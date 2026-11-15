//! Bounded, acknowledged capture of immutable editor buffers.

use super::format::InputFile;
use super::inbox::{self, Buffer, SessionSnapshot};
use super::snapshot::{self, CredentialIds};
use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

const MAX_CHUNK: usize = 256 * 1024;
const MAX_DOCUMENT: u64 = 16 * 1024 * 1024 * 1024;
const MAX_DOCUMENTS: usize = 100_000;
const MAX_METADATA: usize = 16 * 1024 * 1024;

struct OpenBuffer {
    metadata: Buffer,
    file: File,
    path: PathBuf,
    bytes: u64,
    next_sequence: u64,
}

pub struct Capture {
    root: PathBuf,
    expected: usize,
    active_id: Option<String>,
    seen: HashSet<String>,
    buffers: Vec<Buffer>,
    files: Vec<InputFile>,
    current: Option<OpenBuffer>,
    credentials: CredentialIds,
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

impl Capture {
    pub fn new(
        root: &Path,
        expected: usize,
        active_id: Option<String>,
        credentials: CredentialIds,
    ) -> Result<Self, String> {
        if expected > MAX_DOCUMENTS || active_id.as_deref().is_some_and(|id| !inbox::valid_id(id)) {
            return Err("The open-document snapshot is invalid or too large.".into());
        }
        let session = root.join("session");
        fs::create_dir(&session).map_err(|error| error.to_string())?;
        fs::create_dir(session.join("buffers")).map_err(|error| error.to_string())?;
        Ok(Self {
            root: root.to_path_buf(),
            expected,
            active_id,
            seen: HashSet::new(),
            buffers: Vec::new(),
            files: Vec::new(),
            current: None,
            credentials,
        })
    }

    pub fn begin(&mut self, metadata: Buffer) -> Result<(), String> {
        if self.current.is_some() || self.buffers.len() >= self.expected {
            return Err("The open-document snapshot is out of sequence.".into());
        }
        if !inbox::valid_id(&metadata.id)
            || !self.seen.insert(metadata.id.clone())
            || metadata.name.len() > 4096
            || metadata.language.len() > 64
            || metadata
                .path
                .as_ref()
                .is_some_and(|path| path.len() > 32768)
            || !matches!(metadata.line_ending.as_str(), "\n" | "\r\n")
        {
            return Err("An open document has invalid backup metadata.".into());
        }
        if let Some(source) = &metadata.path {
            let path = Path::new(source);
            let name = path
                .file_name()
                .and_then(|name| name.to_str())
                .ok_or("An open document has an invalid path.")?;
            if name.to_ascii_lowercase().starts_with("ai-keys.json") {
                return Err("An open document may contain MDraft API keys. Close it before creating a backup.".into());
            }
            if !self.credentials.is_empty() {
                let parent = path
                    .parent()
                    .and_then(|parent| fs::canonicalize(parent).ok())
                    .ok_or("Cannot verify an open document against the excluded key file.")?;
                let file = snapshot::open_regular(&parent, Path::new(name))
                    .map_err(|_| "Cannot verify an open document against the excluded key file.")?;
                if snapshot::is_credential_file(&file, &self.credentials)? {
                    return Err("An open document is linked to MDraft's excluded key file.".into());
                }
            }
        }
        let path = self
            .root
            .join("session/buffers")
            .join(format!("{}.txt", metadata.id));
        let file = create_private(&path)?;
        self.current = Some(OpenBuffer {
            metadata,
            file,
            path,
            bytes: 0,
            next_sequence: 0,
        });
        Ok(())
    }

    pub fn append(&mut self, id: &str, sequence: u64, bytes: &[u8]) -> Result<u64, String> {
        let buffer = self
            .current
            .as_mut()
            .ok_or("No open document is being captured.")?;
        if buffer.metadata.id != id
            || sequence != buffer.next_sequence
            || bytes.is_empty()
            || bytes.len() > MAX_CHUNK
        {
            return Err("An open-document chunk is invalid or out of sequence.".into());
        }
        let next = buffer
            .bytes
            .checked_add(bytes.len() as u64)
            .ok_or("The open document is too large.")?;
        if next > MAX_DOCUMENT {
            return Err("The open document exceeds the supported backup size.".into());
        }
        buffer
            .file
            .write_all(bytes)
            .map_err(|error| error.to_string())?;
        buffer.bytes = next;
        buffer.next_sequence += 1;
        Ok(next)
    }

    pub fn finish(&mut self, id: &str, sequences: u64, bytes: u64) -> Result<(), String> {
        let buffer = self
            .current
            .take()
            .ok_or("No open document is being captured.")?;
        if buffer.metadata.id != id || buffer.next_sequence != sequences || buffer.bytes != bytes {
            return Err("The open-document snapshot is incomplete.".into());
        }
        buffer.file.sync_all().map_err(|error| error.to_string())?;
        inbox::is_utf8(&buffer.path)?;
        self.files.push(InputFile {
            path: format!("session/buffers/{}.txt", buffer.metadata.id),
            category: "session".into(),
            source: buffer.path,
            executable: false,
        });
        self.buffers.push(buffer.metadata);
        Ok(())
    }

