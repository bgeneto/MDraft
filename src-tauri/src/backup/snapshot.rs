//! Capture registered application files into a private staging directory.
//!
//! Settings and unsaved editor text have separate live authorities. The caller
//! supplies the settings snapshot and stages editor buffers after this module
//! has captured the filesystem stores.

use super::format::{self, Category, Directory, InputFile};
use std::collections::{BTreeMap, HashSet};
use std::fs::{self, File, Metadata, OpenOptions};
use std::io::{Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

const MAX_FILE_BYTES: u64 = 16 * 1024 * 1024 * 1024;
const MAX_FILES: usize = 100_000;
const MAX_DEPTH: usize = 64;
const MAX_SETTINGS: usize = 16 * 1024 * 1024;

#[derive(Clone, Debug)]
pub struct Roots {
    pub config: PathBuf,
    pub data: PathBuf,
}

pub struct Captured {
    pub files: Vec<InputFile>,
    pub directories: Vec<Directory>,
    pub categories: BTreeMap<String, Category>,
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
struct FileId(u64, u64);

#[derive(Default)]
pub(crate) struct CredentialIds(HashSet<FileId>);

impl CredentialIds {
    pub(crate) fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct Fingerprint {
    identity: FileId,
    bytes: u64,
    modified: Option<SystemTime>,
}

#[derive(Clone, Debug)]
struct Source {
    root: PathBuf,
    relative: PathBuf,
    archive: String,
    category: &'static str,
    fingerprint: Fingerprint,
    executable: bool,
}

#[cfg(windows)]
pub(super) fn is_link(metadata: &Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    metadata.file_type().is_symlink() || metadata.file_attributes() & 0x400 != 0
}

#[cfg(not(windows))]
pub(super) fn is_link(metadata: &Metadata) -> bool {
    metadata.file_type().is_symlink()
}

#[cfg(windows)]
fn file_id(file: &File) -> Result<FileId, String> {
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, GetFileInformationByHandle,
    };
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    // The handle remains owned by File. The call only fills the information
    // structure and cannot follow a later replacement of its path.
    unsafe { GetFileInformationByHandle(HANDLE(file.as_raw_handle()), &mut info) }
        .map_err(|error| format!("Could not identify a backup source: {error}"))?;
    Ok(FileId(
        u64::from(info.dwVolumeSerialNumber),
        (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow),
    ))
}

#[cfg(unix)]
fn file_id(file: &File) -> Result<FileId, String> {
    use std::os::unix::fs::MetadataExt;
    let meta = file.metadata().map_err(|error| error.to_string())?;
    Ok(FileId(meta.dev(), meta.ino()))
}

#[cfg(windows)]
pub(crate) fn open_regular(root: &Path, relative: &Path) -> Result<File, String> {
    use std::os::windows::ffi::OsStringExt;
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::Storage::FileSystem::{FILE_NAME_NORMALIZED, GetFinalPathNameByHandleW};

    let path = root.join(relative);
    let file = OpenOptions::new()
        .read(true)
        // Open the link itself, not its target, if the final component changes.
        .custom_flags(0x0020_0000)
        .open(&path)
        .map_err(|error| format!("Could not read {}: {error}", path.display()))?;
    let metadata = file.metadata().map_err(|error| error.to_string())?;
    if is_link(&metadata) || !metadata.is_file() {
        return Err(format!(
            "Cannot back up a link or non-file: {}",
            path.display()
        ));
    }
    let mut wide = vec![0_u16; 1024];
    let handle = HANDLE(file.as_raw_handle());
    // Resolve the opened handle, not just the path checked before opening it.
    let mut len =
        unsafe { GetFinalPathNameByHandleW(handle, &mut wide, FILE_NAME_NORMALIZED) } as usize;
    if len >= wide.len() {
        wide.resize(len + 1, 0);
        len =
            unsafe { GetFinalPathNameByHandleW(handle, &mut wide, FILE_NAME_NORMALIZED) } as usize;
    }
    if len == 0 || len >= wide.len() {
        return Err(format!(
            "Could not verify the source location: {}",
            path.display()
        ));
    }
    let actual = PathBuf::from(std::ffi::OsString::from_wide(&wide[..len]));
    let canonical_root = fs::canonicalize(root).map_err(|error| error.to_string())?;
    let actual_key = actual.to_string_lossy().to_lowercase();
    let mut root_key = canonical_root.to_string_lossy().to_lowercase();
    if !root_key.ends_with('\\') {
        root_key.push('\\');
    }
    if !actual_key.starts_with(&root_key) {
        return Err(format!(
            "A backup source is outside the application folder: {}",
            path.display()
        ));
    }
    Ok(file)
}

#[cfg(unix)]
pub(crate) fn open_regular(root: &Path, relative: &Path) -> Result<File, String> {
    use std::ffi::CString;
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::ffi::OsStrExt;
    use std::path::Component;

    let mut directory = File::open(root).map_err(|error| error.to_string())?;
    let parts: Vec<_> = relative.components().collect();
    if parts.is_empty() {
        return Err("A backup source has no file name.".into());
    }
    for (index, part) in parts.iter().enumerate() {
        let Component::Normal(name) = part else {
            return Err("A backup source has an unsafe path.".into());
        };
        let name =
            CString::new(name.as_bytes()).map_err(|_| "A backup source has an invalid name.")?;
        let mut flags = libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW;
        if index + 1 != parts.len() {
            flags |= libc::O_DIRECTORY;
        }
        // Each directory descriptor anchors the next lookup, so changing a
        // parent path cannot redirect the read through a symlink.
        let fd = unsafe { libc::openat(directory.as_raw_fd(), name.as_ptr(), flags) };
        if fd < 0 {
            return Err(format!(
                "Could not safely open {}: {}",
                root.join(relative).display(),
                std::io::Error::last_os_error()
            ));
        }
        directory = unsafe { File::from_raw_fd(fd) };
    }
    if !directory
        .metadata()
        .map_err(|error| error.to_string())?
        .is_file()
    {
        return Err(format!(
            "Cannot back up a non-file: {}",
            root.join(relative).display()
        ));
    }
    Ok(directory)
}

fn fingerprint(file: &File) -> Result<Fingerprint, String> {
    let metadata = file.metadata().map_err(|error| error.to_string())?;
    if !metadata.is_file() || is_link(&metadata) || metadata.len() > MAX_FILE_BYTES {
        return Err("A backup source is not a supported regular file.".into());
    }
    Ok(Fingerprint {
        identity: file_id(file)?,
        bytes: metadata.len(),
        modified: metadata.modified().ok(),
    })
}

#[cfg(unix)]
fn executable(meta: &Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    meta.permissions().mode() & 0o111 != 0
}

#[cfg(not(unix))]
fn executable(_meta: &Metadata) -> bool {
    false
}

fn exists_without_link(path: &Path) -> Result<bool, String> {
    match fs::symlink_metadata(path) {
        Ok(meta) if is_link(&meta) => Err(format!("Cannot back up a link: {}", path.display())),
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!("Could not inspect {}: {error}", path.display())),
    }
}

pub(crate) fn credential_ids(config: &Path) -> Result<CredentialIds, String> {
    let mut ids = HashSet::new();
    for name in ["ai-keys.json", "ai-keys.json.tmp"] {
        if exists_without_link(&config.join(name))? {
            ids.insert(file_id(&open_regular(config, Path::new(name))?)?);
        }
    }
    Ok(CredentialIds(ids))
}

pub(crate) fn is_credential_file(file: &File, ids: &CredentialIds) -> Result<bool, String> {
    Ok(ids.0.contains(&file_id(file)?))
}

fn file_component(name: &std::ffi::OsStr) -> Result<&str, String> {
    name.to_str()
        .ok_or_else(|| "An application file has a non-UTF-8 name.".into())
}

fn add_source(
    root: &Path,
    relative: &Path,
    archive: String,
    category: &'static str,
    keys: &CredentialIds,
    files: &mut Vec<Source>,
) -> Result<(), String> {
    format::validate_name(&archive)?;
    let file = open_regular(root, relative)?;
    let fingerprint = fingerprint(&file)?;
    if keys.0.contains(&fingerprint.identity) {
        return Err("An application file is a hardlink to the excluded key file.".into());
    }
    if files.len() >= MAX_FILES {
        return Err("There are too many files to back up.".into());
    }
    let meta = file.metadata().map_err(|error| error.to_string())?;
    files.push(Source {
        root: root.to_path_buf(),
        relative: relative.to_path_buf(),
        archive,
        category,
        fingerprint,
        executable: category == "downloads" && executable(&meta),
    });
    Ok(())
}

fn ignored_file(category: &str, path: &str, name: &str) -> bool {
    if name.eq_ignore_ascii_case("ai-keys.json") || name.eq_ignore_ascii_case("ai-keys.json.tmp") {
        return true;
    }
    if category == "downloads" {
        return name.ends_with(".tmp") || name.ends_with(".part") || path == "data/typst/cache";
    }
    category == "recovery" && name.ends_with(".tmp")
}

struct WalkSource<'a> {
    root: &'a Path,
    category: &'static str,
    keys: &'a CredentialIds,
}

