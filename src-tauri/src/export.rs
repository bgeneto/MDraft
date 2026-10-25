//! Export through pandoc, and the optional self-install of pandoc itself.
//!
//! HTML export is *not* here: the application renders that itself from the same
//! pipeline that draws the preview, so it needs neither pandoc nor a LaTeX
//! installation. Everything else in the Export menu runs pandoc.
//!
//! Two design points are worth knowing before changing anything:
//!
//! * **Arguments are a token list, never a shell string.** The user's
//!   `arguments` field is split on whitespace and passed to `Command` as
//!   separate `argv` entries, so a path with spaces works without quoting and a
//!   quote typed into the field would be taken literally.
//! * **Installing is per-user and reversible.** The archive is unpacked under
//!   the application's own data directory; nothing is written to `/usr`, to
//!   `Program Files`, or to the registry, and no elevation is ever requested.

use crate::settings::{AppState, ExportFormat};
use serde::{Deserialize, Serialize};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;
use tauri::{AppHandle, Manager, Runtime};

/// The API endpoint that lists the current pandoc release and its assets.
const RELEASE_API: &str = "https://api.github.com/repos/jgm/pandoc/releases/latest";

/// The largest archive we will fetch. The arm64 macOS build is around 42 MB.
const MAX_ARCHIVE_BYTES: u64 = 120 * 1024 * 1024;

const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(600);

/// How long a single pandoc run may take. A PDF through LaTeX on a large
/// document is the slow case; anything past this is a hang, not work.
const EXPORT_TIMEOUT: Duration = Duration::from_secs(300);

/// Pandoc's `PandocPDFProgramNotFoundError`. Measured, not guessed: running
/// `pandoc -o out.pdf` with no engine installed exits 47 and names the engine it
/// tried on stderr.
const PANDOC_PDF_PROGRAM_NOT_FOUND: i32 = 47;

/// Pandoc's HTML reader plus the backslash math delimiters Asciidoctor emits.
///
/// An AsciiDoc buffer reaches pandoc as Asciidoctor-rendered HTML, because
/// pandoc's own AsciiDoc reader prints unset attributes and conditional
/// directives as prose. Asciidoctor writes inline LaTeX as `\(…\)` and display
/// LaTeX as `\[…\]`; without these extensions the HTML reader treats both as
/// literal text, so the formula survives the round trip as punctuation.
const HTML_READER: &str = "html+tex_math_single_backslash+tex_math_double_backslash";

