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

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime};

use crate::export::{quiet, which};

/// Where the official downloads live. Shown whenever something has to be done by
/// hand, because it is the page that stays correct across releases.
pub const DOWNLOAD_PAGE: &str = "https://typst.app/open-source/#download";

const RELEASE_API: &str = "https://api.github.com/repos/typst/typst/releases/latest";
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(600);
/// A preview that takes longer than this is a runaway document, not a big one.
const RENDER_TIMEOUT: Duration = Duration::from_secs(60);

/// Concurrent previews share the temporary directory; each PDF gets its own name
/// so a slow render cannot be overwritten by the next keystroke.
static NEXT_PDF: AtomicU64 = AtomicU64::new(0);

pub fn typst_exe() -> &'static str {
    if cfg!(windows) { "typst.exe" } else { "typst" }
}

/// The archive GitHub publishes for this platform, when automatic installation
/// is possible.
///
/// Only Windows. Linux and macOS ship `.tar.xz`, and unpacking those would mean
/// pulling in an xz decoder — dependencies this project does not otherwise need —
/// for a platform where `cargo install typst-cli`, `apt install typst` and
/// `brew install typst` all work. The install command says so instead of failing
/// obscurely.
fn release_asset() -> Option<&'static str> {
    const X86: Option<&str> = if cfg!(all(windows, target_arch = "x86_64")) {
        Some("typst-x86_64-pc-windows-msvc.zip")
    } else if cfg!(all(windows, target_arch = "aarch64")) {
        Some("typst-aarch64-pc-windows-msvc.zip")
    } else {
        None
    };
    X86
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
}

#[tauri::command]
pub async fn install_typst<R: Runtime>(app: AppHandle<R>) -> Result<TypstStatus, String> {
    tauri::async_runtime::spawn_blocking(move || install(&app))
        .await
        .map_err(|e| format!("The install task could not be started: {e}"))?
}

