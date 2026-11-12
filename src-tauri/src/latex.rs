//! Experimental, explicitly enabled WasmTex assets and bounded project reads.
//!
//! The WebView never talks to the TeX mirror directly. Its synchronous worker
//! requests use this fixed-origin scheme; source files never enter the URL.
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{
        Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
};
use tauri::{
    AppHandle, Emitter, Manager, UriSchemeResponder,
    http::{Request, Response, header},
};

pub const SCHEME: &str = "mdraft-tex";
// The TeX Live year is one pinned unit (docs/adr/2026-11-12-engine-year-and-cache-namespace.md).
// The engine, its format, the worker shims in `public/wasmtex/<year>/`, the SDK
// year in `src/latex.ts` and the package mirror must all name the same year and
// snapshot, and the `mdraft-tex` URL carries no year the SDK could check, so
// `year_is_one_pinned_unit` and `scripts/latex-sdk-unit.mjs` fail when they drift.
// This is upstream's `2026-latest` profile `2026-20260826-f5d9443`.
const ASSET_ROOT: &str = "https://corca-ai.github.io/wasmtex/wasmtex/2026/";
/// The path the worker shims and the SDK request assets under.
const ASSET_PREFIX: &str = "/wasmtex/2026/";
const MIRROR: &str = "https://texlive.corca.ai/snapshots/2026-d26706764b740276/2026/";
/// Names the mirror's cache directory: the same relative path holds different
/// bytes in another revision, so a flat cache would mix years.
const MIRROR_REVISION: &str = "2026-d26706764b740276";
/// The engine release the pinned digests belong to; `assets/.release` names it.
const ENGINE_RELEASE: &str = "2026-f5d94438a7c75a23";
const RELEASE_MARKER: &str = ".release";
const MAX_FILE: usize = 32 * 1024 * 1024;
const MAX_PROJECT: usize = 64 * 1024 * 1024;
const MAX_FILES: usize = 256;
static TEMP_ID: AtomicU64 = AtomicU64::new(0);
static CACHE_LOCK: Mutex<()> = Mutex::new(());
/// One engine installation at a time; Pandoc and Typst have their own locks.
static INSTALL_LOCK: Mutex<()> = Mutex::new(());
static MIGRATION_LOCK: Mutex<()> = Mutex::new(());
static ASSET_REQUESTS: AtomicU64 = AtomicU64::new(0);
static CACHE_HITS: AtomicU64 = AtomicU64::new(0);
static CACHE_MISSES: AtomicU64 = AtomicU64::new(0);

/// The switch and the cache ceiling, mirrored in memory.
///
/// The `mdraft-tex` scheme handler is synchronous and runs for every package a
/// compile requests, so it cannot parse `settings.json` per request. `AppState`
/// writes this mirror whenever settings are loaded or saved, and the handler
/// reads it. `None` means "not read yet", which is treated as disabled: an
/// engine that has not been switched on must never serve assets.
static ENABLED: AtomicBool = AtomicBool::new(false);
static CACHE_LIMIT_MB: AtomicU64 = AtomicU64::new(256);

/// Mirror the settings the scheme handler needs. Called on load and on save.
pub fn apply_settings(settings: &crate::settings::Settings) {
    ENABLED.store(settings.latex_enabled, Ordering::Relaxed);
    CACHE_LIMIT_MB.store(settings.latex_cache_limit_mb as u64, Ordering::Relaxed);
}

fn enabled() -> bool {
    ENABLED.load(Ordering::Relaxed)
}

fn cache_limit_bytes() -> u64 {
    CACHE_LIMIT_MB
        .load(Ordering::Relaxed)
        .saturating_mul(1024 * 1024)
}

// Digests from the pinned release-cleared manifest of release 2026-f5d94438a7c75a23,
// SHA-256 46ec5ab3…509f6, checked against the downloaded files, not only the manifest.
const ASSETS: &[(&str, &str)] = &[
    (
        "wasmtex-luatex.js",
        "2b16bc7f892a068a548e8950b7d3987f6b23ff2bac4ba6258520739a402906ef",
    ),
    (
        "wasmtex-luatex.wasm",
        "a5d940bf6e8f989c55816ceb06dfad8687100a58d109fa92873175ed4e48b53e",
    ),
    (
        "wasmtex-luatex.worker.js",
        "9a065d4c22b05ac7d937956fc3d654079a599744e5e8fb753fa528e7489da084",
    ),
    (
        "wasmtex-luatex.fmt.gz",
        "1e58b5d1ee400e937c5b690cc4e34af20458c42162b0340f8c06903c40a5ed0b",
    ),
    (
        "wasmtex-luatex-resolver-evidence.js",
        "f42ab09591de3108ac07635f060cc1fca27571f62a852edf5e6307515b83b728",
    ),
    (
        "wasmtex-bibtex.js",
        "1355f9aa7a7fa27a514876a448bbe7b17ba07cfb1ec2c1a251a2d4f0ebc9d9b4",
    ),
    (
        "wasmtex-bibtex.wasm",
        "7ee47f5959d9f2a0d4cbde264be97472b6c1b7a1da2ca58b67baea759b03c3d6",
    ),
    (
        "wasmtex-bibtex.worker.js",
        "73700491b6c38c1d1ba7275e294542dcce9d3ef4485b12dcb63bf53a23a4d990",
    ),
];

/// The previous release's digests (2025-3a6c0df0b2b95005, manifest SHA-256
/// 928bd4b7…3d12b4a). Used only to recognise a pre-`latex/` directory that still
/// holds those files, so it migrates instead of being refused as damaged. Four
/// entries differ from `ASSETS`; the names are the same.
const ASSETS_2025: &[(&str, &str)] = &[
    (
        "wasmtex-luatex.js",
        "9c643deba29dc4cd590c12bc4bd1d2a4ee8d588402390d3ac06818ff317914f9",
    ),
    (
        "wasmtex-luatex.wasm",
        "e5b585bf6b575b379ec2e390fa1572160c9578f12238f55164ab3f8cea7b75cf",
    ),
    (
        "wasmtex-luatex.worker.js",
        "9a065d4c22b05ac7d937956fc3d654079a599744e5e8fb753fa528e7489da084",
    ),
    (
        "wasmtex-luatex.fmt.gz",
        "ae8d91969476536758a18aaf6da91cb94f056b3bc568878a2852a7b8ff43e070",
    ),
    (
        "wasmtex-luatex-resolver-evidence.js",
        "f42ab09591de3108ac07635f060cc1fca27571f62a852edf5e6307515b83b728",
    ),
    (
        "wasmtex-bibtex.js",
        "1355f9aa7a7fa27a514876a448bbe7b17ba07cfb1ec2c1a251a2d4f0ebc9d9b4",
    ),
    (
        "wasmtex-bibtex.wasm",
        "8073e95a81cf03376bbbe503ecd7fcf748a5f897ea308f0e5e42162e78b7b3df",
    ),
    (
        "wasmtex-bibtex.worker.js",
        "73700491b6c38c1d1ba7275e294542dcce9d3ef4485b12dcb63bf53a23a4d990",
    ),
];

/// Whether `assets` holds every file of `set`, byte for byte.
fn assets_match(assets: &Path, set: &[(&str, &str)]) -> bool {
    set.iter().all(|(name, expected)| {
        let asset = assets.join(name);
        fs::symlink_metadata(&asset).is_ok_and(|meta| meta.file_type().is_file())
            && fs::read(&asset).is_ok_and(|bytes| digest(&bytes) == *expected)
    })
}

/// Whether `assets` holds the pinned engine release.
///
/// The marker is written last by `install_latex`, so it names a release only
/// when every file was verified. This checks that the files still exist, not
/// their hashes: the scheme handler verifies the SHA-256 of everything it serves,
/// and hashing 12 MB for each status call would answer nothing a marker does not.
/// An engine from an earlier release has no marker or the wrong one, so it reads
/// as not installed instead of as working and then failing every compile.
fn engine_installed(assets: &Path) -> bool {
    fs::read_to_string(assets.join(RELEASE_MARKER))
        .is_ok_and(|text| text.trim() == ENGINE_RELEASE)
        && ASSETS.iter().all(|(name, _)| {
            fs::symlink_metadata(assets.join(name)).is_ok_and(|meta| meta.file_type().is_file())
        })
}

/// Where the mirror caches `relative`: namespaced by the pinned revision.
fn cache_path(root: &Path, relative: &str) -> PathBuf {
    root.join("mirror").join(MIRROR_REVISION).join(relative)
}