/// A plain-language lead-in for an exit code whose meaning is not obvious from
/// pandoc's own wording, or `None` when pandoc already explains itself.
fn exit_hint(code: Option<i32>) -> Option<&'static str> {
    match code {
        Some(PANDOC_PDF_PROGRAM_NOT_FOUND) => Some(
            "PDF export needs Typst, and it was not found.\n\
             Use Help › Install Typst, or install it yourself from \
             https://typst.app/open-source/#download — it is a single executable with no \
             dependencies, and it will be picked up from PATH.",
        ),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PandocStatus {
    pub found: bool,
    pub path: Option<String>,
    pub version: Option<String>,
    /// "managed" when we installed it, "path" when it came from `PATH`.
    pub source: Option<String>,
    pub pdf_engine: Option<String>,
}

impl PandocStatus {
    fn missing() -> Self {
        Self {
            found: false,
            path: None,
            version: None,
            source: None,
            // Typst is reported by its own command, so there is nothing to fill in
            // here that would not duplicate it.
            pdf_engine: None,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportRequest {
    pub format_id: String,
    /// The document as it currently stands, including unsaved edits.
    pub markdown: String,
    /// Where the user chose to write. Always absolute, from the save dialog.
    pub output_path: String,
    /// The document's own path, for `${inputPath}`. Absent for an untitled doc.
    pub input_path: Option<String>,
    /// `"typst"`, `"html"` or `"asciidoc"` when the source is not Markdown.
    ///
    /// They need different treatment on the way out: Typst has its own
    /// renderer, which is better than any round trip; HTML and AsciiDoc must be
    /// read with pandoc's own readers rather than the Markdown one; and pandoc
    /// needs to be told which it is instead of assuming. Absent means Markdown,
    /// so a settings file or a caller written before this existed still works.
    #[serde(default)]
    pub language: Option<String>,
    /// A custom image folder the Typst compiler must be allowed to read. Only a
    /// `.typ` export uses it; absent for every other format.
    #[serde(default)]
    pub image_root: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportOutcome {
    pub output_path: String,
    pub bytes: u64,
    /// Non-empty warnings from pandoc. A run can succeed and still complain.
    pub warnings: String,
    /// What the after-export options did, for the status line.
    pub after: Vec<String>,
    pub after_errors: Vec<String>,
}

// ---------------------------------------------------------------------------
// Argument construction (pure, and the part worth testing)
// ---------------------------------------------------------------------------

/// The four values substituted into an export format's arguments.
#[derive(Debug, Default, Clone)]
pub struct Placeholders {
    pub input_path: String,
    pub output_path: String,
    pub style_reference: String,
    pub pdf_engine: String,
}

const KEYS: [&str; 4] = [
    "${inputPath}",
    "${outputPath}",
    "${styleReference}",
    "${pdfEngine}",
];

/// Substitute placeholders into one token.
///
/// `None` means the token referenced a placeholder that expanded to nothing, and
/// the caller should drop the token. That is the whole reason this returns an
/// `Option`: `--reference-doc=${styleReference}` has to vanish when no reference
/// file is configured, because pandoc rejects both an empty value and a missing
/// one. Without the rule the defaults could not mention the option at all.
fn expand_token(token: &str, values: &Placeholders) -> Option<String> {
    let mut out = token.to_string();
    for key in KEYS {
        if !out.contains(key) {
            continue;
        }
        let value = match key {
            "${inputPath}" => &values.input_path,
            "${outputPath}" => &values.output_path,
            "${styleReference}" => &values.style_reference,
            _ => &values.pdf_engine,
        };
        if value.is_empty() {
            return None;
        }
        out = out.replace(key, value);
    }
    Some(out)
}

/// Build the complete `argv` for one export.
///
/// `extra_arguments` is appended after `arguments` so a user can override a
/// default without editing it — pandoc takes the last occurrence of most
/// options.
pub fn build_arguments(format: &ExportFormat, values: &Placeholders) -> Vec<String> {
    let mut args = expand_argument_text(&format.arguments, values);
    args.extend(expand_argument_text(&format.extra_arguments, values));
    args
}

fn expand_argument_text(text: &str, values: &Placeholders) -> Vec<String> {
    text.split_whitespace()
        .filter_map(|token| expand_token(token, values))
        .collect()
}

/// Swap the format's Markdown reader for another pandoc reader.
///
/// The default export arguments carry `-f markdown+…` so a Markdown document
/// exports with the dialect this editor writes. An HTML or AsciiDoc source must
/// not be fed to that reader. The user's extra arguments stay last, so an
/// explicit `-f` there still wins.
fn reader_arguments(
    format: &ExportFormat,
    values: &Placeholders,
    reader: &str,
) -> Vec<String> {
    let mut head = expand_argument_text(&format.arguments, values);
    let tail = expand_argument_text(&format.extra_arguments, values);
    let mut index = 0;
    while index < head.len() {
        let token = &head[index];
        if token == "-f" || token == "--from" {
            let end = (index + 1).min(head.len() - 1);
            head.drain(index..=end);
            continue;
        }
        if token.starts_with("--from=") {
            head.remove(index);
            continue;
        }
        index += 1;
    }
    head.push("-f".into());
    head.push(reader.into());
    head.extend(tail);
    head
}

fn html_input_arguments(format: &ExportFormat, values: &Placeholders) -> Vec<String> {
    reader_arguments(format, values, HTML_READER)
}

fn asciidoc_input_arguments(format: &ExportFormat, values: &Placeholders) -> Vec<String> {
    reader_arguments(format, values, "asciidoc")
}

// ---------------------------------------------------------------------------
// Locating tools
// ---------------------------------------------------------------------------

/// The executable name on this platform.
fn pandoc_exe() -> &'static str {
    if cfg!(windows) { "pandoc.exe" } else { "pandoc" }
}

/// Prepare a console program to run without flashing a console window.
///
/// The application is built with `windows_subsystem = "windows"`, so it owns no
/// console. Windows therefore hands every console child a brand new one, which
/// appears and vanishes in a blink — pandoc, and `cmd` for a user-configured
/// after-export command, both do this.
///
/// `CREATE_NO_WINDOW` rather than `DETACHED_PROCESS`: the child still gets a
/// console, so its standard handles keep working, which is how pandoc's output
/// and exit status are read. `DETACHED_PROCESS` would leave the child with no
/// console at all and can break programs that use the console API.
///
/// On other platforms this is a no-op, because nothing there opens a window for
/// a child process in the first place.
#[cfg(windows)]
pub(crate) fn quiet(command: &mut Command) -> &mut Command {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW)
}

#[cfg(not(windows))]
pub(crate) fn quiet(command: &mut Command) -> &mut Command {
    command
}

/// A writable directory of our own, handed to pandoc as its working directory.
///
/// Pandoc's PDF writer does not use the system temporary directory. It creates the
/// engine's input and output with `withTempFile "."`, and for Typst its media
/// directory with `withTempDirectory "."` — both relative to the process's
/// **current working directory**. An application installed by the MSI is started
/// from a Start-menu shortcut whose working directory is the install folder
/// (`C:\Program Files\MDraft`), which a normal user cannot write to, so every PDF
/// export failed with `pandoc.exe: .: openTempFile: permission denied` — while the
/// same program started from a writable folder, such as the repository during
/// development, exported fine.
///
/// The working directory is therefore chosen here instead of inherited, and
/// `TMPDIR`, `TEMP` and `TMP` are pointed at the same place so anything the PDF
/// engine writes to the temporary directory also lands where this process has
/// proved it can write.
struct Scratch {
    path: PathBuf,
}

impl Scratch {
    /// Create a fresh scratch directory, preferring the system temporary
    /// directory and falling back to the application's cache directory. A machine
    /// whose `TEMP` is missing, full or redirected at a place this user cannot
    /// write still exports.
    fn new<R: Runtime>(app: &AppHandle<R>) -> Result<Self, String> {
        let mut roots = vec![std::env::temp_dir().join("mdraft-export")];
        if let Ok(cache) = app.path().app_cache_dir() {
            roots.push(cache.join("export"));
        }
        Self::create(&roots)
    }

    /// Split out of [`Scratch::new`] so the rules can be exercised without an
    /// `AppHandle`.
    fn create(roots: &[PathBuf]) -> Result<Self, String> {
        let mut failures: Vec<String> = Vec::new();
        for root in roots {
            // One directory per run: two exports at once must not share scratch
            // space, and leftovers from a crashed run must never be reused.
            let unique = format!(
                "{}-{:x}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|elapsed| elapsed.as_nanos())
                    .unwrap_or(0)
            );
            let path = root.join(unique);
            match std::fs::create_dir_all(&path) {
                Ok(()) => return Ok(Self { path }),
                Err(e) => failures.push(format!("{}: {e}", root.display())),
            }
        }
        Err(format!(
            "Could not create a working directory for pandoc.\n\n{}",
            failures.join("\n")
        ))
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        // Best effort: a PDF engine that outlived a timeout may still hold a file
        // open, and a directory left in the temporary directory is harmless.
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

/// The pandoc invocation for one export.
///
/// Kept apart from [`export`] so the working directory and the temporary-directory
/// environment — the two halves of the permission fix above — can be asserted
/// without running pandoc.
fn pandoc_command(pandoc: &Path, args: &[String], scratch: &Scratch, directory: &Path) -> Command {
    let mut command = Command::new(pandoc);
    command
        .args(args)
        .current_dir(directory)
        // Everything pandoc and its PDF engine write to the temporary directory
        // goes where this process has proved it can write, rather than wherever a
        // launcher's `TEMP` happens to point.
        .env("TMPDIR", scratch.path())
        .env("TEMP", scratch.path())
        .env("TMP", scratch.path());
    command
}

/// The working directory for one pandoc run.
///
/// Two different needs decide it, and they disagree:
///
/// * The PDF writer is the only one that *writes* to its working directory — the
///   engine's input, the engine's output and, for Typst, the media directory. It
///   therefore needs [`Scratch`], which is guaranteed writable.
/// * Every other writer only *reads* relative resources from there. Images the
///   editor inserts are document-relative by default (`./doc.assets/a.png`), so
///   the document's own folder is the directory that makes them resolve exactly
///   as the preview resolves them. An untitled document has no folder, and then
///   the scratch directory is the only safe answer.
fn pandoc_directory<'a>(request: &'a ExportRequest, scratch: &'a Scratch) -> &'a Path {
    let writes_a_pdf = Path::new(&request.output_path)
        .extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("pdf"));
    if writes_a_pdf {
        return scratch.path();
    }
    request
        .input_path
        .as_deref()
        .map(Path::new)
        .and_then(Path::parent)
        .filter(|directory| directory.is_dir())
        .unwrap_or_else(|| scratch.path())
}

/// Where our own copy of pandoc lives: `<app data>/pandoc/<version>/`.
fn managed_root<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("pandoc"))
}

/// Find a pandoc we installed earlier. Any version directory will do; if several
/// exist, the lexicographically last one wins, which is the newest for the
/// numeric tags GitHub uses.
fn managed_pandoc<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    let root = managed_root(app)?;
    let mut candidates: Vec<PathBuf> = std::fs::read_dir(&root)
        .ok()?
        .filter_map(Result::ok)
        .map(|entry| entry.path().join(pandoc_exe()))
        .filter(|path| path.is_file())
        .collect();
    candidates.sort();
    candidates.pop()
}

/// Resolve an executable through `PATH`.
///
/// Hand-rolled rather than shelling out to `which`/`where`, because we need the
/// resolved path to pass to `--pdf-engine` and to show the user.
pub(crate) fn which(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        if dir.as_os_str().is_empty() {
            continue;
        }
        let candidate = dir.join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

fn pdf_engine<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    // Typst only. The LaTeX route was ten engine names and a multi-gigabyte TeX
    // distribution behind whichever one was found; Typst is one executable with
    // no dependencies, it sets better mathematics, and it takes a fraction of the
    // time. A user who wants another engine can put `--pdf-engine=…` in a
    // format's arguments and it wins, because extra arguments come last.
    crate::typst::find_typst(app).map(|found| found.path)
}

/// Ask a pandoc binary for its version. This is also the liveness check: a
/// truncated download that still extracted will fail here.
fn probe_version(path: &Path) -> Option<String> {
    let output = quiet(&mut Command::new(path))
        .arg("--version")
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let first = text.lines().next()?.trim();
    // "pandoc 3.12.1" or "pandoc.exe 3.12.1"
    Some(
        first
            .rsplit_once(' ')
            .map(|(_, v)| v.to_string())
            .unwrap_or_else(|| first.to_string()),
    )
}

/// A pandoc that was found, with everything needed to describe it.
///
/// The version comes back from the same launch that proved the binary runs.
/// Probing twice would be merely wasteful on other platforms, but on Windows
/// every launch is a console window the user sees.
pub struct FoundPandoc {
    pub path: PathBuf,
    pub source: &'static str,
    pub version: String,
}

/// The pandoc to use, preferring our own copy over whatever is on `PATH`.
pub fn find_pandoc<R: Runtime>(app: &AppHandle<R>) -> Option<FoundPandoc> {
    let (path, source) = managed_pandoc(app)
        .map(|path| (path, "managed"))
        .or_else(|| which(pandoc_exe()).map(|path| (path, "path")))?;
    let version = probe_version(&path)?;
    Some(FoundPandoc {
        path,
        source,
        version,
    })
}

pub fn status<R: Runtime>(app: &AppHandle<R>) -> PandocStatus {
    match find_pandoc(app) {
        Some(found) => PandocStatus {
            found: true,
            version: Some(found.version),
            path: Some(found.path.to_string_lossy().into_owned()),
            source: Some(found.source.into()),
            pdf_engine: pdf_engine(app).map(|p| p.to_string_lossy().into_owned()),
        },
        None => PandocStatus::missing(),
    }
}

// ---------------------------------------------------------------------------
// Running an export
// ---------------------------------------------------------------------------

/// Write `markdown` to pandoc's stdin without deadlocking.
///
/// The write happens on its own thread because pandoc may already be writing to
/// stderr: if it filled that pipe while we were still writing stdin, a
/// single-threaded write-then-wait would deadlock on a large document.
fn feed_stdin(mut stdin: std::process::ChildStdin, markdown: String) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        use std::io::Write;
        // A broken pipe here means pandoc exited early; the status code carries
        // the real reason, so the write error is deliberately not propagated.
        let _ = stdin.write_all(markdown.as_bytes());
        let _ = stdin.flush();
    })
}

