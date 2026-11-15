//! Tauri backup jobs. All paths and temporary files remain owned by Rust.

use super::{buffers, format, gate, inbox, restart, restore, snapshot, transaction};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{Manager, ipc::Channel};

const README: &str = "MDraft application-data backup\n\n\
To restore, open MDraft and choose Preferences > Data > Restore Backup. The app verifies this archive and creates a safety backup before replacing selected settings.\n\n\
This ZIP is not encrypted. It can contain private writing and file paths. API keys, saved documents outside MDraft's folders, external tools and browser data are not included.\n\n\
If MDraft cannot run, first make a copy of your current application data and extract this ZIP into a separate empty folder. Compare file sizes and SHA-256 values with manifest.json. With MDraft closed, copy compatible config and data contents to the app folders; on Windows installed builds those roots can be the same folder, while portable builds use app-data/config and app-data/data beside the executable. On Linux the usual locations are under the XDG config and data directories. Do not copy WebView profiles or run tools from an untrusted backup.\n\n\
Unsaved text is under session/buffers. Open it as a new document and save a copy instead of overwriting an original. Disable imported AI, after-export commands and native tools until you have checked their settings.\n";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub job_id: String,
    pub phase: String,
    pub bytes: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupResult {
    pub path: String,
    pub bytes: u64,
    pub captured_at_ms: u64,
    pub files: usize,
}

struct Destination {
    path: PathBuf,
    display_path: PathBuf,
}

struct CaptureData {
    guard: gate::Capture<'static>,
    captured: snapshot::Captured,
    buffers: buffers::Capture,
    destination: Destination,
    started_ms: u64,
    portable: bool,
}

struct RestorePreviewData {
    manifest: format::Manifest,
    preview: restore::Preview,
    source: PathBuf,
}

struct RestoreCaptureData {
    capture: CaptureData,
    prepared: restore::Prepared,
    preview: restore::Preview,
}

struct RestoreReadyData {
    guard: Option<gate::Capture<'static>>,
    close_guard: Option<gate::CloseBarrier<'static>>,
    prepared: restore::Prepared,
    preview: restore::Preview,
    safety: BackupResult,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreReview {
    pub backup: restore::Preview,
    pub safety_backup: BackupResult,
    pub recovered_documents: usize,
    pub salvaged_journals: usize,
    pub quarantined_downloads: usize,
    pub adjustments: Vec<String>,
}

enum Phase {
    Preparing,
    Capturing(Box<CaptureData>),
    RestorePreview(Box<RestorePreviewData>),
    RestoreCapturing(Box<RestoreCaptureData>),
    RestoreReady(Box<RestoreReadyData>),
    RestoreClosing(Box<RestoreReadyData>),
    RestoreArmed { _guard: gate::Capture<'static> },
    Finishing,
    Finished,
}

struct Job {
    id: String,
    owner: String,
    stage: PathBuf,
    cache: PathBuf,
    canceled: AtomicBool,
    phase: Mutex<Phase>,
    changed: Condvar,
    progress: Channel<Progress>,
}

#[derive(Clone, Default)]
pub struct Jobs {
    current: Arc<Mutex<Option<Arc<Job>>>>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn valid_job_id(id: &str) -> bool {
    id.len() == 36
        && id.bytes().enumerate().all(|(index, byte)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        })
}

fn owner(window: &tauri::WebviewWindow) -> Result<String, String> {
    if window.label() != "main" {
        return Err("Only the main MDraft window can manage application data.".into());
    }
    Ok(window.label().to_string())
}

impl Jobs {
    pub fn is_active(&self) -> Result<bool, String> {
        self.current
            .lock()
            .map(|current| current.is_some())
            .map_err(|_| "The data operation is unavailable.".into())
    }

    fn reserve(&self, job: Arc<Job>) -> Result<(), String> {
        let mut current = self
            .current
            .lock()
            .map_err(|_| "The data operation is unavailable.")?;
        if current.is_some() {
            return Err("Another application-data operation is already running.".into());
        }
        *current = Some(job);
        Ok(())
    }

    fn find(&self, id: &str, window: &str) -> Result<Arc<Job>, String> {
        let current = self
            .current
            .lock()
            .map_err(|_| "The data operation is unavailable.")?;
        current
            .as_ref()
            .filter(|job| job.id == id && job.owner == window)
            .cloned()
            .ok_or_else(|| "The application-data operation is no longer available.".into())
    }

