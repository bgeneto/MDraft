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
//!
//! The install fetches the pinned files in two zip archives, one per base,
//! when `texpresso.json` pins them: a few hundred requests in a row cost more
//! time than their bytes. An archive is only transport. Each member is checked
//! against its own pin, and whatever an archive does not supply is fetched
//! file by file.
//! Decision: docs/architecture.md.

use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::{
        Arc, LazyLock, Mutex, OnceLock,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::{Duration, Instant, SystemTime},
};

use crate::optional_tools;

const CONFIG: &str = include_str!("../texpresso.json");

const FRAME_PREFIX: &str = "/texpresso/";
const DATA_PREFIX: &str = "/texpresso-data/";
const PROJECT_PREFIX: &str = "/project/";
/// A project file the frame may fetch on demand.
const PROJECT_FILE_LIMIT: u64 = 128 * 1024 * 1024;
/// Bytes held by one frame's project table. A refetch replaces its entry, so a
/// changed file does not count twice.
const PROJECT_HELD_LIMIT: u64 = 1024 * 1024 * 1024;
/// Clear cache asks the next frame's boot to delete the luaotfload cache too:
/// it lives in the webview profile, where the Rust cache walk cannot reach it.
static CLEAR_FONT_CACHE: AtomicBool = AtomicBool::new(false);
/// The largest pinned file is the 27 MB XeTeX format.
const MAX_DOWNLOAD: u64 = 64 * 1024 * 1024;
/// An install archive: the formats compress to about 16 MB, and the whole data
/// group to about 19 MB.
const MAX_ARCHIVE: u64 = 96 * 1024 * 1024;
/// Files fetched at once when the install falls back to single files. The
/// agent keeps as many connections, and each request mostly waits for the
/// origin's first byte.
const PARALLEL_DOWNLOADS: usize = 8;
/// Ceiling of the evictable part of the cache: the bundle files under `files/`.
/// The list, the formats and the font-cache archive are needed by every
/// compile and are never evicted. Preferences sets it; 512 MiB is the fallback
/// before settings are loaded.
static CACHE_LIMIT: AtomicU64 = AtomicU64::new(512 * 1024 * 1024);
/// The smallest ceiling the settings row allows, repeated here so a direct
/// caller cannot configure a cache that thrashes on the format files.
const CACHE_FLOOR: u64 = 32 * 1024 * 1024;

/// Mirror the reader's cache ceiling into the generator that serves the frame.
pub fn set_cache_limit(bytes: u64) {
    CACHE_LIMIT.store(bytes.max(CACHE_FLOOR), Ordering::Relaxed);
}
/// A cache hit refreshes the file's modification time, the eviction order, at
/// most this often: a compile reads hundreds of files and must not write
/// hundreds of timestamps.
const TOUCH_INTERVAL: Duration = Duration::from_secs(3600);

static HITS: AtomicU64 = AtomicU64::new(0);
static MISSES: AtomicU64 = AtomicU64::new(0);
static VERIFIED_BYTES: AtomicU64 = AtomicU64::new(0);
static REFUSALS: AtomicU64 = AtomicU64::new(0);
/// Bytes that came from the origin. `VERIFIED_BYTES` also counts every cache
/// read, so the download progress cannot be built from it.
static DOWNLOADED_BYTES: AtomicU64 = AtomicU64::new(0);

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
    /// Install archives, at most one per base. Without one, that base is
    /// installed file by file.
    #[serde(default)]
    archives: Vec<Archive>,
}

/// Which pins an archive carries, and which prefix of the origin serves it.
#[derive(Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
enum Base {
    /// The engine files (`assets`), under `engine/<appRelease>/`.
    Engine,
    /// The list, the digest table and the format files, under
    /// `texlive/<snapshot>/`.
    Data,
}

#[derive(Deserialize)]
struct Archive {
    path: String,
    bytes: u64,
    sha256: String,
    base: Base,
}

#[derive(Deserialize)]
struct Bundle {
    /// The names of the bundle files; its order is the digest table's order.
    list: Pin,
    files: Vec<Pin>,
}

