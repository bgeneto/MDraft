//! Optional companion Incremental Typst Compiler Service supervisor.
//!
//! Architecture & rationale: [`docs/adr/2026-11-13-typst-incremental-service.md`].
//!
//! - Zero start-up network activity: reads an embedded pinned manifest
//!   (`typst-service.json`), installs into `<app_data_dir>/typst/service/<version>/`
//!   ONLY on explicit user action, and verifies SHA-256 digests before writing or
//!   probing the executable.
//! - Keeps Typst (`Apache-2.0`, ~50 MB) out of the `mdraft` binary.
//! - Runs one persistent daemon per active `workspace_root` using stdio binary
//!   packet framing (`[u32 BE json_len][json][u32 BE body_len][payload]`),
//!   transferring unsaved editor buffers via in-memory VFS overlays so `.mdraft-preview-*`
//!   temp files are never written to disk when the service is active.
//! - Automatically evicts idle/over-RSS workers and falls back transparently to
//!   the stock `typst` CLI if unavailable, crashed, or protocol-mismatched.

use std::collections::{HashMap, VecDeque};
use std::io::{BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::Ordering;
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};

use crate::export::{quiet, sha256_hex};
use crate::typst::{
    CompiledTypst, PREVIEW_SUPERSEDED, PreviewCancel, RenderedTypst, TypstDependency,
    TypstSpanAnchor, TypstTimings, between, bounded_compiler_output, extract_named_binary,
};

const MANIFEST_JSON: &str = include_str!("../typst-service.json");
const ALLOWED_RELEASE_ORIGIN: &str = "https://github.com/bgeneto/MDraft/releases/download/";
const EXPECTED_PROTOCOL_VERSION: u32 = 1;
const DEFAULT_IDLE_TIMEOUT_SECS: u64 = 120;
const DEFAULT_MAX_RSS_MB: u64 = 512;
const MAX_CONCURRENT_WORKERS: usize = 3;
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(600);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_HEADER_BYTES: usize = 32 * 1024 * 1024;
const MAX_BODY_BYTES: usize = 128 * 1024 * 1024;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceManifest {
    pub version: String,
    #[allow(dead_code)]
    pub typst_version: String,
    pub protocol_version: u32,
    pub release_url: String,
    pub assets: HashMap<String, ServiceAsset>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceAsset {
    pub asset_name: String,
    pub archive_type: String,
    pub binary_name: String,
    pub bytes: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TypstServiceStatus {
    pub installed: bool,
    pub enabled: bool,
    pub active: bool,
    pub running_workers: usize,
    pub version: Option<String>,
    pub typst_version: Option<String>,
    pub protocol_version: Option<u32>,
    pub path: Option<String>,
    pub can_install: bool,
    pub manifest_version: String,
    pub hint: String,
    pub rss_bytes: Option<u64>,
    pub compile_count: u64,
}

#[derive(Debug, Clone)]
struct ProbeInfo {
    version: String,
    typst_version: String,
    protocol_version: u32,
}

pub(crate) struct RenderRequest<'a> {
    pub root: &'a Path,
    pub main_file: Option<&'a Path>,
    pub source: &'a str,
    pub mode: &'a str,
    pub cancel: Option<&'a PreviewCancel>,
}

// ---------------------------------------------------------------------------
// Wire protocol structs (must stay in sync with tools/mdraft-typst-service)
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(tag = "method", rename_all = "snake_case")]
enum WireMethod<'a> {
    Compile(WireCompileParams<'a>),
    EvictCache {
        #[serde(rename = "maxAge")]
        max_age: usize,
    },
    Shutdown,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WireCompileParams<'a> {
    main_path: &'a str,
    root: Option<&'a str>,
    target: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    source_text: Option<&'a str>,
    clear_unspecified_overlays: bool,
    fallback_to_pages_if_ignored: bool,
    tagged_pdf: bool,
    include_span_map: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WireRequest<'a> {
    id: u64,
    #[serde(flatten)]
    call: WireMethod<'a>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireResponse {
    protocol_version: u32,
    id: u64,
    ok: bool,
    error: Option<String>,
    compile: Option<WireCompileResult>,
    stats: Option<WireServiceStats>,
    #[allow(dead_code)]
    payload_bytes: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireCompileResult {
    kind: String,
    #[serde(default)]
    fell_back_from_document: bool,
    #[serde(default)]
    warnings: Vec<String>,
    #[serde(default)]
    errors: Vec<String>,
    #[serde(default)]
    ignored: Vec<String>,
    #[serde(default)]
    page_hashes: Vec<String>,
    first_changed_page: Option<usize>,
    #[serde(default)]
    changed_pages: Vec<usize>,
    #[serde(default)]
    deps: Vec<TypstDependency>,
    #[serde(default)]
    span_map: Vec<TypstSpanAnchor>,
    #[serde(default)]
    timings: TypstTimings,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireServiceStats {
    #[allow(dead_code)]
    compile_count: u64,
    rss_bytes: Option<u64>,
}

fn read_packet<R: Read>(reader: &mut R) -> std::io::Result<Option<(Vec<u8>, Vec<u8>)>> {
    let mut len_buf = [0u8; 4];
    match reader.read_exact(&mut len_buf) {
        Ok(()) => {}
        Err(err) if err.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(err) => return Err(err),
    }
    let header_len = u32::from_be_bytes(len_buf) as usize;
    if header_len == 0 || header_len > MAX_HEADER_BYTES {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("invalid service header length {header_len}"),
        ));
    }
    let mut header = vec![0u8; header_len];
    reader.read_exact(&mut header)?;

    reader.read_exact(&mut len_buf)?;
    let body_len = u32::from_be_bytes(len_buf) as usize;
    if body_len > MAX_BODY_BYTES {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("invalid service payload length {body_len}"),
        ));
    }
    let mut body = vec![0u8; body_len];
    if body_len > 0 {
        reader.read_exact(&mut body)?;
    }
    Ok(Some((header, body)))
}

fn write_packet<W: Write>(writer: &mut W, header: &[u8], payload: &[u8]) -> std::io::Result<()> {
    let h_len = u32::try_from(header.len()).map_err(|_| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "service header too large")
    })?;
    let p_len = u32::try_from(payload.len()).map_err(|_| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "service payload too large")
    })?;
    writer.write_all(&h_len.to_be_bytes())?;
    writer.write_all(header)?;
    writer.write_all(&p_len.to_be_bytes())?;
    writer.write_all(payload)?;
    writer.flush()
}

