//! Installed TeX distributions: discovery, validation and direct builds.
//!
//! The bundled engine stays the default. This module serves a reader who
//! explicitly chose an installation already on the computer: it finds one,
//! compiles a probe with it, and only then offers the switch. Every real job
//! stages the project into an app-owned directory, runs the engine as a
//! controllable process tree, and maps the compiler's log back to the snapshot —
//! never to the reader's disk.

mod discovery;
pub mod log;
mod runner;

use std::collections::{BTreeMap, HashMap};
use std::ffi::OsString;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

pub use discovery::Candidate;
use discovery::{ENGINES, TOOLS, distribution_name, engine_path, has_engine, known_engine};
use log::{Bibliography, Severity};

const MAX_FILE: usize = 32 * 1024 * 1024;
const MAX_PROJECT: usize = 64 * 1024 * 1024;
const MAX_FILES: usize = 256;
const COMPILE_TIMEOUT: Duration = Duration::from_secs(300);
const PROBE_TIMEOUT: Duration = Duration::from_secs(20);

/// The jobs a Cancel can reach, keyed by the caller's opaque token.
static JOBS: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();

fn jobs() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    JOBS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn register(job: &str) -> Result<Arc<AtomicBool>, String> {
    let token = Arc::new(AtomicBool::new(false));
    jobs()
        .lock()
        .map_err(|_| "The LaTeX job registry is unavailable.")?
        .insert(job.to_string(), token.clone());
    Ok(token)
}

