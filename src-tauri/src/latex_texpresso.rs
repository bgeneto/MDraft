//! The TeXpresso preview backend's files, served from the `mdraft-tex` origin.
//!
//! The frame, its engine and its TeX Live data are siblings on one origin, so
//! the frame never names another host and its policy can forbid every other
//! one. Three kinds of bytes answer a request:
//!
//! - the shell (`texpresso-shell/`), embedded in the executable;
//! - engine files, each pinned by a full SHA-256 in `texpresso.json`;
//! - TeX Live data: the list and the format files pinned the same way, and the
//!   163,011 bundle files checked against a digest table that is itself a
//!   pinned download.
//!
//! Everything downloaded comes from one base URL, `origin` in `texpresso.json`.
//! A byte is verified before it is cached and again when it is served; a file
//! that does not verify is refused by name, never passed through.
//! Decision: docs/adr/2026-11-13-latex-preview-backends.md.

use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::{
        Arc, LazyLock, Mutex, OnceLock,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, SystemTime},
};

const CONFIG: &str = include_str!("../texpresso.json");

const FRAME_PREFIX: &str = "/texpresso/";
const DATA_PREFIX: &str = "/texpresso-data/";
/// The largest pinned file is the 27 MB XeTeX format.
const MAX_DOWNLOAD: u64 = 64 * 1024 * 1024;
/// Ceiling of the evictable part of the cache: the bundle files under `files/`.
/// The list, the formats and the font-cache archive are needed by every
/// compile and are never evicted.
const CACHE_LIMIT: u64 = 512 * 1024 * 1024;
/// A cache hit refreshes the file's modification time, the eviction order, at
/// most this often: a compile reads hundreds of files and must not write
/// hundreds of timestamps.
const TOUCH_INTERVAL: Duration = Duration::from_secs(3600);

static HITS: AtomicU64 = AtomicU64::new(0);
static MISSES: AtomicU64 = AtomicU64::new(0);
static VERIFIED_BYTES: AtomicU64 = AtomicU64::new(0);
static REFUSALS: AtomicU64 = AtomicU64::new(0);

/// The frame's own policy: same-origin only, so no request can leave it.
/// Inline styles stay allowed because the app positions its marks with them.
pub const FRAME_CSP: &str = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; \
style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data: blob:; \
connect-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'";

/// MDraft's shell around the pinned application. These names win over a pinned
/// engine file, and `validate` refuses a pin that would hide behind one.
const SHELL: &[(&str, &[u8], &str)] = &[
    (
        "index.html",
        include_bytes!("../texpresso-shell/index.html"),
        "text/html; charset=utf-8",
    ),
    (
        "texpresso.css",
        include_bytes!("../texpresso-shell/texpresso.css"),
        "text/css; charset=utf-8",
    ),
    (
        "mdraft-embedded.css",
        include_bytes!("../texpresso-shell/mdraft-embedded.css"),
        "text/css; charset=utf-8",
    ),
    (
        "config.js",
        include_bytes!("../texpresso-shell/config.js"),
        "text/javascript",
    ),
    (
        "worker.js",
        include_bytes!("../texpresso-shell/worker.js"),
        "text/javascript",
    ),
    (
        "theme.js",
        include_bytes!("../texpresso-shell/theme.js"),
        "text/javascript",
    ),
    (
        "mdraft-pre.js",
        include_bytes!("../texpresso-shell/mdraft-pre.js"),
        "text/javascript",
    ),
    (
        "mdraft-boot.js",
        include_bytes!("../texpresso-shell/mdraft-boot.js"),
        "text/javascript",
    ),
    (
        "mdraft-bridge.js",
        include_bytes!("../texpresso-shell/mdraft-bridge.js"),
        "text/javascript",
    ),
];

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Config {
    /// The one string between the local origin server and the production bucket.
    origin: String,
    /// Names the engine's folder at the origin and in the cache.
    app_release: String,
    /// Names the TeX Live data's folder at the origin and in the cache, so a
    /// new snapshot never mixes with an old cache.
    snapshot: String,
    bundle: Bundle,
    digests: Digests,
    assets: Vec<Pin>,
}

#[derive(Deserialize)]
struct Bundle {
    /// The names of the bundle files; its order is the digest table's order.
    list: Pin,
    files: Vec<Pin>,
}

#[derive(Deserialize)]
struct Pin {
    path: String,
    bytes: u64,
    sha256: String,
}

#[derive(Deserialize)]
struct Digests {
    path: String,
    entries: usize,
    bytes: u64,
    sha256: String,
}