// ---------------------------------------------------------------------------
// Manifest & installation
// ---------------------------------------------------------------------------

pub fn service_exe() -> &'static str {
    if cfg!(windows) {
        "mdraft-typst-service.exe"
    } else {
        "mdraft-typst-service"
    }
}

fn current_target_triple() -> Option<&'static str> {
    if cfg!(all(windows, target_arch = "x86_64")) {
        Some("x86_64-pc-windows-msvc")
    } else if cfg!(all(windows, target_arch = "aarch64")) {
        Some("aarch64-pc-windows-msvc")
    } else if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
        Some("x86_64-unknown-linux-musl")
    } else if cfg!(all(target_os = "linux", target_arch = "aarch64")) {
        Some("aarch64-unknown-linux-musl")
    } else if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
        Some("x86_64-apple-darwin")
    } else if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        Some("aarch64-apple-darwin")
    } else {
        None
    }
}

fn load_manifest() -> Result<ServiceManifest, String> {
    let manifest: ServiceManifest = serde_json::from_str(MANIFEST_JSON)
        .map_err(|e| format!("Invalid pinned typst-service manifest: {e}"))?;
    if manifest.protocol_version != EXPECTED_PROTOCOL_VERSION {
        return Err(format!(
            "Unsupported typst-service manifest protocol version {} (expected {}).",
            manifest.protocol_version, EXPECTED_PROTOCOL_VERSION
        ));
    }
    Ok(manifest)
}

fn is_valid_published_digest(hex: &str) -> bool {
    let hex = hex.trim();
    hex.len() == 64 && hex.bytes().all(|b| b.is_ascii_hexdigit()) && !hex.bytes().all(|b| b == b'0')
}

pub fn service_root<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|d| d.join("typst").join("service"))
}

fn managed_service_in_dir(root: &Path) -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = std::fs::read_dir(root)
        .ok()?
        .filter_map(Result::ok)
        .map(|entry| entry.path().join(service_exe()))
        .filter(|path| path.is_file())
        .collect();
    candidates.sort();
    candidates.pop()
}

fn probe_service(path: &Path) -> Option<ProbeInfo> {
    let output = quiet(&mut Command::new(path)).arg("--version").output().ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    parse_version_line(text.lines().next()?.trim())
}

/// Parses `"mdraft-typst-service 0.1.0 (typst 0.15.1, protocol 1)"`.
fn parse_version_line(line: &str) -> Option<ProbeInfo> {
    let rest = line.strip_prefix("mdraft-typst-service ")?;
    let (version, meta) = rest.split_once(" (")?;
    let meta = meta.strip_suffix(')')?;
    let mut typst_version = None;
    let mut protocol_version = None;
    for part in meta.split(',') {
        let part = part.trim();
        if let Some(tv) = part.strip_prefix("typst ") {
            typst_version = Some(tv.trim().to_string());
        } else if let Some(pv) = part.strip_prefix("protocol ") {
            protocol_version = pv.trim().parse::<u32>().ok();
        }
    }
    let protocol_version = protocol_version?;
    if protocol_version != EXPECTED_PROTOCOL_VERSION {
        return None;
    }
    Some(ProbeInfo {
        version: version.trim().to_string(),
        typst_version: typst_version?,
        protocol_version,
    })
}

fn find_service<R: Runtime>(app: &AppHandle<R>) -> Option<(PathBuf, ProbeInfo)> {
    let root = service_root(app)?;
    let path = managed_service_in_dir(&root)?;
    let info = probe_service(&path)?;
    Some((path, info))
}

fn is_enabled<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.try_state::<crate::settings::AppState>()
        .and_then(|state| state.settings.lock().ok().map(|s| s.typst_incremental_service))
        .unwrap_or(false)
}

pub fn status<R: Runtime>(app: &AppHandle<R>) -> TypstServiceStatus {
    let enabled = is_enabled(app);
    let manifest = load_manifest().ok();
    let manifest_version = manifest
        .as_ref()
        .map(|m| m.version.clone())
        .unwrap_or_else(|| "unknown".into());
    let can_install = manifest.as_ref().is_some_and(|m| {
        current_target_triple()
            .and_then(|t| m.assets.get(t))
            .is_some_and(|asset| is_valid_published_digest(&asset.sha256))
    });

    let supervisor_stats = supervisor().snapshot_stats();

    match find_service(app) {
        Some((path, info)) => TypstServiceStatus {
            installed: true,
            enabled,
            active: supervisor_stats.running_workers > 0,
            running_workers: supervisor_stats.running_workers,
            version: Some(info.version),
            typst_version: Some(info.typst_version),
            protocol_version: Some(info.protocol_version),
            path: Some(path.to_string_lossy().into_owned()),
            can_install,
            manifest_version,
            hint: if enabled {
                if supervisor_stats.running_workers > 0 {
                    format!(
                        "Incremental service active ({} worker{}, {} compiles).",
                        supervisor_stats.running_workers,
                        if supervisor_stats.running_workers == 1 {
                            ""
                        } else {
                            "s"
                        },
                        supervisor_stats.compile_count
                    )
                } else {
                    "Installed and enabled. Spawns lazily on the next Typst preview edit.".into()
                }
            } else {
                "Installed. Enable \"Incremental Typst compiler service\" above to activate warm previews."
                    .into()
            },
            rss_bytes: supervisor_stats.rss_bytes,
            compile_count: supervisor_stats.compile_count,
        },
        None => TypstServiceStatus {
            installed: false,
            enabled,
            active: false,
            running_workers: 0,
            version: None,
            typst_version: None,
            protocol_version: None,
            path: None,
            can_install,
            manifest_version: manifest_version.clone(),
            hint: if can_install {
                format!(
                    "Not installed. Optional companion daemon ({manifest_version}) reduces warm Typst compile latency; stock Typst CLI remains the automatic fallback."
                )
            } else {
                format!(
                    "Not installed (awaiting published release checksum for {manifest_version}). Stock Typst CLI handles all previews automatically."
                )
            },
            rss_bytes: None,
            compile_count: 0,
        },
    }
}

#[tauri::command]
pub fn typst_service_status<R: Runtime>(app: AppHandle<R>) -> TypstServiceStatus {
    status(&app)
}

static SERVICE_INSTALL: Mutex<()> = Mutex::new(());

fn http_agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(DOWNLOAD_TIMEOUT))
        .user_agent(concat!("MDraft/", env!("CARGO_PKG_VERSION")))
        .build()
        .into()
}

