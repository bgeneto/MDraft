//! Versioned ZIP format and bounded validation.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

pub const FORMAT: &str = "mdraft-backup";
pub const VERSION: u32 = 1;
const MANIFEST_NAME: &str = "manifest.json";
const MAX_MANIFEST: u64 = 32 * 1024 * 1024;
const MAX_ENTRIES: usize = 100_000;
const MAX_ENTRY_BYTES: u64 = 16 * 1024 * 1024 * 1024;
const MAX_TOTAL_BYTES: u64 = 128 * 1024 * 1024 * 1024;
const BUFFER_SIZE: usize = 128 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Category {
    pub included: bool,
    pub present: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Entry {
    pub path: String,
    pub category: String,
    pub bytes: u64,
    pub sha256: String,
    pub executable: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Directory {
    pub path: String,
    pub category: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Manifest {
    pub format: String,
    pub format_version: u32,
    pub app_version: String,
    pub created_at_ms: u64,
    pub capture_started_ms: u64,
    pub capture_finished_ms: u64,
    pub source_os: String,
    pub source_arch: String,
    pub portable: bool,
    pub component_versions: BTreeMap<String, u32>,
    pub categories: BTreeMap<String, Category>,
    #[serde(default)]
    pub directories: Vec<Directory>,
    pub entries: Vec<Entry>,
}

/// A file already copied into a sealed, private staging directory.
pub struct InputFile {
    pub path: String,
    pub category: String,
    pub source: PathBuf,
    pub executable: bool,
}

fn bad(message: impl Into<String>) -> String {
    message.into()
}

fn is_device_name(component: &str) -> bool {
    let name = component
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    matches!(name.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (name.len() == 4
            && (name.starts_with("COM") || name.starts_with("LPT"))
            && matches!(name.as_bytes()[3], b'1'..=b'9'))
}

/// Accept only portable, unambiguous relative ZIP names.
pub fn validate_name(name: &str) -> Result<(), String> {
    if name.is_empty() || name.len() > 4096 || name.starts_with('/') || name.contains('\\') {
        return Err(bad("The backup contains an invalid file name."));
    }
    for part in name.split('/') {
        if part.is_empty()
            || part == "."
            || part == ".."
            || part.ends_with('.')
            || part.ends_with(' ')
            || is_device_name(part)
            || part
                .chars()
                .any(|c| c.is_control() || matches!(c, ':' | '*' | '?' | '"' | '<' | '>' | '|'))
        {
            return Err(bad(format!(
                "The backup contains an unsafe file name: {name}"
            )));
        }
    }
    Ok(())
}

fn record_prefixes(name: &str, known: &mut HashMap<String, String>) -> Result<(), String> {
    let mut prefix = String::new();
    for component in name.split('/') {
        if !prefix.is_empty() {
            prefix.push('/');
        }
        prefix.push_str(component);
        let key = prefix.to_lowercase();
        if known.get(&key).is_some_and(|existing| existing != &prefix) {
            return Err(bad("The backup contains case-ambiguous paths."));
        }
        known.entry(key).or_insert_with(|| prefix.clone());
    }
    Ok(())
}

/// Categories are capabilities, not archive-controlled filesystem paths.
fn category_matches(category: &str, name: &str) -> bool {
    match category {
        "readme" => name == "README.txt",
        "settings" => matches!(
            name,
            "config/settings.json" | "preserved/settings-on-disk.json"
        ),
        "prompts" => name == "config/ai-prompts.md",
        "window" => name == "config/.window-state.json",
        "personal" => name == "config/texmf" || name.starts_with("config/texmf/"),
        "recovery" => {
            matches!(name, "config/recovery" | "config/recovered-backups")
                || name.starts_with("config/recovery/")
                || name.starts_with("config/recovered-backups/")
        }
        "session" => name == "session/session.json" || name.starts_with("session/buffers/"),
        "downloads" => ["data/pandoc", "data/typst", "data/latex", "data/tex-fmt"]
            .iter()
            .any(|root| {
                name == *root
                    || name
                        .strip_prefix(root)
                        .is_some_and(|suffix| suffix.starts_with('/'))
            }),
        _ => false,
    }
}

fn validate_entry(entry: &Entry) -> Result<(), String> {
    validate_name(&entry.path)?;
    if !category_matches(&entry.category, &entry.path)
        || matches!(
            entry.path.as_str(),
            "config/texmf"
                | "config/recovery"
                | "config/recovered-backups"
                | "data/pandoc"
                | "data/typst"
                | "data/latex"
                | "data/tex-fmt"
        )
    {
        return Err(bad(format!(
            "The backup has an unexpected file: {}",
            entry.path
        )));
    }
    if entry
        .path
        .split('/')
        .any(|part| part.eq_ignore_ascii_case("ai-keys.json"))
    {
        return Err(bad("The backup contains an excluded credential file."));
    }
    if entry.bytes > MAX_ENTRY_BYTES
        || entry.sha256.len() != 64
        || !entry
            .sha256
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Err(bad(format!(
            "The backup has invalid file metadata: {}",
            entry.path
        )));
    }
    if entry.executable && entry.category != "downloads" {
        return Err(bad("Only managed downloads can be marked executable."));
    }
    Ok(())
}

fn validate_manifest(manifest: &Manifest) -> Result<(), String> {
    if manifest.format != FORMAT || manifest.format_version != VERSION {
        return Err(bad(
            "This backup format is not supported by this version of MDraft.",
        ));
    }
    if manifest.app_version.is_empty()
        || manifest.source_os.is_empty()
        || manifest.source_arch.is_empty()
        || manifest.capture_finished_ms < manifest.capture_started_ms
        || manifest
            .entries
            .len()
            .saturating_add(manifest.directories.len())
            > MAX_ENTRIES
    {
        return Err(bad("The backup manifest is invalid."));
    }
    let expected = [
        "settings",
        "prompts",
        "personal",
        "recovery",
        "session",
        "window",
        "downloads",
    ];
    if manifest.component_versions.len() != expected.len()
        || expected
            .iter()
            .any(|name| manifest.component_versions.get(*name) != Some(&1))
        || manifest.categories.len() != expected.len()
        || expected
            .iter()
            .any(|name| !manifest.categories.contains_key(*name))
    {
        return Err(bad(
            "A backup component version is not supported by this version of MDraft.",
        ));
    }
    let mut names = HashSet::new();
    let mut prefixes = HashMap::new();
    let mut total = 0_u64;
    for directory in &manifest.directories {
        validate_name(&directory.path)?;
        record_prefixes(&directory.path, &mut prefixes)?;
        if !matches!(
            directory.category.as_str(),
            "personal" | "recovery" | "downloads"
        ) || !category_matches(&directory.category, &directory.path)
            || !manifest
                .categories
                .get(&directory.category)
                .is_some_and(|category| category.included && category.present)
            || !names.insert(directory.path.to_lowercase())
        {
            return Err(bad("The backup has an invalid or duplicate directory."));
        }
    }
    for entry in &manifest.entries {
        validate_entry(entry)?;
        record_prefixes(&entry.path, &mut prefixes)?;
        if !names.insert(entry.path.to_lowercase()) {
            return Err(bad(
                "The backup contains duplicate or ambiguous file names.",
            ));
        }
        if entry.category != "readme"
            && !manifest
                .categories
                .get(&entry.category)
                .is_some_and(|c| c.included && c.present)
        {
            return Err(bad("The backup contains data for an omitted category."));
        }
        total = total
            .checked_add(entry.bytes)
            .ok_or_else(|| bad("The backup is too large."))?;
        if total > MAX_TOTAL_BYTES {
            return Err(bad("The backup exceeds the supported size."));
        }
    }
    if !names.contains("readme.txt") {
        return Err(bad("The backup is missing its recovery instructions."));
    }
    Ok(())
}

pub(super) fn copy_hashed(
    reader: &mut impl Read,
    writer: &mut impl Write,
    limit: u64,
) -> Result<(u64, String), String> {
    copy_hashed_with(reader, writer, limit, &mut |_| Ok(()))
}

pub(super) fn copy_hashed_with(
    reader: &mut impl Read,
    writer: &mut impl Write,
    limit: u64,
    progress: &mut impl FnMut(u64) -> Result<(), String>,
) -> Result<(u64, String), String> {
    let mut digest = Sha256::new();
    let mut bytes = 0_u64;
    let mut buffer = vec![0_u8; BUFFER_SIZE];
    loop {
        progress(0)?;
        let n = reader
            .read(&mut buffer)
            .map_err(|error| error.to_string())?;
        if n == 0 {
            break;
        }
        bytes = bytes
            .checked_add(n as u64)
            .ok_or_else(|| bad("The file is too large."))?;
        if bytes > limit {
            return Err(bad("A backup file exceeds its declared or supported size."));
        }
        writer
            .write_all(&buffer[..n])
            .map_err(|error| error.to_string())?;
        digest.update(&buffer[..n]);
        progress(n as u64)?;
    }
    let mut hex = String::with_capacity(64);
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    for byte in digest.finalize() {
        hex.push(DIGITS[(byte >> 4) as usize] as char);
        hex.push(DIGITS[(byte & 0x0f) as usize] as char);
    }
    Ok((bytes, hex))
}

/// Write to a new private file. The caller publishes it only after verification.
#[cfg(test)]
pub fn write_archive(
    path: &Path,
    manifest: Manifest,
    files: &[InputFile],
) -> Result<Manifest, String> {
    write_archive_with(path, manifest, files, &mut |_| Ok(()))
}

#[cfg(test)]
pub fn write_archive_with(
    path: &Path,
    manifest: Manifest,
    files: &[InputFile],
    progress: &mut impl FnMut(u64) -> Result<(), String>,
) -> Result<Manifest, String> {
    let output = OpenOptions::new()
        .write(true)
        .read(true)
        .create_new(true)
        .open(path)
        .map_err(|error| format!("Could not create the backup: {error}"))?;
    write_archive_to(output, manifest, files, progress)
}

pub fn write_archive_to(
    output: File,
    mut manifest: Manifest,
    files: &[InputFile],
    progress: &mut impl FnMut(u64) -> Result<(), String>,
) -> Result<Manifest, String> {
    if files.len().saturating_add(manifest.directories.len()) > MAX_ENTRIES {
        return Err(bad("There are too many files to back up."));
    }
    let mut zip = ZipWriter::new(output);
    manifest.entries.clear();
    let mut names = HashSet::new();
    for directory in &manifest.directories {
        progress(0)?;
        validate_name(&directory.path)?;
        if !names.insert(directory.path.to_lowercase()) {
            return Err(bad("The backup contains duplicate directory names."));
        }
        zip.add_directory(
            format!("{}/", directory.path),
            SimpleFileOptions::default().unix_permissions(0o700),
        )
        .map_err(|error| error.to_string())?;
    }
    let mut total = 0_u64;
    for item in files {
        progress(0)?;
        validate_name(&item.path)?;
        if !category_matches(&item.category, &item.path) || !names.insert(item.path.to_lowercase())
        {
            return Err(bad(format!(
                "Cannot include the backup file: {}",
                item.path
            )));
        }
        let mut source = File::open(&item.source)
            .map_err(|error| format!("Could not read {}: {error}", item.path))?;
        let metadata = source.metadata().map_err(|error| error.to_string())?;
        if !metadata.is_file() || metadata.len() > MAX_ENTRY_BYTES {
            return Err(bad(format!(
                "Cannot back up {}: unsupported file or size.",
                item.path
            )));
        }
        let options = SimpleFileOptions::default()
            .compression_method(CompressionMethod::Deflated)
            .large_file(metadata.len() >= u32::MAX as u64)
            .unix_permissions(if item.executable { 0o755 } else { 0o600 });
        zip.start_file(&item.path, options)
            .map_err(|error| error.to_string())?;
        let (bytes, sha256) = copy_hashed_with(&mut source, &mut zip, MAX_ENTRY_BYTES, progress)?;
        if bytes != metadata.len() {
            return Err(bad(format!(
                "The staged file changed during backup: {}",
                item.path
            )));
        }
        total = total
            .checked_add(bytes)
            .ok_or_else(|| bad("The backup is too large."))?;
        if total > MAX_TOTAL_BYTES {
            return Err(bad("The backup exceeds the supported size."));
        }
        manifest.entries.push(Entry {
            path: item.path.clone(),
            category: item.category.clone(),
            bytes,
            sha256,
            executable: item.executable,
        });
    }
    validate_manifest(&manifest)?;
    let body = serde_json::to_vec_pretty(&manifest).map_err(|error| error.to_string())?;
    if body.len() as u64 > MAX_MANIFEST {
        return Err(bad("The backup manifest is too large."));
    }
    zip.start_file(
        MANIFEST_NAME,
        SimpleFileOptions::default().unix_permissions(0o600),
    )
    .map_err(|error| error.to_string())?;
    zip.write_all(&body).map_err(|error| error.to_string())?;
    let output = zip
        .finish()
        .map_err(|error| format!("Could not finish the backup: {error}"))?;
    output
        .sync_all()
        .map_err(|error| format!("Could not flush the backup: {error}"))?;
    Ok(manifest)
}

/// Validate every member before an optional extraction into a fresh directory.
#[cfg(test)]
pub fn verify_archive(path: &Path, extract: Option<&Path>) -> Result<Manifest, String> {
    verify_archive_with(path, extract, &mut |_| Ok(()))
}

pub fn verify_archive_with(
    path: &Path,
    extract: Option<&Path>,
    progress: &mut impl FnMut(u64) -> Result<(), String>,
) -> Result<Manifest, String> {
    let parent = path
        .parent()
        .ok_or_else(|| bad("The backup has no parent folder."))?;
    let parent = fs::canonicalize(parent)
        .map_err(|error| format!("Could not open the backup folder: {error}"))?;
    let name = path
        .file_name()
        .ok_or_else(|| bad("The backup has no file name."))?;
    let file = super::snapshot::open_regular(&parent, Path::new(name))
        .map_err(|error| format!("Could not safely open the backup: {error}"))?;
    let mut zip = ZipArchive::new(file).map_err(|error| format!("The ZIP is invalid: {error}"))?;
    // The ZIP reader indexes files by name, so its ordinary length/iteration
    // alone cannot reveal duplicate central-directory names.
    zip.validate_header_consistency()
        .map_err(|error| format!("The ZIP headers are inconsistent: {error}"))?;
    if zip.len() > MAX_ENTRIES + 1 {
        return Err(bad("The backup has too many files."));
    }
    let mut names = HashSet::new();
    let mut prefixes = HashMap::new();
    let mut indices = HashMap::new();
    for index in 0..zip.len() {
        progress(0)?;
        let item = zip.by_index_raw(index).map_err(|error| error.to_string())?;
        let name = std::str::from_utf8(item.name_raw())
            .map_err(|_| bad("The backup has a non-UTF-8 file name."))?
            .to_string();
        let name_without_slash = if item.is_dir() {
            name.strip_suffix('/')
                .ok_or_else(|| bad("The backup contains an invalid directory."))?
        } else {
            &name
        };
        validate_name(name_without_slash)?;
        record_prefixes(name_without_slash, &mut prefixes)?;
        if item.is_symlink()
            || item.encrypted()
            || !matches!(
                item.compression(),
                CompressionMethod::Stored | CompressionMethod::Deflated
            )
            || item.size() > MAX_ENTRY_BYTES
            || (item.is_dir() && item.size() != 0)
            || !names.insert(name_without_slash.to_lowercase())
        {
            return Err(bad(format!(
                "The backup contains an unsupported or duplicate file: {name}"
            )));
        }
        indices.insert(name, index);
    }
    let manifest_index = *indices
        .get(MANIFEST_NAME)
        .ok_or_else(|| bad("The backup manifest is missing."))?;
    let manifest: Manifest = {
        let mut file = zip
            .by_index(manifest_index)
            .map_err(|error| error.to_string())?;
        if file.size() > MAX_MANIFEST {
            return Err(bad("The backup manifest is too large."));
        }
        let mut bytes = Vec::new();
        file.by_ref()
            .take(MAX_MANIFEST + 1)
            .read_to_end(&mut bytes)
            .map_err(|error| error.to_string())?;
        if bytes.len() as u64 > MAX_MANIFEST {
            return Err(bad("The backup manifest is too large."));
        }
        serde_json::from_slice(&bytes)
            .map_err(|error| format!("The backup manifest is invalid: {error}"))?
    };
    validate_manifest(&manifest)?;
    if indices.len() != manifest.entries.len() + manifest.directories.len() + 1 {
        return Err(bad("The backup has missing or undeclared files."));
    }
    if let Some(root) = extract {
        fs::create_dir(root)
            .map_err(|error| format!("Could not create the restore staging folder: {error}"))?;
    }
    for directory in &manifest.directories {
        progress(0)?;
        let name = format!("{}/", directory.path);
        let index = *indices
            .get(&name)
            .ok_or_else(|| bad("A backup directory is missing."))?;
        if !zip
            .by_index_raw(index)
            .map_err(|error| error.to_string())?
            .is_dir()
        {
            return Err(bad("A backup directory is not a directory."));
        }
        if let Some(root) = extract {
            fs::create_dir_all(root.join(&directory.path)).map_err(|error| error.to_string())?;
        }
    }
    for entry in &manifest.entries {
        progress(0)?;
        let index = *indices
            .get(&entry.path)
            .ok_or_else(|| bad(format!("The backup is missing {}.", entry.path)))?;
        let mut item = zip.by_index(index).map_err(|error| error.to_string())?;
        if item.size() != entry.bytes {
            return Err(bad(format!(
                "The size of {} does not match the manifest.",
                entry.path
            )));
        }
        let (bytes, sha256) = if let Some(root) = extract {
            let destination = root.join(&entry.path);
            let parent = destination
                .parent()
                .ok_or_else(|| bad("Invalid restore path."))?;
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            let mut target = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&destination)
                .map_err(|error| format!("Could not stage {}: {error}", entry.path))?;
            let result = copy_hashed_with(&mut item, &mut target, entry.bytes, progress)?;
            target.sync_all().map_err(|error| error.to_string())?;
            result
        } else {
            copy_hashed_with(&mut item, &mut std::io::sink(), entry.bytes, progress)?
        };
        if bytes != entry.bytes || sha256 != entry.sha256 {
            return Err(bad(format!(
                "The contents of {} do not match the manifest.",
                entry.path
            )));
        }
    }
    Ok(manifest)
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
                "mdraft-backup-format-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }

        fn path(&self, name: &str) -> PathBuf {
            self.0.join(name)
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            if self.0.parent() == Some(std::env::temp_dir().as_path())
                && self
                    .0
                    .file_name()
                    .is_some_and(|name| name.to_string_lossy().starts_with("mdraft-backup-format-"))
            {
                let _ = fs::remove_dir_all(&self.0);
            }
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
            format: FORMAT.into(),
            format_version: VERSION,
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
                .collect(),
            directories: Vec::new(),
            entries: Vec::new(),
        }
    }

    fn make_zip(path: &Path, entries: &[(&str, &[u8])]) {
        let file = File::create(path).unwrap();
        let mut zip = ZipWriter::new(file);
        for (name, body) in entries {
            zip.start_file(*name, SimpleFileOptions::default()).unwrap();
            zip.write_all(body).unwrap();
        }
        zip.finish().unwrap();
    }

    #[test]
    fn archives_round_trip_and_restore_exact_bytes() {
        let dir = Scratch::new();
        let readme = dir.path("source-readme");
        let buffer = dir.path("source-buffer");
        fs::write(&readme, "Recover these files.").unwrap();
        fs::write(&buffer, "Olá, 世界\nunfinished").unwrap();
        let files = [
            InputFile {
                path: "README.txt".into(),
                category: "readme".into(),
                source: readme,
                executable: false,
            },
            InputFile {
                path: "session/buffers/a.txt".into(),
                category: "session".into(),
                source: buffer,
                executable: false,
            },
        ];
        let archive = dir.path("backup.zip");
        let mut description = manifest();
        description.directories = vec![Directory {
            path: "config/texmf/empty".into(),
            category: "personal".into(),
        }];
        let written = write_archive(&archive, description, &files).unwrap();
        let restored = dir.path("staged");
        assert_eq!(verify_archive(&archive, Some(&restored)).unwrap(), written);
        assert_eq!(
            fs::read_to_string(restored.join("session/buffers/a.txt")).unwrap(),
            "Olá, 世界\nunfinished"
        );
        assert!(restored.join("config/texmf/empty").is_dir());
    }

    #[test]
    fn rejects_unsafe_and_ambiguous_names() {
        for name in [
            "",
            "../outside",
            "config/../x",
            "/absolute",
            "C:/file",
            "config\\file",
            "config/con.txt",
            "config/file.",
            "config/file ",
            "config/a\0b",
            "config/a:b",
        ] {
            assert!(validate_name(name).is_err(), "accepted {name:?}");
        }
        assert!(validate_name("config/texmf/ação/arquivo.sty").is_ok());
        let dir = Scratch::new();
        let archive = dir.path("case.zip");
        make_zip(&archive, &[("README.txt", b"one"), ("readme.txt", b"two")]);
        assert!(verify_archive(&archive, None).is_err());
    }

    #[test]
    fn rejects_wrong_hash_extra_file_and_unknown_version() {
        let dir = Scratch::new();
        let mut m = manifest();
        m.entries.push(Entry {
            path: "README.txt".into(),
            category: "readme".into(),
            bytes: 4,
            sha256: "0".repeat(64),
            executable: false,
        });
        let body = serde_json::to_vec(&m).unwrap();
        let wrong = dir.path("wrong.zip");
        make_zip(&wrong, &[("README.txt", b"test"), (MANIFEST_NAME, &body)]);
        assert!(
            verify_archive(&wrong, None)
                .unwrap_err()
                .contains("do not match")
        );

        let extra = dir.path("extra.zip");
        make_zip(
            &extra,
            &[
                ("README.txt", b"test"),
                ("config/extra.txt", b"x"),
                (MANIFEST_NAME, &body),
            ],
        );
        assert!(
            verify_archive(&extra, None)
                .unwrap_err()
                .contains("undeclared")
        );

        m.format_version += 1;
        let body = serde_json::to_vec(&m).unwrap();
        let future = dir.path("future.zip");
        make_zip(&future, &[("README.txt", b"test"), (MANIFEST_NAME, &body)]);
        assert!(
            verify_archive(&future, None)
                .unwrap_err()
                .contains("not supported")
        );
    }

    #[test]
    fn rejects_categories_that_could_smuggle_a_credential() {
        let entry = Entry {
            path: "config/texmf/ai-keys.json".into(),
            category: "personal".into(),
            bytes: 0,
            sha256: "0".repeat(64),
            executable: false,
        };
        assert!(validate_entry(&entry).is_err());
        let wrong_root = Entry {
            path: "config/settings.json".into(),
            category: "downloads".into(),
            ..entry
        };
        assert!(validate_entry(&wrong_root).is_err());
    }
}