/// A relative path that stays inside its directory; `~` is the bundle's suffix.
/// A percent sign is not in the set, so an encoded path is refused, not decoded.
fn safe(relative: &str) -> bool {
    !relative.is_empty()
        && relative.len() <= 512
        && relative
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"/._-~".contains(&b))
        && relative
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != "..")
}

/// `https` anywhere, or `http` on this machine only.
///
/// A plain-`http` remote origin is refused even though every byte is verified:
/// the requests themselves would tell the network which packages a document
/// uses.
fn origin_allowed(origin: &str) -> bool {
    let Ok(url) = tauri::Url::parse(origin) else {
        return false;
    };
    if !origin.ends_with('/')
        || url.query().is_some()
        || url.fragment().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return false;
    }
    let Some(host) = url.host_str() else {
        return false;
    };
    match url.scheme() {
        "https" => true,
        "http" => {
            host == "localhost"
                || host
                    .trim_matches(['[', ']'])
                    .parse::<std::net::IpAddr>()
                    .is_ok_and(|address| address.is_loopback())
        }
        _ => false,
    }
}

fn validate(config: &Config) -> Result<(), String> {
    let segment = |value: &str| safe(value) && !value.contains('/');
    let hex = |value: &str| {
        value.len() == 64
            && value
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    };
    if !origin_allowed(&config.origin) {
        return Err(format!(
            "origin \"{}\" must be https, or http on a loopback host, and end with /",
            config.origin
        ));
    }
    for (what, value) in [
        ("appRelease", &config.app_release),
        ("snapshot", &config.snapshot),
        ("digests.path", &config.digests.path),
    ] {
        if !segment(value) {
            return Err(format!("{what} \"{value}\" is not a single path segment"));
        }
    }
    let mut seen = std::collections::BTreeSet::new();
    let data = std::iter::once(&config.bundle.list).chain(&config.bundle.files);
    for (group, pin) in config
        .assets
        .iter()
        .map(|pin| ("assets", pin))
        .chain(data.map(|pin| ("bundle", pin)))
    {
        if !safe(&pin.path) {
            return Err(format!("{group}: \"{}\" is not a relative path", pin.path));
        }
        if !hex(&pin.sha256) {
            return Err(format!(
                "{group}: {} has no 64-digit lowercase SHA-256",
                pin.path
            ));
        }
        if pin.bytes == 0 || pin.bytes > MAX_DOWNLOAD {
            return Err(format!("{group}: {} has an impossible size", pin.path));
        }
        if !seen.insert((group, pin.path.as_str())) {
            return Err(format!("{group}: {} is pinned twice", pin.path));
        }
        if group == "assets" && SHELL.iter().any(|(name, _, _)| *name == pin.path) {
            return Err(format!("assets: {} is a shell file", pin.path));
        }
        // `files/` belongs to the digest table; a pin there would bypass it.
        if group == "bundle" && (pin.path.starts_with("files/") || pin.path == config.digests.path)
        {
            return Err(format!(
                "bundle: {} is not a bundle metadata file",
                pin.path
            ));
        }
    }
    if config.assets.is_empty() {
        return Err("no assets".into());
    }
    if !hex(&config.digests.sha256) {
        return Err("digests has no 64-digit lowercase SHA-256".into());
    }
    if config.digests.entries == 0 || config.digests.bytes != config.digests.entries as u64 * 16 {
        return Err("digests.bytes is not 16 bytes per entry".into());
    }
    Ok(())
}

/// Only a developer edits the file, so a bad one panics with a message;
/// `config_is_valid` runs this in `cargo test`.
fn config() -> &'static Config {
    static PARSED: OnceLock<Config> = OnceLock::new();
    PARSED.get_or_init(|| {
        let config: Config = serde_json::from_str(CONFIG)
            .expect("src-tauri/texpresso.json does not match the config shape");
        if let Err(problem) = validate(&config) {
            panic!("src-tauri/texpresso.json: {problem}");
        }
        config
    })
}

/// The base URL. `MDRAFT_TEXPRESSO_ORIGIN` replaces it under the same rule,
/// which is safe because every byte is verified against the pins whatever
/// serves it; it points one binary at another origin without a rebuild.
fn origin() -> String {
    std::env::var("MDRAFT_TEXPRESSO_ORIGIN")
        .ok()
        .filter(|value| origin_allowed(value))
        .unwrap_or_else(|| config().origin.clone())
}

fn engine_url(path: &str) -> String {
    format!("{}engine/{}/{path}", origin(), config().app_release)
}

fn data_url(path: &str) -> String {
    format!("{}texlive/{}/{path}", origin(), config().snapshot)
}

/// Engine files and the digest table: installed once, kept by Clear cache.
fn engine_dir(root: &Path) -> PathBuf {
    root.join("texpresso-app").join(&config().app_release)
}