fn install_with_manifest_into<F>(
    manifest: &ServiceManifest,
    target_triple: &str,
    install_root: &Path,
    allow_untrusted_origin: bool,
    probe: F,
) -> Result<PathBuf, String>
where
    F: Fn(&Path) -> Option<ProbeInfo>,
{
    if manifest.protocol_version != EXPECTED_PROTOCOL_VERSION {
        return Err(format!(
            "Companion service manifest targets protocol {} (app requires {}).",
            manifest.protocol_version, EXPECTED_PROTOCOL_VERSION
        ));
    }
    if !allow_untrusted_origin && !manifest.release_url.starts_with(ALLOWED_RELEASE_ORIGIN) {
        return Err(format!(
            "Refusing to download Typst service from untrusted origin: {}",
            manifest.release_url
        ));
    }
    let asset = manifest.assets.get(target_triple).ok_or_else(|| {
        format!("No prebuilt Typst companion service is configured for {target_triple}.")
    })?;
    let expected_archive = if cfg!(target_os = "linux") {
        "tar.xz"
    } else {
        "zip"
    };
    if asset.archive_type != expected_archive {
        return Err(format!(
            "Unsupported archive type {} for {target_triple} (expected {expected_archive}).",
            asset.archive_type
        ));
    }

    if !is_valid_published_digest(&asset.sha256) {
        return Err(format!(
            "The pinned SHA-256 digest for {} is not yet published in typst-service.json; automatic download is disabled until a release checksum is pinned.",
            asset.asset_name
        ));
    }

    let base = manifest.release_url.trim_end_matches('/');
    let url = format!("{base}/{}", asset.asset_name);
    let archive = http_agent()
        .get(&url)
        .call()
        .map_err(|e| format!("Could not download Typst service from {url}: {e}"))?
        .body_mut()
        .with_config()
        .limit(256 * 1024 * 1024)
        .read_to_vec()
        .map_err(|e| format!("Could not read Typst service download: {e}"))?;

    if asset.bytes > 0 && archive.len() as u64 != asset.bytes {
        return Err(format!(
            "Downloaded Typst service archive size mismatch (expected {} bytes, got {}).",
            asset.bytes,
            archive.len()
        ));
    }

    let expected = asset.sha256.trim().to_ascii_lowercase();
    let actual = sha256_hex(&archive);
    if actual != expected {
        return Err(format!(
            "The downloaded Typst service archive failed SHA-256 verification and was discarded.\n expected {expected}\n got      {actual}"
        ));
    }

    let binary = extract_named_binary(&archive, &asset.binary_name)?;
    let dir = install_root.join(&manifest.version);
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    let target = dir.join(&asset.binary_name);
    crate::latex::write_atomic(&target, &binary)
        .map_err(|e| format!("Could not write {}: {e}", target.display()))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o755));
    }

    if probe(&target).is_none() {
        let _ = std::fs::remove_file(&target);
        return Err(
            "Typst companion service was downloaded and verified but failed protocol verification."
                .into(),
        );
    }

    Ok(target)
}

#[tauri::command]
pub async fn install_typst_service<R: Runtime>(
    app: AppHandle<R>,
) -> Result<TypstServiceStatus, String> {
    tauri::async_runtime::spawn_blocking(move || install(&app))
        .await
        .map_err(|e| format!("The Typst service install task could not be started: {e}"))?
}

fn install<R: Runtime>(app: &AppHandle<R>) -> Result<TypstServiceStatus, String> {
    let _guard = SERVICE_INSTALL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let manifest = load_manifest()?;
    let target_triple = current_target_triple().ok_or_else(|| {
        "The incremental Typst companion service has no prebuilt binary for this platform.".to_string()
    })?;
    let root = service_root(app).ok_or_else(|| {
        "The application could not determine app_data_dir for the Typst service.".to_string()
    })?;

    let _installed_path =
        install_with_manifest_into(&manifest, target_triple, &root, false, probe_service)?;
    // Restart any stale workers so subsequent compiles pick up the newly installed binary.
    supervisor().shutdown_all();
    Ok(status(app))
}

#[tauri::command]
pub async fn typst_clear_cache<R: Runtime>(app: AppHandle<R>) -> Result<u64, String> {
    tauri::async_runtime::spawn_blocking(move || Ok(clear_cache(&app)))
        .await
        .map_err(|e| format!("The Typst cache clear task could not be started: {e}"))?
}

fn clear_cache<R: Runtime>(app: &AppHandle<R>) -> u64 {
    let mut freed = supervisor().evict_all_caches();

    let mut dirs_to_clean = vec![std::env::temp_dir().join("mdraft-typst")];
    if let Ok(cache_dir) = app.path().app_cache_dir() {
        dirs_to_clean.push(cache_dir.join("typst"));
    }
    if let Ok(data_dir) = app.path().app_data_dir() {
        dirs_to_clean.push(data_dir.join("typst").join("cache"));
    }

    for dir in dirs_to_clean {
        freed = freed.saturating_add(remove_dir_contents(&dir));
    }
    freed
}

fn remove_dir_contents(dir: &Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    let mut freed: u64 = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        if let Ok(meta) = entry.metadata() {
            if meta.is_file() {
                let len = meta.len();
                if std::fs::remove_file(&path).is_ok() {
                    freed = freed.saturating_add(len);
                }
            } else if meta.is_dir() {
                let sub = dir_size(&path);
                if std::fs::remove_dir_all(&path).is_ok() {
                    freed = freed.saturating_add(sub);
                }
            }
        }
    }
    freed
}

fn dir_size(dir: &Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    let mut total: u64 = 0;
    for entry in entries.flatten() {
        if let Ok(meta) = entry.metadata() {
            if meta.is_file() {
                total = total.saturating_add(meta.len());
            } else if meta.is_dir() {
                total = total.saturating_add(dir_size(&entry.path()));
            }
        }
    }
    total
}

// ---------------------------------------------------------------------------
// Persistent workspace-keyed daemon supervisor
// ---------------------------------------------------------------------------

struct WorkerProcess {
    child: Child,
    stdin: Option<BufWriter<ChildStdin>>,
    stdout: Option<BufReader<ChildStdout>>,
    next_id: u64,
    last_used: Instant,
    last_rss_bytes: Option<u64>,
    compile_count: u64,
    stderr_tail: Arc<Mutex<String>>,
}

