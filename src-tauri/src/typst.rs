//! Typst: finding the compiler, installing it, and rendering a preview.
//!
//! Typst replaces the LaTeX route to PDF. The comparison is not close: a TeX
//! distribution is several gigabytes and needs a package manager to keep working,
//! while Typst is a single 50 MB executable with no dependencies at all, and it
//! is markedly faster. pandoc drives it with `--pdf-engine=<path>` and does the
//! rest, so nothing here has to know how a PDF is put together.
//!
//! The compiler is *not* bundled. It is downloaded on request into the
//! application's data directory, which keeps this binary small and keeps the
//! licence question simple — Typst is Apache-2.0 and would have to be shipped
//! with its notice otherwise.

// TODO(coordinator): Register `typst::render_typst_binary`,
// `typst::service::typst_service_status`, `typst::service::install_typst_service`,
// and `typst::service::typst_clear_cache` in `lib.rs` `generate_handler!`, or
// promote `mod typst_service;` into `lib.rs` and replace this with
// `pub(crate) use crate::typst_service as service;`.
#[path = "typst_service.rs"]
pub mod service;

use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant, UNIX_EPOCH};

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};

use crate::export::{quiet, sha256_hex, which};

/// Where the official downloads live. Shown whenever something has to be done by
/// hand, because it is the page that stays correct across releases.
pub const DOWNLOAD_PAGE: &str = "https://typst.app/open-source/#download";

const RELEASE_API: &str = "https://api.github.com/repos/typst/typst/releases/latest";
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(600);
/// A preview that takes longer than this is a runaway document, not a big one.
const RENDER_TIMEOUT: Duration = Duration::from_secs(60);
pub(crate) const PREVIEW_SUPERSEDED: &str = "Typst render was superseded by a newer edit.";

/// Each render gets its own output name, including concurrent exports.
static NEXT_OUTPUT: AtomicU64 = AtomicU64::new(0);

fn render_output(dir: &Path, extension: &str) -> PathBuf {
    dir.join(format!(
        "render-{}-{}.{}",
        std::process::id(),
        NEXT_OUTPUT.fetch_add(1, Ordering::Relaxed),
        extension
    ))
}

pub(crate) type WakeSignal = Arc<(Mutex<bool>, Condvar)>;

/// The newest preview compile per window, and the signal that stops the previous
/// one immediately without timer polling.
pub(crate) struct PreviewCancel {
    flag: AtomicBool,
    waiters: Mutex<Vec<WakeSignal>>,
}

impl PreviewCancel {
    pub(crate) fn new(cancelled: bool) -> Self {
        Self {
            flag: AtomicBool::new(cancelled),
            waiters: Mutex::new(Vec::new()),
        }
    }

    pub(crate) fn load(&self, order: Ordering) -> bool {
        self.flag.load(order)
    }

    pub(crate) fn cancel(&self) {
        self.flag.store(true, Ordering::Release);
        if let Ok(mut waiters) = self.waiters.lock() {
            for signal in waiters.drain(..) {
                let (lock, cvar) = &*signal;
                if let Ok(mut woken) = lock.lock() {
                    *woken = true;
                }
                cvar.notify_all();
            }
        }
    }

    pub(crate) fn subscribe(&self, signal: WakeSignal) -> CancelSubscription<'_> {
        if self.flag.load(Ordering::Acquire) {
            let (lock, cvar) = &*signal;
            if let Ok(mut woken) = lock.lock() {
                *woken = true;
            }
            cvar.notify_all();
            return CancelSubscription {
                parent: self,
                signal: None,
            };
        }
        if let Ok(mut waiters) = self.waiters.lock() {
            if self.flag.load(Ordering::Acquire) {
                let (lock, cvar) = &*signal;
                if let Ok(mut woken) = lock.lock() {
                    *woken = true;
                }
                cvar.notify_all();
                return CancelSubscription {
                    parent: self,
                    signal: None,
                };
            }
            waiters.push(Arc::clone(&signal));
        }
        CancelSubscription {
            parent: self,
            signal: Some(signal),
        }
    }
}

pub(crate) struct CancelSubscription<'a> {
    parent: &'a PreviewCancel,
    signal: Option<WakeSignal>,
}

impl Drop for CancelSubscription<'_> {
    fn drop(&mut self) {
        let Some(target) = self.signal.take() else {
            return;
        };
        if let Ok(mut waiters) = self.parent.waiters.lock() {
            waiters.retain(|item| !Arc::ptr_eq(item, &target));
        }
    }
}

type PreviewFlag = Arc<PreviewCancel>;
#[derive(Default)]
struct PreviewState {
    /// Retained after completion so a late IPC request cannot revive old work.
    latest: Option<u64>,
    active: Option<(u64, PreviewFlag)>,
}
static PREVIEW_FLAGS: OnceLock<Mutex<HashMap<String, PreviewState>>> = OnceLock::new();
static PREVIEW_SLOT: OnceLock<tokio::sync::Semaphore> = OnceLock::new();

fn preview_flags() -> &'static Mutex<HashMap<String, PreviewState>> {
    PREVIEW_FLAGS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Register a preview token and cancel every older compile for this window.
fn begin_preview(key: &str, token: u64) -> PreviewFlag {
    if let Ok(mut flags) = preview_flags().lock() {
        let state = flags.entry(key.to_string()).or_default();
        if state.latest.is_some_and(|latest| token <= latest) {
            return Arc::new(PreviewCancel::new(true));
        }
        if let Some((_, previous)) = &state.active {
            previous.cancel();
        }
        let flag = Arc::new(PreviewCancel::new(false));
        state.latest = Some(token);
        state.active = Some((token, flag.clone()));
        return flag;
    }
    // A poisoned registry cannot establish ownership safely.
    Arc::new(PreviewCancel::new(true))
}

/// Drop a finished token without removing a newer one registered meanwhile.
fn end_preview(key: &str, token: u64) {
    if let Ok(mut flags) = preview_flags().lock()
        && let Some(state) = flags.get_mut(key)
        && state
            .active
            .as_ref()
            .is_some_and(|(current, _)| *current == token)
    {
        state.active = None;
    }
}

/// Advance the watermark and stop only previews at or before this generation.
fn cancel_preview(key: &str, token: u64) -> Result<(), String> {
    let mut flags = preview_flags()
        .lock()
        .map_err(|_| "The Typst preview registry is unavailable.".to_string())?;
    let state = flags.entry(key.to_string()).or_default();
    if state.latest.is_none_or(|latest| token > latest) {
        state.latest = Some(token);
    }
    if let Some((current, flag)) = &state.active
        && *current <= token
    {
        flag.cancel();
    }
    Ok(())
}

#[tauri::command]
pub fn cancel_typst_preview(token: u64) -> Result<(), String> {
    cancel_preview("typst-preview", token)
}

pub fn typst_exe() -> &'static str {
    if cfg!(windows) { "typst.exe" } else { "typst" }
}

/// The archive GitHub publishes for this platform, when automatic installation
/// is possible.
///
/// Windows gets a `.zip`; Linux gets a statically linked musl build inside a
/// `.tar.xz`, which [`extract_binary`] decodes in-process. macOS and other
/// architectures still install by hand, where a package manager is the better
/// answer anyway.
fn release_asset() -> Option<&'static str> {
    if cfg!(all(windows, target_arch = "x86_64")) {
        Some("typst-x86_64-pc-windows-msvc.zip")
    } else if cfg!(all(windows, target_arch = "aarch64")) {
        Some("typst-aarch64-pc-windows-msvc.zip")
    } else if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
        Some("typst-x86_64-unknown-linux-musl.tar.xz")
    } else if cfg!(all(target_os = "linux", target_arch = "aarch64")) {
        Some("typst-aarch64-unknown-linux-musl.tar.xz")
    } else {
        None
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TypstStatus {
    pub found: bool,
    pub version: Option<String>,
    pub path: Option<String>,
    /// "managed" when we installed it, "path" when it came from `PATH`.
    pub source: Option<String>,
    /// Whether the Install button can do the work here, or only explain.
    pub can_install: bool,
    /// A one-line explanation to show beside the button.
    pub hint: String,
    pub download_page: String,
}

pub struct FoundTypst {
    pub path: PathBuf,
    pub source: &'static str,
    pub version: String,
}

fn managed_root<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("typst"))
}