    fn release(&self, job: &Arc<Job>) {
        if let Ok(mut current) = self.current.lock()
            && current
                .as_ref()
                .is_some_and(|other| Arc::ptr_eq(other, job))
        {
            *current = None;
        }
    }
}

fn private_dir(path: &Path) -> Result<(), String> {
    super::private_fs::create_dir(path)
}

fn private_file(path: &Path) -> Result<FileHandle, String> {
    let mut options = OpenOptions::new();
    options.write(true).read(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
        .open(path)
        .map_err(|error| format!("Could not create a temporary backup file: {error}"))
}

type FileHandle = std::fs::File;

/// Publish a completed file without a check-then-overwrite race.
#[cfg(windows)]
pub(super) fn publish_new(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows::Win32::Storage::FileSystem::MoveFileW;
    use windows::core::PCWSTR;
    let source: Vec<u16> = source
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let destination: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    // MoveFileW has no replace-existing flag and both paths share a directory.
    unsafe { MoveFileW(PCWSTR(source.as_ptr()), PCWSTR(destination.as_ptr())) }
        .map_err(|error| std::io::Error::from_raw_os_error(error.code().0 & 0xffff))
}

#[cfg(target_os = "linux")]
pub(super) fn publish_new(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let source = CString::new(source.as_os_str().as_bytes())
        .map_err(|_| std::io::ErrorKind::InvalidInput)?;
    let destination = CString::new(destination.as_os_str().as_bytes())
        .map_err(|_| std::io::ErrorKind::InvalidInput)?;
    let result = unsafe {
        libc::renameat2(
            libc::AT_FDCWD,
            source.as_ptr(),
            libc::AT_FDCWD,
            destination.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(target_os = "macos")]
pub(super) fn publish_new(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let source = CString::new(source.as_os_str().as_bytes())
        .map_err(|_| std::io::ErrorKind::InvalidInput)?;
    let destination = CString::new(destination.as_os_str().as_bytes())
        .map_err(|_| std::io::ErrorKind::InvalidInput)?;
    let result =
        unsafe { libc::renamex_np(source.as_ptr(), destination.as_ptr(), libc::RENAME_EXCL) };
    if result == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
pub(super) fn publish_new(source: &Path, destination: &Path) -> std::io::Result<()> {
    fs::hard_link(source, destination)?;
    fs::remove_file(source)
}

fn roots(app: &tauri::AppHandle) -> Result<snapshot::Roots, String> {
    Ok(snapshot::Roots {
        config: app
            .path()
            .app_config_dir()
            .map_err(|error| format!("Cannot locate settings: {error}"))?,
        data: app
            .path()
            .app_data_dir()
            .map_err(|error| format!("Cannot locate application data: {error}"))?,
    })
}

fn captured_settings(
    app: &tauri::AppHandle,
    expected: &crate::settings::Settings,
) -> Result<Vec<u8>, String> {
    let state = app.state::<crate::settings::AppState>();
    let current = state
        .settings
        .lock()
        .map_err(|_| "The application settings are unavailable.")?;
    let expected = serde_json::to_value(expected).map_err(|error| error.to_string())?;
    if serde_json::to_value(&*current).map_err(|error| error.to_string())? != expected {
        return Err("Settings changed while preparing the backup. Please try again.".into());
    }
    serde_json::to_vec_pretty(&*current).map_err(|error| error.to_string())
}

fn cache_root(app: &tauri::AppHandle, roots: &snapshot::Roots) -> Result<PathBuf, String> {
    let root = app
        .path()
        .app_cache_dir()
        .map_err(|error| format!("Cannot locate private staging: {error}"))?;
    fs::create_dir_all(&root).map_err(|error| format!("Cannot create private staging: {error}"))?;
    let metadata = fs::symlink_metadata(&root).map_err(|error| error.to_string())?;
    if snapshot::is_link(&metadata) || !metadata.is_dir() {
        return Err("The private staging folder is unsafe.".into());
    }
    let cache = fs::canonicalize(&root).map_err(|error| error.to_string())?;
    for path in [&roots.config, &roots.data] {
        if let Ok(source) = fs::canonicalize(path)
            && (cache.starts_with(&source) || source.starts_with(&cache))
        {
            return Err("The private staging folder overlaps application data.".into());
        }
    }
    Ok(cache)
}

fn validate_destination(
    path: &Path,
    roots: &snapshot::Roots,
    cache: &Path,
) -> Result<Destination, String> {
    let display_path = path.to_path_buf();
    if !path.is_absolute()
        || !path
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("zip"))
    {
        return Err("Choose an absolute file name ending in .zip.".into());
    }
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("The backup file name is invalid.")?;
    format::validate_name(name)?;
    let parent = path
        .parent()
        .ok_or("The backup destination has no folder.")?;
    let parent = fs::canonicalize(parent)
        .map_err(|error| format!("Cannot open the destination folder: {error}"))?;
    for source in [&roots.config, &roots.data, cache] {
        if let Ok(source) = fs::canonicalize(source)
            && parent.starts_with(source)
        {
            return Err("Choose a folder outside MDraft's application data and cache.".into());
        }
    }
    let path = parent.join(name);
    match fs::symlink_metadata(&path) {
        Ok(_) => {
            return Err("A file already exists at that location. Choose a new backup name.".into());
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("Cannot inspect the backup destination: {error}")),
    }
    Ok(Destination { path, display_path })
}

fn remove_staging(job: &Job) -> Result<(), String> {
    if job.stage.parent() != Some(job.cache.as_path())
        || job.stage.file_name().and_then(|name| name.to_str())
            != Some(format!("mdraft-data-job-{}", job.id).as_str())
    {
        return Err("Refused to remove an unrecognized staging folder.".into());
    }
    match fs::symlink_metadata(&job.stage) {
        Ok(meta) if snapshot::is_link(&meta) || !meta.is_dir() => {
            Err("The staging folder changed and was preserved.".into())
        }
        Ok(_) => fs::remove_dir_all(&job.stage)
            .map_err(|error| format!("Could not remove private staging: {error}")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

fn complete(jobs: &Jobs, job: &Arc<Job>) -> Result<(), String> {
    let cleanup = remove_staging(job);
    if let Ok(mut phase) = job.phase.lock() {
        *phase = Phase::Finished;
        job.changed.notify_all();
    }
    jobs.release(job);
    cleanup
}

struct Reporter<'a> {
    job: &'a Job,
    phase: &'static str,
    bytes: u64,
    last: Instant,
}

impl<'a> Reporter<'a> {
    fn new(job: &'a Job, phase: &'static str) -> Self {
        let reporter = Self {
            job,
            phase,
            bytes: 0,
            last: Instant::now(),
        };
        reporter.emit();
        reporter
    }

    fn emit(&self) {
        let _ = self.job.progress.send(Progress {
            job_id: self.job.id.clone(),
            phase: self.phase.into(),
            bytes: self.bytes,
        });
    }

    fn tick(&mut self, bytes: u64) -> Result<(), String> {
        if self.job.canceled.load(Ordering::Acquire) {
            return Err("The data operation was canceled.".into());
        }
        self.bytes = self.bytes.saturating_add(bytes);
        if self.last.elapsed() >= Duration::from_millis(250) {
            self.emit();
            self.last = Instant::now();
        }
        Ok(())
    }
}

fn output_manifest(data: &CaptureData, completed_ms: u64) -> format::Manifest {
    format::Manifest {
        format: format::FORMAT.into(),
        format_version: format::VERSION,
        app_version: env!("CARGO_PKG_VERSION").into(),
        created_at_ms: completed_ms,
        capture_started_ms: data.started_ms,
        capture_finished_ms: completed_ms,
        source_os: std::env::consts::OS.into(),
        source_arch: std::env::consts::ARCH.into(),
        portable: data.portable,
        component_versions: data
            .captured
            .categories
            .keys()
            .map(|name| (name.clone(), 1))
            .collect::<BTreeMap<_, _>>(),
        categories: data.captured.categories.clone(),
        directories: data.captured.directories.clone(),
        entries: Vec::new(),
    }
}

#[cfg(windows)]
fn available_space(path: &Path) -> Result<u64, String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    use windows::core::PCWSTR;
    let path: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut available = 0;
    // The buffer is null-terminated and remains alive for the duration of the call.
    unsafe { GetDiskFreeSpaceExW(PCWSTR(path.as_ptr()), Some(&mut available), None, None) }
        .map_err(|error| format!("Could not check available backup space: {error}"))?;
    Ok(available)
}

#[cfg(unix)]
fn available_space(path: &Path) -> Result<u64, String> {
    use std::os::unix::ffi::OsStrExt;
    let path = std::ffi::CString::new(path.as_os_str().as_bytes())
        .map_err(|_| "The backup folder has an invalid path.")?;
    let mut value = std::mem::MaybeUninit::<libc::statvfs>::uninit();
    // statvfs initializes the structure on success; the path is null-terminated.
    if unsafe { libc::statvfs(path.as_ptr(), value.as_mut_ptr()) } != 0 {
        return Err(format!(
            "Could not check available backup space: {}",
            std::io::Error::last_os_error()
        ));
    }
    let value = unsafe { value.assume_init() };
    Ok((value.f_bavail as u64).saturating_mul(value.f_frsize as u64))
}

fn archive_space_bound(
    files: &[format::InputFile],
    directories: &[format::Directory],
) -> Result<u64, String> {
    let mut bytes = 64 * 1024_u64;
    for file in files {
        let length = fs::metadata(&file.source)
            .map_err(|error| format!("Could not inspect staged backup data: {error}"))?
            .len();
        // Deflate can expand incompressible data. Include room for ZIP records
        // and both names and JSON-escaped manifest paths for each entry.
        bytes = bytes
            .saturating_add(length)
            .saturating_add(length / 100)
            .saturating_add(1024)
            .saturating_add((file.path.len() as u64).saturating_mul(4));
    }
    for directory in directories {
        bytes = bytes
            .saturating_add(1024)
            .saturating_add((directory.path.len() as u64).saturating_mul(4));
    }
    Ok(bytes)
}

fn require_archive_space(available: u64, required: u64) -> Result<(), String> {
    if available < required {
        return Err(
            "There may not be enough space for the backup. Choose a folder with more free space or free space and try again."
                .into(),
        );
    }
    Ok(())
}

fn finish_backup(
    job: &Arc<Job>,
    data: CaptureData,
    keep_capture: bool,
) -> Result<(BackupResult, Option<gate::Capture<'static>>), String> {
    let captured_at = now_ms();
    let manifest = output_manifest(&data, captured_at);
    let CaptureData {
        guard,
        mut captured,
        buffers,
        destination,
        ..
    } = data;
    captured.files.extend(buffers.seal()?);
    let readme = job.stage.join("snapshot/README.txt");
    let mut readme_file = private_file(&readme)?;
    readme_file
        .write_all(README.as_bytes())
        .and_then(|()| readme_file.sync_all())
        .map_err(|error| error.to_string())?;
    captured.files.push(format::InputFile {
        path: "README.txt".into(),
        category: "readme".into(),
        source: readme,
        executable: false,
    });
    // A standalone export releases its barrier after sealing. Restore retains
    // it until the final review so the safety copy cannot become stale.
    let retained = if keep_capture {
        Some(guard)
    } else {
        drop(guard);
        None
    };
    let parent = destination
        .path
        .parent()
        .ok_or("Invalid backup destination.")?;
    require_archive_space(
        available_space(parent)?,
        archive_space_bound(&captured.files, &manifest.directories)?,
    )?;
    let temporary = parent.join(format!(".mdraft-backup-{}.partial", job.id));
    let output = private_file(&temporary)?;
    let result = (|| {
        let mut report = Reporter::new(job, "compressing");
        format::write_archive_to(output, manifest, &captured.files, &mut |count| {
            report.tick(count)
        })?;
        let mut report = Reporter::new(job, "verifying");
        let verified =
            format::verify_archive_with(&temporary, None, &mut |count| report.tick(count))?;
        report.tick(0)?;
        report.tick(0)?;
        // Never overwrite a file that appeared after the picker.
        publish_new(&temporary, &destination.path).map_err(|error| {
            format!(
                "Could not save the completed backup without replacing an existing file: {error}"
            )
        })?;
        let bytes = fs::metadata(&destination.path)
            .map_err(|error| error.to_string())?
            .len();
        Ok(BackupResult {
            path: destination.display_path.to_string_lossy().into_owned(),
            bytes,
            captured_at_ms: captured_at,
            files: verified.entries.len(),
        })
    })();
    if result.is_err() && temporary.exists() {
        fs::remove_file(&temporary).map_err(|error| {
            format!("The backup failed and its temporary file could not be removed: {error}")
        })?;
    }
    result.map(|result| (result, retained))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupEstimate {
    saved_bytes: u64,
    download_bytes: u64,
}

#[tauri::command]
pub async fn estimate_data_backup(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<BackupEstimate, String> {
    owner(&window)?;
    let roots = roots(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let (saved_bytes, download_bytes) = snapshot::estimate(&roots)?;
        Ok(BackupEstimate {
            saved_bytes,
            download_bytes,
        })
    })
    .await
    .unwrap_or_else(|error| Err(format!("Could not estimate backup size: {error}")))
}

#[tauri::command]
#[allow(clippy::too_many_arguments)] // Tauri injects the app, window and job state.
pub async fn begin_data_backup(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    jobs: tauri::State<'_, Jobs>,
    job_id: String,
    destination: String,
    include_downloads: bool,
    settings: crate::settings::Settings,
    buffer_count: usize,
    active_id: Option<String>,
    on_progress: Channel<Progress>,
) -> Result<String, String> {
    let owner = owner(&window)?;
    if !valid_job_id(&job_id) {
        return Err("The backup operation has an invalid identity.".into());
    }
    let roots = roots(&app)?;
    let cache = cache_root(&app, &roots)?;
    let stage = cache.join(format!("mdraft-data-job-{job_id}"));
    let destination = validate_destination(Path::new(&destination), &roots, &cache)?;
    let job = Arc::new(Job {
        id: job_id.clone(),
        owner,
        stage,
        cache,
        canceled: AtomicBool::new(false),
        phase: Mutex::new(Phase::Preparing),
        changed: Condvar::new(),
        progress: on_progress,
    });
    jobs.reserve(job.clone())?;
    let jobs = jobs.inner().clone();
    let worker = job.clone();
    let portable = app.config().app.app_directories_override.is_some();
    let capture_app = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        private_dir(&worker.stage)?;
        let stage = worker.stage.join("snapshot");
        private_dir(&stage)?;
        let mut report = Reporter::new(&worker, "preparing");
        let guard = gate::capture(&worker.canceled)?;
        let started_ms = now_ms();
        let settings = captured_settings(&capture_app, &settings)?;
        let captured =
            snapshot::capture_with(&roots, &stage, &settings, include_downloads, &mut |count| {
                report.tick(count)
            })?;
        let buffers = buffers::Capture::new(
            &stage,
            buffer_count,
            active_id,
            snapshot::credential_ids(&roots.config)?,
        )?;
        report.tick(0)?;
        let mut phase = worker
            .phase
            .lock()
            .map_err(|_| "The data operation is unavailable.")?;
        *phase = Phase::Capturing(Box::new(CaptureData {
            guard,
            captured,
            buffers,
            destination,
            started_ms,
            portable,
        }));
        worker.changed.notify_all();
        Ok::<(), String>(())
    })
    .await
    .unwrap_or_else(|error| Err(format!("Could not start backup: {error}")));
    if let Err(error) = result {
        let cleanup = complete(&jobs, &job);
        return Err(match cleanup {
            Ok(()) => error,
            Err(cleanup) => format!("{error} {cleanup}"),
        });
    }
    Ok(job_id)
}

fn with_capture<T>(
    jobs: &Jobs,
    id: &str,
    window: &str,
    operation: impl FnOnce(&mut CaptureData) -> Result<T, String>,
) -> Result<T, String> {
    let job = jobs.find(id, window)?;
    if job.canceled.load(Ordering::Acquire) {
        return Err("The backup was canceled.".into());
    }
    let mut phase = job
        .phase
        .lock()
        .map_err(|_| "The data operation is unavailable.")?;
    match &mut *phase {
        Phase::Capturing(data) => operation(data),
        Phase::RestoreCapturing(data) => operation(&mut data.capture),
        _ => Err("The backup is not accepting document data.".into()),
    }
}

#[tauri::command]
pub fn begin_backup_buffer(
    window: tauri::WebviewWindow,
    jobs: tauri::State<'_, Jobs>,
    job_id: String,
    metadata: inbox::Buffer,
) -> Result<(), String> {
    with_capture(&jobs, &job_id, &owner(&window)?, |data| {
        data.buffers.begin(metadata)
    })
}

#[tauri::command]
pub fn append_backup_buffer(
    window: tauri::WebviewWindow,
    jobs: tauri::State<'_, Jobs>,
    job_id: String,
    buffer_id: String,
    sequence: u64,
    bytes: Vec<u8>,
) -> Result<u64, String> {
    with_capture(&jobs, &job_id, &owner(&window)?, |data| {
        data.buffers.append(&buffer_id, sequence, &bytes)
    })
}

#[tauri::command]
pub fn finish_backup_buffer(
    window: tauri::WebviewWindow,
    jobs: tauri::State<'_, Jobs>,
    job_id: String,
    buffer_id: String,
    sequences: u64,
    bytes: u64,
) -> Result<(), String> {
    with_capture(&jobs, &job_id, &owner(&window)?, |data| {
        data.buffers.finish(&buffer_id, sequences, bytes)
    })
}

#[tauri::command]
pub async fn finish_data_backup(
    window: tauri::WebviewWindow,
    jobs: tauri::State<'_, Jobs>,
    job_id: String,
) -> Result<BackupResult, String> {
    let job = jobs.find(&job_id, &owner(&window)?)?;
    let data = {
        let mut phase = job
            .phase
            .lock()
            .map_err(|_| "The data operation is unavailable.")?;
        match std::mem::replace(&mut *phase, Phase::Finishing) {
            Phase::Capturing(data) => *data,
            other => {
                *phase = other;
                return Err("The backup is not ready to finish.".into());
            }
        }
    };
    let jobs = jobs.inner().clone();
    let worker = job.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        finish_backup(&worker, data, false).map(|(result, _)| result)
    })
    .await
    .unwrap_or_else(|error| Err(format!("Could not finish backup: {error}")));
    let cleanup = complete(&jobs, &job);
    match (result, cleanup) {
        (Ok(result), Ok(())) => Ok(result),
        (Err(error), Ok(())) => Err(error),
        (Ok(_), Err(cleanup)) => Err(format!("The backup was saved, but {cleanup}")),
        (Err(error), Err(cleanup)) => Err(format!("{error} {cleanup}")),
    }
}

#[tauri::command]
pub async fn inspect_data_restore(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    jobs: tauri::State<'_, Jobs>,
    job_id: String,
    source: String,
    on_progress: Channel<Progress>,
) -> Result<restore::Preview, String> {
    let owner = owner(&window)?;
    if !valid_job_id(&job_id) {
        return Err("The restore operation has an invalid identity.".into());
    }
    let source = PathBuf::from(source);
    if !source.is_absolute()
        || !source
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("zip"))
    {
        return Err("Choose an absolute ZIP backup file.".into());
    }
    let roots = roots(&app)?;
    let cache = cache_root(&app, &roots)?;
    let stage = cache.join(format!("mdraft-data-job-{job_id}"));
    let job = Arc::new(Job {
        id: job_id,
        owner,
        stage,
        cache,
        canceled: AtomicBool::new(false),
        phase: Mutex::new(Phase::Preparing),
        changed: Condvar::new(),
        progress: on_progress,
    });
    jobs.reserve(job.clone())?;
    let jobs = jobs.inner().clone();
    let worker = job.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        private_dir(&worker.stage)?;
        let mut report = Reporter::new(&worker, "checking");
        let baseline = transaction::tree_digest_with(&source, &mut |count| report.tick(count))?
            .ok_or("The selected backup no longer exists.")?;
        let manifest = format::verify_archive_with(
            &source,
            Some(&worker.stage.join("extracted")),
            &mut |count| report.tick(count),
        )?;
        report.tick(0)?;
        if transaction::tree_digest_with(&source, &mut |count| report.tick(count))?.as_deref()
            != Some(&baseline)
        {
            return Err("The selected backup changed while it was being checked.".into());
        }
        report.tick(0)?;
        let preview = restore::preview(&manifest)?;
        let mut phase = worker
            .phase
            .lock()
            .map_err(|_| "The data operation is unavailable.")?;
        *phase = Phase::RestorePreview(Box::new(RestorePreviewData {
            manifest,
            preview: preview.clone(),
            source,
        }));
        worker.changed.notify_all();
        Ok::<restore::Preview, String>(preview)
    })
    .await
    .unwrap_or_else(|error| Err(format!("Could not check the backup: {error}")));
    if let Err(error) = result {
        let cleanup = complete(&jobs, &job);
        return Err(match cleanup {
            Ok(()) => error,
            Err(cleanup) => format!("{error} {cleanup}"),
        });
    }
    result
}

