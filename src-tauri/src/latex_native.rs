//! Installed TeX distributions: discovery, validation and direct builds.
//!
//! The bundled preview stays the default. This module serves a reader who
//! explicitly chose an installation already on the computer: it finds one,
//! compiles a probe with it, and only then offers the switch. Every real job
//! stages the project into an app-owned directory, runs the engine as a
//! controllable process tree, and maps the compiler's log back to the snapshot —
//! never to the reader's disk.

mod discovery;
mod inplace;
pub mod log;
mod runner;
pub mod wsl;

use std::collections::{BTreeMap, BTreeSet};
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

/// A library file, which is staged from the request.
const MAX_FILE: usize = 32 * 1024 * 1024;
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
    /// TeXpresso's engine and digest table are present.
    pub texpresso_installed: bool,
    /// PhiTeX's engine and digest table are present.
    pub phitex_installed: bool,
    /// Either preview engine is present.
    pub preview_installed: bool,
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
    /// The main file's folder, where TeX runs. `files` are the editor's
    /// state; whatever else the document reads, TeX reads from the folder.
    #[serde(default)]
    root: Option<String>,
    /// Captured local libraries, staged beside the project, never inside it.
    #[serde(default)]
    texmf: Option<crate::latex_texmf::TexmfSnapshot>,
    /// Recompile from scratch: discard this project's session workspace first.
    /// Additive with a default, so an older frontend stays valid.
    #[serde(default)]
    clean: bool,
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
    /// The project files the build read, relative to the folder and spelled
    /// as on disk: what a change to should recompile the preview.
    pub inputs: Vec<String>,
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
    let root = crate::latex::directory(&app).ok();
    let texpresso_installed = root
        .as_deref()
        .is_some_and(crate::latex_texpresso::available);
    let phitex_installed = root.as_deref().is_some_and(crate::latex_phitex::available);
    let preview_installed = texpresso_installed || phitex_installed;
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
        texpresso_installed,
        phitex_installed,
        preview_installed,
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
    let _ = base_environment(Path::new(bin), &job.path, "TeX Live");
    let linux = wsl::linux_path(distro, &job.path, &work)?;
    let env = wsl_environment(bin, &linux);
    let probe = |program: &str| -> Result<Option<String>, String> {
        let outcome = runner::run(
            &wsl::engine_spec(
                distro,
                &work,
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
            &work,
            &env,
            &format!("{bin}/{preferred}"),
            &engine_arguments(&preferred, None, "mdraft-probe.tex"),
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
    let env = base_environment(&bin, &job.path, &name);
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
    let args = engine_arguments(&preferred, None, "mdraft-probe.tex");
    let cancel = AtomicBool::new(false);
    let outcome = runner::run(
        &runner::RunSpec {
            program: engine,
            args,
            cwd: temp.clone(),
            scratch: temp.clone(),
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
            scratch: cwd.to_path_buf(),
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

/// Load this workspace's staging record, resetting it when it belongs to another
/// project/engine or an older layout. A reset loses the warm caches and any
/// auxiliary files, which is the correct response to an unreadable state.
fn load_workspace(workspace: &Path, root: &Path, main_file: &str, engine: &str) -> WorkspaceState {
    let path = workspace.join("workspace.json");
    if let Ok(text) = std::fs::read_to_string(&path)
        && let Ok(state) = serde_json::from_str::<WorkspaceState>(&text)
        && state.version == WORKSPACE_VERSION
        && state.root == root.to_string_lossy().as_ref()
        && state.main_file == main_file
        && state.engine == engine
    {
        return state;
    }
    let empty = std::fs::read_dir(workspace)
        .map(|mut entries| entries.next().is_none())
        .unwrap_or(false);
    if !empty {
        let _ = std::fs::remove_dir_all(workspace);
        let _ = std::fs::create_dir_all(workspace);
    }
    WorkspaceState::new(root, main_file, engine)
}

fn save_workspace(workspace: &Path, state: &WorkspaceState) -> Result<(), String> {
    let text = serde_json::to_string_pretty(state)
        .map_err(|error| format!("Cannot write the LaTeX workspace record: {error}"))?;
    std::fs::write(workspace.join("workspace.json"), text)
        .map_err(|error| format!("Cannot write the LaTeX workspace record: {error}"))
}

/// A stable, path-safe name for one project/engine workspace.
fn workspace_key(root: &Path, main_file: &str, engine: &str) -> String {
    let material = format!(
        "{}\0{}\0{}",
        root.display(),
        main_file.replace('\\', "/"),
        engine
    );
    crate::latex::digest(material.as_bytes())
}

/// The main file's magic comment, from the bytes the frontend sent, before any
/// staging exists. The engine decides the workspace key, so it must be selected
/// first; a non-UTF-8 main file falls back to Auto exactly as the file reader
/// would.
fn request_main_text(request: &NativeCompileRequest) -> Option<String> {
    let main = request.main_file.replace('\\', "/");
    let file = request
        .files
        .iter()
        .find(|file| file.path.replace('\\', "/") == main)?;
    let bytes = STANDARD.decode(&file.data).ok()?;
    String::from_utf8(bytes).ok()
}

/// Keep the session's workspace count and size bounded. It runs only when a
/// workspace is first created, so the walk is not on the typing path.
fn prune_workspaces(root: &Path, keep: &Path) {
    const SESSION_LIMIT: u64 = 1024 * 1024 * 1024;
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    let mut others: Vec<(std::time::SystemTime, PathBuf, u64)> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path == keep || !path.is_dir() {
            continue;
        }
        others.push((
            workspace_last_used(&path),
            path.clone(),
            directory_size(&path),
        ));
    }
    others.sort_by_key(|(last, _, _)| *last);
    let mut total: u64 = others.iter().map(|(_, _, size)| *size).sum();
    while others.len() > 3 || (total > SESSION_LIMIT && !others.is_empty()) {
        let (_, path, size) = others.remove(0);
        if std::fs::remove_dir_all(&path).is_ok() {
            total = total.saturating_sub(size);
        }
    }
}

fn workspace_last_used(path: &Path) -> std::time::SystemTime {
    std::fs::metadata(path.join("workspace.json"))
        .or_else(|_| std::fs::metadata(path))
        .and_then(|metadata| metadata.modified())
        .unwrap_or(std::time::UNIX_EPOCH)
}

fn directory_size(path: &Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(path) else {
        return 0;
    };
    let mut total = 0u64;
    for entry in entries.flatten() {
        let Ok(metadata) = std::fs::symlink_metadata(entry.path()) else {
            continue;
        };
        if metadata.is_dir() {
            total = total.saturating_add(directory_size(&entry.path()));
        } else if metadata.is_file() {
            total = total.saturating_add(metadata.len());
        }
    }
    total
}

/// Remove generated auxiliary files from the outputs after a failed build.
/// The caches and `tmp/` (the Biber extraction) live beside the outputs and
/// stay.
fn remove_auxiliary(work: &Path) {
    const EXTENSIONS: &[&str] = &[
        "aux", "toc", "lof", "lot", "out", "bbl", "blg", "bcf", "idx", "ind", "ilg", "nav", "snm",
        "vrb", "log",
    ];
    let mut pending = vec![work.to_path_buf()];
    while let Some(dir) = pending.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(metadata) = std::fs::symlink_metadata(&path) else {
                continue;
            };
            if metadata.is_dir() {
                pending.push(path);
            } else if metadata.is_file() {
                let name = path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("");
                let generated = name.ends_with(".run.xml")
                    || path
                        .extension()
                        .and_then(|extension| extension.to_str())
                        .is_some_and(|extension| EXTENSIONS.contains(&extension));
                if generated {
                    let _ = std::fs::remove_file(&path);
                }
            }
        }
    }
}

/// Delete every session workspace. Startup and the app exit call this; a
/// workspace is never reused across app sessions.
/// The generated files whose content says whether another LaTeX pass is
/// needed. `.bcf` is a bibliography input, not a page-layout output, so it is
/// handled by the bibliography decision; `.log`, `.pdf` and `.blg` are not
/// signals.
const AUXILIARY_EXTENSIONS: &[&str] = &[
    "aux", "toc", "lof", "lot", "out", "bbl", "idx", "ind", "nav", "snm", "vrb",
];

fn auxiliary_signature(work: &Path) -> String {
    let mut entries = BTreeMap::new();
    collect_auxiliary(work, work, &mut entries);
    let material = entries
        .iter()
        .map(|(path, digest)| format!("{path}\0{digest}\n"))
        .collect::<String>();
    crate::latex::digest(material.as_bytes())
}

fn collect_auxiliary(root: &Path, dir: &Path, out: &mut BTreeMap<String, String>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(metadata) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        if metadata.is_dir() {
            collect_auxiliary(root, &path, out);
        } else if metadata.is_file()
            && path
                .extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(|extension| AUXILIARY_EXTENSIONS.contains(&extension))
        {
            let relative = path
                .strip_prefix(root)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");
            out.insert(relative, file_digest(&path));
        }
    }
}

fn file_digest(path: &Path) -> String {
    std::fs::read(path)
        .map(|bytes| crate::latex::digest(&bytes))
        .unwrap_or_default()
}

/// The citation/bibliography control lines of every BibTeX `.aux` (a chapter
/// `.aux` carries its own citations), without the label and page-number lines
/// that change on ordinary edits.
fn aux_control(work: &Path) -> String {
    let mut entries = BTreeMap::new();
    collect_aux_control(work, work, &mut entries);
    let material = entries
        .iter()
        .map(|(path, control)| format!("{path}\0{control}\n"))
        .collect::<String>();
    crate::latex::digest(material.as_bytes())
}

fn collect_aux_control(root: &Path, dir: &Path, out: &mut BTreeMap<String, String>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(metadata) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        if metadata.is_dir() {
            collect_aux_control(root, &path, out);
        } else if metadata.is_file()
            && path
                .extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(|extension| extension.eq_ignore_ascii_case("aux"))
        {
            let text = std::fs::read_to_string(&path).unwrap_or_default();
            let mut control = String::new();
            for line in text.lines() {
                let trimmed = line.trim_start();
                if trimmed.starts_with("\\citation{")
                    || trimmed.starts_with("\\bibdata{")
                    || trimmed.starts_with("\\bibstyle{")
                {
                    control.push_str(trimmed);
                    control.push('\n');
                }
            }
            let relative = path
                .strip_prefix(root)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");
            out.insert(relative, crate::latex::digest(control.as_bytes()));
        }
    }
}

