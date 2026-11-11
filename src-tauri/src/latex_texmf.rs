//! Registered local TEXMF libraries: configuration, inspection and capture.
//!
//! A library is a reader-chosen folder of classes, packages and their runtime
//! resources, shared by every LaTeX project. It is a read-only compiler input
//! with its own origin: this module validates the registered roots, indexes the
//! runtime portions of each tree under explicit bounds, and captures one
//! immutable, content-addressed snapshot per compile. Both backends consume that
//! snapshot — the bundled engine through MEMFS, an installed engine through a
//! private staging directory — so neither ever reads the reader's tree while a
//! compile runs. See docs/adr/2026-11-10-local-texmf-libraries.md.

use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};

pub const MAX_ROOTS: usize = 8;
pub const MAX_FILES: usize = 4096;
pub const MAX_BYTES: u64 = 64 * 1024 * 1024;
pub const MAX_FILE: u64 = 32 * 1024 * 1024;
pub const MAX_DEPTH: usize = 16;
/// Directory entries one root may enumerate, counting skipped ones, so a
/// mistakenly registered home folder fails fast instead of walking for minutes.
pub const MAX_ENTRIES: usize = 65_536;
const CAPTURE_ATTEMPTS: usize = 3;

static NEXT_ID: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RootKind {
    /// The app-owned folder under the configuration directory. Its path is
    /// resolved at use time so a portable configuration carries it along.
    Personal,
    /// A folder the reader chose, stored as an absolute machine-local path.
    Folder,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Layout {
    /// A TEXMF tree: tex/, bibtex/, fonts/, scripts/ at the top.
    Tds,
    /// A plain folder of packages; staged as a synthetic TDS tree.
    Packages,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TexmfRoot {
    pub id: String,
    pub kind: RootKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    pub layout: Layout,
    pub enabled: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TexmfIssue {
    /// `error` blocks a compile; `warning` and `info` are reported only.
    pub severity: &'static str,
    pub code: &'static str,
    pub message: String,
    pub paths: Vec<String>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TexmfNames {
    pub classes: Vec<String>,
    pub packages: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TexmfReport {
    /// The registered root this describes; `None` for a candidate folder.
    pub id: Option<String>,
    pub path: String,
    pub label: String,
    pub layout: Layout,
    pub detected_layout: Layout,
    pub enabled: bool,
    /// `ok`, `empty`, `missing`, `unreadable`, `oversized`, `conflicting`.
    pub status: &'static str,
    pub message: Option<String>,
    pub files: usize,
    pub bytes: u64,
    pub issues: Vec<TexmfIssue>,
    pub names: TexmfNames,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TexmfRootView {
    #[serde(flatten)]
    pub root: TexmfRoot,
    /// The resolved folder, for display and Open.
    pub resolved: String,
    pub label: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TexmfConfig {
    pub roots: Vec<TexmfRootView>,
    pub personal_path: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotRoot {
    pub id: String,
    pub label: String,
    pub layout: Layout,
    pub path: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TexmfFile {
    /// Index into [`TexmfSnapshot::roots`]: the search position.
    pub root: usize,
    /// TDS-relative path, `/`-separated (a packages folder is mapped into TDS).
    pub path: String,
    /// The original path inside the reader's folder, for diagnostics.
    pub origin: String,
    pub data: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TexmfSnapshot {
    /// Covers enablement, order, layout, paths and content.
    pub revision: String,
    pub roots: Vec<SnapshotRoot>,
    pub files: Vec<TexmfFile>,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum TexmfAction {
    AddFolder {
        path: String,
        layout: Option<Layout>,
    },
    UsePersonal,
    SetEnabled {
        id: String,
        enabled: bool,
    },
    SetLayout {
        id: String,
        layout: Layout,
    },
    Move {
        id: String,
        offset: i32,
    },
    Remove {
        id: String,
    },
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/// Never captured from a library, whatever directory it is in: host
/// executables, distribution configuration and dumps, and compiled Lua.
fn excluded_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    if lower.starts_with('.') || lower == "texmf.cnf" || lower == "ls-r" || lower == "ls-r.gz" {
        return true;
    }
    [
        ".exe", ".dll", ".so", ".dylib", ".com", ".bat", ".cmd", ".ps1", ".msi", ".scr", ".vbs",
        ".js", ".jse", ".wsf", ".cpl", ".pif", ".lnk", ".sh", ".app", ".fmt", ".luc", ".lub",
        ".efmt",
    ]
    .iter()
    .any(|suffix| lower.ends_with(suffix))
}

const FONT_DIRS: &[&str] = &[
    "opentype", "truetype", "type1", "tfm", "vf", "enc", "map", "afm",
];

/// The TDS path a file of a TDS root is captured under, or `None` when it is
/// outside the runtime portions (doc, source, web2c, bin, …).
fn tds_runtime(relative: &str) -> Option<String> {
    let mut parts = relative.split('/');
    let top = parts.next()?;
    let second = parts.next();
    let keep = match top {
        "tex" | "scripts" => second.is_some(),
        "bibtex" => matches!(second, Some("bst" | "bib" | "csf")) && parts.next().is_some(),
        "fonts" => second.is_some_and(|dir| FONT_DIRS.contains(&dir)) && parts.next().is_some(),
        _ => false,
    };
    keep.then(|| relative.to_string())
}

/// The synthetic TDS path for a file of a packages folder, keeping its relative
/// directory so package-relative resources still resolve.
fn packages_tds(relative: &str) -> String {
    let lower = relative.to_ascii_lowercase();
    let extension = lower.rsplit_once('.').map(|(_, ext)| ext).unwrap_or("");
    let dir = match extension {
        "bst" => "bibtex/bst",
        "bib" => "bibtex/bib",
        "otf" => "fonts/opentype",
        "ttf" | "ttc" => "fonts/truetype",
        "pfb" | "pfa" => "fonts/type1",
        "tfm" => "fonts/tfm",
        "vf" => "fonts/vf",
        "enc" => "fonts/enc",
        "map" => "fonts/map",
        _ => "tex/latex",
    };
    format!("{dir}/{relative}")
}

/// The lookup domain of a captured path, for ambiguity checks. Only names an
/// engine resolves by search take part; images and data are found by path.
fn lookup_domain(tds: &str) -> Option<String> {
    let lower = tds.to_ascii_lowercase();
    let extension = lower.rsplit_once('.').map(|(_, ext)| ext)?;
    let searchable = [
        "sty", "cls", "def", "cfg", "fd", "clo", "ldf", "tex", "lua", "bst", "bib", "otf", "ttf",
        "ttc", "pfb", "tfm", "vf", "enc", "map",
    ];
    if !searchable.contains(&extension) {
        return None;
    }
    let mut parts = lower.split('/');
    let top = parts.next()?;
    let second = parts.next()?;
    Some(match top {
        // tex/<format> is the TDS format directory; the same name in two
        // formats is legitimate (lualatex vs latex copies).
        "tex" => format!("tex/{second}"),
        "scripts" => "lua".into(),
        other => format!("{other}/{second}"),
    })
}

fn basename(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

// ---------------------------------------------------------------------------
// Index
// ---------------------------------------------------------------------------

#[derive(Clone, Debug)]
struct Entry {
    tds: String,
    source: PathBuf,
    origin: String,
    len: u64,
}

#[derive(Debug, Default)]
struct Index {
    entries: Vec<Entry>,
    issues: Vec<TexmfIssue>,
    bytes: u64,
}

#[derive(Debug)]
enum IndexError {
    Missing(String),
    Unreadable(String),
    Oversized(String),
}

impl IndexError {
    fn status(&self) -> &'static str {
        match self {
            IndexError::Missing(_) => "missing",
            IndexError::Unreadable(_) => "unreadable",
            IndexError::Oversized(_) => "oversized",
        }
    }
    fn message(&self) -> String {
        match self {
            IndexError::Missing(m) | IndexError::Unreadable(m) | IndexError::Oversized(m) => {
                m.clone()
            }
        }
    }
}

/// Whether `dir` looks like a TEXMF tree rather than a plain packages folder.
pub fn detect_layout(dir: &Path) -> Layout {
    let is_dir = |name: &str| {
        fs::symlink_metadata(dir.join(name)).is_ok_and(|meta| meta.file_type().is_dir())
    };
    if is_dir("tex")
        || (is_dir("bibtex") && !has_loose_tex(dir))
        || is_dir("scripts") && is_dir("fonts")
    {
        Layout::Tds
    } else {
        Layout::Packages
    }
}

fn has_loose_tex(dir: &Path) -> bool {
    fs::read_dir(dir).is_ok_and(|entries| {
        entries.flatten().any(|entry| {
            let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
            name.ends_with(".sty") || name.ends_with(".cls")
        })
    })
}

fn index_root(dir: &Path, layout: Layout) -> Result<Index, IndexError> {
    let meta = fs::metadata(dir).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            IndexError::Missing(format!(
                "{} is not available. Reconnect the drive or folder, or turn this library off.",
                dir.display()
            ))
        } else {
            IndexError::Unreadable(format!("Cannot read {}: {error}", dir.display()))
        }
    })?;
    if !meta.is_dir() {
        return Err(IndexError::Missing(format!(
            "{} is not a folder.",
            dir.display()
        )));
    }
    let mut index = Index::default();
    let mut stack: Vec<(PathBuf, String, usize)> = vec![(dir.to_path_buf(), String::new(), 0)];
    let mut seen_entries = 0usize;
    let mut skipped_links = Vec::new();
    while let Some((path, relative, depth)) = stack.pop() {
        let entries = fs::read_dir(&path).map_err(|error| {
            IndexError::Unreadable(format!("Cannot list {}: {error}", path.display()))
        })?;
        let mut children: Vec<_> = entries.flatten().collect();
        // Deterministic order: the revision and any reported conflict must not
        // depend on the directory's enumeration order.
        children.sort_by_key(|entry| entry.file_name());
        for entry in children {
            seen_entries += 1;
            if seen_entries > MAX_ENTRIES {
                return Err(IndexError::Oversized(format!(
                    "{} has more than {MAX_ENTRIES} entries. Register a smaller folder that holds only your packages.",
                    dir.display()
                )));
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            let child_relative = if relative.is_empty() {
                name.clone()
            } else {
                format!("{relative}/{name}")
            };
            let Ok(meta) = fs::symlink_metadata(entry.path()) else {
                continue;
            };
            // Symbolic links and Windows junctions are never followed: a link
            // could point anywhere, including outside the registered folder.
            if meta.file_type().is_symlink() {
                skipped_links.push(child_relative);
                continue;
            }
            if name.starts_with('.') {
                continue;
            }
            if meta.is_dir() {
                if depth + 1 >= MAX_DEPTH {
                    return Err(IndexError::Oversized(format!(
                        "{} is nested deeper than {MAX_DEPTH} levels.",
                        entry.path().display()
                    )));
                }
                if layout == Layout::Tds
                    && depth == 0
                    && !matches!(name.as_str(), "tex" | "scripts" | "bibtex" | "fonts")
                {
                    continue; // doc/, source/, web2c/, bin/ …
                }
                stack.push((entry.path(), child_relative, depth + 1));
                continue;
            }
            if !meta.is_file() || excluded_name(&name) {
                continue;
            }
            let tds = match layout {
                Layout::Tds => match tds_runtime(&child_relative) {
                    Some(path) => path,
                    None => continue,
                },
                Layout::Packages => packages_tds(&child_relative),
            };
            let len = meta.len();
            if len > MAX_FILE {
                return Err(IndexError::Oversized(format!(
                    "{} is larger than the 32 MiB file limit.",
                    entry.path().display()
                )));
            }
            index.bytes += len;
            if index.bytes > MAX_BYTES {
                return Err(IndexError::Oversized(format!(
                    "{} holds more than 64 MiB of package files. Register a smaller folder that holds only your packages.",
                    dir.display()
                )));
            }
            index.entries.push(Entry {
                tds,
                source: entry.path(),
                origin: child_relative,
                len,
            });
            if index.entries.len() > MAX_FILES {
                return Err(IndexError::Oversized(format!(
                    "{} holds more than {MAX_FILES} package files. Register a smaller folder that holds only your packages.",
                    dir.display()
                )));
            }
        }
    }
    index.entries.sort_by(|a, b| a.tds.cmp(&b.tds));
    if !skipped_links.is_empty() {
        skipped_links.sort();
        index.issues.push(TexmfIssue {
            severity: "info",
            code: "link-skipped",
            message: "Links are not followed inside a library.".into(),
            paths: skipped_links,
        });
    }
    index.issues.extend(conflicts(&index.entries));
    Ok(index)
}

/// Same-domain duplicates within one root, and paths that differ only by case.
fn conflicts(entries: &[Entry]) -> Vec<TexmfIssue> {
    let mut issues = Vec::new();
    let mut by_name: BTreeMap<(String, String), Vec<&str>> = BTreeMap::new();
    let mut by_case: BTreeMap<String, Vec<&str>> = BTreeMap::new();
    for entry in entries {
        by_case
            .entry(entry.tds.to_lowercase())
            .or_default()
            .push(&entry.origin);
        if let Some(domain) = lookup_domain(&entry.tds) {
            by_name
                .entry((domain, basename(&entry.tds).to_lowercase()))
                .or_default()
                .push(&entry.origin);
        }
    }
    for ((_, name), origins) in by_name {
        if origins.len() > 1 {
            issues.push(TexmfIssue {
                severity: "error",
                code: "ambiguous",
                message: format!(
                    "{name} exists more than once in this folder, so which copy loads would be arbitrary. Keep one."
                ),
                paths: origins.into_iter().map(str::to_string).collect(),
            });
        }
    }
    for (_, origins) in by_case {
        if origins.len() > 1 {
            issues.push(TexmfIssue {
                severity: "error",
                code: "case-conflict",
                message:
                    "These paths differ only by letter case, which other systems cannot keep apart."
                        .into(),
                paths: origins.into_iter().map(str::to_string).collect(),
            });
        }
    }
    issues
}

fn names(entries: &[Entry]) -> TexmfNames {
    let mut out = TexmfNames::default();
    for entry in entries {
        if !entry.tds.starts_with("tex/") {
            continue;
        }
        let name = basename(&entry.tds);
        if let Some(stem) = name.strip_suffix(".cls") {
            out.classes.push(stem.to_string());
        } else if let Some(stem) = name.strip_suffix(".sty") {
            out.packages.push(stem.to_string());
        }
    }
    out.classes.sort();
    out.classes.dedup();
    out.packages.sort();
    out.packages.dedup();
    out
}

// ---------------------------------------------------------------------------
// Roots and settings
// ---------------------------------------------------------------------------

fn personal_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|dir| dir.join("texmf"))
        .map_err(|error| format!("Cannot locate the configuration folder: {error}"))
}

fn resolve(app: &AppHandle, root: &TexmfRoot) -> Result<PathBuf, String> {
    match root.kind {
        RootKind::Personal => personal_dir(app),
        RootKind::Folder => root
            .path
            .as_deref()
            .map(PathBuf::from)
            .ok_or_else(|| "A library folder has no path.".to_string()),
    }
}

fn label_for(root: &TexmfRoot, resolved: &Path) -> String {
    match root.kind {
        RootKind::Personal => "Personal folder".into(),
        RootKind::Folder => resolved
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| resolved.display().to_string()),
    }
}

fn new_id() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos())
        .unwrap_or(0);
    format!(
        "{:x}{:04x}",
        nanos & 0xffff_ffff_ffff,
        NEXT_ID.fetch_add(1, Ordering::Relaxed) & 0xffff
    )
}

/// Canonical identity for duplicate and overlap checks.
fn identity(path: &Path) -> Option<PathBuf> {
    fs::canonicalize(path).ok()
}

fn contains(outer: &Path, inner: &Path) -> bool {
    inner.starts_with(outer)
}

fn config(app: &AppHandle, roots: &[TexmfRoot]) -> Result<TexmfConfig, String> {
    let personal = personal_dir(app)?;
    Ok(TexmfConfig {
        roots: roots
            .iter()
            .map(|root| {
                let resolved = resolve(app, root).unwrap_or_default();
                TexmfRootView {
                    label: label_for(root, &resolved),
                    resolved: resolved.display().to_string(),
                    root: root.clone(),
                }
            })
            .collect(),
        personal_path: personal.display().to_string(),
    })
}

/// Apply one action to a root list. Pure apart from reading the candidate
/// folder, so the rules are testable without an application.
fn apply(
    roots: &mut Vec<TexmfRoot>,
    action: TexmfAction,
    resolved: &dyn Fn(&TexmfRoot) -> Option<PathBuf>,
) -> Result<Option<String>, String> {
    let position = |roots: &[TexmfRoot], id: &str| {
        roots
            .iter()
            .position(|root| root.id == id)
            .ok_or_else(|| "That library is no longer registered.".to_string())
    };
    match action {
        TexmfAction::AddFolder { path, layout } => {
            let requested = PathBuf::from(&path);
            if !requested.is_absolute() {
                return Err("Choose a full path to the library folder.".into());
            }
            if roots.len() >= MAX_ROOTS {
                return Err(format!(
                    "At most {MAX_ROOTS} library folders can be registered."
                ));
            }
            let canonical = identity(&requested)
                .filter(|path| path.is_dir())
                .ok_or_else(|| format!("{path} is not a readable folder."))?;
            for root in roots.iter() {
                let Some(other) = resolved(root).and_then(|path| identity(&path)) else {
                    continue;
                };
                if other == canonical {
                    return Err(format!("{path} is already registered."));
                }
                if contains(&other, &canonical) || contains(&canonical, &other) {
                    return Err(format!(
                        "{path} overlaps the registered folder {}. Register one or the other.",
                        other.display()
                    ));
                }
            }
            let layout = layout.unwrap_or_else(|| detect_layout(&requested));
            // Inspect before saving: a missing, unreadable or oversized folder
            // never becomes a partial entry.
            index_root(&requested, layout).map_err(|error| error.message())?;
            let id = new_id();
            roots.push(TexmfRoot {
                id: id.clone(),
                kind: RootKind::Folder,
                path: Some(
                    std::path::absolute(&requested)
                        .unwrap_or(requested)
                        .display()
                        .to_string(),
                ),
                layout,
                enabled: true,
            });
            Ok(Some(id))
        }
        TexmfAction::UsePersonal => {
            if let Some(existing) = roots.iter().find(|root| root.kind == RootKind::Personal) {
                return Ok(Some(existing.id.clone()));
            }
            if roots.len() >= MAX_ROOTS {
                return Err(format!(
                    "At most {MAX_ROOTS} library folders can be registered."
                ));
            }
            let id = new_id();
            roots.push(TexmfRoot {
                id: id.clone(),
                kind: RootKind::Personal,
                path: None,
                layout: Layout::Tds,
                enabled: true,
            });
            Ok(Some(id))
        }
        TexmfAction::SetEnabled { id, enabled } => {
            let at = position(roots, &id)?;
            roots[at].enabled = enabled;
            Ok(Some(id))
        }
        TexmfAction::SetLayout { id, layout } => {
            let at = position(roots, &id)?;
            if roots[at].kind == RootKind::Personal && layout != Layout::Tds {
                return Err("The personal folder is always a TEXMF tree.".into());
            }
            roots[at].layout = layout;
            Ok(Some(id))
        }
        TexmfAction::Move { id, offset } => {
            let at = position(roots, &id)?;
            let target = at as i64 + offset as i64;
            if offset.abs() != 1 || target < 0 || target >= roots.len() as i64 {
                return Err("That library cannot move further.".into());
            }
            roots.swap(at, target as usize);
            Ok(Some(id))
        }
        TexmfAction::Remove { id } => {
            let at = position(roots, &id)?;
            roots.remove(at);
            Ok(None)
        }
    }
}

fn state(app: &AppHandle) -> Result<tauri::State<'_, crate::settings::AppState>, String> {
    app.try_state::<crate::settings::AppState>()
        .ok_or_else(|| "The settings store is unavailable.".to_string())
}

#[tauri::command]
pub fn latex_texmf_list(app: AppHandle) -> Result<TexmfConfig, String> {
    let settings = state(&app)?.snapshot()?;
    config(&app, &settings.latex_texmf_roots)
}

/// Change the registered roots. Remove only unregisters; it never deletes files.
#[tauri::command]
pub async fn latex_texmf_configure(
    app: AppHandle,
    action: TexmfAction,
) -> Result<TexmfConfig, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = state(&app)?;
        let mut settings = state.snapshot()?;
        let personal = matches!(action, TexmfAction::UsePersonal);
        let app_for_resolve = app.clone();
        apply(&mut settings.latex_texmf_roots, action, &|root| {
            resolve(&app_for_resolve, root).ok()
        })?;
        if personal {
            // Created only by this explicit action; an existing folder and its
            // contents are left exactly as they are.
            let local = personal_dir(&app)?.join("tex").join("latex").join("local");
            fs::create_dir_all(&local)
                .map_err(|error| format!("Cannot create {}: {error}", local.display()))?;
        }
        let saved = state.save(settings)?;
        config(&app, &saved.latex_texmf_roots)
    })
    .await
    .map_err(|error| error.to_string())?
}