fn finish(job: &str) {
    if let Ok(mut registry) = jobs().lock() {
        registry.remove(job);
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineStatus {
    /// `native`, `bundled` or `none`.
    pub backend: String,
    pub bundled_enabled: bool,
    pub bundled_installed: bool,
    pub native_enabled: bool,
    pub native_root: Option<String>,
    pub native_distribution: Option<String>,
    pub native_engine: String,
    pub native_engines: Vec<String>,
    /// Why the configured native installation cannot be used, when it cannot.
    pub problem: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolInfo {
    pub id: String,
    pub path: String,
    pub version: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub root: String,
    pub bin: String,
    pub distribution: String,
    pub engines: Vec<ToolInfo>,
    pub tools: Vec<ToolInfo>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    job: String,
    phase: String,
    detail: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeFile {
    path: String,
    data: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeCompileRequest {
    /// The preview's opaque owner token. Progress and Cancel use it.
    job: String,
    main_file: String,
    files: Vec<NativeFile>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeDiagnostic {
    pub file: String,
    pub line: u32,
    pub severity: String,
    pub message: String,
    pub code: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeCompileResult {
    pub pdf: Option<String>,
    pub partial_pdf: Option<String>,
    pub success: bool,
    pub cancelled: bool,
    pub timed_out: bool,
    pub engine: String,
    pub distribution: String,
    pub passes: u32,
    pub log: String,
    pub log_truncated: bool,
    pub diagnostics: Vec<NativeDiagnostic>,
    pub warnings_truncated: bool,
    pub error: Option<String>,
    pub elapsed_ms: u64,
}

/// The status the preview asks for before each render.
///
/// Reading this launches nothing and makes no request: it inspects the settings
/// and the configured engine files, so a moved installation is reported instead
/// of silently falling back to another engine.
#[tauri::command]
pub fn latex_engine_status(app: AppHandle) -> Result<EngineStatus, String> {
    let state = app
        .try_state::<crate::settings::AppState>()
        .ok_or("The settings store is unavailable.")?;
    let settings = state.snapshot()?;
    let bundled_installed = crate::latex::latex_status(app.clone()).unwrap_or(false);
    let native_root = settings.latex_native_root.clone();
    let native_engines = native_root
        .as_deref()
        .map(|root| {
            let directory = Path::new(root);
            ENGINES
                .iter()
                .filter(|engine| has_engine(directory, engine))
                .map(|engine| (*engine).to_string())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let mut problem = None;
    if settings.latex_native_enabled {
        match native_root.as_deref() {
            None => problem = Some("No installed TeX distribution is selected.".into()),
            Some(root) if !Path::new(root).is_dir() => {
                problem = Some(
                    "The selected TeX installation has moved. Find it again, or turn off the installed engine."
                        .into(),
                );
            }
            Some(_) if native_engines.is_empty() => {
                problem =
                    Some("The selected TeX installation no longer has a supported engine.".into());
            }
            Some(_) => {}
        }
    }
    let backend = if settings.latex_native_enabled {
        "native"
    } else if settings.latex_enabled {
        "bundled"
    } else {
        "none"
    };
    Ok(EngineStatus {
        backend: backend.into(),
        bundled_enabled: settings.latex_enabled,
        bundled_installed,
        native_enabled: settings.latex_native_enabled,
        native_distribution: native_root.as_deref().map(distribution_name),
        native_root,
        native_engine: settings.latex_native_engine,
        native_engines,
        problem,
    })
}

/// Metadata-only discovery. Never launches an executable.
#[tauri::command]
pub fn latex_native_discover() -> Vec<Candidate> {
    discovery::discover()
}

/// Validate a binary directory and commit it.
///
/// This is the explicit step that may execute external code: it probes versions
/// and compiles a tiny document. A failure leaves the previous selection
/// untouched.
#[tauri::command]
pub async fn latex_native_validate(
    app: AppHandle,
    directory: String,
) -> Result<Capabilities, String> {
    tauri::async_runtime::spawn_blocking(move || validate(&app, &directory))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub fn latex_native_set_enabled(app: AppHandle, enabled: bool) -> Result<EngineStatus, String> {
    let state = app
        .try_state::<crate::settings::AppState>()
        .ok_or("The settings store is unavailable.")?;
    let mut settings = state.snapshot()?;
    if enabled {
        let root = settings
            .latex_native_root
            .as_deref()
            .ok_or("Validate an installed TeX distribution before turning it on.")?;
        if !Path::new(root).is_dir() {
            return Err("The selected TeX installation has moved. Find it again first.".into());
        }
        if !ENGINES
            .iter()
            .any(|engine| has_engine(Path::new(root), engine))
        {
            return Err("The selected directory has no supported TeX engine.".into());
        }
    }
    settings.latex_native_enabled = enabled;
    state.save(settings)?;
    latex_engine_status(app)
}

#[tauri::command]
pub fn latex_native_set_engine(app: AppHandle, engine: String) -> Result<EngineStatus, String> {
    if engine != "auto" && known_engine(&engine).is_none() {
        return Err("Unknown LaTeX engine.".into());
    }
    let state = app
        .try_state::<crate::settings::AppState>()
        .ok_or("The settings store is unavailable.")?;
    let mut settings = state.snapshot()?;
    if let Some(root) = settings.latex_native_root.as_deref()
        && let Some(engine) = known_engine(&engine)
        && !has_engine(Path::new(root), engine)
    {
        return Err(format!(
            "The selected installation does not contain {engine}."
        ));
    }
    settings.latex_native_engine = engine;
    state.save(settings)?;
    latex_engine_status(app)
}

#[tauri::command]
pub fn latex_native_cancel(job: String) {
    if let Ok(registry) = jobs().lock()
        && let Some(token) = registry.get(&job)
    {
        token.store(true, Ordering::SeqCst);
    }
}

/// Compile one captured project revision.
#[tauri::command]
pub async fn latex_native_compile(
    app: AppHandle,
    request: NativeCompileRequest,
) -> Result<NativeCompileResult, String> {
    tauri::async_runtime::spawn_blocking(move || compile(&app, request))
        .await
        .map_err(|error| error.to_string())?
}

fn validate(app: &AppHandle, directory: &str) -> Result<Capabilities, String> {
    let requested = Path::new(directory);
    if !requested.is_absolute() {
        return Err("Choose a full path to the TeX engine directory.".into());
    }
    // `canonicalize` returns a verbatim `\\?\C:\...` path on Windows, and
    // `CreateProcessW` does not accept that form in the command line when
    // `lpApplicationName` is null. Keep a normal absolute path there; symlinks
    // in a TeX installation are legitimate. MacTeX's `/Library/TeX/texbin` is
    // also kept as the stable entry point because its target changes when TeX
    // Live is updated.
    let bin = if cfg!(windows) {
        std::path::absolute(requested)
            .map_err(|error| format!("Cannot read {}: {error}", requested.display()))?
    } else if cfg!(target_os = "macos") && requested.is_dir() {
        requested.to_path_buf()
    } else {
        std::fs::canonicalize(requested)
            .map_err(|error| format!("Cannot read {}: {error}", requested.display()))?
    };
    if !bin.is_dir() {
        return Err("The selected path is not a directory.".into());
    }
    let engines: Vec<&'static str> = ENGINES
        .iter()
        .copied()
        .filter(|engine| has_engine(&bin, engine))
        .collect();
    if engines.is_empty() {
        return Err(
            "No LuaLaTeX, pdfLaTeX or XeLaTeX executable was found in that directory.".into(),
        );
    }
    let root = discovery::infer_root(&bin).unwrap_or_else(|| bin.clone());
    let name = distribution_name(&bin.display().to_string());

    let job = runner::job_dir(app, "validate")?;
    let temp = job.path.join("probe");
    std::fs::create_dir_all(&temp).map_err(|error| error.to_string())?;
    let env = base_environment(&bin, &temp, &name);
    let mut engine_info = Vec::new();
    let mut engine_errors = Vec::new();
    for engine in &engines {
        let path = engine_path(&bin, engine);
        match probe_tool(&path, &temp, &env) {
            Ok(version) => engine_info.push(ToolInfo {
                id: (*engine).into(),
                path: path.display().to_string(),
                version,
            }),
            Err(error) => engine_errors.push(format!("{engine}: {error}")),
        }
    }
    if engine_info.is_empty() {
        return Err(format!(
            "The engine files exist but none of them could start. Check that the installation is \
             complete and that this account can execute it. {}",
            engine_errors.join(" | ")
        ));
    }
    let mut tool_info = Vec::new();
    for tool in TOOLS {
        if !bin.join(discovery::exe(tool)).is_file() {
            continue;
        }
        let path = bin.join(discovery::exe(tool));
        if let Ok(version) = probe_tool(&path, &temp, &env) {
            tool_info.push(ToolInfo {
                id: (*tool).to_string(),
                path: path.display().to_string(),
                version,
            });
        }
    }

    // The real gate: a document the same pipeline will compile. A version probe
    // can succeed on a broken installation; a PDF cannot.
    std::fs::write(
        temp.join("mdraft-probe.tex"),
        b"\\documentclass{article}\n\\begin{document}\nMDraft native probe.\n\\end{document}\n",
    )
    .map_err(|error| error.to_string())?;
    let preferred = engine_info
        .iter()
        .find(|entry| entry.id == "lualatex")
        .or_else(|| engine_info.first())
        .map(|entry| entry.id.clone())
        .unwrap_or_default();
    let engine = engine_path(&bin, &preferred);
    let args = engine_arguments(&preferred, "mdraft-probe.tex");
    let cancel = AtomicBool::new(false);
    let outcome = runner::run(
        &runner::RunSpec {
            program: engine,
            args,
            cwd: temp.clone(),
            env,
            timeout: PROBE_TIMEOUT,
        },
        &cancel,
    )?;
    let pdf = find_output(&temp, "mdraft-probe", "pdf");
    let log = std::fs::read_to_string(temp.join("mdraft-probe.log")).unwrap_or_default();
    let Some(pdf) = pdf else {
        return Err(format!(
            "The installation could not compile the probe document (exit {}).\n\n{}",
            outcome.status,
            tail(&log, &outcome.console)
        ));
    };
    if !pdf.starts_with(b"%PDF-") {
        return Err("The probe produced a file that is not a PDF.".into());
    }
    // Commit only after every probe succeeded.
    let state = app
        .try_state::<crate::settings::AppState>()
        .ok_or("The settings store is unavailable.")?;
    let mut settings = state.snapshot()?;
    settings.latex_native_root = Some(bin.display().to_string());
    if settings.latex_native_engine != "auto"
        && !engines.contains(&settings.latex_native_engine.as_str())
    {
        settings.latex_native_engine = "auto".into();
    }
    state.save(settings)?;

    Ok(Capabilities {
        root: root.display().to_string(),
        bin: bin.display().to_string(),
        distribution: name,
        engines: engine_info,
        tools: tool_info,
    })
}

fn probe_tool(program: &Path, cwd: &Path, env: &[(String, String)]) -> Result<String, String> {
    let cancel = AtomicBool::new(false);
    let outcome = runner::run(
        &runner::RunSpec {
            program: program.to_path_buf(),
            args: vec![OsString::from("--version")],
            cwd: cwd.to_path_buf(),
            env: env.to_vec(),
            timeout: PROBE_TIMEOUT,
        },
        &cancel,
    )?;
    if outcome.status != 0 {
        return Err(format!(
            "{} --version exited {}",
            program.display(),
            outcome.status
        ));
    }
    let first = outcome
        .console
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("found");
    Ok(first.to_string())
}

fn compile(app: &AppHandle, request: NativeCompileRequest) -> Result<NativeCompileResult, String> {
    let started = Instant::now();
    let state = app
        .try_state::<crate::settings::AppState>()
        .ok_or("The settings store is unavailable.")?;
    let settings = state.snapshot()?;
    if !settings.latex_native_enabled {
        return Err("The installed TeX distribution is turned off.".into());
    }
    let root = settings
        .latex_native_root
        .clone()
        .ok_or("No installed TeX distribution is selected.")?;
    let bin = PathBuf::from(&root);
    if !bin.is_dir() {
        return Err(
            "The selected TeX installation has moved. Find it again in Preferences › LaTeX.".into(),
        );
    }
    let name = distribution_name(&root);
    let token = register(&request.job)?;

    let job = match runner::job_dir(app, &request.job) {
        Ok(job) => job,
        Err(error) => {
            finish(&request.job);
            return Err(error);
        }
    };
    let work = job.path.join("project");
    let env = base_environment(&bin, &work, &name);
    let staged = match stage(&work, &request) {
        Ok(staged) => staged,
        Err(error) => {
            finish(&request.job);
            return Err(error);
        }
    };
    let engine = match select_engine(&settings.latex_native_engine, &bin, &work, &staged.main) {
        Ok(engine) => engine,
        Err(error) => {
            finish(&request.job);
            return Err(error);
        }
    };
    let main_name = staged
        .main
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "main.tex".into());
    // The snapshot puts the main file at the project root, but the request is
    // external input: pass its relative path, not only the file name, so a
    // nested value still compiles exactly what was staged.
    let main_argument = request.main_file.replace('\\', "/");
    let stem = main_name
        .strip_suffix(".tex")
        .unwrap_or(&main_name)
        .to_string();

    let mut logs: Vec<String> = Vec::new();
    let mut passes = 0u32;
    let mut bibliography_run = Bibliography::None;
    let mut missing_tool: Option<String> = None;
    let mut outcome = runner::RunOutcome::default();
    let mut cancelled = false;
    let mut timed_out = false;
    let mut last_log = String::new();
    let mut force_rerun = false;
    loop {
        if passes >= 3 {
            break;
        }
        passes += 1;
        emit(app, &request.job, "compiling", Some(&engine));
        let args = engine_arguments(&engine, &main_argument);
        outcome = match runner::run(
            &runner::RunSpec {
                program: engine_path(&bin, &engine),
                args,
                cwd: work.clone(),
                env: env.clone(),
                timeout: COMPILE_TIMEOUT,
            },
            &token,
        ) {
            Ok(outcome) => outcome,
            Err(error) => {
                finish(&request.job);
                return Err(error);
            }
        };
        if token.load(Ordering::SeqCst) || outcome.cancelled {
            cancelled = true;
        }
        if outcome.timed_out {
            timed_out = true;
        }
        let log = read_log(&work, &stem);
        last_log = log.clone();
        if !log.is_empty() {
            logs.push(log.clone());
        }
        let parsed = log::parse(&log, &staged.sources);
        if parsed.bibliography != Bibliography::None && bibliography_run == Bibliography::None {
            let tool = match parsed.bibliography {
                Bibliography::Bibtex => "bibtex",
                Bibliography::Biber => "biber",
                Bibliography::None => "",
            };
            if bin.join(discovery::exe(tool)).is_file() {
                bibliography_run = parsed.bibliography;
                emit(app, &request.job, "bibliography", Some(tool));
                let args = vec![OsString::from(stem.clone())];
                let helper = runner::run(
                    &runner::RunSpec {
                        program: bin.join(discovery::exe(tool)),
                        args,
                        cwd: work.clone(),
                        env: env.clone(),
                        timeout: PROBE_TIMEOUT * 3,
                    },
                    &token,
                )?;
                if !helper.console.trim().is_empty() {
                    logs.push(helper.console);
                }
                force_rerun = true;
            } else {
                missing_tool = Some(format!(
                    "This document needs {tool}, but it is not part of the selected installation. Install it with the distribution\x27s own tools, then compile again."
                ));
            }
        }
        if cancelled || timed_out {
            break;
        }
        if (!parsed.rerun && !force_rerun) || outcome.status != 0 {
            break;
        }
        force_rerun = false;
    }
    finish(&request.job);

    let pdf = find_output(&work, &stem, "pdf");
    let parsed = log::parse(&last_log, &staged.sources);
    let log_text = {
        let joined = logs.join("\n");
        let (bounded, truncated) = log::bounded_log(&joined);
        (bounded, truncated)
    };
    let errors: Vec<&log::RawDiagnostic> = parsed
        .diagnostics
        .iter()
        .filter(|entry| entry.severity == Severity::Error)
        .collect();
    let success = !cancelled
        && !timed_out
        && outcome.status == 0
        && pdf.is_some()
        && errors.is_empty()
        && missing_tool.is_none();
    let partial = pdf.filter(|bytes| bytes.starts_with(b"%PDF-"));
    let error = if cancelled {
        Some("Compilation cancelled.".into())
    } else if timed_out {
        Some("Compilation timed out.".into())
    } else if let Some(message) = &missing_tool {
        Some(message.clone())
    } else if !errors.is_empty() {
        Some(errors[0].message.clone())
    } else if outcome.status != 0 {
        Some(format!(
            "The compiler exited with status {}.",
            outcome.status
        ))
    } else if partial.is_none() {
        Some("The compiler reported success but produced no PDF.".into())
    } else {
        None
    };
    let mut diagnostics: Vec<NativeDiagnostic> = parsed
        .diagnostics
        .iter()
        .map(|entry| NativeDiagnostic {
            file: entry.file.clone(),
            line: entry.line,
            severity: entry.severity.as_str().to_string(),
            message: entry.message.clone(),
            code: entry.code.clone(),
        })
        .collect();
    if let Some(message) = &missing_tool {
        diagnostics.push(NativeDiagnostic {
            file: String::new(),
            line: 0,
            severity: "error".into(),
            message: message.clone(),
            code: "missing-tool".into(),
        });
    }
    let warnings_truncated = parsed.truncated
        && parsed
            .diagnostics
            .iter()
            .any(|entry| entry.severity == Severity::Warning);
    Ok(NativeCompileResult {
        pdf: if success {
            partial.as_ref().map(|bytes| STANDARD.encode(bytes))
        } else {
            None
        },
        partial_pdf: if !success {
            partial
                .filter(|_| !cancelled)
                .map(|bytes| STANDARD.encode(&bytes))
        } else {
            None
        },
        success,
        cancelled,
        timed_out,
        engine: engine.clone(),
        distribution: name,
        passes,
        log: log_text.0,
        log_truncated: log_text.1,
        diagnostics,
        warnings_truncated,
        error,
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}

fn emit(app: &AppHandle, job: &str, phase: &str, detail: Option<&str>) {
    let _ = app.emit(
        "latex-native-progress",
        Progress {
            job: job.to_string(),
            phase: phase.to_string(),
            detail: detail.map(str::to_string),
        },
    );
}

struct Staged {
    main: PathBuf,
    sources: BTreeMap<String, String>,
}

fn stage(work: &Path, request: &NativeCompileRequest) -> Result<Staged, String> {
    if request.files.is_empty() {
        return Err("The LaTeX project has no files.".into());
    }
    if request.files.len() > MAX_FILES {
        return Err("The LaTeX project exceeds its file count limit.".into());
    }
    std::fs::create_dir_all(work).map_err(|error| error.to_string())?;
    let mut total = 0usize;
    let mut main = None;
    let mut sources = BTreeMap::new();
    for file in &request.files {
        let relative = safe_relative(&file.path)?;
        if is_executable(&relative) {
            return Err(format!(
                "{} is an executable file; project executables are never staged.",
                file.path
            ));
        }
        let bytes = STANDARD
            .decode(&file.data)
            .map_err(|_| format!("{} is not valid project data.", file.path))?;
        if bytes.len() > MAX_FILE {
            return Err(format!("{} exceeds the 32 MiB file limit.", file.path));
        }
        total = total
            .checked_add(bytes.len())
            .ok_or("The LaTeX project size overflowed.")?;
        if total > MAX_PROJECT {
            return Err("The LaTeX project exceeds 64 MiB.".into());
        }
        let target = work.join(&relative);
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|error| {
                format!(
                    "Cannot create {} in the job directory: {error}",
                    parent.display()
                )
            })?;
        }
        std::fs::write(&target, &bytes)
            .map_err(|error| format!("Cannot stage {}: {error}", file.path))?;
        if relative == request.main_file {
            main = Some(target);
        }
        if relative.to_ascii_lowercase().ends_with(".tex")
            && let Ok(text) = String::from_utf8(bytes)
        {
            sources.insert(relative.replace('\\', "/"), text);
        }
    }
    let main = main.ok_or("The main .tex file is not part of the project snapshot.")?;
    Ok(Staged { main, sources })
}

/// A project-relative path that cannot leave the job directory.
///
/// Unicode is allowed, because a reader's folders are their own; what is refused
/// is anything that is absolute, escapes with `..`, or uses a Windows device or
/// drive prefix.
fn safe_relative(path: &str) -> Result<String, String> {
    let normal = path.replace('\\', "/");
    if normal.is_empty()
        || normal.len() > 512
        || normal.starts_with('/')
        || normal.contains(':')
        || normal.chars().any(|ch| ch.is_control())
    {
        return Err(format!("Unsafe project path: {path}"));
    }
    let mut parts = Vec::new();
    for part in normal.split('/') {
        if part.is_empty() || part == "." || part == ".." {
            return Err(format!("Unsafe project path: {path}"));
        }
        parts.push(part);
    }
    Ok(parts.join("/"))
}

fn is_executable(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    [
        ".exe", ".dll", ".com", ".bat", ".cmd", ".ps1", ".msi", ".scr", ".vbs", ".js", ".jse",
        ".wsf", ".cpl", ".pif", ".lnk", ".sh", ".app",
    ]
    .iter()
    .any(|suffix| lower.ends_with(suffix))
}

fn select_engine(requested: &str, bin: &Path, work: &Path, main: &Path) -> Result<String, String> {
    if let Some(engine) = known_engine(requested) {
        if !has_engine(bin, engine) {
            return Err(format!(
                "The selected installation does not contain {engine}."
            ));
        }
        return Ok(engine.to_string());
    }
    // Auto recognises only the documented `% !TEX program` allowlist; a value
    // outside it is ignored rather than executed.
    if let Ok(text) = std::fs::read_to_string(main) {
        for line in text.lines().take(30) {
            let trimmed = line.trim_start();
            let Some(rest) = trimmed
                .strip_prefix("%!TEX")
                .or_else(|| trimmed.strip_prefix("% !TEX"))
            else {
                continue;
            };
            let Some(value) = rest.trim().strip_prefix("program") else {
                continue;
            };
            let value = value.trim_start_matches([' ', '=']).trim();
            if let Some(engine) = known_engine(value)
                && has_engine(bin, engine)
            {
                let _ = work;
                return Ok(engine.to_string());
            }
        }
    }
    for engine in ENGINES {
        if has_engine(bin, engine) {
            return Ok((*engine).to_string());
        }
    }
    Err("The selected installation has no usable engine.".into())
}

fn set_env(env: &mut Vec<(String, String)>, key: &str, value: String) {
    env.retain(|(existing, _)| !existing.eq_ignore_ascii_case(key));
    env.push((key.to_string(), value));
}

fn base_environment(bin: &Path, work: &Path, distribution: &str) -> Vec<(String, String)> {
    let mut env: Vec<(String, String)> = Vec::new();
    let system_root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
    if cfg!(windows) {
        for key in [
            "SYSTEMROOT",
            "WINDIR",
            "COMSPEC",
            "PATHEXT",
            "NUMBER_OF_PROCESSORS",
            "PROCESSOR_ARCHITECTURE",
            "PROGRAMDATA",
            "PROGRAMFILES",
            "PROGRAMFILES(X86)",
            "COMMONPROGRAMFILES",
            "PUBLIC",
            "ALLUSERSPROFILE",
            "USERPROFILE",
            "HOMEDRIVE",
            "HOMEPATH",
            "APPDATA",
            "LOCALAPPDATA",
        ] {
            if let Ok(value) = std::env::var(key) {
                set_env(&mut env, key, value);
            }
        }
        let original = std::env::var("PATH").unwrap_or_default();
        set_env(
            &mut env,
            "PATH",
            format!(
                "{};{}\\System32;{};{}",
                bin.display(),
                system_root,
                system_root,
                original
            ),
        );
        set_env(&mut env, "NoDefaultCurrentDirectoryInExePath", "1".into());
    } else {
        let original = std::env::var("PATH").unwrap_or_default();
        let path = format!(
            "{}:/usr/local/bin:/usr/bin:/bin{}",
            bin.display(),
            if original.is_empty() {
                String::new()
            } else {
                format!(":{original}")
            }
        );
        set_env(&mut env, "PATH", path);
        set_env(
            &mut env,
            "LANG",
            std::env::var("LANG").unwrap_or_else(|_| "C.UTF-8".into()),
        );
        set_env(
            &mut env,
            "LC_ALL",
            std::env::var("LC_ALL").unwrap_or_else(|_| "C.UTF-8".into()),
        );
    }
    let temp = work.join("tmp");
    let cache = work.join("cache");
    let config = work.join("config");
    let data = work.join("data");
    for directory in [&temp, &cache, &config, &data] {
        let _ = std::fs::create_dir_all(directory);
    }
    set_env(&mut env, "TEMP", temp.display().to_string());
    set_env(&mut env, "TMP", temp.display().to_string());
    set_env(&mut env, "TMPDIR", temp.display().to_string());
    set_env(&mut env, "HOME", work.display().to_string());
    set_env(&mut env, "TEXMFVAR", data.display().to_string());
    set_env(&mut env, "TEXMFCONFIG", config.display().to_string());
    set_env(
        &mut env,
        "TEXMFHOME",
        work.join("home").display().to_string(),
    );
    // TeX Live's luaotfload treats a single TEXMFCACHE entry as an unusable
    // font cache and exits with "no writeable cache path"; its default list
    // (system cache plus the TEXMFVAR override) is what works. MiKTeX's
    // portable layout is the opposite: it needs TEXMFCACHE redirected.
    if distribution == "MiKTeX" {
        set_env(&mut env, "TEXMFCACHE", cache.display().to_string());
    }
    env
}
fn engine_arguments(_engine: &str, main: &str) -> Vec<OsString> {
    // Shell escape stays off: a document is not allowed to run arbitrary
    // commands. Package installation is left to the distribution, so MiKTeX's
    // installer is not disabled.
    vec![
        "-no-shell-escape".into(),
        "-file-line-error".into(),
        "-interaction=nonstopmode".into(),
        main.into(),
    ]
}

fn read_log(work: &Path, stem: &str) -> String {
    std::fs::read_to_string(work.join(format!("{stem}.log")))
        .or_else(|_| std::fs::read_to_string(work.join("console.log")))
        .unwrap_or_default()
}

fn find_output(work: &Path, stem: &str, extension: &str) -> Option<Vec<u8>> {
    let direct = work.join(format!("{stem}.{extension}"));
    if let Ok(bytes) = std::fs::read(&direct)
        && std::fs::symlink_metadata(&direct).is_ok_and(|meta| meta.file_type().is_file())
    {
        return Some(bytes);
    }
    let entries = std::fs::read_dir(work).ok()?;
    for entry in entries.flatten() {
        if !entry
            .file_name()
            .to_string_lossy()
            .to_ascii_lowercase()
            .ends_with(&format!(".{extension}"))
        {
            continue;
        }
        if !entry.file_type().is_ok_and(|kind| kind.is_file()) {
            continue;
        }
        if let Ok(bytes) = std::fs::read(entry.path()) {
            return Some(bytes);
        }
    }
    None
}

fn tail(log: &str, console: &str) -> String {
    let text = if log.trim().is_empty() { console } else { log };
    let (bounded, _) = log::bounded_log(text);
    let start = bounded.len().saturating_sub(4000);
    let start = bounded
        .char_indices()
        .map(|(at, _)| at)
        .find(|at| *at >= start)
        .unwrap_or(0);
    bounded[start..].to_string()
}

/// Write a small file atomically, for the diagnostics tests and the probe.
#[allow(dead_code)]
fn write_atomic(path: &Path, data: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("Invalid path")?;
    std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let temp = parent.join(format!(".{}.tmp", std::process::id()));
    {
        let mut file = std::fs::File::create(&temp).map_err(|error| error.to_string())?;
        file.write_all(data).map_err(|error| error.to_string())?;
    }
    std::fs::rename(&temp, path).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_staged_path_cannot_escape_the_job_directory() {
        for bad in [
            "../outside.tex",
            "/etc/passwd",
            "C:/Windows/system.ini",
            "a/../../b.tex",
            "a//b.tex",
            "a/./b.tex",
            "a\\..\\b.tex",
            "",
        ] {
            assert!(safe_relative(bad).is_err(), "{bad} must be refused");
        }
        assert_eq!(
            safe_relative("chapters/ünïcode.tex").unwrap(),
            "chapters/ünïcode.tex"
        );
        assert_eq!(safe_relative("figures/a b.png").unwrap(), "figures/a b.png");
    }

    #[test]
    fn an_executable_project_file_is_refused() {
        assert!(is_executable("tool.exe"));
        assert!(is_executable("obj/Debug/helper.DLL"));
        assert!(is_executable("run.cmd"));
        assert!(!is_executable("main.tex"));
        assert!(!is_executable("data.json"));
    }

    #[test]
    fn the_auto_engine_honours_only_the_tex_program_allowlist() {
        let root = std::env::temp_dir().join(format!("mdraft-native-{}", std::process::id()));
        let bin = root.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        for engine in ["lualatex", "pdflatex", "xelatex"] {
            std::fs::write(engine_path(&bin, engine), b"").unwrap();
        }
        let main = root.join("main.tex");
        std::fs::write(&main, "% !TEX program = pdflatex\n").unwrap();
        assert_eq!(
            select_engine("auto", &bin, &root, &main).unwrap(),
            "pdflatex"
        );
        std::fs::write(&main, "% !TEX program = sh\n").unwrap();
        assert_eq!(
            select_engine("auto", &bin, &root, &main).unwrap(),
            "lualatex"
        );
        std::fs::write(&main, "% !TEX program = xelatex\n").unwrap();
        assert_eq!(
            select_engine("xelatex", &bin, &root, &main).unwrap(),
            "xelatex"
        );
        std::fs::write(&main, "").unwrap();
        assert!(select_engine("pdflatex", &root, &root, &main).is_err());
        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    #[ignore = "requires TeX Live on the host"]
    fn a_real_engine_compiles_with_the_direct_runner() {
        let bin = std::path::PathBuf::from(
            std::env::var("MDRAFT_TEST_TEX_BIN").unwrap_or_else(|_| "/usr/bin".into()),
        );
        if !has_engine(&bin, "lualatex") {
            eprintln!("no lualatex in {}", bin.display());
            return;
        }
        let job = std::env::temp_dir().join(format!(
            "mdraft-native-real-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&job).unwrap();
        std::fs::write(
            job.join("main.tex"),
            b"\\documentclass{article}\n\\begin{document}\nNative runner probe.\n\\end{document}\n",
        )
        .unwrap();
        let env = base_environment(&bin, &job, "TeX Live");
        let cancel = AtomicBool::new(false);
        let outcome = runner::run(
            &runner::RunSpec {
                program: engine_path(&bin, "lualatex"),
                args: engine_arguments("lualatex", "main.tex"),
                cwd: job.clone(),
                env,
                timeout: Duration::from_secs(120),
            },
            &cancel,
        )
        .unwrap();
        assert_eq!(outcome.status, 0, "lualatex failed: {}", outcome.console);
        let pdf = find_output(&job, "main", "pdf").expect("a PDF");
        assert!(pdf.starts_with(b"%PDF-"));
        let _ = std::fs::remove_dir_all(job);
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "requires MDRAFT_TEST_TEX_BIN to name a real Windows TeX binary directory"]
    fn the_windows_probe_reads_a_version() {
        let Ok(bin) = std::env::var("MDRAFT_TEST_TEX_BIN") else {
            return;
        };
        let bin = std::path::PathBuf::from(bin);
        if !has_engine(&bin, "lualatex") {
            return;
        }
        let job = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../.tmp-native-probe")
            .join(std::process::id().to_string());
        std::fs::create_dir_all(&job).unwrap();
        let env = base_environment(&bin, &job, "MiKTeX");
        let version = probe_tool(&engine_path(&bin, "lualatex"), &job, &env).unwrap();
        assert!(!version.is_empty(), "a version line");
        let _ = std::fs::remove_dir_all(job);
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "requires MDRAFT_TEST_TEX_BIN to name a real Windows TeX binary directory"]
    fn a_real_windows_distribution_compiles() {
        let Ok(bin) = std::env::var("MDRAFT_TEST_TEX_BIN") else {
            eprintln!("MDRAFT_TEST_TEX_BIN is not set");
            return;
        };
        let bin = std::path::PathBuf::from(bin);
        if !has_engine(&bin, "lualatex") {
            eprintln!("no lualatex in {}", bin.display());
            return;
        }
        let job = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../.tmp-native-test")
            .join(format!(
                "{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
        std::fs::create_dir_all(&job).unwrap();
        std::fs::write(
            job.join("main.tex"),
            b"\\documentclass{article}\n\\begin{document}\nNative Windows probe.\n\\end{document}\n",
        )
        .unwrap();
        let env = base_environment(&bin, &job, "MiKTeX");
        let cancel = AtomicBool::new(false);
        let outcome = runner::run(
            &runner::RunSpec {
                program: engine_path(&bin, "lualatex"),
                args: engine_arguments("lualatex", "main.tex"),
                cwd: job.clone(),
                env,
                timeout: Duration::from_secs(300),
            },
            &cancel,
        )
        .unwrap();
        assert_eq!(outcome.status, 0, "lualatex failed: {}", outcome.console);
        let pdf = find_output(&job, "main", "pdf").expect("a PDF");
        assert!(pdf.starts_with(b"%PDF-"));
        let _ = std::fs::remove_dir_all(job);
    }

    #[cfg(unix)]
    #[test]
    #[ignore = "requires unprivileged process groups on the host"]
    fn the_linux_runner_cancels_the_whole_tree() {
        let job = std::env::temp_dir().join(format!(
            "mdraft-native-cancel-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&job).unwrap();
        let cancel = std::sync::Arc::new(AtomicBool::new(false));
        let token = cancel.clone();
        let started = Instant::now();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(400));
            token.store(true, Ordering::SeqCst);
        });
        let outcome = runner::run(
            &runner::RunSpec {
                program: std::path::PathBuf::from("/bin/sleep"),
                args: vec![OsString::from("30")],
                cwd: job.clone(),
                env: vec![("PATH".into(), "/usr/bin:/bin".into())],
                timeout: Duration::from_secs(20),
            },
            &cancel,
        )
        .unwrap();
        assert!(outcome.cancelled);
        assert!(started.elapsed() < Duration::from_secs(10));
        let _ = std::fs::remove_dir_all(job);
    }

    #[test]
    fn engine_arguments_keep_shell_escape_off_and_allow_packages() {
        let args: Vec<String> = engine_arguments("lualatex", "main.tex")
            .iter()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        assert!(!args.iter().any(|arg| arg == "--disable-installer"));
        assert!(args.iter().any(|arg| arg == "-no-shell-escape"));
        assert!(args.iter().any(|arg| arg == "-file-line-error"));
        assert_eq!(args.last().unwrap(), "main.tex");
        assert!(!args.iter().any(|arg| arg.contains("install")));
    }

    #[test]
    fn the_environment_keeps_child_state_inside_the_job() {
        let root = std::env::temp_dir().join(format!("mdraft-env-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let env = base_environment(Path::new("/tex/bin"), &root, "TeX Live");
        let temp = env
            .iter()
            .find(|(key, _)| key == "TEMP")
            .map(|(_, value)| value.clone())
            .unwrap();
        assert!(temp.starts_with(&root.display().to_string()));
        assert!(env.iter().any(|(key, _)| key == "TEXMFVAR"));
    }
}