/// The digest table lives with the engine, not with the data it describes:
/// Clear cache must not leave the backend unable to verify what it downloads
/// next.
fn digests_file(root: &Path) -> PathBuf {
    engine_dir(root).join(format!(".digests-{}.bin", config().snapshot))
}

/// Downloaded TeX Live data. Removed by Clear cache.
fn data_dir(root: &Path) -> PathBuf {
    root.join("texpresso").join(&config().snapshot)
}

fn kind(name: &str) -> &'static str {
    if name.ends_with(".js") || name.ends_with(".mjs") {
        "text/javascript"
    } else if name.ends_with(".wasm") {
        "application/wasm"
    } else if name.ends_with(".lst") || name.ends_with(".deps") {
        "text/plain; charset=utf-8"
    } else {
        "application/octet-stream"
    }
}

/// What a file must hash to.
enum Check<'a> {
    /// A pin from `texpresso.json`: the size and the whole SHA-256.
    Full(&'a Pin),
    /// A digest-table entry: the first 16 bytes of the SHA-256.
    Prefix([u8; 16]),
}

impl Check<'_> {
    fn accepts(&self, bytes: &[u8]) -> bool {
        match self {
            Check::Full(pin) => {
                bytes.len() as u64 == pin.bytes && crate::latex::digest(bytes) == pin.sha256
            }
            Check::Prefix(prefix) => Sha256::digest(bytes)[..16] == prefix[..],
        }
    }
}

/// One keep-alive agent for the origin. `ureq::get` builds a use-once agent,
/// which is a new connection, and for `https` a new handshake, per file; a
/// cold compile asks for a few hundred.
fn download(url: &str) -> Result<Vec<u8>, String> {
    if std::env::var_os("MDRAFT_WASMTEX_OFFLINE").is_some() {
        return Err("The LaTeX network is disabled.".into());
    }
    static AGENT: OnceLock<ureq::Agent> = OnceLock::new();
    let agent = AGENT.get_or_init(|| {
        ureq::Agent::config_builder()
            .timeout_global(Some(Duration::from_secs(120)))
            .max_idle_connections_per_host(8)
            .build()
            .new_agent()
    });
    let mut response = agent
        .get(url)
        .call()
        .map_err(|e| format!("Download failed: {e}"))?;
    response
        .body_mut()
        .with_config()
        .limit(MAX_DOWNLOAD)
        .read_to_vec()
        .map_err(|e| format!("Cannot read download: {e}"))
}

/// The cached file, if it is a regular file that still verifies.
///
/// A file that does not verify is deleted: it was damaged or replaced on disk,
/// and the next step downloads it again or fails by name.
fn read_verified(cache: &Path, check: &Check, touch: bool) -> Option<Vec<u8>> {
    let meta = fs::symlink_metadata(cache).ok()?;
    if !meta.file_type().is_file() || meta.len() > MAX_DOWNLOAD {
        return None;
    }
    let bytes = fs::read(cache).ok()?;
    if !check.accepts(&bytes) {
        REFUSALS.fetch_add(1, Ordering::Relaxed);
        let _ = fs::remove_file(cache);
        return None;
    }
    VERIFIED_BYTES.fetch_add(bytes.len() as u64, Ordering::Relaxed);
    if touch
        && meta
            .modified()
            .ok()
            .and_then(|at| at.elapsed().ok())
            .is_some_and(|age| age > TOUCH_INTERVAL)
        && let Ok(file) = fs::File::options().write(true).open(cache)
    {
        let _ = file.set_modified(SystemTime::now());
    }
    Some(bytes)
}

/// One lock per file being downloaded, so concurrent requests for one path
/// share one download: the second waits, then finds the first one's file.
static FLIGHTS: LazyLock<Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// The evictable directory last measured, and its size.
static FILES_SIZE: Mutex<Option<(PathBuf, u64)>> = Mutex::new(None);

/// Count `added` bytes into `dir` and evict the least recently used files when
/// it passes `limit`.
///
/// The directory is walked once per run and after an eviction, not per file:
/// a walk of ten thousand entries on every download would cost more than the
/// download. Eviction goes to nine tenths of the limit so the next file does
/// not start another one.
fn account(dir: &Path, added: u64, limit: u64) {
    let Ok(mut state) = FILES_SIZE.lock() else {
        return;
    };
    let mut total = match state.as_ref() {
        Some((measured, total)) if measured == dir => total.saturating_add(added),
        // The first measurement already sees the file just written.
        _ => crate::latex::cache_size(dir).unwrap_or(0),
    };
    if total > limit {
        total = crate::latex::evict_to_limit(dir, limit / 10 * 9).unwrap_or(total);
    }
    *state = Some((dir.to_path_buf(), total));
}