#[tauri::command]
#[allow(clippy::too_many_arguments)] // Tauri injects the app, window and job state.
pub async fn begin_restore_safety_backup(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    jobs: tauri::State<'_, Jobs>,
    job_id: String,
    destination: String,
    selection: restore::Selection,
    settings: crate::settings::Settings,
    buffer_count: usize,
    active_id: Option<String>,
) -> Result<(), String> {
    let job = jobs.find(&job_id, &owner(&window)?)?;
    let roots = roots(&app)?;
    let destination = validate_destination(Path::new(&destination), &roots, &job.cache)?;
    let preview = {
        let mut phase = job
            .phase
            .lock()
            .map_err(|_| "The data operation is unavailable.")?;
        if let Phase::RestorePreview(data) = &*phase {
            let source = fs::canonicalize(&data.source)
                .map_err(|error| format!("Cannot inspect the selected backup: {error}"))?;
            if destination.path == source {
                return Err("Choose a different file for the safety backup.".into());
            }
        }
        match std::mem::replace(&mut *phase, Phase::Preparing) {
            Phase::RestorePreview(data) => *data,
            other => {
                *phase = other;
                return Err("The restore preview is no longer available.".into());
            }
        }
    };
    let jobs = jobs.inner().clone();
    let worker = job.clone();
    let portable = app.config().app.app_directories_override.is_some();
    let capture_app = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let mut report = Reporter::new(&worker, "preparing-restore");
        let guard = gate::capture(&worker.canceled)?;
        // The close guard can discard a currently open recovered copy after
        // this point. Do not deduplicate against that mutable inbox: the copy
        // being restored must still exist if the reader chooses Discard.
        let existing = std::collections::HashSet::new();
        let prepared = restore::prepare_with(
            &worker.stage.join("extracted"),
            &worker.stage.join("prepared"),
            &preview.manifest,
            &selection,
            &existing,
            &mut |count| report.tick(count),
        )?;
        let stage = worker.stage.join("snapshot");
        private_dir(&stage)?;
        let started_ms = now_ms();
        let settings = captured_settings(&capture_app, &settings)?;
        let captured = snapshot::capture_with(&roots, &stage, &settings, true, &mut |count| {
            report.tick(count)
        })?;
        let buffers = buffers::Capture::new(
            &stage,
            buffer_count,
            active_id,
            snapshot::credential_ids(&roots.config)?,
        )?;
        report.tick(0)?;
        let mut phase = worker
            .phase
            .lock()
            .map_err(|_| "The data operation is unavailable.")?;
        *phase = Phase::RestoreCapturing(Box::new(RestoreCaptureData {
            capture: CaptureData {
                guard,
                captured,
                buffers,
                destination,
                started_ms,
                portable,
            },
            prepared,
            preview: preview.preview,
        }));
        worker.changed.notify_all();
        Ok::<(), String>(())
    })
    .await
    .unwrap_or_else(|error| Err(format!("Could not prepare the restore: {error}")));
    if let Err(error) = result {
        let cleanup = complete(&jobs, &job);
        return Err(match cleanup {
            Ok(()) => error,
            Err(cleanup) => format!("{error} {cleanup}"),
        });
    }
    Ok(())
}

