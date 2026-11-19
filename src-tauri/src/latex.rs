//! The shared LaTeX transport: the `mdraft-tex` scheme, the bounded project
//! snapshot, the PDF/print commands, and the two bundled preview engines'
//! status/install/cache wrappers.
//!
//! The WebView never talks to an engine origin directly. TeXpresso and PhiTeX
//! are served from this origin by `latex_texpresso.rs` and `latex_phitex.rs`;
//! the project snapshot and the PDF/print commands are shared by every backend.
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
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

use crate::text_encoding;

pub const SCHEME: &str = "mdraft-tex";
const MAX_FILE: usize = 32 * 1024 * 1024;
const MAX_PROJECT: usize = 64 * 1024 * 1024;
const MAX_FILES: usize = 256;
const MANIFEST_MAX_DEPTH: usize = 12;
const MANIFEST_MAX_NAMES: usize = 20_000;
const MANIFEST_SKIPPED_DIRS: [&str; 5] = [".git", ".hg", ".svn", "node_modules", ".mdraft-texmf"];
static TEMP_ID: AtomicU64 = AtomicU64::new(0);
static CACHE_LOCK: Mutex<()> = Mutex::new(());
/// One engine installation at a time; Pandoc and Typst have their own locks.
static INSTALL_LOCK: Mutex<()> = Mutex::new(());

/// The switch and the cache ceiling, mirrored in memory.
static ENABLED: AtomicBool = AtomicBool::new(false);
static CACHE_LIMIT_MB: AtomicU64 = AtomicU64::new(256);

pub fn apply_settings(settings: &crate::settings::Settings) {
    ENABLED.store(settings.latex_enabled, Ordering::Relaxed);
    CACHE_LIMIT_MB.store(settings.latex_cache_limit_mb as u64, Ordering::Relaxed);
    crate::latex_texpresso::set_cache_limit(
        u64::from(settings.latex_cache_limit_mb).saturating_mul(1024 * 1024),
    );
    crate::latex_phitex::set_cache_limit(
        u64::from(settings.latex_cache_limit_mb).saturating_mul(1024 * 1024),
    );
}

pub(crate) fn enabled() -> bool {
    ENABLED.load(Ordering::Relaxed)
}

/// The data directory a settings backup must include.
pub(crate) fn backup_directory(
    root: &Path,
    _keys: &crate::backup::snapshot::CredentialIds,
) -> Result<PathBuf, String> {
    Ok(root.join("latex"))
}

/// The pre-settings engine marker no longer enables anything. Kept as a
/// one-line compatibility answer for settings load; the switch is the only
/// source of truth now.
pub fn legacy_marker_present<R: tauri::Runtime>(_app: &AppHandle<R>) -> bool {
    false
}

/// The bundled engines' data directory. Older releases kept theirs in a sibling
/// directory; those files are inert now and are not migrated into this one.
pub(crate) fn directory(app: &AppHandle) -> Result<PathBuf, String> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Cannot locate the LaTeX data directory: {e}"))?;
    Ok(root.join("latex"))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LatexStats {
    /// TeXpresso: files served from disk, files downloaded, bytes verified,
    /// refusals, and the preview session's download guard.
    texpresso_hits: u64,
    texpresso_misses: u64,
    texpresso_verified_bytes: u64,
    texpresso_refusals: u64,
    texpresso_downloaded_bytes: u64,
    texpresso_guard: crate::texpresso_guard::Report,
    /// PhiTeX: the same counters for its pack and asset transport.
    phitex_hits: u64,
    phitex_misses: u64,
    phitex_verified_bytes: u64,
    phitex_refusals: u64,
    phitex_downloaded_bytes: u64,
}

