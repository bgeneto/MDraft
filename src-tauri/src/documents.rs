//! Document and filesystem commands.
//!
//! All text is normalised to `\n` while it lives in the editor; the file's own
//! line ending and byte-order mark are remembered and restored on save.

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

const BOM: &str = "\u{feff}";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentPayload {
    pub path: String,
    pub name: String,
    pub directory: String,
    pub content: String,
    /// Approximate token count of `content`, from the same estimator the live
    /// status-bar counter uses. Computed here because the text is already in
    /// hand: sending a megabyte back over IPC just to count it would add a full
    /// round-trip to every document open.
    pub tokens: usize,
    /// "\n" or "\r\n"
    pub line_ending: String,
    pub had_bom: bool,
    /// True when the bytes were not valid UTF-8 and had to be replaced.
    pub lossy: bool,
    pub size: u64,
    pub modified_ms: u64,
    pub read_only: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedInfo {
    pub size: u64,
    pub modified_ms: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileStat {
    pub exists: bool,
    pub size: u64,
    pub modified_ms: u64,
    pub read_only: bool,
}

fn modified_ms(meta: &fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn display_name(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn read_document(path: String) -> Result<DocumentPayload, String> {
    let p = PathBuf::from(&path);
    let bytes = fs::read(&p).map_err(|e| format!("Could not read {path}: {e}"))?;
    let meta = fs::metadata(&p).map_err(|e| e.to_string())?;

    // Non-UTF-8 input is decoded lossily rather than rejected, so the editor can
    // still open it; `lossy` tells the UI that saving will change bytes.
    let lossy = std::str::from_utf8(&bytes).is_err();
    let mut text = String::from_utf8_lossy(&bytes).into_owned();
    let had_bom = text.starts_with(BOM);
    if had_bom {
        text = text.trim_start_matches(BOM).to_string();
    }

    let line_ending = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let content = text.replace("\r\n", "\n").replace('\r', "\n");
    let tokens = crate::tokens::estimate_tokens(&content);

    Ok(DocumentPayload {
        path: p.to_string_lossy().to_string(),
        name: display_name(&p),
        directory: p
            .parent()
            .map(|d| d.to_string_lossy().to_string())
            .unwrap_or_default(),
        content,
        tokens,
        line_ending: line_ending.to_string(),
        had_bom,
        lossy,
        size: meta.len(),
        modified_ms: modified_ms(&meta),
        read_only: meta.permissions().readonly(),
    })
}

/// Save `content` to `path`, restoring the original line ending and BOM.
///
/// The write goes to a temporary sibling first and is then renamed over the
/// target, so an interrupted save cannot leave a half-written document.
#[tauri::command]
pub fn write_document(
    path: String,
    content: String,
    line_ending: Option<String>,
    had_bom: Option<bool>,
) -> Result<SavedInfo, String> {
    let p = PathBuf::from(&path);
    let eol = line_ending.unwrap_or_else(|| "\n".to_string());
    let bom = had_bom.unwrap_or(false);

    let mut body = String::with_capacity(content.len() + 3);
    if bom {
        body.push_str(BOM);
    }
    if eol == "\r\n" {
        body.push_str(&content.replace('\n', "\r\n"));
    } else {
        body.push_str(&content);
    }

    if let Some(parent) = p.parent()
        && !parent.as_os_str().is_empty()
    {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    let tmp = temp_sibling(&p);
    fs::write(&tmp, body.as_bytes()).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("Could not write {path}: {e}")
    })?;

    fs::rename(&tmp, &p).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("Could not replace {path}: {e}")
    })?;

    let meta = fs::metadata(&p).map_err(|e| e.to_string())?;
    Ok(SavedInfo {
        size: meta.len(),
        modified_ms: modified_ms(&meta),
    })
}

fn temp_sibling(p: &Path) -> PathBuf {
    let name = display_name(p);
    let tmp_name = format!(".{name}.{}.tmp", std::process::id());
    match p.parent() {
        Some(dir) => dir.join(tmp_name),
        None => PathBuf::from(tmp_name),
    }
}

#[tauri::command]
pub fn stat_document(path: String) -> Result<FileStat, String> {
    let p = PathBuf::from(&path);
    match fs::metadata(&p) {
        Ok(meta) => Ok(FileStat {
            exists: true,
            size: meta.len(),
            modified_ms: modified_ms(&meta),
            read_only: meta.permissions().readonly(),
        }),
        Err(_) => Ok(FileStat {
            exists: false,
            size: 0,
            modified_ms: 0,
            read_only: false,
        }),
    }
}

/// Resolve a path the user typed or pasted.
///
/// An absolute path is used unchanged. A relative one is resolved against the
/// folder of the document being edited, which is what the preview does and what
/// `./image.png` means to a reader. The process working directory is wherever
/// the application happened to be launched, so it must never be the base here:
/// doing so made a file beside the document look missing.
pub(crate) fn resolve_path(path: &str, document_path: Option<&str>) -> PathBuf {
    let candidate = PathBuf::from(path);
    if candidate.is_absolute() {
        return candidate;
    }
    match document_path.and_then(|doc| Path::new(doc).parent()) {
        Some(dir) if !dir.as_os_str().is_empty() => dir.join(candidate),
        _ => candidate,
    }
}

#[tauri::command]
pub fn path_exists(path: String, document_path: Option<String>) -> bool {
    resolve_path(&path, document_path.as_deref()).exists()
}

/// Extensions a document link must never launch. The OS opener would run them.
const EXECUTABLE_EXTENSIONS: [&str; 12] = [
    "exe", "bat", "cmd", "com", "scr", "msi", "ps1", "vbs", "js", "jar", "lnk", "pif",
];

/// Open a local file or folder with the platform's default application.
///
/// A document may name any path; the reader still chooses to click it, but the
/// command is the last line of defence, so an executable is refused here rather
/// than trusted to the shell.
#[tauri::command]
pub fn open_external(path: String) -> Result<(), String> {
    let canonical = PathBuf::from(&path)
        .canonicalize()
        .map_err(|_| format!("{path} was not found."))?;
    if !canonical.is_file() && !canonical.is_dir() {
        return Err(format!("{path} is not a file or a folder."));
    }
    let extension = canonical
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
        .unwrap_or_default();
    if EXECUTABLE_EXTENSIONS.contains(&extension.as_str()) {
        return Err(format!(
            "Refusing to open {path}: executable files are not opened from a document link."
        ));
    }
    tauri_plugin_opener::open_path(&canonical, None::<&str>)
        .map_err(|e| format!("Could not open {path}: {e}"))
}

/// The file passed on the command line, if any (`mdraft notes.md`).
#[tauri::command]
pub fn startup_file() -> Option<String> {
    let arg = std::env::args().nth(1)?;
    if arg.starts_with('-') {
        return None;
    }
    let p = PathBuf::from(&arg);
    if p.is_file() {
        Some(p.to_string_lossy().to_string())
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn open_external_refuses_missing_paths_and_executables() {
        let dir = std::env::temp_dir().join(format!("tt-open-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let missing = dir.join("missing.png");
        let error = open_external(missing.to_string_lossy().to_string()).unwrap_err();
        assert!(error.contains("was not found"), "{error}");

        let program = dir.join("payload.exe");
        fs::write(&program, b"MZ").unwrap();
        let error = open_external(program.to_string_lossy().to_string()).unwrap_err();
        assert!(error.contains("Refusing to open"), "{error}");
        assert!(error.contains("executable"), "{error}");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn round_trip_preserves_crlf_and_bom() {
        let dir = std::env::temp_dir().join(format!("tt-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("doc.md");
        fs::write(&file, "\u{feff}# Title\r\n\r\nbody\r\n").unwrap();

        let doc = read_document(file.to_string_lossy().to_string()).unwrap();
        assert!(doc.had_bom);
        assert_eq!(doc.line_ending, "\r\n");
        assert_eq!(doc.content, "# Title\n\nbody\n");
        // "#" + "Title" + "body": the open path counts the normalised text.
        assert_eq!(doc.tokens, 3);

        write_document(
            file.to_string_lossy().to_string(),
            doc.content.clone(),
            Some(doc.line_ending.clone()),
            Some(doc.had_bom),
        )
        .unwrap();

        let raw = fs::read_to_string(&file).unwrap();
        assert_eq!(raw, "\u{feff}# Title\r\n\r\nbody\r\n");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn saving_without_trailing_newline_keeps_bytes() {
        let dir = std::env::temp_dir().join(format!("tt-test2-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("plain.txt");
        write_document(
            file.to_string_lossy().to_string(),
            "abc".into(),
            Some("\n".into()),
            Some(false),
        )
        .unwrap();
        assert_eq!(fs::read_to_string(&file).unwrap(), "abc");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn relative_paths_resolve_against_the_document_folder() {
        let dir = std::env::temp_dir().join(format!("tt-resolve-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let doc = dir.join("notes.md");
        fs::write(&doc, "x").unwrap();
        fs::write(dir.join("picture.png"), b"not really a png").unwrap();
        let doc_path = Some(doc.to_string_lossy().to_string());

        // The file sits beside the document, not in the process working
        // directory, which is what made the paste report it as missing.
        assert!(path_exists("picture.png".to_string(), doc_path.clone()));
        assert!(path_exists("./picture.png".to_string(), doc_path.clone()));
        assert!(!path_exists("missing.png".to_string(), doc_path));

        // An absolute path keeps its meaning.
        assert!(path_exists(
            dir.join("picture.png").to_string_lossy().to_string(),
            Some(doc.to_string_lossy().to_string())
        ));

        // Without a document there is no folder to resolve against.
        assert_eq!(
            resolve_path("picture.png", None),
            PathBuf::from("picture.png")
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(windows)]
    #[test]
    fn windows_paths_resolve_against_the_document_folder() {
        assert_eq!(
            resolve_path("./image.png", Some("C:\\docs\\notes.md")),
            PathBuf::from("C:\\docs\\.\\image.png")
        );
        assert_eq!(
            resolve_path("C:\\pics\\image.png", Some("C:\\docs\\notes.md")),
            PathBuf::from("C:\\pics\\image.png"),
            "an absolute path must not be joined to the document folder"
        );
    }

    #[cfg(unix)]
    #[test]
    fn unix_paths_resolve_against_the_document_folder() {
        assert_eq!(
            resolve_path("./image.png", Some("/home/me/notes.md")),
            PathBuf::from("/home/me/./image.png")
        );
        assert_eq!(
            resolve_path("/opt/pics/image.png", Some("/home/me/notes.md")),
            PathBuf::from("/opt/pics/image.png"),
            "an absolute path must not be joined to the document folder"
        );
    }
}