#[tauri::command]
pub async fn finish_restore_safety_backup(
    window: tauri::WebviewWindow,
    jobs: tauri::State<'_, Jobs>,
    job_id: String,
) -> Result<RestoreReview, String> {
    let job = jobs.find(&job_id, &owner(&window)?)?;
    let data = {
        let mut phase = job
            .phase
            .lock()
            .map_err(|_| "The data operation is unavailable.")?;
        match std::mem::replace(&mut *phase, Phase::Finishing) {
            Phase::RestoreCapturing(data) => *data,
            other => {
                *phase = other;
                return Err("The restore is not ready for its safety backup.".into());
            }
        }
    };
    let jobs = jobs.inner().clone();
    let worker = job.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let RestoreCaptureData {
            capture,
            prepared,
            preview,
        } = data;
        let (safety, guard) = finish_backup(&worker, capture, true)?;
        if worker.canceled.load(Ordering::Acquire) {
            return Err("The restore was canceled. The safety backup was kept.".into());
        }
        let review = RestoreReview {
            backup: preview.clone(),
            safety_backup: safety.clone(),
            recovered_documents: prepared.recovered_documents,
            salvaged_journals: prepared.salvaged_journals,
            quarantined_downloads: prepared.quarantined_downloads,
            adjustments: prepared.adjustments.clone(),
        };
        let mut phase = worker
            .phase
            .lock()
            .map_err(|_| "The data operation is unavailable.")?;
        *phase = Phase::RestoreReady(Box::new(RestoreReadyData {
            guard,
            close_guard: None,
            prepared,
            preview,
            safety,
        }));
        worker.changed.notify_all();
        Ok::<RestoreReview, String>(review)
    })
    .await
    .unwrap_or_else(|error| Err(format!("Could not create the safety backup: {error}")));
    if let Err(error) = result {
        let cleanup = complete(&jobs, &job);
        return Err(match cleanup {
            Ok(()) => error,
            Err(cleanup) => format!("{error} {cleanup}"),
        });
    }
    result
}

