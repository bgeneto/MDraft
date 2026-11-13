//! The workspace folder behind the Explorer (Track W of
//! docs/plans/2026-11-12-latex-compile-cost.md, GAP-006 slice 1).
//!
//! A workspace is a view and a default, never a permission
//! (docs/adr/2026-11-12-workspace-boundary.md): these commands only *list*
//! directories, one level at a time, inside the folder the reader chose. They
//! never read file contents, never follow a symlink, never write, and refuse a
//! path that resolves outside the root. Opening a listed file goes through the
//! ordinary document commands with their own rules.
//!
//! The first slice uses `std::fs` only: a lazy, bounded, one-level listing with
//! a built-in skip list. No recursive index, no watcher and no `.gitignore`
//! parsing; the Explorer refreshes on expand, on focus and after saves.

use serde::Serialize;
use std::cmp::Ordering;
use std::fs;
use std::path::{Component, Path, PathBuf};

/// Entries listed per directory before the rest is summarised as "N more".
pub const MAX_ENTRIES: usize = 5_000;

/// Directories that are build output or tooling, not writing: skipped unless
/// the reader asks for every file.
const SKIPPED_DIRECTORIES: &[&str] = &[
    ".git",
    ".hg",
    ".svn",
    "node_modules",
    "target",
    "dist",
    "__pycache__",
    ".venv",
    ".idea",
    ".vscode",
];

/// TeX and Typst auxiliary outputs, also hidden by default.
const SKIPPED_EXTENSIONS: &[&str] = &[
    "aux",
    "log",
    "fls",
    "fdb_latexmk",
    "toc",
    "lof",
    "lot",
    "out",
    "bbl",
    "blg",
    "bcf",
    "run.xml",
    "synctex.gz",
    "synctex",
    "nav",
    "snm",
    "vrb",
    "idx",
    "ind",
    "ilg",
    "xdv",
];

/// What MDraft edits as text.
const DOCUMENT_EXTENSIONS: &[&str] = &[
    "md", "markdown", "mdown", "mkd", "txt", "tex", "ltx", "sty", "cls", "bib", "bst", "typ",
    "adoc", "asciidoc", "asc", "html", "htm", "css", "js", "json", "yaml", "yml", "toml",
];

