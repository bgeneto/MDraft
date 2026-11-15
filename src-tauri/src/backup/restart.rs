//! Recover or apply an armed restore before opening the application profile.

use super::jobs::RestoreReview;
use super::snapshot::{self, Roots};
use super::transaction::{self, State};
use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Manager;

const SCHEMA: u32 = 1;
const REQUEST_TTL_MS: u64 = 10 * 60 * 1000;
const MAX_RECORD: u64 = 1024 * 1024;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Pending {
    schema: u32,
    id: String,
    identifier: String,
    executable: PathBuf,
    created_ms: u64,
    review: RestoreReview,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Report {
    pub id: String,
    pub restored: bool,
    pub message: String,
    pub review: Option<RestoreReview>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn base(roots: &Roots) -> PathBuf {
    roots.config.join("restore-transactions")
}

fn read_record<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<Option<T>, String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    if snapshot::is_link(&metadata) || !metadata.is_file() || metadata.len() > MAX_RECORD {
        return Err("A restore record is unsafe or too large; it was preserved.".into());
    }
    let mut file = snapshot::open_regular(
        path.parent().ok_or("Invalid restore record.")?,
        Path::new(path.file_name().ok_or("Invalid restore record name.")?),
    )?;
    let mut bytes = Vec::new();
    Read::by_ref(&mut file)
        .take(MAX_RECORD + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() as u64 > MAX_RECORD {
        return Err("A restore record is too large; it was preserved.".into());
    }
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|error| format!("A restore record is invalid and was preserved: {error}"))
}

fn write_record<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let body = serde_json::to_vec(value).map_err(|error| error.to_string())?;
    if body.len() as u64 > MAX_RECORD {
        return Err("The restore record is too large.".into());
    }
    let next = path.with_extension("json.next");
    match fs::symlink_metadata(&next) {
        Ok(meta) if meta.is_file() && !snapshot::is_link(&meta) && meta.len() <= MAX_RECORD => {
            fs::remove_file(&next).map_err(|error| error.to_string())?;
        }
        Ok(_) => return Err("Unexpected restore record staging was preserved.".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.to_string()),
    }
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&next)
        .map_err(|error| format!("Could not create a restore record: {error}"))?;
    file.write_all(&body)
        .and_then(|()| file.sync_all())
        .map_err(|error| error.to_string())?;
    fs::rename(&next, path).map_err(|error| error.to_string())?;
    #[cfg(unix)]
    std::fs::File::open(path.parent().ok_or("Invalid restore record.")?)
        .and_then(|file| file.sync_all())
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn same_executable(left: &Path, right: &Path) -> bool {
    left == right
        || matches!((fs::canonicalize(left), fs::canonicalize(right)), (Ok(a), Ok(b)) if a == b)
}

pub fn arm(roots: &Roots, identifier: &str, id: &str, review: RestoreReview) -> Result<(), String> {
    let root = base(roots);
    if read_record::<Pending>(&root.join("pending.json"))?.is_some()
        || read_record::<Report>(&root.join("report.json"))?.is_some()
    {
        return Err("Finish reviewing the previous restore before starting another.".into());
    }
    let pending = Pending {
        schema: SCHEMA,
        id: id.into(),
        identifier: identifier.into(),
        executable: std::env::current_exe().map_err(|error| error.to_string())?,
        created_ms: now_ms(),
        review,
    };
    write_record(&root.join(id).join("request.json"), &pending)?;
    write_record(&root.join("pending.json"), &pending)
}

pub fn disarm(roots: &Roots, id: &str) -> Result<(), String> {
    let path = base(roots).join("pending.json");
    if let Some(pending) = read_record::<Pending>(&path)? {
        if pending.id != id {
            return Err("Another pending restore was preserved.".into());
        }
        fs::remove_file(&path).map_err(|error| error.to_string())?;
    }
    Ok(())
}

