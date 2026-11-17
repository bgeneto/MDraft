//! The PhiTeX compatibility preview: install, serve and package cache.
//!
//! PhiTeX's single-threaded `core1.wasm` runs in the frame's worker. The shell
//! (`index.html`, `bundles/main.js`, `bundles/engine-worker.js`) is embedded in the
//! executable; the engine, formats, TeX Live kernel files and Shelf index are
//! one pinned archive downloaded from `mdraft.webonly.app`, verified by its
//! whole SHA-256, and extracted under the app data directory. Shelf packs are
//! fetched on demand through this module and cached, so the frame's policy
//! stays `connect-src 'self'`.
//!
//! The archive's SHA-256 is the trust root: every member is written only after
//! the whole archive verifies. The core checks each pack against the pinned
//! pack table again before using it.

use flate2::read::GzDecoder;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    io::{Cursor, Read},
    path::{Path, PathBuf},
    sync::{
        Mutex, OnceLock,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};
use tauri::http::header;

use crate::optional_tools::{self, Phase};

const CONFIG: &str = include_str!("../phitex.json");
const INDEX: &[u8] = include_bytes!("../phitex-shell/index.html");
const MAIN: &[u8] = include_bytes!("../phitex-shell/bundles/main.js");
const WORKER: &[u8] = include_bytes!("../phitex-shell/bundles/engine-worker.js");

const MAX_ARCHIVE: u64 = 96 * 1024 * 1024;
const MAX_PACK: u64 = 64 * 1024 * 1024;
const MAX_FILE: u64 = 64 * 1024 * 1024;
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(180);