pub fn export<R: Runtime>(app: &AppHandle<R>, request: &ExportRequest) -> Result<ExportOutcome, String> {
    let (format, values) = prepare(app, request)?;

    // A Typst document exported to PDF or HTML goes straight to Typst. For PDF
    // that is the *only* faithful route — pandoc can read Typst and write Typst,
    // but the round trip keeps the words and loses the page. For HTML it is
    // simply the better writer.
    let typst_source = request.language.as_deref() == Some("typst");
    if typst_source {
        let ext = format.extension.to_ascii_lowercase();
        if ext == "pdf" || ext == "html" {
            return export_typst_direct(app, request, &ext);
        }
    }

    let (pandoc, _) = match find_pandoc(app) {
        Some(found) => (found.path, found.source),
        None => {
            return Err(
                "Pandoc was not found. Use Help › Install Pandoc to add it, or install it \
                 yourself."
                    .to_string(),
            )
        }
    };

    let mut args = match request.language.as_deref() {
        Some("html") => html_input_arguments(&format, &values),
        Some("asciidoc") => asciidoc_input_arguments(&format, &values),
        _ => build_arguments(&format, &values),
    };
    // For any other Format a Typst document is rendered to HTML first and handed
    // to pandoc's HTML reader, which is mature, rather than its Typst reader,
    // which is not: it turns `= Text` into the literal text "= Text", prints
    // `#set page(...)` verbatim and leaks `//` comments into the output. Verified
    // by exporting this project's own sample — see the note in typst.rs.
    let mut input_file: Option<PathBuf> = None;
    if typst_source {
        let rendered = std::env::temp_dir().join("mdraft-typst").join("export.html");
        crate::typst::compile_to(
            app,
            request.input_path.as_deref(),
            &request.markdown,
            "html",
            &rendered,
            request.image_root.as_deref(),
        )?;
        // Only the body is handed over. Typst writes a complete HTML document, and
        // pandoc's HTML reader passes anything structural it does not expect — the
        // doctype, `<head>`, the embedded `<style>` — straight through as raw HTML,
        // which is how a reStructuredText export ended up full of `<!DOCTYPE html>`.
        let full = std::fs::read_to_string(&rendered)
            .map_err(|e| format!("Could not read the rendered document: {e}"))?;
        let body = crate::typst::between(&full, "<body", "</body>")
            .ok_or_else(|| "The rendered document had no body.".to_string())?;
        std::fs::write(&rendered, body)
            .map_err(|e| format!("Could not prepare the document for pandoc: {e}"))?;

        args.insert(0, rendered.to_string_lossy().into_owned());
        args.insert(0, "html".to_string());
        args.insert(0, "-f".to_string());
        input_file = Some(rendered);
    }
    if args.is_empty() {
        return Err(format!(
            "The \"{}\" export has no arguments. Set them in Preferences › Export.",
            format.label
        ));
    }

    // Pandoc creates the PDF engine's files in its working directory, so it must
    // not inherit one the launcher happened to provide. Kept alive for the whole
    // run; the guard removes the directory when the export returns.
    let scratch = Scratch::new(app)?;
    let directory = pandoc_directory(request, &scratch);
    let mut command = pandoc_command(&pandoc, &args, &scratch, directory);
    let mut child = quiet(&mut command)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Could not start pandoc: {e}"))?;

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Could not open pandoc's input stream.".to_string())?;
    // The source is only piped when pandoc has no file to read. When it does, the
    // stream is closed empty so pandoc does not wait on it.
    let fed = if input_file.is_some() {
        String::new()
    } else {
        request.markdown.clone()
    };
    let writer = feed_stdin(stdin, fed);

    let output = wait_with_timeout(child, EXPORT_TIMEOUT)?;
    // The writer finishes as soon as pandoc closes its end. Joining keeps the
    // thread from outliving the buffers it borrows, and a panic there would
    // already have aborted the process.
    let _ = writer.join();

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if !output.status.success() {
        let code = output.status.code();
        let mut message = format!(
            "Pandoc exited with {}",
            code.map(|c| c.to_string()).unwrap_or_else(|| "a signal".into())
        );
        // Pandoc's own message is usually the most precise thing available, so
        // our explanation goes first and its text is kept verbatim underneath.
        if let Some(hint) = exit_hint(code) {
            message.push_str(".\n\n");
            message.push_str(hint);
        } else {
            message.push('.');
        }
        if !stderr.is_empty() {
            message.push_str("\n\n");
            message.push_str(&stderr);
        }
        return Err(message);
    }

    let target = PathBuf::from(&request.output_path);
    let bytes = std::fs::metadata(&target).map(|m| m.len()).unwrap_or(0);
    if bytes == 0 {
        // A zero-byte file means pandoc reported success but produced nothing —
        // a missing PDF engine is the usual cause. Saying so beats handing the
        // user an empty document.
        return Err(format!(
            "Pandoc reported success but wrote nothing to {}.\n\nFor PDF this normally means Typst \
             is not installed; use Help › Install Typst.",
            target.display()
        ));
    }

    let after = run_after_actions(app, &target);
    Ok(ExportOutcome {
        output_path: target.to_string_lossy().into_owned(),
        bytes,
        warnings: stderr,
        after: after.after,
        after_errors: after.after_errors,
    })
}