/// A Typst we installed earlier. Any version directory will do; the
/// lexicographically last wins, which is the newest for the numeric tags GitHub
/// publishes.
fn managed_typst<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    let root = managed_root(app)?;
    let mut candidates: Vec<PathBuf> = std::fs::read_dir(&root)
        .ok()?
        .filter_map(Result::ok)
        .map(|entry| entry.path().join(typst_exe()))
        .filter(|path| path.is_file())
        .collect();
    candidates.sort();
    candidates.pop()
}

fn probe_version(path: &Path) -> Option<String> {
    let output = quiet(&mut std::process::Command::new(path))
        .arg("--version")
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    // "typst 0.15.1 (9dfd3a08)"
    let first = text.lines().next()?.trim();
    let mut parts = first.split_whitespace();
    match (parts.next(), parts.next()) {
        (Some("typst"), Some(version)) => Some(version.to_string()),
        _ => None,
    }
}

/// The Typst to use, preferring our own copy over whatever is on `PATH`.
pub fn find_typst<R: Runtime>(app: &AppHandle<R>) -> Option<FoundTypst> {
    let (path, source) = managed_typst(app)
        .map(|path| (path, "managed"))
        .or_else(|| which(typst_exe()).map(|path| (path, "path")))?;
    let version = probe_version(&path)?;
    Some(FoundTypst {
        path,
        source,
        version,
    })
}

pub fn status<R: Runtime>(app: &AppHandle<R>) -> TypstStatus {
    let can_install = release_asset().is_some();
    match find_typst(app) {
        Some(found) => TypstStatus {
            found: true,
            version: Some(found.version),
            path: Some(found.path.to_string_lossy().into_owned()),
            source: Some(found.source.into()),
            can_install,
            hint: "Used for PDF export and for previewing .typ documents.".into(),
            download_page: DOWNLOAD_PAGE.into(),
        },
        None => TypstStatus {
            found: false,
            version: None,
            path: None,
            source: None,
            can_install,
            hint: if can_install {
                "Not installed. Typst is a single executable and is what turns Markdown into a PDF."
                    .into()
            } else {
                format!(
                    "Not installed. Install it with your package manager (`cargo install typst-cli`, \
                     `apt install typst`, `brew install typst`) or from {DOWNLOAD_PAGE}, and it will \
                     be picked up from PATH."
                )
            },
            download_page: DOWNLOAD_PAGE.into(),
        },
    }
}

#[tauri::command]
pub fn typst_status<R: Runtime>(app: AppHandle<R>) -> TypstStatus {
    status(&app)
}

/// Open the official download page, for platforms that install by hand.
#[tauri::command]
pub fn typst_download_page() -> Result<(), String> {
    tauri_plugin_opener::open_url(DOWNLOAD_PAGE, None::<&str>)
        .map_err(|e| format!("Could not open the browser: {e}"))
}

// ---------------------------------------------------------------------------
// Installing
// ---------------------------------------------------------------------------

#[derive(serde::Deserialize)]
struct Release {
    tag_name: String,
    assets: Vec<Asset>,
}

#[derive(serde::Deserialize)]
struct Asset {
    name: String,
    browser_download_url: String,
    /// `sha256:<hex>`, published by GitHub for every release asset.
    digest: Option<String>,
}

fn http_agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(DOWNLOAD_TIMEOUT))
        // GitHub rejects API requests without a User-Agent.
        .user_agent(concat!("MDraft/", env!("CARGO_PKG_VERSION")))
        .build()
        .into()
}

/// Fetch the release, verify the archive's published digest, and unpack the
/// compiler.
///
/// Kept separate from [`install`] so the whole download-verify-unpack contract
/// can be exercised without an `AppHandle`; see the ignored test at the bottom
/// of this file.
fn download_binary(agent: &ureq::Agent) -> Result<(String, Vec<u8>), String> {
    let asset = release_asset().ok_or_else(|| {
        format!(
            "Typst cannot be installed automatically on this platform. Download it from \
             {DOWNLOAD_PAGE}, or install it with your package manager, and it will be picked up \
             from PATH."
        )
    })?;

    let release: Release = {
        let body = agent
            .get(RELEASE_API)
            .header("Accept", "application/vnd.github+json")
            .call()
            .map_err(|e| format!("Could not reach GitHub to list Typst releases: {e}"))?
            .body_mut()
            .with_config()
            .limit(4 * 1024 * 1024)
            .read_to_vec()
            .map_err(|e| format!("Could not read the release list: {e}"))?;
        serde_json::from_slice(&body)
            .map_err(|e| format!("Unexpected release list from GitHub: {e}"))?
    };

    let chosen = release
        .assets
        .iter()
        .find(|a| a.name == asset)
        .ok_or_else(|| {
            format!(
                "The latest Typst release ({}) has no build called {asset}. Its packaging may have \
                 changed; download Typst from {DOWNLOAD_PAGE} instead.",
                release.tag_name
            )
        })?;

    let expected = chosen
        .digest
        .as_deref()
        .and_then(|digest| digest.strip_prefix("sha256:"))
        .ok_or_else(|| {
            format!(
                "GitHub did not publish a SHA-256 for {} so the download cannot be verified. \
                 Install Typst yourself from {DOWNLOAD_PAGE} and it will be picked up from PATH.",
                chosen.name
            )
        })?
        .to_lowercase();

    let archive = agent
        .get(&chosen.browser_download_url)
        .call()
        .map_err(|e| format!("Could not download Typst: {e}"))?
        .body_mut()
        .with_config()
        .limit(256 * 1024 * 1024)
        .read_to_vec()
        .map_err(|e| format!("Could not read the download: {e}"))?;

    let actual = sha256_hex(&archive);
    if actual != expected {
        return Err(format!(
            "The downloaded Typst archive did not match the digest GitHub published, so it was \
             discarded.\n expected {expected}\n got      {actual}"
        ));
    }

    Ok((release.tag_name, extract_named_binary(&archive, typst_exe())?))
}

#[tauri::command]
pub async fn install_typst<R: Runtime>(app: AppHandle<R>) -> Result<TypstStatus, String> {
    tauri::async_runtime::spawn_blocking(move || install(&app))
        .await
        .map_err(|e| format!("The install task could not be started: {e}"))?
}

/// One Typst installation at a time; Pandoc and LaTeX have their own locks.
static TYPST_INSTALL: Mutex<()> = Mutex::new(());

fn install<R: Runtime>(app: &AppHandle<R>) -> Result<TypstStatus, String> {
    // A second Install waits for the first instead of writing the same file.
    let _install = TYPST_INSTALL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let (tag, binary) = download_binary(&http_agent())?;

    let root = managed_root(app).ok_or_else(|| {
        "The application could not work out where to put Typst, so it was not installed."
            .to_string()
    })?;
    let version = tag.trim_start_matches('v').to_string();
    let dir = root.join(&version);
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    let target = dir.join(typst_exe());
    crate::latex::write_atomic(&target, &binary)
        .map_err(|e| format!("Could not write {}: {e}", target.display()))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o755));
    }

    if probe_version(&target).is_none() {
        let _ = std::fs::remove_file(&target);
        return Err(
            "Typst was downloaded and unpacked but would not run, so it was removed. Install it \
             yourself and it will be picked up from PATH."
                .into(),
        );
    }

    Ok(status(app))
}

