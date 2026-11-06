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
        atomic::{AtomicU64, Ordering},
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
const MAX_CACHE: u64 = 256 * 1024 * 1024;
static TEMP_ID: AtomicU64 = AtomicU64::new(0);
static CACHE_LOCK: Mutex<()> = Mutex::new(());
static ASSET_REQUESTS: AtomicU64 = AtomicU64::new(0);
static CACHE_HITS: AtomicU64 = AtomicU64::new(0);
static CACHE_MISSES: AtomicU64 = AtomicU64::new(0);

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

#[tauri::command]
pub fn latex_status(app: AppHandle) -> bool {
    directory(&app).is_ok_and(|dir| dir.join("enabled").is_file())
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
        write_atomic(&root.join("enabled"), b"wasmtex-poc-2025\n")
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
            return Err("A symlink was found in the LaTeX cache.".into());
        }
        let size = if metadata.is_dir() {
            cache_size(&entry.path())?
        } else {
            metadata.len()
        };
        total = total
            .checked_add(size)
            .ok_or("LaTeX cache size overflow.")?;
        if total > MAX_CACHE {
            return Err("The LaTeX package cache exceeds 256 MiB.".into());
        }
    }
    Ok(total)
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
            if !root.join("enabled").is_file() {
                return Err("LaTeX setup has not been enabled.".into());
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
                let _guard = CACHE_LOCK
                    .lock()
                    .map_err(|_| "The LaTeX cache is unavailable.")?;
                if fs::metadata(&cache).is_ok_and(|meta| meta.len() <= MAX_FILE as u64) {
                    if let Ok(bytes) = fs::read(&cache) {
                        CACHE_HITS.fetch_add(1, Ordering::Relaxed);
                        return Ok((bytes, "application/octet-stream"));
                    }
                }
                CACHE_MISSES.fetch_add(1, Ordering::Relaxed);
                let bytes = download(&format!("{MIRROR}{relative}"))?;
                if cache_size(&root.join("mirror"))?.saturating_add(bytes.len() as u64) > MAX_CACHE
                {
                    return Err("The LaTeX package cache is full (256 MiB).".into());
                }
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

#[tauri::command]
pub async fn latex_save_pdf(output_path: String, data: String) -> Result<(), String> {
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
    use super::{collect, safe_relative};
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
}
