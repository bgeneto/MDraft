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
pub mod wsl;

use std::collections::BTreeMap;
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

use crate::cancel_registry::{CancelRegistry, Ticket};

const MAX_FILE: usize = 32 * 1024 * 1024;
const MAX_PROJECT: usize = 64 * 1024 * 1024;
const MAX_FILES: usize = 256;
const COMPILE_TIMEOUT: Duration = Duration::from_secs(300);
const PROBE_TIMEOUT: Duration = Duration::from_secs(20);

/// The jobs a Cancel can reach, keyed by the caller's opaque token.
///
/// The frontend names the job before it invokes the compile, and an edit or
/// Cancel can send `latex_native_cancel` before `compile` has registered it.
/// The registry keeps such a Cancel as a tombstone, so the job starts
/// cancelled instead of running a whole process tree nobody wants.
static JOBS: OnceLock<Mutex<CancelRegistry<Arc<AtomicBool>>>> = OnceLock::new();

fn jobs() -> &'static Mutex<CancelRegistry<Arc<AtomicBool>>> {
    JOBS.get_or_init(|| Mutex::new(CancelRegistry::default()))
}

/// One registered job; dropping it forgets the job on every return path.
struct Registered {
    job: String,
    ticket: Ticket,
}

impl Drop for Registered {
    fn drop(&mut self) {
        if let Ok(mut registry) = jobs().lock() {
            registry.finish(&self.job, self.ticket);
        }
    }
}

