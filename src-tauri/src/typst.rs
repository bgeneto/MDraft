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

use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime};

use crate::export::{quiet, sha256_hex, which};

/// Where the official downloads live. Shown whenever something has to be done by
/// hand, because it is the page that stays correct across releases.
pub const DOWNLOAD_PAGE: &str = "https://typst.app/open-source/#download";

const RELEASE_API: &str = "https://api.github.com/repos/typst/typst/releases/latest";
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(600);
/// A preview that takes longer than this is a runaway document, not a big one.
const RENDER_TIMEOUT: Duration = Duration::from_secs(60);
const PREVIEW_SUPERSEDED: &str = "Typst render was superseded by a newer edit.";

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

/// The newest preview compile per window, and the flag that stops the previous
/// one. A Typst compile is a whole process; ignoring a stale result is not
/// enough when the next keystroke has already asked for another one.
type PreviewFlag = Arc<AtomicBool>;
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
    let flag = Arc::new(AtomicBool::new(false));
    if let Ok(mut flags) = preview_flags().lock() {
        let state = flags.entry(key.to_string()).or_default();
        if state.latest.is_some_and(|latest| token <= latest) {
            flag.store(true, Ordering::Relaxed);
            return flag;
        }
        if let Some((_, previous)) = &state.active {
            previous.store(true, Ordering::Relaxed);
        }
        state.latest = Some(token);
        state.active = Some((token, flag.clone()));
    } else {
        // A poisoned registry cannot establish ownership safely.
        flag.store(true, Ordering::Relaxed);
    }
    flag
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
        flag.store(true, Ordering::Relaxed);
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

    Ok((release.tag_name, extract_binary(&archive)?))
}

#[tauri::command]
pub async fn install_typst<R: Runtime>(app: AppHandle<R>) -> Result<TypstStatus, String> {
    tauri::async_runtime::spawn_blocking(move || install(&app))
        .await
        .map_err(|e| format!("The install task could not be started: {e}"))?
}