fn walk(
    source: &WalkSource<'_>,
    relative: &Path,
    archive: &str,
    files: &mut Vec<Source>,
    directories: &mut Vec<Directory>,
    depth: usize,
    progress: &mut impl FnMut(u64) -> Result<(), String>,
) -> Result<(), String> {
    progress(0)?;
    if depth > MAX_DEPTH {
        return Err("An application folder is nested too deeply to back up.".into());
    }
    let path = source.root.join(relative);
    let meta = fs::symlink_metadata(&path)
        .map_err(|error| format!("Could not inspect {}: {error}", path.display()))?;
    if is_link(&meta) {
        return Err(format!("Cannot back up a link: {}", path.display()));
    }
    if meta.is_file() {
        return add_source(
            source.root,
            relative,
            archive.into(),
            source.category,
            source.keys,
            files,
        );
    }
    if !meta.is_dir() {
        return Err(format!("Cannot back up a special file: {}", path.display()));
    }
    format::validate_name(archive)?;
    if files.len().saturating_add(directories.len()) >= MAX_FILES {
        return Err("There are too many files and folders to back up.".into());
    }
    directories.push(Directory {
        path: archive.into(),
        category: source.category.into(),
    });
    let mut entries = fs::read_dir(&path)
        .map_err(|error| format!("Could not inspect {}: {error}", path.display()))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let name = entry.file_name();
        let name_text = file_component(&name)?;
        let next_archive = format!("{archive}/{name_text}");
        if ignored_file(source.category, &next_archive, name_text) {
            continue;
        }
        walk(
            source,
            &relative.join(name),
            &next_archive,
            files,
            directories,
            depth + 1,
            progress,
        )?;
    }
    Ok(())
}