/// The verified bytes of one file: from the cache, else from `fetch`.
///
/// `name` is what an error calls the file. `evictable` is the directory whose
/// size the file counts against, or `None` for a file that is never evicted.
fn obtain(
    cache: &Path,
    check: &Check,
    name: &str,
    evictable: Option<&Path>,
    fetch: &dyn Fn() -> Result<Vec<u8>, String>,
) -> Result<Vec<u8>, String> {
    if let Some(bytes) = read_verified(cache, check, evictable.is_some()) {
        HITS.fetch_add(1, Ordering::Relaxed);
        return Ok(bytes);
    }
    let flight = FLIGHTS
        .lock()
        .map_err(|_| "The TeXpresso cache is unavailable.")?
        .entry(cache.to_path_buf())
        .or_default()
        .clone();
    let result = (|| {
        let _one = flight
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        // Another request may have finished this download while we waited.
        if let Some(bytes) = read_verified(cache, check, false) {
            HITS.fetch_add(1, Ordering::Relaxed);
            return Ok(bytes);
        }
        MISSES.fetch_add(1, Ordering::Relaxed);
        let bytes = fetch().map_err(|error| format!("{name}: {error}"))?;
        if !check.accepts(&bytes) {
            REFUSALS.fetch_add(1, Ordering::Relaxed);
            return Err(format!(
                "{name} failed SHA-256 verification and was refused."
            ));
        }
        VERIFIED_BYTES.fetch_add(bytes.len() as u64, Ordering::Relaxed);
        crate::latex::write_atomic(cache, &bytes)?;
        if let Some(dir) = evictable {
            account(dir, bytes.len() as u64, CACHE_LIMIT);
        }
        Ok(bytes)
    })();
    if let Ok(mut flights) = FLIGHTS.lock() {
        flights.remove(cache);
    }
    result
}

/// Call `each` with every `files/<folder>/<name><suffix>` a bundle list names,
/// in the list's order, and return how many there were.
///
/// The format is TeXpresso's: the first line is `# <bundle> <hash> <suffix>`,
/// an `@folder` line names the folder of the names after it.
/// `scripts/texpresso-digest-table.mjs` reads it the same way.
fn listed_files(list: &str, mut each: impl FnMut(usize, &str)) -> Result<usize, String> {
    let mut lines = list.split('\n');
    let suffix = lines
        .next()
        .and_then(|first| first.strip_prefix("# "))
        .and_then(|rest| rest.split(' ').nth(2))
        .filter(|suffix| !suffix.is_empty())
        .ok_or("The TeXpresso list has no header line.")?;
    let mut folder: Option<&str> = None;
    let mut path = String::new();
    let mut count = 0;
    for line in lines {
        if line.is_empty() {
            continue;
        }
        if let Some(name) = line.strip_prefix('@') {
            folder = Some(name);
            continue;
        }
        let folder = folder.ok_or("The TeXpresso list names a file before a folder.")?;
        path.clear();
        path.push_str("files/");
        path.push_str(folder);
        path.push('/');
        path.push_str(line);
        path.push_str(suffix);
        each(count, &path);
        count += 1;
    }
    Ok(count)
}

/// The digest of every bundle file, found by path.
struct Table {
    /// The first 16 bytes of SHA-256(path) to the path's position in the list.
    /// Keeping 163,011 paths as strings would cost three times the memory, and
    /// a second path with the same 128 bits cannot be found.
    index: HashMap<u128, u32>,
    /// 16 bytes per position.
    digests: Vec<u8>,
}

fn path_key(path: &str) -> u128 {
    let mut key = [0u8; 16];
    key.copy_from_slice(&Sha256::digest(path.as_bytes())[..16]);
    u128::from_be_bytes(key)
}

impl Table {
    fn build(list: &[u8], digests: Vec<u8>) -> Result<Self, String> {
        let list = std::str::from_utf8(list).map_err(|_| "The TeXpresso list is not UTF-8.")?;
        let mut index = HashMap::with_capacity(digests.len() / 16);
        let count = listed_files(list, |position, path| {
            index.insert(path_key(path), position as u32);
        })?;
        if count * 16 != digests.len() || index.len() != count {
            return Err("The TeXpresso list and its digest table disagree.".into());
        }
        Ok(Self { index, digests })
    }

    fn digest(&self, path: &str) -> Option<[u8; 16]> {
        let at = *self.index.get(&path_key(path))? as usize * 16;
        self.digests.get(at..at + 16)?.try_into().ok()
    }
}

