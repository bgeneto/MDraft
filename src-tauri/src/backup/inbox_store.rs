//! Durable, bounded reads and revisions for restored unsaved documents.

use super::{
    gate,
    inbox::{self, InboxIndex, RecoveredDocument},
    snapshot,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::Manager;

const CHUNK: usize = 128 * 1024;
const MAX_DOCUMENT: u64 = 16 * 1024 * 1024 * 1024;
const MAX_TRANSFERS: usize = 16;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub inbox_id: String,
    pub document: RecoveredDocument,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Chunk {
    pub bytes: Vec<u8>,
    pub finished: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ItemRef {
    inbox_id: String,
    document_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveCopiesResult {
    saved: Vec<String>,
    failed: Vec<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Revision {
    pub version: u32,
    pub sha256: String,
    pub bytes: u64,
}

struct Reading {
    file: File,
    hash: Sha256,
    read: u64,
    expected: Revision,
}

struct Writing {
    _lease: gate::Lease<'static>,
    file: File,
    temporary: PathBuf,
    directory: PathBuf,
    inbox_id: String,
    document_id: String,
    hash: Sha256,
    bytes: u64,
    sequence: u64,
}

#[derive(Default)]
pub struct Transfers {
    reads: Mutex<HashMap<String, Reading>>,
    writes: Mutex<HashMap<String, Writing>>,
}

fn valid_hash(hash: &str) -> bool {
    hash.len() == 64
        && hash
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut result = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        result.push(DIGITS[(byte >> 4) as usize] as char);
        result.push(DIGITS[(byte & 15) as usize] as char);
    }
    result
}

fn directory(path: &Path) -> Result<(), String> {
    let meta = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if snapshot::is_link(&meta) || !meta.is_dir() {
        return Err("A recovered-document folder is unsafe.".into());
    }
    Ok(())
}

fn item_dir(config: &Path, inbox_id: &str) -> Result<PathBuf, String> {
    if !inbox::valid_id(inbox_id) {
        return Err("Invalid recovered-document identity.".into());
    }
    directory(config)?;
    let root = config.join("recovered-backups");
    directory(&root)?;
    let item = root.join(inbox_id);
    directory(&item)?;
    Ok(item)
}

fn index_at(path: &Path) -> Result<InboxIndex, String> {
    let index: InboxIndex = inbox::read_bounded(&path.join("index.json"), inbox::MAX_METADATA)?;
    if index.version != inbox::INBOX_VERSION || index.documents.len() > inbox::MAX_DOCUMENTS {
        return Err("The recovered-document index is not supported.".into());
    }
    let mut seen = std::collections::HashSet::new();
    for document in &index.documents {
        if !inbox::valid_id(&document.id)
            || !inbox::valid_id(&document.original_id)
            || !valid_hash(&document.sha256)
            || document.bytes > MAX_DOCUMENT
            || !seen.insert(&document.id)
        {
            return Err("The recovered-document index is invalid.".into());
        }
    }
    Ok(index)
}

fn lookup(
    config: &Path,
    inbox_id: &str,
    document_id: &str,
) -> Result<(PathBuf, RecoveredDocument), String> {
    if !inbox::valid_id(document_id) {
        return Err("Invalid recovered-document identity.".into());
    }
    let root = item_dir(config, inbox_id)?;
    let doc = index_at(&root)?
        .documents
        .into_iter()
        .find(|item| item.id == document_id)
        .ok_or("The recovered document is no longer available.")?;
    Ok((root, doc))
}

pub(super) fn revision_at(
    root: &Path,
    document: &RecoveredDocument,
) -> Result<(PathBuf, Revision), String> {
    let revisions = root.join("revisions");
    match fs::symlink_metadata(&revisions) {
        Ok(_) => directory(&revisions)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            directory(&root.join("texts"))?;
            return Ok((
                root.join("texts").join(format!("{}.txt", document.id)),
                Revision {
                    version: 1,
                    sha256: document.sha256.clone(),
                    bytes: document.bytes,
                },
            ));
        }
        Err(error) => return Err(error.to_string()),
    }
    let doc_dir = revisions.join(&document.id);
    match fs::symlink_metadata(&doc_dir) {
        Ok(_) => directory(&doc_dir)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            directory(&root.join("texts"))?;
            return Ok((
                root.join("texts").join(format!("{}.txt", document.id)),
                Revision {
                    version: 1,
                    sha256: document.sha256.clone(),
                    bytes: document.bytes,
                },
            ));
        }
        Err(error) => return Err(error.to_string()),
    }
    let current = doc_dir.join("current.json");
    match fs::symlink_metadata(&current) {
        Ok(_) => {
            let revision: Revision = inbox::read_bounded(&current, inbox::MAX_METADATA)?;
            if revision.version != 1
                || !valid_hash(&revision.sha256)
                || revision.bytes > MAX_DOCUMENT
            {
                return Err("A recovered-document revision is invalid.".into());
            }
            Ok((doc_dir.join(format!("{}.txt", revision.sha256)), revision))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            directory(&root.join("texts"))?;
            Ok((
                root.join("texts").join(format!("{}.txt", document.id)),
                Revision {
                    version: 1,
                    sha256: document.sha256.clone(),
                    bytes: document.bytes,
                },
            ))
        }
        Err(error) => Err(error.to_string()),
    }
}

fn open(path: &Path) -> Result<File, String> {
    snapshot::open_regular(
        path.parent().ok_or("Invalid recovered text.")?,
        Path::new(path.file_name().ok_or("Invalid recovered text name.")?),
    )
}

fn private_file(path: &Path) -> Result<File, String> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path).map_err(|error| error.to_string())
}