#[tauri::command]
pub fn release_restore_for_close(
    window: tauri::WebviewWindow,
    jobs: tauri::State<'_, Jobs>,
    job_id: String,
) -> Result<(), String> {
    let job = jobs.find(&job_id, &owner(&window)?)?;
    let mut phase = job
        .phase
        .lock()
        .map_err(|_| "The data operation is unavailable.")?;
    match std::mem::replace(&mut *phase, Phase::Finishing) {
        Phase::RestoreReady(mut data) => {
            let Some(guard) = data.guard.take() else {
                *phase = Phase::RestoreReady(data);
                return Err("The restore barrier is unavailable.".into());
            };
            match guard.into_close_barrier() {
                Ok(barrier) => data.close_guard = Some(barrier),
                Err(error) => {
                    *phase = Phase::RestoreReady(data);
                    return Err(error);
                }
            }
            *phase = Phase::RestoreClosing(data);
            Ok(())
        }
        other => {
            *phase = other;
            Err("The restore is not ready to close.".into())
        }
    }
}

#[tauri::command]
pub async fn arm_data_restore(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    jobs: tauri::State<'_, Jobs>,
    job_id: String,
) -> Result<(), String> {
    let job = jobs.find(&job_id, &owner(&window)?)?;
    let roots = roots(&app)?;
    let data = {
        let mut phase = job
            .phase
            .lock()
            .map_err(|_| "The data operation is unavailable.")?;
        match std::mem::replace(&mut *phase, Phase::Finishing) {
            Phase::RestoreClosing(data) => *data,
            other => {
                *phase = other;
                return Err("The restore is not ready to restart.".into());
            }
        }
    };
    let identifier = app.config().identifier.clone();
    let worker = job.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let mut data = data;
        let guard = data
            .close_guard
            .take()
            .ok_or("The restore close barrier is unavailable.")?
            .capture(&worker.canceled)?;
        let mut journal = transaction::prepare(&roots, &worker.id, &data.prepared.replacements)?;
        let review = RestoreReview {
            backup: data.preview,
            safety_backup: data.safety,
            recovered_documents: data.prepared.recovered_documents,
            salvaged_journals: data.prepared.salvaged_journals,
            quarantined_downloads: data.prepared.quarantined_downloads,
            adjustments: data.prepared.adjustments,
        };
        let mut phase = worker
            .phase
            .lock()
            .map_err(|_| "The data operation is unavailable.")?;
        if worker.canceled.load(Ordering::Acquire) {
            transaction::rollback(&roots, &mut journal)?;
            transaction::cleanup(&roots, &journal)?;
            return Err("The restore was canceled; the safety backup was kept.".into());
        }
        if let Err(error) = restart::arm(&roots, &identifier, &worker.id, review) {
            if restart::disarm(&roots, &worker.id).is_err() {
                // A marker may already be durable. Keep the gate held and let
                // the headless startup resolve it before opening the profile.
                *phase = Phase::RestoreArmed { _guard: guard };
                worker.changed.notify_all();
                return Ok(());
            }
            transaction::rollback(&roots, &mut journal)?;
            transaction::cleanup(&roots, &journal)?;
            return Err(error);
        }
        *phase = Phase::RestoreArmed { _guard: guard };
        worker.changed.notify_all();
        drop(phase);
        // The transaction has its own verified staging; the ZIP inspection and
        // snapshot workspace is no longer needed after the marker is durable.
        let _ = remove_staging(&worker);
        Ok::<(), String>(())
    })
    .await
    .unwrap_or_else(|error| Err(format!("Could not arm the restore: {error}")));
    if let Err(error) = result {
        let cleanup = complete(jobs.inner(), &job);
        return Err(match cleanup {
            Ok(()) => error,
            Err(cleanup) => format!("{error} {cleanup}"),
        });
    }
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(250));
        handle.request_restart();
    });
    Ok(())
}