/// What documents include: images, PDFs and data a figure reads.
const ASSET_EXTENSIONS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "svg", "webp", "pdf", "eps", "csv", "tsv",
];

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceEntry {
    pub name: String,
    /// "dir", "document", "asset" or "other".
    pub kind: &'static str,
    /// A symlink is shown but never followed or expanded.
    pub symlink: bool,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceListing {
    /// The listed directory, relative to the root, with `/` separators.
    pub relative: String,
    pub entries: Vec<WorkspaceEntry>,
    /// Entries not listed because of `MAX_ENTRIES`.
    pub truncated: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceInfo {
    /// The canonical root the Explorer lists from.
    pub root: String,
    pub name: String,
}

fn lower_extension(name: &str) -> String {
    let lower = name.to_ascii_lowercase();
    for multi in ["run.xml", "synctex.gz"] {
        if lower.ends_with(&format!(".{multi}")) {
            return multi.to_string();
        }
    }
    lower
        .rsplit_once('.')
        .map(|(_, ext)| ext.to_string())
        .unwrap_or_default()
}

fn classify(name: &str, is_dir: bool) -> &'static str {
    if is_dir {
        return "dir";
    }
    let extension = lower_extension(name);
    if DOCUMENT_EXTENSIONS.contains(&extension.as_str()) {
        "document"
    } else if ASSET_EXTENSIONS.contains(&extension.as_str()) {
        "asset"
    } else {
        "other"
    }
}

fn skipped(name: &str, is_dir: bool) -> bool {
    if name.starts_with('.') {
        return true;
    }
    if is_dir {
        return SKIPPED_DIRECTORIES.contains(&name);
    }
    SKIPPED_EXTENSIONS.contains(&lower_extension(name).as_str())
}

/// Folders first, then case-insensitive names, numbers compared by value so
/// `ch2` sorts before `ch10`.
fn natural(a: &WorkspaceEntry, b: &WorkspaceEntry) -> Ordering {
    let rank = |entry: &WorkspaceEntry| u8::from(entry.kind != "dir");
    rank(a).cmp(&rank(b)).then_with(|| {
        let (x, y) = (a.name.to_lowercase(), b.name.to_lowercase());
        let (mut i, mut j) = (x.chars().peekable(), y.chars().peekable());
        loop {
            match (i.peek().copied(), j.peek().copied()) {
                (None, None) => return a.name.cmp(&b.name),
                (None, Some(_)) => return Ordering::Less,
                (Some(_), None) => return Ordering::Greater,
                (Some(c), Some(d)) if c.is_ascii_digit() && d.is_ascii_digit() => {
                    let mut n = String::new();
                    while let Some(&k) = i.peek().filter(|k| k.is_ascii_digit()) {
                        n.push(k);
                        i.next();
                    }
                    let mut m = String::new();
                    while let Some(&k) = j.peek().filter(|k| k.is_ascii_digit()) {
                        m.push(k);
                        j.next();
                    }
                    let (n, m) = (n.trim_start_matches('0'), m.trim_start_matches('0'));
                    match n.len().cmp(&m.len()).then_with(|| n.cmp(m)) {
                        Ordering::Equal => continue,
                        other => return other,
                    }
                }
                (Some(c), Some(d)) => {
                    i.next();
                    j.next();
                    if c != d {
                        return c.cmp(&d);
                    }
                }
            }
        }
    })
}

/// Why a folder cannot be a workspace, if it cannot.
///
/// A filesystem or drive root, or the home directory itself, would make the
/// Explorer a file manager for the whole disk; the reader is told to choose
/// the project folder instead.
fn refusal(root: &Path) -> Option<String> {
    if root.parent().is_none() {
        return Some(
            "A drive or filesystem root cannot be a workspace. Choose the project folder.".into(),
        );
    }
    let home =
        std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from);
    if home.and_then(|home| fs::canonicalize(home).ok()).as_deref() == Some(root) {
        return Some("Your home folder cannot be a workspace. Choose the project folder.".into());
    }
    None
}

