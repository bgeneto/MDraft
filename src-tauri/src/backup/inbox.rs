//! Convert archived unsaved writing into independent recovered copies.

use super::format::{self, Manifest};
use super::snapshot;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::Path;

const SESSION_VERSION: u32 = 1;
pub(super) const INBOX_VERSION: u32 = 1;
pub(super) const MAX_METADATA: u64 = 16 * 1024 * 1024;
const MAX_JOURNAL: u64 = 32 * 1024 * 1024;
pub(super) const MAX_DOCUMENTS: usize = 100_000;
const CHUNK: usize = 128 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Buffer {
    pub id: String,
    pub name: String,
    pub language: String,
    pub path: Option<String>,
    pub line_ending: String,
    pub had_bom: bool,
    pub encoding: Option<String>,
    pub lossy: bool,
    pub read_only: bool,
    pub base_modified_ms: u64,
    pub base_size: u64,
    pub base_sha256: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionSnapshot {
    pub version: u32,
    pub active_id: Option<String>,
    pub buffers: Vec<Buffer>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecoveredDocument {
    pub id: String,
    pub original_id: String,
    pub original_path: Option<String>,
    pub name: String,
    pub language: String,
    pub line_ending: String,
    pub had_bom: bool,
    pub encoding: Option<String>,
    pub lossy: bool,
    pub read_only: bool,
    pub base_modified_ms: u64,
    pub base_size: u64,
    pub base_sha256: Option<String>,
    pub sha256: String,
    pub bytes: u64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InboxIndex {
    pub version: u32,
    pub source_app_version: String,
    pub source_created_at_ms: u64,
    pub active_original_id: Option<String>,
    pub documents: Vec<RecoveredDocument>,
    pub salvaged_journals: usize,
    #[serde(default)]
    pub preserved_files: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PreservedFile {
    archive_path: String,
    stored_name: String,
    sha256: String,
    bytes: u64,
}

pub(super) fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

pub(super) fn read_bounded<T: for<'de> Deserialize<'de>>(
    path: &Path,
    max: u64,
) -> Result<T, String> {
    let meta = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if snapshot::is_link(&meta) || !meta.is_file() || meta.len() > max {
        return Err("Recovered document metadata is unsafe or too large.".into());
    }
    let parent = path
        .parent()
        .ok_or("Invalid recovered document metadata.")?;
    let name = path
        .file_name()
        .ok_or("Invalid recovered document metadata.")?;
    let mut file = snapshot::open_regular(parent, Path::new(name))?;
    let mut bytes = Vec::with_capacity(meta.len() as usize);
    Read::by_ref(&mut file)
        .take(max + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() as u64 > max {
        return Err("Recovered document metadata is too large.".into());
    }
    serde_json::from_slice(&bytes)
        .map_err(|error| format!("Recovered document metadata is invalid: {error}"))
}

fn create_private(path: &Path) -> Result<File, String> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path).map_err(|error| error.to_string())
}

pub(super) fn is_utf8(path: &Path) -> Result<(), String> {
    is_utf8_with(path, &mut |_| Ok(()))
}

fn is_utf8_with(
    path: &Path,
    progress: &mut impl FnMut(u64) -> Result<(), String>,
) -> Result<(), String> {
    let mut file = snapshot::open_regular(
        path.parent().ok_or("Invalid buffer path.")?,
        Path::new(path.file_name().ok_or("Invalid buffer name.")?),
    )?;
    let mut buffer = vec![0_u8; CHUNK + 4];
    let mut remaining = 0;
    loop {
        progress(0)?;
        let count = file
            .read(&mut buffer[remaining..])
            .map_err(|error| error.to_string())?;
        if count == 0 {
            return if remaining == 0 {
                Ok(())
            } else {
                Err("A recovered document is not valid UTF-8.".into())
            };
        }
        progress(count as u64)?;
        let bytes = &buffer[..remaining + count];
        match std::str::from_utf8(bytes) {
            Ok(_) => remaining = 0,
            Err(error) if error.error_len().is_none() => {
                remaining = bytes.len() - error.valid_up_to();
                buffer.copy_within(error.valid_up_to()..error.valid_up_to() + remaining, 0);
            }
            Err(_) => return Err("A recovered document is not valid UTF-8.".into()),
        }
    }
}

fn item_id(original: &str, hash: &str) -> String {
    let hash = crate::export::sha256_hex(format!("{original}\0{hash}").as_bytes());
    format!("r-{}", &hash[..32])
}

fn copy_checked_with(
    source: &Path,
    destination: &Path,
    size: u64,
    expected: &str,
    progress: &mut impl FnMut(u64) -> Result<(), String>,
) -> Result<(), String> {
    let mut input = snapshot::open_regular(
        source.parent().ok_or("Invalid source.")?,
        Path::new(source.file_name().ok_or("Invalid source name.")?),
    )?;
    let mut output = create_private(destination)?;
    let (bytes, hash) = format::copy_hashed_with(&mut input, &mut output, size, progress)?;
    if bytes != size || hash != expected {
        return Err("A recovered document changed after backup validation.".into());
    }
    output.sync_all().map_err(|error| error.to_string())
}

fn recovered(buffer: Buffer, sha256: String, bytes: u64) -> Result<RecoveredDocument, String> {
    if !valid_id(&buffer.id) || buffer.name.len() > 4096 || buffer.language.len() > 64 {
        return Err("A recovered document has invalid metadata.".into());
    }
    if !matches!(buffer.line_ending.as_str(), "\n" | "\r\n") {
        return Err("A recovered document has an invalid line ending.".into());
    }
    Ok(RecoveredDocument {
        id: item_id(&buffer.id, &sha256),
        original_id: buffer.id,
        original_path: buffer.path,
        name: buffer.name,
        language: buffer.language,
        line_ending: buffer.line_ending,
        had_bom: buffer.had_bom,
        encoding: buffer.encoding,
        lossy: buffer.lossy,
        read_only: buffer.read_only,
        base_modified_ms: buffer.base_modified_ms,
        base_size: buffer.base_size,
        base_sha256: buffer.base_sha256,
        sha256,
        bytes,
    })
}

/// Build a new inbox from a previously verified and privately extracted ZIP.
/// Current buffer snapshots supersede matching older crash-journal entries.
#[cfg(test)]
pub fn build(
    extracted: &Path,
    destination: &Path,
    manifest: &Manifest,
    existing: &HashSet<(String, String)>,
) -> Result<InboxIndex, String> {
    build_with(extracted, destination, manifest, existing, &mut |_| Ok(()))
}

pub fn build_with(
    extracted: &Path,
    destination: &Path,
    manifest: &Manifest,
    existing: &HashSet<(String, String)>,
    progress: &mut impl FnMut(u64) -> Result<(), String>,
) -> Result<InboxIndex, String> {
    fs::create_dir(destination).map_err(|error| error.to_string())?;
    let texts = destination.join("texts");
    fs::create_dir(&texts).map_err(|error| error.to_string())?;
    let entries: HashMap<_, _> = manifest
        .entries
        .iter()
        .map(|entry| (entry.path.as_str(), entry))
        .collect();
    let mut index = InboxIndex {
        version: INBOX_VERSION,
        source_app_version: manifest.app_version.clone(),
        source_created_at_ms: manifest.created_at_ms,
        active_original_id: None,
        documents: Vec::new(),
        salvaged_journals: 0,
        preserved_files: 0,
    };
    let mut seen = existing.clone();
    let mut live_ids = HashSet::new();
    let mut consumed_buffers = HashSet::new();
    if entries.contains_key("session/session.json") {
        let session: SessionSnapshot =
            read_bounded(&extracted.join("session/session.json"), MAX_METADATA)?;
        if session.version != SESSION_VERSION || session.buffers.len() > MAX_DOCUMENTS {
            return Err("This backup's open-document version is not supported.".into());
        }
        index.active_original_id = session.active_id;
        for buffer in session.buffers {
            progress(0)?;
            if !valid_id(&buffer.id) || !live_ids.insert(buffer.id.clone()) {
                return Err(
                    "The backup has an invalid or duplicate open-document identity.".into(),
                );
            }
            let path = format!("session/buffers/{}.txt", buffer.id);
            consumed_buffers.insert(path.clone());
            let entry = entries
                .get(path.as_str())
                .ok_or("An unsaved document is missing from the backup.")?;
            let source = extracted.join(&path);
            is_utf8_with(&source, progress)?;
            let document = recovered(buffer, entry.sha256.clone(), entry.bytes)?;
            if seen.insert((document.original_id.clone(), document.sha256.clone())) {
                copy_checked_with(
                    &source,
                    &texts.join(format!("{}.txt", document.id)),
                    entry.bytes,
                    &entry.sha256,
                    progress,
                )?;
                index.documents.push(document);
            }
        }
    }
    if manifest.entries.iter().any(|entry| {
        entry.path.starts_with("session/buffers/") && !consumed_buffers.contains(&entry.path)
    }) {
        return Err("The backup has unsaved text without matching document metadata.".into());
    }
    let mut consumed_previous = HashSet::new();
    for entry in &manifest.entries {
        progress(0)?;
        let Some(relative) = entry.path.strip_prefix("config/recovered-backups/") else {
            continue;
        };
        let Some((backup_id, remainder)) = relative.split_once('/') else {
            continue;
        };
        if !valid_id(backup_id) || remainder != "index.json" {
            continue;
        }
        consumed_previous.insert(entry.path.clone());
        let previous: InboxIndex = read_bounded(&extracted.join(&entry.path), MAX_METADATA)?;
        if previous.version != INBOX_VERSION || previous.documents.len() > MAX_DOCUMENTS {
            return Err("A previous recovery inbox has an unsupported version.".into());
        }
        for document in previous.documents {
            if !valid_id(&document.id) || !valid_id(&document.original_id) {
                return Err("A previous recovered document has an invalid identity.".into());
            }
            let source_name = format!(
                "config/recovered-backups/{backup_id}/texts/{}.txt",
                document.id
            );
            let original = entries
                .get(source_name.as_str())
                .ok_or("A previously recovered document is missing.")?;
            consumed_previous.insert(source_name.clone());
            if original.sha256 != document.sha256 || original.bytes != document.bytes {
                return Err("A previous recovered document does not match its index.".into());
            }
            let revision_prefix = format!(
                "config/recovered-backups/{backup_id}/revisions/{}",
                document.id
            );
            let pointer_name = format!("{revision_prefix}/current.json");
            let (source_name, sha256, bytes) = if entries.contains_key(pointer_name.as_str()) {
                let revision: super::inbox_store::Revision =
                    read_bounded(&extracted.join(&pointer_name), MAX_METADATA)?;
                if revision.version != 1
                    || revision.sha256.len() != 64
                    || !revision
                        .sha256
                        .bytes()
                        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
                {
                    return Err("A previous recovered-document revision is invalid.".into());
                }
                let revision_name = format!("{revision_prefix}/{}.txt", revision.sha256);
                let revision_entry = entries
                    .get(revision_name.as_str())
                    .ok_or("A previous recovered-document revision is missing.")?;
                if revision_entry.sha256 != revision.sha256
                    || revision_entry.bytes != revision.bytes
                {
                    return Err(
                        "A previous recovered-document revision does not match its index.".into(),
                    );
                }
                consumed_previous.insert(pointer_name);
                consumed_previous.insert(revision_name.clone());
                (revision_name, revision.sha256, revision.bytes)
            } else {
                (source_name, document.sha256.clone(), document.bytes)
            };
            let source = extracted.join(&source_name);
            is_utf8_with(&source, progress)?;
            let document = recovered(
                Buffer {
                    id: document.original_id,
                    name: document.name,
                    language: document.language,
                    path: document.original_path,
                    line_ending: document.line_ending,
                    had_bom: document.had_bom,
                    encoding: document.encoding,
                    lossy: document.lossy,
                    read_only: document.read_only,
                    base_modified_ms: document.base_modified_ms,
                    base_size: document.base_size,
                    base_sha256: document.base_sha256,
                },
                sha256,
                bytes,
            )?;
            if seen.insert((document.original_id.clone(), document.sha256.clone())) {
                copy_checked_with(
                    &source,
                    &texts.join(format!("{}.txt", document.id)),
                    document.bytes,
                    &document.sha256,
                    progress,
                )?;
                index.documents.push(document);
            }
        }
    }
    // Retain files from older inboxes even when they are not active documents,
    // such as malformed journals or quarantined assets. Their original logical
    // names are recorded separately so repeated restore never silently loses them.
    let mut preserved = Vec::new();
    for entry in &manifest.entries {
        progress(0)?;
        if !entry.path.starts_with("config/recovered-backups/")
            || consumed_previous.contains(&entry.path)
        {
            continue;
        }
        let folder = destination.join("preserved");
        if !folder.exists() {
            fs::create_dir(&folder).map_err(|error| error.to_string())?;
        }
        let stored_name = format!(
            "{}.bin",
            &crate::export::sha256_hex(entry.path.as_bytes())[..32]
        );
        copy_checked_with(
            &extracted.join(&entry.path),
            &folder.join(&stored_name),
            entry.bytes,
            &entry.sha256,
            progress,
        )?;
        preserved.push(PreservedFile {
            archive_path: entry.path.clone(),
            stored_name,
            sha256: entry.sha256.clone(),
            bytes: entry.bytes,
        });
    }
    if !preserved.is_empty() {
        index.preserved_files = preserved.len();
        let bytes = serde_json::to_vec_pretty(&preserved).map_err(|error| error.to_string())?;
        if bytes.len() as u64 > MAX_METADATA {
            return Err("There are too many preserved recovery files to index.".into());
        }
        let mut file = create_private(&destination.join("preserved.json"))?;
        file.write_all(&bytes)
            .and_then(|()| file.sync_all())
            .map_err(|error| error.to_string())?;
    }
    for entry in &manifest.entries {
        progress(0)?;
        let Some(filename) = entry.path.strip_prefix("config/recovery/") else {
            continue;
        };
        if filename.contains('/') || !filename.ends_with(".json") {
            return Err("A crash-recovery file has an invalid name.".into());
        }
        let source = extracted.join(&entry.path);
        let parsed = read_bounded::<crate::recovery::RecoveryEntry>(&source, MAX_JOURNAL);
        match parsed {
            Ok(journal) if valid_id(&journal.id) && filename == format!("{}.json", journal.id) => {
                if live_ids.contains(&journal.id) {
                    continue;
                }
                let content = journal.content.into_bytes();
                let hash = crate::export::sha256_hex(&content);
                let buffer = Buffer {
                    id: journal.id,
                    name: journal.name,
                    language: journal.language,
                    path: journal.path,
                    line_ending: journal.line_ending,
                    had_bom: journal.had_bom,
                    encoding: journal.encoding,
                    lossy: journal.lossy,
                    read_only: journal.read_only,
                    base_modified_ms: journal.base_modified_ms,
                    base_size: journal.base_size,
                    base_sha256: journal.base_sha256,
                };
                let document = recovered(buffer, hash, content.len() as u64)?;
                if seen.insert((document.original_id.clone(), document.sha256.clone())) {
                    let mut output = create_private(&texts.join(format!("{}.txt", document.id)))?;
                    output
                        .write_all(&content)
                        .and_then(|()| output.sync_all())
                        .map_err(|error| error.to_string())?;
                    index.documents.push(document);
                }
            }
            _ => {
                let salvage = destination.join("salvage");
                if !salvage.exists() {
                    fs::create_dir(&salvage).map_err(|error| error.to_string())?;
                }
                let target = salvage.join(format!(
                    "{}.json",
                    &crate::export::sha256_hex(entry.path.as_bytes())[..32]
                ));
                copy_checked_with(&source, &target, entry.bytes, &entry.sha256, progress)?;
                index.salvaged_journals += 1;
            }
        }
        if index.documents.len() > MAX_DOCUMENTS {
            return Err("The backup contains too many recovered documents.".into());
        }
    }
    let bytes = serde_json::to_vec_pretty(&index).map_err(|error| error.to_string())?;
    if bytes.len() as u64 > MAX_METADATA {
        return Err("There are too many recovered documents to index.".into());
    }
    let mut file = create_private(&destination.join("index.json"))?;
    file.write_all(&bytes)
        .and_then(|()| file.sync_all())
        .map_err(|error| error.to_string())?;
    Ok(index)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backup::format::{Category, Entry};
    use std::collections::BTreeMap;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static NEXT: AtomicUsize = AtomicUsize::new(0);
    struct Scratch(PathBuf);

    impl Scratch {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "mdraft-backup-inbox-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            if self.0.parent() == Some(std::env::temp_dir().as_path())
                && self
                    .0
                    .file_name()
                    .is_some_and(|name| name.to_string_lossy().starts_with("mdraft-backup-inbox-"))
            {
                let _ = fs::remove_dir_all(&self.0);
            }
        }
    }

    fn metadata(id: &str) -> Buffer {
        Buffer {
            id: id.into(),
            name: "Draft.md".into(),
            language: "markdown".into(),
            path: Some("/external/original.md".into()),
            line_ending: "\n".into(),
            had_bom: false,
            encoding: Some("UTF-8".into()),
            lossy: false,
            read_only: false,
            base_modified_ms: 1,
            base_size: 2,
            base_sha256: None,
        }
    }

    fn manifest() -> Manifest {
        let names = [
            "settings",
            "prompts",
            "personal",
            "recovery",
            "session",
            "window",
            "downloads",
        ];
        Manifest {
            format: format::FORMAT.into(),
            format_version: 1,
            app_version: "0.9.1".into(),
            created_at_ms: 1,
            capture_started_ms: 1,
            capture_finished_ms: 2,
            source_os: "test".into(),
            source_arch: "test".into(),
            portable: false,
            component_versions: names.into_iter().map(|name| (name.into(), 1)).collect(),
            categories: names
                .into_iter()
                .map(|name| {
                    (
                        name.into(),
                        Category {
                            included: true,
                            present: true,
                        },
                    )
                })
                .collect::<BTreeMap<_, _>>(),
            directories: Vec::new(),
            entries: Vec::new(),
        }
    }

    fn add_file(root: &Path, manifest: &mut Manifest, name: &str, bytes: &[u8], category: &str) {
        let path = root.join(name);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, bytes).unwrap();
        manifest.entries.push(Entry {
            path: name.into(),
            category: category.into(),
            bytes: bytes.len() as u64,
            sha256: crate::export::sha256_hex(bytes),
            executable: false,
        });
    }

    #[test]
    fn current_snapshot_wins_over_journal_and_corrupt_data_is_preserved() {
        let temp = Scratch::new();
        let extracted = temp.0.join("extracted");
        fs::create_dir(&extracted).unwrap();
        let mut manifest = manifest();
        let session = SessionSnapshot {
            version: 1,
            active_id: Some("draft-1".into()),
            buffers: vec![metadata("draft-1")],
        };
        add_file(
            &extracted,
            &mut manifest,
            "session/session.json",
            &serde_json::to_vec(&session).unwrap(),
            "session",
        );
        add_file(
            &extracted,
            &mut manifest,
            "session/buffers/draft-1.txt",
            "current 世界".as_bytes(),
            "session",
        );
        let journal = crate::recovery::RecoveryEntry {
            id: "draft-1".into(),
            path: Some("/external/original.md".into()),
            name: "Draft.md".into(),
            language: "markdown".into(),
            content: "older text".into(),
            line_ending: "\n".into(),
            had_bom: false,
            encoding: None,
            lossy: false,
            read_only: false,
            base_modified_ms: 1,
            base_size: 2,
            base_sha256: None,
            updated_ms: 3,
        };
        add_file(
            &extracted,
            &mut manifest,
            "config/recovery/draft-1.json",
            &serde_json::to_vec(&journal).unwrap(),
            "recovery",
        );
        add_file(
            &extracted,
            &mut manifest,
            "config/recovery/broken.json",
            b"{not valid",
            "recovery",
        );
        let inbox = temp.0.join("inbox");
        let index = build(&extracted, &inbox, &manifest, &HashSet::new()).unwrap();
        assert_eq!(index.documents.len(), 1);
        assert_eq!(index.salvaged_journals, 1);
        assert_eq!(
            index.documents[0].original_path.as_deref(),
            Some("/external/original.md")
        );
        assert_eq!(
            fs::read_to_string(
                inbox
                    .join("texts")
                    .join(format!("{}.txt", index.documents[0].id))
            )
            .unwrap(),
            "current 世界"
        );
        assert_eq!(fs::read_dir(inbox.join("salvage")).unwrap().count(), 1);
    }

    #[test]
    fn refuses_orphaned_and_invalid_text() {
        let temp = Scratch::new();
        let extracted = temp.0.join("extracted");
        fs::create_dir(&extracted).unwrap();
        let mut manifest = manifest();
        add_file(
            &extracted,
            &mut manifest,
            "session/buffers/a.txt",
            b"orphan",
            "session",
        );
        assert!(
            build(
                &extracted,
                &temp.0.join("orphan"),
                &manifest,
                &HashSet::new()
            )
            .err()
            .unwrap()
            .contains("metadata")
        );
        let session = SessionSnapshot {
            version: 1,
            active_id: None,
            buffers: vec![metadata("a")],
        };
        add_file(
            &extracted,
            &mut manifest,
            "session/session.json",
            &serde_json::to_vec(&session).unwrap(),
            "session",
        );
        fs::write(extracted.join("session/buffers/a.txt"), [0xff]).unwrap();
        assert!(
            build(
                &extracted,
                &temp.0.join("invalid"),
                &manifest,
                &HashSet::new()
            )
            .err()
            .unwrap()
            .contains("UTF-8")
        );
    }

    #[test]
    fn utf8_validation_handles_a_character_split_across_chunks() {
        let temp = Scratch::new();
        let path = temp.0.join("large.txt");
        let mut bytes = vec![b'a'; CHUNK + 3];
        bytes.extend_from_slice("🌎".as_bytes());
        fs::write(&path, bytes).unwrap();
        assert!(is_utf8(&path).is_ok());
    }

    #[test]
    fn previously_recovered_edits_restore_the_latest_verified_revision() {
        let temp = Scratch::new();
        let extracted = temp.0.join("extracted");
        fs::create_dir(&extracted).unwrap();
        let mut manifest = manifest();
        let original = b"first recovered version";
        let latest = "later 世界".as_bytes();
        let old_hash = crate::export::sha256_hex(original);
        let new_hash = crate::export::sha256_hex(latest);
        let document = recovered(metadata("draft-1"), old_hash, original.len() as u64).unwrap();
        let prefix = "config/recovered-backups/previous";
        let index = InboxIndex {
            version: INBOX_VERSION,
            source_app_version: "1".into(),
            source_created_at_ms: 1,
            active_original_id: None,
            documents: vec![document.clone()],
            salvaged_journals: 0,
            preserved_files: 0,
        };
        add_file(
            &extracted,
            &mut manifest,
            &format!("{prefix}/index.json"),
            &serde_json::to_vec(&index).unwrap(),
            "recovery",
        );
        add_file(
            &extracted,
            &mut manifest,
            &format!("{prefix}/texts/{}.txt", document.id),
            original,
            "recovery",
        );
        let revision_dir = format!("{prefix}/revisions/{}", document.id);
        let revision = super::super::inbox_store::Revision {
            version: 1,
            sha256: new_hash.clone(),
            bytes: latest.len() as u64,
        };
        add_file(
            &extracted,
            &mut manifest,
            &format!("{revision_dir}/current.json"),
            &serde_json::to_vec(&revision).unwrap(),
            "recovery",
        );
        add_file(
            &extracted,
            &mut manifest,
            &format!("{revision_dir}/{new_hash}.txt"),
            latest,
            "recovery",
        );
        let target = temp.0.join("new-inbox");
        let restored = build(&extracted, &target, &manifest, &HashSet::new()).unwrap();
        assert_eq!(restored.documents.len(), 1);
        assert_eq!(restored.documents[0].sha256, new_hash);
        assert_eq!(
            fs::read(
                target
                    .join("texts")
                    .join(format!("{}.txt", restored.documents[0].id))
            )
            .unwrap(),
            latest
        );
    }
}