fn validate_root_entries(
    root: &Path,
    shared: bool,
    data: bool,
    legacy_latex: Option<&str>,
) -> Result<(), String> {
    if !exists_without_link(root)? {
        return Ok(());
    }
    if !fs::symlink_metadata(root)
        .map_err(|error| error.to_string())?
        .is_dir()
    {
        return Err(format!(
            "The application folder is not a directory: {}",
            root.display()
        ));
    }
    for entry in fs::read_dir(root).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let name = entry.file_name();
        let name = file_component(&name)?;
        let config = matches!(
            name,
            "settings.json"
                | "settings.json.tmp"
                | "ai-prompts.md"
                | "ai-keys.json"
                | "ai-keys.json.tmp"
                | ".window-state.json"
                | ".window-state.json.tmp"
                | "recovery"
                | "recovered-backups"
                | "restore-transactions"
                | "texmf"
        );
        let downloads =
            matches!(name, "pandoc" | "typst" | "latex" | "tex-fmt") || legacy_latex == Some(name);
        let disposable = matches!(
            name,
            ".DS_Store" | "Thumbs.db" | "EBWebView" | "WebView2" | "Cache" | "cache"
        );
        if !(disposable || ((shared || !data) && config) || ((shared || data) && downloads)) {
            return Err(format!(
                "MDraft found unrecognized data in its application folder: {name}. Update MDraft or move that item before backing up."
            ));
        }
    }
    Ok(())
}

type Inventory = (Vec<Source>, Vec<Directory>, BTreeMap<String, Category>);

