//! Windows: a kill-on-close job object around a direct process.
//!
//! No AppContainer, no profile and no ACL changes: the engine is the reader's
//! program and runs with the reader's token. The job object is what makes
//! Cancel terminate the engine's children too, and assigning it while the child
//! is suspended closes the window in which a child could start outside it.

use std::ffi::{OsStr, OsString, c_void};
use std::fs::{File, OpenOptions};
use std::io::Read;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::AsRawHandle;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Instant;

use tauri::Manager;
use windows::Win32::Foundation::{
    CloseHandle, HANDLE, HANDLE_FLAG_INHERIT, SetHandleInformation, WAIT_OBJECT_0,
};
use windows::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
    SetInformationJobObject, TerminateJobObject,
};
use windows::Win32::System::Threading::{
    CREATE_NO_WINDOW, CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT, CreateProcessW,
    DeleteProcThreadAttributeList,
    EXTENDED_STARTUPINFO_PRESENT, GetExitCodeProcess, InitializeProcThreadAttributeList,
    LPPROC_THREAD_ATTRIBUTE_LIST, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, PROCESS_INFORMATION,
    ResumeThread, STARTF_USESTDHANDLES, STARTUPINFOEXW, UpdateProcThreadAttribute,
    WaitForSingleObject,
};

use super::{JobDir, RunOutcome, RunSpec};

static JOB_COUNTER: AtomicU64 = AtomicU64::new(0);

fn wide(value: &OsStr) -> Vec<u16> {
    value.encode_wide().chain(Some(0)).collect()
}

fn quote(arg: &OsStr) -> String {
    let text = arg.to_string_lossy();
    if !text.is_empty() && !text.chars().any(|ch| ch.is_whitespace() || ch == '"') {
        return text.into_owned();
    }
    let mut out = String::from("\"");
    let mut slashes = 0;
    for ch in text.chars() {
        if ch == '\\' {
            slashes += 1;
        } else if ch == '"' {
            out.push_str(&"\\".repeat(slashes * 2 + 1));
            out.push('"');
            slashes = 0;
        } else {
            out.push_str(&"\\".repeat(slashes));
            slashes = 0;
            out.push(ch);
        }
    }
    out.push_str(&"\\".repeat(slashes * 2));
    out.push('"');
    out
}

fn command_line(program: &Path, args: &[OsString]) -> Vec<u16> {
    // A canonicalized path carries the `\\?\` verbatim prefix, which
    // `CreateProcessW` rejects when the application name is null.
    let program = program.to_string_lossy();
    let program = program.strip_prefix(r"\\?\").unwrap_or(&program);
    let mut line = quote(OsStr::new(program));
    for arg in args {
        line.push(' ');
        line.push_str(&quote(arg));
    }
    line.encode_utf16().chain(Some(0)).collect()
}

fn env_block(env: &[(String, String)]) -> Vec<u16> {
    let mut block = Vec::new();
    let mut pairs: Vec<_> = env.iter().collect();
    pairs.sort_by_key(|(key, _)| key.to_ascii_uppercase());
    for (key, value) in pairs {
        block.extend(key.encode_utf16());
        block.push(b'=' as u16);
        block.extend(value.encode_utf16());
        block.push(0);
    }
    block.push(0);
    if block.len() == 1 {
        block.push(0);
    }
    block
}

pub(super) fn job_dir(app: &tauri::AppHandle, job: &str) -> Result<JobDir, String> {
    let safe: String = job
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || *ch == '-')
        .take(48)
        .collect();
    if safe.is_empty() {
        return Err("The LaTeX job has no usable identifier.".into());
    }
    let counter = JOB_COUNTER.fetch_add(1, Ordering::Relaxed);
    let root = app
        .path()
        .app_cache_dir()
        .map_err(|error| format!("Cannot locate the LaTeX job directory: {error}"))?
        .join("latex-jobs");
    let path = root.join(format!("{safe}-{}-{counter}", std::process::id()));
    std::fs::create_dir_all(&path).map_err(|error| {
        format!(
            "Cannot create the private LaTeX job directory {}: {error}",
            path.display()
        )
    })?;
    Ok(JobDir {
        path,
        cleanup: true,
    })
}