/// Export a Typst document with Typst itself, to PDF or HTML.
///
/// The alternative — handing the source to pandoc, which reads Typst and writes
/// Typst, and then running a PDF engine over that — would round-trip the document
/// through a translation that keeps the words and loses the page. Typst's own
/// renderer is the thing that produced the preview, so it is also the thing that
/// should produce the file.
fn export_typst_direct<R: Runtime>(
    app: &AppHandle<R>,
    request: &ExportRequest,
    extension: &str,
) -> Result<ExportOutcome, String> {
    let target = PathBuf::from(&request.output_path);
    crate::typst::compile_to(
        app,
        request.input_path.as_deref(),
        &request.markdown,
        extension,
        &target,
        request.image_root.as_deref(),
    )?;

    let bytes = std::fs::metadata(&target).map(|m| m.len()).unwrap_or(0);
    if bytes == 0 {
        return Err(format!(
            "Typst reported success but wrote nothing to {}.",
            target.display()
        ));
    }

    let after = run_after_actions(app, &target);
    Ok(ExportOutcome {
        output_path: target.to_string_lossy().into_owned(),
        bytes,
        warnings: String::new(),
        after: after.after,
        after_errors: after.after_errors,
    })
}

/// Resolve the format, validate the destination, and collect the placeholder
/// values. Split out of [`export`] so the validation is testable without pandoc.
fn prepare<R: Runtime>(
    app: &AppHandle<R>,
    request: &ExportRequest,
) -> Result<(ExportFormat, Placeholders), String> {
    let format = {
        let state = app.state::<AppState>();
        let settings = state
            .settings
            .lock()
            .map_err(|_| "The settings are unavailable.".to_string())?;
        settings
            .export_formats
            .iter()
            .find(|f| f.id == request.format_id)
            .cloned()
            .ok_or_else(|| format!("Unknown export format \"{}\".", request.format_id))?
    };

    let target = PathBuf::from(&request.output_path);
    if !target.is_absolute() {
        return Err(format!(
            "Refusing to write to the relative path {}.",
            target.display()
        ));
    }
    let parent = target
        .parent()
        .ok_or_else(|| format!("{} has no parent directory.", target.display()))?;
    if !parent.is_dir() {
        return Err(format!("{} is not a directory.", parent.display()));
    }
    // Pandoc would happily read the document and then truncate it, because the
    // input arrives on stdin and the output would be the same file.
    if let Some(input) = &request.input_path
        && !input.is_empty()
        && same_file(input, &request.output_path)
    {
        return Err("The export target is the document you are editing. Choose another name.".into());
    }

    let values = Placeholders {
        input_path: request.input_path.clone().unwrap_or_default(),
        output_path: target.to_string_lossy().into_owned(),
        style_reference: format.style_reference.clone(),
        pdf_engine: pdf_engine(app)
            .map(|p| format!("--pdf-engine={}", p.to_string_lossy()))
            .unwrap_or_default(),
    };
    Ok((format, values))
}

/// Compare two paths the way the filesystem would, without touching the disk.
fn same_file(a: &str, b: &str) -> bool {
    let norm = |s: &str| {
        let s = s.replace('\\', "/");
        if cfg!(windows) {
            s.to_lowercase()
        } else {
            s
        }
    };
    norm(a) == norm(b)
}

/// Wait for a child, killing it if it overruns.
///
/// `std::process` has no timeout, so this polls. The interval is short enough to
/// feel immediate and long enough to cost nothing.
fn wait_with_timeout(
    mut child: std::process::Child,
    timeout: Duration,
) -> Result<std::process::Output, String> {
    let deadline = std::time::Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => {
                return child
                    .wait_with_output()
                    .map_err(|e| format!("Could not collect pandoc's output: {e}"))
            }
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!(
                        "Pandoc did not finish within {} seconds and was stopped.",
                        timeout.as_secs()
                    ));
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(e) => return Err(format!("Lost track of pandoc: {e}")),
        }
    }
}

/// What the after-export options did, for the status line and the error dialog.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AfterExportOutcome {
    pub after: Vec<String>,
    pub after_errors: Vec<String>,
}