fn collect(
    roots: &Roots,
    include_downloads: bool,
    progress: &mut impl FnMut(u64) -> Result<(), String>,
) -> Result<Inventory, String> {
    let config_exists = exists_without_link(&roots.config)?;
    let data_exists = exists_without_link(&roots.data)?;
    let config_canonical = if config_exists {
        Some(fs::canonicalize(&roots.config).map_err(|error| error.to_string())?)
    } else {
        None
    };
    let data_canonical = if data_exists {
        Some(fs::canonicalize(&roots.data).map_err(|error| error.to_string())?)
    } else {
        None
    };
    let shared = config_canonical.is_some() && config_canonical == data_canonical;
    if let (Some(config), Some(data)) = (&config_canonical, &data_canonical)
        && config != data
        && (config.starts_with(data) || data.starts_with(config))
    {
        return Err("Overlapping application folders cannot be backed up safely.".into());
    }
    let keys = credential_ids(&roots.config)?;
    let latex_directory = crate::latex::backup_directory(&roots.data, &keys)?;
    let latex_source = latex_directory
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("The LaTeX data folder has an invalid name.")?;
    validate_root_entries(&roots.config, shared, false, shared.then_some(latex_source))?;
    if !shared {
        validate_root_entries(&roots.data, false, true, Some(latex_source))?;
    }

    let mut files = Vec::new();
    let mut directories = Vec::new();
    let mut categories = BTreeMap::new();
    for (name, root, source, archive, included) in [
        (
            "settings",
            &roots.config,
            "settings.json",
            "config/settings.json",
            true,
        ),
        (
            "prompts",
            &roots.config,
            "ai-prompts.md",
            "config/ai-prompts.md",
            true,
        ),
        (
            "window",
            &roots.config,
            ".window-state.json",
            "config/.window-state.json",
            true,
        ),
        ("personal", &roots.config, "texmf", "config/texmf", true),
        (
            "recovery",
            &roots.config,
            "recovery",
            "config/recovery",
            true,
        ),
        (
            "recovery",
            &roots.config,
            "recovered-backups",
            "config/recovered-backups",
            true,
        ),
        (
            "downloads",
            &roots.data,
            "pandoc",
            "data/pandoc",
            include_downloads,
        ),
        (
            "downloads",
            &roots.data,
            "typst",
            "data/typst",
            include_downloads,
        ),
        (
            "downloads",
            &roots.data,
            latex_source,
            "data/latex",
            include_downloads,
        ),
        (
            "downloads",
            &roots.data,
            "tex-fmt",
            "data/tex-fmt",
            include_downloads,
        ),
    ] {
        let present = included && exists_without_link(&root.join(source))?;
        let state = categories.entry(name.to_string()).or_insert(Category {
            included,
            present: false,
        });
        state.present |= present;
        if present {
            walk(
                &WalkSource {
                    root,
                    category: name,
                    keys: &keys,
                },
                Path::new(source),
                archive,
                &mut files,
                &mut directories,
                0,
                progress,
            )?;
        }
    }
    categories.insert(
        "session".into(),
        Category {
            included: true,
            present: true,
        },
    );
    Ok((files, directories, categories))
}

/// Estimate saved data only; live editor buffers are captured separately.
pub fn estimate(roots: &Roots) -> Result<(u64, u64), String> {
    let (files, _, _) = collect(roots, true, &mut |_| Ok(()))?;
    let mut saved = 0_u64;
    let mut downloads = 0_u64;
    for file in files {
        let total = if file.category == "downloads" {
            &mut downloads
        } else {
            &mut saved
        };
        *total = total
            .checked_add(file.fingerprint.bytes)
            .ok_or("The backup size estimate is too large.")?;
    }
    Ok((saved, downloads))
}

fn create_private(path: &Path) -> Result<File, String> {
    let parent = path.parent().ok_or("Invalid staging path.")?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path).map_err(|error| error.to_string())
}

/// Stage only registered stores; unclassified files or changing sources fail.
#[cfg(test)]
pub fn capture(
    roots: &Roots,
    staging: &Path,
    settings: &[u8],
    include_downloads: bool,
) -> Result<Captured, String> {
    capture_with(roots, staging, settings, include_downloads, &mut |_| Ok(()))
}

