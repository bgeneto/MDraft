//! Document and filesystem commands.
//!
//! All text is normalised to `\n` while it lives in the editor; the file's own
//! line ending and byte-order mark are remembered and restored on save.

use serde::Serialize;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::UNIX_EPOCH;
use tauri::Manager;

use crate::export::sha256_hex;
use crate::text_encoding;

static NEXT_TEMP: AtomicU64 = AtomicU64::new(1);

/// Refuse destructive decoding before a buffer or replacement is created.
///
/// The decision itself belongs to `text_encoding`: this helper only keeps the
/// destination guard readable where it does not need the decoded text.
fn validated_text(bytes: &[u8]) -> Result<(), String> {
    text_encoding::decode(bytes).map(|_| ())
}

fn validate_destination(path: &Path) -> Result<(), String> {
    match fs::read(path) {
        Ok(bytes) => validated_text(&bytes)
            .map_err(|error| format!("Refusing to overwrite {}: {error}", path.display())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!(
            "Could not check {} before replacing it: {error}",
            path.display()
        )),
    }
}

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
    /// The canonical encoding the file was decoded from, such as `UTF-8` or
    /// `windows-1252`. Saving uses this label; it is never guessed again.
    pub encoding: String,
    /// Retained for IPC/legacy recovery compatibility; new unsafe reads fail.
    pub lossy: bool,
    pub size: u64,
    pub modified_ms: u64,
    pub read_only: bool,
    /// SHA-256 of the raw file bytes (BOM and line endings included).
    ///
    /// This is the identity of the disk revision the buffer was opened from.
    /// It is deliberately computed before decoding: a BOM or an EOL change is a
    /// different revision even when the editor text is identical.
    pub sha256: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedInfo {
    pub size: u64,
    pub modified_ms: u64,
}

/// The result of a save that may have been refused by the disk guard.
///
/// `written: false` is a successful command that did **not** change the file:
/// the caller must ask the reader what to do, exactly as it does for the stat
/// based preflight. It is not an I/O error.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckedWrite {
    pub written: bool,
    /// `saved`, `modified` or `deleted`.
    pub change: String,
    pub size: u64,
    pub modified_ms: u64,
    pub sha256: String,
}

/// The current stat and raw-byte digest, for "Keep my version".
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentFingerprint {
    pub exists: bool,
    pub size: u64,
    pub modified_ms: u64,
    pub sha256: String,
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

    let decoded =
        text_encoding::decode(&bytes).map_err(|error| format!("Could not open {path}: {error}"))?;
    Ok(payload(&p, &bytes, &meta, decoded))
}

/// Reopen a document with an encoding the reader chose (Reinterpret).
///
/// Same payload as `read_document`, so the shell's reload path replaces the
/// buffer. Decoding is strict: an encoding that would need a replacement
/// character is refused rather than opened lossily.
#[tauri::command]
pub fn read_document_as(path: String, encoding: String) -> Result<DocumentPayload, String> {
    let p = PathBuf::from(&path);
    let codec = text_encoding::for_label(&encoding)?;
    let bytes = fs::read(&p).map_err(|e| format!("Could not read {path}: {e}"))?;
    let meta = fs::metadata(&p).map_err(|e| e.to_string())?;
    let decoded = text_encoding::decode_as(&bytes, codec)
        .map_err(|error| format!("Could not reopen {path}: {error}"))?;
    Ok(payload(&p, &bytes, &meta, decoded))
}

/// What the file on disk contains, for the encoding dialog: the detector's
/// choice, BOM, raw line-ending counts and how every offered encoding reads it.
///
/// Async so up to ~40 strict decodes of a large file run off the main thread.
#[tauri::command]
pub async fn inspect_document_encoding(path: String) -> Result<text_encoding::Inspection, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = fs::read(&path).map_err(|e| format!("Could not read {path}: {e}"))?;
        Ok(text_encoding::inspect(&bytes))
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Whether `content` can be stored in `encoding`, and where it first cannot.
#[tauri::command]
pub async fn check_encoding_fit(
    content: String,
    encoding: String,
) -> Result<text_encoding::Fit, String> {
    let codec = text_encoding::for_label(&encoding)?;
    Ok(text_encoding::fit(&content, codec))
}

