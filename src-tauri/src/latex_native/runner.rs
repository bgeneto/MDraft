//! Running an installed TeX engine as a controlled process tree.
//!
//! The engine is the reader's own program, so this module does not try to
//! confine its network or filesystem access. It controls what MDraft owns: the
//! working directory, the environment, stdin/stdout/stderr, a hard timeout, and
//! cancellation of the whole tree (a job object on Windows, a process group on
//! Unix). The project snapshot is staged into a private directory first, so
//! generated files never touch the reader's project.

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

/// Run one process, containing and cancelling its whole tree.
pub fn run(spec: &RunSpec, cancel: &AtomicBool) -> Result<RunOutcome, String> {
    platform::run(spec, cancel)
}
