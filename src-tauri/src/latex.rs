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
    AppHandle, Manager, UriSchemeResponder,
    http::{Request, Response, header},
};

pub const SCHEME: &str = "mdraft-tex";
const ASSET_ROOT: &str = "https://corca-ai.github.io/wasmtex/wasmtex/2025/";
const MIRROR: &str = "https://texlive.corca.ai/snapshots/2025-0d3fc73b65e39905/2025/";
const MAX_FILE: usize = 32 * 1024 * 1024;
const MAX_PROJECT: usize = 64 * 1024 * 1024;
const MAX_FILES: usize = 256;
const MAX_DEPTH: usize = 12;
static TEMP_ID: AtomicU64 = AtomicU64::new(0);
static CACHE_LOCK: Mutex<()> = Mutex::new(());
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
    CACHE_LIMIT_MB.load(Ordering::Relaxed).saturating_mul(1024 * 1024)
}

// Digests from the pinned release-cleared manifest, SHA-256 928bd4b7…3d12b4a.
const ASSETS: &[(&str, &str)] = &[
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

fn directory(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|p| p.join("wasmtex-poc-2025"))
        .map_err(|e| format!("Cannot locate the LaTeX data directory: {e}"))
}

/// Whether the reader has enabled the engine.
///
/// Settings-backed, so a portable build and a settings backup carry the switch.
/// The asset files themselves are a separate question: `latex_status` is true
/// only when the switch is on *and* the verified assets are present, because a
/// switch that promises an engine it cannot run is the dead UI this project
/// refuses.
#[tauri::command]
pub fn latex_status(app: AppHandle) -> bool {
    if !enabled() {
        return false;
    }
    directory(&app).is_ok_and(|dir| dir.join("assets").is_dir())
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
        installed: root.join("assets").is_dir(),
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

fn write_atomic(path: &Path, data: &[u8]) -> Result<(), String> {
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

fn digest(data: &[u8]) -> String {
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
        let root = directory(&app)?;
        let assets = root.join("assets");
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
            if path.exists() {
                fs::remove_file(&path).map_err(|e| e.to_string())?;
            }
            write_atomic(&path, &bytes)?;
        }
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
            if let Some(name) = path.strip_prefix("/wasmtex/2025/") {
                let Some((_, expected)) = ASSETS.iter().find(|(allowed, _)| *allowed == name)
                else {
                    return Err("Unknown asset".into());
                };
                ASSET_REQUESTS.fetch_add(1, Ordering::Relaxed);
                let bytes = fs::read(root.join("assets").join(name)).map_err(|e| e.to_string())?;
                if digest(&bytes) != *expected {
                    return Err(
                        "Engine asset failed SHA-256 verification; reinstall LuaLaTeX.".into(),
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
            if let Some(relative) = path.strip_prefix("/mirror/") {
                if !safe_relative(relative) {
                    return Err("Invalid package path".into());
                }
                let cache = root.join("mirror").join(relative);
                // The hit path holds the lock only for the read. The miss path
                // releases it around the download, because holding a global lock
                // across a network request serialises every package a compile
                // asks for and makes a slow mirror look like a hang.
                {
                    let _guard = CACHE_LOCK
                        .lock()
                        .map_err(|_| "The LaTeX cache is unavailable.")?;
                    if fs::metadata(&cache).is_ok_and(|meta| meta.len() <= MAX_FILE as u64) {
                        if let Ok(bytes) = fs::read(&cache) {
                            CACHE_HITS.fetch_add(1, Ordering::Relaxed);
                            return Ok((bytes, "application/octet-stream"));
                        }
                    }
                }
                CACHE_MISSES.fetch_add(1, Ordering::Relaxed);
                let bytes = download(&format!("{MIRROR}{relative}"))?;
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
}

fn supported(path: &Path) -> bool {
    path.extension().and_then(|e| e.to_str()).is_some_and(|e| {
        [
            "tex", "bib", "sty", "cls", "bst", "png", "jpg", "jpeg", "pdf", "otf", "ttf",
        ]
        .contains(&e.to_ascii_lowercase().as_str())
    })
}

fn collect(
    root: &Path,
    dir: &Path,
    depth: usize,
    files: &mut Vec<(PathBuf, Vec<u8>)>,
    total: &mut usize,
) -> Result<(), String> {
    if depth > MAX_DEPTH {
        return Err("The LaTeX project exceeds the directory depth limit.".into());
    }
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.file_name().to_string_lossy().starts_with('.') {
            continue;
        }
        let path = entry.path();
        let meta = fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
        if meta.file_type().is_symlink() {
            return Err(format!(
                "Project symlinks are not supported: {}",
                path.display()
            ));
        }
        let resolved = fs::canonicalize(&path).map_err(|e| e.to_string())?;
        if !resolved.starts_with(root) {
            return Err(format!("Project path escapes its root: {}", path.display()));
        }
        if meta.is_dir() {
            collect(root, &resolved, depth + 1, files, total)?;
        } else if meta.is_file() && supported(&path) {
            if files.len() >= MAX_FILES || meta.len() > MAX_FILE as u64 {
                return Err("The LaTeX project exceeds its file count or file size limit.".into());
            }
            let bytes = fs::read(&resolved).map_err(|e| e.to_string())?;
            if bytes.len() > MAX_FILE {
                return Err("A LaTeX project file exceeds 32 MiB.".into());
            }
            *total = total
                .checked_add(bytes.len())
                .ok_or("Project size overflow")?;
            if *total > MAX_PROJECT {
                return Err("The LaTeX project exceeds 64 MiB.".into());
            }
            files.push((resolved, bytes));
        }
    }
    Ok(())
}

/// Capture the project directory and overlay the current open text buffers.
#[tauri::command]
pub async fn latex_project_snapshot(
    path: String,
    overlays: Vec<Overlay>,
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
        let mut total = 0;
        collect(&root, &root, 0, &mut files, &mut total)?;
        for overlay in overlays {
            let Ok(full) = fs::canonicalize(&overlay.path) else {
                continue;
            };
            if !full.starts_with(&root) {
                continue;
            }
            if let Some((_, bytes)) = files.iter_mut().find(|(path, _)| *path == full) {
                if overlay.text.len() > MAX_FILE {
                    return Err("An open LaTeX project file exceeds 32 MiB.".into());
                }
                total = total.saturating_sub(bytes.len()) + overlay.text.len();
                if total > MAX_PROJECT {
                    return Err("The LaTeX project exceeds 64 MiB.".into());
                }
                *bytes = overlay.text.into_bytes();
            }
        }
        let relative = |path: &Path| -> Result<String, String> {
            let path = path.strip_prefix(&root).map_err(|e| e.to_string())?;
            let text = path
                .to_str()
                .ok_or("Project paths must be valid Unicode.")?;
            Ok(text.replace('\\', "/"))
        };
        let main_file = relative(&main)?;
        let files = files
            .into_iter()
            .map(|(path, data)| {
                Ok(ProjectFile {
                    path: relative(&path)?,
                    data: STANDARD.encode(data),
                })
            })
            .collect::<Result<_, String>>()?;
        Ok(ProjectSnapshot { main_file, files })
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

#[cfg(test)]
mod tests {
    use super::{cache_size, collect, evict_to_limit, safe_relative};
    use std::{fs, path::Path};
    #[test]
    fn mirror_paths_cannot_escape_or_change_host() {
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

    #[test]
    fn project_snapshot_preserves_binary_images_and_included_files() {
        let root =
            fs::canonicalize(Path::new(env!("CARGO_MANIFEST_DIR")).join("../samples/latex-poc"))
                .unwrap();
        let mut files = Vec::new();
        let mut total = 0;
        collect(&root, &root, 0, &mut files, &mut total).unwrap();
        let image = files
            .iter()
            .find(|(path, _)| path.ends_with("figures/diagram.png"))
            .unwrap();
        assert!(image.1.starts_with(b"\x89PNG\r\n\x1a\n"));
        assert!(
            files
                .iter()
                .any(|(path, _)| path.ends_with("chapters/intro.tex"))
        );
        assert!(
            files
                .iter()
                .any(|(path, _)| path.ends_with("references.bib"))
        );
        assert!(total > image.1.len());
    }

    #[cfg(unix)]
    #[test]
    fn project_snapshot_refuses_symlinks_even_inside_root() {
        use std::os::unix::fs::symlink;
        let root = std::env::temp_dir().join(format!("mdraft-latex-link-{}", std::process::id()));
        fs::create_dir(&root).unwrap();
        let link = root.join("escape");
        symlink("/", &link).unwrap();
        let mut files = Vec::new();
        let mut total = 0;
        let root = fs::canonicalize(root).unwrap();
        assert!(
            collect(&root, &root, 0, &mut files, &mut total)
                .unwrap_err()
                .contains("symlink")
        );
        fs::remove_file(link).unwrap();
        fs::remove_dir(root).unwrap();
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