fn display(path: &Path) -> String {
    let text = path.to_string_lossy().to_string();
    // `canonicalize` on Windows returns the verbatim `\\?\` form; the reader and
    // the document commands use the ordinary one.
    text.strip_prefix(r"\\?\UNC\")
        .map(|rest| format!(r"\\{rest}"))
        .or_else(|| text.strip_prefix(r"\\?\").map(str::to_string))
        .unwrap_or(text)
}

/// Check a folder the reader chose and return its canonical form.
pub fn open(path: &str) -> Result<WorkspaceInfo, String> {
    let root = fs::canonicalize(path).map_err(|e| format!("Cannot open the folder: {e}"))?;
    if !root.is_dir() {
        return Err("Choose a folder, not a file.".into());
    }
    if let Some(reason) = refusal(&root) {
        return Err(reason);
    }
    let name = root
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| display(&root));
    Ok(WorkspaceInfo {
        root: display(&root),
        name,
    })
}

/// List one directory of the workspace.
///
/// `relative` uses `/` separators and must stay inside `root`: a `..`, an
/// absolute path or a symlink that resolves outside is refused, on canonical
/// paths, so a workspace can never become a way to list the rest of the disk.
pub fn list(root: &str, relative: &str, show_all: bool) -> Result<WorkspaceListing, String> {
    let root =
        fs::canonicalize(root).map_err(|e| format!("The workspace folder is unavailable: {e}"))?;
    let rel = Path::new(relative);
    if rel.is_absolute()
        || rel
            .components()
            .any(|part| !matches!(part, Component::Normal(_) | Component::CurDir))
    {
        return Err("That path is outside the workspace.".into());
    }
    let target =
        fs::canonicalize(root.join(rel)).map_err(|e| format!("Cannot list the folder: {e}"))?;
    if !target.starts_with(&root) {
        return Err("That path is outside the workspace.".into());
    }
    let mut entries = Vec::new();
    for entry in fs::read_dir(&target).map_err(|e| format!("Cannot list the folder: {e}"))? {
        let Ok(entry) = entry else { continue };
        let name = entry.file_name().to_string_lossy().to_string();
        let Ok(meta) = entry.path().symlink_metadata() else {
            continue;
        };
        let symlink = meta.file_type().is_symlink();
        let is_dir = !symlink && meta.is_dir();
        if !show_all && skipped(&name, is_dir) {
            continue;
        }
        entries.push(WorkspaceEntry {
            kind: classify(&name, is_dir),
            name,
            symlink,
            size: if is_dir { 0 } else { meta.len() },
        });
    }
    entries.sort_by(natural);
    let truncated = entries.len().saturating_sub(MAX_ENTRIES);
    entries.truncate(MAX_ENTRIES);
    Ok(WorkspaceListing {
        relative: relative.trim_matches('/').to_string(),
        entries,
        truncated,
    })
}

/// Bounds for the main-document search: it reads `.tex` sources, so it stays
/// small and never becomes a full-disk index.
const SEARCH_MAX_FILES: usize = 4_000;
const SEARCH_MAX_DEPTH: usize = 8;
const SEARCH_MAX_BYTES: u64 = 1024 * 1024;

fn read_tex(path: &Path) -> Option<String> {
    let meta = fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > SEARCH_MAX_BYTES {
        return None;
    }
    Some(String::from_utf8_lossy(&fs::read(path).ok()?).into_owned())
}

/// Every `.tex` file under `root`, bounded, skipping build folders and symlinks.
fn tex_files(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![(root.to_path_buf(), 0usize)];
    while let Some((dir, depth)) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            if out.len() >= SEARCH_MAX_FILES {
                return out;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            let Ok(meta) = entry.path().symlink_metadata() else {
                continue;
            };
            if meta.file_type().is_symlink() {
                continue;
            }
            if meta.is_dir() {
                if depth < SEARCH_MAX_DEPTH && !skipped(&name, true) {
                    stack.push((entry.path(), depth + 1));
                }
            } else if lower_extension(&name) == "tex" {
                out.push(entry.path());
            }
        }
    }
    out
}

/// The `.tex` files a main document reaches through `\input`/`\include`,
/// resolved against the main file's directory as TeX does, confined to root.
fn closure(root: &Path, main: &Path) -> Vec<PathBuf> {
    let base = main.parent().unwrap_or(root).to_path_buf();
    let mut seen: Vec<PathBuf> = vec![main.to_path_buf()];
    let mut queue = vec![main.to_path_buf()];
    while let Some(file) = queue.pop() {
        if seen.len() > 500 {
            break;
        }
        let Some(text) = read_tex(&file) else {
            continue;
        };
        for (kind, name) in crate::latex::declared_references(&text) {
            if kind != "input" && kind != "include" {
                continue;
            }
            let mut target = base.join(&name);
            if target.extension().is_none() {
                target.set_extension("tex");
            }
            let Ok(target) = fs::canonicalize(&target) else {
                continue;
            };
            if target.starts_with(root) && !seen.contains(&target) {
                seen.push(target.clone());
                queue.push(target);
            }
        }
    }
    seen
}

/// Main documents in the workspace whose include closure contains `file`
/// (main-document rule 4). A main document declares `\documentclass` outside
/// comments and verbatim text; `file` itself is never its own candidate here
/// (rule 3 already covers a file with its own class).
pub fn main_candidates(root: &str, file: &str) -> Result<Vec<String>, String> {
    let root =
        fs::canonicalize(root).map_err(|e| format!("The workspace folder is unavailable: {e}"))?;
    let file = fs::canonicalize(file).map_err(|e| format!("Cannot read the file: {e}"))?;
    if !file.starts_with(&root) {
        return Ok(Vec::new());
    }
    let mut candidates = Vec::new();
    for main in tex_files(&root) {
        let Ok(main) = fs::canonicalize(&main) else {
            continue;
        };
        if main == file {
            continue;
        }
        let Some(text) = read_tex(&main) else {
            continue;
        };
        let declares_class = crate::latex::declared_references(&text)
            .iter()
            .any(|(kind, _)| kind == "documentclass");
        if declares_class && closure(&root, &main).contains(&file) {
            candidates.push(display(&main));
        }
    }
    candidates.sort();
    Ok(candidates)
}

#[tauri::command]
pub fn workspace_open(path: String) -> Result<WorkspaceInfo, String> {
    open(&path)
}

/// Reads `.tex` sources, so it runs off the async runtime's worker threads.
#[tauri::command]
pub async fn workspace_main_candidates(root: String, path: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || main_candidates(&root, &path))
        .await
        .map_err(|e| e.to_string())?
}