/// Read `exe_name` out of a zip archive (Windows/macOS release bundles).
#[cfg(any(target_os = "windows", target_os = "macos"))]
pub(crate) fn extract_named_binary(archive: &[u8], exe_name: &str) -> Result<Vec<u8>, String> {
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(archive))
        .map_err(|e| format!("The downloaded archive is not a readable zip: {e}"))?;

    // The index is found first and the entry reopened afterwards: `ZipArchive`
    // borrows mutably for the life of an entry, so holding one while asking for
    // the next does not compile.
    let mut found: Option<(usize, String)> = None;
    for index in 0..zip.len() {
        let entry = zip
            .by_index(index)
            .map_err(|e| format!("Could not read archive entry {index}: {e}"))?;
        if entry.is_dir() {
            continue;
        }
        let name = entry
            .name()
            .map_err(|e| format!("Could not read archive entry {index}'s name: {e}"))?
            .to_string();
        if Path::new(&name).file_name().and_then(|n| n.to_str()) == Some(exe_name) {
            found = Some((index, name));
            break;
        }
    }

    let (index, name) = found.ok_or_else(|| {
        format!(
            "The downloaded archive did not contain {exe_name}. Its layout may have changed."
        )
    })?;
    let mut entry = zip
        .by_index(index)
        .map_err(|e| format!("Could not reopen {name}: {e}"))?;
    let mut bytes = Vec::with_capacity(entry.size() as usize);
    entry
        .read_to_end(&mut bytes)
        .map_err(|e| format!("Could not read {name} out of the archive: {e}"))?;
    Ok(bytes)
}

/// Read `exe_name` out of a `.tar.xz` archive (Linux release bundles).
///
/// The xz stream is decoded in memory with the pure-Rust `lzma-rs`, so no system
/// `xz` binary or `liblzma` is involved. Only the matching member's bytes are
/// kept: nothing is unpacked to disk and the entry's path is never used to
/// construct a destination.
#[cfg(target_os = "linux")]
pub(crate) fn extract_named_binary(archive: &[u8], exe_name: &str) -> Result<Vec<u8>, String> {
    let mut tar_bytes = Vec::new();
    lzma_rs::xz_decompress(&mut std::io::Cursor::new(archive), &mut tar_bytes)
        .map_err(|e| format!("The downloaded archive is not readable xz: {e}"))?;

    let mut tar = tar::Archive::new(std::io::Cursor::new(tar_bytes));
    let entries = tar
        .entries()
        .map_err(|e| format!("The downloaded archive is not a readable tar: {e}"))?;
    for entry in entries {
        let mut entry = entry.map_err(|e| format!("Could not read a tar entry: {e}"))?;
        let path = entry
            .path()
            .map_err(|e| format!("Could not read a tar entry name: {e}"))?
            .into_owned();
        if path.file_name().and_then(|n| n.to_str()) != Some(exe_name) {
            continue;
        }
        let mut bytes = Vec::new();
        entry
            .read_to_end(&mut bytes)
            .map_err(|e| format!("Could not read {exe_name}: {e}"))?;
        if !bytes.is_empty() {
            return Ok(bytes);
        }
    }
    Err(format!(
        "The downloaded archive did not contain {exe_name}. Its layout may have changed."
    ))
}

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
pub(crate) fn extract_named_binary(_archive: &[u8], _exe_name: &str) -> Result<Vec<u8>, String> {
    Err("Automatic installation is not implemented on this platform.".into())
}

