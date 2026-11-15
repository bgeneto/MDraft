//! A one-shot deletion of MDraft's own application directories.
//!
//! The destructive work cannot happen in the live process: WebView2 keeps its
//! profile open, and the window-state plugin writes `.window-state.json` while
//! the app exits. Doing the delete first and restarting through the ordinary
//! path would therefore recreate part of what was just removed.
//!
//! The frontend instead writes a small marker and asks for a restart. The next
//! process starts with a valid marker, creates no windows or webviews, resolves
//! the application directories, releases Tauri's resources, deletes the files,
//! writes a report and starts the ordinary process again. The ordering is
//! deliberate: `cleanup_before_exit` releases the single-instance lock and the
//! `RunEvent::Exit` handlers never run, so nothing writes application state
//! after the deletion.
//!
//! The marker lives in the operating system's temporary directory because the
//! application's own directory is one of the things being deleted. It carries a
//! timestamp and the executable path, and is honoured for ten minutes by the
//! executable that wrote it. A report of failed paths survives the restart and
//! is read once by the ordinary process, so a locked file is never mistaken for
//! a completed deletion.

use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::Manager;

const MARKER_SCHEMA: u32 = 1;
const MARKER_TTL_MS: u64 = 10 * 60 * 1000;
const REPORT_SCHEMA: u32 = 1;
const REPORT_TTL_MS: u64 = 7 * 24 * 60 * 60 * 1000;
const DELETE_ATTEMPTS: usize = 8;
const DELETE_RETRY: Duration = Duration::from_millis(150);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Pending {
    schema: u32,
    exe: String,
    created_ms: u64,
    #[serde(default)]
    consumed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PurgeFailure {
    pub path: String,
    pub error: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PurgeReport {
    pub deleted: Vec<String>,
    pub failed: Vec<PurgeFailure>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredReport {
    schema: u32,
    exe: String,
    created_ms: u64,
    deleted: Vec<String>,
    failed: Vec<PurgeFailure>,
}

/// The directories to remove and, for an application-directory override, the
/// now-possibly-empty parent to prune as well.
struct Targets {
    dirs: Vec<PathBuf>,
    parent: Option<PathBuf>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn safe_identifier(identifier: &str) -> String {
    identifier
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_') {
                ch
            } else {
                '_'
            }
        })
        .collect()
}

fn marker_path(identifier: &str) -> PathBuf {
    std::env::temp_dir().join(format!("mdraft-purge-{}.json", safe_identifier(identifier)))
}

fn report_path(identifier: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "mdraft-purge-report-{}.json",
        safe_identifier(identifier)
    ))
}

fn write_json<T: Serialize>(path: &Path, value: &T) -> std::io::Result<()> {
    let body = serde_json::to_vec(value)
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?;
    let mut file = fs::File::create(path)?;
    file.write_all(&body)?;
    file.sync_all()
}

/// Whether two paths name the same executable.
///
/// The marker is written before a restart and read by the restarted process, so
/// the path is normally identical. Canonicalising also accepts an install path
/// reached through a different spelling, while a marker left by another copy
/// (an installed and a portable build share an identifier) is ignored.
fn paths_match(recorded: &Path, current: &Path) -> bool {
    if recorded == current {
        return true;
    }
    match (recorded.canonicalize(), current.canonicalize()) {
        (Ok(recorded), Ok(current)) => recorded == current,
        _ => false,
    }
}

fn current_exe() -> Option<PathBuf> {
    std::env::current_exe().ok()
}

fn pending_valid(pending: &Pending, now: u64, exe: &Path) -> bool {
    pending.schema == MARKER_SCHEMA
        && !pending.consumed
        && now.saturating_sub(pending.created_ms) <= MARKER_TTL_MS
        && paths_match(Path::new(&pending.exe), exe)
}

/// True when the next start is a purge pass.
///
/// A malformed, expired or foreign marker is removed so it cannot surprise a
/// later process. Reading the marker happens before Tauri creates a window, so
/// nothing in the application has opened its data directory yet.
pub fn pending_for(identifier: &str) -> bool {
    let path = marker_path(identifier);
    let Ok(raw) = fs::read_to_string(&path) else {
        return false;
    };
    let Ok(pending) = serde_json::from_str::<Pending>(&raw) else {
        let _ = fs::remove_file(&path);
        return false;
    };
    let Some(exe) = current_exe() else {
        return false;
    };
    let now = now_ms();
    if pending_valid(&pending, now, &exe) {
        return true;
    }
    // A marker left by another copy that shares the identifier (an installed
    // and a portable build) is not ours to consume. Remove only our own stale
    // markers so the other copy can still finish its purge.
    let ours = paths_match(Path::new(&pending.exe), &exe);
    let expired = now.saturating_sub(pending.created_ms) > MARKER_TTL_MS;
    if pending.consumed || pending.schema != MARKER_SCHEMA || expired || ours {
        let _ = fs::remove_file(&path);
    }
    false
}