fn legacy_candidates_matching(
    root: &Path,
    verify: &impl Fn(&Path) -> bool,
) -> Result<Vec<PathBuf>, String> {
    let entries = match fs::read_dir(root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(format!("Cannot inspect the LaTeX data directory: {error}")),
    };
    let mut candidates = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;
        if entry.file_name() == "latex" || !entry.file_type().is_ok_and(|kind| kind.is_dir()) {
            continue;
        }
        let assets = entry.path().join("assets");
        if !fs::symlink_metadata(&assets).is_ok_and(|meta| meta.file_type().is_dir()) {
            continue;
        }
        if verify(&assets) {
            candidates.push(entry.path());
        }
    }
    Ok(candidates)
}

/// A directory from before `latex/` counts when it holds either release's files.
fn verified_legacy_assets(assets: &Path) -> bool {
    assets_match(assets, ASSETS) || assets_match(assets, ASSETS_2025)
}

fn legacy_candidates(root: &Path) -> Result<Vec<PathBuf>, String> {
    let candidates = legacy_candidates_matching(root, &verified_legacy_assets)?;
    if let Ok(entries) = fs::read_dir(root) {
        for entry in entries {
            let entry = entry.map_err(|error| error.to_string())?;
            if entry.file_name() == "latex" || !entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                continue;
            }
            let assets = entry.path().join("assets");
            if !fs::symlink_metadata(&assets).is_ok_and(|meta| meta.file_type().is_dir()) {
                continue;
            }
            if ASSETS.iter().any(|(name, _)| assets.join(name).exists())
                && !candidates.contains(&entry.path())
            {
                return Err("An incomplete or damaged LaTeX engine directory was preserved. Repair it before migrating the bundled engine.".into());
            }
        }
    }
    Ok(candidates)
}

fn migrate_directory_matching(
    root: &Path,
    verify: &impl Fn(&Path) -> bool,
) -> Result<PathBuf, String> {
    let _guard = MIGRATION_LOCK
        .lock()
        .map_err(|_| "LaTeX migration is unavailable.")?;
    let target = root.join("latex");
    let candidates = legacy_candidates_matching(root, verify)?;
    if candidates.len() > 1 || (!candidates.is_empty() && target.exists()) {
        return Err("Multiple LaTeX data directories exist. They were preserved; resolve the conflict before using the bundled engine.".into());
    }
    if let Some(source) = candidates.first() {
        fs::rename(source, &target).map_err(|error| {
            format!("Could not move the existing LaTeX data; the original was preserved: {error}")
        })?;
    }
    Ok(target)
}

fn migrate_directory(root: &Path) -> Result<PathBuf, String> {
    // Check for recognizable but incomplete directories before making changes.
    legacy_candidates(root)?;
    migrate_directory_matching(root, &verified_legacy_assets)
}

pub(crate) fn directory(app: &AppHandle) -> Result<PathBuf, String> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Cannot locate the LaTeX data directory: {e}"))?;
    if enabled() {
        return migrate_directory(&root);
    }
    let target = root.join("latex");
    let candidates = legacy_candidates(&root)?;
    if candidates.len() > 1 || (!candidates.is_empty() && target.exists()) {
        return Err("Multiple LaTeX data directories exist. They were preserved; resolve the conflict before using the bundled engine.".into());
    }
    Ok(candidates.into_iter().next().unwrap_or(target))
}

/// Whether the reader has enabled the engine.
///
/// Settings-backed, so a portable build and a settings backup carry the switch.
/// The asset files themselves are a separate question: `latex_status` is true
/// only when the switch is on *and* the pinned release is installed, because a
/// switch that promises an engine it cannot run is the dead UI this project
/// refuses. An engine from an earlier release does not count.
#[tauri::command]
pub fn latex_status(app: AppHandle) -> Result<bool, String> {
    if !enabled() {
        return Ok(false);
    }
    Ok(engine_installed(&directory(&app)?.join("assets")))
}