fn payload(
    p: &Path,
    bytes: &[u8],
    meta: &fs::Metadata,
    decoded: text_encoding::DecodedText,
) -> DocumentPayload {
    let sha256 = sha256_hex(bytes);
    let had_bom = decoded.had_bom;
    let encoding = text_encoding::label(decoded.encoding).to_string();
    let text = decoded.text;

    let line_ending = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let content = text.replace("\r\n", "\n").replace('\r', "\n");
    let tokens = crate::tokens::estimate_tokens(&content);

    DocumentPayload {
        path: p.to_string_lossy().to_string(),
        name: display_name(p),
        directory: p
            .parent()
            .map(|d| d.to_string_lossy().to_string())
            .unwrap_or_default(),
        content,
        tokens,
        line_ending: line_ending.to_string(),
        had_bom,
        encoding,
        lossy: false,
        size: meta.len(),
        modified_ms: modified_ms(meta),
        read_only: meta.permissions().readonly(),
        sha256,
    }
}

/// Save `content` to `path`, restoring the original line ending, BOM and
/// encoding.
///
/// The write goes to a temporary sibling first and is then renamed over the
/// target, so an interrupted save cannot leave a half-written document.
///
/// Existing callers (HTML export, for example) have no disk baseline and keep
/// this command's shape. `write_document_checked` is the guarded variant the
/// editor uses. `encoding` is optional so old callers keep writing UTF-8.
#[tauri::command]
pub fn write_document(
    path: String,
    content: String,
    line_ending: Option<String>,
    had_bom: Option<bool>,
    encoding: Option<String>,
) -> Result<SavedInfo, String> {
    let label = encoding.as_deref().unwrap_or("UTF-8").to_string();
    let outcome = write_document_inner(
        &PathBuf::from(&path),
        &content,
        line_ending,
        had_bom,
        encoding.as_deref(),
        None,
    )?;
    if outcome.change == "encoding" {
        return Err(format!(
            "The text contains characters that {label} cannot store. Save it as a UTF-8 copy instead."
        ));
    }
    Ok(SavedInfo {
        size: outcome.size,
        modified_ms: outcome.modified_ms,
    })
}

/// Save only if the bytes on disk are still the revision the buffer was based
/// on.
///
/// The expected hash is checked once before a temporary file is created and
/// again immediately before the rename. A mismatch is returned as
/// `written: false`, not as an error: the shell shows the normal conflict
/// notice and keeps the reader's text. The second check narrows the
/// check-then-write window; it cannot remove it, because no portable filesystem
/// compare-and-swap exists.
#[tauri::command]
pub fn write_document_checked(
    path: String,
    content: String,
    line_ending: Option<String>,
    had_bom: Option<bool>,
    expected_sha256: Option<String>,
    encoding: Option<String>,
) -> Result<CheckedWrite, String> {
    write_document_inner(
        &PathBuf::from(&path),
        &content,
        line_ending,
        had_bom,
        encoding.as_deref(),
        expected_sha256.as_deref(),
    )
}