/// Resolve every journal before normal startup. Prepared but unarmed work is
/// rolled back; in-progress work always rolls back, even after request expiry.
/// `true` means the window-state plugin must be reloaded in a fresh process.
pub fn recover(
    roots: &Roots,
    identifier: &str,
    executable: &Path,
    now: u64,
) -> Result<bool, String> {
    let root = base(roots);
    let pending = read_record::<Pending>(&root.join("pending.json"))?;
    if let Some(request) = &pending
        && (request.schema != SCHEMA
            || request.identifier != identifier
            || !same_executable(&request.executable, executable))
    {
        return Err("The pending restore belongs to a different application or executable; it was preserved.".into());
    }
    let ids = transaction::list(roots)?;
    if pending
        .as_ref()
        .is_some_and(|request| !ids.contains(&request.id))
    {
        return Err(
            "The pending restore journal is missing; the safety backup was preserved.".into(),
        );
    }
    let mut changed = false;
    for id in ids {
        if pending.as_ref().is_none_or(|request| request.id != id)
            && transaction::abandon_unjournaled(roots, &id)?
        {
            changed = true;
            continue;
        }
        let mut journal = transaction::load(roots, &id)?;
        let recorded = read_record::<Pending>(&root.join(&id).join("request.json"))?;
        if let Some(request) = &recorded
            && (request.schema != SCHEMA
                || request.id != id
                || request.identifier != identifier
                || !same_executable(&request.executable, executable))
        {
            return Err("A restore journal belongs to a different application or executable; it was preserved.".into());
        }
        let armed = pending.as_ref().filter(|value| value.id == id);
        let request = armed.or(recorded.as_ref());
        let mut outcome = None;
        match journal.state() {
            State::Preparing => {
                if armed.is_some() {
                    return Err("An armed restore was interrupted during preparation; its data was preserved.".into());
                }
                transaction::abandon_preparing(roots, &journal)?;
                changed = true;
                continue;
            }
            State::Prepared => {
                if armed.is_some_and(|value| now.saturating_sub(value.created_ms) <= REQUEST_TTL_MS)
                {
                    match transaction::apply(roots, &mut journal, || Ok(())) {
                        Ok(()) => outcome = Some((true, "Backup restored.".to_string())),
                        Err(error) => {
                            transaction::rollback(roots, &mut journal).map_err(|rollback| {
                                format!("Restore failed: {error}. Automatic rollback also failed: {rollback}. Keep the safety backup and contact support before opening this profile.")
                            })?;
                            outcome = Some((
                                false,
                                format!("Restore failed; your previous data was restored. {error}"),
                            ));
                        }
                    }
                } else {
                    transaction::rollback(roots, &mut journal)?;
                    if armed.is_some() {
                        outcome = Some((
                            false,
                            "The restore request expired; your previous data was kept.".into(),
                        ));
                    } else {
                        transaction::cleanup(roots, &journal)?;
                    }
                }
                changed = true;
            }
            State::Applying | State::RollingBack => {
                transaction::rollback(roots, &mut journal).map_err(|error| {
                    format!("An interrupted restore could not be rolled back: {error}. Keep the safety backup and contact support before opening this profile.")
                })?;
                outcome = Some((
                    false,
                    "The interrupted restore was rolled back; your previous data was restored."
                        .into(),
                ));
                changed = true;
            }
            State::Committed
                if armed.is_some()
                    || read_record::<Report>(&root.join("report.json"))?.is_none() =>
            {
                outcome = Some((true, "Backup restored.".into()));
            }
            State::RolledBack
                if armed.is_some()
                    || read_record::<Report>(&root.join("report.json"))?.is_none() =>
            {
                outcome = Some((
                    false,
                    "The restore was rolled back; your previous data was restored.".into(),
                ));
            }
            State::Committed | State::RolledBack => {}
        }
        if let Some((restored, message)) = outcome {
            let report_path = root.join("report.json");
            let existing = read_record::<Report>(&report_path)?;
            if existing.as_ref().is_some_and(|report| report.id != id) {
                return Err("An earlier restore report must be reviewed first.".into());
            }
            if existing.is_none() {
                write_record(
                    &report_path,
                    &Report {
                        id: id.clone(),
                        restored,
                        message,
                        review: request.map(|value| value.review.clone()),
                    },
                )?;
            }
            if armed.is_some() {
                fs::remove_file(root.join("pending.json")).map_err(|error| error.to_string())?;
            }
            changed = true;
        }
    }
    Ok(changed)
}

fn app_roots(app: &tauri::AppHandle) -> Result<Roots, String> {
    Ok(Roots {
        config: app
            .path()
            .app_config_dir()
            .map_err(|error| error.to_string())?,
        data: app
            .path()
            .app_data_dir()
            .map_err(|error| error.to_string())?,
    })
}

pub fn recover_app(app: &tauri::AppHandle) -> Result<bool, String> {
    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    recover(
        &app_roots(app)?,
        &app.config().identifier,
        &executable,
        now_ms(),
    )
}

#[tauri::command]
pub fn get_restore_report(app: tauri::AppHandle) -> Result<Option<Report>, String> {
    read_record(&base(&app_roots(&app)?).join("report.json"))
}