/// Listing reads the disk, so it runs off the async runtime's worker threads:
/// a slow network share must not stall other commands.
#[tauri::command]
pub async fn workspace_list(
    root: String,
    relative: String,
    show_all: bool,
) -> Result<WorkspaceListing, String> {
    tauri::async_runtime::spawn_blocking(move || list(&root, &relative, show_all))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fresh folder under the crate's target directory: the system temp
    /// folder is refused on some Windows hosts (see `latex.rs`'s scratch).
    struct Scratch(PathBuf);
    impl Scratch {
        fn new(name: &str) -> Self {
            let dir = Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("target")
                .join("workspace-tests")
                .join(format!("{name}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            Scratch(dir)
        }
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn tree(name: &str) -> Scratch {
        let dir = Scratch::new(name);
        let root = dir.path();
        fs::create_dir_all(root.join("chapters")).unwrap();
        fs::create_dir_all(root.join("figures")).unwrap();
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::create_dir_all(root.join("node_modules")).unwrap();
        fs::write(root.join("main.tex"), "x").unwrap();
        fs::write(root.join("main.aux"), "x").unwrap();
        fs::write(root.join("main.synctex.gz"), "x").unwrap();
        fs::write(root.join("refs.bib"), "x").unwrap();
        fs::write(root.join(".hidden.tex"), "x").unwrap();
        fs::write(root.join("notes.bin"), "x").unwrap();
        fs::write(root.join("chapters").join("ch10.tex"), "x").unwrap();
        fs::write(root.join("chapters").join("ch2.tex"), "x").unwrap();
        fs::write(root.join("chapters").join("Ch1.tex"), "x").unwrap();
        fs::write(root.join("figures").join("plot.png"), "x").unwrap();
        fs::write(root.join("figures").join("ação.svg"), "x").unwrap();
        dir
    }

    fn names(listing: &WorkspaceListing) -> Vec<&str> {
        listing.entries.iter().map(|e| e.name.as_str()).collect()
    }

    #[test]
    fn lists_one_level_folders_first_and_skips_build_output() {
        let dir = tree("level");
        let listing = list(dir.path().to_str().unwrap(), "", false).unwrap();
        assert_eq!(
            names(&listing),
            ["chapters", "figures", "main.tex", "notes.bin", "refs.bib"]
        );
        assert_eq!(listing.entries[0].kind, "dir");
        assert_eq!(listing.entries[2].kind, "document");
        assert_eq!(listing.entries[3].kind, "other");
        assert_eq!(listing.truncated, 0);
    }

    #[test]
    fn show_all_includes_hidden_and_auxiliary_files() {
        let dir = tree("all");
        let listing = list(dir.path().to_str().unwrap(), "", true).unwrap();
        for name in [
            ".git",
            "node_modules",
            ".hidden.tex",
            "main.aux",
            "main.synctex.gz",
        ] {
            assert!(
                names(&listing).contains(&name),
                "{name} listed with show_all"
            );
        }
    }

    #[test]
    fn numbers_sort_by_value_and_case_does_not_split_names() {
        let dir = tree("natural");
        let listing = list(dir.path().to_str().unwrap(), "chapters", false).unwrap();
        assert_eq!(names(&listing), ["Ch1.tex", "ch2.tex", "ch10.tex"]);
        assert_eq!(listing.relative, "chapters");
    }

    #[test]
    fn unicode_names_and_assets_are_listed() {
        let dir = tree("unicode");
        let listing = list(dir.path().to_str().unwrap(), "figures", false).unwrap();
        assert_eq!(names(&listing), ["ação.svg", "plot.png"]);
        assert!(listing.entries.iter().all(|e| e.kind == "asset"));
    }

    #[test]
    fn parent_and_absolute_paths_are_refused() {
        let dir = tree("refuse");
        let root = dir.path().to_str().unwrap();
        assert!(list(root, "..", false).is_err());
        assert!(list(root, "chapters/../..", false).is_err());
        let outside = Scratch::new("outside");
        assert!(list(root, outside.path().to_str().unwrap(), false).is_err());
    }

    #[test]
    fn a_missing_folder_explains_itself() {
        let error = list("Z:/definitely/missing/folder", "", false).unwrap_err();
        assert!(error.contains("unavailable"), "{error}");
    }

    #[test]
    fn listings_are_capped() {
        let dir = Scratch::new("cap");
        for index in 0..(MAX_ENTRIES + 7) {
            fs::write(dir.path().join(format!("f{index}.tex")), "").unwrap();
        }
        let listing = list(dir.path().to_str().unwrap(), "", false).unwrap();
        assert_eq!(listing.entries.len(), MAX_ENTRIES);
        assert_eq!(listing.truncated, 7);
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_are_shown_but_not_followed() {
        let dir = tree("symlink");
        let outside = Scratch::new("symlink-outside");
        std::os::unix::fs::symlink(outside.path(), dir.path().join("escape")).unwrap();
        let listing = list(dir.path().to_str().unwrap(), "", false).unwrap();
        let link = listing.entries.iter().find(|e| e.name == "escape").unwrap();
        assert!(link.symlink && link.kind != "dir");
        assert!(list(dir.path().to_str().unwrap(), "escape", false).is_err());
    }

    #[test]
    fn main_candidates_follow_includes_from_the_main_files_directory() {
        let dir = Scratch::new("mains");
        let root = dir.path();
        fs::create_dir_all(root.join("chapters").join("sub")).unwrap();
        fs::write(
            root.join("main.tex"),
            "\\documentclass{book}\n\\begin{document}\n\\include{chapters/a}\n\\end{document}\n",
        )
        .unwrap();
        // Nested input: resolved against the main file's folder, as TeX does.
        fs::write(
            root.join("chapters").join("a.tex"),
            "\\input{chapters/sub/b}\n",
        )
        .unwrap();
        fs::write(root.join("chapters").join("sub").join("b.tex"), "Text.\n").unwrap();
        fs::write(root.join("chapters").join("orphan.tex"), "Alone.\n").unwrap();
        // A commented class is not a main document.
        fs::write(
            root.join("notes.tex"),
            "% \\documentclass{article}\n\\input{chapters/a}\n",
        )
        .unwrap();
        let r = root.to_str().unwrap();
        let a = root.join("chapters").join("a.tex");
        let b = root.join("chapters").join("sub").join("b.tex");
        let orphan = root.join("chapters").join("orphan.tex");
        let found = main_candidates(r, a.to_str().unwrap()).unwrap();
        assert_eq!(found.len(), 1, "{found:?}");
        assert!(found[0].ends_with("main.tex"));
        assert_eq!(main_candidates(r, b.to_str().unwrap()).unwrap().len(), 1);
        assert!(
            main_candidates(r, orphan.to_str().unwrap())
                .unwrap()
                .is_empty()
        );
        // A second main including the same chapter makes the choice ambiguous.
        fs::write(
            root.join("draft.tex"),
            "\\documentclass{article}\n\\begin{document}\\input{chapters/a}\\end{document}\n",
        )
        .unwrap();
        assert_eq!(main_candidates(r, a.to_str().unwrap()).unwrap().len(), 2);
    }

    #[test]
    fn open_refuses_files_and_roots() {
        let dir = tree("open");
        assert!(open(dir.path().join("main.tex").to_str().unwrap()).is_err());
        let root = if cfg!(windows) { "C:\\" } else { "/" };
        assert!(open(root).unwrap_err().contains("root"));
        let info = open(dir.path().to_str().unwrap()).unwrap();
        assert!(!info.root.starts_with(r"\\?\"), "{}", info.root);
        assert!(!info.name.is_empty());
    }
}