// ---------------------------------------------------------------------------
// Rendering a preview
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TypstDependency {
    pub path: String,
    pub mtime_ms: u64,
    pub size: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TypstSpanAnchor {
    pub file: String,
    pub line: usize,
    pub column: usize,
    pub byte_offset: usize,
    pub utf16_start: usize,
    pub utf16_end: usize,
    pub page: usize,
    pub x_pt: f64,
    pub y_pt: f64,
    pub width_pt: f64,
    pub height_pt: f64,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct TypstTimings {
    pub vfs_sync_ms: f64,
    pub typst_compile_ms: f64,
    pub export_ms: f64,
    pub page_hash_ms: f64,
    pub total_ms: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderedTypst {
    pub compiler_output: String,
    pub compiler_output_truncated: bool,
    /// `"document"` when the pane should show flowing HTML, `"pages"` when it
    /// should show the compiler's PDF pages.
    pub kind: String,
    /// Body markup, when `kind` is `"document"`.
    pub html: Option<String>,
    /// The export's own stylesheet. Most of it is MathML layout: browsers get
    /// alignment inside tabular mathematics wrong without it.
    pub css: Option<String>,
    /// Base64-encoded PDF, when `kind` is `"pages"` (populated only by legacy
    /// JSON callers; [`render_typst_binary`] omits this field and appends raw
    /// PDF bytes after the length-prefixed JSON header).
    pub pdf: Option<String>,
    /// Warnings worth showing. Not errors: a document with warnings still renders.
    pub warnings: Vec<String>,
    /// Constructs the document view dropped, by name. Its HTML export cannot
    /// express layout, so `#rect`, `#align` and `#pagebreak` are discarded
    /// silently apart from a warning — which the pane has to surface, or it
    /// quietly shows less than the document contains.
    pub ignored: Vec<String>,
    /// File dependencies resolved by Typst during this compile (`#image`, `#include`,
    /// `#import`, bibliography), with mtime/size fingerprints for cache validation.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub deps: Vec<TypstDependency>,
    /// Per-page frame content digests when provided by the companion service.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub page_hashes: Vec<String>,
    /// 1-based first page index whose hash differs from the previous compile.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub first_changed_page: Option<usize>,
    /// 1-based page indices whose hashes changed since the previous compile.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub changed_pages: Vec<usize>,
    /// Compiler AST span anchors across project files (`service` mode only).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub span_map: Vec<TypstSpanAnchor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timings: Option<TypstTimings>,
    #[serde(default)]
    pub fell_back_from_document: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backend_kind: Option<String>,
}

/// Internal compilation output carrying raw PDF bytes before deciding whether
/// an IPC endpoint Base64-encodes or frames raw binary bytes.
pub(crate) struct CompiledTypst {
    pub rendered: RenderedTypst,
    pub pdf_bytes: Option<Vec<u8>>,
}

/// Frame `[u32 BE meta_len][meta_json][raw pdf bytes]` for zero-copy IPC transfer.
pub(crate) fn frame_binary_response(meta: &RenderedTypst, pdf: &[u8]) -> Result<Vec<u8>, String> {
    let header = serde_json::to_vec(meta)
        .map_err(|e| format!("Could not encode Typst metadata header: {e}"))?;
    let header_len = u32::try_from(header.len())
        .map_err(|_| "Typst metadata header exceeded 4 GiB.".to_string())?;
    let mut framed = Vec::with_capacity(4 + header.len() + pdf.len());
    framed.extend_from_slice(&header_len.to_be_bytes());
    framed.extend_from_slice(&header);
    framed.extend_from_slice(pdf);
    Ok(framed)
}

async fn compile_preview<R: Runtime>(
    app: AppHandle<R>,
    path: Option<String>,
    source: String,
    mode: String,
    image_root: Option<String>,
    token: Option<u64>,
) -> Result<CompiledTypst, String> {
    // The application is single-window; one key is enough to let a newer
    // preview stop the compile the previous one started.
    let key = "typst-preview";
    let cancel = token.map(|value| begin_preview(key, value));
    // A newer request signals the running child before waiting for this slot.
    // Export calls have no token and retain their independent process/output.
    let _permit = if let Some(flag) = cancel.as_ref() {
        if flag.load(Ordering::Relaxed) {
            if let Some(value) = token {
                end_preview(key, value);
            }
            return Err(PREVIEW_SUPERSEDED.into());
        }
        let slot = PREVIEW_SLOT.get_or_init(|| tokio::sync::Semaphore::new(1));
        let permit = slot
            .acquire()
            .await
            .map_err(|_| "The Typst preview queue is unavailable.".to_string())?;
        if flag.load(Ordering::Relaxed) {
            if let Some(value) = token {
                end_preview(key, value);
            }
            return Err(PREVIEW_SUPERSEDED.into());
        }
        Some(permit)
    } else {
        None
    };
    let result = tauri::async_runtime::spawn_blocking(move || {
        render(
            &app,
            path.as_deref(),
            &source,
            &mode,
            image_root.as_deref(),
            cancel.as_deref(),
        )
    })
    .await
    .map_err(|e| format!("The Typst render task could not be started: {e}"))
    .and_then(|result| result);
    if let Some(value) = token {
        end_preview(key, value);
    }
    result
}

/// Compile a Typst document for the preview pane (JSON + Base64 PDF compatibility path).
#[tauri::command]
pub async fn render_typst<R: Runtime>(
    app: AppHandle<R>,
    path: Option<String>,
    source: String,
    mode: Option<String>,
    image_root: Option<String>,
    token: Option<u64>,
) -> Result<RenderedTypst, String> {
    let mode = mode.unwrap_or_else(|| "document".into());
    let mut compiled = compile_preview(app, path, source, mode, image_root, token).await?;
    compiled.rendered.pdf = compiled.pdf_bytes.map(|bytes| BASE64.encode(bytes));
    Ok(compiled.rendered)
}

/// Compile a Typst document for the preview pane without Base64 encoding PDF bytes.
#[tauri::command]
pub async fn render_typst_binary<R: Runtime>(
    app: AppHandle<R>,
    path: Option<String>,
    source: String,
    mode: Option<String>,
    image_root: Option<String>,
    token: Option<u64>,
) -> Result<tauri::ipc::Response, String> {
    let mode = mode.unwrap_or_else(|| "document".into());
    let compiled = compile_preview(app, path, source, mode, image_root, token).await?;
    let framed = frame_binary_response(
        &compiled.rendered,
        compiled.pdf_bytes.as_deref().unwrap_or(&[]),
    )?;
    Ok(tauri::ipc::Response::new(framed))
}

/// Temporary file guard for Typst's `--deps <path> --deps-format json`.
struct DepsGuard {
    path: PathBuf,
}

impl DepsGuard {
    fn new(dir: &Path) -> Self {
        Self {
            path: render_output(dir, "deps.json"),
        }
    }
}

impl Drop for DepsGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

#[derive(Deserialize)]
struct TypstDepsJson {
    #[serde(default)]
    inputs: Vec<String>,
}

fn supports_cli_version(version: &str, min_major: u32, min_minor: u32) -> bool {
    let mut parts = version.split('.').filter_map(|p| {
        let digits: String = p.chars().take_while(|c| c.is_ascii_digit()).collect();
        digits.parse::<u32>().ok()
    });
    let (Some(major), Some(minor)) = (parts.next(), parts.next()) else {
        return false;
    };
    (major, minor) >= (min_major, min_minor)
}

fn parse_deps_json(raw: &str, ignore_path: Option<&Path>) -> Vec<TypstDependency> {
    let Ok(parsed) = serde_json::from_str::<TypstDepsJson>(raw) else {
        return Vec::new();
    };
    let ignore_norm = ignore_path.map(|p| {
        let s = p.to_string_lossy();
        s.strip_prefix(r"\\?\").unwrap_or(&s).to_owned()
    });
    let mut deps = Vec::new();
    for entry in parsed.inputs {
        if entry == "<stdin>" || entry.is_empty() {
            continue;
        }
        let clean = entry.strip_prefix(r"\\?\").unwrap_or(&entry).to_owned();
        if ignore_norm.as_deref() == Some(clean.as_str()) {
            continue;
        }
        let Ok(meta) = std::fs::metadata(&clean) else {
            continue;
        };
        if !meta.is_file() {
            continue;
        }
        let mtime_ms = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
            .unwrap_or(0);
        deps.push(TypstDependency {
            path: clean,
            mtime_ms,
            size: meta.len(),
        });
    }
    deps.sort_by(|a, b| a.path.cmp(&b.path));
    deps.dedup_by(|a, b| a.path == b.path);
    deps
}

struct CliRunOptions<'a> {
    binary: &'a Path,
    version: &'a str,
    root: &'a Path,
    main_file: Option<&'a Path>,
    source: &'a str,
    extra: &'a [&'a str],
    output: &'a Path,
    deps_dir: Option<&'a Path>,
    cancel: Option<&'a PreviewCancel>,
}

/// Run Typst once, feeding the document on stdin when compiling from root.
///
/// Returns `(succeeded, stderr, deps)`.
fn run_typst_with_deps(opts: CliRunOptions<'_>) -> Result<(bool, String, Vec<TypstDependency>), String> {
    let mut command = std::process::Command::new(opts.binary);
    quiet(&mut command)
        .arg("compile")
        .args(opts.extra)
        .arg("--root")
        .arg(opts.root);

    let deps_guard = opts
        .deps_dir
        .filter(|_| supports_cli_version(opts.version, 0, 13))
        .map(DepsGuard::new);
    if let Some(guard) = &deps_guard {
        command.arg("--deps").arg(&guard.path).arg("--deps-format").arg("json");
    }

    // Typst places a document read from stdin at the root, so its relative
    // paths resolve from there. When the root is wider than the document's
    // folder (a workspace, or a custom image folder elsewhere), a chapter's
    // `#import "../template.typ"` or `#image("img/a.png")` would resolve from
    // the wrong folder ("path would escape the project root"). Then the saved
    // file itself is compiled when the buffer matches it, and only an unsaved
    // buffer goes through a hidden sibling file, removed afterwards
    // (docs/adr/2026-11-13-typst-widened-root.md).
    let widened = opts
        .main_file
        .filter(|file| file.parent().is_some_and(|dir| dir != opts.root));
    let mut sibling = None;
    let mut stdin = opts.source;
    match widened {
        Some(file) if std::fs::read(file).is_ok_and(|bytes| bytes == opts.source.as_bytes()) => {
            command.arg(file);
            stdin = "";
        }
        Some(file) => {
            let written = Sibling::write(file, opts.source)?;
            command.arg(&written.path);
            sibling = Some(written);
            stdin = "";
        }
        None => {
            command.arg("-");
        }
    }
    command.arg(opts.output).current_dir(opts.root);
    let (ok, stderr) = run_typst_command(command, stdin, opts.cancel, RENDER_TIMEOUT)?;
    let deps = match &deps_guard {
        Some(guard) => std::fs::read_to_string(&guard.path)
            .ok()
            .map(|raw| parse_deps_json(&raw, sibling.as_ref().map(|s| s.path.as_path())))
            .unwrap_or_default(),
        None => Vec::new(),
    };
    // Diagnostics name the document the reader edits, not the sibling.
    let stderr = match &sibling {
        Some(file) => stderr.replace(&file.name, &file.document_name),
        None => stderr,
    };
    Ok((ok, stderr, deps))
}

fn run_typst(
    binary: &Path,
    root: &Path,
    main_file: Option<&Path>,
    source: &str,
    extra: &[&str],
    output: &Path,
    cancel: Option<&PreviewCancel>,
) -> Result<(bool, String), String> {
    let (ok, stderr, _) = run_typst_with_deps(CliRunOptions {
        binary,
        version: "",
        root,
        main_file,
        source,
        extra,
        output,
        deps_dir: None,
        cancel,
    })?;
    Ok((ok, stderr))
}

/// The unsaved buffer written beside the document for one compile; see `run_typst`.
struct Sibling {
    path: PathBuf,
    name: String,
    document_name: String,
}

impl Sibling {
    fn write(document: &Path, source: &str) -> Result<Self, String> {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let dir = document.parent().ok_or("The document has no folder.")?;
        let name = format!(
            ".mdraft-preview-{}-{}.typ",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        );
        let path = dir.join(&name);
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        // Hidden on Windows too, where a leading dot does not hide a file.
        #[cfg(windows)]
        std::os::windows::fs::OpenOptionsExt::attributes(&mut options, 0x2);
        let written = options.open(&path).and_then(|mut file| {
            use std::io::Write;
            file.write_all(source.as_bytes())
        });
        let sibling = Self {
            path,
            name,
            document_name: document
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_default(),
        };
        // Dropping `sibling` removes a partly written file.
        written
            .map_err(|e| format!("Could not write the preview file in {}: {e}", dir.display()))?;
        Ok(sibling)
    }
}

impl Drop for Sibling {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

/// Drain the child while waiting on its OS handle and cancel signal with zero
/// polling loops. This lets cancellation or timeout kill a child blocked on stdin
/// immediately while freeing successful fast exits of 0–40 ms sleep jitter.
fn run_typst_command(
    mut command: std::process::Command,
    source: &str,
    cancel: Option<&PreviewCancel>,
    timeout: Duration,
) -> Result<(bool, String), String> {
    if cancel.is_some_and(|flag| flag.load(Ordering::Relaxed)) {
        return Err(PREVIEW_SUPERSEDED.into());
    }
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Could not start Typst: {e}"))?;

    let child_exited = Arc::new(AtomicBool::new(false));
    let wake_signal = Arc::new((Mutex::new(false), Condvar::new()));
    let _cancel_guard = cancel.map(|c| c.subscribe(Arc::clone(&wake_signal)));

    #[cfg(windows)]
    let raw_handle = {
        use std::os::windows::io::AsRawHandle;
        child.as_raw_handle() as usize
    };
    #[cfg(unix)]
    let child_pid = child.id();

    std::thread::scope(|scope| {
        let writer = child.stdin.take().map(|mut pipe| {
            scope.spawn(move || {
                use std::io::Write;
                pipe.write_all(source.as_bytes())
            })
        });
        let stdout = child.stdout.take().map(|mut pipe| {
            scope.spawn(move || {
                let _ = std::io::copy(&mut pipe, &mut std::io::sink());
            })
        });
        let stderr = child.stderr.take().map(|mut pipe| {
            scope.spawn(move || {
                let mut bytes = Vec::new();
                let _ = pipe.read_to_end(&mut bytes);
                bytes
            })
        });

        let exited_flag = Arc::clone(&child_exited);
        let wake_on_exit = Arc::clone(&wake_signal);
        let exit_waiter = scope.spawn(move || {
            #[cfg(windows)]
            {
                use windows::Win32::Foundation::HANDLE;
                use windows::Win32::System::Threading::{INFINITE, WaitForSingleObject};
                unsafe {
                    let _ = WaitForSingleObject(HANDLE(raw_handle as *mut _), INFINITE);
                }
            }
            #[cfg(unix)]
            {
                unsafe {
                    let mut info: libc::siginfo_t = std::mem::zeroed();
                    loop {
                        let rc = libc::waitid(
                            libc::P_PID,
                            child_pid as libc::id_t,
                            &mut info,
                            libc::WEXITED | libc::WNOWAIT,
                        );
                        if rc == 0 {
                            break;
                        }
                        if std::io::Error::last_os_error().raw_os_error() != Some(libc::EINTR) {
                            break;
                        }
                    }
                }
            }
            exited_flag.store(true, Ordering::Release);
            let (lock, cvar) = &*wake_on_exit;
            if let Ok(mut woken) = lock.lock() {
                *woken = true;
            }
            cvar.notify_all();
        });

        let deadline = Instant::now() + timeout;
        let outcome: Result<(), String> = {
            let (lock, cvar) = &*wake_signal;
            let mut guard = lock
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            loop {
                if cancel.is_some_and(|flag| flag.load(Ordering::Acquire)) {
                    break Err(PREVIEW_SUPERSEDED.to_string());
                }
                if child_exited.load(Ordering::Acquire) {
                    break Ok(());
                }
                let now = Instant::now();
                if now >= deadline {
                    break Err(format!(
                        "Typst did not finish within {} seconds and was stopped.",
                        timeout.as_secs()
                    ));
                }
                let (next_guard, wait_res) = cvar
                    .wait_timeout(guard, deadline.saturating_duration_since(now))
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                guard = next_guard;
                if wait_res.timed_out()
                    && !child_exited.load(Ordering::Acquire)
                    && cancel.is_none_or(|flag| !flag.load(Ordering::Acquire))
                {
                    break Err(format!(
                        "Typst did not finish within {} seconds and was stopped.",
                        timeout.as_secs()
                    ));
                }
            }
        };

        let status = match outcome {
            Ok(()) => {
                let _ = exit_waiter.join();
                child
                    .wait()
                    .map_err(|error| format!("Could not wait for Typst: {error}"))
            }
            Err(reason) => {
                let _ = child.kill();
                let _ = exit_waiter.join();
                let _ = child.wait();
                Err(reason)
            }
        };

        let written = writer.map(|thread| thread.join());
        let _ = stdout.map(|thread| thread.join());
        let stderr = stderr
            .and_then(|thread| thread.join().ok())
            .unwrap_or_default();
        let status = status?;
        match written {
            Some(Ok(Ok(()))) => {}
            Some(Ok(Err(error))) => {
                return Err(format!("Could not pass the document to Typst: {error}"));
            }
            Some(Err(_)) => return Err("The Typst input task failed.".into()),
            None => return Err("Could not open Typst's input pipe.".into()),
        }
        Ok((
            status.success(),
            String::from_utf8_lossy(&stderr).into_owned(),
        ))
    })
}

/// Turn Typst's stderr into the lines worth showing.
///
/// Diagnostics are multi-line and full of box-drawing guides; a preview banner is
/// not. Only the headline of each diagnostic survives, and the two that describe
/// the exporter itself rather than this document are dropped — they appeared on
/// every single document and would train the reader to ignore the banner.
pub(crate) fn bounded_compiler_output(stderr: &str) -> (String, bool) {
    const LIMIT: usize = 64 * 1024;
    let mut end = stderr.len().min(LIMIT);
    while !stderr.is_char_boundary(end) {
        end -= 1;
    }
    let truncated = end < stderr.len();
    let mut output = stderr[..end].to_owned();
    if truncated {
        output.push_str("\n[Compiler output truncated after 64 KiB]");
    }
    (output, truncated)
}

fn diagnostics(stderr: &str) -> Vec<String> {
    stderr
        .lines()
        .map(str::trim)
        .filter(|line| line.starts_with("warning:") || line.starts_with("error:"))
        .filter(|line| !line.contains("html export is under active development"))
        .map(str::to_string)
        .collect()
}

/// The constructs the document view silently dropped.
///
/// Typst's HTML export cannot represent layout, so `#rect`, `#align`, `#pagebreak`
/// and friends are discarded — with a warning, but no error. If the pane did not
/// say so, it would quietly show less than the document contains.
fn ignored_constructs(warnings: &[String]) -> Vec<String> {
    let mut names: Vec<String> = warnings
        .iter()
        .filter_map(|line| {
            let rest = line.strip_prefix("warning: ")?;
            let name = rest.strip_suffix(" was ignored during HTML export")?;
            Some(name.to_string())
        })
        .collect();
    names.sort();
    names.dedup();
    names
}

fn render_document(
    typst: &FoundTypst,
    root: &Path,
    main_file: Option<&Path>,
    dir: &Path,
    source: &str,
    cancel: Option<&PreviewCancel>,
) -> Result<CompiledTypst, String> {
    let total_t0 = Instant::now();
    let target = render_output(dir, "html");
    let _ = std::fs::remove_file(&target);

    let compile_t0 = Instant::now();
    let compiled = run_typst_with_deps(CliRunOptions {
        binary: &typst.path,
        version: &typst.version,
        root,
        main_file,
        source,
        extra: &["--features", "html", "--format", "html"],
        output: &target,
        deps_dir: Some(dir),
        cancel,
    });
    let typst_compile_ms = compile_t0.elapsed().as_secs_f64() * 1000.0;
    let (ok, stderr, deps) = match compiled {
        Ok(result) => result,
        Err(error) => {
            let _ = std::fs::remove_file(&target);
            return Err(error);
        }
    };
    if !ok {
        let _ = std::fs::remove_file(&target);
        let (message, _) = bounded_compiler_output(&stderr);
        return Err(if message.trim().is_empty() {
            "Typst produced no document view.".to_string()
        } else {
            message
        });
    }

    let page = std::fs::read_to_string(&target);
    let _ = std::fs::remove_file(&target);
    let page = page.map_err(|e| format!("Could not read the rendered document: {e}"))?;

    // The export writes a complete HTML document. The body is taken because it is
    // inserted into the application's own document, so that the preview's
    // typography and colours apply exactly as they do to Markdown — the elements
    // are the same ones: h1–h6, p, strong, em, code, ol, ul, table, math.
    let body = between(&page, "<body", "</body>")
        .map(|s| s.to_string())
        .ok_or_else(|| "The rendered document had no body.".to_string())?;
    // Its stylesheet is kept, because most of it is MathML layout for tabular
    // mathematics, which no browser gets right unaided.
    let css = between(&page, "<style>", "</style>").map(|s| s.to_string());

    let warnings = diagnostics(&stderr);
    let ignored = ignored_constructs(&warnings);

    let (compiler_output, compiler_output_truncated) = bounded_compiler_output(&stderr);
    let total_ms = total_t0.elapsed().as_secs_f64() * 1000.0;
    Ok(CompiledTypst {
        rendered: RenderedTypst {
            compiler_output,
            compiler_output_truncated,
            kind: "document".into(),
            html: Some(body),
            css,
            pdf: None,
            warnings,
            ignored,
            deps,
            page_hashes: Vec::new(),
            first_changed_page: None,
            changed_pages: Vec::new(),
            span_map: Vec::new(),
            timings: Some(TypstTimings {
                typst_compile_ms,
                total_ms,
                ..TypstTimings::default()
            }),
            fell_back_from_document: false,
            backend_kind: Some("cli".into()),
        },
        pdf_bytes: None,
    })
}

/// The text between a start marker and an end marker, with the start marker's own
/// attributes (if any) skipped.
pub(crate) fn between<'a>(haystack: &'a str, start: &str, end: &str) -> Option<&'a str> {
    let from = haystack.find(start)?;
    let after_tag = haystack[from..].find('>')? + from + 1;
    let to = haystack[after_tag..].find(end)? + after_tag;
    Some(&haystack[after_tag..to])
}

fn render_pages(
    typst: &FoundTypst,
    root: &Path,
    main_file: Option<&Path>,
    dir: &Path,
    source: &str,
    cancel: Option<&PreviewCancel>,
    fell_back_from_document: bool,
) -> Result<CompiledTypst, String> {
    let total_t0 = Instant::now();
    let target = render_output(dir, "pdf");
    let _ = std::fs::remove_file(&target);

    // Interactive preview skips accessibility structure tree tagging (`--no-pdf-tags`)
    // for faster emission when supported by the installed CLI (`>= 0.14`), while
    // `compile_to` retains tagged PDFs for archival/print exports.
    let mut extra: Vec<&str> = vec!["--format", "pdf"];
    if supports_cli_version(&typst.version, 0, 14) {
        extra.push("--no-pdf-tags");
    }

    // PDF, not one SVG per page: the PDF carries the text and its positions, so
    // PDF.js can put a selectable text layer over the compiler's layout. The SVG
    // writer turns every glyph into an outline, which is why the old page view
    // could not be selected or clicked.
    let compile_t0 = Instant::now();
    let compiled = run_typst_with_deps(CliRunOptions {
        binary: &typst.path,
        version: &typst.version,
        root,
        main_file,
        source,
        extra: &extra,
        output: &target,
        deps_dir: Some(dir),
        cancel,
    });
    let typst_compile_ms = compile_t0.elapsed().as_secs_f64() * 1000.0;
    let (ok, stderr, deps) = match compiled {
        Ok(result) => result,
        Err(error) => {
            let _ = std::fs::remove_file(&target);
            return Err(error);
        }
    };

    if !ok {
        let _ = std::fs::remove_file(&target);
        let (message, _) = bounded_compiler_output(&stderr);
        return Err(if message.trim().is_empty() {
            "Typst produced no PDF and said nothing.".to_string()
        } else {
            message
        });
    }

    let bytes =
        std::fs::read(&target).map_err(|e| format!("Could not read the rendered pages: {e}"))?;
    let _ = std::fs::remove_file(&target);
    if bytes.is_empty() {
        return Err("Typst produced an empty PDF. The document may be empty.".into());
    }

    let (compiler_output, compiler_output_truncated) = bounded_compiler_output(&stderr);
    let total_ms = total_t0.elapsed().as_secs_f64() * 1000.0;
    Ok(CompiledTypst {
        rendered: RenderedTypst {
            compiler_output,
            compiler_output_truncated,
            kind: "pages".into(),
            html: None,
            css: None,
            pdf: None,
            warnings: diagnostics(&stderr),
            ignored: Vec::new(),
            deps,
            page_hashes: Vec::new(),
            first_changed_page: None,
            changed_pages: Vec::new(),
            span_map: Vec::new(),
            timings: Some(TypstTimings {
                typst_compile_ms,
                total_ms,
                ..TypstTimings::default()
            }),
            fell_back_from_document,
            backend_kind: Some("cli".into()),
        },
        pdf_bytes: Some(bytes),
    })
}

/// Compile a Typst document straight to a file, as Typst itself would.
///
/// Used by the export path: a `.typ` document exported to PDF does not go through
/// pandoc at all, because pandoc would read the Typst and write Typst back out,
/// keeping the words and losing the page.
pub fn compile_to<R: Runtime>(
    app: &AppHandle<R>,
    document_path: Option<&str>,
    source: &str,
    format: &str,
    target: &Path,
    image_root: Option<&str>,
) -> Result<(), String> {
    let typst = find_typst(app).ok_or_else(|| {
        "Typst is not installed, so this cannot be exported as PDF. Use Help › Install Typst."
            .to_string()
    })?;

    let fallback = std::env::temp_dir().join("mdraft-typst");
    let root = workspace_root(
        document_path.map(Path::new).and_then(Path::parent),
        image_root,
        &fallback,
    );
    let main_file = document_path
        .map(Path::new)
        .filter(|file| file.parent().is_some_and(Path::is_dir));

    let mut extra: Vec<&str> = Vec::new();
    if format == "html" {
        // Typst's HTML writer refuses to run without being asked for explicitly.
        extra.extend(["--features", "html"]);
    }
    extra.extend(["--format", format]);

    let (ok, stderr) = run_typst(&typst.path, &root, main_file, source, &extra, target, None)?;
    if !ok {
        let message: Vec<&str> = stderr
            .lines()
            .filter(|line| !line.trim().is_empty())
            .take(20)
            .collect();
        return Err(if message.is_empty() {
            format!("Typst exited without explaining why it could not write {format}.")
        } else {
            message.join("\n")
        });
    }
    Ok(())
}

fn render<R: Runtime>(
    app: &AppHandle<R>,
    document_path: Option<&str>,
    source: &str,
    mode: &str,
    image_root: Option<&str>,
    cancel: Option<&PreviewCancel>,
) -> Result<CompiledTypst, String> {
    let dir = std::env::temp_dir().join("mdraft-typst");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Could not create {}: {e}", dir.display()))?;

    // `--root` bounds what the document may read. Pointing it at the document's
    // own folder is what lets `#image("img/plot.png")` resolve; an untitled
    // document has no folder, so the temporary directory serves. A custom image
    // folder elsewhere on the same volume widens the root to the common
    // ancestor, because Typst accepts one root and would otherwise refuse the
    // image the reader explicitly asked to copy there.
    let root = workspace_root(
        document_path.map(Path::new).and_then(Path::parent),
        image_root,
        &dir,
    );
    let main_file = document_path
        .map(Path::new)
        .filter(|file| file.parent().is_some_and(Path::is_dir));

    if let Some(service_result) = service::try_render(
        app,
        service::RenderRequest {
            root: &root,
            main_file,
            source,
            mode,
            cancel,
        },
    ) {
        return service_result;
    }

    let typst = find_typst(app).ok_or_else(|| {
        format!(
            "Typst is not installed, so .typ documents cannot be previewed. \
             Install it via Tools › Check or Install Typst... or manually from {DOWNLOAD_PAGE}."
        )
    })?;

    if mode == "pages" {
        return render_pages(&typst, &root, main_file, &dir, source, cancel, false);
    }

    match render_document(&typst, &root, main_file, &dir, source, cancel) {
        Ok(rendered) => Ok(rendered),
        Err(failure) => {
            // A cancelled compile must not start a second process just to be
            // cancelled again; the frontend has already moved to a newer edit.
            if cancel.is_some_and(|flag| flag.load(Ordering::Relaxed)) {
                return Err(failure);
            }
            // The document view is experimental and refuses some documents
            // outright. Falling back keeps the pane useful, and says why.
            let mut fallback =
                render_pages(&typst, &root, main_file, &dir, source, cancel, true)?;
            fallback
                .rendered
                .warnings
                .insert(0, format!("The document view was unavailable ({failure})."));
            Ok(fallback)
        }
    }
}

/// The directory `--root` should point at.
///
/// Typst accepts a single root, so an image in a custom folder outside the
/// document's folder is unreachable. The smallest widening that covers both is
/// their deepest common ancestor. When the two do not share a volume (or the
/// folder cannot be resolved) the document's folder wins, and the frontend
/// says the compiler cannot reach the image rather than pretending it can.
fn workspace_root(
    document_dir: Option<&Path>,
    image_root: Option<&str>,
    fallback: &Path,
) -> PathBuf {
    let Some(document_dir) = document_dir.filter(|path| path.is_dir()) else {
        return fallback.to_path_buf();
    };
    let Some(image_root) = image_root.map(Path::new).filter(|path| path.is_dir()) else {
        return document_dir.to_path_buf();
    };
    common_ancestor(document_dir, image_root).unwrap_or_else(|| document_dir.to_path_buf())
}

fn common_ancestor(document_dir: &Path, image_root: &Path) -> Option<PathBuf> {
    let images = image_root.canonicalize().ok()?;
    let mut candidate = document_dir.to_path_buf();
    loop {
        let canonical = candidate.canonicalize().ok()?;
        if is_within(&images, &canonical) {
            return Some(candidate);
        }
        let parent = candidate.parent()?.to_path_buf();
        if parent == candidate {
            return None;
        }
        candidate = parent;
    }
}

fn is_within(child: &Path, ancestor: &Path) -> bool {
    #[cfg(windows)]
    {
        // Windows paths compare case-insensitively, and a document under
        // `C:\Users\reader` must still contain `c:\users\reader\Pictures`.
        let child = child.to_string_lossy().to_lowercase();
        let ancestor = ancestor.to_string_lossy().to_lowercase();
        let ancestor = ancestor.trim_end_matches('\\');
        child == ancestor || child.starts_with(&format!("{ancestor}\\"))
    }
    #[cfg(not(windows))]
    {
        child.starts_with(ancestor)
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
#[cfg(test)]
mod tests {
    #[test]
    fn compiler_output_is_bounded_without_splitting_utf8() {
        let text = format!("{}é", "a".repeat(65535));
        let (output, truncated) = super::bounded_compiler_output(&text);
        assert!(truncated);
        assert!(output.starts_with(&"a".repeat(65535)));
        assert!(output.contains("Compiler output truncated"));
        let (output, truncated) = super::bounded_compiler_output("");
        assert_eq!(output, "");
        assert!(!truncated);
        let text = "warning: example\n".repeat(30);
        assert_eq!(super::bounded_compiler_output(&text), (text, false));
    }

    use super::*;

    #[test]
    fn a_version_line_is_read_the_way_typst_prints_it() {
        // "typst 0.15.1 (9dfd3a08)" is what 0.15.1 prints; the hash is ignored.
        let line = "typst 0.15.1 (9dfd3a08)";
        let mut parts = line.split_whitespace();
        assert_eq!(parts.next(), Some("typst"));
        assert_eq!(parts.next(), Some("0.15.1"));
    }

    #[test]
    fn a_new_preview_cancels_only_the_older_compile() {
        let key = "unit-preview-cancel";
        let first = begin_preview(key, 1);
        assert!(!first.load(Ordering::Relaxed));
        let second = begin_preview(key, 2);
        assert!(first.load(Ordering::Relaxed));
        assert!(!second.load(Ordering::Relaxed));
        // A late finish of the first token must not remove the newer entry.
        end_preview(key, 1);
        let third = begin_preview(key, 3);
        assert!(second.load(Ordering::Relaxed));
        assert!(!third.load(Ordering::Relaxed));
        end_preview(key, 3);
    }

    #[test]
    fn an_older_preview_cannot_replace_a_newer_generation() {
        let key = "unit-preview-out-of-order";
        let newest = begin_preview(key, 5);
        let older = begin_preview(key, 4);
        assert!(older.load(Ordering::Relaxed));
        assert!(!newest.load(Ordering::Relaxed));
        let next = begin_preview(key, 6);
        assert!(newest.load(Ordering::Relaxed));
        assert!(!next.load(Ordering::Relaxed));
        end_preview(key, 6);
    }

    #[test]
    fn cancellation_respects_the_generation_watermark() {
        let key = "unit-preview-watermark";
        let current = begin_preview(key, 10);
        cancel_preview(key, 9).unwrap();
        assert!(!current.load(Ordering::Relaxed));
        cancel_preview(key, 10).unwrap();
        assert!(current.load(Ordering::Relaxed));
        let late = begin_preview(key, 10);
        assert!(late.load(Ordering::Relaxed));
        let next = begin_preview(key, 11);
        assert!(!next.load(Ordering::Relaxed));
        cancel_preview(key, 10).unwrap();
        assert!(!next.load(Ordering::Relaxed));
        end_preview(key, 11);
        let late_after_finish = begin_preview(key, 10);
        assert!(late_after_finish.load(Ordering::Relaxed));
    }

    #[test]
    fn simultaneous_renders_get_distinct_output_paths() {
        let dir = Path::new("audit-typst-scratch");
        let first = render_output(dir, "html");
        let second = render_output(dir, "html");
        let pages = render_output(dir, "pdf");
        assert_ne!(first, second);
        assert_ne!(first, pages);
        assert_eq!(first.parent(), Some(dir));
        assert_eq!(
            pages.extension().and_then(|value| value.to_str()),
            Some("pdf")
        );
    }

    /// The parent test launches this one in a child test process. With no
    /// marker it is a no-op in an ordinary suite run.
    #[test]
    fn fake_typst_stalls_without_reading() {
        if std::env::var_os("MDRAFT_TEST_TYPST_STALL").is_some() {
            std::thread::sleep(Duration::from_secs(5));
        }
    }

    #[test]
    fn cancellation_interrupts_a_child_blocked_on_stdin() {
        let mut command = std::process::Command::new(std::env::current_exe().unwrap());
        command
            .arg("--exact")
            .arg("typst::tests::fake_typst_stalls_without_reading")
            .arg("--nocapture")
            .env("MDRAFT_TEST_TYPST_STALL", "1");
        let flag = Arc::new(PreviewCancel::new(false));
        let signal = flag.clone();
        let canceller = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(150));
            signal.cancel();
        });
        let source = "x".repeat(2 * 1024 * 1024);
        let started = std::time::Instant::now();
        let result = run_typst_command(command, &source, Some(&flag), Duration::from_secs(5));
        canceller.join().unwrap();
        assert_eq!(result.unwrap_err(), PREVIEW_SUPERSEDED);
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn timeout_interrupts_a_child_blocked_on_stdin() {
        let mut command = std::process::Command::new(std::env::current_exe().unwrap());
        command
            .arg("--exact")
            .arg("typst::tests::fake_typst_stalls_without_reading")
            .arg("--nocapture")
            .env("MDRAFT_TEST_TYPST_STALL", "1");
        let source = "x".repeat(2 * 1024 * 1024);
        let started = std::time::Instant::now();
        let result = run_typst_command(command, &source, None, Duration::from_millis(150));
        assert!(result.unwrap_err().contains("was stopped"));
        assert!(started.elapsed() < Duration::from_secs(3));
    }

    #[test]
    fn a_widened_root_compiles_a_sibling_that_is_removed_afterwards() {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("typst-sibling-test");
        std::fs::create_dir_all(&dir).unwrap();
        let path = {
            let sibling = Sibling::write(&dir.join("chapter.typ"), "= Chapter").unwrap();
            assert_eq!(sibling.document_name, "chapter.typ");
            assert!(sibling.name.starts_with(".mdraft-preview-"));
            assert_eq!(std::fs::read_to_string(&sibling.path).unwrap(), "= Chapter");
            sibling.path.clone()
        };
        assert!(!path.exists(), "the sibling must not outlive its compile");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn fake_typst_closes_stdin_without_reading() {}

    #[test]
    fn a_child_that_closes_stdin_reports_the_failed_write() {
        let mut command = std::process::Command::new(std::env::current_exe().unwrap());
        command
            .arg("--exact")
            .arg("typst::tests::fake_typst_closes_stdin_without_reading")
            .arg("--nocapture");
        let source = "x".repeat(2 * 1024 * 1024);
        let result = run_typst_command(command, &source, None, Duration::from_secs(5));
        assert!(
            result
                .unwrap_err()
                .contains("Could not pass the document to Typst")
        );
    }

    #[test]
    fn the_archive_name_matches_what_github_publishes() {
        // Pinned because the asset name is a promise between two projects: if
        // Typst renames it, the installer fails with "no build called ..." and
        // this test is the reminder of what it used to be.
        if cfg!(all(windows, target_arch = "x86_64")) {
            assert_eq!(release_asset(), Some("typst-x86_64-pc-windows-msvc.zip"));
        }
        if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
            assert_eq!(
                release_asset(),
                Some("typst-x86_64-unknown-linux-musl.tar.xz")
            );
        }
        if cfg!(all(target_os = "linux", target_arch = "aarch64")) {
            assert_eq!(
                release_asset(),
                Some("typst-aarch64-unknown-linux-musl.tar.xz")
            );
        }
    }

    #[test]
    fn automatic_installation_is_available_where_a_single_executable_is_published() {
        let expected = (cfg!(windows) || cfg!(target_os = "linux"))
            && (cfg!(target_arch = "x86_64") || cfg!(target_arch = "aarch64"));
        assert_eq!(release_asset().is_some(), expected);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn the_linux_archive_reader_finds_the_typst_member() {
        let payload = b"#!/bin/sh\necho 'typst 9.9.9'\n";
        let mut tar_bytes = Vec::new();
        {
            let mut builder = tar::Builder::new(&mut tar_bytes);
            let mut header = tar::Header::new_gnu();
            header.set_size(payload.len() as u64);
            header.set_mode(0o755);
            header.set_cksum();
            builder
                .append_data(
                    &mut header,
                    "typst-x86_64-unknown-linux-musl/typst",
                    &payload[..],
                )
                .unwrap();
            builder.finish().unwrap();
        }

        let mut xz = Vec::new();
        lzma_rs::xz_compress(&mut std::io::Cursor::new(&tar_bytes), &mut xz).unwrap();

        assert_eq!(extract_named_binary(&xz, "typst").unwrap(), payload.to_vec());
    }

    #[test]
    fn cli_version_feature_gates_respect_minimums() {
        assert!(supports_cli_version("0.15.1", 0, 14));
        assert!(supports_cli_version("0.14.0", 0, 14));
        assert!(!supports_cli_version("0.13.1", 0, 14));
        assert!(supports_cli_version("0.13.0", 0, 13));
        assert!(supports_cli_version("1.0.0", 0, 14));
        assert!(!supports_cli_version("", 0, 13));
    }

    #[test]
    fn parse_deps_json_skips_stdin_and_sibling_and_stats_real_inputs() {
        let dir = std::env::temp_dir().join(format!("mdraft_typst_deps_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let img = dir.join("diagram.png");
        let sibling = dir.join(".mdraft-preview-1.typ");
        std::fs::write(&img, b"png-bytes").unwrap();
        std::fs::write(&sibling, b"= Ignore").unwrap();

        let verbatim = format!(r"\\?\{}", img.display());
        let raw = serde_json::json!({
            "inputs": ["<stdin>", sibling.to_string_lossy(), verbatim, img.to_string_lossy()],
            "outputs": []
        })
        .to_string();

        let parsed = parse_deps_json(&raw, Some(&sibling));
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].path, img.to_string_lossy());
        assert_eq!(parsed[0].size, 9);
        assert!(parsed[0].mtime_ms > 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn frame_binary_response_prefixes_json_length_and_appends_raw_pdf() {
        let meta = RenderedTypst {
            compiler_output: String::new(),
            compiler_output_truncated: false,
            kind: "pages".into(),
            html: None,
            css: None,
            pdf: None,
            warnings: vec![],
            ignored: vec![],
            deps: vec![],
            page_hashes: vec!["abc".into()],
            first_changed_page: Some(1),
            changed_pages: vec![1],
            span_map: vec![],
            timings: None,
            fell_back_from_document: false,
            backend_kind: Some("service".into()),
        };
        let pdf = b"%PDF-1.7\nbinary";
        let framed = frame_binary_response(&meta, pdf).unwrap();
        let meta_len = u32::from_be_bytes([framed[0], framed[1], framed[2], framed[3]]) as usize;
        let json: serde_json::Value = serde_json::from_slice(&framed[4..4 + meta_len]).unwrap();
        assert_eq!(json["kind"], "pages");
        assert_eq!(json["pageHashes"][0], "abc");
        assert_eq!(&framed[4 + meta_len..], pdf);
    }

    /// The installer talks to a live service whose asset naming, digest field
    /// and archive layout are all outside our control. Any of the three can
    /// change without notice, and the failure would only surface the first time
    /// a user pressed the button — so this exercises the real contract.
    ///
    /// Ignored by default because it downloads about 18 MB:
    ///
    /// ```text
    /// cargo test -- --ignored --nocapture downloading_typst
    /// ```
    #[test]
    #[ignore = "downloads ~18 MB from GitHub"]
    fn downloading_typst_yields_a_runnable_binary() {
        let (tag, binary) =
            download_binary(&http_agent()).expect("the installer contract still holds");
        assert!(!tag.is_empty(), "the release has no tag");
        assert!(
            binary.len() > 1_000_000,
            "the extracted binary is only {} bytes, which cannot be Typst",
            binary.len()
        );
        // A zip starts with "PK"; anything else means we unpacked a README or a
        // directory entry by mistake.
        assert_ne!(&binary[..2], b"PK", "extracted an archive, not the binary");

        let dir = std::env::temp_dir().join("mdraft-typst-contract");
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join(typst_exe());
        std::fs::write(&path, &binary).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }

        let version = probe_version(&path).expect("the downloaded Typst did not run");
        assert!(
            version.chars().next().is_some_and(|c| c.is_ascii_digit()),
            "unexpected version {version:?}"
        );
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn the_root_widens_to_the_common_ancestor_of_the_image_folder() {
        let base = std::env::temp_dir().join(format!("tt-typst-root-{}", std::process::id()));
        let notes = base.join("notes");
        let pictures = base.join("pictures");
        std::fs::create_dir_all(&notes).unwrap();
        std::fs::create_dir_all(&pictures).unwrap();

        assert_eq!(
            workspace_root(Some(&notes), Some(&pictures.to_string_lossy()), &base),
            base,
            "the smallest root that covers both is their parent"
        );

        let inside = notes.join("media");
        std::fs::create_dir_all(&inside).unwrap();
        assert_eq!(
            workspace_root(Some(&notes), Some(&inside.to_string_lossy()), &base),
            notes,
            "a folder inside the document needs no widening"
        );

        let missing = base.join("missing");
        assert_eq!(
            workspace_root(Some(&notes), Some(&missing.to_string_lossy()), &base),
            notes,
            "a folder that does not exist cannot widen the root"
        );

        assert_eq!(
            workspace_root(None, Some(&pictures.to_string_lossy()), &base),
            base,
            "an untitled document keeps the temporary fallback"
        );

        let _ = std::fs::remove_dir_all(&base);
    }

    #[cfg(windows)]
    #[test]
    fn the_root_comparison_ignores_case_on_windows() {
        let base = std::env::temp_dir().join(format!("tt-typst-case-{}", std::process::id()));
        let notes = base.join("Notes");
        std::fs::create_dir_all(&notes).unwrap();
        let lower = PathBuf::from(notes.to_string_lossy().to_lowercase());
        assert!(is_within(&notes, &lower));
        assert!(is_within(&lower, &notes));
        let _ = std::fs::remove_dir_all(&base);
    }
}