#[tauri::command]
pub fn acknowledge_restore_report(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let roots = app_roots(&app)?;
    let path = base(&roots).join("report.json");
    let report =
        read_record::<Report>(&path)?.ok_or("The restore report is no longer available.")?;
    if report.id != id {
        return Err("The restore report changed.".into());
    }
    // A crash after cleanup but before deleting the delivered report may leave
    // only the report. It is safe to acknowledge when its transaction is gone.
    if transaction::list(&roots)?.contains(&id) {
        let journal = transaction::load(&roots, &id)?;
        transaction::cleanup(&roots, &journal)?;
    }
    fs::remove_file(&path).map_err(|error| error.to_string())?;
    let _ = fs::remove_dir(base(&roots));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backup::{
        format,
        jobs::BackupResult,
        restore,
        transaction::{Replacement, Target},
    };
    use std::sync::atomic::{AtomicUsize, Ordering};

    static NEXT: AtomicUsize = AtomicUsize::new(0);
    struct Scratch(PathBuf);
    impl Scratch {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "mdraft-restart-test-{}-{}",
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
                    .is_some_and(|name| name.to_string_lossy().starts_with("mdraft-restart-test-"))
            {
                let _ = fs::remove_dir_all(&self.0);
            }
        }
    }

    fn fixture(temp: &Scratch) -> (Roots, PathBuf) {
        let config = temp.0.join("config");
        fs::create_dir(&config).unwrap();
        fs::write(config.join("settings.json"), "old settings").unwrap();
        let source = temp.0.join("source.json");
        fs::write(&source, "new settings").unwrap();
        let roots = Roots {
            config: config.clone(),
            data: config,
        };
        (roots, source)
    }

    fn review() -> RestoreReview {
        RestoreReview {
            backup: restore::Preview {
                format_version: format::VERSION,
                app_version: "1.0".into(),
                created_at_ms: 1,
                source_os: std::env::consts::OS.into(),
                source_arch: std::env::consts::ARCH.into(),
                portable: false,
                total_bytes: 1,
                categories: Default::default(),
                compatible_platform: true,
            },
            safety_backup: BackupResult {
                path: "safety.zip".into(),
                bytes: 1,
                captured_at_ms: 1,
                files: 1,
            },
            recovered_documents: 0,
            salvaged_journals: 0,
            quarantined_downloads: 0,
            adjustments: vec![],
        }
    }

    fn prepare(roots: &Roots, source: &Path) -> transaction::Journal {
        transaction::prepare(
            roots,
            "test-transaction",
            &[Replacement {
                target: Target::Settings,
                source: Some(source.to_path_buf()),
            }],
        )
        .unwrap()
    }

    #[test]
    fn armed_restore_commits_once_and_keeps_a_report() {
        let temp = Scratch::new();
        let (roots, source) = fixture(&temp);
        prepare(&roots, &source);
        arm(&roots, "test.app", "test-transaction", review()).unwrap();
        let exe = std::env::current_exe().unwrap();
        assert!(recover(&roots, "test.app", &exe, now_ms()).unwrap());
        assert_eq!(
            fs::read_to_string(roots.config.join("settings.json")).unwrap(),
            "new settings"
        );
        let report = read_record::<Report>(&base(&roots).join("report.json"))
            .unwrap()
            .unwrap();
        assert!(report.restored);
        assert_eq!(report.review.unwrap().safety_backup.path, "safety.zip");
        assert!(!recover(&roots, "test.app", &exe, now_ms()).unwrap());
        transaction::cleanup(
            &roots,
            &transaction::load(&roots, "test-transaction").unwrap(),
        )
        .unwrap();
    }

    #[test]
    fn expired_unstarted_request_keeps_previous_data() {
        let temp = Scratch::new();
        let (roots, source) = fixture(&temp);
        prepare(&roots, &source);
        arm(&roots, "test.app", "test-transaction", review()).unwrap();
        let exe = std::env::current_exe().unwrap();
        assert!(recover(&roots, "test.app", &exe, now_ms() + REQUEST_TTL_MS + 1).unwrap());
        assert_eq!(
            fs::read_to_string(roots.config.join("settings.json")).unwrap(),
            "old settings"
        );
        assert!(
            !read_record::<Report>(&base(&roots).join("report.json"))
                .unwrap()
                .unwrap()
                .restored
        );
    }

    #[test]
    fn interrupted_commit_rolls_back_even_without_marker_and_after_expiry() {
        let temp = Scratch::new();
        let (roots, source) = fixture(&temp);
        let mut journal = prepare(&roots, &source);
        arm(&roots, "test.app", "test-transaction", review()).unwrap();
        let mut step = 0;
        assert!(
            transaction::apply(&roots, &mut journal, || {
                step += 1;
                if step == 3 {
                    Err("interrupted".into())
                } else {
                    Ok(())
                }
            })
            .is_err()
        );
        fs::remove_file(base(&roots).join("pending.json")).unwrap();
        let exe = std::env::current_exe().unwrap();
        assert!(recover(&roots, "test.app", &exe, now_ms() + REQUEST_TTL_MS + 1).unwrap());
        assert_eq!(
            fs::read_to_string(roots.config.join("settings.json")).unwrap(),
            "old settings"
        );
        let report = read_record::<Report>(&base(&roots).join("report.json"))
            .unwrap()
            .unwrap();
        assert!(!report.restored);
        assert_eq!(report.review.unwrap().safety_backup.path, "safety.zip");
    }

    #[test]
    fn foreign_executable_cannot_run_a_pending_restore() {
        let temp = Scratch::new();
        let (roots, source) = fixture(&temp);
        prepare(&roots, &source);
        arm(&roots, "test.app", "test-transaction", review()).unwrap();
        assert!(
            recover(
                &roots,
                "test.app",
                Path::new("foreign-executable"),
                now_ms()
            )
            .is_err()
        );
        assert_eq!(
            fs::read_to_string(roots.config.join("settings.json")).unwrap(),
            "old settings"
        );
    }
}