impl WorkerProcess {
    fn spawn(binary: &Path, root: &Path) -> Result<Self, String> {
        let mut cmd = Command::new(binary);
        quiet(&mut cmd)
            .arg("--stdio")
            .arg("--framing")
            .arg("packet")
            .arg("--root")
            .arg(root)
            .arg("--idle-timeout")
            .arg(DEFAULT_IDLE_TIMEOUT_SECS.to_string())
            .arg("--max-rss-mb")
            .arg(DEFAULT_MAX_RSS_MB.to_string())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Could not spawn Typst service {}: {e}", binary.display()))?;
        let stdin = child
            .stdin
            .take()
            .map(BufWriter::new)
            .ok_or_else(|| "Typst service stdin pipe was unavailable.".to_string())?;
        let stdout = child
            .stdout
            .take()
            .map(BufReader::new)
            .ok_or_else(|| "Typst service stdout pipe was unavailable.".to_string())?;

        let stderr_tail = Arc::new(Mutex::new(String::new()));
        if let Some(mut err_pipe) = child.stderr.take() {
            let tail_ref = Arc::clone(&stderr_tail);
            std::thread::spawn(move || {
                let mut buf = [0u8; 1024];
                loop {
                    match err_pipe.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            let chunk = String::from_utf8_lossy(&buf[..n]);
                            if let Ok(mut guard) = tail_ref.lock() {
                                guard.push_str(&chunk);
                                if guard.len() > 4096 {
                                    let mut cut = guard.len() - 4096;
                                    while !guard.is_char_boundary(cut) && cut < guard.len() {
                                        cut += 1;
                                    }
                                    guard.drain(..cut);
                                }
                            }
                        }
                    }
                }
            });
        }

        Ok(Self {
            child,
            stdin: Some(stdin),
            stdout: Some(stdout),
            next_id: 1,
            last_used: Instant::now(),
            last_rss_bytes: None,
            compile_count: 0,
            stderr_tail,
        })
    }

    fn is_alive(&mut self) -> bool {
        if self.last_used.elapsed() > Duration::from_secs(DEFAULT_IDLE_TIMEOUT_SECS + 5) {
            return false;
        }
        matches!(self.child.try_wait(), Ok(None))
    }

    fn request(
        &mut self,
        req_builder: impl FnOnce(u64) -> Result<Vec<u8>, String>,
        payload: &[u8],
        cancel: Option<&PreviewCancel>,
        timeout: Duration,
    ) -> Result<(WireResponse, Vec<u8>), String> {
        if cancel.is_some_and(|c| c.load(Ordering::Relaxed)) {
            return Err(PREVIEW_SUPERSEDED.to_string());
        }

        let id = self.next_id;
        self.next_id = self.next_id.saturating_add(1);
        let header = req_builder(id)?;

        let mut stdin = self
            .stdin
            .take()
            .ok_or_else(|| "Typst service stdin already closed.".to_string())?;
        let mut stdout = self
            .stdout
            .take()
            .ok_or_else(|| "Typst service stdout already closed.".to_string())?;

        let done_signal = Arc::new((Mutex::new(false), Condvar::new()));
        let _cancel_guard = cancel.map(|c| c.subscribe(Arc::clone(&done_signal)));

        let io_result = std::thread::scope(|scope| {
            let signal_for_io = Arc::clone(&done_signal);
            let io_handle = scope.spawn(move || {
                let res = (|| -> Result<(Vec<u8>, Vec<u8>), String> {
                    write_packet(&mut stdin, &header, payload)
                        .map_err(|e| format!("Failed writing request to Typst service: {e}"))?;
                    match read_packet(&mut stdout) {
                        Ok(Some(packet)) => Ok(packet),
                        Ok(None) => Err("Typst service closed its stream unexpectedly.".into()),
                        Err(e) => Err(format!("Failed reading response from Typst service: {e}")),
                    }
                })();
                {
                    let (lock, cvar) = &*signal_for_io;
                    if let Ok(mut done) = lock.lock() {
                        *done = true;
                    }
                    cvar.notify_all();
                }
                (stdin, stdout, res)
            });

            let deadline = Instant::now() + timeout;
            let (lock, cvar) = &*done_signal;
            let mut aborted_reason: Option<String> = None;
            {
                let mut guard = lock
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                while !*guard {
                    if cancel.is_some_and(|c| c.load(Ordering::Relaxed)) {
                        aborted_reason = Some(PREVIEW_SUPERSEDED.to_string());
                        break;
                    }
                    let now = Instant::now();
                    if now >= deadline {
                        aborted_reason = Some(format!(
                            "Typst service did not respond within {} seconds and was stopped.",
                            timeout.as_secs()
                        ));
                        break;
                    }
                    let (next_guard, wait_res) = cvar
                        .wait_timeout(guard, deadline.saturating_duration_since(now))
                        .unwrap_or_else(|poisoned| poisoned.into_inner());
                    guard = next_guard;
                    if wait_res.timed_out()
                        && !*guard
                        && cancel.is_none_or(|c| !c.load(Ordering::Relaxed))
                    {
                        aborted_reason = Some(format!(
                            "Typst service did not respond within {} seconds and was stopped.",
                            timeout.as_secs()
                        ));
                        break;
                    }
                }
            }

            if let Some(reason) = aborted_reason {
                // Killing the daemon closes its pipes so `io_handle` unblocks cleanly.
                let _ = self.child.kill();
                let _ = io_handle.join();
                let _ = self.child.wait();
                return Err(reason);
            }

            let (ret_stdin, ret_stdout, packet_res) = io_handle
                .join()
                .map_err(|_| "Typst service IO task panicked.".to_string())?;
            self.stdin = Some(ret_stdin);
            self.stdout = Some(ret_stdout);
            packet_res
        })?;

        let (resp_json, resp_body) = io_result;
        let resp: WireResponse = serde_json::from_slice(&resp_json)
            .map_err(|e| format!("Invalid JSON response from Typst service: {e}"))?;
        if resp.protocol_version != EXPECTED_PROTOCOL_VERSION {
            return Err(format!(
                "Typst service protocol mismatch: got {}, expected {}",
                resp.protocol_version, EXPECTED_PROTOCOL_VERSION
            ));
        }
        if resp.id != id {
            return Err(format!(
                "Typst service response ID mismatch: got {}, expected {id}",
                resp.id
            ));
        }

        self.last_used = Instant::now();
        if let Some(stats) = &resp.stats {
            self.last_rss_bytes = stats.rss_bytes;
            self.compile_count = stats.compile_count;
        }
        Ok((resp, resp_body))
    }

    fn evict_cache(&mut self) -> u64 {
        let rss_before = self.last_rss_bytes;
        let result = self.request(
            |id| {
                serde_json::to_vec(&WireRequest {
                    id,
                    call: WireMethod::EvictCache { max_age: 0 },
                })
                .map_err(|e| e.to_string())
            },
            &[],
            None,
            Duration::from_secs(5),
        );
        if let Ok((resp, _)) = result
            && let Some(stats) = resp.stats
            && let (Some(before), Some(after)) = (rss_before, stats.rss_bytes)
        {
            return before.saturating_sub(after);
        }
        0
    }
}