fn write_pending(app: &tauri::AppHandle) -> Result<(), String> {
    let exe =
        current_exe().ok_or_else(|| "MDraft could not locate its own executable.".to_string())?;
    let pending = Pending {
        schema: MARKER_SCHEMA,
        exe: exe.to_string_lossy().into_owned(),
        created_ms: now_ms(),
        consumed: false,
    };
    write_json(&marker_path(&app.config().identifier), &pending)
        .map_err(|error| format!("Could not prepare the data deletion: {error}"))
}

/// Remove the marker, or mark it consumed if the file cannot be removed yet.
///
/// A marker that survived a successful purge would make the next ordinary start
/// delete the fresh settings. The consumed flag is the fallback when antivirus
/// software or a sharing mode holds the temporary file open.
fn consume_marker(identifier: &str) {
    let path = marker_path(identifier);
    if fs::remove_file(&path).is_ok() {
        return;
    }
    let Ok(raw) = fs::read_to_string(&path) else {
        return;
    };
    let Ok(mut pending) = serde_json::from_str::<Pending>(&raw) else {
        return;
    };
    pending.consumed = true;
    pending.created_ms = now_ms();
    let _ = write_json(&path, &pending);
}

fn stored_report(report: &PurgeReport, exe: &Path) -> StoredReport {
    StoredReport {
        schema: REPORT_SCHEMA,
        exe: exe.to_string_lossy().into_owned(),
        created_ms: now_ms(),
        deleted: report.deleted.clone(),
        failed: report.failed.clone(),
    }
}

fn write_report(identifier: &str, report: &PurgeReport) -> std::io::Result<()> {
    let exe = current_exe().unwrap_or_default();
    write_json(&report_path(identifier), &stored_report(report, &exe))
}

/// Read and clear a report at an explicit location.
///
/// A report from another executable is left in place: an installed and a
/// portable build can share the same identifier, and each should see its own
/// answer. Expired reports are discarded.
fn read_report(path: &Path, exe: &Path, now: u64) -> Option<PurgeReport> {
    let raw = fs::read_to_string(path).ok()?;
    let Ok(stored) = serde_json::from_str::<StoredReport>(&raw) else {
        let _ = fs::remove_file(path);
        return None;
    };
    let valid = stored.schema == REPORT_SCHEMA
        && now.saturating_sub(stored.created_ms) <= REPORT_TTL_MS
        && paths_match(Path::new(&stored.exe), exe);
    if !valid {
        if now.saturating_sub(stored.created_ms) > REPORT_TTL_MS {
            let _ = fs::remove_file(path);
        }
        return None;
    }
    let _ = fs::remove_file(path);
    Some(PurgeReport {
        deleted: stored.deleted,
        failed: stored.failed,
    })
}

pub fn take_report(identifier: &str) -> Option<PurgeReport> {
    let exe = current_exe()?;
    read_report(&report_path(identifier), &exe, now_ms())
}

fn path_key(path: &Path) -> String {
    let text = path.to_string_lossy();
    if cfg!(windows) {
        text.to_lowercase()
    } else {
        text.into_owned()
    }
}

fn dedupe(paths: &mut Vec<PathBuf>) {
    let mut seen = std::collections::HashSet::new();
    paths.retain(|path| seen.insert(path_key(path)));
}

fn is_safe_parent(path: &Path) -> bool {
    if !path.is_absolute() || path.parent().is_none() || path.components().count() < 2 {
        return false;
    }
    if let Some(exe) = current_exe()
        && let Some(exe_dir) = exe.parent()
        && (path == exe_dir || exe_dir.starts_with(path))
    {
        return false;
    }
    true
}

fn common_parent(dirs: &[PathBuf]) -> Option<PathBuf> {
    if dirs.len() < 2 {
        return None;
    }
    let first = dirs.first()?.parent()?.to_path_buf();
    if dirs.iter().all(|dir| dir.parent() == Some(first.as_path())) && is_safe_parent(&first) {
        Some(first)
    } else {
        None
    }
}

/// Resolve the application's own directories.
///
/// An `appDirectoriesOverride` (the portable build) redirects config and data
/// beside the executable; its local-data and cache fallbacks are shared with an
/// installed copy, so those are deliberately left alone. The default build
/// deletes the platform data/cache directories as well, which is where WebView2
/// keeps its profile on Windows.
fn targets(app: &tauri::AppHandle) -> Result<Targets, String> {
    let config = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("Cannot locate the application settings folder: {error}"))?;
    let data = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Cannot locate the application data folder: {error}"))?;
    let portable = app.config().app.app_directories_override.is_some();
    let mut dirs = vec![config, data];
    if !portable {
        dirs.push(app.path().app_local_data_dir().map_err(|error| {
            format!("Cannot locate the application local data folder: {error}")
        })?);
        dirs.push(
            app.path()
                .app_cache_dir()
                .map_err(|error| format!("Cannot locate the application cache folder: {error}"))?,
        );
    }
    dedupe(&mut dirs);
    let parent = if portable { common_parent(&dirs) } else { None };
    Ok(Targets { dirs, parent })
}