/// Which bibliography tool, if any, this pass needs. The `.bbl` is the
/// authority: re-running a tool cannot fix keys that are absent from the
/// `.bib`, so an unchanged `.bcf`/`.bib` is trusted instead of a persistent
/// log warning.
fn decide_bibliography(
    work: &Path,
    stem: &str,
    bcf_before: &str,
    bcf_after: &str,
    control_before: &str,
    control_after: &str,
    bib_changed: bool,
) -> Bibliography {
    let has_bbl = work.join(format!("{stem}.bbl")).is_file();
    if work.join(format!("{stem}.bcf")).is_file() {
        if !has_bbl || bcf_before != bcf_after || bib_changed {
            return Bibliography::Biber;
        }
        return Bibliography::None;
    }
    if !control_after.is_empty() && (!has_bbl || control_before != control_after || bib_changed) {
        return Bibliography::Bibtex;
    }
    Bibliography::None
}
pub fn cleanup_session(app: &AppHandle) {
    runner::cleanup_workspaces(app);
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
    let (token, registration) = register(&request.job)?;

    let main_text = request_main_text(&request);
    let engine = select_engine_text(
        &settings.latex_native_engine,
        &|engine| target.has_engine(engine),
        main_text.as_deref(),
        settings.latex_native_prefers_xelatex,
    )?;
    let identity = target.engine_identity(&engine);
    let folder = match request.root.as_deref() {
        Some(root) => Some(std::fs::canonicalize(root).map_err(|error| {
            format!(
                "Cannot read the folder of the main LaTeX file {}: {error}",
                Path::new(root).display()
            )
        })?),
        None => None,
    };
    if let (Target::Wsl(selected), Some(root)) = (&target, folder.as_deref())
        && inplace::is_network(root)
    {
        return Err(format!(
            "{} is on a network share, and {} runs TeX in the document's own folder, which \
             WSL cannot do there. Compile it with a Windows TeX distribution or the bundled \
             engine, or move the folder to a local drive.",
            inplace::plain(root).display(),
            wsl_distribution_name(&selected.distro)
        ));
    }
    // A request without a folder (the direct command and its integration test)
    // keeps a fresh directory per job and nothing is reused. The shipped
    // frontend always sends the folder.
    let _temporary_job: Option<runner::JobDir>;
    let workspace_path: PathBuf;
    let workspace_created: bool;
    match &folder {
        Some(root) => {
            let key = workspace_key(root, &request.main_file, &identity);
            if request.clean {
                // Recompile from scratch: remove the workspace before anything
                // reads its .aux, .bbl or caches.
                let existing = runner::workspace_dir(app, &key)?;
                let _ = std::fs::remove_dir_all(&existing.path);
            }
            let workspace = runner::workspace_dir(app, &key)?;
            workspace_created = workspace.created;
            workspace_path = workspace.path;
            _temporary_job = None;
        }
        None => {
            let job = runner::job_dir(app, &request.job)?;
            workspace_path = job.path.clone();
            workspace_created = true;
            _temporary_job = Some(job);
        }
    }
    if workspace_created
        && folder.is_some()
        && let Ok(session_root) = runner::workspace_root(app)
    {
        prune_workspaces(&session_root, &workspace_path);
    }
    let progress = |phase: &str, detail: Option<&str>| emit(app, &request.job, phase, detail);
    let mut result = build(Build {
        target: &target,
        engine: &engine,
        identity: &identity,
        workspace: &workspace_path,
        folder: folder.as_deref(),
        request: &request,
        cancel: &token,
        progress: &progress,
    })?;
    drop(registration);
    result.elapsed_ms = started.elapsed().as_millis() as u64;
    Ok(result)
}

/// One build in a workspace `compile` chose. It needs no app, so the
/// real-distribution tests run exactly this.
struct Build<'a> {
    target: &'a Target,
    engine: &'a str,
    /// What the workspace record is checked against (`engine_identity`).
    identity: &'a str,
    workspace: &'a Path,
    /// The main file's canonical folder, where TeX runs; None when the
    /// request carries the whole project.
    folder: Option<&'a Path>,
    request: &'a NativeCompileRequest,
    cancel: &'a AtomicBool,
    progress: &'a dyn Fn(&str, Option<&str>),
}