fn write_document_inner(
    p: &Path,
    content: &str,
    line_ending: Option<String>,
    had_bom: Option<bool>,
    encoding: Option<&str>,
    expected_sha256: Option<&str>,
) -> Result<CheckedWrite, String> {
    let path = p.display();
    let eol = line_ending.unwrap_or_else(|| "\n".to_string());
    let bom = had_bom.unwrap_or(false);
    let codec = text_encoding::for_label(encoding.unwrap_or("UTF-8"))?;

    if let Some(expected) = expected_sha256 {
        if let Some(conflict) = check_expected(p, expected)? {
            return Ok(conflict);
        }
    } else {
        validate_destination(p)?;
    }

    // Encode before creating a temporary sibling. An unmappable character must
    // leave the destination untouched, including its directory listing.
    let body = match text_encoding::encode_body(content, codec, bom, &eol) {
        Ok(body) => body,
        Err(text_encoding::EncodeError::Unmappable) => {
            return Ok(CheckedWrite {
                written: false,
                change: "encoding".into(),
                size: 0,
                modified_ms: 0,
                sha256: String::new(),
            });
        }
        Err(error) => return Err(error.to_string()),
    };

    if let Some(parent) = p.parent()
        && !parent.as_os_str().is_empty()
    {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    let (tmp, mut file) = loop {
        let candidate = temp_sibling(p);
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
        {
            Ok(file) => break (candidate, file),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("Could not write {path}: {error}")),
        }
    };
    let written = file.write_all(&body).and_then(|_| file.sync_all());
    drop(file);
    if let Err(error) = written {
        let _ = fs::remove_file(&tmp);
        return Err(format!("Could not write {path}: {error}"));
    }

    if let Some(expected) = expected_sha256 {
        match check_expected(p, expected) {
            Ok(Some(conflict)) => {
                let _ = fs::remove_file(&tmp);
                return Ok(conflict);
            }
            Ok(None) => {}
            Err(error) => {
                let _ = fs::remove_file(&tmp);
                return Err(error);
            }
        }
    } else if let Err(error) = validate_destination(p) {
        let _ = fs::remove_file(&tmp);
        return Err(error);
    }

    if let Err(error) = fs::rename(&tmp, p) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("Could not replace {path}: {error}"));
    }

    let meta = fs::metadata(p).map_err(|e| e.to_string())?;
    Ok(CheckedWrite {
        written: true,
        change: "saved".into(),
        size: meta.len(),
        modified_ms: modified_ms(&meta),
        sha256: sha256_hex(&body),
    })
}

/// Compare the target with the bytes the buffer was based on.
///
/// `Ok(None)` means the disk still matches. `Ok(Some(outcome))` is a conflict
/// the caller must surface without writing; `Err` is an I/O failure. The same
/// function is used before the temporary file is created and immediately
/// before the rename.
fn check_expected(path: &Path, expected: &str) -> Result<Option<CheckedWrite>, String> {
    match fs::read(path) {
        Ok(bytes) => {
            let actual = sha256_hex(&bytes);
            if actual == expected {
                // The baseline was a text document, but validate again: a
                // caller could otherwise pass a binary file's digest and turn
                // this command into an arbitrary overwrite.
                validated_text(&bytes).map_err(|error| {
                    format!("Refusing to overwrite {}: {error}", path.display())
                })?;
                return Ok(None);
            }
            let meta = fs::metadata(path).map_err(|e| e.to_string())?;
            Ok(Some(CheckedWrite {
                written: false,
                change: "modified".into(),
                size: meta.len(),
                modified_ms: modified_ms(&meta),
                sha256: actual,
            }))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Some(CheckedWrite {
            written: false,
            change: "deleted".into(),
            size: 0,
            modified_ms: 0,
            sha256: String::new(),
        })),
        Err(error) => Err(format!(
            "Could not check {} before replacing it: {error}",
            path.display()
        )),
    }
}

