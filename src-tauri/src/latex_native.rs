//! Installed TeX distributions: discovery, validation and direct builds.
//!
//! The bundled preview stays the default. This module serves a reader who
//! explicitly chose an installation already on the computer: it finds one,
//! compiles a probe with it, and only then offers the switch. Every real job
//! stages the project into an app-owned directory, runs the engine as a
//! controllable process tree, and maps the compiler's log back to the snapshot —
//! never to the reader's disk.

mod discovery;
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

const MAX_FILE: usize = 32 * 1024 * 1024;
const MAX_PROJECT: usize = 64 * 1024 * 1024;
const MAX_FILES: usize = 256;
/// A manifest file is read from the project root, not sent over IPC.
const MAX_MANIFEST_FILE: u64 = 128 * 1024 * 1024;
/// The whole staged tree at most; the same ceiling as the preview's project table.
const MAX_MANIFEST_TOTAL: u64 = 1024 * 1024 * 1024;
/// The manifest itself is bounded by the snapshot; a hostile request is not.
const MAX_MANIFEST_FILES: usize = 20_000;
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
    /// The hidden WasmTex backend's assets, kept for its regression layer.
    pub bundled_installed: bool,
    /// The production preview engine and digest table are present.
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
    /// The project root, for the manifest files that are staged from disk.
    #[serde(default)]
    root: Option<String>,
    /// Relative names from the snapshot manifest; eager files win over these.
    #[serde(default)]
    manifest: Vec<String>,
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
    let preview_installed =
        crate::latex::directory(&app).is_ok_and(|root| crate::latex_texpresso::available(&root));
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

/// Remove generated auxiliary files after a failed build, keeping the staged
/// inputs, caches and `tmp/` (the Biber extraction). A project file that
/// happens to have one of these names is staged again by the next build.
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

/// Every `.bib`/`.bst` file the workspace can give the bibliography tool. A
/// changed content forces a tool run even when the citation controls did not
/// change.
fn bibliography_inputs(workspace: &Path) -> String {
    let mut entries = BTreeMap::new();
    for root in [workspace.join("project"), workspace.join("texmf")] {
        collect_bibliography_inputs(&root, &root, &mut entries);
    }
    let material = entries
        .iter()
        .map(|(path, digest)| format!("{path}\0{digest}\n"))
        .collect::<String>();
    crate::latex::digest(material.as_bytes())
}