impl Drop for WorkerProcess {
    fn drop(&mut self) {
        if let Some(mut stdin) = self.stdin.take() {
            let id = self.next_id;
            if let Ok(header) = serde_json::to_vec(&WireRequest {
                id,
                call: WireMethod::Shutdown,
            }) {
                let _ = write_packet(&mut stdin, &header, &[]);
            }
            drop(stdin);
        }
        if matches!(self.child.try_wait(), Ok(None)) {
            let _ = self.child.kill();
        }
        let _ = self.child.wait();
        let _ = &self.stderr_tail;
    }
}

fn normalize_workspace_key(root: &Path) -> PathBuf {
    let canon = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    #[cfg(windows)]
    {
        let raw = canon.to_string_lossy();
        let trimmed = raw.strip_prefix(r"\\?\").unwrap_or(&raw).to_lowercase();
        PathBuf::from(trimmed)
    }
    #[cfg(not(windows))]
    {
        canon
    }
}

type WorkerSlot = Arc<Mutex<Option<WorkerProcess>>>;

struct SnapshotStats {
    running_workers: usize,
    rss_bytes: Option<u64>,
    compile_count: u64,
}

#[derive(Default)]
struct SupervisorInner {
    workers: HashMap<PathBuf, WorkerSlot>,
    lru: VecDeque<PathBuf>,
    retired_compiles: u64,
}

pub(crate) struct ServiceSupervisor {
    inner: Mutex<SupervisorInner>,
}

impl ServiceSupervisor {
    fn new() -> Self {
        Self {
            inner: Mutex::new(SupervisorInner::default()),
        }
    }

    fn slot_for(&self, root: &Path) -> (WorkerSlot, Vec<WorkerSlot>) {
        let key = normalize_workspace_key(root);
        let mut guard = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        guard.lru.retain(|k| k != &key);
        guard.lru.push_back(key.clone());

        let slot = guard
            .workers
            .entry(key)
            .or_insert_with(|| Arc::new(Mutex::new(None)))
            .clone();

        let mut evicted_slots = Vec::new();
        while guard.lru.len() > MAX_CONCURRENT_WORKERS {
            if let Some(old_key) = guard.lru.pop_front()
                && let Some(old_slot) = guard.workers.remove(&old_key)
            {
                evicted_slots.push(old_slot);
            }
        }
        (slot, evicted_slots)
    }

    fn shutdown_all(&self) {
        let slots: Vec<WorkerSlot> = {
            let mut guard = self
                .inner
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            guard.lru.clear();
            guard.workers.drain().map(|(_, s)| s).collect()
        };
        for slot in slots {
            if let Ok(mut worker_opt) = slot.lock()
                && let Some(worker) = worker_opt.take()
            {
                self.record_retired(&worker);
                drop(worker);
            }
        }
    }

    fn record_retired(&self, worker: &WorkerProcess) {
        if let Ok(mut guard) = self.inner.lock() {
            guard.retired_compiles = guard.retired_compiles.saturating_add(worker.compile_count);
        }
    }

    fn evict_all_caches(&self) -> u64 {
        let slots: Vec<WorkerSlot> = {
            let guard = self
                .inner
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            guard.workers.values().cloned().collect()
        };
        let mut freed: u64 = 0;
        for slot in slots {
            if let Ok(mut worker_opt) = slot.lock()
                && let Some(worker) = worker_opt.as_mut()
                && worker.is_alive()
            {
                freed = freed.saturating_add(worker.evict_cache());
            }
        }
        freed
    }

    fn snapshot_stats(&self) -> SnapshotStats {
        let (slots, retired) = {
            let guard = self
                .inner
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            (
                guard.workers.values().cloned().collect::<Vec<_>>(),
                guard.retired_compiles,
            )
        };
        let mut running_workers = 0usize;
        let mut rss_total = 0u64;
        let mut has_rss = false;
        let mut compile_count = retired;
        for slot in slots {
            if let Ok(mut guard) = slot.try_lock()
                && let Some(worker) = guard.as_mut()
            {
                if worker.is_alive() {
                    running_workers += 1;
                    if let Some(rss) = worker.last_rss_bytes {
                        rss_total = rss_total.saturating_add(rss);
                        has_rss = true;
                    }
                    compile_count = compile_count.saturating_add(worker.compile_count);
                } else if let Some(dead) = guard.take() {
                    drop(dead);
                }
            }
        }
        SnapshotStats {
            running_workers,
            rss_bytes: has_rss.then_some(rss_total),
            compile_count,
        }
    }

    pub(crate) fn compile_with_binary(
        &self,
        binary: &Path,
        req: RenderRequest<'_>,
    ) -> Result<CompiledTypst, String> {
        let (slot, evicted_slots) = self.slot_for(req.root);
        for old_slot in evicted_slots {
            if let Ok(mut old_worker) = old_slot.lock()
                && let Some(w) = old_worker.take()
            {
                self.record_retired(&w);
                drop(w);
            }
        }

        let mut worker_guard = slot
            .lock()
            .map_err(|_| "Typst service worker slot mutex was poisoned.".to_string())?;

        if let Some(existing) = worker_guard.as_mut()
            && !existing.is_alive()
            && let Some(dead) = worker_guard.take()
        {
            self.record_retired(&dead);
            drop(dead);
        }

        if worker_guard.is_none() {
            *worker_guard = Some(WorkerProcess::spawn(binary, req.root)?);
        }

        let untitled_main = req.root.join("main.typ");
        let main_path = req.main_file.unwrap_or(&untitled_main);
        let main_path_str = main_path.to_string_lossy();
        let root_str = req.root.to_string_lossy();

        let worker = worker_guard
            .as_mut()
            .ok_or_else(|| "Typst service worker unavailable.".to_string())?;

        let target = if req.mode == "pages" {
            "pages"
        } else {
            "document"
        };

        let run_one = |worker: &mut WorkerProcess,
                       target_mode: &'static str,
                       include_span_map: bool|
         -> Result<(WireResponse, Vec<u8>), String> {
            let (source_text, body) = if req.source.is_empty() {
                (Some(""), &[][..])
            } else {
                (None, req.source.as_bytes())
            };
            worker.request(
                |id| {
                    serde_json::to_vec(&WireRequest {
                        id,
                        call: WireMethod::Compile(WireCompileParams {
                            main_path: &main_path_str,
                            root: Some(&root_str),
                            target: target_mode,
                            source_text,
                            clear_unspecified_overlays: true,
                            fallback_to_pages_if_ignored: false,
                            tagged_pdf: false,
                            include_span_map,
                        }),
                    })
                    .map_err(|e| format!("Could not encode service request: {e}"))
                },
                body,
                req.cancel,
                REQUEST_TIMEOUT,
            )
        };

        let first = run_one(worker, target, target == "pages");
        let (resp, payload) = match first {
            Ok(ok) => ok,
            Err(err) => {
                if let Some(dead) = worker_guard.take() {
                    self.record_retired(&dead);
                    drop(dead);
                }
                return Err(err);
            }
        };

        if !resp.ok {
            let msg = resp
                .error
                .unwrap_or_else(|| "Typst service returned an error.".into());
            return Err(msg);
        }
        let compile = resp
            .compile
            .ok_or_else(|| "Typst service omitted compile metadata.".to_string())?;

        if target == "document" {
            if !compile.errors.is_empty() || payload.is_empty() {
                if req.cancel.is_some_and(|c| c.load(Ordering::Relaxed)) {
                    return Err(PREVIEW_SUPERSEDED.to_string());
                }
                let reason = if compile.errors.is_empty() {
                    "The rendered document had no body.".to_string()
                } else {
                    compile.errors.join("\n")
                };
                let (fb_resp, fb_payload) = match run_one(worker, "pages", true) {
                    Ok(ok) => ok,
                    Err(err) => {
                        if let Some(dead) = worker_guard.take() {
                            self.record_retired(&dead);
                            drop(dead);
                        }
                        return Err(err);
                    }
                };
                if !fb_resp.ok {
                    return Err(fb_resp
                        .error
                        .unwrap_or_else(|| "Typst service fallback failed.".into()));
                }
                let mut fb_compile = fb_resp
                    .compile
                    .ok_or_else(|| "Typst service fallback omitted compile metadata.".to_string())?;
                fb_compile.fell_back_from_document = true;
                fb_compile.warnings.insert(
                    0,
                    format!("The document view was unavailable ({reason})."),
                );
                return compiled_from_wire(fb_compile, fb_payload, Some(binary));
            }

            let html_doc = String::from_utf8(payload)
                .map_err(|e| format!("Typst service returned non-UTF8 HTML: {e}"))?;
            let Some(body) = between(&html_doc, "<body", "</body>").map(|s| s.to_string()) else {
                if req.cancel.is_some_and(|c| c.load(Ordering::Relaxed)) {
                    return Err(PREVIEW_SUPERSEDED.to_string());
                }
                let (fb_resp, fb_payload) = run_one(worker, "pages", true)?;
                if !fb_resp.ok {
                    return Err(fb_resp
                        .error
                        .unwrap_or_else(|| "Typst service fallback failed.".into()));
                }
                let mut fb_compile = fb_resp
                    .compile
                    .ok_or_else(|| "Typst service fallback omitted compile metadata.".to_string())?;
                fb_compile.fell_back_from_document = true;
                fb_compile.warnings.insert(
                    0,
                    "The document view was unavailable (The rendered document had no body.).".into(),
                );
                return compiled_from_wire(fb_compile, fb_payload, Some(binary));
            };
            let css = between(&html_doc, "<style>", "</style>").map(|s| s.to_string());
            let raw_output = format_compiler_output(&compile.warnings, &compile.errors);
            let (compiler_output, compiler_output_truncated) = bounded_compiler_output(&raw_output);
            return Ok(CompiledTypst {
                rendered: RenderedTypst {
                    compiler_output,
                    compiler_output_truncated,
                    kind: "document".into(),
                    html: Some(body),
                    css,
                    pdf: None,
                    warnings: compile.warnings,
                    ignored: compile.ignored,
                    deps: compile.deps,
                    page_hashes: Vec::new(),
                    first_changed_page: None,
                    changed_pages: Vec::new(),
                    span_map: compile.span_map,
                    timings: Some(compile.timings),
                    fell_back_from_document: false,
                    backend_kind: Some("service".into()),
                },
                pdf_bytes: None,
            });
        }

        compiled_from_wire(compile, payload, Some(binary))
    }
}

fn format_compiler_output(warnings: &[String], errors: &[String]) -> String {
    let mut lines = Vec::with_capacity(warnings.len() + errors.len());
    for w in warnings {
        if w.starts_with("warning:") || w.starts_with("error:") {
            lines.push(w.clone());
        } else {
            lines.push(format!("warning: {w}"));
        }
    }
    for e in errors {
        if e.starts_with("error:") {
            lines.push(e.clone());
        } else {
            lines.push(format!("error: {e}"));
        }
    }
    lines.join("\n")
}

fn compiled_from_wire(
    compile: WireCompileResult,
    payload: Vec<u8>,
    _binary: Option<&Path>,
) -> Result<CompiledTypst, String> {
    if !compile.errors.is_empty() && payload.is_empty() {
        return Err(compile.errors.join("\n"));
    }
    if payload.is_empty() {
        return Err("Typst service produced an empty PDF. The document may be empty.".into());
    }
    let raw_output = format_compiler_output(&compile.warnings, &compile.errors);
    let (compiler_output, compiler_output_truncated) = bounded_compiler_output(&raw_output);
    Ok(CompiledTypst {
        rendered: RenderedTypst {
            compiler_output,
            compiler_output_truncated,
            kind: compile.kind,
            html: None,
            css: None,
            pdf: None,
            warnings: compile.warnings,
            ignored: compile.ignored,
            deps: compile.deps,
            page_hashes: compile.page_hashes,
            first_changed_page: compile.first_changed_page,
            changed_pages: compile.changed_pages,
            span_map: compile.span_map,
            timings: Some(compile.timings),
            fell_back_from_document: compile.fell_back_from_document,
            backend_kind: Some("service".into()),
        },
        pdf_bytes: Some(payload),
    })
}

static SUPERVISOR: OnceLock<ServiceSupervisor> = OnceLock::new();

pub(crate) fn supervisor() -> &'static ServiceSupervisor {
    SUPERVISOR.get_or_init(ServiceSupervisor::new)
}

