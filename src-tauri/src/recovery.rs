//! Crash recovery journal for unsaved buffers.
//!
//! The editor is the authority while the application runs; this store is the
//! durable copy that survives a crash, a forced kill or a WebView reload. One
//! JSON file per dirty buffer, written atomically, keeps a failure isolated to
//! the entry being written instead of the whole journal.
//!
//! The frontend owns *when* to write — it debounces per session — and this
//! module owns *how*: ids are validated so an entry name can never leave the
//! recovery directory, content is capped so a runaway buffer cannot fill the
//! disk, and a corrupt file is ignored rather than deleted because the reader's
//! text may be the only copy.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

/// One buffer's durable copy.
///
/// `baseModifiedMs` and `baseSize` describe the disk revision the buffer was
/// based on. They are deliberately not "the file's current state": restoring
/// them lets the external-change guard notice that the file moved while MDraft
/// was closed, instead of silently overwriting it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryEntry {
    pub id: String,
    pub path: Option<String>,
    pub name: String,
    pub language: String,
    pub content: String,
    pub line_ending: String,
    pub had_bom: bool,
    pub lossy: bool,
    pub read_only: bool,
    pub base_modified_ms: u64,
    pub base_size: u64,
    /// SHA-256 of the disk revision this buffer was based on, or `None` for an
    /// entry written by a build before content validation existed.
    ///
    /// The first save after a restore is checked against this, so a file that
    /// changed while MDraft was closed cannot be overwritten merely because its
    /// size and `mtime` happened to match.
    #[serde(default)]
    pub base_sha256: Option<String>,
    /// Set by the host on write, never trusted from the frontend.
    #[serde(default)]
    pub updated_ms: u64,
}

const MAX_CONTENT_BYTES: usize = 16 * 1024 * 1024;
const MAX_ENTRIES: usize = 64;
const MAX_ID_LEN: usize = 128;

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// The recovery directory, beside `settings.json`.
///
/// It deliberately shares the application's config directory: the test harness
/// already backs that directory up and restores it, and `appDirectoriesOverride`
/// (the portable build) redirects it whole. A journal is application state, not
/// a document sibling, and keeping it out of the document folder is what makes
/// "never write next to the document" true.
fn store_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|dir| dir.join("recovery"))
        .map_err(|error| format!("The recovery directory is unavailable: {error}"))
}

/// An id is a filename, so it may only contain filename-safe characters.
fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_ID_LEN
        && id
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
}

fn entry_path(dir: &Path, id: &str) -> Result<PathBuf, String> {
    if !valid_id(id) {
        return Err("The recovery entry has an invalid id.".into());
    }
    Ok(dir.join(format!("{id}.json")))
}

fn count_entries(dir: &Path) -> Result<usize, String> {
    if !dir.exists() {
        return Ok(0);
    }
    let mut count = 0;
    for entry in fs::read_dir(dir).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.ends_with(".json") {
            count += 1;
        }
    }
    Ok(count)
}

/// Write one entry, replacing the previous copy atomically.
fn write_entry(dir: &Path, mut entry: RecoveryEntry) -> Result<RecoveryEntry, String> {
    if !valid_id(&entry.id) {
        return Err("The recovery entry has an invalid id.".into());
    }
    if entry.content.len() > MAX_CONTENT_BYTES {
        return Err(format!(
            "This document is too large to journal ({} MiB, limit {} MiB). Save it to keep it safe.",
            entry.content.len() / (1024 * 1024),
            MAX_CONTENT_BYTES / (1024 * 1024)
        ));
    }

    let path = entry_path(dir, &entry.id)?;
    if !path.exists() && count_entries(dir)? >= MAX_ENTRIES {
        return Err(format!(
            "The recovery journal is full ({MAX_ENTRIES} documents). Save or close a document and try again."
        ));
    }

    entry.updated_ms = now_ms();
    // Compact JSON, a temporary sibling and a rename: a full buffer is sent on
    // every debounce, and pretty-printing 16 MiB would cost more than the
    // write. The rename is what keeps an interrupted write from truncating the
    // previous copy.
    let body = serde_json::to_vec(&entry).map_err(|error| error.to_string())?;
    fs::create_dir_all(dir).map_err(|error| error.to_string())?;
    let tmp = path.with_extension("json.tmp");
    if let Err(error) = fs::write(&tmp, &body) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("Could not write the recovery entry: {error}"));
    }
    if let Err(error) = fs::rename(&tmp, &path) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("Could not replace the recovery entry: {error}"));
    }
    Ok(entry)
}

fn list_entries(dir: &Path) -> Result<Vec<RecoveryEntry>, String> {
    if !dir.exists() {
        return Ok(Vec::new());
    }

    let mut entries = Vec::new();
    for item in fs::read_dir(dir).map_err(|error| error.to_string())? {
        let item = item.map_err(|error| error.to_string())?;
        let path = item.path();
        if !path.is_file() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        let Some(stem) = name.strip_suffix(".json") else {
            continue;
        };
        // A temporary file is a write in progress, not a recovery entry.
        if name.ends_with(".json.tmp") || !valid_id(stem) {
            continue;
        }
        let Ok(raw) = fs::read_to_string(&path) else {
            continue;
        };
        let Ok(entry) = serde_json::from_str::<RecoveryEntry>(&raw) else {
            // The file may be the only copy of the reader's text. Ignore it;
            // do not delete it and do not let it block the rest of the list.
            continue;
        };
        // The filename is the identity used by remove; a mismatched file is
        // corrupt or hand-made and must not be removed under the wrong name.
        if entry.id == stem {
            entries.push(entry);
        }
    }

    entries.sort_by(|a, b| b.updated_ms.cmp(&a.updated_ms));
    Ok(entries)
}

