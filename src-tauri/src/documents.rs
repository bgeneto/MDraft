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

use crate::export::sha256_hex;

const BOM: &str = "\u{feff}";
static NEXT_TEMP: AtomicU64 = AtomicU64::new(1);

/// Refuse destructive decoding before a buffer or replacement is created.
/// A text file mentioning a signature later in prose is still text.
fn validated_text(bytes: &[u8]) -> Result<&str, String> {
    if bytes.starts_with(&[0xff, 0xfe, 0, 0]) || bytes.starts_with(&[0, 0, 0xfe, 0xff]) {
        return Err(
            "UTF-32 text is not supported yet. Convert a copy to UTF-8 before opening it.".into(),
        );
    }
    if bytes.starts_with(&[0xff, 0xfe]) || bytes.starts_with(&[0xfe, 0xff]) {
        return Err(
            "UTF-16 text is not supported yet. Convert a copy to UTF-8 before opening it.".into(),
        );
    }
    let header = bytes
        .iter()
        .position(|byte| !byte.is_ascii_whitespace())
        .unwrap_or(0);
    let prefix = &bytes[header..];
    let binary_signature = prefix.starts_with(b"%PDF-")
        || bytes.starts_with(b"GIF87a")
        || bytes.starts_with(b"GIF89a")
        || bytes.starts_with(b"PK\x03\x04")
        || bytes.starts_with(b"PK\x05\x06")
        || bytes.starts_with(b"PK\x07\x08")
        || bytes.starts_with(b"\x89PNG\r\n\x1a\n")
        || bytes.starts_with(b"\xff\xd8\xff")
        || (bytes.starts_with(b"RIFF")
            && bytes
                .get(8..12)
                .is_some_and(|kind| kind == b"WEBP" || kind == b"WAVE" || kind == b"AVI "));
    if binary_signature
        || bytes
            .iter()
            .any(|byte| matches!(byte, 0..=8 | 11 | 14..=31 | 127))
    {
        return Err("This is a binary/non-text file. It cannot be edited as a document.".into());
    }
    std::str::from_utf8(bytes).map_err(|_| {
        "This file is not valid UTF-8. Convert a copy to UTF-8; opening it lossily could destroy its original characters.".into()
    })
}

fn validate_destination(path: &Path) -> Result<(), String> {
    match fs::read(path) {
        Ok(bytes) => validated_text(&bytes)
            .map(|_| ())
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
    let sha256 = sha256_hex(&bytes);

    let mut text = validated_text(&bytes)
        .map_err(|error| format!("Could not open {path}: {error}"))?
        .to_owned();
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
        lossy: false,
        size: meta.len(),
        modified_ms: modified_ms(&meta),
        read_only: meta.permissions().readonly(),
        sha256,
    })
}

/// Save `content` to `path`, restoring the original line ending and BOM.
///
/// The write goes to a temporary sibling first and is then renamed over the
/// target, so an interrupted save cannot leave a half-written document.
///
/// Existing callers (HTML export, for example) have no disk baseline and keep
/// this command's shape. `write_document_checked` is the guarded variant the
/// editor uses.
#[tauri::command]
pub fn write_document(
    path: String,
    content: String,
    line_ending: Option<String>,
    had_bom: Option<bool>,
) -> Result<SavedInfo, String> {
    let outcome = write_document_inner(
        &PathBuf::from(&path),
        &content,
        line_ending,
        had_bom,
        None,
    )?;
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
) -> Result<CheckedWrite, String> {
    write_document_inner(
        &PathBuf::from(&path),
        &content,
        line_ending,
        had_bom,
        expected_sha256.as_deref(),
    )
}

fn write_document_inner(
    p: &Path,
    content: &str,
    line_ending: Option<String>,
    had_bom: Option<bool>,
    expected_sha256: Option<&str>,
) -> Result<CheckedWrite, String> {
    let path = p.display();
    let eol = line_ending.unwrap_or_else(|| "\n".to_string());
    let bom = had_bom.unwrap_or(false);

    if let Some(expected) = expected_sha256 {
        if let Some(conflict) = check_expected(p, expected)? {
            return Ok(conflict);
        }
    } else {
        validate_destination(p)?;
    }

    let mut body = String::with_capacity(content.len() + 3);
    if bom {
        body.push_str(BOM);
    }
    if eol == "\r\n" {
        body.push_str(&content.replace('\n', "\r\n"));
    } else {
        body.push_str(content);
    }

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
    let written = file
        .write_all(body.as_bytes())
        .and_then(|_| file.sync_all());
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
        sha256: sha256_hex(body.as_bytes()),
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
                validated_text(&bytes)
                    .map_err(|error| format!("Refusing to overwrite {}: {error}", path.display()))?;
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
    fn refuses_binary_signatures_controls_and_invalid_utf8() {
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
            b"caf\xe9",
        ] {
            assert!(validated_text(bytes).is_err(), "{bytes:?}");
        }
    }

    #[test]
    fn identifies_unsupported_encoding_before_binary_nuls() {
        for (bytes, encoding) in [
            (b"\xff\xfeh\0i\0".as_slice(), "UTF-16"),
            (b"\xfe\xff\0h\0i", "UTF-16"),
            (b"\xff\xfe\0\0h\0\0\0", "UTF-32"),
            (b"\0\0\xfe\xff\0\0\0h", "UTF-32"),
        ] {
            let error = validated_text(bytes).unwrap_err();
            assert!(error.contains(encoding), "{error}");
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
        ] {
            assert_eq!(validated_text(text.as_bytes()).unwrap(), text);
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
            ("b.txt", b"\xff\xfeh\0i\0"),
            ("c.md", b"caf\xe9"),
        ] {
            let path = dir.join(name);
            fs::write(&path, bytes).unwrap();
            let error = write_document(
                path.to_string_lossy().into(),
                "replacement".into(),
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
        )
        .unwrap();
        assert_eq!(fs::read_to_string(copy).unwrap(), "caf\u{fffd}");
        assert_eq!(
            fs::read_dir(&dir).unwrap().count(),
            4,
            "no temporary siblings left"
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
        write_document(path.to_string_lossy().into(), "new text".into(), None, None).unwrap();
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
                    write_document(path, format!("writer {n}\n").repeat(100), None, None).unwrap();
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
        assert_eq!(doc.sha256, sha256_hex("\u{feff}# Title\r\n\r\nbody\r\n".as_bytes()));
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