type Answer = Result<(Vec<u8>, &'static str), String>;

#[derive(Deserialize)]
struct Config {
    release: String,
    origin: String,
    archive: Archive,
    shelf: Shelf,
}

#[derive(Deserialize)]
struct Archive {
    path: String,
    sha256: String,
    bytes: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Shelf {
    hosts: Vec<String>,
    pack_table: String,
    release_json: String,
}

fn config() -> &'static Config {
    static PARSED: OnceLock<Config> = OnceLock::new();
    PARSED.get_or_init(|| serde_json::from_str(CONFIG).expect("src-tauri/phitex.json is not valid"))
}

fn data(root: &Path) -> PathBuf {
    root.join("phitex")
}
fn files(root: &Path) -> PathBuf {
    data(root).join("files")
}
fn cache(root: &Path) -> PathBuf {
    data(root).join("cache")
}
fn packs(root: &Path) -> PathBuf {
    cache(root).join("packs")
}
fn marker(root: &Path) -> PathBuf {
    data(root).join(".release")
}

static HITS: AtomicU64 = AtomicU64::new(0);
static MISSES: AtomicU64 = AtomicU64::new(0);
static VERIFIED: AtomicU64 = AtomicU64::new(0);
static REFUSALS: AtomicU64 = AtomicU64::new(0);
static DOWNLOADED: AtomicU64 = AtomicU64::new(0);
static CACHE_LIMIT: AtomicU64 = AtomicU64::new(512 * 1024 * 1024);

pub fn set_cache_limit(bytes: u64) {
    CACHE_LIMIT.store(bytes, Ordering::Relaxed);
}

pub fn stats() -> (u64, u64, u64, u64) {
    (
        HITS.load(Ordering::Relaxed),
        MISSES.load(Ordering::Relaxed),
        VERIFIED.load(Ordering::Relaxed),
        REFUSALS.load(Ordering::Relaxed),
    )
}

pub fn downloaded_bytes() -> u64 {
    DOWNLOADED.load(Ordering::Relaxed)
}

/// Whether the pinned archive is installed and complete enough to boot.
pub fn available(root: &Path) -> bool {
    let root = data(root);
    fs::read_to_string(root.join(".release")).is_ok_and(|text| text.trim() == config().release)
        && root.join("files/dist/core1.wasm").is_file()
        && root.join("files/formats/names.txt").is_file()
}

pub fn cache_bytes(root: &Path) -> u64 {
    crate::latex::cache_size(&cache(root)).unwrap_or(0)
}

/// Clear the on-demand package cache, keeping the installed engine and formats.
pub fn clear(root: &Path) -> Result<u64, String> {
    let dir = cache(root);
    let bytes = crate::latex::cache_size(&dir).unwrap_or(0);
    if dir.exists() {
        fs::remove_dir_all(&dir).map_err(|error| error.to_string())?;
    }
    Ok(bytes)
}

fn digest(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn download(url: &str, cap: u64, progress: impl FnMut(u64)) -> Result<Vec<u8>, String> {
    let deadline = Instant::now() + DOWNLOAD_TIMEOUT;
    let mut response = ureq::get(url)
        .config()
        .timeout_global(Some(DOWNLOAD_TIMEOUT))
        .build()
        .call()
        .map_err(|error| format!("Download failed: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("Download failed: HTTP {}", response.status()));
    }
    let mut reader = response.body_mut().as_reader();
    optional_tools::read_to_vec_bounded(&mut reader, cap, deadline, progress)
}

pub fn install_with_progress(
    root: &Path,
    mut emit: impl FnMut(Phase, u64, Option<u64>),
) -> Result<(), String> {
    if available(root) {
        emit(Phase::Ready, 0, None);
        return Ok(());
    }
    let cfg = config();
    let origin = std::env::var("MDRAFT_PHITEX_ORIGIN").unwrap_or_else(|_| cfg.origin.clone());
    let url = format!(
        "{}/{}",
        origin.trim_end_matches('/'),
        cfg.archive.path.trim_start_matches('/')
    );
    let total = Some(cfg.archive.bytes);
    emit(Phase::Downloading, 0, total);
    let mut last = 0u64;
    let archive = download(&url, MAX_ARCHIVE, |received| {
        if received.saturating_sub(last) >= 256 * 1024 {
            last = received;
            emit(Phase::Downloading, received, total);
        }
    })?;
    emit(Phase::Downloading, archive.len() as u64, total);
    if archive.len() as u64 != cfg.archive.bytes {
        return Err("The PhiTeX archive has an unexpected size.".into());
    }
    emit(Phase::Verifying, 0, None);
    if digest(&archive) != cfg.archive.sha256 {
        REFUSALS.fetch_add(1, Ordering::Relaxed);
        return Err("The downloaded PhiTeX archive failed SHA-256 verification.".into());
    }
    emit(Phase::Unpacking, 0, None);
    let target = files(root);
    if target.exists() {
        fs::remove_dir_all(&target).map_err(|error| error.to_string())?;
    }
    fs::create_dir_all(&target).map_err(|error| error.to_string())?;
    let mut zip = zip::ZipArchive::new(Cursor::new(archive)).map_err(|error| error.to_string())?;
    let count = zip.len();
    for index in 0..count {
        let mut entry = zip.by_index(index).map_err(|error| error.to_string())?;
        let name = entry.name().map_err(|error| error.to_string())?.to_string();
        if entry.is_dir() {
            continue;
        }
        if entry.is_symlink() || entry.encrypted() {
            return Err("The PhiTeX archive contains a link or encrypted member.".into());
        }
        if !crate::latex::safe_relative(&name) {
            return Err(format!(
                "The PhiTeX archive contains an unsafe path: {name}"
            ));
        }
        let declared = entry.size();
        if declared > MAX_FILE {
            return Err(format!("{name} is larger than the PhiTeX file limit."));
        }
        let mut bytes = Vec::with_capacity(declared.min(MAX_FILE) as usize);
        entry
            .by_ref()
            .take(MAX_FILE + 1)
            .read_to_end(&mut bytes)
            .map_err(|error| error.to_string())?;
        if bytes.len() as u64 > MAX_FILE {
            return Err(format!("{name} is larger than the PhiTeX file limit."));
        }
        crate::latex::write_atomic(&target.join(&name), &bytes)?;
        emit(Phase::Unpacking, index as u64 + 1, Some(count as u64));
    }
    crate::latex::write_atomic(&marker(root), cfg.release.as_bytes())?;
    emit(Phase::Ready, 0, None);
    Ok(())
}

/// One pinned file from the installed archive.
fn installed(root: &Path, relative: &str) -> Option<Vec<u8>> {
    if !crate::latex::safe_relative(relative) {
        return None;
    }
    let path = files(root).join(relative);
    if !path.is_file() {
        return None;
    }
    fs::read(path).ok()
}

fn kind(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" => "text/javascript; charset=utf-8",
        "wasm" => "application/wasm",
        "json" => "application/json",
        "txt" => "text/plain; charset=utf-8",
        "sty" | "cls" | "def" | "cfg" | "bst" | "tex" | "bib" => "text/plain; charset=utf-8",
        "otf" => "font/otf",
        "ttf" => "font/ttf",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        _ => "application/octet-stream",
    }
}

/// A pack's expected size and SHA-256 from the installed pack table.
type PackTable = HashMap<String, (String, u64)>;

fn pack_expected(root: &Path, id: &str) -> Option<(String, u64)> {
    static TABLE: OnceLock<Mutex<Option<(PathBuf, PackTable)>>> = OnceLock::new();
    let table = TABLE.get_or_init(|| Mutex::new(None));
    let path = files(root).join(&config().shelf.pack_table);
    let mut guard = table.lock().ok()?;
    if guard.as_ref().is_none_or(|(cached, _)| *cached != path) {
        let bytes = fs::read(&path).ok()?;
        let mut decoded = String::new();
        GzDecoder::new(Cursor::new(bytes))
            .read_to_string(&mut decoded)
            .ok()?;
        let mut map = HashMap::new();
        for line in decoded.lines() {
            let mut fields = line.split('\t');
            let (Some(name), Some(sha), Some(size)) = (fields.next(), fields.next(), fields.next())
            else {
                continue;
            };
            if let Ok(size) = size.parse::<u64>() {
                map.insert(name.to_string(), (sha.to_string(), size));
            }
        }
        *guard = Some((path, map));
    }
    guard.as_ref().and_then(|(_, map)| map.get(id).cloned())
}

fn verified_pack(bytes: &[u8], expected: &(String, u64)) -> bool {
    bytes.len() as u64 == expected.1 && digest(bytes) == expected.0
}

fn shelf_pack(root: &Path, id: &str) -> Answer {
    if id.is_empty()
        || id.len() > 256
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
    {
        return Err("Invalid pack name".into());
    }
    let expected = pack_expected(root, id).ok_or_else(|| format!("pack {id} is not pinned"))?;
    let cached = packs(root).join(format!("{id}.pack"));
    if let Ok(bytes) = fs::read(&cached)
        && verified_pack(&bytes, &expected)
    {
        HITS.fetch_add(1, Ordering::Relaxed);
        VERIFIED.fetch_add(bytes.len() as u64, Ordering::Relaxed);
        return Ok((bytes, "application/octet-stream"));
    }
    MISSES.fetch_add(1, Ordering::Relaxed);
    for host in &config().shelf.hosts {
        let url = format!("{}h/{}.pack", host, id);
        let bytes = match download(&url, MAX_PACK, |_| {}) {
            Ok(bytes) => bytes,
            Err(_) => continue,
        };
        DOWNLOADED.fetch_add(bytes.len() as u64, Ordering::Relaxed);
        if !verified_pack(&bytes, &expected) {
            REFUSALS.fetch_add(1, Ordering::Relaxed);
            continue;
        }
        let dir = packs(root);
        fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
        let limit = CACHE_LIMIT.load(Ordering::Relaxed);
        crate::latex::evict_to_limit_keeping(
            &dir,
            limit.saturating_sub(bytes.len() as u64),
            &|path| path == cached,
        )?;
        crate::latex::write_atomic(&cached, &bytes)?;
        VERIFIED.fetch_add(bytes.len() as u64, Ordering::Relaxed);
        return Ok((bytes, "application/octet-stream"));
    }
    Err(format!("Shelf has no pack {id}"))
}

pub fn serve(root: &Path, path: &str) -> Option<Answer> {
    let rest = path.strip_prefix("/phitex/")?;
    if rest.is_empty() || rest == "index.html" {
        return Some(Ok((INDEX.to_vec(), "text/html; charset=utf-8")));
    }
    if rest == "bundles/main.js" || rest == "dist/main.js" {
        return Some(Ok((MAIN.to_vec(), "text/javascript; charset=utf-8")));
    }
    if rest == "bundles/engine-worker.js" || rest == "dist/engine-worker.js" {
        return Some(Ok((WORKER.to_vec(), "text/javascript; charset=utf-8")));
    }
    if rest == "shelf/release.json" {
        return Some(
            installed(root, &config().shelf.release_json)
                .map(|bytes| (bytes, "application/json"))
                .ok_or_else(|| "the pinned Shelf release is missing".into()),
        );
    }
    if let Some(id) = rest.strip_prefix("shelf/h/") {
        let id = id.strip_suffix(".pack").unwrap_or(id);
        return Some(shelf_pack(root, id));
    }
    if rest.starts_with("shelf/") {
        return Some(Err("Unknown Shelf resource".into()));
    }
    Some(
        installed(root, rest)
            .map(|bytes| (bytes, kind(rest)))
            .ok_or_else(|| "Unknown PhiTeX resource".into()),
    )
}

/// The frame's policy is the shared one; this keeps the response header names
/// in one place if the shell ever needs a different one.
#[allow(dead_code)]
const CONTENT_TYPE: header::HeaderName = header::CONTENT_TYPE;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_pack_name_cannot_escape_its_directory() {
        for bad in ["", "../x", "a/b", "a\\b", "a?b", "a%2fb"] {
            assert!(shelf_pack(Path::new("/nonexistent"), bad).is_err());
        }
    }

    #[test]
    fn the_pin_names_a_release_and_archive() {
        let cfg = config();
        assert!(!cfg.release.is_empty());
        assert!(cfg.archive.sha256.len() == 64);
        assert!(cfg.archive.bytes > 0);
        assert!(!cfg.shelf.hosts.is_empty());
    }
}