pub(super) fn run(spec: &RunSpec, cancel: &AtomicBool) -> Result<RunOutcome, String> {
    let console = OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .read(true)
        .open(spec.cwd.join("console.log"))
        .map_err(|error| format!("Cannot open the compiler output file: {error}"))?;
    let stderr = console
        .try_clone()
        .map_err(|error| format!("Cannot duplicate the compiler output handle: {error}"))?;
    std::fs::write(spec.cwd.join("stdin.txt"), b"")
        .map_err(|error| format!("Cannot create the compiler input file: {error}"))?;
    let stdin = File::open(spec.cwd.join("stdin.txt"))
        .map_err(|error| format!("Cannot open the compiler input file: {error}"))?;
    let handles = [
        HANDLE(stdin.as_raw_handle()),
        HANDLE(console.as_raw_handle()),
        HANDLE(stderr.as_raw_handle()),
    ];
    for handle in handles {
        unsafe { SetHandleInformation(handle, 1, HANDLE_FLAG_INHERIT) }
            .map_err(|error| format!("Cannot make the compiler output inheritable: {error}"))?;
    }

    let job = unsafe { CreateJobObjectW(None, None) }
        .map_err(|error| format!("Cannot create the LaTeX job object: {error}"))?;
    let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    unsafe {
        SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &limits as *const _ as *const c_void,
            std::mem::size_of_val(&limits) as u32,
        )
    }
    .map_err(|error| format!("Cannot configure the LaTeX job object: {error}"))?;

    // Only the standard handles are inherited; the webview's handles are not.
    let attribute_count = 1;
    let mut size = 0usize;
    let _ = unsafe { InitializeProcThreadAttributeList(None, attribute_count, None, &mut size) };
    if size == 0 {
        return Err("Windows returned an empty process attribute list.".into());
    }
    let mut buffer = vec![0usize; size.div_ceil(std::mem::size_of::<usize>())];
    let list = LPPROC_THREAD_ATTRIBUTE_LIST(buffer.as_mut_ptr() as *mut c_void);
    unsafe { InitializeProcThreadAttributeList(Some(list), attribute_count, None, &mut size) }
        .map_err(|error| format!("Cannot initialize the process attribute list: {error}"))?;
    unsafe {
        UpdateProcThreadAttribute(
            list,
            0,
            PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
            Some(handles.as_ptr() as *const c_void),
            std::mem::size_of_val(&handles),
            None,
            None,
        )
    }
    .map_err(|error| format!("Cannot restrict the inherited handles: {error}"))?;

    let mut startup: STARTUPINFOEXW = unsafe { std::mem::zeroed() };
    startup.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = handles[0];
    startup.StartupInfo.hStdOutput = handles[1];
    startup.StartupInfo.hStdError = handles[2];
    startup.lpAttributeList = list;

    let mut line = command_line(&spec.program, &spec.args);
    let block = env_block(&spec.env);
    let cwd = wide(spec.cwd.as_os_str());
    let mut info: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
    let started = Instant::now();
    // CREATE_NO_WINDOW: this GUI process owns no console, so without it Windows
    // opens a visible console for every engine, probe and BibTeX run (and the
    // helpers they start inherit it). The child still gets a console, so the
    // redirected handles keep working. This is the one spawn site that cannot
    // use `export::quiet()`; see the console-flash entry in
    // docs/agent-guide/traps/editor-and-ui.md.
    let flags = EXTENDED_STARTUPINFO_PRESENT
        | CREATE_SUSPENDED
        | CREATE_UNICODE_ENVIRONMENT
        | CREATE_NO_WINDOW;
    let created = unsafe {
        CreateProcessW(
            windows::core::PCWSTR::null(),
            Some(windows::core::PWSTR(line.as_mut_ptr())),
            None,
            None,
            true,
            flags,
            Some(block.as_ptr() as *const c_void),
            windows::core::PCWSTR(cwd.as_ptr()),
            &startup.StartupInfo,
            &mut info,
        )
    };
    unsafe { DeleteProcThreadAttributeList(list) };
    if let Err(error) = created {
        unsafe {
            let _ = CloseHandle(job);
        }
        return Err(format!("Cannot start {}: {error}", spec.program.display()));
    }
    if let Err(error) = unsafe { AssignProcessToJobObject(job, info.hProcess) } {
        unsafe {
            let _ = TerminateJobObject(job, 1);
            let _ = CloseHandle(info.hThread);
            let _ = CloseHandle(info.hProcess);
            let _ = CloseHandle(job);
        }
        return Err(format!("Cannot contain the LaTeX process: {error}"));
    }
    unsafe { ResumeThread(info.hThread) };

    let mut cancelled = false;
    let mut timed_out = false;
    loop {
        if cancel.load(Ordering::SeqCst) {
            cancelled = true;
            unsafe {
                let _ = TerminateJobObject(job, 1);
            }
            break;
        }
        if unsafe { WaitForSingleObject(info.hProcess, 100) } == WAIT_OBJECT_0 {
            break;
        }
        if started.elapsed() >= spec.timeout {
            timed_out = true;
            unsafe {
                let _ = TerminateJobObject(job, 1);
            }
            break;
        }
    }
    let mut code = 0u32;
    unsafe { GetExitCodeProcess(info.hProcess, &mut code) }
        .map_err(|error| format!("Cannot read the LaTeX process exit code: {error}"))?;
    let _ = unsafe { WaitForSingleObject(info.hProcess, 5000) };
    unsafe {
        let _ = CloseHandle(info.hThread);
        let _ = CloseHandle(info.hProcess);
        let _ = CloseHandle(job);
    }

    let mut console_text = String::new();
    if let Ok(mut file) = File::open(spec.cwd.join("console.log")) {
        let _ = file.read_to_string(&mut console_text);
    }
    let (console_text, _) = crate::latex_native::log::bounded_log(&console_text);
    Ok(RunOutcome {
        status: code as i32,
        cancelled,
        timed_out,
        console: console_text,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    // Declared here rather than enabling the windows crate's Console feature
    // for test-only calls.
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetConsoleWindow() -> *mut c_void;
        fn FreeConsole() -> i32;
    }

    const PROBE: &str = "MDRAFT_TEST_CONSOLE_PROBE";
    const NAME: &str = "latex_native::runner::windows::tests::console_probe";

    fn window_state() -> &'static str {
        if unsafe { GetConsoleWindow() }.is_null() {
            "none"
        } else {
            "visible"
        }
    }

    /// Helper mode, launched by the test below in a child test process. In
    /// `parent` mode it also starts itself once more, the way an engine starts
    /// kpsewhich or a MiKTeX helper, and relays that grandchild's report. With
    /// no marker it is a no-op in an ordinary suite run.
    #[test]
    fn console_probe() {
        let Some(mode) = std::env::var_os(PROBE) else {
            return;
        };
        println!("child-window={}", window_state());
        if mode == "parent" {
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", NAME, "--nocapture", "--test-threads=1"])
                .env(PROBE, "grandchild")
                .output()
                .unwrap();
            let text = String::from_utf8_lossy(&output.stdout);
            // libtest prints the marker on its own "test … ... " line.
            let state = text
                .split("child-window=")
                .nth(1)
                .and_then(|rest| rest.split_whitespace().next())
                .unwrap_or("missing");
            println!("grandchild-window={state}");
        }
    }

    const LAUNCHER: &str = "latex_native::runner::windows::tests::console_launcher";

    /// Launcher mode: become what the release app is — a process with no
    /// console — and start the probe through the real runner. A test process
    /// started from a terminal (or from an agent's windowless shell) would
    /// otherwise hand the probe its own console, and the probe would report
    /// that console's window state, which says nothing about the flag.
    #[test]
    fn console_launcher() {
        if std::env::var_os("MDRAFT_TEST_CONSOLE_LAUNCHER").is_none() {
            return;
        }
        unsafe { FreeConsole() };
        let cwd = std::env::temp_dir().join(format!(
            "mdraft-console-probe-{}-{}",
            std::process::id(),
            JOB_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&cwd).unwrap();
        let mut env: Vec<(String, String)> = std::env::vars()
            .filter(|(key, _)| key != "MDRAFT_TEST_CONSOLE_LAUNCHER")
            .collect();
        env.push((PROBE.into(), "parent".into()));
        let outcome = run(
            &RunSpec {
                program: std::env::current_exe().unwrap(),
                args: ["--exact", NAME, "--nocapture", "--test-threads=1"]
                    .iter()
                    .map(OsString::from)
                    .collect(),
                cwd: cwd.clone(),
                env,
                timeout: Duration::from_secs(60),
            },
            &AtomicBool::new(false),
        )
        .unwrap();
        let _ = std::fs::remove_dir_all(&cwd);
        println!("status={}", outcome.status);
        println!("{}", outcome.console);
    }

    #[test]
    fn engines_run_in_a_hidden_console_with_working_output() {
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", LAUNCHER, "--nocapture", "--test-threads=1"])
            .env("MDRAFT_TEST_CONSOLE_LAUNCHER", "1")
            .output()
            .unwrap();
        let text = String::from_utf8_lossy(&output.stdout);
        // The markers arriving at all prove stdout still reaches console.log.
        assert!(
            text.contains("child-window=none"),
            "the engine must get a console without a window:\n{text}"
        );
        assert!(
            text.contains("grandchild-window=none"),
            "a helper the engine starts must inherit the hidden console:\n{text}"
        );
        assert!(text.contains("status=0"), "{text}");
    }
}