fn install<R: Runtime>(app: &AppHandle<R>) -> Result<TypstStatus, String> {
    let (tag, binary) = download_binary(&http_agent())?;

    let root = managed_root(app).ok_or_else(|| {
        "The application could not work out where to put Typst, so it was not installed.".to_string()
    })?;
    let version = tag.trim_start_matches('v').to_string();
    let dir = root.join(&version);
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    let target = dir.join(typst_exe());
    std::fs::write(&target, &binary)
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

/// Read `typst.exe` out of the release zip.
#[cfg(any(target_os = "windows", target_os = "macos"))]
fn extract_binary(archive: &[u8]) -> Result<Vec<u8>, String> {
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
        if name.ends_with("typst.exe") || name.ends_with("/typst") {
            found = Some((index, name));
            break;
        }
    }

    let (index, name) = found.ok_or_else(|| {
        "The downloaded archive did not contain a typst binary. Its layout may have changed."
            .to_string()
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

/// Read the `typst` member out of the Linux release tarball.
///
/// The xz stream is decoded in memory with the pure-Rust `lzma-rs`, so no system
/// `xz` binary or `liblzma` is involved. Only the matching member's bytes are
/// kept: nothing is unpacked to disk and the entry's path is never used to
/// construct a destination.
#[cfg(target_os = "linux")]
fn extract_binary(archive: &[u8]) -> Result<Vec<u8>, String> {
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
        if path.file_name().and_then(|n| n.to_str()) != Some("typst") {
            continue;
        }
        let mut bytes = Vec::new();
        entry
            .read_to_end(&mut bytes)
            .map_err(|e| format!("Could not read the Typst binary: {e}"))?;
        if !bytes.is_empty() {
            return Ok(bytes);
        }
    }
    Err("The downloaded archive did not contain a typst binary. Its layout may have changed."
        .to_string())
}

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
fn extract_binary(_archive: &[u8]) -> Result<Vec<u8>, String> {
    Err("Automatic installation is not implemented on this platform.".into())
}

// ---------------------------------------------------------------------------
// Rendering a preview
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderedTypst {
    /// `"document"` when the pane should show flowing HTML, `"pages"` when it
    /// should show the compiler's PDF pages.
    pub kind: String,
    /// Body markup, when `kind` is `"document"`.
    pub html: Option<String>,
    /// The export's own stylesheet. Most of it is MathML layout: browsers get
    /// alignment inside tabular mathematics wrong without it.
    pub css: Option<String>,
    /// Base64-encoded PDF, when `kind` is `"pages"`.
    ///
    /// The PDF is the compiler's own layout. PDF.js draws it and supplies the
    /// text layer; the alternative, one SVG per page, drew every glyph as an
    /// outline and made the page impossible to select or click.
    pub pdf: Option<String>,
    /// Warnings worth showing. Not errors: a document with warnings still renders.
    pub warnings: Vec<String>,
    /// Constructs the document view dropped, by name. Its HTML export cannot
    /// express layout, so `#rect`, `#align` and `#pagebreak` are discarded
    /// silently apart from a warning — which the pane has to surface, or it
    /// quietly shows less than the document contains.
    pub ignored: Vec<String>,
}

/// Compile a Typst document for the preview pane.
///
/// Two views, because neither is good enough alone.
///
/// The **document** view is Typst's own HTML export. It produces plain semantic
/// HTML — `h2`, `p`, `strong`, `em`, `code`, `ol`, `table`, MathML — with no
/// classes, which is the same element set the Markdown preview already styles, so
/// the pane's typography, colours and width apply unchanged and the text reflows
/// and can be selected. The cost is that it is marked experimental by upstream and
/// it cannot represent layout at all: page size, `#align`, boxes and page breaks
/// are dropped, each with a warning that this code collects so the pane can say so.
///
/// The **pages** view renders the real pages to PDF. It is always faithful, and it
/// is the only way to see what an export will print; PDF.js draws it and supplies
/// the selectable text layer, so the page can be read, copied and clicked without
/// becoming a second layout engine.
///
/// The source arrives as a string and is piped in on stdin rather than written to
/// a file next to the user's document. Verified equivalent for both formats: an
/// `#include` and an `#image` resolve exactly as they do when the file is compiled
/// directly, as long as `--root` points at the document's directory.
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

/// Run Typst once, feeding the document on stdin.
///
/// Returns `(succeeded, stderr)`. stdout is drained and discarded: with `-` as the
/// input and an output path given, Typst writes only the file, and reading both
/// pipes on their own threads is what keeps a chatty document from deadlocking on
/// a full pipe buffer.
fn run_typst(
    binary: &Path,
    root: &Path,
    source: &str,
    extra: &[&str],
    output: &Path,
    cancel: Option<&AtomicBool>,
) -> Result<(bool, String), String> {
    let mut command = std::process::Command::new(binary);
    quiet(&mut command)
        .arg("compile")
        .args(extra)
        .arg("--root")
        .arg(root)
        .arg("-")
        .arg(output)
        .current_dir(root);
    run_typst_command(command, source, cancel, RENDER_TIMEOUT)
}

/// Drain the child while stdin is written on a separate scoped thread. This
/// lets a cancellation or timeout kill a child that stopped reading a large
/// buffer, and avoids copying the whole source merely to move it to a thread.
fn run_typst_command(
    mut command: std::process::Command,
    source: &str,
    cancel: Option<&AtomicBool>,
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

        let deadline = std::time::Instant::now() + timeout;
        let outcome = loop {
            if cancel.is_some_and(|flag| flag.load(Ordering::Relaxed)) {
                let _ = child.kill();
                let _ = child.wait();
                break Err(PREVIEW_SUPERSEDED.to_string());
            }
            if std::time::Instant::now() >= deadline {
                let _ = child.kill();
                let _ = child.wait();
                break Err(format!(
                    "Typst did not finish within {} seconds and was stopped.",
                    timeout.as_secs()
                ));
            }
            match child.try_wait() {
                Ok(Some(status)) => break Ok(status),
                Ok(None) => std::thread::sleep(Duration::from_millis(40)),
                Err(error) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    break Err(format!("Could not wait for Typst: {error}"));
                }
            }
        };

        let written = writer.map(|thread| thread.join());
        let _ = stdout.map(|thread| thread.join());
        let stderr = stderr
            .and_then(|thread| thread.join().ok())
            .unwrap_or_default();
        let status = outcome?;
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
    binary: &Path,
    root: &Path,
    dir: &Path,
    source: &str,
    cancel: Option<&AtomicBool>,
) -> Result<RenderedTypst, String> {
    let target = render_output(dir, "html");
    let _ = std::fs::remove_file(&target);

    let compiled = run_typst(
        binary,
        root,
        source,
        &["--features", "html", "--format", "html"],
        &target,
        cancel,
    );
    let (ok, stderr) = match compiled {
        Ok(result) => result,
        Err(error) => {
            let _ = std::fs::remove_file(&target);
            return Err(error);
        }
    };
    if !ok {
        let _ = std::fs::remove_file(&target);
        let message: Vec<String> = stderr
            .lines()
            .filter(|line| !line.trim().is_empty())
            .take(20)
            .map(str::to_string)
            .collect();
        return Err(if message.is_empty() {
            "Typst produced no document view.".to_string()
        } else {
            message.join("\n")
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

    Ok(RenderedTypst {
        kind: "document".into(),
        html: Some(body),
        css,
        pdf: None,
        warnings,
        ignored,
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
    binary: &Path,
    root: &Path,
    dir: &Path,
    source: &str,
    cancel: Option<&AtomicBool>,
) -> Result<RenderedTypst, String> {
    let target = render_output(dir, "pdf");
    let _ = std::fs::remove_file(&target);

    // PDF, not one SVG per page: the PDF carries the text and its positions, so
    // PDF.js can put a selectable text layer over the compiler's layout. The SVG
    // writer turns every glyph into an outline, which is why the old page view
    // could not be selected or clicked.
    let compiled = run_typst(binary, root, source, &["--format", "pdf"], &target, cancel);
    let (ok, stderr) = match compiled {
        Ok(result) => result,
        Err(error) => {
            let _ = std::fs::remove_file(&target);
            return Err(error);
        }
    };

    if !ok {
        let _ = std::fs::remove_file(&target);
        let message: Vec<&str> = stderr
            .lines()
            .filter(|line| !line.trim().is_empty())
            .take(20)
            .collect();
        return Err(if message.is_empty() {
            "Typst produced no PDF and said nothing.".to_string()
        } else {
            message.join("\n")
        });
    }

    let bytes =
        std::fs::read(&target).map_err(|e| format!("Could not read the rendered pages: {e}"))?;
    let _ = std::fs::remove_file(&target);
    if bytes.is_empty() {
        return Err("Typst produced an empty PDF. The document may be empty.".into());
    }

    Ok(RenderedTypst {
        kind: "pages".into(),
        html: None,
        css: None,
        pdf: Some(BASE64.encode(bytes)),
        warnings: diagnostics(&stderr),
        ignored: Vec::new(),
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

    let mut extra: Vec<&str> = Vec::new();
    if format == "html" {
        // Typst's HTML writer refuses to run without being asked for explicitly.
        extra.extend(["--features", "html"]);
    }
    extra.extend(["--format", format]);

    let (ok, stderr) = run_typst(&typst.path, &root, source, &extra, target, None)?;
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
    cancel: Option<&AtomicBool>,
) -> Result<RenderedTypst, String> {
    let typst = find_typst(app).ok_or_else(|| {
        format!(
            "Typst is not installed, so .typ documents cannot be previewed. \
             Install it via Help › Install Typst... or manually from {DOWNLOAD_PAGE}."
        )
    })?;

    let dir = std::env::temp_dir().join("mdraft-typst");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;

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

    if mode == "pages" {
        return render_pages(&typst.path, &root, &dir, source, cancel);
    }

    match render_document(&typst.path, &root, &dir, source, cancel) {
        Ok(rendered) => Ok(rendered),
        Err(failure) => {
            // A cancelled compile must not start a second process just to be
            // cancelled again; the frontend has already moved to a newer edit.
            if cancel.is_some_and(|flag| flag.load(Ordering::Relaxed)) {
                return Err(failure);
            }
            // The document view is experimental and refuses some documents
            // outright. Falling back keeps the pane useful, and says why.
            let mut fallback = render_pages(&typst.path, &root, &dir, source, cancel)?;
            fallback
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
        let flag = Arc::new(AtomicBool::new(false));
        let signal = flag.clone();
        let canceller = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(150));
            signal.store(true, Ordering::Relaxed);
        });
        let source = "x".repeat(2 * 1024 * 1024);
        let started = std::time::Instant::now();
        let result = run_typst_command(command, &source, Some(&flag), Duration::from_secs(5));
        canceller.join().unwrap();
        assert_eq!(result.unwrap_err(), PREVIEW_SUPERSEDED);
        assert!(started.elapsed() < Duration::from_secs(3));
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

        assert_eq!(extract_binary(&xz).unwrap(), payload.to_vec());
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