fn install<R: Runtime>(app: &AppHandle<R>) -> Result<TypstStatus, String> {
    let asset = release_asset().ok_or_else(|| {
        format!(
            "Typst cannot be installed automatically on this platform. Download it from \
             {DOWNLOAD_PAGE}, or install it with your package manager, and it will be picked up \
             from PATH."
        )
    })?;

    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(DOWNLOAD_TIMEOUT))
        .user_agent(concat!("MDraft/", env!("CARGO_PKG_VERSION")))
        .build()
        .into();

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

    let archive = agent
        .get(&chosen.browser_download_url)
        .call()
        .map_err(|e| format!("Could not download Typst: {e}"))?
        .body_mut()
        .with_config()
        .limit(256 * 1024 * 1024)
        .read_to_vec()
        .map_err(|e| format!("Could not read the download: {e}"))?;

    let binary = extract_binary(&archive)?;

    let root = managed_root(app).ok_or_else(|| {
        "The application could not work out where to put Typst, so it was not installed.".to_string()
    })?;
    let version = release.tag_name.trim_start_matches('v').to_string();
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

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
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
) -> Result<RenderedTypst, String> {
    let mode = mode.unwrap_or_else(|| "document".into());
    tauri::async_runtime::spawn_blocking(move || render(&app, path.as_deref(), &source, &mode))
        .await
        .map_err(|e| format!("The Typst render task could not be started: {e}"))?
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
) -> Result<(bool, String), String> {
    let mut child = {
        let mut command = std::process::Command::new(binary);
        quiet(&mut command)
            .arg("compile")
            .args(extra)
            .arg("--root")
            .arg(root)
            .arg("-")
            .arg(output)
            .current_dir(root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        command.spawn().map_err(|e| format!("Could not start Typst: {e}"))?
    };

    if let Some(mut stdin) = child.stdin.take() {
        use std::io::Write;
        stdin
            .write_all(source.as_bytes())
            .map_err(|e| format!("Could not pass the document to Typst: {e}"))?;
    }

    let stdout_thread = child.stdout.take().map(|mut pipe| {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = pipe.read_to_end(&mut buf);
            buf
        })
    });
    let stderr_thread = child.stderr.take().map(|mut pipe| {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = pipe.read_to_end(&mut buf);
            buf
        })
    });

    let deadline = std::time::Instant::now() + RENDER_TIMEOUT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    // A document that never finishes would otherwise wedge a
                    // worker thread for the life of the process, and the next
                    // keystroke would start another one.
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!(
                        "Typst did not finish within {} seconds and was stopped.",
                        RENDER_TIMEOUT.as_secs()
                    ));
                }
                std::thread::sleep(Duration::from_millis(40));
            }
            Err(e) => return Err(format!("Could not wait for Typst: {e}")),
        }
    };

    let _ = stdout_thread.map(|t| t.join());
    let stderr = stderr_thread
        .map(|t| t.join().unwrap_or_default())
        .unwrap_or_default();
    Ok((status.success(), String::from_utf8_lossy(&stderr).into_owned()))
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
) -> Result<RenderedTypst, String> {
    let target = dir.join("document.html");
    let _ = std::fs::remove_file(&target);

    let (ok, stderr) = run_typst(
        binary,
        root,
        source,
        &["--features", "html", "--format", "html"],
        &target,
    )?;
    if !ok {
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

    let page = std::fs::read_to_string(&target)
        .map_err(|e| format!("Could not read the rendered document: {e}"))?;

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
) -> Result<RenderedTypst, String> {
    let target = dir.join(format!(
        "pages-{}-{}.pdf",
        std::process::id(),
        NEXT_PDF.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = std::fs::remove_file(&target);

    // PDF, not one SVG per page: the PDF carries the text and its positions, so
    // PDF.js can put a selectable text layer over the compiler's layout. The SVG
    // writer turns every glyph into an outline, which is why the old page view
    // could not be selected or clicked.
    let (ok, stderr) = run_typst(binary, root, source, &["--format", "pdf"], &target)?;

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
) -> Result<(), String> {
    let typst = find_typst(app).ok_or_else(|| {
        format!("Typst is not installed, so this cannot be exported as PDF. Use Help › Install Typst.")
    })?;

    let root = document_path
        .map(Path::new)
        .and_then(Path::parent)
        .filter(|p| p.is_dir())
        .map(Path::to_path_buf)
        .unwrap_or_else(|| std::env::temp_dir().join("mdraft-typst"));

    let mut extra: Vec<&str> = Vec::new();
    if format == "html" {
        // Typst's HTML writer refuses to run without being asked for explicitly.
        extra.extend(["--features", "html"]);
    }
    extra.extend(["--format", format]);

    let (ok, stderr) = run_typst(&typst.path, &root, source, &extra, target)?;
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
) -> Result<RenderedTypst, String> {
    let typst = find_typst(app).ok_or_else(|| {
        format!("Typst is not installed, so .typ documents cannot be previewed. {DOWNLOAD_PAGE}")
    })?;

    let dir = std::env::temp_dir().join("mdraft-typst");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;

    // `--root` bounds what the document may read. Pointing it at the document's
    // own folder is what lets `#image("img/plot.png")` resolve; an untitled
    // document has no folder, so the temporary directory serves.
    let root = document_path
        .map(Path::new)
        .and_then(Path::parent)
        .filter(|p| p.is_dir())
        .map(Path::to_path_buf)
        .unwrap_or_else(|| dir.clone());

    if mode == "pages" {
        return render_pages(&typst.path, &root, &dir, source);
    }

    match render_document(&typst.path, &root, &dir, source) {
        Ok(rendered) => Ok(rendered),
        Err(failure) => {
            // The document view is experimental and refuses some documents
            // outright. Falling back keeps the pane useful, and says why.
            let mut fallback = render_pages(&typst.path, &root, &dir, source)?;
            fallback
                .warnings
                .insert(0, format!("The document view was unavailable ({failure})."));
            Ok(fallback)
        }
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
    fn the_windows_archive_name_matches_what_github_publishes() {
        // Pinned because the asset name is a promise between two projects: if
        // Typst renames it, the installer fails with "no build called ..." and
        // this test is the reminder of what it used to be.
        if cfg!(all(windows, target_arch = "x86_64")) {
            assert_eq!(release_asset(), Some("typst-x86_64-pc-windows-msvc.zip"));
        }
    }

    #[test]
    fn automatic_installation_is_windows_only_and_says_so() {
        // Every other platform has a package manager that does this better, and
        // shipping an xz decoder to duplicate it is not worth the bytes.
        assert_eq!(release_asset().is_some(), cfg!(windows));
    }
}