fn is_safe_target(path: &Path) -> bool {
    if !path.is_absolute() || path.parent().is_none() || path.components().count() < 3 {
        return false;
    }
    if path
        .components()
        .any(|component| matches!(component, Component::ParentDir))
    {
        return false;
    }
    if path.file_name().is_none() {
        return false;
    }
    if let Some(exe) = current_exe()
        && let Some(exe_dir) = exe.parent()
        && (path == exe_dir || exe_dir.starts_with(path))
    {
        return false;
    }
    match fs::symlink_metadata(path) {
        Ok(metadata) => metadata.is_dir() && !metadata.file_type().is_symlink(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => true,
        Err(_) => false,
    }
}

fn delete_tree(path: &Path) -> Result<bool, String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.to_string()),
    };
    if metadata.file_type().is_symlink() {
        return Err("Refused to follow a symbolic link.".to_string());
    }
    if !metadata.is_dir() {
        return Err("The path is not a directory.".to_string());
    }

    let mut last = String::new();
    for attempt in 0..DELETE_ATTEMPTS {
        match fs::remove_dir_all(path) {
            Ok(()) => return Ok(true),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(error) => {
                last = error.to_string();
                if attempt + 1 < DELETE_ATTEMPTS {
                    std::thread::sleep(DELETE_RETRY);
                }
            }
        }
    }
    Err(last)
}

fn delete_all(targets: &Targets) -> PurgeReport {
    let mut report = PurgeReport::default();
    for path in &targets.dirs {
        let label = path.display().to_string();
        if !is_safe_target(path) {
            report.failed.push(PurgeFailure {
                path: label,
                error: "Refused to delete an unsafe path.".to_string(),
            });
            continue;
        }
        match delete_tree(path) {
            Ok(true) => report.deleted.push(label),
            Ok(false) => {}
            Err(error) => report.failed.push(PurgeFailure { path: label, error }),
        }
    }
    if let Some(parent) = &targets.parent
        && is_safe_parent(parent)
    {
        // `remove_dir` only removes an empty directory, which is the whole
        // point: the portable `app-data` wrapper should disappear, while a
        // shared parent such as `%APPDATA%` must remain.
        let _ = fs::remove_dir(parent);
    }
    report
}

/// Delete the application's directories and start the ordinary process again.
///
/// Called from `setup` in the marker-only process. The environment is cloned
/// before `cleanup_before_exit` because the restart needs it after Tauri's
/// resources have been released.
pub fn run_and_restart(app: &tauri::AppHandle) -> ! {
    let identifier = app.config().identifier.clone();
    let env = app.env();
    let targets = targets(app);
    app.cleanup_before_exit();

    let report = match targets {
        Ok(targets) => delete_all(&targets),
        Err(error) => PurgeReport {
            deleted: Vec::new(),
            failed: vec![PurgeFailure {
                path: "application data".to_string(),
                error,
            }],
        },
    };
    let _ = write_report(&identifier, &report);
    consume_marker(&identifier);
    tauri::process::restart(&env);
}

#[tauri::command]
pub fn request_data_purge(app: tauri::AppHandle) -> Result<(), String> {
    write_pending(&app)?;
    // The close guard has already flushed settings and closed the documents.
    // Let the IPC reply reach the window before the restart tears it down; if
    // the request never lands, the marker makes the next launch finish the job.
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(250));
        handle.request_restart();
    });
    Ok(())
}