fn collect_bibliography_inputs(root: &Path, dir: &Path, out: &mut BTreeMap<String, String>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(metadata) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        if metadata.is_dir() {
            collect_bibliography_inputs(root, &path, out);
        } else if metadata.is_file()
            && path
                .extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(|extension| {
                    extension.eq_ignore_ascii_case("bib") || extension.eq_ignore_ascii_case("bst")
                })
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
    let name = target.distribution();
    let (token, registration) = register(&request.job)?;

    let main_text = request_main_text(&request);
    let engine = select_engine_text(
        &settings.latex_native_engine,
        &|engine| target.has_engine(engine),
        main_text.as_deref(),
    )?;
    let identity = target.engine_identity(&engine);
    let root = match request.root.as_deref() {
        Some(root) => Some(
            std::fs::canonicalize(root)
                .map_err(|error| format!("Cannot read the project directory: {error}"))?,
        ),
        None => None,
    };
    // A request without a root (the direct command and its integration test)
    // keeps the old fresh-directory behaviour: eager files are staged, no
    // manifest, and nothing is reused. The shipped frontend always sends root.
    let _temporary_job: Option<runner::JobDir>;
    let workspace_path: PathBuf;
    let workspace_created: bool;
    match &root {
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
        && root.is_some()
        && let Ok(session_root) = runner::workspace_root(app)
    {
        prune_workspaces(&session_root, &workspace_path);
    }
    let work = workspace_path.join("project");
    let main_file = request.main_file.replace('\\', "/");
    let mut workspace_state = load_workspace(
        &workspace_path,
        root.as_deref().unwrap_or(Path::new("")),
        &main_file,
        &identity,
    );
    // The previous `.bib`/`.bst` content, before this request's files are
    // staged. A content change forces the bibliography tool even when the
    // citation controls themselves did not change.
    let bib_before = bibliography_inputs(&workspace_path);
    let staged = stage(&workspace_path, &request, &mut workspace_state)?;
    let roots = stage_texmf(
        &workspace_path.join("texmf"),
        request.texmf.as_ref(),
        &mut workspace_state,
    )?;
    let bib_after = bibliography_inputs(&workspace_path);
    let bib_changed = bib_before != bib_after;
    save_workspace(&workspace_path, &workspace_state)?;
    if matches!(target, Target::Wsl(_)) {
        emit(app, &request.job, "starting-wsl", None);
    }
    let env = target.environment(&workspace_path, &work, &engine, roots)?;
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
    let mut aux_before = auxiliary_signature(&work);

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
        // The previous pass's bibliography state, before this pass rewrites it.
        let bcf_before = file_digest(&work.join(format!("{stem}.bcf")));
        let control_before = aux_control(&work);
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
        let bcf_after = file_digest(&work.join(format!("{stem}.bcf")));
        let control_after = aux_control(&work);
        let bibliography = decide_bibliography(
            &work,
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
                emit(app, &request.job, "bibliography", Some(tool));
                let args = vec![OsString::from(stem.clone())];
                let bbl_before = file_digest(&work.join(format!("{stem}.bbl")));
                let helper = runner::run(
                    &target.spec(tool, args, &work, &env, PROBE_TIMEOUT * 3)?,
                    &token,
                )?;
                if !helper.console.trim().is_empty() {
                    logs.push(helper.console);
                }
                // Only a changed .bbl requires another LaTeX pass. A tool run
                // that produced identical output does not.
                let bbl_after = file_digest(&work.join(format!("{stem}.bbl")));
                if bbl_before != bbl_after {
                    force_rerun = true;
                }
            } else {
                missing_tool = Some(format!(
                    "This document needs {tool}, but it is not part of the selected installation. Install it with the distribution\x27s own tools, then compile again."
                ));
            }
        }
        if cancelled || timed_out {
            break;
        }
        let aux_after = auxiliary_signature(&work);
        let aux_changed = aux_before != aux_after;
        aux_before = aux_after;
        if (!parsed.rerun && !aux_changed && !force_rerun) || outcome.status != 0 {
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
    if !success {
        // A failed or cancelled pass can leave a half-written .aux/.bcf. Keep
        // the staged sources, caches and tmp/ (the Biber extraction), but let
        // the next build start from clean outputs.
        remove_auxiliary(&work);
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

/// Bump when the staging record or layout changes; an older record is discarded.
const WORKSPACE_VERSION: u32 = 1;

/// What one staged project file was copied from.
///
/// Eager files (the main file and open buffers) use `digest`; manifest files
/// use the source's size and modification stamp. A generated file with the same
/// name is not in this record, so reusing the workspace never overwrites it
/// just because the source is unchanged.
#[derive(Serialize, Deserialize, Clone)]
struct StagedFile {
    size: u64,
    modified: u64,
    /// Non-empty for an eager file; empty for a manifest file.
    digest: String,
}

#[derive(Serialize, Deserialize)]
struct WorkspaceState {
    version: u32,
    root: String,
    main_file: String,
    engine: String,
    texmf_revision: Option<String>,
    staged: BTreeMap<String, StagedFile>,
}

impl WorkspaceState {
    fn new(root: &Path, main_file: &str, engine: &str) -> Self {
        WorkspaceState {
            version: WORKSPACE_VERSION,
            root: root.to_string_lossy().into_owned(),
            main_file: main_file.to_string(),
            engine: engine.to_string(),
            texmf_revision: None,
            staged: BTreeMap::new(),
        }
    }
}

/// A modification time this close to the staging clock cannot prove a later
/// same-size edit is absent: filesystems record mtimes at a coarse tick (the
/// kernel tick on ext4, two seconds on FAT), so a rewrite in the same tick
/// keeps the old stamp. Such a file is recorded as unproven (stamp 0) and
/// copied again on the next compile, as Git does with "racily clean" entries.
const RACY_STAMP_WINDOW: Duration = Duration::from_secs(3);

fn file_stamp(metadata: &std::fs::Metadata) -> u64 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|age| u64::try_from(age.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}

/// The stamp that may prove a staged copy current: the source's stamp, or 0
/// when it is unknown or too recent to rule out a later same-size edit (see
/// `RACY_STAMP_WINDOW`). A future mtime (clock skew) is as unprovable as a
/// recent one.
fn settled_stamp(metadata: &std::fs::Metadata, staged_at: std::time::SystemTime) -> u64 {
    let settled = metadata.modified().is_ok_and(|modified| {
        staged_at
            .duration_since(modified)
            .is_ok_and(|age| age >= RACY_STAMP_WINDOW)
    });
    if settled { file_stamp(metadata) } else { 0 }
}

struct Staged {
    main: PathBuf,
    sources: BTreeMap<String, String>,
}

fn stage(
    workspace: &Path,
    request: &NativeCompileRequest,
    state: &mut WorkspaceState,
) -> Result<Staged, String> {
    if request.files.is_empty() {
        return Err("The LaTeX project has no files.".into());
    }
    if request.files.len() > MAX_FILES {
        return Err("The LaTeX project exceeds its file count limit.".into());
    }
    let work = workspace.join("project");
    std::fs::create_dir_all(&work).map_err(|error| error.to_string())?;
    let staged_at = std::time::SystemTime::now();
    let mut total = 0usize;
    let mut main = None;
    let mut sources = BTreeMap::new();
    let mut desired = BTreeSet::new();
    let main_relative = request.main_file.replace('\\', "/");
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
        desired.insert(relative.clone());
        let target = work.join(&relative);
        // The eager bytes win over every disk copy, including one the engine
        // rewrote in the previous build. Compare the staged file, not the
        // record, so a generated overwrite cannot hide the reader's buffer.
        let same = target
            .metadata()
            .ok()
            .filter(|metadata| metadata.is_file() && metadata.len() == bytes.len() as u64)
            .is_some_and(|_| {
                std::fs::read(&target)
                    .ok()
                    .is_some_and(|current| current == bytes)
            });
        if !same {
            ensure_parent_dirs(&work, &relative)?;
            remove_conflicting_path(&target)?;
            std::fs::write(&target, &bytes)
                .map_err(|error| format!("Cannot stage {}: {error}", file.path))?;
        }
        if relative == main_relative {
            main = Some(target.clone());
        }
        if relative.to_ascii_lowercase().ends_with(".tex")
            && let Ok(text) = String::from_utf8(bytes.clone())
        {
            sources.insert(relative.clone(), text);
        }
        state.staged.insert(
            relative,
            StagedFile {
                size: bytes.len() as u64,
                modified: 0,
                digest: crate::latex::digest(&bytes),
            },
        );
    }
    if let Some(root) = &request.root {
        let root = std::fs::canonicalize(root)
            .map_err(|error| format!("Cannot read the project directory: {error}"))?;
        if request.manifest.len() > MAX_MANIFEST_FILES {
            return Err(format!(
                "The LaTeX project has more than {MAX_MANIFEST_FILES} files in its project manifest."
            ));
        }
        let mut manifest_total = 0u64;
        for relative in &request.manifest {
            let target_relative = safe_relative(relative)?;
            // An eager file (including an unsaved buffer's bytes) already won.
            if desired.contains(&target_relative) {
                continue;
            }
            let (source, size) = crate::latex::project_file_in(&root, relative)?;
            if size > MAX_MANIFEST_FILE {
                return Err(format!(
                    "{relative} exceeds the 128 MiB project-file limit; move it outside the project."
                ));
            }
            manifest_total = manifest_total
                .checked_add(size)
                .ok_or("The LaTeX project size overflowed.")?;
            if manifest_total > MAX_MANIFEST_TOTAL {
                return Err(
                    "The LaTeX project exceeds the 1 GiB staged-project limit; split the project."
                        .into(),
                );
            }
            if is_executable(&target_relative) {
                return Err(format!(
                    "{relative} is an executable file; project executables are never staged."
                ));
            }
            let metadata = std::fs::metadata(&source)
                .map_err(|error| format!("Cannot read {relative}: {error}"))?;
            let stamp = settled_stamp(&metadata, staged_at);
            let target = work.join(&target_relative);
            // A source that has not changed is left exactly as it is. This is
            // what keeps a generated file (a PDF, .bbl, .aux) that happens to
            // share a project name from being replaced on every compile.
            let unchanged = state.staged.get(&target_relative).is_some_and(|previous| {
                previous.size == size
                    && previous.modified != 0
                    && previous.modified == stamp
                    && previous.digest.is_empty()
                    && target.is_file()
            });
            if !unchanged {
                ensure_parent_dirs(&work, &target_relative)?;
                remove_conflicting_path(&target)?;
                // Copy, never hard-link: a committed main.pdf, main.bbl or
                // main.aux must not be writable through the staged copy.
                std::fs::copy(&source, &target)
                    .map_err(|error| format!("Cannot stage {relative}: {error}"))?;
            }
            if target_relative.to_ascii_lowercase().ends_with(".tex")
                && let Ok(text) = std::fs::read_to_string(&target)
            {
                sources.insert(target_relative.clone(), text);
            }
            state.staged.insert(
                target_relative.clone(),
                StagedFile {
                    size,
                    modified: stamp,
                    digest: String::new(),
                },
            );
            desired.insert(target_relative);
        }
    }
    // Remove a staged copy whose project file disappeared. Generated files are
    // not in `staged`, so a .aux, .bbl or PDF the engine wrote is never
    // deleted here.
    let obsolete: Vec<String> = state
        .staged
        .keys()
        .filter(|relative| !desired.contains(*relative))
        .cloned()
        .collect();
    for relative in obsolete {
        let target = work.join(&relative);
        if target.is_file() {
            let _ = std::fs::remove_file(&target);
        }
        state.staged.remove(&relative);
    }
    let main = main.ok_or("The main .tex file is not part of the project snapshot.")?;
    Ok(Staged { main, sources })
}

/// Create every parent of a staged file, removing a stale file that now has to
/// become a directory. A project rename can turn a file into a directory.
fn ensure_parent_dirs(work: &Path, relative: &str) -> Result<(), String> {
    let parts: Vec<&str> = relative.split('/').collect();
    let mut path = work.to_path_buf();
    for part in &parts[..parts.len().saturating_sub(1)] {
        path.push(part);
        if let Ok(metadata) = std::fs::symlink_metadata(&path)
            && metadata.is_file()
        {
            std::fs::remove_file(&path)
                .map_err(|error| format!("Cannot replace {}: {error}", path.display()))?;
        }
        std::fs::create_dir_all(&path)
            .map_err(|error| format!("Cannot create {}: {error}", path.display()))?;
    }
    Ok(())
}

/// A staged path that is currently a directory cannot also be a file.
fn remove_conflicting_path(target: &Path) -> Result<(), String> {
    match std::fs::symlink_metadata(target) {
        Ok(metadata) if metadata.is_dir() => std::fs::remove_dir_all(target)
            .map_err(|error| format!("Cannot replace {}: {error}", target.display())),
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Cannot read {}: {error}", target.display())),
    }
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

#[cfg(test)]
fn select_engine_with(
    requested: &str,
    has: &dyn Fn(&str) -> bool,
    main: &Path,
) -> Result<String, String> {
    let text = std::fs::read_to_string(main).ok();
    select_engine_text(requested, has, text.as_deref())
}

/// The engine selection shared by the file reader (tests and probes) and the
/// workspace path, which has the main file's bytes before staging exists.
fn select_engine_text(
    requested: &str,
    has: &dyn Fn(&str) -> bool,
    text: Option<&str>,
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
                    .map(|metadata| format!("{}:{}", metadata.len(), file_stamp(&metadata)))
                    .unwrap_or_default();
                format!("path:{}:{}:{stamp}", bin.display(), engine)
            }
            Target::Wsl(selected) => {
                format!("wsl:{}:{}:{engine}", selected.distro, selected.bin)
            }
        }
    }

    fn environment(
        &self,
        job: &Path,
        _work: &Path,
        engine: &str,
        roots: usize,
    ) -> Result<Vec<(String, String)>, String> {
        match self {
            Target::Path { bin, name } => {
                let mut env = base_environment(bin, job, name);
                for (key, value) in library_environment(self.family(), engine, roots) {
                    set_env(&mut env, &key, value);
                }
                Ok(env)
            }
            Target::Wsl(selected) => {
                // Creates the private directories on the Windows side.
                let _ = base_environment(Path::new(&selected.bin), job, "TeX Live");
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
    // Build state lives at the workspace root; `project` is the cwd only, so a
    // project may have its own tmp/cache/data folder.
    let mut env = vec![
        // Not the Windows PATH that WSL interop appends.
        ("PATH".to_string(), format!("{bin}:/usr/bin:/bin")),
        ("LANG".to_string(), "C.UTF-8".to_string()),
        ("LC_ALL".to_string(), "C.UTF-8".to_string()),
        ("HOME".to_string(), job.to_string()),
        ("TMPDIR".to_string(), format!("{job}/tmp")),
        ("TEXMFVAR".to_string(), format!("{job}/data")),
        ("TEXMFCONFIG".to_string(), format!("{job}/config")),
        ("TEXMFHOME".to_string(), format!("{job}/home")),
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
    fn stage_stages_the_manifest_but_keeps_eager_bytes() {
        let base =
            std::env::temp_dir().join(format!("mdraft-native-manifest-{}", std::process::id()));
        let root = base.join("project");
        let workspace = base.join("job");
        let work = workspace.join("project");
        std::fs::create_dir_all(root.join("figures")).unwrap();
        std::fs::write(root.join("main.tex"), b"disk main").unwrap();
        std::fs::write(root.join("extra.tex"), b"manifest source").unwrap();
        std::fs::write(root.join("figures/a.bin"), b"figure").unwrap();
        let request = NativeCompileRequest {
            job: "manifest".into(),
            main_file: "main.tex".into(),
            files: vec![NativeFile {
                path: "main.tex".into(),
                data: STANDARD.encode(b"open buffer"),
            }],
            root: Some(root.to_string_lossy().into_owned()),
            manifest: vec![
                "main.tex".into(),
                "extra.tex".into(),
                "figures/a.bin".into(),
            ],
            texmf: None,
            clean: false,
        };
        let mut state = WorkspaceState::new(&root, "main.tex", "lualatex");
        let staged = stage(&workspace, &request, &mut state).unwrap();
        assert_eq!(
            std::fs::read(work.join("main.tex")).unwrap(),
            b"open buffer"
        );
        assert_eq!(
            std::fs::read(work.join("extra.tex")).unwrap(),
            b"manifest source"
        );
        assert_eq!(
            std::fs::read(work.join("figures/a.bin")).unwrap(),
            b"figure"
        );
        assert!(staged.sources.contains_key("extra.tex"));
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn stage_copies_project_files_instead_of_linking_them() {
        let base = std::env::temp_dir().join(format!("mdraft-native-copy-{}", std::process::id()));
        let root = base.join("project");
        let workspace = base.join("job");
        std::fs::create_dir_all(&root).unwrap();
        for (name, bytes) in [
            ("main.tex", b"main".as_slice()),
            ("main.pdf", b"project pdf".as_slice()),
            ("main.bbl", b"project bbl".as_slice()),
            ("main.aux", b"project aux".as_slice()),
        ] {
            std::fs::write(root.join(name), bytes).unwrap();
        }
        let request = NativeCompileRequest {
            job: "copy".into(),
            main_file: "main.tex".into(),
            files: vec![NativeFile {
                path: "main.tex".into(),
                data: STANDARD.encode(b"open buffer"),
            }],
            root: Some(root.to_string_lossy().into_owned()),
            manifest: vec![
                "main.tex".into(),
                "main.pdf".into(),
                "main.bbl".into(),
                "main.aux".into(),
            ],
            texmf: None,
            clean: false,
        };
        let mut state = WorkspaceState::new(&root, "main.tex", "lualatex");
        stage(&workspace, &request, &mut state).unwrap();
        let work = workspace.join("project");
        // The engine writes generated names in its own folder. A hard link
        // would write through to the reader's project; a copy must not.
        std::fs::write(work.join("main.pdf"), b"engine pdf").unwrap();
        std::fs::write(work.join("main.bbl"), b"engine bbl").unwrap();
        std::fs::write(work.join("main.aux"), b"engine aux").unwrap();
        assert_eq!(
            std::fs::read(root.join("main.pdf")).unwrap(),
            b"project pdf"
        );
        assert_eq!(
            std::fs::read(root.join("main.bbl")).unwrap(),
            b"project bbl"
        );
        assert_eq!(
            std::fs::read(root.join("main.aux")).unwrap(),
            b"project aux"
        );
        assert_eq!(std::fs::read(work.join("main.pdf")).unwrap(), b"engine pdf");
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn stage_reuses_unchanged_files_and_removes_deleted_ones() {
        let base = std::env::temp_dir().join(format!("mdraft-native-sync-{}", std::process::id()));
        let root = base.join("project");
        let workspace = base.join("job");
        std::fs::create_dir_all(root.join("figures")).unwrap();
        std::fs::write(root.join("main.tex"), b"main").unwrap();
        std::fs::write(root.join("extra.tex"), b"one").unwrap();
        std::fs::write(root.join("figures/a.bin"), b"a").unwrap();
        let request = |manifest: Vec<String>| NativeCompileRequest {
            job: "sync".into(),
            main_file: "main.tex".into(),
            files: vec![NativeFile {
                path: "main.tex".into(),
                data: STANDARD.encode(b"main"),
            }],
            root: Some(root.to_string_lossy().into_owned()),
            manifest,
            texmf: None,
            clean: false,
        };
        let mut state = WorkspaceState::new(&root, "main.tex", "lualatex");
        stage(
            &workspace,
            &request(vec![
                "main.tex".into(),
                "extra.tex".into(),
                "figures/a.bin".into(),
            ]),
            &mut state,
        )
        .unwrap();
        let work = workspace.join("project");
        assert_eq!(std::fs::read(work.join("extra.tex")).unwrap(), b"one");

        std::fs::write(root.join("extra.tex"), b"two").unwrap();
        std::fs::write(root.join("new.tex"), b"new").unwrap();
        std::fs::remove_file(root.join("figures/a.bin")).unwrap();
        stage(
            &workspace,
            &request(vec![
                "main.tex".into(),
                "extra.tex".into(),
                "new.tex".into(),
            ]),
            &mut state,
        )
        .unwrap();
        assert_eq!(std::fs::read(work.join("extra.tex")).unwrap(), b"two");
        assert_eq!(std::fs::read(work.join("new.tex")).unwrap(), b"new");
        assert!(!work.join("figures/a.bin").exists());
        assert_eq!(std::fs::read(work.join("main.tex")).unwrap(), b"main");
        let _ = std::fs::remove_dir_all(base);
    }
    #[test]
    fn a_recent_stamp_cannot_prove_a_file_unchanged() {
        let path = std::env::temp_dir().join(format!("mdraft-racy-{}", std::process::id()));
        std::fs::write(&path, b"one").unwrap();
        let now = std::time::SystemTime::now();
        // Written just now: a same-size rewrite in this tick would keep the stamp.
        assert_eq!(settled_stamp(&std::fs::metadata(&path).unwrap(), now), 0);
        let old = now - Duration::from_secs(60);
        std::fs::File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(old)
            .unwrap();
        let metadata = std::fs::metadata(&path).unwrap();
        assert_ne!(settled_stamp(&metadata, now), 0);
        assert_eq!(settled_stamp(&metadata, now), file_stamp(&metadata));
        // A stamp ahead of the staging clock is not trusted either.
        assert_eq!(settled_stamp(&metadata, old - Duration::from_secs(60)), 0);
        let _ = std::fs::remove_file(path);
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
    fn run_manifest_staging(target: &Target, base: &Path) {
        let project = base.join("project");
        let workspace = base.join("job");
        let work = workspace.join("project");
        std::fs::create_dir_all(project.join("figures")).unwrap();
        std::fs::write(
            project.join("main.tex"),
            b"\\documentclass{article}\n\\usepackage{graphicx}\n\\newcommand{\\fig}{figures/dot}\n\\begin{document}\n\\includegraphics[width=1cm]{\\fig}\nManifest staging probe.\n\\end{document}\n",
        )
        .unwrap();
        let source = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../samples/latex-on-demand/figures/dot.png");
        std::fs::copy(source, project.join("figures/dot.png")).unwrap();
        let main = std::fs::read(project.join("main.tex")).unwrap();
        let request = NativeCompileRequest {
            job: "manifest-real".into(),
            main_file: "main.tex".into(),
            files: vec![NativeFile {
                path: "main.tex".into(),
                data: STANDARD.encode(main),
            }],
            root: Some(project.to_string_lossy().into_owned()),
            manifest: vec!["main.tex".into(), "figures/dot.png".into()],
            texmf: None,
            clean: false,
        };
        let mut state = WorkspaceState::new(&project, "main.tex", "lualatex");
        let staged = stage(&workspace, &request, &mut state).unwrap();
        assert!(
            work.join("figures/dot.png").is_file(),
            "the manifest image is staged"
        );
        for engine in ["lualatex", "pdflatex", "xelatex"] {
            if !target.has_engine(engine) {
                eprintln!("{engine}: not installed (not run)");
                continue;
            }
            let env = target.environment(&workspace, &work, engine, 0).unwrap();
            let outcome = runner::run(
                &target
                    .spec(
                        engine,
                        engine_arguments(engine, "main.tex"),
                        &work,
                        &env,
                        Duration::from_secs(600),
                    )
                    .unwrap(),
                &AtomicBool::new(false),
            )
            .unwrap();
            assert_eq!(
                outcome.status, 0,
                "{engine} failed with the staged manifest: {}",
                outcome.console
            );
            let pdf = find_output(&work, "main", "pdf").expect("a PDF from the staged manifest");
            assert!(pdf.starts_with(b"%PDF-"), "{engine}: not a PDF");
            eprintln!("{engine}: manifest staging verified");
        }
        let _ = std::fs::remove_dir_all(base);
        let _ = staged;
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "requires MDRAFT_TEST_TEX_BIN to name a real Windows TeX binary directory"]
    fn a_real_windows_distribution_stages_the_manifest_for_every_engine() {
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
            .join(format!("manifest-real-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        run_manifest_staging(&target, &base);
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "requires MDRAFT_TEST_WSL_DISTRO (and optionally MDRAFT_TEST_WSL_BIN)"]
    fn a_wsl_distribution_stages_the_manifest_for_every_engine() {
        let distro = std::env::var("MDRAFT_TEST_WSL_DISTRO").unwrap();
        let bin = std::env::var("MDRAFT_TEST_WSL_BIN").unwrap_or_else(|_| "/usr/bin".into());
        let target = Target::Wsl(wsl::WslInstallation {
            distro,
            bin,
            engines: vec!["lualatex".into(), "pdflatex".into()],
            tools: Vec::new(),
        });
        let base = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target/test-tmp")
            .join(format!("manifest-wsl-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        run_manifest_staging(&target, &base);
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
        assert_eq!(value(&env, "HOME"), Some("/mnt/c/jobs/a, b"));
        assert_eq!(value(&env, "TEXMFHOME"), Some("{../texmf/0}"));
        assert!(
            value(&env, "TEXMFVAR")
                .unwrap()
                .starts_with("/mnt/c/jobs/a, b/")
        );
        let without = wsl_environment("/usr/bin", "/mnt/c/jobs/x", "pdflatex", 0);
        assert_eq!(value(&without, "TEXMFHOME"), Some("/mnt/c/jobs/x/home"));
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
        // A comma, a space and a non-ASCII letter in the job path: search paths
        // are relative, so none of it reaches a search-path expression.
        let job = std::env::temp_dir().join(format!("mdraft-texmf, real ü-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&job);
        let (snapshot, main) = library_fixture(&job);
        let mut state = WorkspaceState::new(&job, "main.tex", "lualatex");
        let roots = stage_texmf(&job.join("texmf"), Some(&snapshot), &mut state).unwrap();
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
        let mut state = WorkspaceState::new(&job, "main.tex", "lualatex");
        let roots = stage_texmf(&job.join("texmf"), Some(&snapshot), &mut state).unwrap();
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
    fn the_bibliography_inputs_track_bib_content() {
        let workspace = temp_case("bib-inputs");
        std::fs::create_dir_all(workspace.join("project")).unwrap();
        std::fs::write(workspace.join("project/refs.bib"), b"@book{a}").unwrap();
        let first = bibliography_inputs(&workspace);
        assert_eq!(first, bibliography_inputs(&workspace));
        std::fs::write(workspace.join("project/refs.bib"), b"@book{b}").unwrap();
        assert_ne!(first, bibliography_inputs(&workspace));
        let _ = std::fs::remove_dir_all(workspace);
    }
}