fn create_directory(path: &Path) -> Result<(), String> {
    match fs::create_dir(path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error.to_string()),
    }
    directory(path)
}

fn atomic_json<T: Serialize>(path: &Path, token: &str, value: &T) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(value).map_err(|error| error.to_string())?;
    if bytes.len() as u64 > inbox::MAX_METADATA {
        return Err("Recovered-document metadata is too large.".into());
    }
    let temp = path
        .parent()
        .ok_or("Invalid recovered metadata.")?
        .join(format!(".{token}.tmp"));
    let mut file = private_file(&temp)?;
    file.write_all(&bytes)
        .and_then(|()| file.sync_all())
        .map_err(|error| error.to_string())?;
    fs::rename(&temp, path).map_err(|error| error.to_string())?;
    #[cfg(unix)]
    File::open(path.parent().ok_or("Invalid recovered metadata.")?)
        .and_then(|file| file.sync_all())
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn config(app: &tauri::AppHandle, window: &tauri::WebviewWindow) -> Result<PathBuf, String> {
    if window.label() != "main" {
        return Err("Only the main window can manage recovered documents.".into());
    }
    app.path()
        .app_config_dir()
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn list_recovered_documents(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<Vec<Item>, String> {
    let config = config(&app, &window)?;
    let root = config.join("recovered-backups");
    match fs::symlink_metadata(&root) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.to_string()),
        Ok(_) => directory(&root)?,
    }
    let mut items = Vec::new();
    for entry in fs::read_dir(&root).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let name = entry
            .file_name()
            .to_str()
            .ok_or("Invalid recovery inbox name.")?
            .to_owned();
        let folder = item_dir(&config, &name)?;
        for document in index_at(&folder)?.documents {
            items.push(Item {
                inbox_id: name.clone(),
                document,
            });
        }
        if items.len() > inbox::MAX_DOCUMENTS {
            return Err("Too many recovered documents.".into());
        }
    }
    Ok(items)
}

#[tauri::command]
pub fn begin_recovered_read(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Transfers>,
    inbox_id: String,
    document_id: String,
    transfer_id: String,
) -> Result<(), String> {
    if !inbox::valid_id(&transfer_id) {
        return Err("Invalid transfer identity.".into());
    }
    let (root, doc) = lookup(&config(&app, &window)?, &inbox_id, &document_id)?;
    let (path, expected) = revision_at(&root, &doc)?;
    let file = open(&path)?;
    if file.metadata().map_err(|error| error.to_string())?.len() != expected.bytes {
        return Err("Recovered text has an unexpected size.".into());
    }
    let mut reads = state
        .reads
        .lock()
        .map_err(|_| "The recovery reader is unavailable.")?;
    if reads.len() >= MAX_TRANSFERS || reads.contains_key(&transfer_id) {
        return Err("Too many recovery reads are active.".into());
    }
    reads.insert(
        transfer_id,
        Reading {
            file,
            hash: Sha256::new(),
            read: 0,
            expected,
        },
    );
    Ok(())
}