fn remove_entry(dir: &Path, id: &str) -> Result<(), String> {
    if !valid_id(id) {
        return Err("The recovery entry has an invalid id.".into());
    }
    let path = entry_path(dir, id)?;
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Could not remove the recovery entry: {error}")),
    }
}

#[tauri::command]
pub fn list_recovery(app: AppHandle) -> Result<Vec<RecoveryEntry>, String> {
    list_entries(&store_dir(&app)?)
}

#[tauri::command]
pub fn write_recovery(app: AppHandle, entry: RecoveryEntry) -> Result<(), String> {
    let dir = store_dir(&app)?;
    write_entry(&dir, entry)?;
    Ok(())
}

#[tauri::command]
pub fn remove_recovery(app: AppHandle, id: String) -> Result<(), String> {
    remove_entry(&store_dir(&app)?, &id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::time::Duration;

    static COUNTER: AtomicU32 = AtomicU32::new(0);

    fn temp_dir(tag: &str) -> PathBuf {
        let id = COUNTER.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!(
            "mdraft-recovery-{tag}-{}-{id}",
            std::process::id()
        ))
    }

    fn entry(id: &str) -> RecoveryEntry {
        RecoveryEntry {
            id: id.into(),
            path: Some("C:\\notes\\chapter.md".into()),
            name: "chapter.md".into(),
            language: "markdown".into(),
            content: "unsaved text\n".into(),
            line_ending: "\r\n".into(),
            had_bom: false,
            lossy: false,
            read_only: false,
            base_modified_ms: 1_760_000_000_000,
            base_size: 42,
            base_sha256: Some("a".repeat(64)),
            updated_ms: 0,
        }
    }

    #[test]
    fn round_trip_write_list_and_remove() {
        let dir = temp_dir("round-trip");
        let _ = fs::remove_dir_all(&dir);

        let first = write_entry(&dir, entry("first")).unwrap();
        assert!(first.updated_ms > 0);
        std::thread::sleep(Duration::from_millis(2));
        write_entry(&dir, entry("second")).unwrap();

        let listed = list_entries(&dir).unwrap();
        assert_eq!(listed.len(), 2);
        // Newest first.
        assert_eq!(listed[0].id, "second");
        assert_eq!(listed[1].id, "first");
        assert_eq!(listed[1].content, "unsaved text\n");
        assert_eq!(listed[1].base_modified_ms, 1_760_000_000_000);

        remove_entry(&dir, "first").unwrap();
        remove_entry(&dir, "first").unwrap(); // missing is success
        let listed = list_entries(&dir).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, "second");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_unsafe_ids() {
        let dir = temp_dir("unsafe");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        for id in ["", "../x", "a/b", "a\\b", "..", ".hidden", "space id"] {
            let error = write_entry(&dir, entry(id)).unwrap_err();
            assert!(!error.is_empty(), "{id:?} should be refused");
        }
        assert_eq!(list_entries(&dir).unwrap().len(), 0);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn older_entries_without_a_base_hash_still_load() {
        let dir = temp_dir("legacy-hash");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        // A journal written before GAP-032 has no baseSha256 key. It must load
        // with None, not be treated as corrupt and silently skipped.
        let mut value = serde_json::to_value(entry("legacy")).unwrap();
        value.as_object_mut().unwrap().remove("baseSha256");
        fs::write(
            dir.join("legacy.json"),
            serde_json::to_vec(&value).unwrap(),
        )
        .unwrap();

        let listed = list_entries(&dir).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, "legacy");
        assert_eq!(listed[0].base_sha256, None);
        // A new write of the same entry carries a hash again.
        let mut rewritten = listed[0].clone();
        rewritten.base_sha256 = Some("b".repeat(64));
        let stored = write_entry(&dir, rewritten).unwrap();
        assert_eq!(stored.base_sha256, Some("b".repeat(64)));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn ignores_corrupt_and_temporary_files() {
        let dir = temp_dir("corrupt");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("bad.json"), b"{ not json").unwrap();
        fs::write(dir.join("note.txt"), b"not an entry").unwrap();
        fs::write(dir.join("pending.json.tmp"), b"{ not json").unwrap();

        assert!(list_entries(&dir).unwrap().is_empty());
        // A valid entry still survives next to the noise.
        write_entry(&dir, entry("good")).unwrap();
        assert_eq!(list_entries(&dir).unwrap().len(), 1);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn caps_content() {
        let dir = temp_dir("content-cap");
        let _ = fs::remove_dir_all(&dir);
        let mut big = entry("big");
        big.content = "x".repeat(MAX_CONTENT_BYTES + 1);
        let error = write_entry(&dir, big).unwrap_err();
        assert!(error.contains("too large"), "{error}");
        assert_eq!(list_entries(&dir).unwrap().len(), 0);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn caps_entry_count() {
        let dir = temp_dir("entry-cap");
        let _ = fs::remove_dir_all(&dir);
        for index in 0..MAX_ENTRIES {
            write_entry(&dir, entry(&format!("entry-{index}"))).unwrap();
        }
        let error = write_entry(&dir, entry("overflow")).unwrap_err();
        assert!(error.contains("full"), "{error}");
        // Replacing an existing entry is still allowed at the cap.
        write_entry(&dir, entry("entry-0")).unwrap();
        let _ = fs::remove_dir_all(&dir);
    }
}