#[derive(Deserialize, Clone)]
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
    let mut bases = Vec::new();
    for archive in &config.archives {
        // `install/` holds nothing else, so an archive can never shadow a pin
        // or a bundle file.
        if !safe(&archive.path)
            || !archive.path.starts_with("install/")
            || !archive.path.ends_with(".zip")
        {
            return Err(format!(
                "archives: \"{}\" is not an install/*.zip path",
                archive.path
            ));
        }
        if !hex(&archive.sha256) {
            return Err(format!(
                "archives: {} has no 64-digit lowercase SHA-256",
                archive.path
            ));
        }
        if archive.bytes == 0 || archive.bytes > MAX_ARCHIVE {
            return Err(format!("archives: {} has an impossible size", archive.path));
        }
        if bases.contains(&archive.base) {
            return Err(format!("archives: two archives for {:?}", archive.base));
        }
        bases.push(archive.base);
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
fn download(url: &str, deadline: Option<Instant>) -> Result<Vec<u8>, String> {
    fetch(url, MAX_DOWNLOAD, deadline, |_| {})
}

/// `download` with a size cap and a byte callback.
///
/// A request with a deadline may run until that deadline: at 1 Mbit/s the
/// 27 MB XeTeX format or the data archive takes longer than the agent's two
/// minutes, which suits on-demand files only.
fn fetch(
    url: &str,
    cap: u64,
    deadline: Option<Instant>,
    on_bytes: impl FnMut(u64),
) -> Result<Vec<u8>, String> {
    if std::env::var_os("MDRAFT_TEX_OFFLINE").is_some() {
        return Err("The LaTeX network is disabled.".into());
    }
    static AGENT: OnceLock<ureq::Agent> = OnceLock::new();
    let agent = AGENT.get_or_init(|| {
        ureq::Agent::config_builder()
            .timeout_global(Some(Duration::from_secs(120)))
            .max_idle_connections_per_host(PARALLEL_DOWNLOADS)
            .build()
            .new_agent()
    });
    let request = agent.get(url);
    let mut response = match deadline {
        Some(deadline) => request
            .config()
            .timeout_global(Some(
                deadline
                    .saturating_duration_since(Instant::now())
                    .max(Duration::from_secs(1)),
            ))
            .build()
            .call(),
        None => request.call(),
    }
    .map_err(|e| format!("Download failed: {e}"))?;
    let limit = deadline.unwrap_or_else(|| Instant::now() + Duration::from_secs(120));
    let mut reader = response.body_mut().as_reader();
    optional_tools::read_to_vec_bounded(&mut reader, cap, limit, on_bytes)
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

/// The evictable directory last measured, its size, and the size an eviction
/// could not go below because the current session uses those files.
static FILES_SIZE: Mutex<Option<(PathBuf, u64, u64)>> = Mutex::new(None);

/// Count `added` bytes into `dir` and evict the least recently used files when
/// it passes `limit`.
///
/// The directory is walked once per run and after an eviction, not per file:
/// a walk of ten thousand entries on every download would cost more than the
/// download. Eviction goes to nine tenths of the limit so the next file does
/// not start another one.
///
/// A file the current preview session read is never evicted: removing it only
/// makes the next compile download it again, which is how a 256 MiB cache and
/// a 1 GB font scan turned into the same downloads on every compile. When those
/// files alone pass the limit, the preview says so, and the walk is not
/// repeated until the cache grows by another tenth of the limit.
fn account(dir: &Path, added: u64, limit: u64) {
    let Ok(mut state) = FILES_SIZE.lock() else {
        return;
    };
    let (mut total, mut floor) = match state.as_ref() {
        Some((measured, total, floor)) if measured == dir => (total.saturating_add(added), *floor),
        // The first measurement already sees the file just written.
        _ => (crate::latex::cache_size(dir).unwrap_or(0), 0),
    };
    if total > limit && total > floor.saturating_add(limit / 10) {
        let data = dir.parent().unwrap_or(dir);
        let keep = |path: &Path| {
            path.strip_prefix(data).is_ok_and(|relative| {
                let key = relative
                    .components()
                    .map(|part| part.as_os_str().to_string_lossy())
                    .collect::<Vec<_>>()
                    .join("/");
                crate::texpresso_guard::working_contains(&key)
            })
        };
        total = crate::latex::evict_to_limit_keeping(dir, limit / 10 * 9, &keep).unwrap_or(total);
        floor = if total > limit { total } else { 0 };
        crate::texpresso_guard::set_cache_overflow((total > limit).then_some(total));
    }
    *state = Some((dir.to_path_buf(), total, floor));
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
    let _writer = crate::backup::gate::writer()?;
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
        // Counted once the bytes arrived: a download the guard refused, or one
        // that failed, downloaded nothing.
        let bytes = fetch().map_err(|error| format!("{name}: {error}"))?;
        MISSES.fetch_add(1, Ordering::Relaxed);
        DOWNLOADED_BYTES.fetch_add(bytes.len() as u64, Ordering::Relaxed);
        if !check.accepts(&bytes) {
            REFUSALS.fetch_add(1, Ordering::Relaxed);
            return Err(format!(
                "{name} failed SHA-256 verification and was refused."
            ));
        }
        VERIFIED_BYTES.fetch_add(bytes.len() as u64, Ordering::Relaxed);
        crate::latex::write_atomic(cache, &bytes)?;
        if let Some(dir) = evictable {
            account(dir, bytes.len() as u64, CACHE_LIMIT.load(Ordering::Relaxed));
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
/// an `@folder` line names the folder of the names after it. From the `v4`
/// lists on, lines starting with `=` follow the names: the app's prefetch
/// groups, which name no file. `scripts/texpresso-digest-table.mjs` reads it
/// the same way.
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
        if line.is_empty() || line.starts_with('=') {
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

fn list_bytes(root: &Path, deadline: Option<Instant>) -> Result<Vec<u8>, String> {
    let list = &config().bundle.list;
    obtain(
        &data_dir(root).join(&list.path),
        &Check::Full(list),
        &list.path,
        None,
        &|| download(&data_url(&list.path), deadline),
    )
}

fn digest_bytes(root: &Path, deadline: Option<Instant>) -> Result<Vec<u8>, String> {
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
        &|| download(&data_url(&digests.path), deadline),
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
    let table = Arc::new(Table::build(
        &list_bytes(root, None)?,
        digest_bytes(root, None)?,
    )?);
    *slot = Some(table.clone());
    Ok(table)
}

/// One live preview session: its canonical project root and the bytes its
/// frame has fetched so far.
struct ProjectSession {
    root: PathBuf,
    served: HashMap<String, u64>,
    captures: usize,
}

static PROJECT_SESSIONS: LazyLock<Mutex<HashMap<String, ProjectSession>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static PROJECT_TOKEN_SEQ: AtomicU64 = AtomicU64::new(0);

/// The capability for one project root. The frame presents it on every
/// on-demand request; without it the route cannot name a directory at all.
pub fn project_token(root: &Path) -> Result<String, String> {
    let root = fs::canonicalize(root)
        .map_err(|error| format!("Cannot read the project directory: {error}"))?;
    let mut sessions = PROJECT_SESSIONS
        .lock()
        .map_err(|_| "The preview session registry is unavailable.".to_string())?;
    if let Some((token, session)) = sessions
        .iter_mut()
        .find(|(_, session)| session.root == root)
    {
        session.captures += 1;
        return Ok(token.clone());
    }
    // Native builds also ask for a snapshot; keep abandoned roots bounded.
    if sessions.len() >= 64
        && let Some(oldest) = sessions.keys().next().cloned()
    {
        sessions.remove(&oldest);
    }
    let token = random_token();
    sessions.insert(
        token.clone(),
        ProjectSession {
            root,
            served: HashMap::new(),
            captures: 1,
        },
    );
    Ok(token)
}

/// Release one capture. A cache probe and a live frame may share the token.
pub fn revoke_project_token(token: &str) {
    if let Ok(mut sessions) = PROJECT_SESSIONS.lock()
        && let Some(session) = sessions.get_mut(token)
    {
        session.captures -= 1;
        if session.captures == 0 {
            sessions.remove(token);
        }
    }
}

fn random_token() -> String {
    use std::hash::{BuildHasher, Hasher};
    let mut material = Vec::new();
    for _ in 0..2 {
        let mut hasher = std::collections::hash_map::RandomState::new().build_hasher();
        hasher.write_u64(PROJECT_TOKEN_SEQ.fetch_add(1, Ordering::Relaxed));
        material.extend_from_slice(&hasher.finish().to_le_bytes());
    }
    let now = SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    material.extend_from_slice(&now.as_nanos().to_le_bytes());
    material.extend_from_slice(&std::process::id().to_le_bytes());
    Sha256::digest(&material)[..16]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<Vec<_>>()
        .join("")
}

fn hex_digit(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn percent_decode(value: &str) -> Result<String, String> {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] == b'%' {
            let high = bytes.get(at + 1).and_then(|byte| hex_digit(*byte));
            let low = bytes.get(at + 2).and_then(|byte| hex_digit(*byte));
            let (Some(high), Some(low)) = (high, low) else {
                return Err("The project path has an invalid percent escape.".into());
            };
            decoded.push(high << 4 | low);
            at += 3;
        } else {
            decoded.push(bytes[at]);
            at += 1;
        }
    }
    String::from_utf8(decoded).map_err(|_| "Project paths must be valid Unicode.".into())
}

fn project_kind(name: &str) -> &'static str {
    let extension = Path::new(name)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match extension.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "pdf" => "application/pdf",
        "otf" => "font/otf",
        "ttf" => "font/ttf",
        "ttc" | "otc" => "font/collection",
        "tex" | "ltx" | "sty" | "cls" | "bib" | "bst" | "cfg" | "def" | "txt" | "csv" => {
            "text/plain; charset=utf-8"
        }
        _ => "application/octet-stream",
    }
}

/// Serve one project file through the frame's capability.
fn serve_project(rest: &str) -> Answer {
    let (token, encoded) = rest
        .split_once('/')
        .ok_or("Unknown project file request.")?;
    let relative = percent_decode(encoded)?;
    let root = PROJECT_SESSIONS
        .lock()
        .map_err(|_| "The preview session registry is unavailable.".to_string())?
        .get(token)
        .map(|session| session.root.clone())
        .ok_or("The preview project session has ended.")?;
    let (path, size) = crate::latex::project_file_in(&root, &relative)?;
    if size > PROJECT_FILE_LIMIT {
        return Err(format!(
            "{relative} exceeds the 128 MiB project-file limit; move it outside the project."
        ));
    }
    let bytes = fs::read(&path).map_err(|error| format!("Cannot read {relative}: {error}"))?;
    if bytes.len() as u64 > PROJECT_FILE_LIMIT {
        return Err(format!(
            "{relative} exceeds the 128 MiB project-file limit; move it outside the project."
        ));
    }
    let mut sessions = PROJECT_SESSIONS
        .lock()
        .map_err(|_| "The preview session registry is unavailable.".to_string())?;
    let session = sessions
        .get_mut(token)
        .ok_or("The preview project session has ended.")?;
    let held: u64 = session.served.values().sum();
    let previous = session.served.get(&relative).copied().unwrap_or(0);
    let next = held
        .saturating_sub(previous)
        .saturating_add(bytes.len() as u64);
    if next > PROJECT_HELD_LIMIT {
        return Err(
            "The preview has fetched more than 1 GiB of project files; Clear cache or split the project."
                .into(),
        );
    }
    session.served.insert(relative.clone(), bytes.len() as u64);
    Ok((bytes, project_kind(&relative)))
}

type Answer = Result<(Vec<u8>, &'static str), String>;

fn serve_frame(root: &Path, name: &str) -> Answer {
    if name == "boot.json" {
        let clear = CLEAR_FONT_CACHE.swap(false, Ordering::Relaxed);
        return Ok((
            format!("{{\"clearFontCache\":{clear}}}").into_bytes(),
            "application/json",
        ));
    }
    if let Some((_, bytes, kind)) = SHELL.iter().find(|(shell, _, _)| *shell == name) {
        // The page is served `no-store`, so every new frame asks for it: that
        // starts the download budget of a new preview session.
        if name == "index.html" {
            crate::texpresso_guard::reset();
        }
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
        &|| download(&engine_url(&pin.path), None),
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
            &|| download(&data_url(&pin.path), None),
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
        &|| {
            crate::texpresso_guard::admit(relative)?;
            let bytes = download(&data_url(relative), None)?;
            crate::texpresso_guard::record(relative, bytes.len() as u64);
            Ok(bytes)
        },
    )?;
    crate::texpresso_guard::note_working(relative);
    Ok((bytes, kind(relative)))
}

/// Answer a frame, engine or data request; `None` when the path is not ours.
/// `root` is the LaTeX data directory. The caller has checked the switch.
pub fn serve(root: &Path, path: &str) -> Option<Answer> {
    if let Some(rest) = path.strip_prefix(PROJECT_PREFIX) {
        return Some(serve_project(rest));
    }
    if let Some(name) = path.strip_prefix(FRAME_PREFIX) {
        return Some(serve_frame(root, name));
    }
    let relative = path.strip_prefix(DATA_PREFIX)?;
    Some(serve_data(root, relative))
}

/// The same install, reporting cumulative bytes as they arrive.
///
/// The overall deadline is threaded into every request, so a stalled
/// connection cannot keep the install alive past ten minutes.
pub fn install_with_progress(root: &Path, progress: impl FnMut(u64, u64)) -> Result<(), String> {
    let _writer = crate::backup::gate::writer()?;
    let deadline = optional_tools::deadline();
    cleanup_temp_files(&engine_dir(root), true);
    cleanup_temp_files(&data_dir(root), false);
    let config = config();
    // The formats are written one level down, `tt2026/`, which the walk above
    // does not enter.
    let mut format_dirs: Vec<PathBuf> = config
        .bundle
        .files
        .iter()
        .filter_map(|pin| {
            data_dir(root)
                .join(&pin.path)
                .parent()
                .map(Path::to_path_buf)
        })
        .collect();
    format_dirs.dedup();
    for dir in format_dirs {
        cleanup_temp_files(&dir, false);
    }

    install_from(
        &members(root),
        &config.archives,
        deadline,
        &|archive, on_bytes| {
            let url = match archive.base {
                Base::Engine => engine_url(&archive.path),
                Base::Data => data_url(&archive.path),
            };
            fetch(&url, MAX_ARCHIVE, Some(deadline), on_bytes)
        },
        &|member| {
            let url = match member.base {
                Base::Engine => engine_url(&member.pin.path),
                Base::Data => data_url(&member.pin.path),
            };
            download(&url, Some(deadline))
        },
        Throttle::new(progress),
    )
}

/// One pinned file of the install and where it is cached.
#[derive(Clone)]
struct Member {
    pin: Pin,
    base: Base,
    target: PathBuf,
}

/// Everything the install puts in place. The digest table's name in the data
/// archive and at the origin is `digests.path`; it is cached with the engine.
fn members(root: &Path) -> Vec<Member> {
    let config = config();
    let engine = config.assets.iter().map(|pin| Member {
        pin: pin.clone(),
        base: Base::Engine,
        target: engine_dir(root).join(&pin.path),
    });
    let digests = Member {
        pin: Pin {
            path: config.digests.path.clone(),
            bytes: config.digests.bytes,
            sha256: config.digests.sha256.clone(),
        },
        base: Base::Data,
        target: digests_file(root),
    };
    let data = std::iter::once(&config.bundle.list)
        .chain(&config.bundle.files)
        .map(|pin| Member {
            pin: pin.clone(),
            base: Base::Data,
            target: data_dir(root).join(&pin.path),
        });
    engine.chain(std::iter::once(digests)).chain(data).collect()
}

/// Progress events at most every half percent: an archive arrives 64 KB at a
/// time, which would be hundreds of events for one bar.
struct Throttle<F: FnMut(u64, u64)> {
    report: F,
    last: Option<(u64, u64)>,
}

impl<F: FnMut(u64, u64)> Throttle<F> {
    fn new(report: F) -> Self {
        Self { report, last: None }
    }

    fn report(&mut self, done: u64, total: u64) {
        let due = match self.last {
            None => true,
            Some((last, last_total)) => {
                total != last_total || done >= total || done >= last + (total / 200).max(1)
            }
        };
        if due {
            self.last = Some((done, total));
            (self.report)(done, total);
        }
    }
}

/// Fetches one install archive, reporting the bytes received so far.
type GetArchive<'a> = dyn Fn(&Archive, &mut dyn FnMut(u64)) -> Result<Vec<u8>, String> + 'a;

/// The install with its two transports passed in, so tests need no origin.
///
/// The members that are missing or damaged are fetched; an archive is tried
/// for every base that has one. A refused, missing or damaged archive costs
/// only time: what it did not supply is then fetched file by file.
fn install_from<F: FnMut(u64, u64)>(
    members: &[Member],
    archives: &[Archive],
    deadline: Instant,
    get_archive: &GetArchive<'_>,
    get_file: &(dyn Fn(&Member) -> Result<Vec<u8>, String> + Sync),
    mut progress: Throttle<F>,
) -> Result<(), String> {
    let mut missing: Vec<&Member> = members
        .iter()
        .filter(|member| read_verified(&member.target, &Check::Full(&member.pin), false).is_none())
        .collect();
    let needed: Vec<&Archive> = archives
        .iter()
        .filter(|archive| missing.iter().any(|member| member.base == archive.base))
        .collect();
    let by_file = |missing: &[&Member], base: Base| {
        missing
            .iter()
            .filter(|member| member.base == base)
            .map(|member| member.pin.bytes)
            .sum::<u64>()
    };
    let mut total = needed.iter().map(|archive| archive.bytes).sum::<u64>()
        + missing
            .iter()
            .filter(|member| !needed.iter().any(|archive| archive.base == member.base))
            .map(|member| member.pin.bytes)
            .sum::<u64>();
    let mut done = 0u64;
    progress.report(done, total);

    let mut archive_error = None;
    for archive in needed {
        optional_tools::check_deadline(deadline)?;
        let start = done;
        let result = get_archive(archive, &mut |received| {
            progress.report(start + received.min(archive.bytes), total)
        })
        .and_then(|bytes| {
            let pin = Pin {
                path: archive.path.clone(),
                bytes: archive.bytes,
                sha256: archive.sha256.clone(),
            };
            if !Check::Full(&pin).accepts(&bytes) {
                REFUSALS.fetch_add(1, Ordering::Relaxed);
                return Err("failed SHA-256 verification and was refused.".into());
            }
            DOWNLOADED_BYTES.fetch_add(bytes.len() as u64, Ordering::Relaxed);
            let known: Vec<&Member> = members
                .iter()
                .filter(|member| member.base == archive.base)
                .collect();
            let wanted: Vec<&str> = missing
                .iter()
                .filter(|member| member.base == archive.base)
                .map(|member| member.pin.path.as_str())
                .collect();
            extract(&bytes, &known, &wanted)
        });
        done = start + archive.bytes;
        match result {
            Ok(written) => missing.retain(|member| {
                member.base != archive.base || !written.contains(member.pin.path.as_str())
            }),
            Err(error) => archive_error = Some(format!("{}: {error}", archive.path)),
        }
        // Whatever the archive left out is now fetched one file at a time.
        total =
            done + by_file(&missing, archive.base) + total.saturating_sub(start + archive.bytes);
        progress.report(done, total);
    }

    let remaining: u64 = missing.iter().map(|member| member.pin.bytes).sum();
    total = done + remaining;
    progress.report(done, total);
    fetch_files(&missing, deadline, get_file, |bytes| {
        done += bytes;
        progress.report(done, total);
    })
    .map_err(|error| match archive_error {
        // The archive's failure is what the reader most needs when the
        // fallback failed too.
        Some(first) => format!("{error} (The install archive failed first: {first})"),
        None => error,
    })
}

/// Fetch `files` through `obtain`, a few at a time, and report each one's
/// size on the calling thread as it is cached.
fn fetch_files(
    files: &[&Member],
    deadline: Instant,
    get_file: &(dyn Fn(&Member) -> Result<Vec<u8>, String> + Sync),
    mut finished: impl FnMut(u64),
) -> Result<(), String> {
    if files.is_empty() {
        return Ok(());
    }
    let next = std::sync::atomic::AtomicUsize::new(0);
    let failed = AtomicBool::new(false);
    let (sender, receiver) = std::sync::mpsc::channel::<Result<u64, String>>();
    std::thread::scope(|scope| {
        for _ in 0..PARALLEL_DOWNLOADS.min(files.len()) {
            let sender = sender.clone();
            let (next, failed) = (&next, &failed);
            scope.spawn(move || {
                loop {
                    let at = next.fetch_add(1, Ordering::Relaxed);
                    let Some(member) = files.get(at) else {
                        break;
                    };
                    if failed.load(Ordering::Relaxed) {
                        break;
                    }
                    let result = optional_tools::check_deadline(deadline).and_then(|()| {
                        obtain(
                            &member.target,
                            &Check::Full(&member.pin),
                            &member.pin.path,
                            None,
                            &|| get_file(member),
                        )
                    });
                    if result.is_err() {
                        failed.store(true, Ordering::Relaxed);
                    }
                    if sender.send(result.map(|_| member.pin.bytes)).is_err() {
                        break;
                    }
                }
            });
        }
        drop(sender);
        let mut first_error = None;
        for result in receiver {
            match result {
                Ok(bytes) => finished(bytes),
                Err(error) => {
                    first_error.get_or_insert(error);
                }
            }
        }
        first_error.map_or(Ok(()), Err)
    })
}

/// Write the `wanted` members of a verified archive into place.
///
/// Every entry must be a plain file named exactly like one of `known`, once.
/// Each wanted member is read up to its pinned size plus one byte, checked
/// against its full pin, and written atomically; a member already in place is
/// skipped unread. Anything else refuses the rest of the archive. Returns the
/// names written.
fn extract<'a>(
    archive: &[u8],
    known: &[&'a Member],
    wanted: &[&str],
) -> Result<std::collections::HashSet<&'a str>, String> {
    use std::io::Read;
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(archive))
        .map_err(|e| format!("is not a readable zip: {e}"))?;
    let mut seen = std::collections::HashSet::new();
    let mut written = std::collections::HashSet::new();
    for index in 0..zip.len() {
        let mut entry = zip
            .by_index(index)
            .map_err(|e| format!("entry {index} is unreadable: {e}"))?;
        let name = entry
            .name()
            .map_err(|e| format!("entry {index} has no readable name: {e}"))?
            .into_owned();
        let Some(member) = known.iter().find(|member| member.pin.path == name) else {
            return Err(format!("holds {name}, which is not pinned."));
        };
        if !seen.insert(name.clone()) {
            return Err(format!("holds {name} twice."));
        }
        if entry.is_dir()
            || entry.is_symlink()
            || entry.encrypted()
            || !matches!(
                entry.compression(),
                zip::CompressionMethod::Stored | zip::CompressionMethod::Deflated
            )
        {
            return Err(format!(
                "holds {name} as something other than a plain file."
            ));
        }
        if !wanted.contains(&name.as_str()) {
            continue;
        }
        let mut bytes = Vec::with_capacity(member.pin.bytes as usize);
        (&mut entry)
            .take(member.pin.bytes + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| format!("could not unpack {name}: {e}"))?;
        if !Check::Full(&member.pin).accepts(&bytes) {
            REFUSALS.fetch_add(1, Ordering::Relaxed);
            return Err(format!("holds a {name} that does not match its pin."));
        }
        VERIFIED_BYTES.fetch_add(bytes.len() as u64, Ordering::Relaxed);
        crate::latex::write_atomic(&member.target, &bytes)?;
        written.insert(member.pin.path.as_str());
    }
    Ok(written)
}

/// Remove temporary files a killed process left behind. Verified assets are
/// never touched; only `.mdraft-*.tmp` names are candidates. The engine folder
/// is small, so it is walked; the TeX Live data folder can hold 100k+ files, so
/// only its top level (the list and digest table) is walked.
fn cleanup_temp_files(dir: &Path, recursive: bool) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(metadata) = fs::symlink_metadata(&path) else {
            continue;
        };
        if metadata.file_type().is_dir() {
            if recursive {
                cleanup_temp_files(&path, true);
            }
            continue;
        }
        let is_temp = entry.file_name().to_string_lossy().starts_with(".mdraft-")
            && path.extension().is_some_and(|extension| extension == "tmp");
        // Only a file older than the install budget is certainly stale. A
        // preview compiling while the install starts may legitimately be
        // writing a fresh temporary sibling; deleting that would make its
        // verified download fail for no reason.
        let stale = metadata
            .modified()
            .ok()
            .and_then(|time| time.elapsed().ok())
            .is_some_and(|age| age > Duration::from_secs(15 * 60));
        if is_temp && stale {
            let _ = fs::remove_file(&path);
        }
    }
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
/// The engine files and the digest table stay, like the other preview engine does.
pub fn clear(root: &Path) -> Result<u64, String> {
    let _writer = crate::backup::gate::writer()?;
    // The next frame deletes texpresso-luatex-caches before the app starts.
    CLEAR_FONT_CACHE.store(true, Ordering::Relaxed);
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

/// Bytes downloaded from the origin since start.
pub fn downloaded_bytes() -> u64 {
    DOWNLOADED_BYTES.load(Ordering::Relaxed)
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
    fn the_renderer_can_load_pdf_js() {
        // `ocaml.js` draws a PDF image with pdf.js, loading these two names from
        // `vendor/pdfjs/` (its data folders it passes as base URLs). An unpinned
        // name is refused, and every PDF image would show only its file name.
        let config = config();
        for name in [
            "vendor/pdfjs/pdf.min.mjs",
            "vendor/pdfjs/pdf.worker.min.mjs",
        ] {
            assert!(
                config.assets.iter().any(|pin| pin.path == name),
                "{name} is not pinned"
            );
            assert!(safe(name), "{name}");
            assert_eq!(kind(name), "text/javascript");
        }
        for folder in ["cmaps/", "standard_fonts/", "wasm/", "iccs/"] {
            let prefix = format!("vendor/pdfjs/{folder}");
            assert!(
                config
                    .assets
                    .iter()
                    .any(|pin| pin.path.starts_with(&prefix)),
                "nothing under {prefix} is pinned"
            );
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
    fn a_bad_archive_pin_is_refused() {
        let good = || {
            serde_json::json!({
                "path": "install/engine-0123456789abcdef.zip",
                "bytes": 1000,
                "sha256": "a".repeat(64),
                "base": "engine",
            })
        };
        let parse = |archives: serde_json::Value| {
            let mut value: serde_json::Value = serde_json::from_str(CONFIG).unwrap();
            value["archives"] = archives;
            validate(&serde_json::from_value::<Config>(value).unwrap())
        };
        assert!(parse(serde_json::json!([good()])).is_ok());
        let mut data = good();
        data["base"] = "data".into();
        data["path"] = "install/core.zip".into();
        assert!(parse(serde_json::json!([good(), data])).is_ok());
        assert!(
            parse(serde_json::json!([good(), good()])).is_err(),
            "two per base"
        );
        for (field, bad) in [
            ("path", serde_json::json!("files/a.zip")),
            ("path", serde_json::json!("install/../ocaml.js")),
            ("path", serde_json::json!("install/engine.tar")),
            ("sha256", serde_json::json!("ABC")),
            ("bytes", serde_json::json!(0)),
            ("bytes", serde_json::json!(MAX_ARCHIVE + 1)),
        ] {
            let mut archive = good();
            archive[field] = bad.clone();
            assert!(
                parse(serde_json::json!([archive])).is_err(),
                "{field} {bad}"
            );
        }
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
    fn the_boot_file_consumes_the_font_cache_clear_flag() {
        let root = scratch("boot-flag");
        clear(&root).unwrap();
        let (first, kind) = serve(&root, "/texpresso/boot.json").unwrap().unwrap();
        assert_eq!(kind, "application/json");
        assert!(
            String::from_utf8_lossy(&first).contains("\"clearFontCache\":true"),
            "{}",
            String::from_utf8_lossy(&first)
        );
        let (second, _) = serve(&root, "/texpresso/boot.json").unwrap().unwrap();
        assert!(
            String::from_utf8_lossy(&second).contains("\"clearFontCache\":false"),
            "{}",
            String::from_utf8_lossy(&second)
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn the_project_route_serves_a_file_with_a_live_token() {
        let root = scratch("project-route");
        fs::write(root.join("hello world.tex"), b"project bytes").unwrap();
        let token = project_token(&root).unwrap();
        let (bytes, kind) = serve(&root, &format!("/project/{token}/hello%20world.tex"))
            .unwrap()
            .unwrap();
        assert_eq!(bytes, b"project bytes");
        assert!(kind.starts_with("text/plain"), "{kind}");
        let probe = project_token(&root).unwrap();
        assert_eq!(probe, token);
        revoke_project_token(&probe);
        assert!(
            serve(&root, &format!("/project/{token}/hello%20world.tex"))
                .unwrap()
                .is_ok()
        );
        revoke_project_token(&token);
        assert!(
            serve(&root, &format!("/project/{token}/hello%20world.tex"))
                .unwrap()
                .is_err(),
            "a revoked token no longer names a root"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn the_project_route_refuses_traversal_and_encoded_traversal() {
        let root = scratch("project-traversal");
        fs::write(root.join("main.tex"), b"main").unwrap();
        let token = project_token(&root).unwrap();
        for path in [
            format!("/project/{token}/../secret.tex"),
            format!("/project/{token}/%2e%2e/secret.tex"),
            format!("/project/{token}/a/%2e%2e/%2e%2e/secret.tex"),
            format!("/project/{token}/%2fsecret.tex"),
            format!("/project/{token}/a%5cb.tex"),
        ] {
            let answer = serve(&root, &path).unwrap();
            assert!(answer.is_err(), "{path} was served: {answer:?}");
        }
        revoke_project_token(&token);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn the_project_route_refuses_a_link_and_an_oversized_file() {
        let root = scratch("project-link");
        let outside = scratch("project-link-outside");
        fs::write(outside.join("secret.tex"), b"secret").unwrap();
        fs::write(root.join("main.tex"), b"main").unwrap();
        let token = project_token(&root).unwrap();

        #[cfg(unix)]
        let made =
            std::os::unix::fs::symlink(outside.join("secret.tex"), root.join("linked.tex")).is_ok();
        #[cfg(windows)]
        let made =
            std::os::windows::fs::symlink_file(outside.join("secret.tex"), root.join("linked.tex"))
                .is_ok();
        if made {
            let answer = serve(&root, &format!("/project/{token}/linked.tex")).unwrap();
            assert!(answer.is_err(), "a symlink was served");
        }

        let large = root.join("large.bin");
        let file = fs::File::create(&large).unwrap();
        file.set_len(PROJECT_FILE_LIMIT + 1).unwrap();
        drop(file);
        let answer = serve(&root, &format!("/project/{token}/large.bin")).unwrap();
        assert!(answer.is_err(), "an oversized file was served");

        revoke_project_token(&token);
        let _ = fs::remove_dir_all(root);
        let _ = fs::remove_dir_all(outside);
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
        // A v4 list's trailing prefetch groups name no file.
        let v4 = format!("{list}=0 1 2\n=17 3 4\n");
        let table = Table::build(v4.as_bytes(), digests.clone()).unwrap();
        assert_eq!(
            table.digest("files/tt2022/v1/cherokee.tfm~h"),
            Some(prefix_of(b"three"))
        );
        assert_eq!(table.digest("files/tt2022/v1/=0 1 2~h"), None);
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
        assert!(serve(&dir, "/other/2026/file.js").is_none());
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
        install_with_progress(&root, |_, _| {}).unwrap();
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

    /// Needs `scripts/texpresso-origin-server.mjs` serving the install files
    /// (the archives and the single files) on `MDRAFT_TEXPRESSO_ORIGIN`; the
    /// bundle files are not needed. With `--fail install/=404` on the server it
    /// measures the single-file fallback instead.
    #[test]
    #[ignore = "needs the local TeXpresso origin server"]
    fn the_local_origin_installs_the_formats() {
        let root = scratch("origin-install");
        let started = Instant::now();
        let mut events = 0;
        install_with_progress(&root, |_, _| events += 1).unwrap();
        eprintln!(
            "cold install: {:.1} s, {events} progress events, {} bytes downloaded",
            started.elapsed().as_secs_f64(),
            downloaded_bytes()
        );
        assert!(available(&root));
        for pin in &config().bundle.files {
            let path = data_dir(&root).join(&pin.path);
            assert_eq!(
                fs::metadata(&path).unwrap().len(),
                pin.bytes,
                "{}",
                pin.path
            );
        }
        // Installed: the repair downloads nothing.
        let before = downloaded_bytes();
        install_with_progress(&root, |_, _| {}).unwrap();
        assert_eq!(downloaded_bytes(), before);
        fs::remove_dir_all(root).unwrap();
    }

    /// Three engine files and one data file under `root`, with their contents.
    fn install_set(root: &Path) -> Vec<(Member, Vec<u8>)> {
        [
            ("ocaml.js", Base::Engine, b"engine one".to_vec()),
            ("vendor/pdfjs/cmaps/a.bcmap", Base::Engine, b"cmap".to_vec()),
            ("vendor/pdfjs/wasm/b.wasm", Base::Engine, vec![7u8; 5000]),
            ("tt2026/v3.fmt", Base::Data, vec![1u8; 20000]),
        ]
        .into_iter()
        .map(|(path, base, bytes)| {
            let member = Member {
                pin: pin_of(path, &bytes),
                base,
                target: root.join(format!("{base:?}")).join(path),
            };
            (member, bytes)
        })
        .collect()
    }

    /// A zip of `entries`, deflated, and the archive pin it would get.
    fn zip_of(base: Base, entries: &[(&str, &[u8])]) -> (Archive, Vec<u8>) {
        use std::io::Write;
        let mut buffer = std::io::Cursor::new(Vec::new());
        {
            let mut zip = zip::ZipWriter::new(&mut buffer);
            let options = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated);
            for (name, bytes) in entries {
                zip.start_file(*name, options).unwrap();
                zip.write_all(bytes).unwrap();
            }
            zip.finish().unwrap();
        }
        let bytes = buffer.into_inner();
        let archive = Archive {
            path: format!("install/{base:?}.zip"),
            bytes: bytes.len() as u64,
            sha256: crate::latex::digest(&bytes),
            base,
        };
        (archive, bytes)
    }

    /// The result, the archive paths and file paths requested, and the
    /// progress events of one `run_install`.
    type InstallRun = (
        Result<(), String>,
        Vec<String>,
        Vec<String>,
        Vec<(u64, u64)>,
    );

    /// Run `install_from` against in-memory transports. Returns the archive
    /// paths and the file paths that were requested, and the progress events.
    fn run_install(
        members: &[Member],
        archives: &[(Archive, Vec<u8>)],
        files: &HashMap<String, Vec<u8>>,
    ) -> InstallRun {
        let archive_requests = Mutex::new(Vec::new());
        let file_requests = Mutex::new(Vec::new());
        let mut events = Vec::new();
        let pins: Vec<Archive> = archives
            .iter()
            .map(|(archive, _)| Archive {
                path: archive.path.clone(),
                bytes: archive.bytes,
                sha256: archive.sha256.clone(),
                base: archive.base,
            })
            .collect();
        let result = install_from(
            members,
            &pins,
            Instant::now() + Duration::from_secs(60),
            &|archive, on_bytes| {
                archive_requests.lock().unwrap().push(archive.path.clone());
                let (_, bytes) = archives
                    .iter()
                    .find(|(pin, _)| pin.path == archive.path)
                    .unwrap();
                on_bytes(bytes.len() as u64 / 2);
                on_bytes(bytes.len() as u64);
                Ok(bytes.clone())
            },
            &|member| {
                file_requests.lock().unwrap().push(member.pin.path.clone());
                files
                    .get(&member.pin.path)
                    .cloned()
                    .ok_or_else(|| "404".to_string())
            },
            Throttle::new(|done, total| events.push((done, total))),
        );
        let mut files = file_requests.into_inner().unwrap();
        files.sort();
        (
            result,
            archive_requests.into_inner().unwrap(),
            files,
            events,
        )
    }

    fn all_files(set: &[(Member, Vec<u8>)]) -> HashMap<String, Vec<u8>> {
        set.iter()
            .map(|(member, bytes)| (member.pin.path.clone(), bytes.clone()))
            .collect()
    }

    fn assert_installed(set: &[(Member, Vec<u8>)]) {
        for (member, bytes) in set {
            assert_eq!(
                &fs::read(&member.target).unwrap(),
                bytes,
                "{}",
                member.pin.path
            );
        }
    }

    #[test]
    fn the_archives_install_everything_without_single_files() {
        let root = scratch("archive-install");
        let set = install_set(&root);
        let members: Vec<Member> = set.iter().map(|(member, _)| member.clone()).collect();
        let engine: Vec<(&str, &[u8])> = set
            .iter()
            .filter(|(member, _)| member.base == Base::Engine)
            .map(|(member, bytes)| (member.pin.path.as_str(), bytes.as_slice()))
            .collect();
        let archives = [
            zip_of(Base::Engine, &engine),
            zip_of(Base::Data, &[("tt2026/v3.fmt", &set[3].1)]),
        ];
        let (result, asked, files, events) = run_install(&members, &archives, &HashMap::new());
        result.unwrap();
        assert_eq!(asked.len(), 2);
        assert!(files.is_empty(), "{files:?}");
        assert_installed(&set);
        // Progress counts the archives' bytes and ends at its total.
        let total = archives[0].0.bytes + archives[1].0.bytes;
        assert_eq!(events.first(), Some(&(0, total)));
        assert_eq!(events.last(), Some(&(total, total)));
        assert!(events.windows(2).all(|pair| pair[0].0 <= pair[1].0));

        // Installed and intact: the repair downloads nothing.
        let (result, asked, files, _) = run_install(&members, &archives, &HashMap::new());
        result.unwrap();
        assert!(asked.is_empty() && files.is_empty());

        // One damaged file: its archive is fetched again, and only that file
        // is rewritten.
        fs::write(&set[1].0.target, b"damaged").unwrap();
        let (result, asked, files, _) = run_install(&members, &archives, &HashMap::new());
        result.unwrap();
        assert_eq!(asked, vec![archives[0].0.path.clone()]);
        assert!(files.is_empty());
        assert_installed(&set);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn without_an_archive_every_file_is_fetched_singly() {
        let root = scratch("archive-none");
        let set = install_set(&root);
        let members: Vec<Member> = set.iter().map(|(member, _)| member.clone()).collect();
        let (result, asked, files, events) = run_install(&members, &[], &all_files(&set));
        result.unwrap();
        assert!(asked.is_empty());
        assert_eq!(files.len(), set.len());
        assert_installed(&set);
        let total: u64 = set.iter().map(|(member, _)| member.pin.bytes).sum();
        assert_eq!(events.last(), Some(&(total, total)));

        // A file the origin does not have fails the install by name.
        let root = scratch("archive-none-missing");
        let set = install_set(&root);
        let members: Vec<Member> = set.iter().map(|(member, _)| member.clone()).collect();
        let mut files = all_files(&set);
        files.remove("ocaml.js");
        let (result, _, _, _) = run_install(&members, &[], &files);
        assert!(result.unwrap_err().contains("ocaml.js"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_bad_archive_falls_back_to_single_files() {
        let fmt: &[u8] = &[1u8; 20000];
        type Case<'a> = (&'a str, Vec<(&'a str, Vec<u8>)>);
        let cases: Vec<Case> = vec![
            // First, so that no verified member is written before the refusal.
            (
                "unknown member",
                vec![("evil.js", b"x".to_vec()), ("tt2026/v3.fmt", fmt.to_vec())],
            ),
            ("traversal", vec![("../tt2026/v3.fmt", fmt.to_vec())]),
            (
                "member over its pin",
                vec![("tt2026/v3.fmt", vec![1u8; 20001])],
            ),
            (
                "member off its pin",
                vec![("tt2026/v3.fmt", vec![2u8; 20000])],
            ),
        ];
        for (case, entries) in cases {
            let root = scratch("archive-bad");
            let set = install_set(&root);
            let members: Vec<Member> = set.iter().map(|(member, _)| member.clone()).collect();
            let entries: Vec<(&str, &[u8])> = entries
                .iter()
                .map(|(name, bytes)| (*name, bytes.as_slice()))
                .collect();
            let archives = [zip_of(Base::Data, &entries)];
            let (result, asked, files, _) = run_install(&members, &archives, &all_files(&set));
            result.unwrap_or_else(|error| panic!("{case}: {error}"));
            assert_eq!(asked.len(), 1, "{case}");
            assert!(
                files.contains(&"tt2026/v3.fmt".to_string()),
                "{case}: {files:?}"
            );
            assert_installed(&set);
            fs::remove_dir_all(root).unwrap();
        }

        // An archive whose bytes do not match its pin is never opened.
        let root = scratch("archive-bad-pin");
        let set = install_set(&root);
        let members: Vec<Member> = set.iter().map(|(member, _)| member.clone()).collect();
        let (mut archive, bytes) = zip_of(Base::Data, &[("tt2026/v3.fmt", fmt)]);
        archive.sha256 = "0".repeat(64);
        let (result, _, files, _) = run_install(&members, &[(archive, bytes)], &all_files(&set));
        result.unwrap();
        assert!(files.contains(&"tt2026/v3.fmt".to_string()));
        assert_installed(&set);

        // When the fallback fails too, the error names both.
        let root = scratch("archive-bad-both");
        let set = install_set(&root);
        let members: Vec<Member> = set.iter().map(|(member, _)| member.clone()).collect();
        let (archive, bytes) = zip_of(Base::Data, &[("evil.js", b"x")]);
        let mut files = all_files(&set);
        files.remove("tt2026/v3.fmt");
        let (result, _, _, _) = run_install(&members, &[(archive, bytes)], &files);
        let error = result.unwrap_err();
        assert!(
            error.contains("tt2026/v3.fmt") && error.contains("evil.js"),
            "{error}"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_link_or_a_duplicate_in_an_archive_is_refused() {
        let root = scratch("archive-shapes");
        let set = install_set(&root);
        let known: Vec<&Member> = set.iter().map(|(member, _)| member).collect();
        let wanted = ["ocaml.js"];

        let mut buffer = std::io::Cursor::new(Vec::new());
        {
            let mut zip = zip::ZipWriter::new(&mut buffer);
            let options = zip::write::SimpleFileOptions::default();
            zip.add_symlink("ocaml.js", "../../outside", options)
                .unwrap();
            zip.finish().unwrap();
        }
        let error = extract(buffer.get_ref(), &known, &wanted).unwrap_err();
        assert!(error.contains("plain file"), "{error}");
        assert!(!set[0].0.target.exists());

        let error = extract(b"not a zip", &known, &wanted).unwrap_err();
        assert!(error.contains("zip"), "{error}");

        // A member already in place is skipped unread; one that is not
        // wanted is never written.
        let (_, bytes) = zip_of(
            Base::Engine,
            &[
                ("ocaml.js", &set[0].1),
                ("vendor/pdfjs/cmaps/a.bcmap", &set[1].1),
            ],
        );
        let written = extract(&bytes, &known, &wanted).unwrap();
        assert_eq!(written.into_iter().collect::<Vec<_>>(), vec!["ocaml.js"]);
        assert!(!set[1].0.target.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn progress_is_throttled_but_reaches_its_end() {
        let mut events = Vec::new();
        let mut throttle = Throttle::new(|done, total| events.push((done, total)));
        for done in 0..=1000 {
            throttle.report(done, 1000);
        }
        throttle.report(1000, 1000);
        throttle.report(1000, 1500);
        assert!(events.len() <= 205, "{}", events.len());
        assert_eq!(events.first(), Some(&(0, 1000)));
        assert!(events.contains(&(1000, 1000)));
        assert_eq!(events.last(), Some(&(1000, 1500)));
    }
}