#[tauri::command]
pub fn read_recovered_chunk(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Transfers>,
    transfer_id: String,
) -> Result<Chunk, String> {
    if window.label() != "main" {
        return Err("Invalid recovery reader.".into());
    }
    let mut reads = state
        .reads
        .lock()
        .map_err(|_| "The recovery reader is unavailable.")?;
    let reader = reads
        .get_mut(&transfer_id)
        .ok_or("The recovery read is no longer available.")?;
    let mut bytes = vec![0; CHUNK];
    let count = reader
        .file
        .read(&mut bytes)
        .map_err(|error| error.to_string())?;
    bytes.truncate(count);
    reader.read = reader
        .read
        .checked_add(count as u64)
        .ok_or("Recovered text is too large.")?;
    reader.hash.update(&bytes);
    if count == 0 {
        let reader = reads
            .remove(&transfer_id)
            .ok_or("The recovery read disappeared.")?;
        let actual = hex(&reader.hash.finalize());
        if reader.read != reader.expected.bytes || actual != reader.expected.sha256 {
            return Err("Recovered text failed its integrity check.".into());
        }
        return Ok(Chunk {
            bytes,
            finished: true,
        });
    }
    if reader.read > reader.expected.bytes {
        reads.remove(&transfer_id);
        return Err("Recovered text changed while reading.".into());
    }
    Ok(Chunk {
        bytes,
        finished: false,
    })
}

#[tauri::command]
pub fn cancel_recovered_read(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Transfers>,
    transfer_id: String,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Invalid recovery reader.".into());
    }
    state
        .reads
        .lock()
        .map_err(|_| "The recovery reader is unavailable.")?
        .remove(&transfer_id);
    Ok(())
}

#[tauri::command]
pub fn begin_recovered_revision(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Transfers>,
    inbox_id: String,
    document_id: String,
    transfer_id: String,
) -> Result<(), String> {
    if !inbox::valid_id(&transfer_id) {
        return Err("Invalid transfer identity.".into());
    }
    let lease = gate::lease()?;
    let (root, _) = lookup(&config(&app, &window)?, &inbox_id, &document_id)?;
    let revisions = root.join("revisions");
    create_directory(&revisions)?;
    let dir = revisions.join(&document_id);
    create_directory(&dir)?;
    let mut writes = state
        .writes
        .lock()
        .map_err(|_| "The recovery writer is unavailable.")?;
    if writes.len() >= MAX_TRANSFERS
        || writes.contains_key(&transfer_id)
        || writes
            .values()
            .any(|w| w.inbox_id == inbox_id && w.document_id == document_id)
    {
        return Err("A revision of this recovered document is already being saved.".into());
    }
    let temporary = dir.join(format!("incoming-{transfer_id}.tmp"));
    let file = private_file(&temporary)?;
    writes.insert(
        transfer_id,
        Writing {
            _lease: lease,
            file,
            temporary,
            directory: dir,
            inbox_id,
            document_id,
            hash: Sha256::new(),
            bytes: 0,
            sequence: 0,
        },
    );
    Ok(())
}

#[tauri::command]
pub fn append_recovered_revision(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Transfers>,
    transfer_id: String,
    sequence: u64,
    bytes: Vec<u8>,
) -> Result<u64, String> {
    if window.label() != "main" {
        return Err("Invalid recovery writer.".into());
    }
    let mut writes = state
        .writes
        .lock()
        .map_err(|_| "The recovery writer is unavailable.")?;
    let writer = writes
        .get_mut(&transfer_id)
        .ok_or("The recovery revision is no longer available.")?;
    if bytes.is_empty() || bytes.len() > CHUNK || writer.sequence != sequence {
        return Err("A recovered-document chunk is invalid or out of order.".into());
    }
    writer.bytes = writer
        .bytes
        .checked_add(bytes.len() as u64)
        .filter(|size| *size <= MAX_DOCUMENT)
        .ok_or("Recovered text is too large.")?;
    writer
        .file
        .write_all(&bytes)
        .map_err(|error| error.to_string())?;
    writer.hash.update(&bytes);
    writer.sequence += 1;
    Ok(writer.bytes)
}