/// Return the current stat and raw-byte digest without decoding the text.
///
/// Used by "Keep my version", which must adopt the revision it just observed.
#[tauri::command]
pub fn fingerprint_document(path: String) -> Result<DocumentFingerprint, String> {
    let p = PathBuf::from(&path);
    match fs::read(&p) {
        Ok(bytes) => {
            let meta = fs::metadata(&p).map_err(|e| e.to_string())?;
            Ok(DocumentFingerprint {
                exists: true,
                size: meta.len(),
                modified_ms: modified_ms(&meta),
                sha256: sha256_hex(&bytes),
            })
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(DocumentFingerprint {
            exists: false,
            size: 0,
            modified_ms: 0,
            sha256: String::new(),
        }),
        Err(error) => Err(format!("Could not read {path}: {error}")),
    }
}

fn temp_sibling(p: &Path) -> PathBuf {
    let name = display_name(p);
    let sequence = NEXT_TEMP.fetch_add(1, Ordering::Relaxed);
    let tmp_name = format!(".{name}.{}.{sequence}.tmp", std::process::id());
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

/// Resolve a legacy image only when both checks stay on a fixed local drive.
/// A valid ordinary Markdown target always wins, even if it is not an image.
#[tauri::command]
pub async fn resolve_legacy_local_image(
    primary: String,
    candidate: String,
    document_path: Option<String>,
) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || {
        resolve_legacy_local_image_inner(primary, candidate, document_path)
    })
    .await
    .ok()
    .flatten()
}

fn resolve_legacy_local_image_inner(
    primary: String,
    candidate: String,
    document_path: Option<String>,
) -> Option<String> {
    let primary = resolve_path(&primary, document_path.as_deref());
    let candidate = resolve_path(&candidate, document_path.as_deref());
    let (primary_exists, _, _) = local_fixed_presence(&primary)?;
    if primary_exists {
        return None;
    }
    let (candidate_exists, candidate_is_file, candidate_path) = local_fixed_presence(&candidate)?;
    if !candidate_exists || !candidate_is_file {
        return None;
    }
    Some(candidate_path.to_string_lossy().into_owned())
}

#[cfg(not(windows))]
fn local_fixed_presence(_path: &Path) -> Option<(bool, bool, PathBuf)> {
    None
}

#[cfg(windows)]
fn local_fixed_presence(path: &Path) -> Option<(bool, bool, PathBuf)> {
    use std::os::windows::fs::MetadataExt;
    use std::path::{Component, Prefix};
    use windows::Win32::Storage::FileSystem::GetDriveTypeW;
    use windows::core::PCWSTR;

    let mut components = path.components();
    let drive = match components.next()? {
        Component::Prefix(prefix) => match prefix.kind() {
            Prefix::Disk(letter) => letter,
            _ => return None,
        },
        _ => return None,
    };
    if !matches!(components.next(), Some(Component::RootDir)) {
        return None;
    }
    let root = format!("{}:\\", char::from(drive));
    let wide: Vec<u16> = root.encode_utf16().chain(std::iter::once(0)).collect();
    // The null-terminated root is valid for this call. DRIVE_FIXED is 3;
    // mapped, removable, UNC and unknown drives are deliberately excluded.
    if unsafe { GetDriveTypeW(PCWSTR(wide.as_ptr())) } != 3 {
        return None;
    }
    let mut current = PathBuf::from(root);
    let drive_root = current.clone();
    let mut is_file = false;
    for component in components {
        match component {
            Component::Normal(part) => current.push(part),
            Component::CurDir => continue,
            Component::ParentDir if current != drive_root && !is_file => {
                current.pop();
                is_file = false;
                continue;
            }
            _ => return None,
        }
        match std::fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_attributes() & 0x400 == 0 => is_file = metadata.is_file(),
            Ok(_) => return None, // FILE_ATTRIBUTE_REPARSE_POINT
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Some((false, false, current));
            }
            Err(_) => return None,
        }
    }
    Some((true, is_file, current))
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

/// The folders Preferences offers to open, by name.
///
/// A whitelist rather than a path: the frontend cannot touch the filesystem, and
/// a command that accepted an arbitrary path would hand it that ability through
/// the back door. Each name resolves under the application's own data directory,
/// which is where the managed tools live.
const APP_FOLDERS: [&str; 3] = ["pandoc", "typst", "latex"];

