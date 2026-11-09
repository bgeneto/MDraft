//! Linux and macOS: a direct process in its own process group.
//!
//! The installed engine is the reader's program; this module only makes sure a
//! Cancel reaches the engine and every helper it started. `setsid` through
//! `process_group(0)` gives the tree one group, and a negative `kill` signals it.

use std::ffi::OsString;
use std::io::Read;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use tauri::Manager;

use super::{JobDir, RunOutcome, RunSpec};

const POLL: Duration = Duration::from_millis(60);

pub(super) fn job_dir(app: &tauri::AppHandle, job: &str) -> Result<JobDir, String> {
    let safe: String = job
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || *ch == '-')
        .take(48)
        .collect();
    if safe.is_empty() {
        return Err("The LaTeX job has no usable identifier.".into());
    }
    let root = app
        .path()
        .app_cache_dir()
        .map_err(|error| format!("Cannot locate the LaTeX job directory: {error}"))?
        .join("latex-jobs");
    let path = root.join(format!("{safe}-{}", std::process::id()));
    std::fs::create_dir_all(&path).map_err(|error| {
        format!(
            "Cannot create the private LaTeX job directory {}: {error}",
            path.display()
        )
    })?;
    let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700));
    Ok(JobDir {
        path,
        cleanup: true,
    })
}

pub(super) fn run(spec: &RunSpec, cancel: &AtomicBool) -> Result<RunOutcome, String> {
    let mut command = Command::new(&spec.program);
    command.args(&spec.args);
    command.current_dir(&spec.cwd);
    command.env_clear();
    for (key, value) in &spec.env {
        command.env(key, value);
    }
    let console = std::fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .read(true)
        .open(spec.cwd.join("console.log"))
        .map_err(|error| format!("Cannot open the compiler output file: {error}"))?;
    let stderr = console
        .try_clone()
        .map_err(|error| format!("Cannot duplicate the compiler output handle: {error}"))?;
    let stdin = std::fs::OpenOptions::new()
        .read(true)
        .open("/dev/null")
        .map_err(|error| format!("Cannot open the null input device: {error}"))?;
    command
        .stdin(Stdio::from(stdin))
        .stdout(Stdio::from(console))
        .stderr(Stdio::from(stderr));
    command.process_group(0);
    let started = Instant::now();
    let mut child = command
        .spawn()
        .map_err(|error| format!("Cannot start {}: {error}", spec.program.display()))?;
    let pid = child.id() as i32;
    let mut cancelled = false;
    let mut timed_out = false;
    let mut code: i32 = -1;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                code = status.code().unwrap_or(-1);
                break;
            }
            Ok(None) => {}
            Err(error) => {
                return Err(format!("Cannot wait for the LaTeX process: {error}"));
            }
        }
        if cancel.load(Ordering::SeqCst) {
            cancelled = true;
            kill_group(pid);
            let _ = child.kill();
            let _ = child.wait();
            break;
        }
        if started.elapsed() >= spec.timeout {
            timed_out = true;
            kill_group(pid);
            let _ = child.kill();
            let _ = child.wait();
            break;
        }
        std::thread::sleep(POLL);
    }
    let mut console_text = String::new();
    if let Ok(mut file) = std::fs::File::open(spec.cwd.join("console.log")) {
        let _ = file.read_to_string(&mut console_text);
    }
    let (console_text, _) = crate::latex_native::log::bounded_log(&console_text);
    Ok(RunOutcome {
        status: code,
        cancelled,
        timed_out,
        console: console_text,
    })
}

fn kill_group(pid: i32) {
    if pid <= 0 {
        return;
    }
    unsafe {
        // Negative pid addresses the group created by `process_group(0)`, so
        // the engine's children (BibTeX, Biber, font tools) die with it.
        libc::kill(-pid, libc::SIGKILL);
    }
}