#[tauri::command]
pub fn finish_recovered_revision(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Transfers>,
    transfer_id: String,
    sequences: u64,
    bytes: u64,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Invalid recovery writer.".into());
    }
    let writer = state
        .writes
        .lock()
        .map_err(|_| "The recovery writer is unavailable.")?
        .remove(&transfer_id)
        .ok_or("The recovery revision is no longer available.")?;
    if writer.sequence != sequences || writer.bytes != bytes {
        return Err("The recovered-document revision is incomplete.".into());
    }
    writer.file.sync_all().map_err(|error| error.to_string())?;
    inbox::is_utf8(&writer.temporary)?;
    let hash = hex(&writer.hash.clone().finalize());
    drop(writer.file);
    let dest = writer.directory.join(format!("{hash}.txt"));
    if dest.exists() {
        let mut existing = open(&dest)?;
        let (count, actual) =
            super::format::copy_hashed(&mut existing, &mut std::io::sink(), MAX_DOCUMENT)?;
        if count != bytes || actual != hash {
            return Err("An existing recovery revision is damaged; it was preserved.".into());
        }
        fs::remove_file(&writer.temporary).map_err(|error| error.to_string())?;
    } else {
        fs::rename(&writer.temporary, &dest).map_err(|error| error.to_string())?;
    }
    atomic_json(
        &writer.directory.join("current.json"),
        &transfer_id,
        &Revision {
            version: 1,
            sha256: hash,
            bytes,
        },
    )
}

#[tauri::command]
pub fn cancel_recovered_revision(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Transfers>,
    transfer_id: String,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Invalid recovery writer.".into());
    }
    if let Some(writer) = state
        .writes
        .lock()
        .map_err(|_| "The recovery writer is unavailable.")?
        .remove(&transfer_id)
    {
        drop(writer.file);
        fs::remove_file(writer.temporary).map_err(|error| error.to_string())?;
    }
    Ok(())
}

/// Remove an inbox item only after an explicit discard or a successful save.
/// An unexpected file is left in place and reported for manual inspection.
#[tauri::command]
pub fn forget_recovered_document(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Transfers>,
    inbox_id: String,
    document_id: String,
    token: String,
) -> Result<(), String> {
    if !inbox::valid_id(&token) {
        return Err("Invalid recovery operation identity.".into());
    }
    let _lease = gate::close_lease()?;
    let config = config(&app, &window)?;
    let (root, document) = lookup(&config, &inbox_id, &document_id)?;
    let writes = state
        .writes
        .lock()
        .map_err(|_| "The recovery writer is unavailable.")?;
    if writes
        .values()
        .any(|writer| writer.inbox_id == inbox_id && writer.document_id == document_id)
    {
        return Err("Wait for the recovered document to finish saving.".into());
    }
    forget_inner(&root, &document, &token)
}

fn forget_inner(root: &Path, document: &RecoveredDocument, token: &str) -> Result<(), String> {
    let mut index = index_at(root)?;
    index.documents.retain(|item| item.id != document.id);
    atomic_json(&root.join("index.json"), token, &index)?;
    let mut preserved = false;
    let original = root.join("texts").join(format!("{}.txt", document.id));
    if original.exists() {
        let mut file = open(&original)?;
        let (bytes, hash) =
            super::format::copy_hashed(&mut file, &mut std::io::sink(), MAX_DOCUMENT)?;
        drop(file);
        if bytes == document.bytes && hash == document.sha256 {
            fs::remove_file(&original).map_err(|error| error.to_string())?;
        } else {
            preserved = true;
        }
    }
    let revisions = root.join("revisions").join(&document.id);
    if revisions.exists() {
        directory(&root.join("revisions"))?;
        directory(&revisions)?;
        for entry in fs::read_dir(&revisions).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            let name = entry.file_name().to_string_lossy().to_string();
            let path = entry.path();
            if name == "current.json" {
                let _: Revision = inbox::read_bounded(&path, inbox::MAX_METADATA)?;
                fs::remove_file(path).map_err(|error| error.to_string())?;
            } else if let Some(hash) = name.strip_suffix(".txt").filter(|value| valid_hash(value)) {
                let mut file = open(&path)?;
                let (_, actual) =
                    super::format::copy_hashed(&mut file, &mut std::io::sink(), MAX_DOCUMENT)?;
                drop(file);
                if actual == hash {
                    fs::remove_file(path).map_err(|error| error.to_string())?;
                } else {
                    preserved = true;
                }
            } else {
                preserved = true;
            }
        }
        let _ = fs::remove_dir(&revisions);
        let _ = fs::remove_dir(root.join("revisions"));
    }
    if preserved {
        return Err("The recovered copy was removed from the list, but unexpected files were preserved in its recovery folder.".into());
    }
    Ok(())
}

fn safe_copy_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("");
    let mut clean = String::new();
    for ch in base.chars() {
        let ch = if ch.is_control()
            || matches!(ch, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
        {
            '_'
        } else {
            ch
        };
        if clean.len() + ch.len_utf8() > 100 {
            break;
        }
        clean.push(ch);
    }
    let clean = clean.trim_matches([' ', '.']);
    let clean = if clean.is_empty() {
        "document.txt"
    } else {
        clean
    };
    format!("Recovered-{clean}")
}