fn build(job: Build<'_>) -> Result<NativeCompileResult, String> {
    let started = Instant::now();
    let Build {
        target,
        engine,
        identity,
        workspace,
        folder,
        request,
        cancel: token,
        progress,
    } = job;
    let main_file = request.main_file.replace('\\', "/");
    let source = workspace.join("source");
    // The record is checked first: a stale workspace is emptied before
    // anything is written into it.
    let mut workspace_state =
        load_workspace(workspace, folder.unwrap_or(&source), &main_file, identity);
    let root = match folder {
        Some(root) => root.to_path_buf(),
        None => materialize(&source, &request.files)?,
    };
    let out = workspace.join("out");
    let overlay = workspace.join("overlay");
    std::fs::create_dir_all(&out)
        .map_err(|error| format!("Cannot create the LaTeX output folder: {error}"))?;
    let prepared = inplace::prepare(
        &root,
        &overlay,
        &out,
        &main_file,
        &request.files,
        &mut workspace_state.bibliography,
    )?;
    let roots = stage_texmf(
        &workspace.join("texmf"),
        request.texmf.as_ref(),
        &mut workspace_state,
    )?;
    // A changed bibliography input forces the tool even when the citation
    // controls did not change.
    let bib_digest = bibliography_digest(&root, &prepared, &workspace_state.bibliography_reads);
    let bib_changed = workspace_state.bibliography_digest.as_deref() != Some(bib_digest.as_str());
    workspace_state.bibliography_digest = Some(bib_digest);
    save_workspace(workspace, &workspace_state)?;
    if matches!(target, Target::Wsl(_)) {
        progress("starting-wsl", None);
    }
    let paths = target.paths(workspace, &root, roots, !prepared.overlaid.is_empty())?;
    let env = target.environment(workspace, &paths, engine);
    let cwd = inplace::plain(&root);
    let main_name = prepared.main.clone();
    let file_name = main_name.rsplit('/').next().unwrap_or(&main_name);
    let stem = file_name
        .strip_suffix(".tex")
        .unwrap_or(file_name)
        .to_string();
    // `\include{chapters/one}` writes `chapters/one.aux` below the outputs,
    // and TeX Live does not create the folder (MiKTeX does).
    inplace::output_dirs(&out, prepared.carried.iter());
    let mut aux_before = auxiliary_signature(&out);
    // What this build read is stamped against its start: a file changed
    // while TeX ran is recorded unsettled, and the next build reads it again.
    let build_start = std::time::SystemTime::now();
    let mut sources = prepared.sources.clone();
    let mut inputs: BTreeSet<String> = BTreeSet::new();
    let mut from_folder: BTreeSet<String> = BTreeSet::new();

    let mut logs: Vec<String> = Vec::new();
    let mut passes = 0u32;
    let mut retries = 0u32;
    let mut bibliography_run = Bibliography::None;
    let mut missing_tool: Option<String> = None;
    let mut outcome = runner::RunOutcome::default();
    let mut cancelled = false;
    let mut timed_out = false;
    let mut last_log = String::new();
    let mut force_rerun = false;
    loop {
        if passes >= 3 + retries {
            break;
        }
        // A Cancel that arrived before registration, or between passes, stops
        // here rather than after one more engine process.
        if token.load(Ordering::SeqCst) {
            cancelled = true;
            break;
        }
        // The previous pass's bibliography state, before this pass rewrites it.
        let bcf_before = file_digest(&out.join(format!("{stem}.bcf")));
        let control_before = aux_control(&out);
        passes += 1;
        progress("compiling", Some(engine));
        let args = engine_arguments(engine, Some(&paths.out), &main_name);
        outcome = runner::run(
            &target.spec(engine, args, &cwd, &out, &env, COMPILE_TIMEOUT)?,
            token,
        )?;
        if token.load(Ordering::SeqCst) || outcome.cancelled {
            cancelled = true;
        }
        if outcome.timed_out {
            timed_out = true;
        }
        let log = read_log(&out, &stem);
        last_log = log.clone();
        if !log.is_empty() {
            logs.push(log.clone());
        }
        let recorded = std::fs::read_to_string(out.join(format!("{stem}.fls"))).unwrap_or_default();
        for input in inplace::recorded_inputs(&recorded, &paths.engine) {
            if input.to_ascii_lowercase().ends_with(".tex") {
                sources.entry(input.clone()).or_default();
            }
            inputs.insert(input);
        }
        from_folder.extend(inplace::read_from_folder(&recorded, &paths.engine));
        if cancelled || timed_out {
            break;
        }
        // An `\include` whose folder the carried names did not show (a name
        // built by a macro) needs its output folder too: create it and run the
        // pass again.
        let unwritable: Vec<String> = inplace::unwritable(&log)
            .into_iter()
            .filter(|name| {
                name.rsplit_once('/')
                    .is_some_and(|(dir, _)| !out.join(dir).is_dir())
            })
            .collect();
        if !unwritable.is_empty() && retries < 2 {
            retries += 1;
            inplace::output_dirs(&out, unwritable.iter());
            remove_auxiliary(&out);
            aux_before = auxiliary_signature(&out);
            continue;
        }
        let parsed = log::parse(&log, &sources);
        let bcf_after = file_digest(&out.join(format!("{stem}.bcf")));
        let control_after = aux_control(&out);
        let bibliography = decide_bibliography(
            &out,
            &stem,
            &bcf_before,
            &bcf_after,
            &control_before,
            &control_after,
            bib_changed,
        );
        if bibliography != Bibliography::None && bibliography_run == Bibliography::None {
            let tool = match bibliography {
                Bibliography::Bibtex => "bibtex",
                Bibliography::Biber => "biber",
                Bibliography::None => "",
            };
            if target.has_tool(tool) {
                bibliography_run = bibliography;
                progress("bibliography", Some(tool));
                // The tool runs beside the outputs, where every `.aux` is and
                // the declared `.bib`/`.bst` files were written. The folder is
                // on its search path for the rest.
                let mut args = Vec::new();
                if tool == "bibtex" && target.family() == Family::Miktex {
                    let mut include = OsString::from("-include-directory=");
                    include.push(cwd.as_os_str());
                    args.push(include);
                }
                args.push(OsString::from(stem.clone()));
                let bbl_before = file_digest(&out.join(format!("{stem}.bbl")));
                let helper = runner::run(
                    &target.spec(tool, args, &out, &out, &env, PROBE_TIMEOUT * 3)?,
                    token,
                )?;
                if !helper.console.trim().is_empty() {
                    logs.push(helper.console);
                }
                let blg =
                    std::fs::read_to_string(out.join(format!("{stem}.blg"))).unwrap_or_default();
                workspace_state.bibliography_reads =
                    inplace::bibliography_inputs(&inplace::bibliography_reads(&blg), &paths.engine);
                // Only a changed .bbl requires another LaTeX pass. A tool run
                // that produced identical output does not.
                let bbl_after = file_digest(&out.join(format!("{stem}.bbl")));
                if bbl_before != bbl_after {
                    force_rerun = true;
                }
            } else {
                missing_tool = Some(format!(
                    "This document needs {tool}, but it is not part of the selected installation. Install it with the distribution\x27s own tools, then compile again."
                ));
            }
        }
        let aux_after = auxiliary_signature(&out);
        let aux_changed = aux_before != aux_after;
        aux_before = aux_after;
        if (!parsed.rerun && !aux_changed && !force_rerun) || outcome.status != 0 {
            break;
        }
        force_rerun = false;
    }

    let read = record_build_reads(
        folder,
        &prepared,
        &inputs,
        &workspace_state.bibliography_reads,
        build_start,
    );
    let _ = save_workspace(workspace, &workspace_state);

    let pdf = find_output(&out, &stem, "pdf");
    let parsed = log::parse(&last_log, &sources);
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
    diagnostics.extend(unsaved_diagnostics(&prepared, &from_folder));
    let warnings_truncated = parsed.truncated
        && parsed
            .diagnostics
            .iter()
            .any(|entry| entry.severity == Severity::Warning);
    if !success {
        // A failed or cancelled pass can leave a half-written .aux/.bcf. Keep
        // the caches and tmp/ (the Biber extraction), but let the next build
        // start from clean outputs.
        remove_auxiliary(&out);
    }
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
        engine: engine.to_string(),
        distribution: target.distribution(),
        passes,
        log: log_text.0,
        log_truncated: log_text.1,
        diagnostics,
        warnings_truncated,
        error,
        elapsed_ms: started.elapsed().as_millis() as u64,
        inputs: read.into_iter().collect(),
    })
}

/// Warnings for unsaved buffers TeX did not compile: one named `./x` (found
/// before the build, with its line), and any other the recorder shows was read
/// from the folder instead of the overlay.
fn unsaved_diagnostics(
    prepared: &inplace::Prepared,
    from_folder: &BTreeSet<String>,
) -> Vec<NativeDiagnostic> {
    let mut diagnostics: Vec<NativeDiagnostic> = prepared
        .warnings
        .iter()
        .map(|warning| NativeDiagnostic {
            file: warning.source.clone(),
            line: warning.line,
            severity: "warning".into(),
            message: warning.message.clone(),
            code: "unsaved-not-compiled".into(),
        })
        .collect();
    for name in prepared.overlaid.intersection(from_folder) {
        if prepared
            .warnings
            .iter()
            .any(|warning| &warning.file == name)
        {
            continue;
        }
        diagnostics.push(NativeDiagnostic {
            file: name.clone(),
            line: 0,
            severity: "warning".into(),
            message: format!(
                "{name} has unsaved changes, but TeX read the saved file from the folder. \
                 Save it to compile the changes."
            ),
            code: "unsaved-not-compiled".into(),
        });
    }
    diagnostics
}

/// Write a request's files into a private folder, for a request that names
/// no folder of its own, and return its canonical path.
fn materialize(source: &Path, files: &[NativeFile]) -> Result<PathBuf, String> {
    let _ = std::fs::remove_dir_all(source);
    std::fs::create_dir_all(source).map_err(|error| error.to_string())?;
    for file in files {
        let relative = inplace::safe_relative(&file.path)?;
        let bytes = STANDARD
            .decode(&file.data)
            .map_err(|_| format!("{} is not valid project data.", file.path))?;
        let target = source.join(&relative);
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        std::fs::write(&target, bytes)
            .map_err(|error| format!("Cannot write {}: {error}", file.path))?;
    }
    std::fs::canonicalize(source).map_err(|error| error.to_string())
}