/// Apply the after-export options to a file that was just written.
///
/// The options are global settings, not per format. They used to live on each
/// `ExportFormat`, which made them look dead: a box ticked for Word did nothing
/// when the user exported HTML or a different pandoc format. Every path that
/// writes a file — pandoc, Typst and HTML — now asks for the same three actions.
///
/// Errors are collected rather than propagated: the file was written, so a
/// failure to open it must not be reported as a failed export.
fn run_after_actions<R: Runtime>(app: &AppHandle<R>, target: &Path) -> AfterExportOutcome {
    let settings = match app.state::<AppState>().settings.lock() {
        Ok(settings) => settings.clone(),
        Err(_) => {
            return AfterExportOutcome {
                after: Vec::new(),
                after_errors: vec!["The settings are unavailable.".into()],
            };
        }
    };

    let mut outcome = AfterExportOutcome::default();

    if settings.after_open_location {
        match tauri_plugin_opener::reveal_item_in_dir(target) {
            Ok(()) => outcome.after.push("revealed the file".into()),
            Err(e) => outcome
                .after_errors
                .push(format!("could not reveal the file: {e}")),
        }
    }
    if settings.after_open_file {
        match tauri_plugin_opener::open_path(target, None::<&str>) {
            Ok(()) => outcome.after.push("opened the file".into()),
            Err(e) => outcome
                .after_errors
                .push(format!("could not open the file: {e}")),
        }
    }
    if settings.after_run_command {
        let command = settings
            .after_command
            .replace("${outputPath}", &target.to_string_lossy());
        if command.trim().is_empty() {
            outcome
                .after_errors
                .push("no command was configured".into());
        } else {
            match run_user_command(&command) {
                Ok(()) => outcome.after.push(format!("ran {command}")),
                Err(e) => outcome.after_errors.push(format!("command failed: {e}")),
            }
        }
    }

    outcome
}

/// Run a command the user configured themselves.
///
/// This is the one place the application executes something it did not choose,
/// so it is opt-in per format, the command is visible in Preferences, and it
/// only ever runs after a successful export.
fn run_user_command(command: &str) -> Result<(), String> {
    let mut builder = if cfg!(windows) {
        let mut c = Command::new("cmd");
        c.arg("/C").arg(command);
        c
    } else {
        let mut c = Command::new("sh");
        c.arg("-c").arg(command);
        c
    };
    let status = quiet(&mut builder)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .status()
        .map_err(|e| e.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("exited with {}", status.code().unwrap_or(-1)))
    }
}

// ---------------------------------------------------------------------------
// Installing pandoc
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct Release {
    tag_name: String,
    assets: Vec<Asset>,
}

#[derive(Debug, Deserialize)]
struct Asset {
    name: String,
    browser_download_url: String,
    /// `sha256:<hex>`, published by GitHub for every release asset.
    digest: Option<String>,
}

/// Lowercase hex SHA-256, written out byte by byte so no formatting trait of the
/// digest crate's output type has to be relied on.
///
/// Shared with the Typst installer: both verify a downloaded release archive
/// against the digest GitHub publishes before executing anything from it.
pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// The asset suffix for this platform, e.g. `windows-x86_64.zip`.
fn asset_suffix() -> Result<&'static str, String> {
    let arch = std::env::consts::ARCH;
    let suffix = match (std::env::consts::OS, arch) {
        ("windows", "x86_64") => "windows-x86_64.zip",
        ("linux", "x86_64") => "linux-amd64.tar.gz",
        ("linux", "aarch64") => "linux-arm64.tar.gz",
        ("macos", "x86_64") => "x86_64-macOS.zip",
        ("macos", "aarch64") => "arm64-macOS.zip",
        (os, arch) => {
            return Err(format!(
                "There is no pandoc build for {os} on {arch}. Install pandoc yourself and it will \
                 be picked up from PATH."
            ))
        }
    };
    Ok(suffix)
}

fn http_agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(DOWNLOAD_TIMEOUT))
        // GitHub rejects API requests without a User-Agent.
        .user_agent(concat!("MDraft/", env!("CARGO_PKG_VERSION")))
        .build()
        .into()
}

fn fetch_release(agent: &ureq::Agent) -> Result<Release, String> {
    let body = agent
        .get(RELEASE_API)
        .header("Accept", "application/vnd.github+json")
        .call()
        .map_err(|e| format!("Could not reach GitHub to list pandoc releases: {e}"))?
        .body_mut()
        .with_config()
        .limit(4 * 1024 * 1024)
        .read_to_vec()
        .map_err(|e| format!("Could not read the release list: {e}"))?;
    serde_json::from_slice(&body).map_err(|e| format!("Unexpected release list from GitHub: {e}"))
}

/// Read the `pandoc`/`pandoc.exe` member out of the platform's archive shape.
#[cfg(any(target_os = "windows", target_os = "macos"))]
fn extract_binary(archive: &[u8]) -> Result<Vec<u8>, String> {
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(archive))
        .map_err(|e| format!("The downloaded archive is not a readable zip: {e}"))?;

    let mut best: Option<(usize, u64, String)> = None;
    for index in 0..zip.len() {
        let entry = zip
            .by_index(index)
            .map_err(|e| format!("Could not read archive entry {index}: {e}"))?;
        if entry.is_dir() {
            continue;
        }
        // `name()` hands back a fallible `Cow` in zip 9, so it is resolved to an
        // owned String before the entry is used for anything else.
        let name = entry
            .name()
            .map_err(|e| format!("Could not read archive entry {index}'s name: {e}"))?
            .to_string();
        let base = name.rsplit('/').next().unwrap_or("");
        if base != "pandoc" && base != "pandoc.exe" {
            continue;
        }
        // A macOS archive carries more than one `pandoc`: a symlink and the real
        // binary. The largest entry is the real one.
        let size = entry.size();
        if best.as_ref().is_none_or(|(_, s, _)| size > *s) {
            best = Some((index, size, name));
        }
    }

    let (index, _, name) = best.ok_or_else(|| {
        "The downloaded archive did not contain a pandoc binary. Its layout may have changed."
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

#[cfg(target_os = "linux")]
fn extract_binary(archive: &[u8]) -> Result<Vec<u8>, String> {
    let decoder = flate2::read::GzDecoder::new(std::io::Cursor::new(archive));
    let mut tar = tar::Archive::new(decoder);
    let entries = tar
        .entries()
        .map_err(|e| format!("The downloaded archive is not a readable tar: {e}"))?;
    for entry in entries {
        let mut entry = entry.map_err(|e| format!("Could not read a tar entry: {e}"))?;
        let path = entry
            .path()
            .map_err(|e| format!("Could not read a tar entry name: {e}"))?
            .into_owned();
        if path.file_name().and_then(|n| n.to_str()) != Some("pandoc") {
            continue;
        }
        let mut bytes = Vec::new();
        entry
            .read_to_end(&mut bytes)
            .map_err(|e| format!("Could not read the pandoc binary: {e}"))?;
        if !bytes.is_empty() {
            return Ok(bytes);
        }
    }
    Err("The downloaded archive did not contain a pandoc binary. Its layout may have changed."
        .to_string())
}

/// Fetch the release, pick this platform's asset, verify its digest, and unpack
/// the binary. Returns the release tag alongside the bytes.
///
/// Kept separate from [`install`] so the whole download-verify-unpack contract
/// can be exercised without an `AppHandle` — see the ignored test at the bottom
/// of this file.
fn download_binary(agent: &ureq::Agent) -> Result<(String, Vec<u8>), String> {
    let release = fetch_release(agent)?;
    let suffix = asset_suffix()?;

    let asset = release
        .assets
        .iter()
        .find(|a| a.name.ends_with(suffix))
        .ok_or_else(|| {
            format!(
                "Pandoc {} has no asset named *{suffix}. Install it yourself and it will be picked \
                 up from PATH.",
                release.tag_name
            )
        })?;

    let expected = asset
        .digest
        .as_deref()
        .and_then(|d| d.strip_prefix("sha256:"))
        .ok_or_else(|| {
            format!(
                "GitHub did not publish a SHA-256 for {} so the download cannot be verified. \
                 Install pandoc yourself and it will be picked up from PATH.",
                asset.name
            )
        })?
        .to_lowercase();

    let bytes = agent
        .get(&asset.browser_download_url)
        .call()
        .map_err(|e| format!("Downloading {} failed: {e}", asset.name))?
        .body_mut()
        .with_config()
        .limit(MAX_ARCHIVE_BYTES)
        .read_to_vec()
        .map_err(|e| format!("Could not read {}: {e}", asset.name))?;

    let actual = sha256_hex(&bytes);
    if actual != expected {
        return Err(format!(
            "The downloaded archive did not match the digest GitHub published, so it was discarded.\n\
             expected {expected}\n\
             got      {actual}"
        ));
    }

    Ok((release.tag_name, extract_binary(&bytes)?))
}

/// Download, verify and unpack pandoc into the application's data directory.
pub fn install<R: Runtime>(app: &AppHandle<R>) -> Result<PandocStatus, String> {
    let (tag, binary) = download_binary(&http_agent())?;

    let root =
        managed_root(app).ok_or_else(|| "No writable application data directory.".to_string())?;
    let dir = root.join(&tag);
    std::fs::create_dir_all(&dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    let target = dir.join(pandoc_exe());
    std::fs::write(&target, &binary).map_err(|e| format!("Could not write {}: {e}", target.display()))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o755))
            .map_err(|e| format!("Could not mark {} executable: {e}", target.display()))?;
    }

    if probe_version(&target).is_none() {
        let _ = std::fs::remove_file(&target);
        return Err(
            "Pandoc was downloaded and unpacked but would not run, so it was removed. Install it \
             yourself and it will be picked up from PATH."
                .into(),
        );
    }

    Ok(status(app))
}