fn report(
    id: Option<String>,
    root: Option<&TexmfRoot>,
    dir: &Path,
    layout: Option<Layout>,
) -> TexmfReport {
    let detected = detect_layout(dir);
    let layout = layout.or(root.map(|root| root.layout)).unwrap_or(detected);
    let label = root.map(|root| label_for(root, dir)).unwrap_or_else(|| {
        dir.file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default()
    });
    let enabled = root.is_none_or(|root| root.enabled);
    match index_root(dir, layout) {
        Ok(index) => {
            let names = names(&index.entries);
            let blocking = index.issues.iter().any(|issue| issue.severity == "error");
            let status = if blocking {
                "conflicting"
            } else if names.classes.is_empty()
                && names.packages.is_empty()
                && index.entries.is_empty()
            {
                "empty"
            } else {
                "ok"
            };
            let message = match status {
                "empty" => Some(match layout {
                    Layout::Tds => {
                        "No package files yet. Put each package in its own folder under tex/latex/."
                            .into()
                    }
                    Layout::Packages => "No package files yet.".into(),
                }),
                "conflicting" => {
                    Some("Two files would answer the same name. Keep one, then refresh.".into())
                }
                _ => None,
            };
            TexmfReport {
                id,
                path: dir.display().to_string(),
                label,
                layout,
                detected_layout: detected,
                enabled,
                status,
                message,
                files: index.entries.len(),
                bytes: index.bytes,
                issues: index.issues,
                names,
            }
        }
        Err(error) => TexmfReport {
            id,
            path: dir.display().to_string(),
            label,
            layout,
            detected_layout: detected,
            enabled,
            status: error.status(),
            message: Some(error.message()),
            files: 0,
            bytes: 0,
            issues: Vec::new(),
            names: TexmfNames::default(),
        },
    }
}