fn register(job: &str) -> Result<(Arc<AtomicBool>, Registered), String> {
    let token = Arc::new(AtomicBool::new(false));
    let (ticket, _) = jobs()
        .lock()
        .map_err(|_| "The LaTeX job registry is unavailable.")?
        .register(job, token.clone());
    Ok((
        token,
        Registered {
            job: job.to_string(),
            ticket,
        },
    ))
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
    /// The selected TeX Live inside WSL, when that is the native engine.
    pub native_wsl: Option<wsl::WslInstallation>,
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
    /// Captured local libraries, staged beside the project, never inside it.
    #[serde(default)]
    texmf: Option<crate::latex_texmf::TexmfSnapshot>,
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
    let native_wsl = settings.latex_native_wsl.clone();
    let mut native_engines = native_root
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
    if let Some(selected) = &native_wsl {
        native_engines = selected.engines.clone();
        // Registry only: a status read must never start the distribution.
        if settings.latex_native_enabled && !wsl_registered(&selected.distro) {
            problem = Some(format!(
                "The WSL distribution {} is no longer registered. Find an installation again, or turn off the installed engine.",
                selected.distro
            ));
        }
    } else if settings.latex_native_enabled {
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
        native_distribution: match &native_wsl {
            Some(selected) => Some(wsl_distribution_name(&selected.distro)),
            None => native_root.as_deref().map(distribution_name),
        },
        native_root,
        native_engine: settings.latex_native_engine,
        native_engines,
        native_wsl,
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
    if enabled && let Some(selected) = &settings.latex_native_wsl {
        if !wsl_registered(&selected.distro) {
            return Err(format!(
                "The WSL distribution {} is no longer registered.",
                selected.distro
            ));
        }
    } else if enabled {
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
    if let Some(selected) = &settings.latex_native_wsl
        && let Some(engine) = known_engine(&engine)
        && !selected.engines.iter().any(|known| known == engine)
    {
        return Err(format!(
            "The selected installation does not contain {engine}."
        ));
    }
    if settings.latex_native_wsl.is_none()
        && let Some(root) = settings.latex_native_root.as_deref()
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
    if let Ok(mut registry) = jobs().lock() {
        registry.cancel(&job);
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

/// Registered WSL distributions, from the registry only. Starts nothing.
#[tauri::command]
pub fn latex_native_wsl_distributions() -> Vec<wsl::WslDistribution> {
    #[cfg(windows)]
    {
        wsl::distributions()
    }
    #[cfg(not(windows))]
    {
        Vec::new()
    }
}

/// Look for TeX engines inside one distribution. This starts its VM, which is
/// why it is a separate, explicit action rather than part of discovery.
#[tauri::command]
pub async fn latex_native_wsl_look(
    app: AppHandle,
    distro: String,
) -> Result<Vec<wsl::WslCandidate>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(windows)]
        {
            let job = runner::job_dir(&app, "wsl-look")?;
            wsl::look_inside(&distro, &job.path)
        }
        #[cfg(not(windows))]
        {
            let _ = (app, distro);
            Err("WSL is available only on Windows.".to_string())
        }
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Validate a TeX Live inside WSL with version probes and a probe compile,
/// then commit it as the installed engine.
#[tauri::command]
pub async fn latex_native_wsl_validate(
    app: AppHandle,
    distro: String,
    bin: String,
) -> Result<Capabilities, String> {
    tauri::async_runtime::spawn_blocking(move || validate_wsl(&app, &distro, &bin))
        .await
        .map_err(|error| error.to_string())?
}

#[cfg(not(windows))]
fn validate_wsl(_app: &AppHandle, _distro: &str, _bin: &str) -> Result<Capabilities, String> {
    Err("WSL is available only on Windows.".into())
}

#[cfg(windows)]
fn validate_wsl(app: &AppHandle, distro: &str, bin: &str) -> Result<Capabilities, String> {
    if !wsl::registered(distro) {
        return Err(format!("{distro} is not a registered WSL distribution."));
    }
    if !wsl::safe_linux_dir(bin) {
        return Err("Choose an absolute Linux directory such as /usr/bin.".into());
    }
    let job = runner::job_dir(app, "validate-wsl")?;
    let work = job.path.join("project");
    std::fs::create_dir_all(&work).map_err(|error| error.to_string())?;
    let _ = base_environment(Path::new(bin), &work, "TeX Live");
    let linux = wsl::linux_path(distro, &job.path, &work)?;
    let env = wsl_environment(bin, &linux, "lualatex", 0);
    let probe = |program: &str| -> Result<Option<String>, String> {
        let outcome = runner::run(
            &wsl::engine_spec(
                distro,
                &work,
                &env,
                &format!("{bin}/{program}"),
                &[OsString::from("--version")],
                PROBE_TIMEOUT,
            )?,
            &AtomicBool::new(false),
        )?;
        Ok((outcome.status == 0).then(|| {
            outcome
                .console
                .lines()
                .map(str::trim)
                .find(|line| !line.is_empty())
                .unwrap_or("found")
                .to_string()
        }))
    };
    let mut engines = Vec::new();
    for engine in ENGINES {
        if let Some(version) = probe(engine)? {
            engines.push(ToolInfo {
                id: (*engine).into(),
                path: format!("{bin}/{engine}"),
                version,
            });
        }
    }
    if engines.is_empty() {
        return Err(format!(
            "No LuaLaTeX, pdfLaTeX or XeLaTeX could start from {bin} in {distro}."
        ));
    }
    let mut tools = Vec::new();
    for tool in TOOLS {
        if let Some(version) = probe(tool)? {
            tools.push(ToolInfo {
                id: (*tool).into(),
                path: format!("{bin}/{tool}"),
                version,
            });
        }
    }
    std::fs::write(
        work.join("mdraft-probe.tex"),
        b"\\documentclass{article}\n\\begin{document}\nMDraft native probe.\n\\end{document}\n",
    )
    .map_err(|error| error.to_string())?;
    let preferred = engines
        .iter()
        .find(|entry| entry.id == "lualatex")
        .unwrap_or(&engines[0])
        .id
        .clone();
    let outcome = runner::run(
        &wsl::engine_spec(
            distro,
            &work,
            &env,
            &format!("{bin}/{preferred}"),
            &engine_arguments(&preferred, "mdraft-probe.tex"),
            PROBE_TIMEOUT * 3,
        )?,
        &AtomicBool::new(false),
    )?;
    let log = std::fs::read_to_string(work.join("mdraft-probe.log")).unwrap_or_default();
    let Some(pdf) = find_output(&work, "mdraft-probe", "pdf") else {
        return Err(format!(
            "The installation could not compile the probe document (exit {}).\n\n{}",
            outcome.status,
            tail(&log, &outcome.console)
        ));
    };
    if !pdf.starts_with(b"%PDF-") {
        return Err("The probe produced a file that is not a PDF.".into());
    }
    let state = app
        .try_state::<crate::settings::AppState>()
        .ok_or("The settings store is unavailable.")?;
    let mut settings = state.snapshot()?;
    settings.latex_native_wsl = Some(wsl::WslInstallation {
        distro: distro.to_string(),
        bin: bin.to_string(),
        engines: engines.iter().map(|entry| entry.id.clone()).collect(),
        tools: tools.iter().map(|entry| entry.id.clone()).collect(),
    });
    settings.latex_native_root = None;
    if settings.latex_native_engine != "auto"
        && !engines
            .iter()
            .any(|entry| entry.id == settings.latex_native_engine)
    {
        settings.latex_native_engine = "auto".into();
    }
    state.save(settings)?;
    Ok(Capabilities {
        root: format!("{distro}:{bin}"),
        bin: bin.to_string(),
        distribution: wsl_distribution_name(distro),
        engines,
        tools,
    })
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
    settings.latex_native_wsl = None;
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
    let target = Target::from_settings(&settings)?;
    let name = target.distribution();
    let (token, registration) = register(&request.job)?;

    let job = runner::job_dir(app, &request.job)?;
    let work = job.path.join("project");
    let staged = stage(&work, &request)?;
    let roots = stage_texmf(&job.path.join("texmf"), request.texmf.as_ref())?;
    let engine = select_engine_with(
        &settings.latex_native_engine,
        &|engine| target.has_engine(engine),
        &staged.main,
    )?;
    if matches!(target, Target::Wsl(_)) {
        emit(app, &request.job, "starting-wsl", None);
    }
    let env = target.environment(&job.path, &work, &engine, roots)?;
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
        // A Cancel that arrived before registration, or between passes, stops
        // here rather than after one more engine process.
        if token.load(Ordering::SeqCst) {
            cancelled = true;
            break;
        }
        passes += 1;
        emit(app, &request.job, "compiling", Some(&engine));
        let args = engine_arguments(&engine, &main_argument);
        outcome = runner::run(
            &target.spec(&engine, args, &work, &env, COMPILE_TIMEOUT)?,
            &token,
        )?;
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
            if target.has_tool(tool) {
                bibliography_run = parsed.bibliography;
                emit(app, &request.job, "bibliography", Some(tool));
                let args = vec![OsString::from(stem.clone())];
                let helper = runner::run(
                    &target.spec(tool, args, &work, &env, PROBE_TIMEOUT * 3)?,
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
    drop(registration);

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

#[cfg(test)]
fn select_engine(requested: &str, bin: &Path, _work: &Path, main: &Path) -> Result<String, String> {
    select_engine_with(requested, &|engine| has_engine(bin, engine), main)
}

fn select_engine_with(
    requested: &str,
    has: &dyn Fn(&str) -> bool,
    main: &Path,
) -> Result<String, String> {
    if let Some(engine) = known_engine(requested) {
        if !has(engine) {
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
                && has(engine)
            {
                return Ok(engine.to_string());
            }
        }
    }
    for engine in ENGINES {
        if has(engine) {
            return Ok((*engine).to_string());
        }
    }
    Err("The selected installation has no usable engine.".into())
}

/// Where a job runs: a host binary directory, or TeX Live inside WSL.
enum Target {
    Path { bin: PathBuf, name: String },
    Wsl(wsl::WslInstallation),
}

/// How a distribution finds files outside its own trees.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Family {
    /// TeX Live, MacTeX, TinyTeX and distribution packages.
    Kpathsea,
    /// MiKTeX ignores TEXMFHOME; it honours `.;`-prefixed search variables.
    Miktex,
}

impl Target {
    fn from_settings(settings: &crate::settings::Settings) -> Result<Target, String> {
        if let Some(selected) = &settings.latex_native_wsl {
            if !wsl_registered(&selected.distro) {
                return Err(format!(
                    "The WSL distribution {} is no longer registered. Find an installation again in Preferences › LaTeX.",
                    selected.distro
                ));
            }
            return Ok(Target::Wsl(selected.clone()));
        }
        let root = settings
            .latex_native_root
            .clone()
            .ok_or("No installed TeX distribution is selected.")?;
        let bin = PathBuf::from(&root);
        if !bin.is_dir() {
            return Err(
                "The selected TeX installation has moved. Find it again in Preferences › LaTeX."
                    .into(),
            );
        }
        Ok(Target::Path {
            name: distribution_name(&root),
            bin,
        })
    }

    fn distribution(&self) -> String {
        match self {
            Target::Path { name, .. } => name.clone(),
            Target::Wsl(selected) => wsl_distribution_name(&selected.distro),
        }
    }

    fn family(&self) -> Family {
        match self {
            Target::Path { name, .. } if name == "MiKTeX" => Family::Miktex,
            _ => Family::Kpathsea,
        }
    }

    fn has_engine(&self, engine: &str) -> bool {
        match self {
            Target::Path { bin, .. } => has_engine(bin, engine),
            Target::Wsl(selected) => selected.engines.iter().any(|known| known == engine),
        }
    }

    fn has_tool(&self, tool: &str) -> bool {
        match self {
            Target::Path { bin, .. } => bin.join(discovery::exe(tool)).is_file(),
            Target::Wsl(selected) => selected.tools.iter().any(|known| known == tool),
        }
    }

    fn environment(
        &self,
        job: &Path,
        work: &Path,
        engine: &str,
        roots: usize,
    ) -> Result<Vec<(String, String)>, String> {
        match self {
            Target::Path { bin, name } => {
                let mut env = base_environment(bin, work, name);
                for (key, value) in library_environment(self.family(), engine, roots) {
                    set_env(&mut env, &key, value);
                }
                Ok(env)
            }
            Target::Wsl(selected) => {
                // Creates the private directories on the Windows side.
                let _ = base_environment(Path::new(&selected.bin), work, "TeX Live");
                let linux = wsl_linux_path(&selected.distro, job)?;
                Ok(wsl_environment(&selected.bin, &linux, engine, roots))
            }
        }
    }

    fn spec(
        &self,
        program: &str,
        args: Vec<OsString>,
        work: &Path,
        env: &[(String, String)],
        timeout: Duration,
    ) -> Result<runner::RunSpec, String> {
        match self {
            Target::Path { bin, .. } => Ok(runner::RunSpec {
                program: engine_path(bin, program),
                args,
                cwd: work.to_path_buf(),
                env: env.to_vec(),
                timeout,
            }),
            Target::Wsl(selected) => wsl_engine_spec(selected, work, env, program, &args, timeout),
        }
    }
}

/// The exact Linux environment of a WSL job. `job` is the Linux form of the
/// Windows job directory; everything writable stays inside it.
fn wsl_environment(bin: &str, job: &str, engine: &str, roots: usize) -> Vec<(String, String)> {
    let work = format!("{job}/project");
    let mut env = vec![
        // Not the Windows PATH that WSL interop appends.
        ("PATH".to_string(), format!("{bin}:/usr/bin:/bin")),
        ("LANG".to_string(), "C.UTF-8".to_string()),
        ("LC_ALL".to_string(), "C.UTF-8".to_string()),
        ("HOME".to_string(), work.clone()),
        ("TMPDIR".to_string(), format!("{work}/tmp")),
        ("TEXMFVAR".to_string(), format!("{work}/data")),
        ("TEXMFCONFIG".to_string(), format!("{work}/config")),
        ("TEXMFHOME".to_string(), format!("{work}/home")),
    ];
    for (key, value) in library_environment(Family::Kpathsea, engine, roots) {
        set_env(&mut env, &key, value);
    }
    env
}

/// The search-path variables that put staged libraries after the project and
/// before the distribution. Paths are relative to the engine's working
/// directory (job/project), so a job path with a comma, brace or non-ASCII
/// letter never enters a search-path expression. Measured on TeX Live 2025 and
/// MiKTeX 23.1; see the support matrix in the local TEXMF plan.
fn library_environment(family: Family, engine: &str, roots: usize) -> Vec<(String, String)> {
    if roots == 0 {
        return Vec::new();
    }
    let root = |n: usize| format!("../texmf/{n}");
    match family {
        Family::Kpathsea => {
            // TEXMFHOME is part of $TEXMF, so the distribution's own cnf supplies
            // format-aware TEXINPUTS.<fmt>, BSTINPUTS, LUAINPUTS and font paths.
            let list: Vec<String> = (0..roots).map(root).collect();
            vec![("TEXMFHOME".into(), format!("{{{}}}", list.join(",")))]
        }
        Family::Miktex => {
            let tex: &[&str] = match engine {
                "lualatex" => &["tex/lualatex", "tex/latex", "tex/luatex", "tex/generic"],
                "xelatex" => &["tex/xelatex", "tex/latex", "tex/xetex", "tex/generic"],
                _ => &["tex/latex", "tex/pdftex", "tex/generic"],
            };
            let over = |subdirs: &[&str]| -> String {
                // The leading `.` keeps the project first: MiKTeX otherwise
                // searches these variables before the working directory.
                let mut value = String::from(".;");
                for n in 0..roots {
                    for dir in subdirs {
                        value.push_str(&format!("{}/{dir}//;", root(n)));
                    }
                }
                value
            };
            vec![
                ("TEXINPUTS".into(), over(tex)),
                ("BSTINPUTS".into(), over(&["bibtex/bst"])),
                ("BIBINPUTS".into(), over(&["bibtex/bib"])),
                (
                    "LUAINPUTS".into(),
                    over(&[
                        "scripts",
                        "tex/luatex",
                        "tex/lualatex",
                        "tex/latex",
                        "tex/generic",
                    ]),
                ),
                ("OPENTYPEFONTS".into(), over(&["fonts/opentype"])),
                ("TTFONTS".into(), over(&["fonts/truetype"])),
            ]
        }
    }
}

/// Write a validated library snapshot as job/texmf/<n>/<TDS path>.
fn stage_texmf(
    dir: &Path,
    snapshot: Option<&crate::latex_texmf::TexmfSnapshot>,
) -> Result<usize, String> {
    let Some(snapshot) = snapshot else {
        return Ok(0);
    };
    crate::latex_texmf::validate_snapshot(snapshot)?;
    for index in 0..snapshot.roots.len() {
        std::fs::create_dir_all(dir.join(index.to_string())).map_err(|error| error.to_string())?;
    }
    for file in &snapshot.files {
        let bytes = STANDARD
            .decode(&file.data)
            .map_err(|_| format!("{} is not valid library data.", file.path))?;
        if bytes.len() > MAX_FILE {
            return Err(format!("{} exceeds the 32 MiB file limit.", file.path));
        }
        let target = dir.join(file.root.to_string()).join(&file.path);
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        std::fs::write(&target, &bytes)
            .map_err(|error| format!("Cannot stage the library file {}: {error}", file.path))?;
    }
    Ok(snapshot.roots.len())
}

fn wsl_distribution_name(distro: &str) -> String {
    format!("TeX Live (WSL: {distro})")
}

#[cfg(windows)]
fn wsl_registered(distro: &str) -> bool {
    wsl::registered(distro)
}

#[cfg(not(windows))]
fn wsl_registered(_distro: &str) -> bool {
    false
}

#[cfg(windows)]
fn wsl_linux_path(distro: &str, job: &Path) -> Result<String, String> {
    wsl::linux_path(distro, job, job)
}

#[cfg(not(windows))]
fn wsl_linux_path(_distro: &str, _job: &Path) -> Result<String, String> {
    Err("WSL is available only on Windows.".into())
}

#[cfg(windows)]
fn wsl_engine_spec(
    selected: &wsl::WslInstallation,
    work: &Path,
    env: &[(String, String)],
    program: &str,
    args: &[OsString],
    timeout: Duration,
) -> Result<runner::RunSpec, String> {
    if !wsl::safe_linux_dir(&selected.bin)
        || !(known_engine(program).is_some() || TOOLS.contains(&program))
    {
        return Err("Invalid WSL program.".into());
    }
    wsl::engine_spec(
        &selected.distro,
        work,
        env,
        &format!("{}/{program}", selected.bin),
        args,
        timeout,
    )
}

#[cfg(not(windows))]
fn wsl_engine_spec(
    _selected: &wsl::WslInstallation,
    _work: &Path,
    _env: &[(String, String)],
    _program: &str,
    _args: &[OsString],
    _timeout: Duration,
) -> Result<runner::RunSpec, String> {
    Err("WSL is available only on Windows.".into())
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

    fn value<'a>(env: &'a [(String, String)], key: &str) -> Option<&'a str> {
        env.iter()
            .find(|(name, _)| name == key)
            .map(|(_, value)| value.as_str())
    }

    #[test]
    fn library_search_paths_follow_the_distribution_family() {
        assert!(library_environment(Family::Kpathsea, "lualatex", 0).is_empty());
        assert!(library_environment(Family::Miktex, "lualatex", 0).is_empty());
        let kpathsea = library_environment(Family::Kpathsea, "pdflatex", 2);
        assert_eq!(
            value(&kpathsea, "TEXMFHOME"),
            Some("{../texmf/0,../texmf/1}")
        );
        let miktex = library_environment(Family::Miktex, "lualatex", 2);
        let tex = value(&miktex, "TEXINPUTS").unwrap();
        // Project first (MiKTeX searches these before the working directory),
        // then roots in order with format-specific directories first.
        assert!(
            tex.starts_with(".;../texmf/0/tex/lualatex//;../texmf/0/tex/latex//;"),
            "{tex}"
        );
        assert!(tex.find("../texmf/0/").unwrap() < tex.find("../texmf/1/").unwrap());
        assert!(!tex.contains("tex/xelatex"));
        assert!(
            value(&miktex, "BSTINPUTS")
                .unwrap()
                .starts_with(".;../texmf/0/bibtex/bst//;")
        );
        assert!(
            value(&miktex, "LUAINPUTS")
                .unwrap()
                .contains("../texmf/1/scripts//;")
        );
        assert!(value(&miktex, "OPENTYPEFONTS").is_some());
        let xelatex = library_environment(Family::Miktex, "xelatex", 1);
        assert!(
            value(&xelatex, "TEXINPUTS")
                .unwrap()
                .starts_with(".;../texmf/0/tex/xelatex//;")
        );
        // Every entry is relative: a job path never enters a search expression.
        for (_, value) in kpathsea.iter().chain(&miktex) {
            assert!(!value.contains(':') || value.starts_with(".;"), "{value}");
            assert!(!value.contains('\\'));
        }
    }

    #[test]
    fn the_wsl_environment_is_exact_and_job_local() {
        let env = wsl_environment(
            "/usr/local/texlive/2025/bin/x86_64-linux",
            "/mnt/c/jobs/a, b",
            "lualatex",
            1,
        );
        assert_eq!(
            value(&env, "PATH"),
            Some("/usr/local/texlive/2025/bin/x86_64-linux:/usr/bin:/bin")
        );
        assert_eq!(value(&env, "HOME"), Some("/mnt/c/jobs/a, b/project"));
        assert_eq!(value(&env, "TEXMFHOME"), Some("{../texmf/0}"));
        assert!(
            value(&env, "TEXMFVAR")
                .unwrap()
                .starts_with("/mnt/c/jobs/a, b/")
        );
        let without = wsl_environment("/usr/bin", "/mnt/c/jobs/x", "pdflatex", 0);
        assert_eq!(
            value(&without, "TEXMFHOME"),
            Some("/mnt/c/jobs/x/project/home")
        );
    }

    fn library_snapshot(
        files: &[(usize, &str, &[u8])],
        roots: usize,
    ) -> crate::latex_texmf::TexmfSnapshot {
        crate::latex_texmf::TexmfSnapshot {
            revision: "test".into(),
            roots: (0..roots)
                .map(|n| crate::latex_texmf::SnapshotRoot {
                    id: n.to_string(),
                    label: n.to_string(),
                    layout: crate::latex_texmf::Layout::Tds,
                    path: String::new(),
                })
                .collect(),
            files: files
                .iter()
                .map(|(root, path, data)| crate::latex_texmf::TexmfFile {
                    root: *root,
                    path: (*path).into(),
                    origin: String::new(),
                    data: STANDARD.encode(data),
                })
                .collect(),
        }
    }

    #[test]
    fn libraries_are_staged_beside_the_project_and_revalidated() {
        let job = std::env::temp_dir().join(format!(
            "mdraft-stage-texmf-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let snapshot = library_snapshot(
            &[
                (0, "tex/latex/a/a.sty", b"x"),
                (1, "fonts/opentype/f/F.otf", &[0, 255]),
            ],
            3,
        );
        assert_eq!(stage_texmf(&job.join("texmf"), Some(&snapshot)).unwrap(), 3);
        assert_eq!(
            std::fs::read(job.join("texmf/0/tex/latex/a/a.sty")).unwrap(),
            b"x"
        );
        assert_eq!(
            std::fs::read(job.join("texmf/1/fonts/opentype/f/F.otf")).unwrap(),
            [0, 255]
        );
        assert!(job.join("texmf/2").is_dir(), "an empty root still exists");
        let escaping = library_snapshot(&[(0, "tex/../../project/main.tex", b"x")], 1);
        assert!(stage_texmf(&job.join("texmf2"), Some(&escaping)).is_err());
        assert_eq!(stage_texmf(&job.join("none"), None).unwrap(), 0);
        let _ = std::fs::remove_dir_all(job);
    }

    /// The staged fixture used by the real-engine library tests: a class in
    /// root 0 that loads a package present in roots 0 and 1 (root 0 wins), a
    /// root-1-only package, format-specific copies, a project file shadowing a
    /// root file (the project wins), and a .bst/.bib pair.
    fn library_fixture(job: &Path) -> (crate::latex_texmf::TexmfSnapshot, &'static str) {
        let project = job.join("project");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::write(
            project.join("main.tex"),
            "\\documentclass{mdraftcls}\\usepackage{mdraftover}\n\\begin{document}\nGate.\\nocite{*}\\bibliographystyle{mdraftgate}\\bibliography{mdraftgate}\n\\end{document}\n",
        )
        .unwrap();
        std::fs::write(
            project.join("mdraftover.sty"),
            "\\ProvidesPackage{mdraftover}\\typeout{RESULT-OVER: project}\n",
        )
        .unwrap();
        let bst = concat!(
            "ENTRY{title}{}{}\n",
            "FUNCTION{misc}{ \"\\bibitem{\" cite$ * \"}\" * write$ newline$ title write$ newline$ }\n",
            "READ\n",
            "FUNCTION{begin.bib}{ \"\\begin{thebibliography}{1}\" write$ newline$ }\n",
            "EXECUTE{begin.bib}\n",
            "ITERATE{call.type$}\n",
            "FUNCTION{end.bib}{ \"\\end{thebibliography}\" write$ newline$ }\n",
            "EXECUTE{end.bib}\n",
        );
        let files: Vec<(usize, &str, Vec<u8>)> = vec![
            (0, "tex/latex/mdraftcls/mdraftcls.cls", b"\\NeedsTeXFormat{LaTeX2e}\\ProvidesClass{mdraftcls}\\LoadClassWithOptions{article}\\RequirePackage{mdraftpkg}\\RequirePackageWithOptions{mdraftdup}\\InputIfFileExists{mdraftcls-extra.def}{}{\\typeout{RESULT-DEF: missing}}\n".to_vec()),
            (0, "tex/latex/mdraftcls/mdraftcls-extra.def", b"\\typeout{RESULT-DEF: r0}\n".to_vec()),
            (0, "tex/latex/mdraftpkg/mdraftpkg.sty", b"\\ProvidesPackage{mdraftpkg}\\typeout{RESULT-PKG: r0}\\RequirePackage{mdraftronly}\n".to_vec()),
            (0, "tex/latex/mdraftover/mdraftover.sty", b"\\ProvidesPackage{mdraftover}\\typeout{RESULT-OVER: r0}\n".to_vec()),
            (0, "tex/lualatex/mdraftdup/mdraftdup.sty", b"\\ProvidesPackage{mdraftdup}\\typeout{RESULT-DUP: lualatex}\n".to_vec()),
            (0, "tex/latex/mdraftdup/mdraftdup.sty", b"\\ProvidesPackage{mdraftdup}\\typeout{RESULT-DUP: latex}\n".to_vec()),
            (0, "tex/context/mdraftdup/mdraftdup.sty", b"\\ProvidesPackage{mdraftdup}\\typeout{RESULT-DUP: context}\n".to_vec()),
            (0, "bibtex/bst/mdraftgate/mdraftgate.bst", bst.as_bytes().to_vec()),
            (0, "bibtex/bib/mdraftgate/mdraftgate.bib", b"@misc{gate, title={RESULTBIB}}\n".to_vec()),
            (1, "tex/latex/mdraftpkg/mdraftpkg.sty", b"\\ProvidesPackage{mdraftpkg}\\typeout{RESULT-PKG: r1}\n".to_vec()),
            (1, "tex/latex/x/mdraftronly.sty", b"\\ProvidesPackage{mdraftronly}\\typeout{RESULT-RONLY: r1}\n".to_vec()),
        ];
        let borrowed: Vec<(usize, &str, &[u8])> = files
            .iter()
            .map(|(r, p, d)| (*r, *p, d.as_slice()))
            .collect();
        (library_snapshot(&borrowed, 2), "main.tex")
    }

    fn assert_library_markers(log: &str, engine: &str) {
        let expect = [
            ("RESULT-PKG: r0", "root 0 wins over root 1"),
            ("RESULT-RONLY: r1", "a root-1-only package resolves"),
            ("RESULT-DEF: r0", "an optional internal file resolves"),
            ("RESULT-OVER: project", "the project wins over every root"),
        ];
        for (marker, why) in expect {
            assert!(
                log.contains(marker),
                "{engine}: {why} ({marker} missing)\n{}",
                &log[log.len().saturating_sub(3000)..]
            );
        }
        let dup = if engine == "lualatex" {
            "RESULT-DUP: lualatex"
        } else {
            "RESULT-DUP: latex"
        };
        assert!(
            log.contains(dup),
            "{engine}: format-specific copy ({dup} missing)"
        );
        assert!(!log.contains("RESULT-DUP: context"));
    }

    #[test]
    #[ignore = "requires MDRAFT_TEST_TEX_BIN to name a real TeX binary directory"]
    fn a_real_distribution_resolves_staged_libraries() {
        let bin = PathBuf::from(std::env::var("MDRAFT_TEST_TEX_BIN").unwrap());
        let name = distribution_name(&bin.display().to_string());
        let target = Target::Path {
            bin: bin.clone(),
            name,
        };
        // A comma, a space and a non-ASCII letter in the job path: search paths
        // are relative, so none of it reaches a search-path expression.
        let job = std::env::temp_dir().join(format!("mdraft-texmf, real ü-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&job);
        let (snapshot, main) = library_fixture(&job);
        let roots = stage_texmf(&job.join("texmf"), Some(&snapshot)).unwrap();
        let work = job.join("project");
        for engine in ["lualatex", "pdflatex", "xelatex"] {
            if !target.has_engine(engine) {
                eprintln!("{engine}: not installed (not run)");
                continue;
            }
            let env = target.environment(&job, &work, engine, roots).unwrap();
            let run = |program: &str, args: Vec<OsString>| {
                runner::run(
                    &target
                        .spec(program, args, &work, &env, Duration::from_secs(600))
                        .unwrap(),
                    &AtomicBool::new(false),
                )
                .unwrap()
            };
            run(engine, engine_arguments(engine, main));
            run("bibtex", vec!["main".into()]);
            let outcome = run(engine, engine_arguments(engine, main));
            let log = read_log(&work, "main");
            assert_library_markers(&log, engine);
            let bbl = std::fs::read_to_string(work.join("main.bbl")).unwrap_or_default();
            assert!(
                bbl.contains("RESULTBIB"),
                "{engine}: the private .bst/.bib reached BibTeX"
            );
            assert!(
                find_output(&work, "main", "pdf").is_some_and(|pdf| pdf.starts_with(b"%PDF-")),
                "{engine}: {}",
                outcome.console
            );
            eprintln!("{engine}: library resolution verified");
        }
        let _ = std::fs::remove_dir_all(job);
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "requires MDRAFT_TEST_WSL_DISTRO (and optionally MDRAFT_TEST_WSL_BIN)"]
    fn a_wsl_distribution_resolves_staged_libraries_and_cancels() {
        let distro = std::env::var("MDRAFT_TEST_WSL_DISTRO").unwrap();
        let bin = std::env::var("MDRAFT_TEST_WSL_BIN").unwrap_or_else(|_| "/usr/bin".into());
        let selected = wsl::WslInstallation {
            distro: distro.clone(),
            bin: bin.clone(),
            engines: vec!["lualatex".into(), "pdflatex".into()],
            tools: vec!["bibtex".into()],
        };
        let target = Target::Wsl(selected);
        let job = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target/test-tmp")
            .join(format!("wsl, job ü-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&job);
        let (snapshot, main) = library_fixture(&job);
        let roots = stage_texmf(&job.join("texmf"), Some(&snapshot)).unwrap();
        let work = job.join("project");
        for engine in ["lualatex", "pdflatex"] {
            let env = target.environment(&job, &work, engine, roots).unwrap();
            let run = |program: &str, args: Vec<OsString>| {
                runner::run(
                    &target
                        .spec(program, args, &work, &env, Duration::from_secs(600))
                        .unwrap(),
                    &AtomicBool::new(false),
                )
                .unwrap()
            };
            run(engine, engine_arguments(engine, main));
            run("bibtex", vec!["main".into()]);
            run(engine, engine_arguments(engine, main));
            assert_library_markers(&read_log(&work, "main"), engine);
            let bbl = std::fs::read_to_string(work.join("main.bbl")).unwrap_or_default();
            assert!(
                bbl.contains("RESULTBIB"),
                "{engine}: BibTeX through the launcher"
            );
        }
        // Cancel ends the Linux process tree, not only wsl.exe.
        std::fs::write(work.join("spin.tex"), "\\def\\spin{\\spin}\\spin\n").unwrap();
        let env = target.environment(&job, &work, "pdflatex", roots).unwrap();
        let cancel = std::sync::Arc::new(AtomicBool::new(false));
        let signal = cancel.clone();
        let canceller = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs(4));
            signal.store(true, Ordering::SeqCst);
        });
        let started = Instant::now();
        let outcome = runner::run(
            &target
                .spec(
                    "pdflatex",
                    engine_arguments("pdflatex", "spin.tex"),
                    &work,
                    &env,
                    Duration::from_secs(600),
                )
                .unwrap(),
            &cancel,
        )
        .unwrap();
        canceller.join().unwrap();
        assert!(outcome.cancelled && started.elapsed() < Duration::from_secs(30));
        std::thread::sleep(Duration::from_secs(2));
        let survivors = runner::run(
            &wsl::spec(
                &distro,
                &work,
                vec!["/usr/bin/pgrep".into(), "-f".into(), "spin.tex".into()],
                Duration::from_secs(60),
            )
            .unwrap(),
            &AtomicBool::new(false),
        )
        .unwrap();
        assert_ne!(
            survivors.status, 0,
            "an engine survived Cancel: {}",
            survivors.console
        );
        let _ = std::fs::remove_dir_all(job);
    }
}
