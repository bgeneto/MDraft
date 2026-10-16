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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    /// Lower-cased extension without the dot; empty for directories.
    pub ext: String,
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

    Ok(DocumentPayload {
        path: p.to_string_lossy().to_string(),
        name: display_name(&p),
        directory: p
            .parent()
            .map(|d| d.to_string_lossy().to_string())
            .unwrap_or_default(),
        content,
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

    if let Some(parent) = p.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
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

#[tauri::command]
pub fn path_exists(path: String) -> bool {
    Path::new(&path).exists()
}

/// List one directory level for the sidebar file browser.
#[tauri::command]
pub fn list_directory(path: String, show_hidden: Option<bool>) -> Result<Vec<DirEntry>, String> {
    let dir = PathBuf::from(&path);
    let read = fs::read_dir(&dir).map_err(|e| format!("Could not list {path}: {e}"))?;
    let include_hidden = show_hidden.unwrap_or(false);

    let mut entries: Vec<DirEntry> = Vec::new();
    for item in read.flatten() {
        let name = item.file_name().to_string_lossy().to_string();
        if name.starts_with('.') && !include_hidden {
            continue;
        }
        let full = item.path();
        let is_dir = item.file_type().map(|t| t.is_dir()).unwrap_or(false);
        let ext = if is_dir {
            String::new()
        } else {
            full.extension()
                .map(|e| e.to_string_lossy().to_lowercase())
                .unwrap_or_default()
        };
        entries.push(DirEntry {
            name,
            path: full.to_string_lossy().to_string(),
            is_dir,
            ext,
        });
    }

    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    entries.truncate(2000);
    Ok(entries)
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
    fn round_trip_preserves_crlf_and_bom() {
        let dir = std::env::temp_dir().join(format!("tt-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("doc.md");
        fs::write(&file, "\u{feff}# Title\r\n\r\nbody\r\n").unwrap();

        let doc = read_document(file.to_string_lossy().to_string()).unwrap();
        assert!(doc.had_bom);
        assert_eq!(doc.line_ending, "\r\n");
        assert_eq!(doc.content, "# Title\n\nbody\n");

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
    fn listing_sorts_directories_first() {
        let dir = std::env::temp_dir().join(format!("tt-test3-{}", std::process::id()));
        fs::create_dir_all(dir.join("zeta")).unwrap();
        fs::write(dir.join("alpha.md"), "x").unwrap();

        let entries = list_directory(dir.to_string_lossy().to_string(), Some(false)).unwrap();
        assert_eq!(entries[0].name, "zeta");
        assert!(entries[0].is_dir);
        assert_eq!(entries[1].name, "alpha.md");
        assert_eq!(entries[1].ext, "md");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn hidden_entries_are_opt_in() {
        let dir = std::env::temp_dir().join(format!("tt-test4-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(".hidden.md"), "x").unwrap();
        fs::write(dir.join("visible.md"), "x").unwrap();

        let without = list_directory(dir.to_string_lossy().to_string(), None).unwrap();
        assert_eq!(without.len(), 1);
        assert_eq!(without[0].name, "visible.md");

        let with = list_directory(dir.to_string_lossy().to_string(), Some(true)).unwrap();
        assert_eq!(with.len(), 2);
        let _ = fs::remove_dir_all(&dir);
    }
}