// ---------------------------------------------------------------------------
// PDF through the system's own print-to-PDF
// ---------------------------------------------------------------------------

/// Strip anything that cannot appear in a filename, so a document called
/// `a/b:c*.md` still produces a usable temporary file.
fn safe_stem(name: &str) -> String {
    let stem = name.trim_end_matches(".md").trim();
    let cleaned: String = stem
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' || c == ' ' || c == '.' {
                c
            } else {
                '-'
            }
        })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.').to_string();
    // A name made entirely of punctuation is safe but useless — `///` would
    // otherwise become `---.html` — so it falls back to the same placeholder as
    // an empty name.
    if trimmed.is_empty() || !trimmed.chars().any(|c| c.is_alphanumeric()) {
        "document".into()
    } else {
        // Long names are fine on disk but produce an unreadable browser tab.
        trimmed.chars().take(60).collect()
    }
}

/// Write a print-ready document and hand it to the system's default browser.
///
/// This is the PDF path that needs nothing installed. It exists because the
/// alternative — pandoc driving a LaTeX engine — requires a TeX distribution of
/// several hundred megabytes, and because WebView2 exposes no print UI of its
/// own: `window.print()` inside the application fires no dialog and prints
/// nothing, so the document has to be printed by a browser that does implement
/// it.
///
/// Returns the path written, which is under the system temporary directory and
/// is replaced on every export.
#[tauri::command]
pub fn print_document<R: Runtime>(app: AppHandle<R>, html: String, name: String) -> Result<String, String> {
    let dir = std::env::temp_dir().join("mdraft-print");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    let target = dir.join(format!("{}.html", safe_stem(&name)));

    std::fs::write(&target, html.as_bytes())
        .map_err(|e| format!("Could not write {}: {e}", target.display()))?;

    tauri_plugin_opener::open_path(&target, None::<&str>).map_err(|e| {
        format!(
            "Wrote {} but could not open it in a browser: {e}\n\
             Open that file yourself and print it to PDF.",
            target.display()
        )
    })?;

    let _ = app;
    Ok(target.to_string_lossy().into_owned())
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Report what pandoc is available, if any. Fast enough to call on every panel
/// open, so it stays synchronous.
#[tauri::command]
pub fn pandoc_status<R: Runtime>(app: AppHandle<R>) -> PandocStatus {
    status(&app)
}

/// Run one export.
///
/// Both this and the installer move to a blocking thread: a PDF through LaTeX
/// takes tens of seconds, and the download is 40 MB. Running either on an async
/// worker would stall every other command for the duration.
#[tauri::command]
pub async fn run_export<R: Runtime>(
    app: AppHandle<R>,
    request: ExportRequest,
) -> Result<ExportOutcome, String> {
    tauri::async_runtime::spawn_blocking(move || export(&app, &request))
        .await
        .map_err(|e| format!("The export task could not be started: {e}"))?
}

#[tauri::command]
pub async fn install_pandoc<R: Runtime>(app: AppHandle<R>) -> Result<PandocStatus, String> {
    tauri::async_runtime::spawn_blocking(move || install(&app))
        .await
        .map_err(|e| format!("The install task could not be started: {e}"))?
}

/// Run the after-export options for a file the frontend wrote itself.
///
/// HTML is produced in TypeScript and written through `write_document`, so it
/// never passes through [`export`]. Without this command the options did nothing
/// for HTML at all — one of the paths the user was exporting when they reported
/// that neither box worked.
#[tauri::command]
pub fn run_after_export<R: Runtime>(app: AppHandle<R>, path: String) -> AfterExportOutcome {
    run_after_actions(&app, Path::new(&path))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn format_with(arguments: &str, extra: &str) -> ExportFormat {
        ExportFormat {
            arguments: arguments.into(),
            extra_arguments: extra.into(),
            ..ExportFormat::default()
        }
    }

    fn values() -> Placeholders {
        Placeholders {
            input_path: "/docs/notes.md".into(),
            output_path: "/out/report.docx".into(),
            style_reference: String::new(),
            pdf_engine: "--pdf-engine=/usr/bin/xelatex".into(),
        }
    }

    #[test]
    fn substitutes_paths_without_shell_quoting() {
        let args = build_arguments(&format_with("-s -o ${outputPath}", ""), &values());
        assert_eq!(args, vec!["-s", "-o", "/out/report.docx"]);
    }

    #[test]
    fn a_path_with_spaces_stays_one_argument() {
        let mut v = values();
        v.output_path = "/my documents/final report.docx".into();
        let args = build_arguments(&format_with("-o ${outputPath}", ""), &v);
        // The whole point of building argv directly: no quoting, no splitting.
        assert_eq!(args, vec!["-o", "/my documents/final report.docx"]);
    }

    #[test]
    fn drops_a_token_whose_placeholder_is_empty() {
        let args = build_arguments(
            &format_with("-s -o ${outputPath} --reference-doc=${styleReference}", ""),
            &values(),
        );
        assert_eq!(args, vec!["-s", "-o", "/out/report.docx"]);
        assert!(!args.iter().any(|a| a.contains("reference-doc")));
    }

    #[test]
    fn keeps_the_token_once_a_style_reference_exists() {
        let mut v = values();
        v.style_reference = "/styles/thesis.docx".into();
        let args = build_arguments(
            &format_with("-s --reference-doc=${styleReference} -o ${outputPath}", ""),
            &v,
        );
        assert_eq!(
            args,
            vec![
                "-s",
                "--reference-doc=/styles/thesis.docx",
                "-o",
                "/out/report.docx"
            ]
        );
    }

    #[test]
    fn drops_the_pdf_engine_option_when_no_engine_was_found() {
        let mut v = values();
        v.pdf_engine = String::new();
        let args = build_arguments(&format_with("-s -o ${outputPath} ${pdfEngine}", ""), &v);
        assert_eq!(args, vec!["-s", "-o", "/out/report.docx"]);
    }

    #[test]
    fn a_scratch_directory_is_writable_and_removed_with_its_export() {
        let root = std::env::temp_dir().join("mdraft-scratch-test");
        let scratch =
            Scratch::create(std::slice::from_ref(&root)).expect("a writable temp directory");
        let path = scratch.path().to_path_buf();
        assert!(path.is_dir(), "{} was not created", path.display());
        // Pandoc writes its engine input here; a directory that exists but cannot
        // take a file fixes nothing.
        std::fs::write(path.join("probe.typ"), b"= probe").expect("the scratch is writable");
        drop(scratch);
        assert!(!path.exists(), "{} outlived its export", path.display());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_scratch_directory_falls_back_to_the_next_root() {
        let base = std::env::temp_dir().join("mdraft-scratch-fallback-test");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        // A *file* where the first root's directory should be: no platform can
        // create a directory inside a file, so the first root must be rejected.
        let blocked = base.join("blocked");
        std::fs::write(&blocked, b"not a directory").unwrap();
        let usable = base.join("usable");
        let scratch = Scratch::create(&[blocked, usable.clone()]).expect("the second root works");
        assert!(
            scratch.path().starts_with(&usable),
            "{} did not use the fallback root",
            scratch.path().display()
        );
        drop(scratch);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_pdf_export_runs_where_pandoc_can_write() {
        let root = std::env::temp_dir().join("mdraft-command-test");
        let scratch =
            Scratch::create(std::slice::from_ref(&root)).expect("a writable temp directory");
        let args = ["-s", "-o", "/out/report.pdf"].map(String::from).to_vec();
        let request = ExportRequest {
            format_id: "pdf".into(),
            markdown: "# report".into(),
            output_path: "/out/report.pdf".into(),
            input_path: Some("/docs/report.md".into()),
            language: None,
            image_root: None,
        };
        let directory = pandoc_directory(&request, &scratch);
        let command = pandoc_command(Path::new("/usr/bin/pandoc"), &args, &scratch, directory);

        // The working directory is the whole fix: pandoc's PDF writer resolves its
        // `withTempFile "."` calls against it, and an MSI install inherits
        // `C:\Program Files\MDraft`, which a normal user cannot write to. Even a
        // document beside its own folder must not decide this: the PDF writer
        // *creates files* there.
        assert_eq!(command.get_current_dir(), Some(scratch.path()));
        let environment: Vec<(String, Option<String>)> = command
            .get_envs()
            .map(|(key, value)| {
                (
                    key.to_string_lossy().into_owned(),
                    value.map(|v| v.to_string_lossy().into_owned()),
                )
            })
            .collect();
        for name in ["TMPDIR", "TEMP", "TMP"] {
            let found = environment
                .iter()
                .find(|(key, _)| key == name)
                .unwrap_or_else(|| panic!("{name} was not set"));
            assert_eq!(
                found.1.as_deref(),
                Some(scratch.path().to_string_lossy().as_ref()),
                "{name} must point at the scratch directory"
            );
        }
        drop(scratch);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn another_format_runs_in_the_documents_folder_so_images_resolve() {
        let root = std::env::temp_dir().join("mdraft-document-directory-test");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let document = root.join("notes.md");
        std::fs::write(&document, "# notes").unwrap();
        let scratch = Scratch::create(std::slice::from_ref(&root)).expect("a writable temp");
        let request = ExportRequest {
            format_id: "docx".into(),
            markdown: "# notes".into(),
            output_path: root.join("notes.docx").to_string_lossy().into_owned(),
            input_path: Some(document.to_string_lossy().into_owned()),
            language: None,
            image_root: None,
        };

        // Images are inserted as `./doc.assets/a.png` by default; pandoc can only
        // find those from the document's folder. Only the PDF writer needs the
        // scratch directory instead.
        assert_eq!(pandoc_directory(&request, &scratch), root.as_path());

        let untitled = ExportRequest {
            input_path: None,
            ..request
        };
        assert_eq!(pandoc_directory(&untitled, &scratch), scratch.path());

        drop(scratch);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn extra_arguments_come_last_so_they_win() {
        let args = build_arguments(
            &format_with("-s -o ${outputPath}", "--toc --number-sections"),
            &values(),
        );
        assert_eq!(
            args,
            vec!["-s", "-o", "/out/report.docx", "--toc", "--number-sections"]
        );
    }

    #[test]
    fn an_empty_arguments_field_produces_nothing_to_run() {
        assert!(build_arguments(&format_with("   ", "  "), &values()).is_empty());
    }

    #[test]
    fn html_replaces_the_markdown_reader_and_keeps_the_output_arguments() {
        let args = html_input_arguments(
            &format_with(
                "-f markdown+tex_math_dollars -s -o ${outputPath} --reference-doc=${styleReference}",
                "",
            ),
            &values(),
        );
        assert_eq!(args, vec!["-s", "-o", "/out/report.docx", "-f", HTML_READER]);
        assert!(!args.iter().any(|arg| arg.contains("tex_math_dollars")));
    }

    #[test]
    fn html_reader_comes_before_the_users_extra_arguments() {
        let args = html_input_arguments(
            &format_with("-f markdown -s -o ${outputPath}", "--from=latex --toc"),
            &values(),
        );
        assert_eq!(
            args,
            vec![
                "-s",
                "-o",
                "/out/report.docx",
                "-f",
                HTML_READER,
                "--from=latex",
                "--toc"
            ]
        );
    }

    #[test]
    fn html_reader_handles_the_long_form_and_a_missing_value() {
        let args = html_input_arguments(
            &format_with("--from markdown -s -o ${outputPath} --from", ""),
            &values(),
        );
        assert_eq!(args, vec!["-s", "-o", "/out/report.docx", "-f", HTML_READER]);
    }

    #[test]
    fn html_reader_keeps_the_backslash_math_asciidoctor_emits() {
        // Asciidoctor writes `\(…\)` and `\[…\]`; pandoc's plain HTML reader
        // prints both as literal text unless these extensions are named.
        let args = html_input_arguments(
            &format_with("-f markdown -s -o ${outputPath}", ""),
            &values(),
        );
        assert!(args.iter().any(|arg| arg == HTML_READER));
        assert!(HTML_READER.contains("tex_math_single_backslash"));
        assert!(HTML_READER.contains("tex_math_double_backslash"));
    }

    #[test]
    fn asciidoc_replaces_the_markdown_reader_without_the_math_extensions() {
        let args = asciidoc_input_arguments(
            &format_with(
                "-f markdown+tex_math_dollars -s -o ${outputPath} --reference-doc=${styleReference}",
                "",
            ),
            &values(),
        );
        assert_eq!(args, vec!["-s", "-o", "/out/report.docx", "-f", "asciidoc"]);
        assert!(!args.iter().any(|arg| arg.contains("tex_math")));
    }

    #[test]
    fn asciidoc_reader_comes_before_the_users_extra_arguments() {
        let args = asciidoc_input_arguments(
            &format_with("-f markdown -s -o ${outputPath}", "--from=latex --toc"),
            &values(),
        );
        assert_eq!(
            args,
            vec![
                "-s",
                "-o",
                "/out/report.docx",
                "-f",
                "asciidoc",
                "--from=latex",
                "--toc"
            ]
        );
    }

    #[test]
    fn unknown_placeholders_are_left_alone_rather_than_dropped() {
        // A typo should reach pandoc and produce its error, not silently vanish
        // and leave the user wondering why an option had no effect.
        let args = build_arguments(&format_with("--from=${inputFormat}", ""), &values());
        assert_eq!(args, vec!["--from=${inputFormat}"]);
    }

    #[test]
    fn same_file_ignores_separators_and_case_on_windows() {
        assert!(same_file("/docs/a.md", "/docs/a.md"));
        assert!(same_file(r"C:\Docs\a.md", "C:/Docs/a.md"));
        #[cfg(windows)]
        assert!(same_file(r"C:\Docs\a.md", r"c:\docs\A.MD"));
        #[cfg(not(windows))]
        assert!(!same_file("/Docs/a.md", "/docs/a.md"));
    }

    #[test]
    fn safe_stem_produces_a_usable_filename() {
        assert_eq!(safe_stem("notes.md"), "notes");
        assert_eq!(safe_stem("chapter 1.md"), "chapter 1");
        assert_eq!(safe_stem("a/b:c*.md"), "a-b-c-");
        // An empty or all-punctuation name still has to yield something.
        assert_eq!(safe_stem(""), "document");
        assert_eq!(safe_stem("///"), "document");
        assert!(safe_stem(&"x".repeat(200)).chars().count() <= 60);
    }

    #[test]
    fn safe_stem_cannot_escape_the_directory_it_is_joined_onto() {
        // The property that matters is not how pretty the name is but that no
        // separator survives, so the result stays a single path component.
        for hostile in [
            "../../etc/passwd",
            r"..\..\windows\system32\config",
            "/absolute/path",
            "C:\\Windows\\notepad.exe",
            "....//....//x",
        ] {
            let safe = safe_stem(hostile);
            assert!(
                !safe.contains('/') && !safe.contains('\\'),
                "{hostile:?} produced {safe:?}, which still contains a separator"
            );
            assert!(!safe.is_empty(), "{hostile:?} produced an empty name");
            assert!(
                !safe.starts_with('.'),
                "{hostile:?} produced {safe:?}, which is a relative directory reference"
            );
        }
    }

    #[test]
    fn sha256_matches_a_known_vector() {        // FIPS 180-4 test vector, so a broken hex writer cannot pass unnoticed.
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn every_default_format_writes_somewhere_and_names_itself() {
        for format in crate::settings::default_export_formats() {
            assert!(!format.id.is_empty(), "a format has no id");
            assert!(!format.label.is_empty(), "{} has no label", format.id);
            assert!(!format.extension.is_empty(), "{} has no extension", format.id);
            assert!(
                format.arguments.contains("${outputPath}"),
                "{} never says where to write",
                format.id
            );
            assert!(
                !format.extension.starts_with('.'),
                "{} has a leading dot in its extension",
                format.id
            );
        }
    }

    #[test]
    fn every_default_format_reads_the_dialect_the_editor_writes() {
        // Without the backslash math extensions `\(…\)` degrades into escaped
        // literal text, so a document would render correctly in the preview and
        // export incorrectly. Guard the default rather than discover it again.
        for format in crate::settings::default_export_formats() {
            assert!(
                format.arguments.contains("tex_math_single_backslash")
                    && format.arguments.contains("tex_math_double_backslash"),
                "{} does not enable the backslash math delimiters the editor renders",
                format.id
            );
            assert!(
                format.arguments.contains("-f markdown"),
                "{} does not state its input format",
                format.id
            );
        }
    }

    #[test]
    fn default_format_ids_are_unique() {
        let mut ids: Vec<String> = crate::settings::default_export_formats()
            .into_iter()
            .map(|f| f.id)
            .collect();
        let total = ids.len();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), total, "two export formats share an id");
    }

    /// The installer talks to a live service whose asset naming, digest field
    /// and archive layout are all outside our control. Any of the three can
    /// change without notice, and the failure would only surface the first time
    /// a user pressed the button — so this exercises the real contract.
    ///
    /// Ignored by default because it downloads about 40 MB:
    ///
    /// ```text
    /// cargo test -- --ignored --nocapture downloading_pandoc
    /// ```
    #[test]
    #[ignore = "downloads ~40 MB from GitHub"]
    fn downloading_pandoc_yields_a_runnable_binary() {
        let agent = http_agent();
        let (tag, binary) = download_binary(&agent).expect("the installer contract still holds");
        assert!(!tag.is_empty(), "the release has no tag");

        assert!(
            binary.len() > 1_000_000,
            "the extracted binary is only {} bytes, which cannot be pandoc",
            binary.len()
        );
        // A zip starts with "PK"; anything else means we unpacked a directory
        // entry or a README by mistake.
        assert_ne!(&binary[..2], b"PK", "extracted an archive, not the binary");

        let dir = std::env::temp_dir().join("mdraft-pandoc-contract");
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join(pandoc_exe());
        std::fs::write(&path, &binary).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }

        let version = probe_version(&path).expect("the extracted pandoc runs and reports a version");
        println!("extracted pandoc {version} from tag {tag}");
        assert!(
            version.starts_with(char::is_numeric),
            "unexpected version string {version:?}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
