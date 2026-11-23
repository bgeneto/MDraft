//! Running an installed TeX engine as a controlled process tree.
//!
//! The engine is the reader's own program, so this module does not try to
//! confine its network or filesystem access. It controls what MDraft owns: the
//! working directory, the environment, stdin/stdout/stderr, a hard timeout, and
//! cancellation of the whole tree (a job object on Windows, a process group on
//! Unix). The engine may run in the reader's folder; what the runner itself
//! writes (the console output) goes to the spec's private scratch folder.

use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::time::Duration;

#[cfg(windows)]
mod windows;
#[cfg(windows)]
use windows as platform;

#[cfg(unix)]
mod unix;
#[cfg(unix)]
use unix as platform;

/// Everything needed to start one engine (or helper) process.
#[derive(Clone, Debug)]
pub struct RunSpec {
    pub program: PathBuf,
    pub args: Vec<std::ffi::OsString>,
    pub cwd: PathBuf,
    /// A private folder for the child's console output and its empty input.
    /// The working directory can be the reader's own folder, and nothing is
    /// written there.
    pub scratch: PathBuf,
    /// The complete environment the child receives.
    pub env: Vec<(String, String)>,
    pub timeout: Duration,
}

#[derive(Clone, Debug, Default)]
pub struct RunOutcome {
    pub status: i32,
    pub cancelled: bool,
    pub timed_out: bool,
    /// The tail of stdout and stderr, for a failure that produced no log file.
    pub console: String,
}

/// An app-owned job directory. Dropping it removes the tree.
pub struct JobDir {
    pub path: PathBuf,
    cleanup: bool,
}

impl Drop for JobDir {
    fn drop(&mut self) {
        if self.cleanup {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }
}

/// Create a private job directory the engine can write.
pub fn job_dir(app: &tauri::AppHandle, job: &str) -> Result<JobDir, String> {
    platform::job_dir(app, job)
}

/// A build workspace that lasts for the app session.
///
/// Unlike [`JobDir`], dropping it does not delete the tree: the caches, the
/// auxiliary files and `tmp/` (where Biber extracts its runtime) are the point.
/// [`cleanup_workspaces`] owns the session lifetime.
pub struct SessionWorkspace {
    pub path: PathBuf,
    /// True when this call created the directory, so the caller can prune.
    pub created: bool,
}

pub fn workspace_dir(app: &tauri::AppHandle, key: &str) -> Result<SessionWorkspace, String> {
    platform::workspace_dir(app, key)
}

pub fn workspace_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    platform::workspace_root(app)
}

/// Delete every session workspace. This is the only cleanup; a workspace is
/// never reused across app sessions.
pub fn cleanup_workspaces(app: &tauri::AppHandle) {
    platform::cleanup_workspaces(app);
}

/// Run one process, containing and cancelling its whole tree.
pub fn run(spec: &RunSpec, cancel: &AtomicBool) -> Result<RunOutcome, String> {
    platform::run(spec, cancel)
}