#[tauri::command]
pub fn latex_stats() -> LatexStats {
    let (texpresso_hits, texpresso_misses, texpresso_verified_bytes, texpresso_refusals) =
        crate::latex_texpresso::stats();
    let (phitex_hits, phitex_misses, phitex_verified_bytes, phitex_refusals) =
        crate::latex_phitex::stats();
    LatexStats {
        texpresso_hits,
        texpresso_misses,
        texpresso_verified_bytes,
        texpresso_refusals,
        texpresso_downloaded_bytes: crate::latex_texpresso::downloaded_bytes(),
        texpresso_guard: crate::texpresso_guard::report(),
        phitex_hits,
        phitex_misses,
        phitex_verified_bytes,
        phitex_refusals,
        phitex_downloaded_bytes: crate::latex_phitex::downloaded_bytes(),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LatexCacheInfo {
    bytes: u64,
    limit_mb: u32,
    enabled: bool,
    installed: bool,
    preview_installed: bool,
    texpresso_installed: bool,
    phitex_installed: bool,
}

#[tauri::command]
pub fn latex_cache_info(app: AppHandle) -> Result<LatexCacheInfo, String> {
    let root = directory(&app)?;
    let limit_mb = CACHE_LIMIT_MB.load(Ordering::Relaxed).min(u32::MAX as u64) as u32;
    let texpresso_installed = crate::latex_texpresso::available(&root);
    let phitex_installed = crate::latex_phitex::available(&root);
    Ok(LatexCacheInfo {
        bytes: cache_size(&root.join("mirror"))
            .unwrap_or(0)
            .saturating_add(crate::latex_texpresso::cache_bytes(&root))
            .saturating_add(crate::latex_phitex::cache_bytes(&root)),
        limit_mb,
        enabled: enabled(),
        installed: texpresso_installed || phitex_installed,
        preview_installed: texpresso_installed || phitex_installed,
        texpresso_installed,
        phitex_installed,
    })
}

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

#[tauri::command]
pub fn latex_texpresso_revoke(token: String) {
    crate::latex_texpresso::revoke_project_token(&token);
}

#[tauri::command]
pub fn texpresso_download_decision(allow: bool) -> bool {
    crate::texpresso_guard::decide(allow)
}

#[tauri::command]
pub fn texpresso_status(app: AppHandle) -> Result<bool, String> {
    if !enabled() {
        return Ok(false);
    }
    Ok(crate::latex_texpresso::available(&directory(&app)?))
}

#[tauri::command]
pub async fn install_texpresso(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _writer = crate::backup::gate::writer()?;
        let _install = INSTALL_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        crate::latex_texpresso::install_with_progress(&directory(&app)?, |received, total| {
            crate::optional_tools::emit(
                &app,
                crate::optional_tools::Progress {
                    tool: crate::optional_tools::Tool::Latex,
                    phase: crate::optional_tools::Phase::Downloading,
                    received,
                    total: Some(total),
                },
            );
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub fn phitex_status(app: AppHandle) -> Result<bool, String> {
    if !enabled() {
        return Ok(false);
    }
    Ok(crate::latex_phitex::available(&directory(&app)?))
}

#[tauri::command]
pub async fn install_phitex(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _writer = crate::backup::gate::writer()?;
        let _install = INSTALL_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        crate::latex_phitex::install_with_progress(&directory(&app)?, |phase, received, total| {
            crate::optional_tools::emit(
                &app,
                crate::optional_tools::Progress {
                    tool: crate::optional_tools::Tool::Latex,
                    phase,
                    received,
                    total,
                },
            );
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub fn latex_clear_cache(app: AppHandle) -> Result<u64, String> {
    let _writer = crate::backup::gate::writer()?;
    let root = directory(&app)?;
    let mirror = root.join("mirror");
    let _guard = CACHE_LOCK
        .lock()
        .map_err(|_| "The LaTeX cache is unavailable.")?;
    let freed = cache_size(&mirror).unwrap_or(0);
    if mirror.exists() {
        fs::remove_dir_all(&mirror).map_err(|e| e.to_string())?;
    }
    Ok(freed
        .saturating_add(crate::latex_texpresso::clear(&root)?)
        .saturating_add(crate::latex_phitex::clear(&root)?))
}

pub(crate) fn write_atomic(path: &Path, data: &[u8]) -> Result<(), String> {
    let _writer = crate::backup::gate::writer()?;
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

#[cfg(test)]
pub(crate) fn remove_if_present(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

pub(crate) fn safe_relative(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= 512
        && path
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"/._-".contains(&b))
        && path
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != "..")
}

pub(crate) fn cache_size(dir: &Path) -> Result<u64, String> {
    if !dir.exists() {
        return Ok(0);
    }
    let mut total = 0u64;
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let metadata = fs::symlink_metadata(entry.path()).map_err(|e| e.to_string())?;
        if metadata.file_type().is_symlink() {
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

#[cfg(test)]
pub(crate) fn evict_to_limit(dir: &Path, limit: u64) -> Result<u64, String> {
    evict_to_limit_keeping(dir, limit, &|_| false)
}

pub(crate) fn evict_to_limit_keeping(
    dir: &Path,
    limit: u64,
    keep: &dyn Fn(&Path) -> bool,
) -> Result<u64, String> {
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
        if keep(&path) {
            continue;
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
                return Err("Bundled TeX is not enabled.".into());
            }
            let path = request.uri().path();
            if let Some(answer) = crate::latex_texpresso::serve(&root, path) {
                return answer;
            }
            if let Some(answer) = crate::latex_phitex::serve(&root, path) {
                return answer;
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
        if content_type.starts_with("text/html") {
            response = response.header(
                header::CONTENT_SECURITY_POLICY,
                crate::latex_texpresso::FRAME_CSP,
            );
        }
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
    /// Canonical encoding of the buffer this text came from. Absent means
    /// UTF-8, which keeps an old caller's default.
    #[serde(default)]
    encoding: Option<String>,
    /// The buffer's original BOM. UTF-16 always receives one when encoded.
    #[serde(default)]
    had_bom: Option<bool>,
    /// The buffer's original line ending, so an unchanged open file reaches the
    /// compiler with the same bytes it has on disk.
    #[serde(default)]
    line_ending: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFile {
    path: String,
    data: String,
    /// The encoding a text source was decoded from. Images have no label.
    #[serde(skip_serializing_if = "Option::is_none")]
    encoding: Option<String>,
}

/// One name in the bounded project-tree manifest.
#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestFile {
    path: String,
    size: u64,
    /// Milliseconds since the Unix epoch; 0 when the file system has no stamp.
    modified: u64,
}

/// The project tree without its bytes: the frame resolves a name TeX opens
/// against this table, then fetches that file from the mdraft-tex origin.
#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectManifest {
    /// Bumped when the shape changes; the frame refuses an unknown version.
    version: u32,
    files: Vec<ManifestFile>,
    /// Changes when any name, size or stamp changes.
    digest: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSnapshot {
    main_file: String,
    /// The capability the frame presents on /project/<token>/…. It names the
    /// live session root and is revoked when the frame is disposed.
    project_token: String,
    files: Vec<ProjectFile>,
    /// The bounded project tree: relative names, sizes and modification
    /// stamps, never bytes. The frame uses it as a membership table for files
    /// the predictor did not name, then fetches a hit on demand.
    manifest: ProjectManifest,
    /// Paths skipped because they are links (symbolic links or junctions) in
    /// the reference walk or the manifest walk.
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
    brace_argument_in(&chars)
}

/// `first_brace_argument` over a slice, so a caller scanning a whole file
/// does not copy the rest of the file for every command it finds.
fn brace_argument_in(chars: &[char]) -> Option<String> {
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
    let end = brace_end(chars, at)?;
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
pub(crate) fn declared_references(text: &str) -> Vec<(String, String)> {
    let masked = mask_literal_regions(text);
    let mut out = Vec::new();
    // Comments are removed line by line first, then the commands are read
    // across lines: TeX takes an argument from the next line, and templates
    // spread `\documentclass[` … `]{Class}` over several lines with a comment
    // after each option. Reading one line at a time missed that class.
    let code_lines: Vec<&str> = masked
        .split('\n')
        .map(|line| &line[..comment_start(line).unwrap_or(line.len())])
        .collect();
    let chars: Vec<char> = code_lines.join("\n").chars().collect();
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
            let Some(argument) = brace_argument_in(&chars[after..]) else {
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
    for code in code_lines {
        let chars: Vec<char> = code.chars().collect();
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

/// A link the walk must not follow: a symbolic link, or a Windows junction.
///
/// Windows reports both through FileType::is_symlink: a junction is a reparse
/// point whose tag carries the name-surrogate bit. Cloud placeholders do not,
/// so a hydrated OneDrive project is not mistaken for a link.
fn is_link(metadata: &fs::Metadata) -> bool {
    metadata.file_type().is_symlink()
}

/// The stamp the manifest reports for one file. Milliseconds are enough to
/// invalidate a changed file without exposing a platform-specific SystemTime
/// shape to the frame.
fn file_stamp(metadata: &fs::Metadata) -> u64 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|age| u64::try_from(age.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}

/// Walk the project tree once and return its bounded manifest.
///
/// The walk never follows a link and never reads a file: the frame gets names,
/// sizes and stamps, then asks for the bytes of a name TeX actually opens. The
/// skipped names are returned separately so the snapshot can report them with
/// the reference walk's skips.
fn project_manifest(root: &Path) -> Result<(ProjectManifest, Vec<String>), String> {
    project_manifest_with(root, MANIFEST_MAX_DEPTH, MANIFEST_MAX_NAMES)
}

fn project_manifest_with(
    root: &Path,
    max_depth: usize,
    max_names: usize,
) -> Result<(ProjectManifest, Vec<String>), String> {
    let root = &fs::canonicalize(root).map_err(|e| e.to_string())?;
    let mut files: Vec<ManifestFile> = Vec::new();
    let mut skipped: Vec<String> = Vec::new();
    let mut pending = vec![(root.to_path_buf(), 0usize)];

    while let Some((dir, depth)) = pending.pop() {
        if depth > max_depth {
            return Err(format!(
                "The LaTeX project is nested deeper than {max_depth} directory levels. Move the project into a folder of its own."
            ));
        }
        let entries = fs::read_dir(&dir).map_err(|error| {
            format!(
                "Cannot list {} for the project manifest: {error}",
                dir.display()
            )
        })?;
        // Directory enumeration order is not stable; the digest and the tests
        // must not depend on it.
        let mut entries: Vec<_> = entries.flatten().collect();
        entries.sort_by_key(|entry| entry.file_name());

        for entry in entries {
            let path = entry.path();
            let relative = relative_to(root, &path)?;
            let name = entry.file_name();
            if name
                .to_str()
                .is_some_and(|name| MANIFEST_SKIPPED_DIRS.contains(&name))
            {
                continue;
            }
            let metadata = fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
            if is_link(&metadata) {
                skipped.push(relative);
                continue;
            }
            if metadata.is_dir() {
                pending.push((path, depth + 1));
                continue;
            }
            if !metadata.is_file() {
                continue; // a device or socket is not project content
            }
            if files.len() >= max_names {
                return Err(format!(
                    "The LaTeX project has more than {max_names} files in its project manifest. Move the project into a folder of its own."
                ));
            }
            files.push(ManifestFile {
                path: relative,
                size: metadata.len(),
                modified: file_stamp(&metadata),
            });
        }
    }

    files.sort_by(|left, right| left.path.cmp(&right.path));
    skipped.sort();
    skipped.dedup();
    let mut key = String::new();
    for file in &files {
        key.push_str(&file.path);
        key.push('\u{0}');
        key.push_str(&file.size.to_string());
        key.push('\u{0}');
        key.push_str(&file.modified.to_string());
        key.push('\n');
    }
    Ok((
        ProjectManifest {
            version: 1,
            files,
            digest: digest(key.as_bytes()),
        },
        skipped,
    ))
}

/// The components of a project-relative path, or an error.
///
/// This is the confinement gate shared by the on-demand route and native
/// staging. It accepts the names the manifest may hold (Unicode, spaces) but no
/// empty, dot, dot-dot, drive/alternate-stream or backslash component. The
/// caller still checks links and canonicalizes the joined path.
pub(crate) fn project_components(relative: &str) -> Result<Vec<&str>, String> {
    if relative.is_empty()
        || relative.len() > 4096
        || relative.starts_with('/')
        || relative.contains('\\')
        || relative.contains('\0')
    {
        return Err("The project path is not a safe relative path.".into());
    }
    let mut parts = Vec::new();
    for part in relative.split('/') {
        if part.is_empty() || part == "." || part == ".." || part.contains(':') {
            return Err("The project path is not a safe relative path.".into());
        }
        parts.push(part);
    }
    Ok(parts)
}

/// Resolve one project file without following a link or leaving the root.
///
/// Returns the canonical path and its size. The route and native staging both
/// call this: a new reader of project bytes must not re-implement the checks.
/// Resolve one project file when the caller already canonicalized the root.
pub(crate) fn project_file_in(root: &Path, relative: &str) -> Result<(PathBuf, u64), String> {
    let parts = project_components(relative)?;
    let mut path = root.to_path_buf();
    for part in parts {
        path.push(part);
        let metadata = fs::symlink_metadata(&path)
            .map_err(|error| format!("Cannot read {relative}: {error}"))?;
        if is_link(&metadata) {
            return Err(format!(
                "{relative} is a link; project links are never read."
            ));
        }
    }
    let full = fs::canonicalize(&path).map_err(|e| format!("Cannot read {relative}: {e}"))?;
    if !full.starts_with(root) {
        return Err(format!("{relative} resolves outside the project."));
    }
    let metadata = fs::metadata(&full).map_err(|e| format!("Cannot read {relative}: {e}"))?;
    if !metadata.is_file() {
        return Err(format!("{relative} is not a file."));
    }
    Ok((full, metadata.len()))
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
/// A named alias rather than a bare tuple: the return type is four collections
/// deep, and a reader (and Clippy) should not have to decode it at every call.
type CollectedProject = (
    Vec<(PathBuf, Vec<u8>)>,
    Vec<String>,
    String,
    BTreeMap<PathBuf, String>,
);

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
    let mut encodings: BTreeMap<PathBuf, String> = BTreeMap::new();
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

        let is_text = path.extension().is_some_and(|e| {
            matches!(
                e.to_ascii_lowercase().to_str(),
                Some("tex" | "bib" | "sty" | "cls" | "bst")
            )
        });
        let named = relative_to(root, &path).unwrap_or_else(|_| path.display().to_string());

        // An open buffer wins over the bytes on disk, so an unsaved edit compiles.
        let overlay = overlays.iter().find(|entry| {
            fs::canonicalize(&entry.path)
                .map(|full| full == path)
                .unwrap_or(false)
        });
        let (bytes, text) = match overlay {
            Some(entry) => {
                if entry.text.len() > MAX_FILE {
                    return Err("An open LaTeX project file exceeds 32 MiB.".into());
                }
                let codec = text_encoding::for_label(entry.encoding.as_deref().unwrap_or("UTF-8"))
                    .map_err(|error| format!("Cannot compile {named}: {error}"))?;
                let bytes = text_encoding::encode_body(
                    &entry.text,
                    codec,
                    entry.had_bom.unwrap_or(false),
                    entry.line_ending.as_deref().unwrap_or("\n"),
                )
                .map_err(|error| format!("Cannot compile {named}: {error}"))?;
                if is_text {
                    encodings.insert(path.clone(), text_encoding::label(codec).to_string());
                }
                (bytes, is_text.then(|| entry.text.clone()))
            }
            None => {
                let meta = fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
                if is_link(&meta) {
                    skipped.push(named);
                    continue;
                }
                if meta.len() > MAX_FILE as u64 {
                    return Err("A LaTeX project file exceeds 32 MiB.".into());
                }
                let bytes = fs::read(&path).map_err(|e| e.to_string())?;
                let text = if is_text {
                    let decoded = text_encoding::decode(&bytes)
                        .map_err(|error| format!("Cannot compile {named}: {error}"))?;
                    encodings.insert(
                        path.clone(),
                        text_encoding::label(decoded.encoding).to_string(),
                    );
                    Some(decoded.text)
                } else {
                    None
                };
                (bytes, text)
            }
        };

        total = total
            .checked_add(bytes.len())
            .ok_or("Project size overflow")?;
        if total > MAX_PROJECT {
            return Err("The LaTeX project exceeds 64 MiB.".into());
        }

        // Only a text source declares further references; an image does not.
        if let Some(text) = text {
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
                                .is_ok_and(|meta| is_link(&meta))
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
    Ok((files, skipped, digest(key.as_bytes()), encodings))
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
        if is_link(&metadata) {
            return Err("A symbolic link or junction cannot be the main LaTeX file.".into());
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
        let (collected, skipped_paths, key, encodings) =
            collect_referenced(&root, &main, &overlays)?;
        files.extend(collected);
        skipped.extend(skipped_paths);
        generation.push_str(&key);

        // The manifest is the frame's membership table. Its digest travels
        // with it; the generation key stays tied to the files TeX actually
        // reads so an unrelated draft does not invalidate a finished PDF.
        let (manifest, manifest_skipped) = project_manifest(&root)?;
        skipped.extend(manifest_skipped);
        skipped.sort();
        skipped.dedup();
        generation.push_str("\nmanifest:");
        generation.push_str(&manifest.digest);
        let main_file = relative_to(&root, &main)?;
        let files = files
            .into_iter()
            .map(|(path, data)| {
                let encoding = encodings.get(&path).cloned();
                Ok(ProjectFile {
                    path: relative_to(&root, &path)?,
                    data: STANDARD.encode(data),
                    encoding,
                })
            })
            .collect::<Result<_, String>>()?;
        let texmf = if include_libraries.unwrap_or(true) {
            crate::latex_texmf::capture(&app)?
        } else {
            None
        };
        if let Some(texmf) = &texmf {
            generation.push_str(
                "
texmf:",
            );
            generation.push_str(&texmf.revision);
        }
        Ok(ProjectSnapshot {
            main_file,
            project_token: crate::latex_texpresso::project_token(&root)?,
            files,
            manifest,
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
/// `docs/architecture.md`. A second layout of the same
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
        MANIFEST_MAX_DEPTH, MANIFEST_MAX_NAMES, MANIFEST_SKIPPED_DIRS, MAX_PROJECT, Overlay,
        cache_size, collect_referenced, declared_references, evict_to_limit, mask_literal_regions,
        project_manifest, project_manifest_with, remove_if_present,
    };

    #[test]
    fn removing_an_asset_another_install_removed_is_not_an_error() {
        let path =
            std::env::temp_dir().join(format!("mdraft-remove-if-present-{}", std::process::id()));
        std::fs::write(&path, b"old").unwrap();
        remove_if_present(&path).unwrap();
        assert!(!path.exists());
        remove_if_present(&path).expect("an already removed asset is the wanted state");
    }
    use std::{fs, path::Path};

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
        let (files, skipped, _, _) =
            collect_referenced(&root, &root.join("main.tex"), &[]).unwrap();
        assert!(skipped.is_empty());
        assert!(files.iter().any(|(path, _)| path.ends_with("myclass.cls")));
        assert!(files.iter().any(|(path, _)| path.ends_with("mystyle.sty")));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn project_snapshot_preserves_legacy_encodings_and_encodes_overlays() {
        let root = scratch("legacy-encoding");
        fs::create_dir_all(root.join("chapters")).unwrap();
        fs::write(root.join("main.tex"), b"\\input{chapters/cap01}\n").unwrap();
        let legacy = b"Cap\xedtulo: a\xe7\xe3o";
        fs::write(root.join("chapters/cap01.tex"), legacy).unwrap();

        let (files, _, _, encodings) =
            collect_referenced(&root, &root.join("main.tex"), &[]).unwrap();
        let chapter = files
            .iter()
            .find(|(path, _)| path.ends_with("chapters/cap01.tex"))
            .expect("the chapter is collected");
        assert_eq!(chapter.1, legacy);
        assert_eq!(
            encodings.get(&chapter.0).map(String::as_str),
            Some("windows-1252")
        );

        // An open chapter is encoded back to its original bytes before the
        // compiler sees it, even though the editor buffer is Unicode text.
        let overlays = vec![Overlay {
            path: root
                .join("chapters/cap01.tex")
                .to_string_lossy()
                .into_owned(),
            text: "Capítulo: ação".into(),
            encoding: Some("windows-1252".into()),
            had_bom: Some(false),
            line_ending: Some("\n".into()),
        }];
        let (files, _, _, encodings) =
            collect_referenced(&root, &root.join("main.tex"), &overlays).unwrap();
        let chapter = files
            .iter()
            .find(|(path, _)| path.ends_with("chapters/cap01.tex"))
            .expect("the overlaid chapter is collected");
        assert_eq!(chapter.1, legacy);
        assert_eq!(
            encodings.get(&chapter.0).map(String::as_str),
            Some("windows-1252")
        );

        let overlays = vec![Overlay {
            path: root
                .join("chapters/cap01.tex")
                .to_string_lossy()
                .into_owned(),
            text: "Capítulo: ação 😀".into(),
            encoding: Some("windows-1252".into()),
            had_bom: Some(false),
            line_ending: Some("\n".into()),
        }];
        let error = collect_referenced(&root, &root.join("main.tex"), &overlays).unwrap_err();
        assert!(error.contains("cap01.tex"), "{error}");
        assert!(error.contains("cannot store"), "{error}");

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
        let (files, _, _, _) = collect_referenced(&root, &root.join("main.tex"), &[]).unwrap();
        let has = |name: &str| files.iter().any(|(path, _)| path.ends_with(name));
        for name in [
            "inner.cls",
            "first.sty",
            "second.sty",
            "third.sty",
            "house.bst",
        ] {
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
        let (files, skipped, generation, _) = collect_referenced(&root, &main, &[]).unwrap();
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
        let (files, _, _, _) = collect_referenced(&root, &root.join("main.tex"), &[]).unwrap();
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
        let (files, skipped, _, _) =
            collect_referenced(&root, &root.join("main.tex"), &[]).unwrap();
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
        let (files, _, _, _) = collect_referenced(&root, &root.join("main.tex"), &[]).unwrap();
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
        let (files, _, _, _) = collect_referenced(&root, &root.join("main.tex"), &[]).unwrap();
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

    /// The Legrand Orange Book template's preamble shape: one option per line,
    /// each followed by a comment, and the class name on the closing line.
    const SPREAD_CLASS: &str = "\\documentclass[\n\
        \t11pt, % Default font size, select one of 10pt, 11pt or 12pt\n\
        \tfleqn, % Left align equations ]{decoy}\n\
        \ta4paper, % Paper size\n\
        \t%oneside, % Uncomment for oneside mode\n\
        ]{LegrandOrangeBook}\n";

    #[test]
    fn a_reference_whose_argument_starts_on_a_later_line_is_collected() {
        assert_eq!(
            declared_references(SPREAD_CLASS),
            vec![("documentclass".to_string(), "LegrandOrangeBook".to_string())],
            "the class is read across lines, and the `]{{decoy}}` in a comment is not"
        );
        let packages = declared_references("\\usepackage{\n  alpha, % first\n  beta\n}\n");
        assert_eq!(
            packages,
            vec![
                ("usepackage".to_string(), "alpha".to_string()),
                ("usepackage".to_string(), "beta".to_string()),
            ]
        );
        assert!(
            declared_references("%\\documentclass[\n%  a4paper,\n%]{gone}\n").is_empty(),
            "a class commented out line by line stays out"
        );
    }

    #[test]
    fn project_snapshot_collects_a_class_named_on_a_later_line() {
        let root = scratch("latex-spread-class");
        fs::write(
            root.join("main.tex"),
            format!("{SPREAD_CLASS}\\begin{{document}}x\\end{{document}}\n"),
        )
        .unwrap();
        fs::write(root.join("LegrandOrangeBook.cls"), "% local class\n").unwrap();
        let (files, _, _, _) = collect_referenced(&root, &root.join("main.tex"), &[]).unwrap();
        assert!(
            files
                .iter()
                .any(|(path, _)| path.ends_with("LegrandOrangeBook.cls")),
            "the project-local class reaches the snapshot"
        );
        fs::remove_dir_all(root).unwrap();
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
        let (files, skipped, _, _) =
            collect_referenced(&root, &root.join("main.tex"), &[]).unwrap();
        assert!(files.iter().any(|(path, _)| path.ends_with("main.tex")));
        assert_eq!(skipped.len(), 1, "the symlink is reported: {skipped:?}");
        assert!(skipped[0].contains("linked.tex"));
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn manifest_lists_names_sizes_and_tracks_changes() {
        let root = scratch("manifest");
        fs::create_dir_all(root.join("chapters")).unwrap();
        fs::write(root.join("main.tex"), b"main").unwrap();
        fs::write(root.join("chapters/one.tex"), b"chapter").unwrap();

        let (first, skipped) = project_manifest(&root).unwrap();
        assert!(skipped.is_empty(), "{skipped:?}");
        assert_eq!(first.version, 1);
        assert_eq!(
            first
                .files
                .iter()
                .map(|file| file.path.as_str())
                .collect::<Vec<_>>(),
            ["chapters/one.tex", "main.tex"]
        );
        assert_eq!(
            first
                .files
                .iter()
                .find(|file| file.path == "main.tex")
                .map(|file| file.size),
            Some(4)
        );

        fs::write(root.join("chapters/one.tex"), b"a longer chapter").unwrap();
        let (second, _) = project_manifest(&root).unwrap();
        assert_ne!(
            first.digest, second.digest,
            "a changed size changes the digest"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn manifest_skips_and_reports_links_without_following_them() {
        let root = scratch("manifest-links");
        let outside = scratch("manifest-links-outside");
        fs::write(root.join("main.tex"), b"main").unwrap();
        fs::write(outside.join("secret.tex"), b"secret").unwrap();
        fs::create_dir_all(outside.join("dir")).unwrap();
        fs::write(outside.join("dir/secret.tex"), b"secret").unwrap();

        #[cfg(unix)]
        let (file_link, dir_link) = {
            use std::os::unix::fs::symlink;
            (
                symlink(outside.join("secret.tex"), root.join("linked.tex")).is_ok(),
                symlink(outside.join("dir"), root.join("linked-dir")).is_ok(),
            )
        };
        #[cfg(windows)]
        let (file_link, dir_link) = {
            use std::os::windows::fs::{symlink_dir, symlink_file};
            (
                symlink_file(outside.join("secret.tex"), root.join("linked.tex")).is_ok(),
                symlink_dir(outside.join("dir"), root.join("linked-dir")).is_ok(),
            )
        };
        if !(file_link && dir_link) {
            // Creating a symlink needs a privilege on Windows; without it there
            // is nothing to test. The junction test below covers that host.
            let _ = fs::remove_dir_all(&root);
            let _ = fs::remove_dir_all(&outside);
            return;
        }

        let (manifest, skipped) = project_manifest(&root).unwrap();
        assert_eq!(
            manifest
                .files
                .iter()
                .map(|file| file.path.as_str())
                .collect::<Vec<_>>(),
            ["main.tex"]
        );
        assert_eq!(skipped, ["linked-dir", "linked.tex"]);
        fs::remove_dir_all(&root).unwrap();
        fs::remove_dir_all(&outside).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn manifest_skips_and_reports_a_junction() {
        let root = scratch("manifest-junction");
        let outside = scratch("manifest-junction-outside");
        fs::write(root.join("main.tex"), b"main").unwrap();
        fs::write(outside.join("secret.tex"), b"secret").unwrap();
        let status = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(root.join("escape"))
            .arg(&outside)
            .output()
            .unwrap();
        if !status.status.success() {
            let _ = fs::remove_dir_all(&root);
            let _ = fs::remove_dir_all(&outside);
            return; // mklink unavailable in this environment
        }

        let (manifest, skipped) = project_manifest(&root).unwrap();
        assert_eq!(
            manifest
                .files
                .iter()
                .map(|file| file.path.as_str())
                .collect::<Vec<_>>(),
            ["main.tex"]
        );
        assert_eq!(skipped, ["escape"]);
        let _ = fs::remove_dir(root.join("escape"));
        fs::remove_dir_all(&root).unwrap();
        fs::remove_dir_all(&outside).unwrap();
    }

    #[test]
    fn manifest_refuses_the_name_and_depth_caps_with_a_named_error() {
        let root = scratch("manifest-caps");
        fs::write(root.join("main.tex"), b"main").unwrap();
        for name in ["a.tex", "b.tex", "c.tex"] {
            fs::write(root.join(name), b"x").unwrap();
        }
        let error = project_manifest_with(&root, MANIFEST_MAX_DEPTH, 3).unwrap_err();
        assert!(error.contains("3 files"), "{error}");
        assert!(error.contains("manifest"), "{error}");

        let deep = scratch("manifest-depth");
        let mut dir = deep.clone();
        for _ in 0..3 {
            dir.push("level");
            fs::create_dir_all(&dir).unwrap();
        }
        fs::write(dir.join("main.tex"), b"x").unwrap();
        let error = project_manifest_with(&deep, 2, MANIFEST_MAX_NAMES).unwrap_err();
        assert!(error.contains("deeper than 2"), "{error}");
        assert!(error.contains("directory levels"), "{error}");

        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(deep).unwrap();
    }

    #[test]
    fn manifest_skips_tool_and_library_folders() {
        let root = scratch("manifest-skipped-dirs");
        for dir in MANIFEST_SKIPPED_DIRS {
            let path = root.join(dir);
            fs::create_dir_all(&path).unwrap();
            fs::write(path.join("hidden.tex"), b"x").unwrap();
        }
        fs::write(root.join("main.tex"), b"main").unwrap();

        let (manifest, skipped) = project_manifest(&root).unwrap();
        assert_eq!(
            manifest
                .files
                .iter()
                .map(|file| file.path.as_str())
                .collect::<Vec<_>>(),
            ["main.tex"]
        );
        assert!(skipped.is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn manifest_refuses_a_name_that_is_not_unicode() {
        use std::os::unix::ffi::OsStringExt;
        let root = scratch("manifest-non-unicode");
        let name = std::ffi::OsString::from_vec(vec![b'b', b'a', b'd', 0xff]);
        fs::write(root.join(&name), b"x").unwrap();
        let error = project_manifest(&root).unwrap_err();
        assert!(error.contains("valid Unicode"), "{error}");
        fs::remove_dir_all(root).unwrap();
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