    pub fn seal(self) -> Result<Vec<InputFile>, String> {
        if self.current.is_some() || self.buffers.len() != self.expected {
            return Err("Not every open document was captured.".into());
        }
        if self
            .active_id
            .as_ref()
            .is_some_and(|id| !self.seen.contains(id))
        {
            return Err("The active recovered document was not captured.".into());
        }
        let snapshot = SessionSnapshot {
            version: 1,
            active_id: self.active_id,
            buffers: self.buffers,
        };
        let body = serde_json::to_vec_pretty(&snapshot).map_err(|error| error.to_string())?;
        if body.len() > MAX_METADATA {
            return Err("Open-document metadata exceeds the supported backup size.".into());
        }
        let path = self.root.join("session/session.json");
        let mut file = create_private(&path)?;
        file.write_all(&body)
            .and_then(|()| file.sync_all())
            .map_err(|error| error.to_string())?;
        let mut files = self.files;
        files.push(InputFile {
            path: "session/session.json".into(),
            category: "session".into(),
            source: path,
            executable: false,
        });
        Ok(files)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static NEXT: AtomicUsize = AtomicUsize::new(0);
    struct Scratch(PathBuf);

    impl Scratch {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "mdraft-backup-buffers-{}-{}",
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
                && self.0.file_name().is_some_and(|name| {
                    name.to_string_lossy().starts_with("mdraft-backup-buffers-")
                })
            {
                let _ = fs::remove_dir_all(&self.0);
            }
        }
    }

    fn buffer(id: &str) -> Buffer {
        Buffer {
            id: id.into(),
            name: "Draft".into(),
            language: "markdown".into(),
            path: None,
            line_ending: "\n".into(),
            had_bom: false,
            encoding: Some("UTF-8".into()),
            lossy: false,
            read_only: false,
            base_modified_ms: 0,
            base_size: 0,
            base_sha256: None,
        }
    }

    #[test]
    fn captures_chunks_in_order_and_seals_metadata() {
        let temp = Scratch::new();
        let mut capture =
            Capture::new(&temp.0, 1, Some("one".into()), CredentialIds::default()).unwrap();
        capture.begin(buffer("one")).unwrap();
        assert_eq!(capture.append("one", 0, b"Hello ").unwrap(), 6);
        assert_eq!(capture.append("one", 1, "世界".as_bytes()).unwrap(), 12);
        capture.finish("one", 2, 12).unwrap();
        let files = capture.seal().unwrap();
        assert_eq!(files.len(), 2);
        assert_eq!(
            fs::read_to_string(temp.0.join("session/buffers/one.txt")).unwrap(),
            "Hello 世界"
        );
        let snapshot: SessionSnapshot =
            serde_json::from_slice(&fs::read(temp.0.join("session/session.json")).unwrap())
                .unwrap();
        assert_eq!(snapshot.buffers[0].id, "one");
        assert_eq!(snapshot.active_id.as_deref(), Some("one"));
    }

    #[test]
    fn rejects_missing_duplicate_and_out_of_order_chunks() {
        let temp = Scratch::new();
        let mut capture = Capture::new(&temp.0, 2, None, CredentialIds::default()).unwrap();
        capture.begin(buffer("one")).unwrap();
        assert!(capture.append("one", 1, b"wrong").is_err());
        assert!(capture.append("other", 0, b"wrong").is_err());
        capture.append("one", 0, b"safe").unwrap();
        capture.finish("one", 1, 4).unwrap();
        assert!(capture.begin(buffer("one")).is_err());
        assert!(capture.seal().is_err());
    }

    #[test]
    fn refuses_incomplete_or_invalid_utf8_buffers() {
        let temp = Scratch::new();
        let mut capture = Capture::new(&temp.0, 1, None, CredentialIds::default()).unwrap();
        capture.begin(buffer("one")).unwrap();
        capture.append("one", 0, &[0xff]).unwrap();
        assert!(capture.finish("one", 1, 1).unwrap_err().contains("UTF-8"));
    }

    #[test]
    fn refuses_a_dirty_buffer_linked_to_excluded_credentials() {
        let temp = Scratch::new();
        let config = temp.0.join("config");
        let stage = temp.0.join("stage");
        fs::create_dir(&config).unwrap();
        fs::create_dir(&stage).unwrap();
        let secret = config.join("ai-keys.json");
        let alias = temp.0.join("notes.md");
        fs::write(&secret, b"synthetic credential sentinel").unwrap();
        fs::hard_link(secret, &alias).unwrap();
        let keys = snapshot::credential_ids(&config).unwrap();
        let mut capture = Capture::new(&stage, 1, None, keys).unwrap();
        let mut metadata = buffer("one");
        metadata.path = Some(alias.to_string_lossy().into_owned());
        assert!(
            capture
                .begin(metadata)
                .unwrap_err()
                .contains("excluded key file")
        );
    }
}