/// The directory a named application folder resolves to, under `data_root`.
///
/// Split out from the command so the mapping can be tested without an
/// `AppHandle`: an unknown name must not resolve.
fn app_folder_path(data_root: &Path, folder: &str) -> Result<PathBuf, String> {
    if !APP_FOLDERS.contains(&folder) {
        return Err(format!("There is no {folder} folder to open."));
    }
    Ok(data_root.join(folder))
}

/// Open one of the application's own tool folders in the OS file manager.
///
/// Preferences shows a button instead of printing the path, so the reader can
/// look at what was downloaded without reading a `C:\…` line. The folder is
/// created when it does not exist yet: a reader who has not installed Typst
/// still gets an answer rather than an error about a missing directory.
#[tauri::command]
pub fn open_app_folder(app: tauri::AppHandle, folder: String) -> Result<(), String> {
    let data_root = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Cannot locate the application data directory: {e}"))?;
    let target = if folder == "latex" {
        crate::latex::directory(&app)?
    } else {
        app_folder_path(&data_root, &folder)?
    };
    fs::create_dir_all(&target)
        .map_err(|e| format!("Could not create {}: {e}", target.display()))?;
    tauri_plugin_opener::open_path(&target, None::<&str>)
        .map_err(|e| format!("Could not open {}: {e}", target.display()))
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
    fn app_folders_are_a_whitelist_not_a_path() {
        let root = Path::new("C:/data");
        assert_eq!(
            app_folder_path(root, "pandoc").unwrap(),
            root.join("pandoc")
        );
        assert_eq!(app_folder_path(root, "typst").unwrap(), root.join("typst"));
        assert_eq!(app_folder_path(root, "latex").unwrap(), root.join("latex"));
        // A name that is not on the list must not resolve, so a compromised
        // frontend cannot make the command open an arbitrary directory.
        for bad in [
            "",
            "..",
            "..\\Windows",
            "C:/Windows",
            "pandoc/../..",
            "PANDOC",
        ] {
            assert!(app_folder_path(root, bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn refuses_binary_signatures_and_controls() {
        for bytes in [
            b"%PDF-1.7\nplain-looking payload".as_slice(),
            b" \n%PDF-1.4\nobject",
            b"GIF89a123456789",
            b"PK\x03\x04document.xml",
            b"\x89PNG\r\n\x1a\n",
            b"RIFF1234WEBPpayload",
            b"\xff\xd8\xffimage",
            b"text\0with a NUL",
            b"bad\x1bcontrol",
            b"bad\x80\x81",
        ] {
            assert!(validated_text(bytes).is_err(), "{bytes:?}");
        }
    }

    #[test]
    fn identifies_utf32_before_binary_nuls() {
        for bytes in [b"\xff\xfe\0\0h\0\0\0".as_slice(), b"\0\0\xfe\xff\0\0\0h"] {
            let error = validated_text(bytes).unwrap_err();
            assert!(error.contains("UTF-32"), "{error}");
            assert!(!error.contains("binary"), "{error}");
        }
    }

    #[test]
    fn accepts_utf8_unicode_whitespace_and_signature_like_prose() {
        for text in [
            "",
            "plain\ttext\r\n\u{c}page\n",
            "ação 日本語 😀",
            "\u{feff}# Title",
            "A PDF begins with %PDF-1.7",
            "```\n%PDF-1.7\n```",
            "MZ is a word",
            "PK is text",
            "caf\u{e9}",
        ] {
            assert!(validated_text(text.as_bytes()).is_ok(), "{text:?}");
        }
    }

    #[test]
    fn opening_refused_bytes_does_not_change_them() {
        let dir = std::env::temp_dir().join(format!("tt-refused-open-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("document.md");
        let bytes = b"%PDF-1.7\0original";
        fs::write(&path, bytes).unwrap();
        assert!(read_document(path.to_string_lossy().into()).is_err());
        assert_eq!(fs::read(&path).unwrap(), bytes);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn write_refuses_unsafe_existing_targets_but_can_save_a_copy() {
        let dir = std::env::temp_dir().join(format!("tt-refused-write-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        for (name, bytes) in [
            ("a.pdf", b"%PDF-1.7\noriginal".as_slice()),
            ("b.txt", b"bad\0text"),
        ] {
            let path = dir.join(name);
            fs::write(&path, bytes).unwrap();
            let error = write_document(
                path.to_string_lossy().into(),
                "replacement".into(),
                None,
                None,
                None,
            )
            .unwrap_err();
            assert!(error.contains("Refusing to overwrite"), "{error}");
            assert_eq!(fs::read(path).unwrap(), bytes);
        }
        let copy = dir.join("utf8-copy.txt");
        write_document(
            copy.to_string_lossy().into(),
            "caf\u{fffd}".into(),
            None,
            None,
            None,
        )
        .unwrap();
        assert_eq!(fs::read_to_string(copy).unwrap(), "caf\u{fffd}");
        assert_eq!(
            fs::read_dir(&dir).unwrap().count(),
            3,
            "no temporary siblings left"
        );
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn windows_1252_document_opens_and_saves_identical_bytes() {
        let dir = std::env::temp_dir().join(format!("tt-legacy-round-trip-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("tese.tex");
        let bytes = b"Tese apresentada ao Instituto de F\xedsica da Universidade de Bras\xedlia, \
                      para obten\xe7\xe3o do t\xedtulo de Doutor em F\xedsica.";
        fs::write(&file, bytes).unwrap();

        let document = read_document(file.to_string_lossy().to_string()).unwrap();
        assert_eq!(document.encoding, "windows-1252");
        assert!(document.content.contains("Física"));
        assert!(document.content.contains("Brasília"));
        assert!(document.content.contains("obtenção"));

        let outcome = write_document_checked(
            file.to_string_lossy().to_string(),
            document.content,
            Some(document.line_ending),
            Some(document.had_bom),
            Some(document.sha256),
            Some(document.encoding),
        )
        .unwrap();
        assert!(outcome.written);
        assert_eq!(fs::read(&file).unwrap(), bytes);
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_windows_1252_edit_keeps_the_encoding_and_accents() {
        let dir = std::env::temp_dir().join(format!("tt-legacy-edit-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("cap01.tex");
        fs::write(&file, b"caf\xe9").unwrap();

        let document = read_document(file.to_string_lossy().to_string()).unwrap();
        let outcome = write_document_checked(
            file.to_string_lossy().to_string(),
            "café ação".into(),
            Some(document.line_ending),
            Some(document.had_bom),
            Some(document.sha256),
            Some(document.encoding),
        )
        .unwrap();
        assert!(outcome.written);
        assert_eq!(fs::read(&file).unwrap(), b"caf\xe9 a\xe7\xe3o");

        let reopened = read_document(file.to_string_lossy().to_string()).unwrap();
        assert_eq!(reopened.encoding, "windows-1252");
        assert_eq!(reopened.content, "café ação");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn an_unmappable_character_is_refused_without_touching_disk() {
        let dir = std::env::temp_dir().join(format!("tt-unmappable-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("tese.tex");
        let bytes = b"caf\xe9";
        fs::write(&file, bytes).unwrap();

        let document = read_document(file.to_string_lossy().to_string()).unwrap();
        let outcome = write_document_checked(
            file.to_string_lossy().to_string(),
            format!("{} \u{1f600}", document.content),
            Some(document.line_ending),
            Some(document.had_bom),
            Some(document.sha256),
            Some(document.encoding),
        )
        .unwrap();
        assert!(!outcome.written);
        assert_eq!(outcome.change, "encoding");
        assert_eq!(fs::read(&file).unwrap(), bytes);
        assert_eq!(
            fs::read_dir(&dir).unwrap().count(),
            1,
            "an encoding refusal must not leave a temporary sibling"
        );
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn checked_write_refuses_a_same_size_same_mtime_rewrite() {
        let dir = std::env::temp_dir().join(format!("tt-checked-conflict-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("notes.md");
        fs::write(&file, "AAAA").unwrap();
        let baseline = sha256_hex(b"AAAA");
        let original = fs::metadata(&file).unwrap().modified().unwrap();

        // A different file with the same length and the timestamp the session
        // remembers is exactly what the stat guard cannot see.
        fs::write(&file, "BBBB").unwrap();
        std::fs::OpenOptions::new()
            .write(true)
            .open(&file)
            .unwrap()
            .set_modified(original)
            .unwrap();
        assert_eq!(fs::metadata(&file).unwrap().len(), 4);

        let outcome = write_document_checked(
            file.to_string_lossy().into(),
            "CCCC".into(),
            None,
            None,
            Some(baseline),
            None,
        )
        .unwrap();
        assert!(!outcome.written);
        assert_eq!(outcome.change, "modified");
        assert_eq!(fs::read_to_string(&file).unwrap(), "BBBB");
        assert_eq!(
            fs::read_dir(&dir).unwrap().count(),
            1,
            "a refused save must not leave a temporary sibling"
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn checked_write_returns_the_digest_of_the_bytes_it_wrote() {
        let dir = std::env::temp_dir().join(format!("tt-checked-digest-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("document.md");
        fs::write(&file, "old").unwrap();
        let baseline = sha256_hex(b"old");

        let outcome = write_document_checked(
            file.to_string_lossy().into(),
            "new\n".into(),
            Some("\r\n".into()),
            Some(true),
            Some(baseline),
            None,
        )
        .unwrap();
        assert!(outcome.written);
        assert_eq!(outcome.change, "saved");
        assert_eq!(fs::read(&file).unwrap(), "\u{feff}new\r\n".as_bytes());
        assert_eq!(outcome.sha256, sha256_hex("\u{feff}new\r\n".as_bytes()));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn checked_write_reports_a_deleted_target_without_creating_it() {
        let dir = std::env::temp_dir().join(format!("tt-checked-deleted-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("gone.md");

        let outcome = write_document_checked(
            file.to_string_lossy().into(),
            "text".into(),
            None,
            None,
            Some(sha256_hex(b"old")),
            None,
        )
        .unwrap();
        assert!(!outcome.written);
        assert_eq!(outcome.change, "deleted");
        assert!(!file.exists());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn the_last_check_refuses_a_newer_external_revision() {
        let dir = std::env::temp_dir().join(format!("tt-recheck-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("notes.md");
        fs::write(&file, "AAAA").unwrap();
        let baseline = sha256_hex(b"AAAA");

        // This is the same helper called immediately before rename.
        fs::write(&file, "BBBB").unwrap();
        let conflict = check_expected(&file, &baseline).unwrap().unwrap();
        assert!(!conflict.written);
        assert_eq!(conflict.change, "modified");
        assert_eq!(conflict.sha256, sha256_hex(b"BBBB"));
        assert_eq!(fs::read_to_string(&file).unwrap(), "BBBB");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn checked_write_still_refuses_a_binary_destination() {
        let dir = std::env::temp_dir().join(format!("tt-checked-binary-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("document.md");
        let bytes = b"%PDF-1.7\0payload";
        fs::write(&file, bytes).unwrap();

        let error = write_document_checked(
            file.to_string_lossy().into(),
            "text".into(),
            None,
            None,
            Some(sha256_hex(bytes)),
            None,
        )
        .unwrap_err();
        assert!(error.contains("Refusing to overwrite"), "{error}");
        assert_eq!(fs::read(&file).unwrap(), bytes);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn temporary_siblings_are_unique_and_do_not_truncate_an_existing_one() {
        let dir = std::env::temp_dir().join(format!("tt-temp-unique-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("notes.md");
        let first = temp_sibling(&path);
        let second = temp_sibling(&path);
        assert_ne!(first, second);
        fs::write(&first, "another writer's scratch").unwrap();
        write_document(
            path.to_string_lossy().into(),
            "new text".into(),
            None,
            None,
            None,
        )
        .unwrap();
        assert_eq!(
            fs::read_to_string(&first).unwrap(),
            "another writer's scratch"
        );
        assert_eq!(fs::read_to_string(path).unwrap(), "new text");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn concurrent_writes_never_share_a_temporary_sibling() {
        let dir = std::env::temp_dir().join(format!("tt-temp-concurrent-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("notes.txt");
        fs::write(&path, "base").unwrap();
        let handles: Vec<_> = (0..8)
            .map(|n| {
                let path = path.to_string_lossy().to_string();
                std::thread::spawn(move || {
                    write_document(path, format!("writer {n}\n").repeat(100), None, None, None)
                        .unwrap();
                })
            })
            .collect();
        for handle in handles {
            handle.join().unwrap();
        }
        let text = fs::read_to_string(&path).unwrap();
        assert!((0..8).any(|n| text == format!("writer {n}\n").repeat(100)));
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
        fs::remove_dir_all(dir).unwrap();
    }

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

    #[cfg(windows)]
    #[test]
    fn legacy_local_image_preserves_primary_and_never_probes_unc() {
        let root = std::env::temp_dir().join(format!("tt-legacy-image-{}", std::process::id()));
        fs::create_dir_all(root.join(".hidden")).unwrap();
        let primary = root.join("missing.png");
        let candidate = root.join(".hidden").join("image.png");
        fs::write(&candidate, b"image").unwrap();
        let p = primary.to_string_lossy().into_owned();
        let c = candidate.to_string_lossy().into_owned();
        assert_eq!(
            resolve_legacy_local_image_inner(p.clone(), c.clone(), None),
            Some(c.clone())
        );
        let document = root.join("docs").join("doc.md");
        fs::create_dir_all(document.parent().unwrap()).unwrap();
        assert_eq!(
            resolve_legacy_local_image_inner(
                r"..\missing.png".into(),
                r"..\.hidden\image.png".into(),
                Some(document.to_string_lossy().into_owned()),
            ),
            Some(c.clone())
        );
        fs::write(&primary, b"ordinary target").unwrap();
        assert_eq!(
            resolve_legacy_local_image_inner(p.clone(), c.clone(), None),
            None
        );
        assert_eq!(
            resolve_legacy_local_image_inner(p, r"\\server\share\image.png".into(), None),
            None
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(not(windows))]
    #[test]
    fn legacy_windows_image_fallback_does_not_reinterpret_posix_names() {
        let root = std::env::temp_dir().join(format!("tt-legacy-posix-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let literal = root.join(r"images\.hidden\image.png");
        fs::write(&literal, b"image").unwrap();
        assert_eq!(
            resolve_legacy_local_image_inner(
                root.join("images.hiddenimage.png")
                    .to_string_lossy()
                    .into_owned(),
                literal.to_string_lossy().into_owned(),
                None,
            ),
            None
        );
        fs::remove_dir_all(root).unwrap();
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
        // The identity is the raw revision, before BOM/EOL normalisation.
        assert_eq!(
            doc.sha256,
            sha256_hex("\u{feff}# Title\r\n\r\nbody\r\n".as_bytes())
        );
        // "#" + "Title" + "body": the open path counts the normalised text.
        assert_eq!(doc.tokens, 3);

        write_document(
            file.to_string_lossy().to_string(),
            doc.content.clone(),
            Some(doc.line_ending.clone()),
            Some(doc.had_bom),
            Some(doc.encoding.clone()),
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
            None,
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