#[tauri::command]
pub async fn cancel_data_backup(
    window: tauri::WebviewWindow,
    jobs: tauri::State<'_, Jobs>,
    job_id: String,
) -> Result<(), String> {
    let job = match jobs.find(&job_id, &owner(&window)?) {
        Ok(job) => job,
        Err(_) => return Ok(()),
    };
    job.canceled.store(true, Ordering::Release);
    let jobs = jobs.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut phase = job
            .phase
            .lock()
            .map_err(|_| "The data operation is unavailable.")?;
        loop {
            match &*phase {
                Phase::Capturing(_)
                | Phase::RestorePreview(_)
                | Phase::RestoreCapturing(_)
                | Phase::RestoreReady(_)
                | Phase::RestoreClosing(_) => {
                    let old = std::mem::replace(&mut *phase, Phase::Finished);
                    drop(old);
                    job.changed.notify_all();
                    drop(phase);
                    return complete(&jobs, &job);
                }
                Phase::Finished => return Ok(()),
                Phase::RestoreArmed { .. } => {
                    return Err("The restore has already started and cannot be canceled.".into());
                }
                Phase::Preparing | Phase::Finishing => {
                    phase = job
                        .changed
                        .wait(phase)
                        .map_err(|_| "The data operation is unavailable.")?;
                }
            }
        }
    })
    .await
    .map_err(|error| format!("Could not cancel backup: {error}"))?
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
                "mdraft-backup-jobs-{}-{}",
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
                    .is_some_and(|name| name.to_string_lossy().starts_with("mdraft-backup-jobs-"))
            {
                let _ = fs::remove_dir_all(&self.0);
            }
        }
    }

    fn setup(
        temp: &Scratch,
        existing: bool,
    ) -> (Arc<Job>, CaptureData, PathBuf, &'static gate::Gate) {
        let id = "00000000-0000-4000-8000-000000000001";
        let config = temp.0.join("config");
        let cache = temp.0.join("cache");
        fs::create_dir(&config).unwrap();
        fs::create_dir(&cache).unwrap();
        fs::write(config.join("settings.json"), b"{}").unwrap();
        let roots = snapshot::Roots {
            config: config.clone(),
            data: config,
        };
        let destination_path = temp.0.join("backup.zip");
        let destination = validate_destination(&destination_path, &roots, &cache).unwrap();
        if existing {
            fs::write(&destination_path, b"previous backup").unwrap();
        }
        let stage = cache.join(format!("mdraft-data-job-{id}"));
        private_dir(&stage).unwrap();
        private_dir(&stage.join("snapshot")).unwrap();
        let canceled = AtomicBool::new(false);
        // A private gate keeps parallel application tests independent.
        let test_gate = Box::leak(Box::new(gate::Gate::default()));
        let guard = test_gate.capture(&canceled).unwrap();
        let settings = serde_json::to_vec(&crate::settings::Settings::default()).unwrap();
        let captured = snapshot::capture(&roots, &stage.join("snapshot"), &settings, true).unwrap();
        let buffers = buffers::Capture::new(
            &stage.join("snapshot"),
            0,
            None,
            snapshot::CredentialIds::default(),
        )
        .unwrap();
        let job = Arc::new(Job {
            id: id.into(),
            owner: "main".into(),
            stage,
            cache,
            canceled: AtomicBool::new(false),
            phase: Mutex::new(Phase::Finishing),
            changed: Condvar::new(),
            progress: Channel::new(|_| Ok(())),
        });
        let data = CaptureData {
            guard,
            captured,
            buffers,
            destination,
            started_ms: now_ms(),
            portable: false,
        };
        (job, data, destination_path, test_gate)
    }

    #[test]
    fn creates_a_verified_archive_and_releases_the_capture_gate() {
        let temp = Scratch::new();
        let (job, data, destination, test_gate) = setup(&temp, false);
        let (result, _) = finish_backup(&job, data, false).unwrap();
        assert_eq!(result.path, destination.to_string_lossy());
        assert!(format::verify_archive(&destination, None).is_ok());
        assert!(test_gate.writer().is_ok());
        remove_staging(&job).unwrap();
    }

    #[test]
    fn checks_destination_space_before_writing_the_zip() {
        let temp = Scratch::new();
        let source = temp.0.join("source");
        fs::write(&source, b"saved text").unwrap();
        let files = [format::InputFile {
            path: "config/settings.json".into(),
            category: "settings".into(),
            source,
            executable: false,
        }];
        let required = archive_space_bound(&files, &[]).unwrap();
        assert!(required > 10);
        assert!(require_archive_space(required - 1, required).is_err());
        assert!(require_archive_space(required, required).is_ok());
        assert!(available_space(&temp.0).unwrap() > 0);
        assert!(!temp.0.join("backup.zip").exists());
    }

    #[test]
    fn preserves_an_existing_destination_if_it_changed() {
        let temp = Scratch::new();
        let (job, data, destination, _) = setup(&temp, true);
        fs::write(&destination, b"newer backup").unwrap();
        assert!(
            finish_backup(&job, data, false)
                .err()
                .unwrap()
                .contains("without replacing")
        );
        assert_eq!(fs::read(&destination).unwrap(), b"newer backup");
        assert!(
            !temp
                .0
                .join(format!(".mdraft-backup-{}.partial", job.id))
                .exists()
        );
        remove_staging(&job).unwrap();
    }

    #[test]
    fn cancellation_does_not_replace_an_existing_backup() {
        let temp = Scratch::new();
        let (job, data, destination, _) = setup(&temp, true);
        job.canceled.store(true, Ordering::Release);
        assert!(
            finish_backup(&job, data, false)
                .err()
                .unwrap()
                .contains("canceled")
        );
        assert_eq!(fs::read(&destination).unwrap(), b"previous backup");
        assert!(
            !temp
                .0
                .join(format!(".mdraft-backup-{}.partial", job.id))
                .exists()
        );
        remove_staging(&job).unwrap();
    }
}