pub fn capture_with(
    roots: &Roots,
    staging: &Path,
    settings: &[u8],
    include_downloads: bool,
    progress: &mut impl FnMut(u64) -> Result<(), String>,
) -> Result<Captured, String> {
    if settings.len() > MAX_SETTINGS
        || !serde_json::from_slice::<serde_json::Value>(settings).is_ok_and(|v| v.is_object())
    {
        return Err("The current preferences snapshot is invalid or too large.".into());
    }
    let stage_canonical = fs::canonicalize(staging).map_err(|error| error.to_string())?;
    for root in [&roots.config, &roots.data] {
        if let Ok(source) = fs::canonicalize(root)
            && (stage_canonical.starts_with(&source) || source.starts_with(&stage_canonical))
        {
            return Err("The staging folder overlaps application data.".into());
        }
    }
    let (sources, directories, mut categories) = collect(roots, include_downloads, progress)?;
    let mut files = Vec::new();
    for source in &sources {
        progress(0)?;
        let archive = if source.archive == "config/settings.json" {
            "preserved/settings-on-disk.json"
        } else {
            &source.archive
        };
        let target = staging.join(archive);
        let mut input = open_regular(&source.root, &source.relative)?;
        if fingerprint(&input)? != source.fingerprint {
            return Err(format!(
                "Application data changed during backup: {}",
                source.archive
            ));
        }
        let mut output = create_private(&target)?;
        let (size, hash) =
            format::copy_hashed_with(&mut input, &mut output, MAX_FILE_BYTES, progress)?;
        output.sync_all().map_err(|error| error.to_string())?;
        input
            .seek(SeekFrom::Start(0))
            .map_err(|error| error.to_string())?;
        let (check_size, check_hash) =
            format::copy_hashed_with(&mut input, &mut std::io::sink(), MAX_FILE_BYTES, progress)?;
        if size != source.fingerprint.bytes
            || size != check_size
            || hash != check_hash
            || fingerprint(&input)? != source.fingerprint
        {
            return Err(format!(
                "Application data changed during backup: {}",
                source.archive
            ));
        }
        files.push(InputFile {
            path: archive.into(),
            category: source.category.into(),
            source: target,
            executable: source.executable,
        });
    }
    let (after, after_directories, _) = collect(roots, include_downloads, progress)?;
    let before_keys: HashSet<_> = sources
        .iter()
        .map(|s| (&s.archive, &s.fingerprint))
        .collect();
    let after_keys: HashSet<_> = after.iter().map(|s| (&s.archive, &s.fingerprint)).collect();
    if before_keys != after_keys
        || directories.iter().collect::<HashSet<_>>()
            != after_directories.iter().collect::<HashSet<_>>()
    {
        return Err("Application data changed during backup. Try again.".into());
    }
    let previous = staging.join("preserved/settings-on-disk.json");
    if previous
        .metadata()
        .is_ok_and(|metadata| metadata.len() == settings.len() as u64)
        && fs::read(&previous).map_err(|error| error.to_string())? == settings
    {
        fs::remove_file(&previous).map_err(|error| error.to_string())?;
        files.retain(|file| file.path != "preserved/settings-on-disk.json");
    }
    let current = staging.join("config/settings.json");
    let mut file = create_private(&current)?;
    file.write_all(settings)
        .and_then(|()| file.sync_all())
        .map_err(|error| error.to_string())?;
    files.push(InputFile {
        path: "config/settings.json".into(),
        category: "settings".into(),
        source: current,
        executable: false,
    });
    if let Some(state) = categories.get_mut("settings") {
        state.present = true;
    }
    Ok(Captured {
        files,
        directories,
        categories,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static NEXT: AtomicUsize = AtomicUsize::new(0);

    struct Scratch(PathBuf);

    impl Scratch {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "mdraft-backup-snapshot-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&root).unwrap();
            Self(root)
        }

        fn directory(&self, name: &str) -> PathBuf {
            let result = self.0.join(name);
            fs::create_dir_all(&result).unwrap();
            result
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            if self.0.parent() == Some(std::env::temp_dir().as_path())
                && self.0.file_name().is_some_and(|name| {
                    name.to_string_lossy()
                        .starts_with("mdraft-backup-snapshot-")
                })
            {
                let _ = fs::remove_dir_all(&self.0);
            }
        }
    }

    #[test]
    fn captures_registered_stores_and_excludes_keys_and_generated_cache() {
        let temp = Scratch::new();
        let root = temp.directory("app");
        let staging = temp.directory("staging");
        fs::write(root.join("settings.json"), br#"{"theme":"light"}"#).unwrap();
        fs::write(root.join("ai-prompts.md"), "custom prompts").unwrap();
        fs::write(root.join("ai-keys.json"), "private sentinel").unwrap();
        fs::create_dir_all(root.join("texmf/tex/latex/local")).unwrap();
        fs::create_dir(root.join("texmf/empty")).unwrap();
        fs::write(root.join("texmf/tex/latex/local/mine.sty"), "package").unwrap();
        fs::create_dir(root.join("recovery")).unwrap();
        fs::write(root.join("recovery/broken.json"), "{invalid").unwrap();
        fs::write(root.join("recovery/writing.json.tmp"), "partial").unwrap();
        fs::create_dir_all(root.join("typst/cache")).unwrap();
        fs::write(root.join("typst/cache/generated.bin"), "cache").unwrap();
        fs::write(root.join("typst/tool.exe"), "tool").unwrap();
        let result = capture(
            &Roots {
                config: root.clone(),
                data: root,
            },
            &staging,
            br#"{"theme":"dark"}"#,
            true,
        )
        .unwrap();
        let names: HashSet<_> = result.files.iter().map(|file| file.path.as_str()).collect();
        for expected in [
            "config/settings.json",
            "preserved/settings-on-disk.json",
            "config/ai-prompts.md",
            "config/recovery/broken.json",
            "config/texmf/tex/latex/local/mine.sty",
            "data/typst/tool.exe",
        ] {
            assert!(names.contains(expected), "missing {expected}");
        }
        assert!(!names.iter().any(|name| name.contains("ai-keys")
            || name.contains("cache")
            || name.ends_with(".tmp")));
        assert_eq!(
            fs::read(staging.join("config/settings.json")).unwrap(),
            br#"{"theme":"dark"}"#
        );
        assert!(result.categories["downloads"].included);
        assert!(
            result
                .directories
                .iter()
                .any(|directory| directory.path == "config/texmf/empty")
        );
    }

    #[test]
    fn estimates_saved_and_downloaded_data_without_credentials() {
        let temp = Scratch::new();
        let config = temp.directory("config");
        let data = temp.directory("data");
        fs::write(config.join("settings.json"), b"{}").unwrap();
        fs::write(config.join("ai-prompts.md"), b"hello").unwrap();
        fs::write(config.join("ai-keys.json"), b"secret").unwrap();
        fs::create_dir(data.join("pandoc")).unwrap();
        fs::write(data.join("pandoc/tool.exe"), b"tool").unwrap();
        assert_eq!(estimate(&Roots { config, data }).unwrap(), (7, 4));
    }

    #[test]
    fn omitted_downloads_and_identical_settings_are_not_copied() {
        let temp = Scratch::new();
        let config = temp.directory("config");
        let data = temp.directory("data");
        let staging = temp.directory("staging");
        fs::write(config.join("settings.json"), b"{}").unwrap();
        fs::create_dir(data.join("pandoc")).unwrap();
        fs::write(data.join("pandoc/tool.exe"), b"tool").unwrap();
        let result = capture(&Roots { config, data }, &staging, b"{}", false).unwrap();
        assert!(!result.categories["downloads"].included);
        assert!(
            !result
                .files
                .iter()
                .any(|file| file.path.starts_with("data/") || file.path.starts_with("preserved/"))
        );
    }

    #[test]
    fn refuses_a_hardlink_to_the_credential_file() {
        for name in ["ai-keys.json", "ai-keys.json.tmp"] {
            let temp = Scratch::new();
            let root = temp.directory("app");
            let staging = temp.directory("staging");
            fs::write(root.join(name), "private sentinel").unwrap();
            fs::create_dir(root.join("texmf")).unwrap();
            fs::hard_link(root.join(name), root.join("texmf/linked.sty")).unwrap();
            let error = capture(
                &Roots {
                    config: root.clone(),
                    data: root,
                },
                &staging,
                b"{}",
                true,
            )
            .err()
            .unwrap();
            assert!(error.contains("hardlink"), "{error}");
        }
    }

    #[test]
    fn refuses_unclassified_data_and_staging_inside_sources() {
        let temp = Scratch::new();
        let root = temp.directory("app");
        let staging = temp.directory("staging");
        fs::write(root.join("unknown-user-data.txt"), "keep me").unwrap();
        let roots = Roots {
            config: root.clone(),
            data: root.clone(),
        };
        assert!(
            capture(&roots, &staging, b"{}", true)
                .err()
                .unwrap()
                .contains("unrecognized")
        );
        fs::remove_file(root.join("unknown-user-data.txt")).unwrap();
        let inside = root.join("staging");
        fs::create_dir(&inside).unwrap();
        assert!(
            capture(&roots, &inside, b"{}", true)
                .err()
                .unwrap()
                .contains("overlaps")
        );
    }
}