/// The bibliography inputs this build would hand the tool: the declared ones
/// by content, the others the tool reported reading by stamp.
fn bibliography_digest(root: &Path, prepared: &inplace::Prepared, reads: &[String]) -> String {
    let mut material = prepared.bibliography.clone();
    for read in reads {
        if prepared.carried.contains(read) {
            continue;
        }
        material.push('\n');
        material.push_str(read);
        material.push('\0');
        material.push_str(&crate::latex::current_stamp(
            root,
            read,
            crate::latex::file_stamp,
        ));
    }
    crate::latex::digest(material.as_bytes())
}

/// The project files this build read, by their names on disk, recorded with
/// the folder's dependencies so the next snapshot can tell whether the PDF is
/// still current.
///
/// A carried file is left out of the record: its bytes are in the preview's
/// key already, and a just-saved buffer would otherwise invalidate the PDF it
/// was compiled into. Every folder a read came from is recorded too, so a
/// file added there (a `.sty` that now shadows the distribution's, a figure
/// in a format TeX prefers) makes the next build run.
fn record_build_reads(
    folder: Option<&Path>,
    prepared: &inplace::Prepared,
    inputs: &BTreeSet<String>,
    bibliography_reads: &[String],
    build_start: std::time::SystemTime,
) -> BTreeSet<String> {
    let mut read: BTreeSet<String> = BTreeSet::new();
    read.insert(prepared.main.clone());
    read.extend(prepared.overlaid.iter().cloned());
    let Some(root) = folder else {
        return read;
    };
    for name in inputs.iter().chain(bibliography_reads) {
        if let Some(disk) = inplace::on_disk(root, name) {
            read.insert(disk);
        }
    }
    let mut dirs = BTreeSet::new();
    for name in &read {
        dirs.insert(name.rsplit_once('/').map_or("", |(dir, _)| dir).to_string());
        if prepared.carried.contains(name) {
            continue;
        }
        let stamp = crate::latex::current_stamp(root, name, |metadata| {
            crate::latex::settled_stamp(metadata, build_start)
        });
        crate::latex::record_file_read(root, name, stamp);
    }
    for dir in dirs {
        let (_, digest) = crate::latex::list_project_dir(root, &dir);
        crate::latex::record_dir_read(root, &dir, digest);
    }
    read
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

/// Bump when the workspace record or layout changes; an older record is
/// discarded with its workspace. 2: TeX compiles in the folder itself, and
/// the workspace holds the outputs and the overlay, never a project copy.
const WORKSPACE_VERSION: u32 = 2;

#[derive(Serialize, Deserialize)]
struct WorkspaceState {
    version: u32,
    root: String,
    main_file: String,
    engine: String,
    texmf_revision: Option<String>,
    /// Declared `.bib`/`.bst` files written beside the outputs, by digest.
    #[serde(default)]
    bibliography: BTreeMap<String, String>,
    /// What the bibliography inputs were at the last build.
    #[serde(default)]
    bibliography_digest: Option<String>,
    /// Project files the bibliography tool reported reading (its `.blg`).
    #[serde(default)]
    bibliography_reads: Vec<String>,
}

impl WorkspaceState {
    fn new(root: &Path, main_file: &str, engine: &str) -> Self {
        WorkspaceState {
            version: WORKSPACE_VERSION,
            root: root.to_string_lossy().into_owned(),
            main_file: main_file.to_string(),
            engine: engine.to_string(),
            texmf_revision: None,
            bibliography: BTreeMap::new(),
            bibliography_digest: None,
            bibliography_reads: Vec::new(),
        }
    }
}

#[cfg(test)]
fn select_engine(requested: &str, bin: &Path, _work: &Path, main: &Path) -> Result<String, String> {
    select_engine_with(requested, &|engine| has_engine(bin, engine), main, false)
}

#[cfg(test)]
fn select_engine_with(
    requested: &str,
    has: &dyn Fn(&str) -> bool,
    main: &Path,
    prefer_xelatex: bool,
) -> Result<String, String> {
    let text = std::fs::read_to_string(main).ok();
    select_engine_text(requested, has, text.as_deref(), prefer_xelatex)
}

/// The engine selection shared by the file reader (tests and probes) and the
/// workspace path, which has the main file's bytes before staging exists.
///
/// Without a usable magic comment, auto takes the first installed engine:
/// XeLaTeX first when `prefer_xelatex` (a new install), else [`ENGINES`] order.
fn select_engine_text(
    requested: &str,
    has: &dyn Fn(&str) -> bool,
    text: Option<&str>,
    prefer_xelatex: bool,
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
    if let Some(text) = text {
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
    if prefer_xelatex && has("xelatex") {
        return Ok("xelatex".into());
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

    /// What makes a build workspace specific to one engine binary. A
    /// distribution update changes the stamp, so an old format/aux state is not
    /// reused silently.
    fn engine_identity(&self, engine: &str) -> String {
        match self {
            Target::Path { bin, .. } => {
                let path = engine_path(bin, engine);
                let stamp = std::fs::metadata(&path)
                    .map(|metadata| crate::latex::file_stamp(&metadata))
                    .unwrap_or_default();
                format!("path:{}:{}:{stamp}", bin.display(), engine)
            }
            Target::Wsl(selected) => {
                format!("wsl:{}:{}:{engine}", selected.distro, selected.bin)
            }
        }
    }

    /// One build's folders in the engine's own terms. A WSL build asks the
    /// distribution for their Linux forms, once per folder and app session.
    fn paths(
        &self,
        workspace: &Path,
        root: &Path,
        roots: usize,
        overlaid: bool,
    ) -> Result<BuildPaths, String> {
        let overlay = workspace.join("overlay");
        let out = workspace.join("out");
        match self {
            Target::Path { .. } => {
                let text = |path: &Path| inplace::plain(path).to_string_lossy().replace('\\', "/");
                let overlay_search = if overlaid {
                    Some(inplace::search_form(&overlay)?)
                } else {
                    None
                };
                Ok(BuildPaths {
                    state: inplace::plain(workspace).to_string_lossy().into_owned(),
                    out: inplace::plain(&out).to_string_lossy().into_owned(),
                    engine: inplace::EnginePaths {
                        root: text(root),
                        workspace: text(workspace),
                        overlay: overlay_search.clone().unwrap_or_else(|| text(&overlay)),
                        out: text(&out),
                        windows: cfg!(windows),
                    },
                    overlay: overlay_search,
                    libraries: (0..roots)
                        .map(|n| inplace::search_form(&workspace.join("texmf").join(n.to_string())))
                        .collect::<Result<_, _>>()?,
                    output: inplace::search_form(&out).ok(),
                    root: inplace::search_form(root).ok(),
                })
            }
            Target::Wsl(selected) => {
                let state = wsl_linux_path(&selected.distro, workspace, workspace)?;
                let folder = wsl_linux_path(&selected.distro, root, workspace)?;
                let overlay = format!("{state}/overlay");
                let out = format!("{state}/out");
                Ok(BuildPaths {
                    engine: inplace::EnginePaths {
                        root: folder.clone(),
                        workspace: state.clone(),
                        overlay: overlay.clone(),
                        out: out.clone(),
                        windows: false,
                    },
                    overlay: if overlaid {
                        Some(inplace::linux_search_form(&overlay)?)
                    } else {
                        None
                    },
                    libraries: (0..roots)
                        .map(|n| inplace::linux_search_form(&format!("{state}/texmf/{n}")))
                        .collect::<Result<_, _>>()?,
                    output: inplace::linux_search_form(&out).ok(),
                    root: inplace::linux_search_form(&folder).ok(),
                    out,
                    state,
                })
            }
        }
    }

    fn environment(
        &self,
        workspace: &Path,
        paths: &BuildPaths,
        engine: &str,
    ) -> Vec<(String, String)> {
        match self {
            Target::Path { bin, name } => {
                let mut env = base_environment(bin, workspace, name);
                let separator = if cfg!(windows) { ';' } else { ':' };
                for (key, value) in search_environment(self.family(), engine, paths, separator) {
                    set_env(&mut env, &key, value);
                }
                env
            }
            Target::Wsl(selected) => {
                // Creates the private directories on the Windows side.
                let _ = base_environment(Path::new(&selected.bin), workspace, "TeX Live");
                let mut env = wsl_environment(&selected.bin, &paths.state);
                for (key, value) in search_environment(Family::Kpathsea, engine, paths, ':') {
                    set_env(&mut env, &key, value);
                }
                env
            }
        }
    }

    fn spec(
        &self,
        program: &str,
        args: Vec<OsString>,
        work: &Path,
        scratch: &Path,
        env: &[(String, String)],
        timeout: Duration,
    ) -> Result<runner::RunSpec, String> {
        match self {
            Target::Path { bin, .. } => Ok(runner::RunSpec {
                program: engine_path(bin, program),
                args,
                cwd: work.to_path_buf(),
                scratch: scratch.to_path_buf(),
                env: env.to_vec(),
                timeout,
            }),
            Target::Wsl(selected) => {
                wsl_engine_spec(selected, work, scratch, env, program, &args, timeout)
            }
        }
    }
}

/// One build's folders as the engine names them.
struct BuildPaths {
    /// The workspace: HOME, the caches and the temporary files.
    state: String,
    /// The value of `-output-directory`.
    out: String,
    /// For reading what the engine recorded.
    engine: inplace::EnginePaths,
    /// Search-path elements, each checked by `search_form`: the overlay when
    /// a buffer differs from its file, the library roots, and the outputs and
    /// the folder when their names allow it.
    overlay: Option<String>,
    libraries: Vec<String>,
    output: Option<String>,
    root: Option<String>,
}

/// The exact Linux environment of a WSL job. `job` is the Linux form of the
/// workspace; everything writable stays inside it.
fn wsl_environment(bin: &str, job: &str) -> Vec<(String, String)> {
    vec![
        // Not the Windows PATH that WSL interop appends.
        ("PATH".to_string(), format!("{bin}:/usr/bin:/bin")),
        ("LANG".to_string(), "C.UTF-8".to_string()),
        ("LC_ALL".to_string(), "C.UTF-8".to_string()),
        ("HOME".to_string(), job.to_string()),
        ("TMPDIR".to_string(), format!("{job}/tmp")),
        ("TEXMFVAR".to_string(), format!("{job}/data")),
        ("TEXMFCONFIG".to_string(), format!("{job}/config")),
        ("TEXMFHOME".to_string(), format!("{job}/home")),
    ]
}

/// The search paths of one build. TeX's working directory is the document's
/// folder, so `.` is the project: the overlay comes before it, the libraries
/// after it and before the distribution. The bibliography tool runs beside
/// the outputs, where the declared `.bib`/`.bst` files were written, and finds
/// the rest in the folder.
///
/// Measured on TeX Live 2025 (Debian, in WSL) and MiKTeX 23.1: the libraries,
/// the overlay, the output folder and the recorder.
fn search_environment(
    family: Family,
    engine: &str,
    paths: &BuildPaths,
    separator: char,
) -> Vec<(String, String)> {
    let mut env: Vec<(String, String)> = Vec::new();
    let bibliography = |libraries: String| {
        let mut value = format!(".{separator}");
        if let Some(root) = &paths.root {
            value.push_str(root);
            value.push(separator);
        }
        value.push_str(&libraries);
        value
    };
    match family {
        Family::Kpathsea => {
            // TEXMFHOME is part of $TEXMF, so the distribution's own cnf supplies
            // format-aware TEXINPUTS.<fmt>, BSTINPUTS, LUAINPUTS and font paths.
            if !paths.libraries.is_empty() {
                env.push((
                    "TEXMFHOME".into(),
                    format!("{{{}}}", paths.libraries.join(",")),
                ));
            }
            // The empty element after the overlay is the distribution's own,
            // format-aware path, which starts with `.`.
            if let Some(overlay) = &paths.overlay {
                env.push(("TEXINPUTS".into(), format!("{overlay}{separator}")));
            }
            if let Some(output) = &paths.output {
                env.push(("TEXMFOUTPUT".into(), output.clone()));
            }
            env.push(("BIBINPUTS".into(), bibliography(String::new())));
            env.push(("BSTINPUTS".into(), bibliography(String::new())));
        }
        Family::Miktex => {
            let tex: &[&str] = match engine {
                "lualatex" => &["tex/lualatex", "tex/latex", "tex/luatex", "tex/generic"],
                "xelatex" => &["tex/xelatex", "tex/latex", "tex/xetex", "tex/generic"],
                _ => &["tex/latex", "tex/pdftex", "tex/generic"],
            };
            let libraries = |subdirs: &[&str]| -> String {
                let mut value = String::new();
                for root in &paths.libraries {
                    for dir in subdirs {
                        value.push_str(&format!("{root}/{dir}//;"));
                    }
                }
                value
            };
            // The `.` keeps the folder before the libraries: MiKTeX otherwise
            // searches these variables before the working directory.
            let over = |subdirs: &[&str]| format!(".;{}", libraries(subdirs));
            if paths.overlay.is_some() || !paths.libraries.is_empty() {
                let mut value = String::new();
                if let Some(overlay) = &paths.overlay {
                    value.push_str(overlay);
                    value.push(';');
                }
                value.push_str(&over(tex));
                env.push(("TEXINPUTS".into(), value));
            }
            env.push(("BIBINPUTS".into(), bibliography(libraries(&["bibtex/bib"]))));
            env.push(("BSTINPUTS".into(), bibliography(libraries(&["bibtex/bst"]))));
            if !paths.libraries.is_empty() {
                env.push((
                    "LUAINPUTS".into(),
                    over(&[
                        "scripts",
                        "tex/luatex",
                        "tex/lualatex",
                        "tex/latex",
                        "tex/generic",
                    ]),
                ));
                env.push(("OPENTYPEFONTS".into(), over(&["fonts/opentype"])));
                env.push(("TTFONTS".into(), over(&["fonts/truetype"])));
            }
        }
    }
    env
}

/// Write a validated library snapshot as job/texmf/<n>/<TDS path>.
fn stage_texmf(
    dir: &Path,
    snapshot: Option<&crate::latex_texmf::TexmfSnapshot>,
    state: &mut WorkspaceState,
) -> Result<usize, String> {
    let Some(snapshot) = snapshot else {
        state.texmf_revision = None;
        return Ok(0);
    };
    crate::latex_texmf::validate_snapshot(snapshot)?;
    let roots_ready = (0..snapshot.roots.len()).all(|index| dir.join(index.to_string()).is_dir());
    if state.texmf_revision.as_deref() == Some(snapshot.revision.as_str()) && roots_ready {
        return Ok(snapshot.roots.len());
    }
    if dir.exists() {
        std::fs::remove_dir_all(dir).map_err(|error| {
            format!(
                "Cannot replace the staged library folder {}: {error}",
                dir.display()
            )
        })?;
    }
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
    state.texmf_revision = Some(snapshot.revision.clone());
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

/// The Linux form of a Windows folder. The mapping changes only with the
/// distribution's mount configuration, and asking costs a launch, so each
/// answer is kept for the app session.
#[cfg(windows)]
fn wsl_linux_path(distro: &str, path: &Path, scratch: &Path) -> Result<String, String> {
    type Known = Mutex<BTreeMap<(String, PathBuf), String>>;
    static KNOWN: OnceLock<Known> = OnceLock::new();
    let path = inplace::plain(path);
    let key = (distro.to_string(), path.clone());
    let known = KNOWN.get_or_init(Default::default);
    if let Some(linux) = known.lock().ok().and_then(|map| map.get(&key).cloned()) {
        return Ok(linux);
    }
    let linux = wsl::linux_path(distro, &path, scratch)?;
    if let Ok(mut map) = known.lock() {
        if map.len() >= 256 {
            map.clear();
        }
        map.insert(key, linux.clone());
    }
    Ok(linux)
}

#[cfg(not(windows))]
fn wsl_linux_path(_distro: &str, _path: &Path, _scratch: &Path) -> Result<String, String> {
    Err("WSL is available only on Windows.".into())
}

#[cfg(windows)]
fn wsl_engine_spec(
    selected: &wsl::WslInstallation,
    work: &Path,
    scratch: &Path,
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
        scratch,
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
    _scratch: &Path,
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

fn base_environment(bin: &Path, state: &Path, distribution: &str) -> Vec<(String, String)> {
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
    // Build state lives at the workspace root, not inside the project copy: a
    // project may legitimately have a `tmp`, `cache` or `data` folder.
    let temp = state.join("tmp");
    let cache = state.join("cache");
    let config = state.join("config");
    let data = state.join("data");
    for directory in [&temp, &cache, &config, &data] {
        let _ = std::fs::create_dir_all(directory);
    }
    set_env(&mut env, "TEMP", temp.display().to_string());
    set_env(&mut env, "TMP", temp.display().to_string());
    set_env(&mut env, "TMPDIR", temp.display().to_string());
    set_env(&mut env, "HOME", state.display().to_string());
    set_env(&mut env, "TEXMFVAR", data.display().to_string());
    set_env(&mut env, "TEXMFCONFIG", config.display().to_string());
    set_env(
        &mut env,
        "TEXMFHOME",
        state.join("home").display().to_string(),
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
/// The engine's command line. \`out\` is the output folder of a build; the
/// installation probe compiles in its own scratch folder and passes None.
fn engine_arguments(_engine: &str, out: Option<&str>, main: &str) -> Vec<OsString> {
    // Shell escape stays off: a document is not allowed to run arbitrary
    // commands. Package installation is left to the distribution, so MiKTeX's
    // installer is not disabled. \`-recorder\` lists every file the engine
    // opened, which is what the build depends on.
    let mut args: Vec<OsString> = vec![
        "-recorder".into(),
        "-no-shell-escape".into(),
        "-file-line-error".into(),
        "-interaction=nonstopmode".into(),
    ];
    if let Some(out) = out {
        args.push(format!("-output-directory={out}").into());
    }
    args.push(main.into());
    args
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
    fn a_request_without_a_folder_is_written_privately() {
        let base = temp_case("materialize");
        let files = [NativeFile {
            path: "chapters/one.tex".into(),
            data: STANDARD.encode(b"one"),
        }];
        let root = materialize(&base.join("source"), &files).unwrap();
        assert_eq!(
            std::fs::read(root.join("chapters/one.tex")).unwrap(),
            b"one"
        );
        let escaping = [NativeFile {
            path: "../outside.tex".into(),
            data: STANDARD.encode(b"x"),
        }];
        assert!(materialize(&base.join("other"), &escaping).is_err());
        assert!(!base.join("outside.tex").exists());
        let _ = std::fs::remove_dir_all(base);
    }

    /// A request the way the frontend sends one: the folder, and the editor's
    /// state of the files the snapshot carries.
    fn native_request(
        root: &Path,
        main: &str,
        files: &[(&str, &[u8])],
        texmf: Option<crate::latex_texmf::TexmfSnapshot>,
    ) -> NativeCompileRequest {
        NativeCompileRequest {
            job: "test".into(),
            main_file: main.into(),
            files: files
                .iter()
                .map(|(path, data)| NativeFile {
                    path: (*path).into(),
                    data: STANDARD.encode(data),
                })
                .collect(),
            root: Some(root.to_string_lossy().into_owned()),
            texmf,
            clean: false,
        }
    }

    /// What `compile` runs once it has chosen the workspace.
    fn run_build(
        target: &Target,
        engine: &str,
        workspace: &Path,
        request: &NativeCompileRequest,
    ) -> Result<NativeCompileResult, String> {
        let folder = std::fs::canonicalize(request.root.as_deref().unwrap()).unwrap();
        let identity = target.engine_identity(engine);
        std::fs::create_dir_all(workspace).unwrap();
        build(Build {
            target,
            engine,
            identity: &identity,
            workspace,
            folder: Some(&folder),
            request,
            cancel: &AtomicBool::new(false),
            progress: &|_, _| {},
        })
    }

    /// Every file below a folder with its bytes.
    fn folder_state(dir: &Path) -> BTreeMap<String, Vec<u8>> {
        let mut found = BTreeMap::new();
        let mut pending = vec![dir.to_path_buf()];
        while let Some(next) = pending.pop() {
            for entry in std::fs::read_dir(&next).unwrap().flatten() {
                let path = entry.path();
                if path.is_dir() {
                    pending.push(path);
                } else {
                    let relative = path.strip_prefix(dir).unwrap();
                    found.insert(
                        relative.to_string_lossy().replace('\\', "/"),
                        std::fs::read(&path).unwrap(),
                    );
                }
            }
        }
        found
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
        // A new install falls back to XeLaTeX; a magic comment still wins.
        let has = |engine: &str| has_engine(&bin, engine);
        assert_eq!(
            select_engine_with("auto", &has, &main, true).unwrap(),
            "xelatex"
        );
        std::fs::write(&main, "% !TEX program = lualatex\n").unwrap();
        assert_eq!(
            select_engine_with("auto", &has, &main, true).unwrap(),
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
                args: engine_arguments("lualatex", None, "main.tex"),
                cwd: job.clone(),
                scratch: job.clone(),
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

    /// The in-place build against a real distribution. The folder's name has a
    /// space, a comma, braces and a non-ASCII letter; the main file is named
    /// like a reader's; one chapter has unsaved changes, another is
    /// `\include`d from a subfolder; a figure is named by a macro, so the
    /// snapshot never saw it; a draft that does not compile sits beside it;
    /// and there is a bibliography. The folder must not change by one byte.
    fn run_in_place(target: &Target, base: &Path) {
        let root = base.join("Thesis, {v2} \u{fc}");
        std::fs::create_dir_all(root.join("chapters")).unwrap();
        std::fs::create_dir_all(root.join("figures")).unwrap();
        let main_name = "LaTeX Reference2.tex";
        let main: &[u8] = b"\\documentclass{article}\n\\usepackage{graphicx}\n\\newcommand{\\fig}{figures/dot}\n\\begin{document}\n\\input{chapters/one}\n\\include{chapters/two}\n\\includegraphics[width=1cm]{\\fig}\n\\cite{key}\n\\bibliographystyle{plain}\n\\bibliography{refs}\n\\end{document}\n";
        let two: &[u8] = b"\\typeout{RESULT-TWO: saved}Two.\n";
        // Braced, so the style does not change its case.
        let bib: &[u8] = b"@misc{key, title={{RESULTBIB}}}\n";
        let unsaved: &[u8] = b"\\typeout{RESULT-ONE: unsaved}One, edited.\n";
        std::fs::write(root.join(main_name), main).unwrap();
        std::fs::write(
            root.join("chapters/one.tex"),
            b"\\typeout{RESULT-ONE: saved}One.\n",
        )
        .unwrap();
        std::fs::write(root.join("chapters/two.tex"), two).unwrap();
        std::fs::write(root.join("refs.bib"), bib).unwrap();
        std::fs::write(root.join("draft.tex"), b"\\undefined\n").unwrap();
        std::fs::copy(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../samples/latex-on-demand/figures/dot.png"),
            root.join("figures/dot.png"),
        )
        .unwrap();
        let before = folder_state(&root);
        let carried: Vec<(&str, &[u8])> = vec![
            (main_name, main),
            ("chapters/one.tex", unsaved),
            ("chapters/two.tex", two),
            ("refs.bib", bib),
        ];
        let request = native_request(&root, main_name, &carried, None);
        let mut ran = None;
        for engine in ["pdflatex", "lualatex", "xelatex"] {
            if !target.has_engine(engine) {
                eprintln!("{engine}: not installed (not run)");
                continue;
            }
            let workspace = base.join(format!("workspace-{engine}"));
            let result = run_build(target, engine, &workspace, &request).unwrap();
            let tail = &result.log[result.log.len().saturating_sub(3000)..];
            assert!(result.success, "{engine}: {:?}\n{tail}", result.error);
            assert!(
                result.log.contains("RESULT-ONE: unsaved")
                    && !result.log.contains("RESULT-ONE: saved"),
                "{engine}: the unsaved chapter is compiled, not the saved one\n{tail}"
            );
            assert!(result.log.contains("RESULT-TWO: saved"), "{engine}\n{tail}");
            for name in [
                main_name,
                "chapters/one.tex",
                "chapters/two.tex",
                "figures/dot.png",
            ] {
                assert!(
                    result.inputs.iter().any(|input| input == name),
                    "{engine}: {name} is an input of the build: {:?}",
                    result.inputs
                );
            }
            assert!(
                !result.inputs.iter().any(|input| input == "draft.tex"),
                "{engine}: a file the build did not read is not its input"
            );
            assert!(
                !result
                    .diagnostics
                    .iter()
                    .any(|entry| entry.code == "unsaved-not-compiled"),
                "{engine}: {:?}",
                result.diagnostics
            );
            if target.has_tool("bibtex") {
                let bbl = std::fs::read_to_string(workspace.join("out/LaTeX Reference2.bbl"))
                    .unwrap_or_default();
                assert!(
                    bbl.contains("RESULTBIB"),
                    "{engine}: BibTeX ran beside the outputs\n{bbl}\n{tail}\n{:?}",
                    folder_state(&workspace.join("out"))
                        .keys()
                        .collect::<Vec<_>>()
                );
                assert!(
                    result.inputs.iter().any(|input| input == "refs.bib"),
                    "{engine}: {:?}",
                    result.inputs
                );
            }
            assert_eq!(
                folder_state(&root),
                before,
                "{engine}: nothing is written into the folder"
            );
            eprintln!(
                "{engine}: in-place build verified ({} passes)",
                result.passes
            );
            ran = Some((engine, workspace));
        }
        // Saved: the chapter is read from the folder and the overlay empties.
        let (engine, workspace) = ran.expect("at least one engine ran");
        std::fs::write(root.join("chapters/one.tex"), unsaved).unwrap();
        let saved = folder_state(&root);
        let result = run_build(target, engine, &workspace, &request).unwrap();
        assert!(result.success, "{engine}: {:?}", result.error);
        assert!(result.log.contains("RESULT-ONE: unsaved"));
        assert!(
            folder_state(&workspace.join("overlay")).is_empty(),
            "a saved buffer is not overlaid"
        );
        assert_eq!(folder_state(&root), saved);
        let _ = std::fs::remove_dir_all(base);
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "requires MDRAFT_TEST_TEX_BIN to name a real Windows TeX binary directory"]
    fn a_real_windows_distribution_compiles_in_place() {
        let Ok(bin) = std::env::var("MDRAFT_TEST_TEX_BIN") else {
            eprintln!("MDRAFT_TEST_TEX_BIN is not set");
            return;
        };
        let bin = PathBuf::from(bin);
        let target = Target::Path {
            name: distribution_name(&bin.display().to_string()),
            bin,
        };
        let base = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target/test-tmp")
            .join(format!("in-place-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        run_in_place(&target, &base);
    }

    #[cfg(unix)]
    #[test]
    #[ignore = "requires TeX Live on the host"]
    fn a_real_distribution_compiles_in_place() {
        let bin = PathBuf::from(
            std::env::var("MDRAFT_TEST_TEX_BIN").unwrap_or_else(|_| "/usr/bin".into()),
        );
        let target = Target::Path {
            name: distribution_name(&bin.display().to_string()),
            bin,
        };
        let base = std::env::temp_dir().join(format!("mdraft-in-place-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        run_in_place(&target, &base);
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "requires MDRAFT_TEST_WSL_DISTRO (and optionally MDRAFT_TEST_WSL_BIN)"]
    fn a_wsl_distribution_compiles_in_place() {
        let distro = std::env::var("MDRAFT_TEST_WSL_DISTRO").unwrap();
        let bin = std::env::var("MDRAFT_TEST_WSL_BIN").unwrap_or_else(|_| "/usr/bin".into());
        let target = Target::Wsl(wsl::WslInstallation {
            distro,
            bin,
            engines: vec!["lualatex".into(), "pdflatex".into(), "xelatex".into()],
            tools: vec!["bibtex".into()],
        });
        let base = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target/test-tmp")
            .join(format!("in-place-wsl-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        run_in_place(&target, &base);
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
                args: engine_arguments("lualatex", None, "main.tex"),
                cwd: job.clone(),
                scratch: job.clone(),
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
                scratch: job.clone(),
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
        let args: Vec<String> = engine_arguments("lualatex", None, "main.tex")
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
    fn search_paths_put_the_overlay_first_and_the_libraries_after_the_folder() {
        // Nothing overlaid and no library: the distribution's own paths, with
        // the folder after the outputs for the bibliography tool.
        let plain = search_environment(
            Family::Kpathsea,
            "pdflatex",
            &build_paths(0, false, Some("C:/Thesis")),
            ';',
        );
        assert_eq!(value(&plain, "TEXINPUTS"), None);
        assert_eq!(value(&plain, "TEXMFHOME"), None);
        assert_eq!(value(&plain, "BIBINPUTS"), Some(".;C:/Thesis;"));
        assert_eq!(value(&plain, "TEXMFOUTPUT"), Some("C:/ws/out"));

        let kpathsea = search_environment(
            Family::Kpathsea,
            "pdflatex",
            &build_paths(2, true, None),
            ':',
        );
        assert_eq!(
            value(&kpathsea, "TEXMFHOME"),
            Some("{C:/ws/texmf/0,C:/ws/texmf/1}")
        );
        // The empty element after the overlay is the distribution's own,
        // format-aware path, which starts with `.`.
        assert_eq!(value(&kpathsea, "TEXINPUTS"), Some("C:/ws/overlay:"));
        assert_eq!(value(&kpathsea, "BSTINPUTS"), Some(".:"));

        let miktex = search_environment(
            Family::Miktex,
            "lualatex",
            &build_paths(2, true, Some("C:/Thesis")),
            ';',
        );
        let tex = value(&miktex, "TEXINPUTS").unwrap();
        // The overlay, then the folder (MiKTeX searches these variables
        // before the working directory), then the roots in order with the
        // format-specific directories first.
        assert!(
            tex.starts_with(
                "C:/ws/overlay;.;C:/ws/texmf/0/tex/lualatex//;C:/ws/texmf/0/tex/latex//;"
            ),
            "{tex}"
        );
        assert!(tex.find("texmf/0/").unwrap() < tex.find("texmf/1/").unwrap());
        assert!(!tex.contains("tex/xelatex"));
        assert!(
            value(&miktex, "BSTINPUTS")
                .unwrap()
                .starts_with(".;C:/Thesis;C:/ws/texmf/0/bibtex/bst//;")
        );
        assert!(
            value(&miktex, "LUAINPUTS")
                .unwrap()
                .contains("C:/ws/texmf/1/scripts//;")
        );
        assert!(value(&miktex, "OPENTYPEFONTS").is_some());
        let xelatex =
            search_environment(Family::Miktex, "xelatex", &build_paths(1, false, None), ';');
        assert!(
            value(&xelatex, "TEXINPUTS")
                .unwrap()
                .starts_with(".;C:/ws/texmf/0/tex/xelatex//;")
        );
        let none = search_environment(
            Family::Miktex,
            "pdflatex",
            &build_paths(0, false, None),
            ';',
        );
        assert_eq!(value(&none, "TEXINPUTS"), None);
        assert_eq!(value(&none, "LUAINPUTS"), None);
        assert_eq!(value(&none, "BIBINPUTS"), Some(".;"));
    }

    fn build_paths(libraries: usize, overlay: bool, root: Option<&str>) -> BuildPaths {
        BuildPaths {
            state: "C:/ws".into(),
            out: "C:/ws/out".into(),
            engine: inplace::EnginePaths {
                root: "C:/Thesis".into(),
                workspace: "C:/ws".into(),
                overlay: "C:/ws/overlay".into(),
                out: "C:/ws/out".into(),
                windows: true,
            },
            overlay: overlay.then(|| "C:/ws/overlay".to_string()),
            libraries: (0..libraries).map(|n| format!("C:/ws/texmf/{n}")).collect(),
            output: Some("C:/ws/out".into()),
            root: root.map(str::to_string),
        }
    }

    #[test]
    fn the_wsl_environment_is_exact_and_job_local() {
        let env = wsl_environment(
            "/usr/local/texlive/2025/bin/x86_64-linux",
            "/mnt/c/jobs/a, b",
        );
        assert_eq!(
            value(&env, "PATH"),
            Some("/usr/local/texlive/2025/bin/x86_64-linux:/usr/bin:/bin")
        );
        assert_eq!(value(&env, "HOME"), Some("/mnt/c/jobs/a, b"));
        assert_eq!(value(&env, "TEXMFHOME"), Some("/mnt/c/jobs/a, b/home"));
        assert!(
            value(&env, "TEXMFVAR")
                .unwrap()
                .starts_with("/mnt/c/jobs/a, b/")
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
        let mut state = WorkspaceState::new(&job, "main.tex", "lualatex");
        assert_eq!(
            stage_texmf(&job.join("texmf"), Some(&snapshot), &mut state).unwrap(),
            3
        );
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
        assert!(stage_texmf(&job.join("texmf2"), Some(&escaping), &mut state).is_err());
        assert_eq!(stage_texmf(&job.join("none"), None, &mut state).unwrap(), 0);
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
        // A comma, a space and a non-ASCII letter in the document's folder,
        // where TeX runs: no search path names it.
        let base = std::env::temp_dir().join(format!("mdraft-texmf-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let job = base.join("real, \u{fc}");
        let (snapshot, main) = library_fixture(&job);
        let root = job.join("project");
        let main_bytes = std::fs::read(root.join(main)).unwrap();
        let request = native_request(&root, main, &[(main, &main_bytes)], Some(snapshot));
        for engine in ["lualatex", "pdflatex", "xelatex"] {
            if !target.has_engine(engine) {
                eprintln!("{engine}: not installed (not run)");
                continue;
            }
            let workspace = base.join(format!("workspace-{engine}"));
            let result = run_build(&target, engine, &workspace, &request).unwrap();
            assert_library_markers(&result.log, engine);
            let bbl = std::fs::read_to_string(workspace.join("out/main.bbl")).unwrap_or_default();
            assert!(
                bbl.contains("RESULTBIB"),
                "{engine}: the private .bst/.bib reached BibTeX"
            );
            assert!(result.success, "{engine}: {:?}", result.error);
            eprintln!("{engine}: library resolution verified");
        }
        let _ = std::fs::remove_dir_all(base);
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
        let base = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target/test-tmp")
            .join(format!("wsl-texmf-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let job = base.join("wsl, job \u{fc}");
        let (snapshot, main) = library_fixture(&job);
        let root = job.join("project");
        let main_bytes = std::fs::read(root.join(main)).unwrap();
        let request = native_request(&root, main, &[(main, &main_bytes)], Some(snapshot));
        for engine in ["lualatex", "pdflatex"] {
            let workspace = base.join(format!("workspace-{engine}"));
            let result = run_build(&target, engine, &workspace, &request).unwrap();
            assert_library_markers(&result.log, engine);
            let bbl = std::fs::read_to_string(workspace.join("out/main.bbl")).unwrap_or_default();
            assert!(
                bbl.contains("RESULTBIB"),
                "{engine}: BibTeX through the launcher"
            );
        }
        // Cancel ends the Linux process tree, not only wsl.exe.
        std::fs::write(root.join("spin.tex"), "\\def\\spin{\\spin}\\spin\n").unwrap();
        let workspace = base.join("workspace-spin");
        std::fs::create_dir_all(workspace.join("out")).unwrap();
        let folder = std::fs::canonicalize(&root).unwrap();
        let paths = target.paths(&workspace, &folder, 0, false).unwrap();
        let env = target.environment(&workspace, &paths, "pdflatex");
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
                    engine_arguments("pdflatex", Some(&paths.out), "spin.tex"),
                    &inplace::plain(&folder),
                    &workspace.join("out"),
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
                &workspace,
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
        let _ = std::fs::remove_dir_all(base);
    }

    fn temp_case(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "mdraft-native-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn the_auxiliary_signature_tracks_content_not_mtime() {
        let work = temp_case("aux-signature");
        std::fs::create_dir_all(work.join("chapters")).unwrap();
        std::fs::write(work.join("main.aux"), b"\\newlabel{a}{{1}{1}}").unwrap();
        std::fs::write(work.join("chapters/one.aux"), b"\\newlabel{b}{{2}{2}}").unwrap();
        std::fs::write(work.join("main.log"), b"a log").unwrap();
        let first = auxiliary_signature(&work);
        // A no-op pass rewrites the same content.
        std::fs::write(work.join("main.aux"), b"\\newlabel{a}{{1}{1}}").unwrap();
        assert_eq!(first, auxiliary_signature(&work));
        std::fs::write(work.join("chapters/one.aux"), b"\\newlabel{b}{{3}{3}}").unwrap();
        assert_ne!(first, auxiliary_signature(&work));
        let _ = std::fs::remove_dir_all(work);
    }

    #[test]
    fn the_bibliography_decision_uses_bcf_bib_and_bbl_state() {
        let work = temp_case("bib-decision");
        let stem = "main";
        assert_eq!(
            decide_bibliography(&work, stem, "", "bcf", "", "", false),
            Bibliography::None,
            "no .bcf and no .aux control is not a bibliography"
        );
        std::fs::write(work.join("main.bcf"), b"bcf").unwrap();
        assert_eq!(
            decide_bibliography(&work, stem, "", "bcf", "", "", false),
            Bibliography::Biber,
            "no .bbl runs the tool"
        );
        std::fs::write(work.join("main.bbl"), b"bbl").unwrap();
        assert_eq!(
            decide_bibliography(&work, stem, "same", "same", "", "", false),
            Bibliography::None,
            "a current .bbl and unchanged inputs skip the tool"
        );
        assert_eq!(
            decide_bibliography(&work, stem, "old", "new", "", "", false),
            Bibliography::Biber,
            "a changed .bcf runs Biber"
        );
        assert_eq!(
            decide_bibliography(&work, stem, "same", "same", "", "", true),
            Bibliography::Biber,
            "a changed .bib runs Biber even when the .bcf is stable"
        );
        let _ = std::fs::remove_dir_all(work);
    }

    #[test]
    fn the_bibtex_decision_ignores_page_and_label_changes() {
        let work = temp_case("bibtex-decision");
        std::fs::write(
            work.join("main.aux"),
            b"\\citation{a}\n\\bibdata{refs}\n\\bibstyle{plain}\n\\newlabel{x}{{1}{1}}\n",
        )
        .unwrap();
        let control = aux_control(&work);
        assert_eq!(control, aux_control(&work));
        std::fs::write(
            work.join("main.aux"),
            b"\\citation{a}\n\\bibdata{refs}\n\\bibstyle{plain}\n\\newlabel{x}{{1}{2}}\n",
        )
        .unwrap();
        assert_eq!(control, aux_control(&work));
        std::fs::write(work.join("main.bbl"), b"bbl").unwrap();
        assert_eq!(
            decide_bibliography(&work, "main", "", "", &control, &control, false),
            Bibliography::None
        );
        let changed = aux_control(&work);
        std::fs::write(
            work.join("main.aux"),
            b"\\citation{a}\\citation{b}\n\\bibdata{refs}\n\\bibstyle{plain}\n",
        )
        .unwrap();
        let changed_after = aux_control(&work);
        assert_eq!(
            decide_bibliography(&work, "main", "", "", &changed, &changed_after, false),
            Bibliography::Bibtex
        );
        let _ = std::fs::remove_dir_all(work);
    }

    #[test]
    fn the_bibliography_digest_follows_declared_content_and_read_stamps() {
        let base = temp_case("bib-digest");
        let root = base.join("root");
        std::fs::create_dir_all(root.join("data")).unwrap();
        std::fs::write(root.join("main.tex"), b"main").unwrap();
        std::fs::write(root.join("refs.bib"), b"@book{a}").unwrap();
        std::fs::write(root.join("data/found.bib"), b"@book{f}").unwrap();
        let root = std::fs::canonicalize(&root).unwrap();
        let mut staged = BTreeMap::new();
        let prepare = |bib: &[u8], staged: &mut BTreeMap<String, String>| {
            inplace::prepare(
                &root,
                &base.join("overlay"),
                &base.join("out"),
                "main.tex",
                &[
                    NativeFile {
                        path: "main.tex".into(),
                        data: STANDARD.encode(b"main"),
                    },
                    NativeFile {
                        path: "refs.bib".into(),
                        data: STANDARD.encode(bib),
                    },
                ],
                staged,
            )
            .unwrap()
        };
        let reads = vec!["refs.bib".to_string(), "data/found.bib".to_string()];
        let first = bibliography_digest(&root, &prepare(b"@book{a}", &mut staged), &reads);
        assert_eq!(
            first,
            bibliography_digest(&root, &prepare(b"@book{a}", &mut staged), &reads)
        );
        let edited = bibliography_digest(&root, &prepare(b"@book{b}", &mut staged), &reads);
        assert_ne!(first, edited, "a declared .bib is compared by content");
        std::fs::write(root.join("data/found.bib"), b"@book{changed}").unwrap();
        assert_ne!(
            edited,
            bibliography_digest(&root, &prepare(b"@book{b}", &mut staged), &reads),
            "a .bib the tool found in the folder is compared by stamp"
        );
        let _ = std::fs::remove_dir_all(base);
    }
}