#[tauri::command]
pub fn take_purge_report(app: tauri::AppHandle) -> Option<PurgeReport> {
    take_report(&app.config().identifier)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(tag: &str) -> PathBuf {
        // The test process may be sandboxed away from the OS temporary
        // directory. `target/` is ignored and writable, and these fixtures are
        // deleted before the test returns.
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("purge-tests")
            .join(format!("{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn pending(consumed: bool) -> Pending {
        Pending {
            schema: MARKER_SCHEMA,
            exe: current_exe().unwrap().to_string_lossy().into_owned(),
            created_ms: now_ms(),
            consumed,
        }
    }

    #[test]
    fn marker_names_are_files_not_paths() {
        let path = marker_path("io.github/../mdraft");
        let name = path.file_name().unwrap().to_string_lossy();
        assert_eq!(name, "mdraft-purge-io.github_.._mdraft.json");
        assert!(!name.contains('/'));
        assert!(!name.contains('\\'));
    }

    #[test]
    fn pending_is_bound_to_time_and_executable() {
        let exe = current_exe().unwrap();
        let record = pending(false);
        let now = now_ms();
        assert!(pending_valid(&record, now, &exe));
        assert!(!pending_valid(&record, now + MARKER_TTL_MS + 1, &exe));
        assert!(!pending_valid(
            &record,
            now,
            &exe.with_file_name("another-mdraft.exe")
        ));
        assert!(!pending_valid(&pending(true), now, &exe));
    }

    #[test]
    fn unsafe_paths_are_refused() {
        assert!(!is_safe_target(Path::new("relative/path")));
        assert!(!is_safe_target(Path::new("..")));
        let root = if cfg!(windows) {
            Path::new("C:\\")
        } else {
            Path::new("/")
        };
        assert!(!is_safe_target(root));
    }

    #[test]
    fn a_file_target_is_reported_and_kept() {
        let root = temp("file-target");
        let target = root.join("not-a-directory");
        fs::write(&target, b"keep").unwrap();
        let report = delete_all(&Targets {
            dirs: vec![target.clone()],
            parent: None,
        });
        assert!(report.deleted.is_empty());
        assert_eq!(report.failed.len(), 1);
        assert!(report.failed[0].error.contains("unsafe"));
        assert!(target.exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn delete_removes_nested_contents_and_empty_parent() {
        let root = temp("delete");
        let parent = root.join("app-data");
        let config = parent.join("config");
        let nested = config.join("recovery");
        fs::create_dir_all(&nested).unwrap();
        fs::write(config.join("settings.json"), b"{}").unwrap();
        fs::write(nested.join("one.json"), b"{}").unwrap();

        let report = delete_all(&Targets {
            dirs: vec![config.clone()],
            parent: Some(parent.clone()),
        });
        assert!(report.failed.is_empty(), "{report:?}");
        assert_eq!(report.deleted.len(), 1);
        assert!(!config.exists());
        assert!(!parent.exists(), "the empty portable wrapper should go");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_missing_target_is_already_deleted() {
        let root = temp("missing");
        let target = root.join("settings");
        let report = delete_all(&Targets {
            dirs: vec![target.clone()],
            parent: None,
        });
        assert!(report.failed.is_empty());
        assert!(report.deleted.is_empty());
        assert!(!target.exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn report_round_trips_once() {
        let root = temp("report");
        let path = root.join("report.json");
        let exe = current_exe().unwrap();
        let report = PurgeReport {
            deleted: vec!["a".into()],
            failed: vec![PurgeFailure {
                path: "b".into(),
                error: "locked".into(),
            }],
        };
        write_json(&path, &stored_report(&report, &exe)).unwrap();
        let taken = read_report(&path, &exe, now_ms()).expect("report should be readable");
        assert_eq!(taken.deleted, report.deleted);
        assert_eq!(taken.failed.len(), 1);
        assert_eq!(taken.failed[0].error, "locked");
        assert!(
            read_report(&path, &exe, now_ms()).is_none(),
            "report is one-shot"
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_foreign_or_expired_report_is_not_consumed() {
        let root = temp("foreign-report");
        let path = root.join("report.json");
        let exe = current_exe().unwrap();
        let report = PurgeReport {
            deleted: vec!["a".into()],
            failed: Vec::new(),
        };
        let mut stored = stored_report(&report, &exe);
        stored.exe = exe
            .with_file_name("another-mdraft.exe")
            .to_string_lossy()
            .into_owned();
        write_json(&path, &stored).unwrap();
        assert!(read_report(&path, &exe, now_ms()).is_none());
        assert!(path.exists(), "a report for another executable is kept");

        let mut stored = stored_report(&report, &exe);
        stored.created_ms = now_ms().saturating_sub(REPORT_TTL_MS + 1);
        write_json(&path, &stored).unwrap();
        assert!(read_report(&path, &exe, now_ms()).is_none());
        assert!(!path.exists(), "an expired report is discarded");
        let _ = fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_target_is_refused() {
        use std::os::unix::fs::symlink;

        let root = temp("symlink");
        let real = root.join("real");
        let link = root.join("link");
        fs::create_dir_all(&real).unwrap();
        fs::write(real.join("keep.txt"), b"keep").unwrap();
        symlink(&real, &link).unwrap();
        let report = delete_all(&Targets {
            dirs: vec![link.clone()],
            parent: None,
        });
        assert_eq!(report.failed.len(), 1);
        assert!(link.exists(), "the link itself was not removed");
        assert!(real.join("keep.txt").exists());
        let _ = fs::remove_dir_all(&root);
    }
}