fn list_bytes(root: &Path) -> Result<Vec<u8>, String> {
    let list = &config().bundle.list;
    obtain(
        &data_dir(root).join(&list.path),
        &Check::Full(list),
        &list.path,
        None,
        &|| download(&data_url(&list.path)),
    )
}

fn digest_bytes(root: &Path) -> Result<Vec<u8>, String> {
    let digests = &config().digests;
    let pin = Pin {
        path: digests.path.clone(),
        bytes: digests.bytes,
        sha256: digests.sha256.clone(),
    };
    obtain(
        &digests_file(root),
        &Check::Full(&pin),
        "The TeXpresso digest table",
        None,
        &|| download(&data_url(&digests.path)),
    )
}

/// The table, built on first use and kept: 3.9 MB of list is parsed once.
/// The lock is held while it is built, so the requests of a starting compile
/// wait for one build instead of starting their own.
fn table(root: &Path) -> Result<Arc<Table>, String> {
    static TABLE: Mutex<Option<Arc<Table>>> = Mutex::new(None);
    let mut slot = TABLE
        .lock()
        .map_err(|_| "The TeXpresso digest table is unavailable.")?;
    if let Some(table) = slot.as_ref() {
        return Ok(table.clone());
    }
    let table = Arc::new(Table::build(&list_bytes(root)?, digest_bytes(root)?)?);
    *slot = Some(table.clone());
    Ok(table)
}