/// Inspect registered roots (all when `ids` is absent), or one candidate folder
/// the reader just picked. Reads files only: it never compiles or downloads.
#[tauri::command]
pub async fn latex_texmf_inspect(
    app: AppHandle,
    ids: Option<Vec<String>>,
    candidate: Option<String>,
    layout: Option<Layout>,
) -> Result<Vec<TexmfReport>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(candidate) = candidate {
            let dir = PathBuf::from(&candidate);
            if !dir.is_absolute() {
                return Err("Choose a full path to the library folder.".into());
            }
            return Ok(vec![report(None, None, &dir, layout)]);
        }
        let settings = state(&app)?.snapshot()?;
        let mut reports = Vec::new();
        let mut first_owner: HashMap<String, String> = HashMap::new();
        for root in &settings.latex_texmf_roots {
            if ids.as_ref().is_some_and(|ids| !ids.contains(&root.id)) {
                continue;
            }
            let dir = resolve(&app, root)?;
            let mut entry = report(Some(root.id.clone()), Some(root), &dir, None);
            // Cross-root shadowing is reported, never blocked: an earlier
            // folder overriding a later one can be intentional.
            if root.enabled {
                let mut shadowed = Vec::new();
                for name in entry.names.classes.iter().map(|n| format!("{n}.cls")).chain(entry.names.packages.iter().map(|n| format!("{n}.sty"))) {
                    match first_owner.get(&name) {
                        Some(owner) => shadowed.push(format!("{name} (used from {owner})")),
                        None => {
                            first_owner.insert(name, entry.label.clone());
                        }
                    }
                }
                if !shadowed.is_empty() {
                    entry.issues.push(TexmfIssue {
                        severity: "info",
                        code: "shadowed",
                        message: "A folder above this one provides the same names, so its copies are used.".into(),
                        paths: shadowed,
                    });
                }
            }
            reports.push(entry);
        }
        Ok(reports)
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Open a registered root in the file manager. Takes an id, never a path.
#[tauri::command]
pub fn latex_texmf_open(app: AppHandle, id: String) -> Result<(), String> {
    let settings = state(&app)?.snapshot()?;
    let root = settings
        .latex_texmf_roots
        .iter()
        .find(|root| root.id == id)
        .ok_or("That library is no longer registered.")?;
    let mut dir = resolve(&app, root)?;
    if root.kind == RootKind::Personal {
        let local = dir.join("tex").join("latex").join("local");
        if local.is_dir() {
            dir = local;
        }
    }
    if !dir.is_dir() {
        return Err(format!("{} is not available.", dir.display()));
    }
    tauri_plugin_opener::open_path(&dir, None::<&str>).map_err(|error| error.to_string())
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

#[derive(Debug)]
enum CaptureError {
    Unstable(String),
    Fatal(String),
}

fn read_contained(entry: &Entry, canonical_root: &Path) -> Result<Vec<u8>, CaptureError> {
    let before = fs::symlink_metadata(&entry.source)
        .map_err(|error| CaptureError::Unstable(format!("{}: {error}", entry.origin)))?;
    if before.file_type().is_symlink() || !before.is_file() {
        return Err(CaptureError::Unstable(entry.origin.clone()));
    }
    // A link substituted between listing and read cannot widen access.
    let canonical = fs::canonicalize(&entry.source)
        .map_err(|error| CaptureError::Unstable(format!("{}: {error}", entry.origin)))?;
    if !canonical.starts_with(canonical_root) {
        return Err(CaptureError::Fatal(format!(
            "{} resolves outside its library folder and was not read.",
            entry.origin
        )));
    }
    let bytes = fs::read(&canonical)
        .map_err(|error| CaptureError::Unstable(format!("{}: {error}", entry.origin)))?;
    let after = fs::symlink_metadata(&entry.source)
        .map_err(|error| CaptureError::Unstable(format!("{}: {error}", entry.origin)))?;
    if bytes.len() as u64 != entry.len
        || after.len() != before.len()
        || after.modified().ok() != before.modified().ok()
    {
        return Err(CaptureError::Unstable(entry.origin.clone()));
    }
    Ok(bytes)
}

fn capture_once(roots: &[(TexmfRoot, PathBuf, String)]) -> Result<TexmfSnapshot, CaptureError> {
    let mut hasher = Sha256::new();
    let mut files = Vec::new();
    let mut snapshot_roots = Vec::new();
    let mut total_bytes = 0u64;
    for (position, (root, dir, label)) in roots.iter().enumerate() {
        let index = index_root(dir, root.layout).map_err(|error| {
            CaptureError::Fatal(format!(
                "The local library \"{label}\" cannot be used: {} Turn it off in Preferences › LaTeX › Local packages and classes to compile without it.",
                error.message()
            ))
        })?;
        if let Some(issue) = index.issues.iter().find(|issue| issue.severity == "error") {
            return Err(CaptureError::Fatal(format!(
                "The local library \"{label}\" has a conflict: {} ({}) Fix it, or turn the library off in Preferences › LaTeX.",
                issue.message,
                issue.paths.join(", ")
            )));
        }
        let canonical_root = fs::canonicalize(dir)
            .map_err(|error| CaptureError::Fatal(format!("{}: {error}", dir.display())))?;
        hasher.update(format!(
            "root\u{0}{}\u{0}{:?}\u{0}{}\n",
            root.id,
            root.layout,
            dir.display()
        ));
        for entry in &index.entries {
            let bytes = read_contained(entry, &canonical_root)?;
            total_bytes += bytes.len() as u64;
            if total_bytes > MAX_BYTES || files.len() >= MAX_FILES {
                return Err(CaptureError::Fatal(format!(
                    "The enabled local libraries together exceed the {} MiB / {MAX_FILES}-file limit. Turn one off or register a smaller folder.",
                    MAX_BYTES / 1024 / 1024
                )));
            }
            hasher.update(format!("{position}\u{0}{}\u{0}", entry.tds));
            hasher.update(Sha256::digest(&bytes));
            hasher.update(b"\n");
            files.push(TexmfFile {
                root: position,
                path: entry.tds.clone(),
                origin: dir.join(&entry.origin).display().to_string(),
                data: STANDARD.encode(&bytes),
            });
        }
        snapshot_roots.push(SnapshotRoot {
            id: root.id.clone(),
            label: label.clone(),
            layout: root.layout,
            path: dir.display().to_string(),
        });
    }
    Ok(TexmfSnapshot {
        revision: hasher
            .finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect(),
        roots: snapshot_roots,
        files,
    })
}

fn capture_roots(roots: &[(TexmfRoot, PathBuf, String)]) -> Result<Option<TexmfSnapshot>, String> {
    if roots.is_empty() {
        return Ok(None);
    }
    let mut last = String::new();
    for _ in 0..CAPTURE_ATTEMPTS {
        match capture_once(roots) {
            Ok(snapshot) => return Ok(Some(snapshot)),
            Err(CaptureError::Fatal(message)) => return Err(message),
            Err(CaptureError::Unstable(file)) => last = file,
        }
    }
    Err(format!(
        "A local library kept changing while it was read ({last}). Wait for the change to finish, then compile again."
    ))
}

/// Capture every enabled root, in order, or `None` when none is enabled.
///
/// An enabled root that is missing, unreadable, oversized or conflicting fails
/// the capture with a named remedy: compiling against a different version of
/// its packages would be silently wrong.
pub fn capture(app: &AppHandle) -> Result<Option<TexmfSnapshot>, String> {
    let settings = state(app)?.snapshot()?;
    let mut roots = Vec::new();
    for root in settings
        .latex_texmf_roots
        .iter()
        .filter(|root| root.enabled)
    {
        let dir = resolve(app, root)?;
        let label = label_for(root, &dir);
        roots.push((root.clone(), dir, label));
    }
    capture_roots(&roots)
}

/// The current revision of the enabled libraries, or `None` when none is
/// enabled. Used on window focus to decide whether a preview went stale; it
/// reads files but never compiles or downloads.
#[tauri::command]
pub async fn latex_texmf_revision(app: AppHandle) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        capture(&app).map(|snapshot| snapshot.map(|snapshot| snapshot.revision))
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Validate a snapshot received back from the frontend before staging it.
pub fn validate_snapshot(snapshot: &TexmfSnapshot) -> Result<(), String> {
    if snapshot.roots.len() > MAX_ROOTS || snapshot.files.len() > MAX_FILES {
        return Err("The local library snapshot exceeds its limits.".into());
    }
    let mut total = 0usize;
    for file in &snapshot.files {
        if file.root >= snapshot.roots.len() {
            return Err("The local library snapshot names an unknown root.".into());
        }
        let normal = file.path.replace('\\', "/");
        if normal.is_empty()
            || normal.len() > 512
            || normal.starts_with('/')
            || normal.contains(':')
            || normal.chars().any(char::is_control)
            || normal
                .split('/')
                .any(|part| part.is_empty() || part == "." || part == "..")
            || excluded_name(basename(&normal))
        {
            return Err(format!("Unsafe local library path: {}", file.path));
        }
        let top = normal.split('/').next().unwrap_or("");
        if !matches!(top, "tex" | "scripts" | "bibtex" | "fonts") {
            return Err(format!("Unexpected local library path: {}", file.path));
        }
        total = total.saturating_add(file.data.len() / 4 * 3);
        if total as u64 > MAX_BYTES + MAX_BYTES / 8 {
            return Err("The local library snapshot exceeds 64 MiB.".into());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "mdraft-texmf-{name}-{}-{}",
            std::process::id(),
            NEXT_ID.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn write(path: &Path, text: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    fn folder(id: &str, path: &Path, layout: Layout) -> TexmfRoot {
        TexmfRoot {
            id: id.into(),
            kind: RootKind::Folder,
            path: Some(path.display().to_string()),
            layout,
            enabled: true,
        }
    }

    #[test]
    fn older_settings_load_with_no_roots() {
        let settings: crate::settings::Settings = serde_json::from_str("{}").unwrap();
        assert!(settings.latex_texmf_roots.is_empty());
        let json = serde_json::json!({"latexTexmfRoots":[{"id":"a","kind":"folder","path":"C:/x","layout":"tds","enabled":false}]});
        let settings: crate::settings::Settings = serde_json::from_value(json).unwrap();
        assert_eq!(settings.latex_texmf_roots[0].layout, Layout::Tds);
        assert!(!settings.latex_texmf_roots[0].enabled);
    }

    #[test]
    fn a_tds_tree_keeps_runtime_files_and_skips_the_rest() {
        let root = temp("tds");
        write(&root.join("tex/latex/mine/mine.sty"), "x");
        write(&root.join("tex/latex/mine/mine-helper.def"), "x");
        write(&root.join("tex/lualatex/mine/mine.sty"), "lua copy");
        write(&root.join("scripts/mine/mine.lua"), "return {}");
        write(&root.join("bibtex/bst/mine/mine.bst"), "x");
        write(&root.join("fonts/opentype/mine/Mine.otf"), "x");
        write(&root.join("doc/latex/mine/mine.pdf"), "x");
        write(&root.join("source/latex/mine/mine.dtx"), "x");
        write(&root.join("web2c/texmf.cnf"), "x");
        write(&root.join("tex/latex/mine/texmf.cnf"), "x");
        write(&root.join("tex/latex/mine/tool.exe"), "x");
        write(&root.join("tex/latex/mine/.hidden.sty"), "x");
        assert_eq!(detect_layout(&root), Layout::Tds);
        let index = index_root(&root, Layout::Tds).unwrap();
        let paths: Vec<&str> = index.entries.iter().map(|e| e.tds.as_str()).collect();
        assert_eq!(
            paths,
            [
                "bibtex/bst/mine/mine.bst",
                "fonts/opentype/mine/Mine.otf",
                "scripts/mine/mine.lua",
                "tex/latex/mine/mine-helper.def",
                "tex/latex/mine/mine.sty",
                "tex/lualatex/mine/mine.sty",
            ]
        );
        // The lualatex and latex copies are format-specific, not a conflict.
        assert!(index.issues.iter().all(|issue| issue.severity != "error"));
    }

    #[test]
    fn a_packages_folder_is_mapped_into_tds_with_its_subdirectories() {
        let root = temp("packages");
        write(&root.join("thesis.cls"), "x");
        write(&root.join("sub/helper.sty"), "x");
        write(&root.join("sub/logo.png"), "x");
        write(&root.join("refs/house.bst"), "x");
        write(&root.join("fonts/Brand.ttf"), "x");
        assert_eq!(detect_layout(&root), Layout::Packages);
        let index = index_root(&root, Layout::Packages).unwrap();
        let paths: Vec<&str> = index.entries.iter().map(|e| e.tds.as_str()).collect();
        assert!(paths.contains(&"tex/latex/thesis.cls"));
        assert!(paths.contains(&"tex/latex/sub/helper.sty"));
        assert!(paths.contains(&"tex/latex/sub/logo.png"));
        assert!(paths.contains(&"bibtex/bst/refs/house.bst"));
        assert!(paths.contains(&"fonts/truetype/fonts/Brand.ttf"));
    }

    #[test]
    fn same_domain_duplicates_are_named_and_block() {
        let root = temp("ambiguous");
        write(&root.join("a/dup.sty"), "1");
        write(&root.join("b/dup.sty"), "2");
        write(&root.join("a/logo.png"), "1");
        write(&root.join("b/logo.png"), "2");
        let index = index_root(&root, Layout::Packages).unwrap();
        let ambiguous: Vec<_> = index
            .issues
            .iter()
            .filter(|issue| issue.code == "ambiguous")
            .collect();
        assert_eq!(ambiguous.len(), 1, "images are found by path, not by name");
        assert_eq!(ambiguous[0].paths, ["a/dup.sty", "b/dup.sty"]);
        let roots = vec![(
            folder("x", &root, Layout::Packages),
            root.clone(),
            "x".into(),
        )];
        let error = capture_roots(&roots).unwrap_err();
        assert!(
            error.contains("conflict") && error.contains("a/dup.sty"),
            "{error}"
        );
    }

    #[test]
    fn limits_are_named_and_never_truncate() {
        let root = temp("limits");
        let mut path = root.clone();
        for level in 0..MAX_DEPTH + 1 {
            path = path.join(format!("d{level}"));
        }
        write(&path.join("deep.sty"), "x");
        let error = index_root(&root, Layout::Packages).unwrap_err();
        assert_eq!(error.status(), "oversized");
        assert!(error.message().contains("16 levels"));
    }

    #[test]
    fn a_missing_root_blocks_the_capture_with_a_remedy() {
        let gone = std::env::temp_dir().join("mdraft-texmf-does-not-exist-xyz");
        let roots = vec![(folder("g", &gone, Layout::Tds), gone.clone(), "gone".into())];
        let error = capture_roots(&roots).unwrap_err();
        assert!(
            error.contains("not available") && error.contains("Turn it off"),
            "{error}"
        );
    }

    #[test]
    fn the_revision_covers_order_layout_and_content() {
        let a = temp("rev-a");
        let b = temp("rev-b");
        write(&a.join("tex/latex/x/x.sty"), "one");
        write(&b.join("tex/latex/y/y.sty"), "two");
        let ra = folder("a", &a, Layout::Tds);
        let rb = folder("b", &b, Layout::Tds);
        let first = capture_roots(&[
            (ra.clone(), a.clone(), "a".into()),
            (rb.clone(), b.clone(), "b".into()),
        ])
        .unwrap()
        .unwrap();
        let swapped = capture_roots(&[
            (rb.clone(), b.clone(), "b".into()),
            (ra.clone(), a.clone(), "a".into()),
        ])
        .unwrap()
        .unwrap();
        assert_ne!(first.revision, swapped.revision);
        assert_eq!(first.files[0].root, 0);
        assert_eq!(first.files[0].path, "tex/latex/x/x.sty");
        write(&a.join("tex/latex/x/x.sty"), "changed");
        let edited = capture_roots(&[(ra, a.clone(), "a".into()), (rb, b, "b".into())])
            .unwrap()
            .unwrap();
        assert_ne!(first.revision, edited.revision);
        // Bytes are preserved exactly, including non-UTF-8 content.
        fs::write(a.join("tex/latex/x/x.sty"), [0xff, 0x00, 0x7f]).unwrap();
        let binary = capture_roots(&[(folder("a", &a, Layout::Tds), a, "a".into())])
            .unwrap()
            .unwrap();
        assert_eq!(
            STANDARD.decode(&binary.files[0].data).unwrap(),
            [0xff, 0x00, 0x7f]
        );
    }

    #[cfg(unix)]
    #[test]
    fn links_are_skipped_and_reported() {
        let root = temp("links");
        let outside = temp("outside");
        write(&outside.join("secret.sty"), "x");
        fs::create_dir_all(root.join("tex/latex")).unwrap();
        std::os::unix::fs::symlink(&outside, root.join("tex/latex/escape")).unwrap();
        let index = index_root(&root, Layout::Tds).unwrap();
        assert!(index.entries.is_empty());
        assert_eq!(index.issues[0].code, "link-skipped");
    }

    #[cfg(windows)]
    #[test]
    fn junctions_are_skipped_and_reported() {
        let root = temp("junction");
        let outside = temp("junction-outside");
        write(&outside.join("secret.sty"), "x");
        fs::create_dir_all(root.join("tex/latex")).unwrap();
        let status = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(root.join("tex/latex/escape"))
            .arg(&outside)
            .output()
            .unwrap();
        if !status.status.success() {
            return; // mklink unavailable in this environment
        }
        let index = index_root(&root, Layout::Tds).unwrap();
        assert!(index.entries.is_empty(), "{:?}", index.entries);
        assert_eq!(index.issues[0].code, "link-skipped");
    }

    #[test]
    fn configure_rules() {
        let a = temp("cfg-a");
        let inner = a.join("inner");
        fs::create_dir_all(&inner).unwrap();
        write(&a.join("pkg.sty"), "x");
        let b = temp("cfg-b");
        let mut roots = Vec::new();
        let resolve = |root: &TexmfRoot| root.path.as_deref().map(PathBuf::from);
        let id = apply(
            &mut roots,
            TexmfAction::AddFolder {
                path: a.display().to_string(),
                layout: None,
            },
            &resolve,
        )
        .unwrap()
        .unwrap();
        assert_eq!(roots[0].layout, Layout::Packages);
        assert!(
            apply(
                &mut roots,
                TexmfAction::AddFolder {
                    path: a.display().to_string(),
                    layout: None
                },
                &resolve
            )
            .unwrap_err()
            .contains("already registered")
        );
        assert!(
            apply(
                &mut roots,
                TexmfAction::AddFolder {
                    path: inner.display().to_string(),
                    layout: None
                },
                &resolve
            )
            .unwrap_err()
            .contains("overlaps")
        );
        assert!(
            apply(
                &mut roots,
                TexmfAction::AddFolder {
                    path: "relative/path".into(),
                    layout: None
                },
                &resolve
            )
            .is_err()
        );
        let second = apply(
            &mut roots,
            TexmfAction::AddFolder {
                path: b.display().to_string(),
                layout: Some(Layout::Tds),
            },
            &resolve,
        )
        .unwrap()
        .unwrap();
        apply(
            &mut roots,
            TexmfAction::Move {
                id: second.clone(),
                offset: -1,
            },
            &resolve,
        )
        .unwrap();
        assert_eq!(roots[0].id, second);
        assert!(
            apply(
                &mut roots,
                TexmfAction::Move {
                    id: second.clone(),
                    offset: -1
                },
                &resolve
            )
            .is_err()
        );
        apply(
            &mut roots,
            TexmfAction::SetEnabled {
                id: id.clone(),
                enabled: false,
            },
            &resolve,
        )
        .unwrap();
        assert!(!roots[1].enabled);
        let personal = apply(&mut roots, TexmfAction::UsePersonal, &resolve)
            .unwrap()
            .unwrap();
        assert_eq!(
            apply(&mut roots, TexmfAction::UsePersonal, &resolve)
                .unwrap()
                .unwrap(),
            personal
        );
        assert!(
            apply(
                &mut roots,
                TexmfAction::SetLayout {
                    id: personal.clone(),
                    layout: Layout::Packages
                },
                &resolve
            )
            .is_err()
        );
        apply(&mut roots, TexmfAction::Remove { id }, &resolve).unwrap();
        assert_eq!(roots.len(), 2);
        // Remove never touched the folder itself.
        assert!(a.join("pkg.sty").is_file());
    }

    #[test]
    fn a_received_snapshot_is_validated_again() {
        let ok = TexmfSnapshot {
            revision: "r".into(),
            roots: vec![SnapshotRoot {
                id: "a".into(),
                label: "a".into(),
                layout: Layout::Tds,
                path: "x".into(),
            }],
            files: vec![TexmfFile {
                root: 0,
                path: "tex/latex/a/a.sty".into(),
                origin: String::new(),
                data: STANDARD.encode("x"),
            }],
        };
        assert!(validate_snapshot(&ok).is_ok());
        for bad in [
            "../escape.sty",
            "tex/../../x.sty",
            "C:/x.sty",
            "doc/a.pdf",
            "tex/latex/a/run.exe",
            "/tex/a.sty",
            "tex/latex/texmf.cnf",
        ] {
            let mut snapshot = ok.clone();
            snapshot.files[0].path = bad.into();
            assert!(validate_snapshot(&snapshot).is_err(), "{bad}");
        }
        let mut wrong_root = ok.clone();
        wrong_root.files[0].root = 3;
        assert!(validate_snapshot(&wrong_root).is_err());
    }
}