fn copy_name_with_suffix(name: &str, suffix: usize) -> String {
    if suffix == 0 {
        return name.into();
    }
    if let Some((stem, extension)) = name.rsplit_once('.')
        && !stem.is_empty()
        && !extension.is_empty()
    {
        return format!("{stem}-{suffix}.{extension}");
    }
    format!("{name}-{suffix}")
}

/// Save independent UTF-8 copies using exclusive creation; never overwrite an
/// existing file. A successfully saved copy is acknowledged one item at a time.
#[tauri::command]
pub fn save_recovered_copies(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Transfers>,
    folder: String,
    items: Vec<ItemRef>,
    token: String,
) -> Result<SaveCopiesResult, String> {
    if !inbox::valid_id(&token) || items.is_empty() || items.len() > inbox::MAX_DOCUMENTS {
        return Err("The recovered-document selection is invalid.".into());
    }
    let _lease = gate::lease()?;
    let config = config(&app, &window)?;
    let destination = PathBuf::from(folder);
    if !destination.is_absolute() {
        return Err("Choose an absolute destination folder.".into());
    }
    directory(&destination)?;
    let destination = fs::canonicalize(&destination).map_err(|error| error.to_string())?;
    for root in [
        &config,
        &app.path()
            .app_data_dir()
            .map_err(|error| error.to_string())?,
    ] {
        if let Ok(root) = fs::canonicalize(root)
            && destination.starts_with(root)
        {
            return Err("Choose a folder outside MDraft's application data.".into());
        }
    }
    let writes = state
        .writes
        .lock()
        .map_err(|_| "The recovery writer is unavailable.")?;
    let mut result = SaveCopiesResult {
        saved: Vec::new(),
        failed: Vec::new(),
    };
    for (index, item) in items.into_iter().enumerate() {
        let operation = (|| -> Result<String, String> {
            if writes.values().any(|writer| {
                writer.inbox_id == item.inbox_id && writer.document_id == item.document_id
            }) {
                return Err("A recovered document is still being edited.".into());
            }
            let (root, document) = lookup(&config, &item.inbox_id, &item.document_id)?;
            let (source, revision) = revision_at(&root, &document)?;
            let mut input = open(&source)?;
            let partial = destination.join(format!(".mdraft-recovered-{token}-{index}.partial"));
            let mut output = private_file(&partial)?;
            let copied = super::format::copy_hashed(&mut input, &mut output, MAX_DOCUMENT);
            output.sync_all().map_err(|error| {
                format!(
                    "Could not finish the copy at {}: {error}",
                    partial.display()
                )
            })?;
            drop(output);
            let (bytes, hash) = copied.map_err(|error| {
                format!("Could not write the copy at {}: {error}", partial.display())
            })?;
            if bytes != revision.bytes || hash != revision.sha256 {
                return Err(format!(
                    "Recovered text failed verification; the incomplete copy remains at {}.",
                    partial.display()
                ));
            }
            let name = safe_copy_name(&document.name);
            let mut target = None;
            for suffix in 0..10_000 {
                let candidate = copy_name_with_suffix(&name, suffix);
                let path = destination.join(candidate);
                match super::jobs::publish_new(&partial, &path) {
                    Ok(()) => {
                        target = Some(path);
                        break;
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                    Err(error) => {
                        return Err(format!(
                            "Could not finish the copy; its verified temporary file is at {}: {error}",
                            partial.display()
                        ));
                    }
                }
            }
            let target = target.ok_or("Too many files with the same recovered name.")?;
            forget_inner(&root, &document, &format!("{token}-{index}")).map_err(|error| {
                format!(
                    "Saved {}, but could not clear its recovery entry: {error}",
                    target.display()
                )
            })?;
            Ok(target.to_string_lossy().into_owned())
        })();
        match operation {
            Ok(path) => result.saved.push(path),
            Err(error) => result.failed.push(error),
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recovered_names_are_safe_bounded_and_keep_the_extension() {
        assert_eq!(safe_copy_name("../../Draft.md"), "Recovered-Draft.md");
        assert_eq!(safe_copy_name("..\\CON"), "Recovered-CON");
        assert!(!safe_copy_name("a:b*?.md").contains([':', '*', '?']));
        assert!(safe_copy_name(&"世".repeat(200)).len() <= 110);
        assert_eq!(
            copy_name_with_suffix("Recovered-Draft.md", 2),
            "Recovered-Draft-2.md"
        );
    }
}