type Answer = Result<(Vec<u8>, &'static str), String>;

fn serve_frame(root: &Path, name: &str) -> Answer {
    if let Some((_, bytes, kind)) = SHELL.iter().find(|(shell, _, _)| *shell == name) {
        return Ok((bytes.to_vec(), kind));
    }
    let Some(pin) = config().assets.iter().find(|pin| pin.path == name) else {
        return Err("Unknown TeXpresso file".into());
    };
    let bytes = obtain(
        &engine_dir(root).join(&pin.path),
        &Check::Full(pin),
        &pin.path,
        None,
        &|| download(&engine_url(&pin.path)),
    )?;
    Ok((bytes, kind(name)))
}

fn serve_data(root: &Path, relative: &str) -> Answer {
    let bundle = &config().bundle;
    if let Some(pin) = std::iter::once(&bundle.list)
        .chain(&bundle.files)
        .find(|pin| pin.path == relative)
    {
        let bytes = obtain(
            &data_dir(root).join(&pin.path),
            &Check::Full(pin),
            &pin.path,
            None,
            &|| download(&data_url(&pin.path)),
        )?;
        return Ok((bytes, kind(relative)));
    }
    if !safe(relative) || !relative.starts_with("files/") {
        return Err("Unknown TeXpresso data file".into());
    }
    let Some(digest) = table(root)?.digest(relative) else {
        REFUSALS.fetch_add(1, Ordering::Relaxed);
        return Err(format!("{relative} is not in the TeXpresso bundle."));
    };
    let data = data_dir(root);
    let bytes = obtain(
        &data.join(relative),
        &Check::Prefix(digest),
        relative,
        Some(&data.join("files")),
        &|| download(&data_url(relative)),
    )?;
    Ok((bytes, kind(relative)))
}

/// Answer a frame, engine or data request; `None` when the path is not ours.
/// `root` is the LaTeX data directory. The caller has checked the switch.
pub fn serve(root: &Path, path: &str) -> Option<Answer> {
    if let Some(name) = path.strip_prefix(FRAME_PREFIX) {
        return Some(serve_frame(root, name));
    }
    let relative = path.strip_prefix(DATA_PREFIX)?;
    Some(serve_data(root, relative))
}

/// Download and verify what the backend needs before its frame can start: the
/// engine files, the digest table and the list.
///
/// A file already present and intact is not downloaded again, so this is also
/// the repair. The formats and bundle files follow on demand, through `serve`.
pub fn install(root: &Path) -> Result<(), String> {
    for pin in &config().assets {
        obtain(
            &engine_dir(root).join(&pin.path),
            &Check::Full(pin),
            &pin.path,
            None,
            &|| download(&engine_url(&pin.path)),
        )?;
    }
    digest_bytes(root)?;
    list_bytes(root)?;
    Ok(())
}

/// Whether the engine files and the digest table are all present. Sizes only:
/// every serve verifies the SHA-256, and hashing 15 MB per status call would
/// answer nothing more.
pub fn available(root: &Path) -> bool {
    let present = |path: PathBuf, bytes: u64| {
        fs::symlink_metadata(path)
            .is_ok_and(|meta| meta.file_type().is_file() && meta.len() == bytes)
    };
    config()
        .assets
        .iter()
        .all(|pin| present(engine_dir(root).join(&pin.path), pin.bytes))
        && present(digests_file(root), config().digests.bytes)
}

/// The bytes Clear cache would free: every snapshot's downloaded data.
pub fn cache_bytes(root: &Path) -> u64 {
    crate::latex::cache_size(&root.join("texpresso")).unwrap_or(0)
}

/// Delete the downloaded TeX Live data, of this snapshot and of older ones.
/// The engine files and the digest table stay, like the WasmTex engine does.
pub fn clear(root: &Path) -> Result<u64, String> {
    let data = root.join("texpresso");
    let freed = crate::latex::cache_size(&data).unwrap_or(0);
    if data.exists() {
        fs::remove_dir_all(&data).map_err(|e| e.to_string())?;
    }
    if let Ok(mut state) = FILES_SIZE.lock() {
        *state = None;
    }
    Ok(freed)
}

/// Hits, misses, verified bytes and refusals since start; no paths.
pub fn stats() -> (u64, u64, u64, u64) {
    (
        HITS.load(Ordering::Relaxed),
        MISSES.load(Ordering::Relaxed),
        VERIFIED_BYTES.load(Ordering::Relaxed),
        REFUSALS.load(Ordering::Relaxed),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("texpresso-tests")
            .join(format!("{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn pin_of(path: &str, bytes: &[u8]) -> Pin {
        Pin {
            path: path.into(),
            bytes: bytes.len() as u64,
            sha256: crate::latex::digest(bytes),
        }
    }

    fn prefix_of(bytes: &[u8]) -> [u8; 16] {
        Sha256::digest(bytes)[..16].try_into().unwrap()
    }

    #[test]
    fn config_is_valid() {
        // The real file: a bad edit of `src-tauri/texpresso.json` fails here and
        // not at the first preview.
        let config = config();
        validate(config).unwrap();
        // The pinned list really is the bundle's list, and the format files
        // carry their own digest in their names.
        assert!(config.bundle.list.path.ends_with(".lst"));
        for pin in &config.bundle.files {
            let stem = pin.path.rsplit('/').next().unwrap();
            let tag = stem.split(['-', '.']).nth(1).unwrap();
            assert!(pin.sha256.starts_with(tag), "{} is misnamed", pin.path);
        }
    }

    #[test]
    fn a_bad_config_is_refused() {
        let parse = |edit: &dyn Fn(&mut serde_json::Value)| {
            let mut value: serde_json::Value = serde_json::from_str(CONFIG).unwrap();
            edit(&mut value);
            validate(&serde_json::from_value::<Config>(value).unwrap())
        };
        assert!(parse(&|_| {}).is_ok());
        assert!(parse(&|v| v["origin"] = "http://example.com/".into()).is_err());
        assert!(parse(&|v| v["snapshot"] = "../other".into()).is_err());
        assert!(parse(&|v| v["appRelease"] = "a/b".into()).is_err());
        assert!(parse(&|v| v["assets"][0]["path"] = "../ocaml.js".into()).is_err());
        assert!(parse(&|v| v["assets"][0]["path"] = "index.html".into()).is_err());
        assert!(parse(&|v| v["assets"][1]["path"] = v["assets"][0]["path"].clone()).is_err());
        assert!(parse(&|v| v["assets"][0]["sha256"] = "ABC".into()).is_err());
        assert!(
            parse(&|v| v["bundle"]["files"][0]["path"] = "files/tt2026/v1/a~h".into()).is_err()
        );
        assert!(parse(&|v| v["digests"]["bytes"] = 17.into()).is_err());
    }

    #[test]
    fn only_https_or_loopback_http_is_an_origin() {
        for good in [
            "https://data.example.org/",
            "https://data.example.org/mdraft/",
            "http://127.0.0.1:8717/",
            "http://localhost:8717/",
            "http://[::1]:8717/",
        ] {
            assert!(origin_allowed(good), "{good}");
        }
        for bad in [
            "http://data.example.org/",
            "http://192.168.1.10:8717/",
            "http://127.0.0.1.example.org/",
            "http://localhost.example.org/",
            "https://data.example.org",
            "https://data.example.org/?x=1",
            "https://user:secret@data.example.org/",
            "ftp://127.0.0.1/",
            "file:///C:/mirror/",
            "",
        ] {
            assert!(!origin_allowed(bad), "{bad}");
        }
    }

    #[test]
    fn a_path_cannot_leave_its_directory() {
        for good in [
            "ocaml.js",
            "vendor/codemirror/codemirror.js",
            "files/tt2026/v1/a.tfm~h",
        ] {
            assert!(safe(good), "{good}");
        }
        for bad in [
            "", "/a", "a//b", "../a", "a/../b", "a/./b", "a\\b", "a%2Fb", "a b", "a:b",
        ] {
            assert!(!safe(bad), "{bad}");
        }
    }

    #[test]
    fn a_tampered_cached_file_is_refused() {
        let dir = scratch("tampered");
        let cache = dir.join("engine.wasm");
        let good = b"the pinned bytes".to_vec();
        let pin = pin_of("engine.wasm", &good);
        let check = Check::Full(&pin);

        // Tampered on disk, origin unreachable: an error that names the file,
        // and the bad copy is gone.
        fs::write(&cache, b"the pinned byteZ").unwrap();
        let error = obtain(&cache, &check, "engine.wasm", None, &|| {
            Err("offline".into())
        })
        .unwrap_err();
        assert!(error.contains("engine.wasm"), "{error}");
        assert!(!cache.exists());

        // The origin serves wrong bytes: refused by name, nothing cached.
        let error = obtain(
            &cache,
            &check,
            "engine.wasm",
            None,
            &|| Ok(b"evil".to_vec()),
        )
        .unwrap_err();
        assert!(
            error.contains("engine.wasm") && error.contains("SHA-256"),
            "{error}"
        );
        assert!(!cache.exists());

        // The right bytes are cached, and the next read needs no origin.
        let fetched = obtain(&cache, &check, "engine.wasm", None, &|| Ok(good.clone())).unwrap();
        assert_eq!(fetched, good);
        let again = obtain(&cache, &check, "engine.wasm", None, &|| {
            panic!("a cached file must not be downloaded")
        })
        .unwrap();
        assert_eq!(again, good);

        // The right bytes at the wrong length do not pass a full pin.
        let short = Pin {
            bytes: 3,
            ..pin_of("engine.wasm", &good)
        };
        assert!(!Check::Full(&short).accepts(&good));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_symlink_in_the_cache_is_never_read() {
        let dir = scratch("symlink");
        let target = dir.join("target");
        let good = b"bytes".to_vec();
        fs::write(&target, &good).unwrap();
        let link = dir.join("link");
        #[cfg(unix)]
        let made = std::os::unix::fs::symlink(&target, &link).is_ok();
        #[cfg(windows)]
        let made = std::os::windows::fs::symlink_file(&target, &link).is_ok();
        // Creating a symlink needs a privilege on Windows; without it there is
        // nothing to test.
        if made {
            assert!(read_verified(&link, &Check::Prefix(prefix_of(&good)), false).is_none());
        }
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn the_table_finds_a_listed_file_and_nothing_else() {
        let list = "# tt2026/v3 abc ~h\n@tt2026/v3\n.tex\nCherokee.tfm\n@tt2022/v1\ncherokee.tfm\n";
        let contents: [&[u8]; 3] = [b"one", b"two", b"three"];
        let digests: Vec<u8> = contents.iter().flat_map(|bytes| prefix_of(bytes)).collect();
        let table = Table::build(list.as_bytes(), digests.clone()).unwrap();
        assert_eq!(
            table.digest("files/tt2026/v3/.tex~h"),
            Some(prefix_of(b"one"))
        );
        assert_eq!(
            table.digest("files/tt2026/v3/Cherokee.tfm~h"),
            Some(prefix_of(b"two"))
        );
        assert_eq!(
            table.digest("files/tt2022/v1/cherokee.tfm~h"),
            Some(prefix_of(b"three"))
        );
        // The same name in another folder, in another case, or without the
        // suffix is another file.
        for outside in [
            "files/tt2022/v1/Cherokee.tfm~h",
            "files/tt2026/v3/cherokee.tfm~h",
            "files/tt2026/v3/Cherokee.tfm",
            "files/tt2026/v3/unknown.sty~h",
            "tt2026/v3.lst",
        ] {
            assert_eq!(table.digest(outside), None, "{outside}");
        }
        // A table for a different list is refused whole.
        assert!(Table::build(list.as_bytes(), digests[..32].to_vec()).is_err());
        assert!(Table::build(b"@tt2026/v3\na\n", digests[..16].to_vec()).is_err());
        assert!(Table::build(b"# b h ~h\nname\n", digests[..16].to_vec()).is_err());
    }

    #[test]
    fn an_unpinned_path_is_refused_without_a_request() {
        // None of these reaches the origin: the answer comes from the pins.
        let dir = scratch("unpinned");
        for path in [
            "/texpresso/",
            "/texpresso/sw.js",
            "/texpresso/vendor/codemirror/vim.js",
            "/texpresso/../latex-engine.json",
            "/texpresso-data/",
            "/texpresso-data/digests.bin",
            "/texpresso-data/tt2026/other.fmt",
            "/texpresso-data/files/../tt2026/v3.lst",
            "/texpresso-data/files%2Ftt2026",
        ] {
            assert!(
                serve(&dir, path).is_some_and(|answer| answer.is_err()),
                "{path}"
            );
        }
        assert!(serve(&dir, "/wasmtex/2026/wasmtex-luatex.js").is_none());
        assert!(serve(&dir, "/mirror/texpresso/a").is_none());
        let (bytes, kind) = serve(&dir, "/texpresso/index.html").unwrap().unwrap();
        assert!(kind.starts_with("text/html"));
        // The frame's policy has no inline script to allow, so the shell has none.
        let html = String::from_utf8(bytes).unwrap();
        assert!(!html.contains("<style"));
        for script in html.split("<script").skip(1) {
            assert!(
                script.split('>').next().unwrap().contains("src=\"./"),
                "inline script"
            );
        }
        assert!(
            dir.read_dir().unwrap().next().is_none(),
            "nothing was written"
        );
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn the_evictable_cache_stays_under_its_limit() {
        let dir = scratch("evict").join("files");
        fs::create_dir_all(&dir).unwrap();
        let old = SystemTime::now() - Duration::from_secs(7200);
        for (name, age) in [("a", 3), ("b", 2), ("c", 1)] {
            let path = dir.join(name);
            fs::write(&path, [0u8; 100]).unwrap();
            let file = fs::File::options().write(true).open(&path).unwrap();
            file.set_modified(old - Duration::from_secs(age * 60))
                .unwrap();
        }
        fs::write(dir.join("d"), [0u8; 100]).unwrap();
        // 400 bytes against a limit of 350: evict to 315, oldest first.
        account(&dir, 100, 350);
        assert!(
            !dir.join("a").exists(),
            "the least recently used file goes first"
        );
        assert!(dir.join("b").exists() && dir.join("c").exists() && dir.join("d").exists());
        // Under the limit nothing is removed, and the running total is kept.
        account(&dir, 0, 350);
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 3);
        fs::remove_dir_all(dir.parent().unwrap()).unwrap();
    }

    #[test]
    fn a_hit_refreshes_an_old_timestamp_only() {
        let dir = scratch("touch");
        let cache = dir.join("a~h");
        let good = b"font".to_vec();
        fs::write(&cache, &good).unwrap();
        let check = Check::Prefix(prefix_of(&good));
        let old = SystemTime::now() - Duration::from_secs(7200);
        fs::File::options()
            .write(true)
            .open(&cache)
            .unwrap()
            .set_modified(old)
            .unwrap();
        assert!(read_verified(&cache, &check, true).is_some());
        let touched = fs::metadata(&cache).unwrap().modified().unwrap();
        assert!(
            touched > old + Duration::from_secs(3600),
            "an old hit is refreshed"
        );
        assert!(read_verified(&cache, &check, true).is_some());
        assert_eq!(fs::metadata(&cache).unwrap().modified().unwrap(), touched);
        fs::remove_dir_all(dir).unwrap();
    }

    /// Needs `scripts/texpresso-origin-server.mjs` on the configured origin:
    /// `cargo test -- --ignored texpresso`.
    #[test]
    #[ignore = "needs the local TeXpresso origin server"]
    fn the_local_origin_installs_and_serves() {
        let root = scratch("origin");
        assert!(!available(&root));
        install(&root).unwrap();
        assert!(available(&root));
        let list = &config().bundle.list;
        let (bytes, kind) = serve(&root, &format!("/texpresso-data/{}", list.path))
            .unwrap()
            .unwrap();
        assert_eq!(bytes.len() as u64, list.bytes);
        assert!(kind.starts_with("text/plain"));
        // The pair a case-insensitive disk confuses.
        let upper = serve(&root, "/texpresso-data/files/tt2022/v1/Cherokee.tfm~h")
            .unwrap()
            .unwrap()
            .0;
        let lower = serve(&root, "/texpresso-data/files/tt2022/v1/cherokee.tfm~h")
            .unwrap()
            .unwrap()
            .0;
        assert_ne!(upper, lower);
        assert!(
            serve(&root, "/texpresso-data/files/tt2022/v1/CHEROKEE.tfm~h")
                .unwrap()
                .is_err()
        );
        let (wasm, kind) = serve(&root, "/texpresso/dluatex-bin-jspi.wasm")
            .unwrap()
            .unwrap();
        assert_eq!(kind, "application/wasm");
        assert!(wasm.starts_with(b"\0asm"));
        // Clear cache removes the data and keeps the engine.
        assert!(cache_bytes(&root) > 0);
        assert!(clear(&root).unwrap() > 0);
        assert_eq!(cache_bytes(&root), 0);
        assert!(available(&root));
        fs::remove_dir_all(root).unwrap();
    }
}