/// Whether the pre-settings marker file exists, for the one-time migration.
///
/// The old engine stored enablement beside its verified assets. Settings load
/// adopts the marker only when the settings file has no explicit switch.
pub fn legacy_marker_present<R: tauri::Runtime>(app: &AppHandle<R>) -> bool {
    app.path().app_data_dir().is_ok_and(|dir| {
        (dir.join("latex").join("enabled").is_file()
            && verified_legacy_assets(&dir.join("latex").join("assets")))
            || legacy_candidates(&dir).is_ok_and(|candidates| {
                candidates.len() == 1 && candidates[0].join("enabled").is_file()
            })
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LatexStats {
    asset_requests: u64,
    cache_hits: u64,
    cache_misses: u64,
}

/// Aggregate transport counters, without document paths or content.
#[tauri::command]
pub fn latex_stats() -> LatexStats {
    LatexStats {
        asset_requests: ASSET_REQUESTS.load(Ordering::Relaxed),
        cache_hits: CACHE_HITS.load(Ordering::Relaxed),
        cache_misses: CACHE_MISSES.load(Ordering::Relaxed),
    }
}

/// What Preferences reports about the downloaded package cache.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LatexCacheInfo {
    /// The bytes currently on disk.
    bytes: u64,
    /// The reader's ceiling, in MiB.
    limit_mb: u32,
    /// Whether the engine switch is on.
    enabled: bool,
    /// Whether the verified engine assets are present.
    installed: bool,
}

/// Report the cache size and the switch, for the Preferences row.
#[tauri::command]
pub fn latex_cache_info(app: AppHandle) -> Result<LatexCacheInfo, String> {
    let root = directory(&app)?;
    let limit_mb = CACHE_LIMIT_MB.load(Ordering::Relaxed).min(u32::MAX as u64) as u32;
    Ok(LatexCacheInfo {
        bytes: cache_size(&root.join("mirror")).unwrap_or(0),
        limit_mb,
        enabled: enabled(),
        installed: engine_installed(&root.join("assets")),
    })
}

/// Turn the engine off.
///
/// Deletes nothing: the reader's cache stays where it is, inert, and Clear cache
/// remains the only destructive action (decision D14). Turning the switch off
/// stops the `mdraft-tex` scheme from serving anything, so a compile that is
/// already running fails closed rather than continuing to read assets.
#[tauri::command]
pub fn latex_disable(app: AppHandle) -> Result<(), String> {
    let state = app
        .try_state::<crate::settings::AppState>()
        .ok_or("The settings store is unavailable.")?;
    let mut settings = state.snapshot()?;
    settings.latex_enabled = false;
    state.save(settings)?;
    Ok(())
}

/// Delete the downloaded TeX package cache.
///
/// The only destructive LaTeX action, and it is the reader's: nothing here is
/// called automatically. The engine assets are kept, so a compile after clearing
/// re-downloads packages but does not reinstall the engine.
#[tauri::command]
pub fn latex_clear_cache(app: AppHandle) -> Result<u64, String> {
    let root = directory(&app)?;
    let mirror = root.join("mirror");
    let _guard = CACHE_LOCK
        .lock()
        .map_err(|_| "The LaTeX cache is unavailable.")?;
    let freed = cache_size(&mirror).unwrap_or(0);
    if mirror.exists() {
        fs::remove_dir_all(&mirror).map_err(|e| e.to_string())?;
    }
    Ok(freed)
}

fn download(url: &str) -> Result<Vec<u8>, String> {
    if std::env::var_os("MDRAFT_WASMTEX_OFFLINE").is_some() {
        return Err("The experimental LaTeX network is disabled.".into());
    }
    let mut response = ureq::get(url)
        .call()
        .map_err(|e| format!("Download failed: {e}"))?;
    response
        .body_mut()
        .with_config()
        .limit(MAX_FILE as u64)
        .read_to_vec()
        .map_err(|e| format!("Cannot read download: {e}"))
}

pub(crate) fn write_atomic(path: &Path, data: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("Invalid cache path")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let temp = parent.join(format!(
        ".mdraft-{}-{}.tmp",
        std::process::id(),
        TEMP_ID.fetch_add(1, Ordering::Relaxed)
    ));
    fs::write(&temp, data).map_err(|e| e.to_string())?;
    match fs::rename(&temp, path) {
        Ok(()) => Ok(()),
        Err(_) if path.is_file() => {
            let _ = fs::remove_file(temp);
            Ok(())
        }
        Err(e) => {
            let _ = fs::remove_file(temp);
            Err(e.to_string())
        }
    }
}

pub(crate) fn digest(data: &[u8]) -> String {
    Sha256::digest(data)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// Called only by the explicit experimental setup action.
///
/// Downloads and verifies the engine assets, then turns the settings switch on.
/// The switch lives in `settings.json` (decision D2) so a portable build and a
/// settings backup carry it; the cache directory holds downloaded bytes only.
#[tauri::command]
pub async fn install_latex(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        // A second Download waits and then finds the verified assets in place.
        let _install = INSTALL_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let data_root = app
            .path()
            .app_data_dir()
            .map_err(|error| format!("Cannot locate the LaTeX data directory: {error}"))?;
        let root = migrate_directory(&data_root)?;
        let assets = root.join("assets");
        // Retire the marker first: a directory that is part-way between two
        // releases must never claim either one.
        remove_if_present(&assets.join(RELEASE_MARKER))?;
        for &(name, expected) in ASSETS {
            let path = assets.join(name);
            if fs::read(&path).is_ok_and(|bytes| digest(&bytes) == expected) {
                continue;
            }
            let bytes = download(&format!("{ASSET_ROOT}{name}"))?;
            if digest(&bytes) != expected {
                return Err(format!(
                    "The downloaded {name} failed SHA-256 verification."
                ));
            }
            // A corrupt old file must not win the atomic-install race.
            remove_if_present(&path)?;
            write_atomic(&path, &bytes)?;
        }
        // Every file is verified, so the release can be claimed. Written last.
        write_atomic(&assets.join(RELEASE_MARKER), ENGINE_RELEASE.as_bytes())?;
        // The switch is settings-backed, so it is written through `AppState`
        // rather than as a marker file beside the cache.
        if let Some(state) = app.try_state::<crate::settings::AppState>() {
            let mut settings = state.snapshot()?;
            settings.latex_enabled = true;
            state.save(settings)?;
        } else {
            return Err("The settings store is unavailable.".into());
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Remove `path`; a file that is already gone is the outcome that was wanted.
fn remove_if_present(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

fn safe_relative(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= 512
        && path
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"/._-".contains(&b))
        && path
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != "..")
}

fn cache_size(dir: &Path) -> Result<u64, String> {
    if !dir.exists() {
        return Ok(0);
    }
    let mut total = 0u64;
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let metadata = fs::symlink_metadata(entry.path()).map_err(|e| e.to_string())?;
        if metadata.file_type().is_symlink() {
            // A symlink in the cache is skipped and reported rather than aborting
            // the whole measurement: one odd entry must not make Preferences
            // unable to show a size, and it must never be followed.
            continue;
        }
        let size = if metadata.is_dir() {
            cache_size(&entry.path())?
        } else {
            metadata.len()
        };
        total = total
            .checked_add(size)
            .ok_or("LaTeX cache size overflow.")?;
    }
    Ok(total)
}

/// Delete the least-recently-used cache files until the total fits `limit`.
///
/// Runs *before* a download rather than after it: a cold compile that fills the
/// cache and then fails is worse than one that spends a moment making room. The
/// modification time is the recency signal, which is what the filesystem already
/// records and what a reader's own file manager would show.
fn evict_to_limit(dir: &Path, limit: u64) -> Result<u64, String> {
    if !dir.exists() {
        return Ok(0);
    }
    let mut files: Vec<(PathBuf, u64, std::time::SystemTime)> = Vec::new();
    collect_cache_files(dir, &mut files)?;
    let mut total: u64 = files.iter().map(|(_, size, _)| *size).sum();
    if total <= limit {
        return Ok(total);
    }
    files.sort_by_key(|(_, _, modified)| *modified);
    for (path, size, _) in files {
        if total <= limit {
            break;
        }
        if fs::remove_file(&path).is_ok() {
            total = total.saturating_sub(size);
        }
    }
    Ok(total)
}

fn collect_cache_files(
    dir: &Path,
    out: &mut Vec<(PathBuf, u64, std::time::SystemTime)>,
) -> Result<(), String> {
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let metadata = fs::symlink_metadata(entry.path()).map_err(|e| e.to_string())?;
        if metadata.file_type().is_symlink() {
            continue;
        }
        if metadata.is_dir() {
            collect_cache_files(&entry.path(), out)?;
        } else {
            let modified = metadata.modified().unwrap_or(std::time::UNIX_EPOCH);
            out.push((entry.path(), metadata.len(), modified));
        }
    }
    Ok(())
}

fn mirror_request(path: &str) -> Option<(Option<&str>, &str)> {
    if let Some(relative) = path.strip_prefix("/mirror/") {
        return Some((None, relative));
    }
    let rest = path.strip_prefix("/jobs/")?;
    let (job, relative) = rest.split_once("/mirror/")?;
    if job.is_empty() || job.len() > 20 || !job.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    Some((Some(job), relative))
}

pub fn serve(app: AppHandle, request: Request<Vec<u8>>, responder: UriSchemeResponder) {
    tauri::async_runtime::spawn_blocking(move || {
        let origin = request
            .headers()
            .get(header::ORIGIN)
            .and_then(|v| v.to_str().ok())
            .filter(|value| {
                [
                    "tauri://localhost",
                    "http://tauri.localhost",
                    "https://tauri.localhost",
                ]
                .contains(value)
            })
            .map(str::to_owned);
        let result = (|| -> Result<(Vec<u8>, &str), String> {
            if request.method() != tauri::http::Method::GET {
                return Err("GET required".into());
            }
            let root = directory(&app)?;
            if !enabled() {
                return Err("LuaLaTeX is not enabled.".into());
            }
            let path = request.uri().path();
            if let Some(name) = path.strip_prefix(ASSET_PREFIX) {
                let Some((_, expected)) = ASSETS.iter().find(|(allowed, _)| *allowed == name)
                else {
                    return Err("Unknown asset".into());
                };
                ASSET_REQUESTS.fetch_add(1, Ordering::Relaxed);
                let bytes = fs::read(root.join("assets").join(name)).map_err(|e| e.to_string())?;
                if digest(&bytes) != *expected {
                    return Err(
                        "Engine asset failed SHA-256 verification; reinstall bundled TeX (turn it off and on in Preferences › LaTeX).".into(),
                    );
                }
                let kind = if name.ends_with(".js") {
                    "text/javascript"
                } else if name.ends_with(".wasm") {
                    "application/wasm"
                } else {
                    "application/octet-stream"
                };
                return Ok((bytes, kind));
            }
            if let Some((job, relative)) = mirror_request(path) {
                if !safe_relative(relative) {
                    return Err("Invalid package path".into());
                }
                let cache = cache_path(&root, relative);
                // The hit path holds the lock only for the read. The miss path
                // releases it around the download, because holding a global lock
                // across a network request serialises every package a compile
                // asks for and makes a slow mirror look like a hang.
                {
                    let _guard = CACHE_LOCK
                        .lock()
                        .map_err(|_| "The LaTeX cache is unavailable.")?;
                    if fs::metadata(&cache).is_ok_and(|meta| meta.len() <= MAX_FILE as u64)
                        && let Ok(bytes) = fs::read(&cache)
                    {
                        CACHE_HITS.fetch_add(1, Ordering::Relaxed);
                        return Ok((bytes, "application/octet-stream"));
                    }
                }
                CACHE_MISSES.fetch_add(1, Ordering::Relaxed);
                if let Some(job) = job {
                    let _ = app.emit("latex-package-download", (job, true));
                }
                let result = download(&format!("{MIRROR}{relative}"));
                if let Some(job) = job {
                    let _ = app.emit("latex-package-download", (job, false));
                }
                let bytes = result?;
                if bytes.len() > MAX_FILE {
                    return Err("A package is larger than the 32 MiB limit.".into());
                }
                let _guard = CACHE_LOCK
                    .lock()
                    .map_err(|_| "The LaTeX cache is unavailable.")?;
                // Make room *before* writing, so a full cache does not turn a
                // cold compile into an opaque failure.
                let limit = cache_limit_bytes();
                let mirror = root.join("mirror");
                evict_to_limit(&mirror, limit.saturating_sub(bytes.len() as u64))?;
                write_atomic(&cache, &bytes)?;
                return Ok((bytes, "application/octet-stream"));
            }
            Err("Unknown resource".into())
        })();
        let (status, body, content_type) = match result {
            Ok((body, kind)) => (200, body, kind),
            Err(error) => (404, error.into_bytes(), "text/plain; charset=utf-8"),
        };
        let mut response = Response::builder()
            .status(status)
            .header(header::CONTENT_TYPE, content_type)
            .header(header::CACHE_CONTROL, "no-store")
            .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff");
        if let Some(origin) = origin {
            response = response.header(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin);
        }
        responder.respond(
            response
                .body(body)
                .unwrap_or_else(|_| Response::new(Vec::new())),
        );
    });
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Overlay {
    path: String,
    text: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFile {
    path: String,
    data: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSnapshot {
    main_file: String,
    files: Vec<ProjectFile>,
    /// Paths skipped because they are symlinks.
    ///
    /// Reported instead of aborting the project: one odd entry must not make a
    /// document uncompilable, and the reader is told which file was left out so a
    /// later "File not found" is not a mystery.
    skipped: Vec<String>,
    /// A generation key over the main file and the referenced set.
    ///
    /// Keying on the *set* rather than a revision counter means an edit that does
    /// not change which files are read (a typo fix) does not invalidate a finished
    /// PDF, while adding an `\input` does. It also covers the library revision.
    generation: String,
    /// Registered local libraries, captured separately from the project so a
    /// library file never becomes a chapter, a source-map candidate or a
    /// project member. `None` when no library is enabled.
    #[serde(skip_serializing_if = "Option::is_none")]
    texmf: Option<crate::latex_texmf::TexmfSnapshot>,
}

/// The character index of `needle` at or after `from`.
fn find_from(text: &[char], needle: &str, from: usize) -> Option<usize> {
    let needle: Vec<char> = needle.chars().collect();
    if needle.is_empty() || text.len() < needle.len() {
        return None;
    }
    (from..=text.len() - needle.len()).find(|&start| {
        text[start..start + needle.len()]
            .iter()
            .zip(&needle)
            .all(|(a, b)| a == b)
    })
}

/// Every `\name` occurrence, as `(start, end)` character indices.
fn matches_command(text: &[char], name: &str) -> Vec<(usize, usize)> {
    let mut out = Vec::new();
    let needle = format!("\\{name}");
    let mut from = 0;
    while let Some(at) = find_from(text, &needle, from) {
        // The name must end there: `\verbatim` is not `\verb`.
        let after = at + needle.len();
        if text
            .get(after)
            .is_some_and(|ch| ch.is_ascii_alphabetic() || *ch == '@')
        {
            from = after;
            continue;
        }
        out.push((at, after));
        from = after;
    }
    out
}

/// Blank a character range, keeping newlines so offsets survive.
fn blank(out: &mut [char], from: usize, to: usize) {
    let end = to.min(out.len());
    for ch in out.iter_mut().take(end).skip(from) {
        if *ch != '\n' {
            *ch = ' ';
        }
    }
}

/// The index just past a balanced `{…}` group starting at `at`, if there is one.
fn brace_end(out: &[char], at: usize) -> Option<usize> {
    if out.get(at) != Some(&'{') {
        return None;
    }
    let mut depth = 0usize;
    let mut end = at;
    while end < out.len() {
        match out[end] {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(end + 1);
                }
            }
            _ => {}
        }
        end += 1;
    }
    None
}

/// Mask the regions that are literal text, preserving offsets.
///
/// The Rust twin of `maskLiteralRegions` in `src/latex-references.ts`. A document
/// that *shows* `\input{…}` inside `\verb` or a `verbatim` block is not reading
/// that file, and the shipped LaTeX Reference does exactly that.
///
/// Hand-written rather than regex-driven on purpose: this crate has no `regex`
/// dependency, and adding one for a masking pass would cost build time on every
/// platform for a scanner that only needs a few delimiter and keyword pairs.
fn mask_literal_regions(text: &str) -> String {
    let mut out: Vec<char> = text.chars().collect();

    // `\verb` / `\verb*`: the next non-letter character is the delimiter, and the
    // literal runs to the next occurrence of it on the same line.
    for (start, _) in matches_command(&out, "verb") {
        let mut at = start + "\\verb".len();
        if out.get(at) == Some(&'*') {
            at += 1;
        }
        let Some(&delimiter) = out.get(at) else {
            continue;
        };
        if delimiter.is_ascii_alphabetic() || delimiter == ' ' {
            continue;
        }
        at += 1;
        let mut end = at;
        while end < out.len() && out[end] != delimiter && out[end] != '\n' {
            end += 1;
        }
        blank(&mut out, start, end + 1);
    }

    // The literal environments, bodies included.
    for name in [
        "verbatim",
        "verbatim*",
        "Verbatim",
        "Verbatim*",
        "lstlisting",
        "minted",
        "alltt",
        // The `comment` package's environment is not read by the compiler, and
        // `filecontents` writes a file rather than typesetting its body. Both
        // were scanned as live markup, so a reference inside them was collected
        // (or reported) even though TeX never executes it.
        "comment",
        "filecontents",
        "filecontents*",
    ] {
        let open = format!("\\begin{{{name}}}");
        let close = format!("\\end{{{name}}}");
        let mut from = 0;
        while let Some(found) = find_from(&out, &open, from) {
            let end = find_from(&out, &close, found + open.len())
                .map(|at| at + close.len())
                .unwrap_or(out.len());
            blank(&mut out, found, end);
            from = end;
        }
    }

    // `\iffalse … \fi` never runs.
    let mut from = 0;
    while let Some(found) = find_from(&out, "\\iffalse", from) {
        let end = find_from(&out, "\\fi", found + 8)
            .map(|at| at + 3)
            .unwrap_or(out.len());
        blank(&mut out, found, end);
        from = end;
    }

    // `\lstinline` and `\mintinline`, in their delimiter and brace forms.
    for command in ["lstinline", "mintinline"] {
        for (start, _) in matches_command(&out, command) {
            let mut at = start + command.len() + 1;
            while at < out.len() && out[at].is_whitespace() {
                at += 1;
            }
            if out.get(at) == Some(&'[') {
                while at < out.len() && out[at] != ']' {
                    at += 1;
                }
                at += 1;
                while at < out.len() && out[at].is_whitespace() {
                    at += 1;
                }
            }
            // `\mintinline{lang}` takes a language group before the delimiter.
            if let Some(end) = brace_end(&out, at) {
                at = end;
                while at < out.len() && out[at].is_whitespace() {
                    at += 1;
                }
            }
            let Some(&delimiter) = out.get(at) else {
                continue;
            };
            if delimiter.is_ascii_alphanumeric() || delimiter == ' ' || delimiter == '\\' {
                continue;
            }
            at += 1;
            let mut end = at;
            while end < out.len() && out[end] != delimiter {
                end += 1;
            }
            blank(&mut out, start, end + 1);
        }
    }

    // A command whose argument is text, not a path: `\texttt{\input}` names the
    // command instead of calling it.
    for command in [
        "texttt", "textbf", "textit", "textrm", "textsf", "textsc", "textsl", "textup", "textmd",
        "emph", "mbox", "hbox", "text",
    ] {
        for (start, _) in matches_command(&out, command) {
            let mut at = start + command.len() + 1;
            while at < out.len() && out[at].is_whitespace() {
                at += 1;
            }
            if let Some(end) = brace_end(&out, at) {
                blank(&mut out, start, end);
            }
        }
    }

    out.into_iter().collect()
}

/// The first `{…}` argument in `text`, after any optional `[…]`.
fn first_brace_argument(text: &str) -> Option<String> {
    let chars: Vec<char> = text.chars().collect();
    let mut at = 0;
    while at < chars.len() && chars[at].is_whitespace() {
        at += 1;
    }
    if chars.get(at) == Some(&'[') {
        while at < chars.len() && chars[at] != ']' {
            at += 1;
        }
        at += 1;
        while at < chars.len() && chars[at].is_whitespace() {
            at += 1;
        }
    }
    let end = brace_end(&chars, at)?;
    Some(chars[at + 1..end - 1].iter().collect())
}

/// The byte offset where a TeX comment starts on this line, or None.
///
/// A `%` starts a comment unless an **odd** number of backslashes precedes it:
/// `\%` is a literal percent, `\\%` is an escaped backslash followed by a
/// comment, `\\\%` is a literal percent again. The old single-character test
/// kept the whole line for `\\%`, so a commented reference after a line break
/// was still collected — and the TS validator, which had the same rule, still
/// reported it.
fn comment_start(line: &str) -> Option<usize> {
    for (at, ch) in line.char_indices() {
        if ch != '%' {
            continue;
        }
        let slashes = line[..at].chars().rev().take_while(|c| *c == '\\').count();
        if slashes % 2 == 0 {
            return Some(at);
        }
    }
    None
}

/// The literal references one source declares, as `(kind, name)`.
fn declared_references(text: &str) -> Vec<(String, String)> {
    let masked = mask_literal_regions(text);
    let mut out = Vec::new();
    for line in masked.split('\n') {
        let code = &line[..comment_start(line).unwrap_or(line.len())];
        let chars: Vec<char> = code.chars().collect();
        // A class or package loads its own dependencies with the LaTeX2e
        // kernel forms; without them a project-local class that needs a
        // project-local package compiled with that package missing.
        for (command, kind) in [
            ("input", "input"),
            ("include", "include"),
            ("includegraphics", "includegraphics"),
            ("bibliography", "bibliography"),
            ("addbibresource", "addbibresource"),
            ("documentclass", "documentclass"),
            ("LoadClass", "documentclass"),
            ("LoadClassWithOptions", "documentclass"),
            ("usepackage", "usepackage"),
            ("RequirePackage", "usepackage"),
            ("RequirePackageWithOptions", "usepackage"),
            ("bibliographystyle", "bibliographystyle"),
        ] {
            for (_, after) in matches_command(&chars, command) {
                let rest: String = chars[after..].iter().collect();
                let Some(argument) = first_brace_argument(&rest) else {
                    continue;
                };
                let names: Vec<String> = if kind == "bibliography" || kind == "usepackage" {
                    argument.split(',').map(str::to_string).collect()
                } else {
                    vec![argument]
                };
                for raw in names {
                    let name = raw.trim().trim_start_matches("./").to_string();
                    if !name.is_empty() {
                        out.push((kind.to_string(), name));
                    }
                }
            }
        }
        // Custom classes accept assets through commands such as
        // `\qrcode{qrcode.png}` and constants such as `{ logo_unb_vert }`.
        // They are still literal names. Reuse the confined graphics resolver
        // for file-like arguments instead of copying unrelated sibling files.
        let mut starts = Vec::new();
        for (index, ch) in chars.iter().enumerate() {
            if *ch == '{' {
                starts.push(index);
            } else if *ch == '}'
                && let Some(start) = starts.pop()
            {
                let argument: String = chars[start + 1..index].iter().collect();
                let name = argument.trim().trim_start_matches("./");
                let lower = name.to_ascii_lowercase();
                let image_suffix = [".pdf", ".png", ".jpg", ".jpeg"]
                    .iter()
                    .any(|suffix| lower.ends_with(suffix));
                let bare_file_name = name.contains('_')
                    && !name.contains('.')
                    && !name.chars().any(char::is_whitespace);
                if (image_suffix || bare_file_name)
                    && literal_reference(name)
                    && !out
                        .iter()
                        .any(|(kind, existing)| kind == "includegraphics" && existing == name)
                {
                    out.push(("includegraphics".to_string(), name.to_string()));
                }
            }
        }
    }
    out
}

/// Literal graphics directories in the main preamble, relative to the project.
fn graphics_paths(text: &str) -> Vec<String> {
    let masked = mask_literal_regions(text);
    let code = masked
        .lines()
        .map(|line| &line[..comment_start(line).unwrap_or(line.len())])
        .collect::<Vec<_>>()
        .join("\n");
    let mut chars: Vec<char> = code.chars().collect();
    for (start, after) in matches_command(&chars, "begin") {
        let rest: String = chars[after..].iter().collect();
        if first_brace_argument(&rest).as_deref() == Some("document") {
            chars.truncate(start);
            break;
        }
    }
    let mut paths = Vec::new();
    for (_, after) in matches_command(&chars, "graphicspath") {
        let rest: String = chars[after..].iter().collect();
        let Some(argument) = first_brace_argument(&rest) else {
            continue;
        };
        let inner: Vec<char> = argument.chars().collect();
        let mut at = 0;
        let mut candidate = Vec::new();
        while at < inner.len() {
            while at < inner.len() && inner[at].is_whitespace() {
                at += 1;
            }
            if at == inner.len() {
                break;
            }
            let Some(end) = brace_end(&inner, at) else {
                candidate.clear();
                break;
            };
            let item: String = inner[at + 1..end - 1].iter().collect();
            if item.contains(['{', '}']) {
                candidate.clear();
                break;
            }
            let path = item.trim();
            let path = path.strip_suffix('/').unwrap_or(path);
            let path = path.strip_prefix("./").unwrap_or(path);
            if literal_reference(path) {
                candidate.push(path.to_string());
            }
            at = end;
        }
        paths = candidate;
    }
    paths
}

/// The extensions a reference with no suffix may resolve to.
fn candidate_suffixes(kind: &str) -> &'static [&'static str] {
    match kind {
        "includegraphics" => &[".pdf", ".png", ".jpg", ".jpeg"],
        "bibliography" | "addbibresource" => &[".bib"],
        "documentclass" => &[".cls"],
        "usepackage" => &[".sty"],
        "bibliographystyle" => &[".bst"],
        _ => &[".tex"],
    }
}

/// Whether a reference names a literal path the snapshot may read.
fn literal_reference(name: &str) -> bool {
    !name.is_empty()
        && !name.contains(['\\', '{', '}', '#', '$', '~', ':'])
        && !name.starts_with('/')
        && !name
            .split('/')
            .any(|part| part.is_empty() || part == ".." || part == ".")
}

/// A project-relative path with forward slashes, for the IPC payload.
fn relative_to(root: &Path, path: &Path) -> Result<String, String> {
    let relative = path.strip_prefix(root).map_err(|e| e.to_string())?;
    let text = relative
        .to_str()
        .ok_or("Project paths must be valid Unicode.")?;
    Ok(text.replace('\\', "/"))
}

/// Collect the files a document actually reads, following its references.
///
/// Replaces the directory walk. The old collector copied every supported file
/// under the root — including drafts the document never mentions — and aborted
/// the whole project on the first symlink anywhere below it. This one starts at
/// the main file and follows what it declares, so a project with a large
/// `figures/` folder of unused images sends only the ones it uses.
///
/// A symlink is **skipped and reported**, never followed: following one can leave
/// the project root, which is the confinement the snapshot exists to enforce.
/// The files a project reads, the symlinks skipped, and the generation key.
///
/// A named alias rather than a bare tuple: the return type is three collections
/// deep, and a reader (and Clippy) should not have to decode it at every call.
type CollectedProject = (Vec<(PathBuf, Vec<u8>)>, Vec<String>, String);

fn collect_referenced(
    root: &Path,
    main: &Path,
    overlays: &[Overlay],
) -> Result<CollectedProject, String> {
    // Every candidate is canonicalized before it is compared with `root`, so the
    // root must be canonical too — otherwise a caller passing a path with a
    // symlinked or non-normalised prefix would silently collect nothing. The
    // command canonicalizes already; doing it here makes the invariant the
    // function's own rather than the caller's.
    let root = &fs::canonicalize(root).map_err(|e| e.to_string())?;
    let main = &fs::canonicalize(main).map_err(|e| e.to_string())?;
    let mut files: Vec<(PathBuf, Vec<u8>)> = Vec::new();
    let mut skipped: Vec<String> = Vec::new();
    let mut seen: std::collections::BTreeSet<PathBuf> = std::collections::BTreeSet::new();
    let mut pending: Vec<PathBuf> = vec![main.to_path_buf()];
    let mut total = 0usize;
    let mut graphics = Vec::new();

    while let Some(path) = pending.pop() {
        if !seen.insert(path.clone()) {
            continue;
        }
        if files.len() >= MAX_FILES {
            return Err("The LaTeX project exceeds its file count limit.".into());
        }

        // An open buffer wins over the bytes on disk, so an unsaved edit compiles.
        let overlay = overlays.iter().find(|entry| {
            fs::canonicalize(&entry.path)
                .map(|full| full == path)
                .unwrap_or(false)
        });
        let bytes = match overlay {
            Some(entry) => {
                if entry.text.len() > MAX_FILE {
                    return Err("An open LaTeX project file exceeds 32 MiB.".into());
                }
                entry.text.clone().into_bytes()
            }
            None => {
                let meta = fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
                if meta.file_type().is_symlink() {
                    skipped.push(
                        relative_to(root, &path).unwrap_or_else(|_| path.display().to_string()),
                    );
                    continue;
                }
                if meta.len() > MAX_FILE as u64 {
                    return Err("A LaTeX project file exceeds 32 MiB.".into());
                }
                fs::read(&path).map_err(|e| e.to_string())?
            }
        };

        total = total
            .checked_add(bytes.len())
            .ok_or("Project size overflow")?;
        if total > MAX_PROJECT {
            return Err("The LaTeX project exceeds 64 MiB.".into());
        }

        // Only a text source declares further references; an image does not.
        if path.extension().is_some_and(|e| {
            matches!(
                e.to_ascii_lowercase().to_str(),
                Some("tex" | "bib" | "sty" | "cls" | "bst")
            )
        }) {
            let text = String::from_utf8_lossy(&bytes).into_owned();
            if path == *main {
                graphics = graphics_paths(&text);
            }
            for (kind, name) in declared_references(&text) {
                // A non-literal reference is reported by the frontend validator
                // with a named message before a compile is attempted; skipping it
                // here keeps the snapshot from failing twice for one cause.
                if !literal_reference(&name) {
                    continue;
                }
                // TeX resolves `\input` and `\includegraphics` against the main
                // file's directory, not against the including file's. Resolving
                // from `path.parent()` made a chapter in `chapters/` look for
                // `chapters/figures/plot.png` while LuaLaTeX read
                // `figures/plot.png`; the snapshot then omitted the image and the
                // validator reported a file that exists.
                let has_extension = name
                    .rsplit('/')
                    .next()
                    .is_some_and(|part| part.contains('.'));
                let suffixes: &[&str] = if has_extension {
                    &[""]
                } else {
                    candidate_suffixes(&kind)
                };
                let mut prefixes = vec![String::new()];
                if kind == "includegraphics" {
                    prefixes.extend(graphics.iter().map(|path| format!("{path}/")));
                }
                'candidates: for prefix in prefixes {
                    for suffix in suffixes {
                        let candidate = root.join(format!("{prefix}{name}{suffix}"));
                        // Check each component before canonicalizing: otherwise
                        // the link itself disappears and cannot be reported.
                        let relative = candidate.strip_prefix(root).map_err(|e| e.to_string())?;
                        let mut component_path = root.to_path_buf();
                        let mut link = false;
                        for component in relative.components() {
                            component_path.push(component);
                            if fs::symlink_metadata(&component_path)
                                .is_ok_and(|meta| meta.file_type().is_symlink())
                            {
                                skipped.push(relative_to(root, &component_path)?);
                                link = true;
                                break;
                            }
                        }
                        if link {
                            continue;
                        }
                        let Ok(full) = fs::canonicalize(&candidate) else {
                            continue;
                        };
                        // Refuse references that resolve outside the project.
                        if !full.starts_with(root) || !full.is_file() {
                            continue;
                        }
                        pending.push(full);
                        break 'candidates;
                    }
                }
            }
        }

        files.push((path, bytes));
    }

    // The generation key covers the main file and the referenced set.
    let mut key = String::new();
    for (path, bytes) in &files {
        key.push_str(&relative_to(root, path).unwrap_or_default());
        key.push('\u{0}');
        key.push_str(&digest(bytes));
        key.push('\n');
    }
    skipped.sort();
    Ok((files, skipped, digest(key.as_bytes())))
}

/// Capture the project directory and overlay the current open text buffers.
#[tauri::command]
pub async fn latex_project_snapshot(
    app: AppHandle,
    path: String,
    overlays: Vec<Overlay>,
    include_libraries: Option<bool>,
) -> Result<ProjectSnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let requested = Path::new(&path);
        let metadata = fs::symlink_metadata(requested)
            .map_err(|e| format!("Cannot read the main LaTeX file: {e}"))?;
        if metadata.file_type().is_symlink() {
            return Err("A symbolic link cannot be the main LaTeX file.".into());
        }
        let parent = requested
            .parent()
            .ok_or("The project has no parent directory.")?;
        let root = fs::canonicalize(parent).map_err(|e| e.to_string())?;
        let main = fs::canonicalize(requested)
            .map_err(|e| format!("Cannot read the main LaTeX file: {e}"))?;
        if main.parent() != Some(root.as_path()) {
            return Err("The main file resolves outside the selected project directory.".into());
        }
        if !main.is_file()
            || !main
                .extension()
                .is_some_and(|e| e.eq_ignore_ascii_case("tex"))
        {
            return Err("Choose a saved .tex file as the LaTeX project root.".into());
        }
        let mut files = Vec::new();
        let mut skipped = Vec::new();
        let mut generation = String::new();
        let (collected, skipped_paths, key) = collect_referenced(&root, &main, &overlays)?;
        files.extend(collected);
        skipped.extend(skipped_paths);
        generation.push_str(&key);
        let main_file = relative_to(&root, &main)?;
        let files = files
            .into_iter()
            .map(|(path, data)| {
                Ok(ProjectFile {
                    path: relative_to(&root, &path)?,
                    data: STANDARD.encode(data),
                })
            })
            .collect::<Result<_, String>>()?;
        let texmf = if include_libraries.unwrap_or(true) {
            crate::latex_texmf::capture(&app)?
        } else {
            None
        };
        if let Some(texmf) = &texmf {
            generation.push_str("
texmf:");
            generation.push_str(&texmf.revision);
        }
        Ok(ProjectSnapshot {
            main_file,
            files,
            skipped,
            generation,
            texmf,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Write the PDF a document's own compiler produced.
///
/// Language-neutral on purpose: it serves Typst's Pages view and a LaTeX
/// project alike, because both hand over the bytes their engine emitted rather
/// than a re-rendered article. The name says what it does, not which engine made
/// the bytes.
#[tauri::command]
pub async fn save_compiled_pdf(output_path: String, data: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        if data.len() > MAX_PROJECT * 2 {
            return Err("The PDF is too large to export.".into());
        }
        let bytes = STANDARD.decode(data).map_err(|_| "Invalid PDF data.")?;
        if bytes.len() > MAX_PROJECT || !bytes.starts_with(b"%PDF-") {
            return Err("The compiler did not produce a valid PDF.".into());
        }
        let target = PathBuf::from(output_path);
        if !target
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("pdf"))
        {
            return Err("Choose a .pdf output file.".into());
        }
        crate::print::write_pdf_atomically(&target, |pending| {
            fs::write(pending, &bytes).map_err(|error| error.to_string())
        })?;
        Ok(())
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Write the PDF a document's own compiler produced, then open it to be printed.
///
/// The PDF sibling of `export::print_document`, and the reason it exists is the
/// same: WebView2 exposes no print UI, so `window.print()` inside the application
/// fires no dialog. The system's PDF viewer owns the print dialog, so the bytes go
/// to a temporary file and the viewer is asked to open it.
///
/// This prints **the compiled PDF**, never a re-render — see
/// `docs/adr/2026-11-06-print-the-compiled-pdf.md`. A second layout of the same
/// document would contradict the preview sitting beside it.
#[tauri::command]
pub async fn print_compiled_pdf<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    data: String,
    name: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if data.len() > MAX_PROJECT * 2 {
            return Err("The PDF is too large to print.".into());
        }
        let bytes = STANDARD.decode(data).map_err(|_| "Invalid PDF data.")?;
        if bytes.len() > MAX_PROJECT || !bytes.starts_with(b"%PDF-") {
            return Err("The compiler did not produce a valid PDF.".into());
        }

        // A folder per handoff: printing again must not rename over a PDF the
        // viewer may still hold open.
        // The same stem rule the print document uses, so a name with a separator
        // cannot escape the directory.
        let file_name = format!("{}.pdf", crate::export::safe_stem(&name));
        let target = crate::print::write_handoff(&file_name, |target| {
            crate::print::write_pdf_atomically(target, |pending| {
                fs::write(pending, &bytes).map_err(|error| error.to_string())
            })
            .map(|_| ())
        })?;

        tauri_plugin_opener::open_path(&target, None::<&str>).map_err(|error| {
            format!(
                "Wrote {} but could not open it: {error}\n\
                 Open that file yourself and print it.",
                target.display()
            )
        })?;

        let _ = app;
        Ok(target.to_string_lossy().into_owned())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::{
        MAX_PROJECT, cache_size, collect_referenced, declared_references, evict_to_limit,
        mask_literal_regions, remove_if_present, safe_relative,
    };

    #[test]
    fn removing_an_asset_another_install_removed_is_not_an_error() {
        let path = std::env::temp_dir().join(format!(
            "mdraft-remove-if-present-{}",
            std::process::id()
        ));
        std::fs::write(&path, b"old").unwrap();
        remove_if_present(&path).unwrap();
        assert!(!path.exists());
        remove_if_present(&path).expect("an already removed asset is the wanted state");
    }
    use std::{fs, path::Path};

    #[test]
    fn migration_preserves_data_and_refuses_collisions() {
        let root = scratch("latex-migration");
        let old = root.join("former-engine");
        fs::create_dir_all(old.join("assets")).unwrap();
        fs::create_dir_all(old.join("mirror")).unwrap();
        fs::write(old.join("assets/identity"), b"verified").unwrap();
        fs::write(old.join("mirror/package"), b"cached").unwrap();
        let verify =
            |assets: &Path| fs::read(assets.join("identity")).is_ok_and(|v| v == b"verified");
        let target = super::migrate_directory_matching(&root, &verify).unwrap();
        assert_eq!(fs::read(target.join("mirror/package")).unwrap(), b"cached");
        assert!(!old.exists());
        assert_eq!(
            super::migrate_directory_matching(&root, &verify).unwrap(),
            target
        );
        fs::create_dir_all(old.join("assets")).unwrap();
        fs::write(old.join("assets/identity"), b"verified").unwrap();
        assert!(super::migrate_directory_matching(&root, &verify).is_err());
        assert!(old.exists() && target.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn migration_preserves_incomplete_and_unrelated_directories() {
        let root = scratch("latex-migration-incomplete");
        let unrelated = root.join("other-tool").join("assets");
        fs::create_dir_all(&unrelated).unwrap();
        fs::write(unrelated.join("identity"), b"unrelated").unwrap();
        assert!(super::legacy_candidates(&root).unwrap().is_empty());
        let incomplete = root.join("former-engine").join("assets");
        fs::create_dir_all(&incomplete).unwrap();
        fs::write(incomplete.join(super::ASSETS[0].0), b"damaged").unwrap();
        assert!(super::migrate_directory(&root).is_err());
        assert!(incomplete.exists() && unrelated.exists());
        assert!(!root.join("latex").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn year_is_one_pinned_unit() {
        // The year is read from the scheme prefix and every other constant must
        // agree with it. `scripts/latex-sdk-unit.mjs` covers the TypeScript side
        // and the worker shims.
        let year = super::ASSET_PREFIX
            .trim_matches('/')
            .rsplit('/')
            .next()
            .unwrap();
        assert_eq!(super::ASSET_PREFIX, format!("/wasmtex/{year}/"));
        assert_eq!(
            super::ASSET_ROOT,
            format!("https://corca-ai.github.io/wasmtex/wasmtex/{year}/")
        );
        assert!(super::MIRROR_REVISION.starts_with(&format!("{year}-")));
        assert_eq!(
            super::MIRROR,
            format!(
                "https://texlive.corca.ai/snapshots/{}/{year}/",
                super::MIRROR_REVISION
            )
        );
        assert!(super::ENGINE_RELEASE.starts_with(&format!("{year}-")));
    }

    #[test]
    fn pinned_digests_are_well_formed_and_the_previous_release_differs() {
        for set in [super::ASSETS, super::ASSETS_2025] {
            for (name, digest) in set {
                assert!(safe_relative(name), "{name}");
                assert!(
                    digest.len() == 64
                        && digest
                            .bytes()
                            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)),
                    "{name} digest is not 64 lowercase hex digits"
                );
            }
        }
        assert_eq!(super::ASSETS.len(), super::ASSETS_2025.len());
        for (new, old) in super::ASSETS.iter().zip(super::ASSETS_2025) {
            assert_eq!(new.0, old.0, "the same files in the same order");
        }
        let changed = super::ASSETS
            .iter()
            .zip(super::ASSETS_2025)
            .filter(|(new, old)| new.1 != old.1)
            .count();
        assert_eq!(
            changed, 4,
            "TeX Live 2026 changed the engine, wasm, format and BibTeX wasm"
        );
    }

    #[test]
    fn engine_installed_needs_the_release_marker_and_every_file() {
        let root = scratch("latex-engine-installed");
        let assets = root.join("assets");
        fs::create_dir_all(&assets).unwrap();
        assert!(!super::engine_installed(&assets), "an empty directory");
        for (name, _) in super::ASSETS {
            fs::write(assets.join(name), b"x").unwrap();
        }
        assert!(
            !super::engine_installed(&assets),
            "files with no marker are an earlier release"
        );
        fs::write(
            assets.join(super::RELEASE_MARKER),
            "2025-3a6c0df0b2b95005",
        )
        .unwrap();
        assert!(
            !super::engine_installed(&assets),
            "another release's marker"
        );
        fs::write(
            assets.join(super::RELEASE_MARKER),
            format!("{}\n", super::ENGINE_RELEASE),
        )
        .unwrap();
        assert!(super::engine_installed(&assets));
        fs::remove_file(assets.join(super::ASSETS[3].0)).unwrap();
        assert!(!super::engine_installed(&assets), "a missing file");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn assets_match_compares_bytes_and_ignores_names_it_was_not_asked_about() {
        let root = scratch("latex-assets-match");
        let one = super::digest(b"one");
        let two = super::digest(b"two");
        let set = [("a", one.as_str()), ("b", two.as_str())];
        assert!(!super::assets_match(&root, &set), "files are missing");
        fs::write(root.join("a"), b"one").unwrap();
        fs::write(root.join("b"), b"two").unwrap();
        fs::write(root.join("extra"), b"other").unwrap();
        assert!(super::assets_match(&root, &set));
        fs::write(root.join("b"), b"changed").unwrap();
        assert!(!super::assets_match(&root, &set), "one file differs");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn cache_is_namespaced_by_mirror_revision() {
        let root = Path::new("root");
        let path = super::cache_path(root, "pdftex/26/article.cls");
        assert_eq!(
            path,
            root.join("mirror")
                .join(super::MIRROR_REVISION)
                .join("pdftex/26/article.cls")
        );
        assert_ne!(
            path,
            root.join("mirror").join("pdftex/26/article.cls"),
            "an entry from before the namespace is a different file"
        );
    }

    #[test]
    fn mirror_paths_cannot_escape_or_change_host() {
        assert_eq!(
            super::mirror_request("/jobs/12/mirror/a.sty"),
            Some((Some("12"), "a.sty"))
        );
        assert_eq!(
            super::mirror_request("/mirror/a.sty"),
            Some((None, "a.sty"))
        );
        assert_eq!(super::mirror_request("/jobs/bad/mirror/a.sty"), None);
        assert_eq!(super::mirror_request("/jobs/1/other/a.sty"), None);
        for good in ["tex/latex/base/article.cls", "fonts/a-b.1"] {
            assert!(safe_relative(good));
        }
        for bad in [
            "",
            "../a",
            "tex/../../etc",
            "/absolute",
            "a//b",
            "https://example.com",
            "x%2f..",
            "x?y",
        ] {
            assert!(!safe_relative(bad));
        }
    }

    /// The print command must refuse anything that is not a PDF.
    ///
    /// The validation is the same one `save_compiled_pdf` applies, and it matters
    /// more here: the file is written to a temporary directory and handed to the
    /// system viewer, so accepting arbitrary bytes would open whatever they are.
    #[test]
    fn a_print_payload_must_be_a_pdf() {
        // The guard is inline in the command, which needs an `AppHandle`; the
        // predicate it applies is what is worth pinning.
        let accepts = |bytes: &[u8]| bytes.starts_with(b"%PDF-") && bytes.len() <= MAX_PROJECT;
        assert!(accepts(b"%PDF-1.7\n..."));
        assert!(!accepts(b"<html>not a pdf</html>"));
        assert!(!accepts(b""));
        // A payload over the ceiling is refused rather than written.
        let huge = vec![b'x'; MAX_PROJECT + 1];
        assert!(!accepts(&huge));
    }

    #[test]
    fn project_snapshot_collects_local_classes_and_styles() {
        let root = scratch("latex-local-classes");
        fs::write(
            root.join("main.tex"),
            "\\documentclass{myclass}\\usepackage{mystyle}\\begin{document}x\\end{document}\\n",
        )
        .unwrap();
        fs::write(root.join("myclass.cls"), "% local class\n").unwrap();
        fs::write(root.join("mystyle.sty"), "% local style\n").unwrap();
        let (files, skipped, _) =
            collect_referenced(&root, &root.join("main.tex"), &[]).unwrap();
        assert!(skipped.is_empty());
        assert!(files.iter().any(|(path, _)| path.ends_with("myclass.cls")));
        assert!(files.iter().any(|(path, _)| path.ends_with("mystyle.sty")));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn project_snapshot_follows_kernel_loads_inside_classes_and_packages() {
        let root = scratch("latex-kernel-loads");
        fs::write(
            root.join("main.tex"),
            "\\documentclass{outer}\\bibliographystyle{house}\\begin{document}x\\end{document}\n",
        )
        .unwrap();
        fs::write(
            root.join("outer.cls"),
            "\\LoadClassWithOptions{inner}\n\\RequirePackage{first,second}\n\\RequirePackageWithOptions{third}\n% \\RequirePackage{commented}\n",
        )
        .unwrap();
        fs::write(root.join("inner.cls"), "\\LoadClass{article}\n").unwrap();
        for name in ["first", "second", "third", "commented"] {
            fs::write(root.join(format!("{name}.sty")), "% package\n").unwrap();
        }
        fs::write(root.join("house.bst"), "ENTRY{}{}{}\n").unwrap();
        let (files, _, _) = collect_referenced(&root, &root.join("main.tex"), &[]).unwrap();
        let has = |name: &str| files.iter().any(|(path, _)| path.ends_with(name));
        for name in ["inner.cls", "first.sty", "second.sty", "third.sty", "house.bst"] {
            assert!(has(name), "{name} was not collected");
        }
        assert!(!has("commented.sty"), "a commented load is not a reference");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn project_snapshot_follows_references_and_preserves_binary_images() {
        let root = fs::canonicalize(
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../samples/latex-project"),
        )
        .unwrap();
        let main = root.join("main.tex");
        let (files, skipped, generation) = collect_referenced(&root, &main, &[]).unwrap();
        assert!(skipped.is_empty(), "the fixture has no symlinks");
        assert!(!generation.is_empty(), "a generation key is produced");

        // The included chapter and the bibliography are reached through the
        // document's own references, not by walking the directory.
        assert!(
            files
                .iter()
                .any(|(path, _)| path.ends_with("chapters/intro.tex")),
            "the included chapter is collected"
        );
        assert!(
            files
                .iter()
                .any(|(path, _)| path.ends_with("references.bib")),
            "the bibliography is collected"
        );
        // The image is binary and must survive byte-for-byte.
        let image = files
            .iter()
            .find(|(path, _)| path.ends_with("figures/diagram.png"))
            .expect("the referenced image is collected");
        assert!(image.1.starts_with(b"\x89PNG\r\n\x1a\n"));
    }

    #[test]
    fn a_reference_to_a_file_the_document_never_names_is_not_read() {
        // The whole point of following references: a sibling draft is not part of
        // the project just because it sits in the same folder.
        let root = scratch("unreferenced");
        fs::write(root.join("main.tex"), "\\input{used}").unwrap();
        fs::write(root.join("used.tex"), "included").unwrap();
        fs::write(root.join("draft.tex"), "never mentioned").unwrap();
        let (files, _, _) = collect_referenced(&root, &root.join("main.tex"), &[]).unwrap();
        let names: Vec<String> = files
            .iter()
            .map(|(path, _)| path.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        assert!(names.contains(&"main.tex".to_string()));
        assert!(names.contains(&"used.tex".to_string()));
        assert!(
            !names.contains(&"draft.tex".to_string()),
            "an unreferenced file is not collected: {names:?}"
        );
    }

    #[test]
    fn class_macro_graphics_are_collected_without_unrelated_images() {
        let root = scratch("macro-graphics");
        fs::write(root.join("main.tex"), "\\documentclass{assessment}\n\\qrcode{qrcode.png}\n% \\logo{ignored.png}\n\\texttt{example.png}").unwrap();
        fs::write(
            root.join("assessment.cls"),
            "\\tl_gset:Nn \\g_logo_tl { logo_unb_vert }\n\\includegraphics{\\g_logo_tl}",
        )
        .unwrap();
        fs::write(root.join("qrcode.png"), b"qr binary").unwrap();
        fs::write(root.join("logo_unb_vert.jpg"), b"logo binary").unwrap();
        for name in ["unused.png", "ignored.png", "example.png"] {
            fs::write(root.join(name), b"not referenced").unwrap();
        }
        let (files, skipped, _) = collect_referenced(&root, &root.join("main.tex"), &[]).unwrap();
        assert!(skipped.is_empty());
        assert_eq!(
            files
                .iter()
                .find(|(path, _)| path.ends_with("qrcode.png"))
                .unwrap()
                .1,
            b"qr binary"
        );
        assert_eq!(
            files
                .iter()
                .find(|(path, _)| path.ends_with("logo_unb_vert.jpg"))
                .unwrap()
                .1,
            b"logo binary"
        );
        assert_eq!(
            files.len(),
            4,
            "only the source, class and named images are read"
        );
        assert!(
            declared_references(
                "\\qrcode{../outside.png}\n\\qrcode{C:/private.png}\n\\qrcode{/private.png}"
            )
            .is_empty()
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_literal_region_is_not_a_reference() {
        // The shipped LaTeX Reference shows these commands as examples. Reading
        // them as references made the document uncompilable.
        let masked = mask_literal_regions("\\verb|\\input{chapters/intro}|");
        assert!(
            !masked.contains("\\input"),
            "the \\verb body is blanked: {masked:?}"
        );
        let masked = mask_literal_regions("\\begin{verbatim}\n\\input{x}\n\\end{verbatim}");
        assert!(!masked.contains("\\input"), "the verbatim body is blanked");
        let masked = mask_literal_regions("\\texttt{\\input} names the command");
        assert!(!masked.contains("\\input"), "a text argument is blanked");
        // A real reference survives.
        assert!(mask_literal_regions("\\input{real}").contains("\\input"));
    }

    #[test]
    fn a_chapter_resolves_references_against_the_project_root() {
        // TeX does not change the working directory for an included file, so a
        // chapter under `chapters/` that names `figures/plot.png` still means the
        // root's `figures/plot.png`. Resolving from the chapter's own directory
        // skipped the image, and the validator then called a real file missing.
        let root = scratch("nested-reference");
        fs::create_dir_all(root.join("chapters")).unwrap();
        fs::create_dir_all(root.join("figures")).unwrap();
        fs::write(root.join("main.tex"), "\\input{chapters/intro}").unwrap();
        fs::write(
            root.join("chapters/intro.tex"),
            "\\includegraphics{figures/plot.png}",
        )
        .unwrap();
        fs::write(root.join("figures/plot.png"), b"\x89PNG\r\n\x1a\n").unwrap();
        let (files, _, _) = collect_referenced(&root, &root.join("main.tex"), &[]).unwrap();
        assert!(
            files
                .iter()
                .any(|(path, _)| path.ends_with("figures/plot.png")),
            "the chapter's image is collected from the root: {:?}",
            files
                .iter()
                .map(|(path, _)| path.display().to_string())
                .collect::<Vec<_>>()
        );
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn snapshot_uses_literal_main_preamble_graphics_paths() {
        let root = scratch("graphics-path");
        fs::create_dir_all(root.join("figures")).unwrap();
        fs::create_dir_all(root.join("chapters")).unwrap();
        fs::write(
            root.join("main.tex"),
            "\\graphicspath{{missing/}{./figures/}}\n\\begin{document}\n\\input{chapters/intro}",
        )
        .unwrap();
        fs::write(root.join("chapters/intro.tex"), "\\includegraphics{plot}").unwrap();
        fs::write(root.join("figures/plot.png"), b"image").unwrap();
        let (files, _, _) = collect_referenced(&root, &root.join("main.tex"), &[]).unwrap();
        assert!(
            files
                .iter()
                .any(|(path, _)| path.ends_with("figures/plot.png"))
        );
        assert_eq!(
            super::graphics_paths(
                "% \\graphicspath{{ignored/}}\n\\graphicspath{{../unsafe/}{figures/}}\n\\begin{document}\\graphicspath{{late/}}"
            ),
            vec!["figures"]
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_commented_reference_is_not_collected() {
        // A line comment keeps the command out of the snapshot.
        assert!(declared_references("% \\input{gone}").is_empty());
        assert!(declared_references("text % \\input{gone}").is_empty());
        // `\\%` is a line break followed by a comment: the percent is not
        // escaped, and the command after it must not be read.
        assert!(declared_references("a\\\\% \\input{gone}").is_empty());
        // `\%` is a literal percent, so the reference beside it is live.
        assert_eq!(declared_references("50\\% \\input{real}").len(), 1);
        // The `comment` environment is not read by the compiler either.
        assert!(declared_references("\\begin{comment}\n\\input{gone}\n\\end{comment}").is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_is_skipped_and_reported_rather_than_aborting_the_project() {
        // The old collector failed the whole project on the first symlink. One
        // odd entry must not make a document uncompilable; it is reported so a
        // later "File not found" is explained.
        use std::os::unix::fs::symlink;
        let root = scratch("symlink");
        fs::write(root.join("main.tex"), "\\input{linked}").unwrap();
        symlink("/etc/hostname", root.join("linked.tex")).unwrap();
        let (files, skipped, _) = collect_referenced(&root, &root.join("main.tex"), &[]).unwrap();
        assert!(files.iter().any(|(path, _)| path.ends_with("main.tex")));
        assert_eq!(skipped.len(), 1, "the symlink is reported: {skipped:?}");
        assert!(skipped[0].contains("linked.tex"));
        fs::remove_dir_all(&root).unwrap();
    }

    /// A scratch directory the test process can actually write to.
    ///
    /// `std::env::temp_dir()` is refused on some Windows hosts (`Os { code: 5,
    /// kind: PermissionDenied }`), which is why the cache tests below use the
    /// target directory cargo already owns instead of the system temp folder.
    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("latex-tests")
            .join(format!("{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn the_cache_size_ignores_a_symlink_instead_of_failing() {
        // One odd entry must not stop Preferences from reporting a size, and it
        // must never be followed: a symlink can point outside the cache.
        let root = scratch("size");
        fs::create_dir_all(root.join("mirror")).unwrap();
        fs::write(root.join("mirror/a.sty"), b"12345").unwrap();
        assert_eq!(cache_size(&root.join("mirror")).unwrap(), 5);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn eviction_removes_the_least_recently_used_files_first() {
        let root = scratch("evict");
        // Three files of 100 bytes each; the oldest must go first.
        for (index, age) in [(0usize, 300u64), (1, 200), (2, 100)] {
            let path = root.join(format!("{index}.sty"));
            fs::write(&path, vec![b'x'; 100]).unwrap();
            let when = std::time::SystemTime::now() - std::time::Duration::from_secs(age);
            let file = fs::OpenOptions::new().write(true).open(&path).unwrap();
            file.set_modified(when).unwrap();
        }
        // Room for two files only.
        let remaining = evict_to_limit(&root, 200).unwrap();
        assert!(remaining <= 200, "remaining {remaining}");
        assert!(!root.join("0.sty").exists(), "the oldest file is evicted");
        assert!(root.join("2.sty").exists(), "the newest file survives");
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn eviction_is_a_no_op_under_the_limit() {
        let root = scratch("keep");
        fs::write(root.join("a.sty"), vec![b'x'; 100]).unwrap();
        assert_eq!(evict_to_limit(&root, 1024).unwrap(), 100);
        assert!(root.join("a.sty").exists());
        fs::remove_dir_all(&root).unwrap();
    }
}