pub fn shutdown_all_services() {
    supervisor().shutdown_all();
}

/// Attempts compilation using the optional companion daemon if enabled in
/// `settings.json` and installed in `app_data_dir/typst/service/`.
///
/// Returns:
/// - `Some(Ok(...))` when the service compiled the preview cleanly.
/// - `Some(Err(...))` when the request was superseded/cancelled OR the document
///   itself had a Typst compilation error (avoiding a redundant slow CLI compile).
/// - `None` when disabled, not installed, or when the companion daemon itself
///   could not execute (crash, broken pipe, protocol mismatch), signaling the
///   caller to fall back seamlessly to stock Typst CLI.
pub(crate) fn try_render<R: Runtime>(
    app: &AppHandle<R>,
    req: RenderRequest<'_>,
) -> Option<Result<CompiledTypst, String>> {
    if !is_enabled(app) {
        return None;
    }
    if req.cancel.is_some_and(|c| c.load(Ordering::Relaxed)) {
        return Some(Err(PREVIEW_SUPERSEDED.to_string()));
    }
    let (binary, _info) = find_service(app)?;
    match supervisor().compile_with_binary(&binary, req) {
        Ok(compiled) => Some(Ok(compiled)),
        Err(err) if err == PREVIEW_SUPERSEDED => Some(Err(err)),
        Err(err) => {
            // Distinguish user Typst source errors from transport/daemon failures.
            let is_transport_failure = err.starts_with("Could not spawn Typst service")
                || err.starts_with("Typst service closed")
                || err.starts_with("Failed writing request")
                || err.starts_with("Failed reading response")
                || err.starts_with("Invalid JSON response")
                || err.starts_with("Typst service protocol mismatch")
                || err.starts_with("Typst service response ID mismatch")
                || err.starts_with("Typst service IO task panicked")
                || err.starts_with("Typst service stdin")
                || err.starts_with("Typst service stdout")
                || err.starts_with("Typst service did not respond");
            if is_transport_failure {
                None
            } else {
                Some(Err(err))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    use std::net::TcpListener;

    #[test]
    fn manifest_json_parses_all_supported_platforms() {
        let manifest = load_manifest().expect("embedded typst-service.json must parse");
        assert_eq!(manifest.protocol_version, EXPECTED_PROTOCOL_VERSION);
        assert_eq!(manifest.typst_version, "0.15.1");
        assert!(manifest.release_url.starts_with(ALLOWED_RELEASE_ORIGIN));
        for target in [
            "x86_64-pc-windows-msvc",
            "aarch64-pc-windows-msvc",
            "x86_64-unknown-linux-musl",
            "aarch64-unknown-linux-musl",
            "x86_64-apple-darwin",
            "aarch64-apple-darwin",
        ] {
            assert!(
                manifest.assets.contains_key(target),
                "missing asset definition for {target}"
            );
        }
    }

    #[test]
    fn parses_version_output_strictly() {
        let ok = parse_version_line("mdraft-typst-service 0.1.0 (typst 0.15.1, protocol 1)")
            .expect("valid version line must parse");
        assert_eq!(ok.version, "0.1.0");
        assert_eq!(ok.typst_version, "0.15.1");
        assert_eq!(ok.protocol_version, 1);
        assert!(
            parse_version_line("mdraft-typst-service 0.1.0 (typst 0.15.1, protocol 99)").is_none(),
            "incompatible protocol version must fail closed"
        );
    }

    #[test]
    fn refuses_placeholder_digest_and_untrusted_origin_before_network() {
        let tmp = std::env::temp_dir().join(format!(
            "mdraft_typst_service_digest_test_{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();

        let embedded = load_manifest().unwrap();
        let target = current_target_triple().unwrap_or("x86_64-pc-windows-msvc");
        let err = install_with_manifest_into(&embedded, target, &tmp, false, |_| None).unwrap_err();
        assert!(
            err.contains("not yet published"),
            "unexpected error for placeholder digest: {err}"
        );

        let mut evil = embedded;
        evil.release_url = "https://evil.example/downloads/".into();
        let origin_err =
            install_with_manifest_into(&evil, target, &tmp, false, |_| None).unwrap_err();
        assert!(origin_err.contains("untrusted origin"));

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[cfg(any(target_os = "windows", target_os = "macos"))]
    #[test]
    fn loopback_download_verifies_sha256_unpacks_and_cleans_bad_probe() {
        use std::io::Write as _;

        let tmp = std::env::temp_dir().join(format!(
            "mdraft_typst_service_loopback_{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();

        let payload = b"MZ-fake-service-binary-bytes";
        let mut zip_buf = Vec::new();
        {
            let mut zip = zip::ZipWriter::new(Cursor::new(&mut zip_buf));
            let opts = zip::write::SimpleFileOptions::default();
            zip.start_file(format!("bundle/{}", service_exe()), opts)
                .unwrap();
            zip.write_all(payload).unwrap();
            zip.finish().unwrap();
        }
        let real_hash = sha256_hex(&zip_buf);

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let served_bytes = zip_buf.clone();
        let server = std::thread::spawn(move || {
            for _ in 0..3 {
                if let Ok((mut stream, _)) = listener.accept() {
                    let mut req_buf = [0u8; 1024];
                    let _ = stream.read(&mut req_buf);
                    let header = format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        served_bytes.len()
                    );
                    let _ = stream.write_all(header.as_bytes());
                    let _ = stream.write_all(&served_bytes);
                }
            }
        });

        let target = current_target_triple().unwrap();
        let mut assets = HashMap::new();
        assets.insert(
            target.to_string(),
            ServiceAsset {
                asset_name: "service.zip".into(),
                archive_type: "zip".into(),
                binary_name: service_exe().into(),
                bytes: zip_buf.len() as u64,
                sha256: "f".repeat(64),
            },
        );
        let mut manifest = ServiceManifest {
            version: "0.1.0-test".into(),
            typst_version: "0.15.1".into(),
            protocol_version: 1,
            release_url: format!("http://{addr}/"),
            assets,
        };

        // 1. Mismatched SHA-256 must fail and leave target clean.
        let mismatch =
            install_with_manifest_into(&manifest, target, &tmp, true, |_| None).unwrap_err();
        assert!(mismatch.contains("failed SHA-256 verification"));
        assert!(!tmp.join("0.1.0-test").join(service_exe()).exists());

        // 2. Correct SHA-256 + failing probe must unlink binary.
        manifest.assets.get_mut(target).unwrap().sha256 = real_hash;
        let bad_probe =
            install_with_manifest_into(&manifest, target, &tmp, true, |_| None).unwrap_err();
        assert!(bad_probe.contains("failed protocol verification"));
        assert!(!tmp.join("0.1.0-test").join(service_exe()).exists());

        // 3. Correct SHA-256 + passing probe installs cleanly.
        let installed = install_with_manifest_into(&manifest, target, &tmp, true, |_| {
            Some(ProbeInfo {
                version: "0.1.0-test".into(),
                typst_version: "0.15.1".into(),
                protocol_version: 1,
            })
        })
        .expect("verified loopback install must succeed");
        assert_eq!(std::fs::read(&installed).unwrap(), payload);

        server.join().unwrap();
        let _ = std::fs::remove_dir_all(&tmp);
    }

    fn locate_built_service_binary() -> Option<PathBuf> {
        let mut candidates = Vec::new();
        if let Ok(target_dir) = std::env::var("CARGO_TARGET_DIR") {
            let td = PathBuf::from(target_dir);
            candidates.push(td.join("release").join(service_exe()));
            candidates.push(td.join("debug").join(service_exe()));
        }
        if let Ok(exe) = std::env::current_exe()
            && let Some(profile_dir) = exe.parent().and_then(|d| d.parent())
            && let Some(target_dir) = profile_dir.parent()
        {
            candidates.push(target_dir.join("release").join(service_exe()));
            candidates.push(target_dir.join("debug").join(service_exe()));
        }
        let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .to_path_buf();
        candidates.push(
            repo_root
                .join("tools")
                .join("mdraft-typst-service")
                .join("target")
                .join("release")
                .join(service_exe()),
        );
        candidates.push(
            repo_root
                .join("tools")
                .join("mdraft-typst-service")
                .join("target")
                .join("debug")
                .join(service_exe()),
        );
        candidates
            .into_iter()
            .find(|p| p.is_file() && probe_service(p).is_some())
    }

    #[test]
    fn daemon_supervisor_compiles_multi_file_vfs_and_recovers_after_kill() {
        let Some(binary) = locate_built_service_binary() else {
            return;
        };
        let ws = std::env::temp_dir().join(format!(
            "mdraft_typst_daemon_integration_{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&ws);
        let chapters = ws.join("chapters");
        std::fs::create_dir_all(&chapters).unwrap();
        std::fs::write(ws.join("shared.typ"), "#let greet(name) = [Hello *#name*!]").unwrap();
        let ch1 = chapters.join("ch1.typ");
        std::fs::write(&ch1, "= Chapter 1\nOld content on disk.\n").unwrap();

        let sup = ServiceSupervisor::new();
        let unsaved_v1 = "#import \"../shared.typ\": greet\n= Chapter 1\n#greet(\"MDraft\")\n#pagebreak()\n= Page 2\nTail line 1.";
        let res1 = sup
            .compile_with_binary(
                &binary,
                RenderRequest {
                    root: &ws,
                    main_file: Some(&ch1),
                    source: unsaved_v1,
                    mode: "pages",
                    cancel: None,
                },
            )
            .expect("warm daemon compile 1 must succeed");
        assert_eq!(res1.rendered.kind, "pages");
        assert_eq!(res1.rendered.page_hashes.len(), 2);
        assert!(!res1.rendered.deps.is_empty(), "deps must record shared.typ");
        assert!(
            !res1.rendered.span_map.is_empty(),
            "span_map must include AST span anchors"
        );
        assert!(res1.pdf_bytes.as_ref().is_some_and(|b| b.starts_with(b"%PDF")));
        // Zero `.mdraft-preview-*` temp files written beside ch1.typ!
        let has_preview_temp = std::fs::read_dir(&chapters)
            .unwrap()
            .flatten()
            .any(|e| e.file_name().to_string_lossy().starts_with(".mdraft-preview-"));
        assert!(!has_preview_temp, "service must never write .mdraft-preview-* to disk");

        // Second compile only mutating page 2 preserves page 1 hash!
        let unsaved_v2 = "#import \"../shared.typ\": greet\n= Chapter 1\n#greet(\"MDraft\")\n#pagebreak()\n= Page 2\nTail line edited.";
        let res2 = sup
            .compile_with_binary(
                &binary,
                RenderRequest {
                    root: &ws,
                    main_file: Some(&ch1),
                    source: unsaved_v2,
                    mode: "pages",
                    cancel: None,
                },
            )
            .expect("warm daemon compile 2 must succeed");
        assert_eq!(res2.rendered.page_hashes[0], res1.rendered.page_hashes[0]);
        assert_ne!(res2.rendered.page_hashes[1], res1.rendered.page_hashes[1]);
        assert_eq!(res2.rendered.first_changed_page, Some(2));
        assert_eq!(res2.rendered.changed_pages, vec![2]);

        // Kill daemon worker mid-session -> next request transparently respawns & compiles!
        {
            let (slot, _) = sup.slot_for(&ws);
            let mut guard = slot.lock().unwrap();
            if let Some(worker) = guard.as_mut() {
                let _ = worker.child.kill();
                let _ = worker.child.wait();
            }
        }
        let res3 = sup
            .compile_with_binary(
                &binary,
                RenderRequest {
                    root: &ws,
                    main_file: Some(&ch1),
                    source: unsaved_v2,
                    mode: "pages",
                    cancel: None,
                },
            )
            .expect("supervisor must recover transparently from killed daemon");
        assert_eq!(res3.rendered.page_hashes, res2.rendered.page_hashes);

        let snap = sup.snapshot_stats();
        assert_eq!(snap.running_workers, 1);
        assert!(snap.compile_count >= 3);

        let _freed = sup.evict_all_caches();
        sup.shutdown_all();

        let scratch = ws.join("scratch");
        let nested = scratch.join("sub");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(scratch.join("a.bin"), b"12345").unwrap();
        std::fs::write(nested.join("b.bin"), b"6789").unwrap();
        assert_eq!(remove_dir_contents(&scratch), 9);

        let _ = std::fs::remove_dir_all(&ws);
    }
}
