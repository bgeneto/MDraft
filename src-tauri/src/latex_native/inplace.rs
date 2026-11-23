//! An installed TeX distribution compiles the document in its own folder.
//!
//! TeX runs with the main file's folder as its working directory, exactly as
//! it does from a terminal or another editor, and writes every output to the
//! app's workspace (`-output-directory`). Nothing is copied out of the folder
//! and nothing is written into it. What the folder cannot supply is the editor
//! state: a buffer with unsaved changes goes into an overlay folder that TeX
//! searches before the working directory. `-recorder` lists every file TeX
//! opened, which is what this build read and therefore what it depends on.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use base64::{Engine, engine::general_purpose::STANDARD};

/// Files one request may carry, and their bytes in all. The snapshot carries
/// 256 files and 64 MiB up front, plus every open buffer; the request is still
/// external input.
const MAX_REQUEST_FILES: usize = 4096;
const MAX_REQUEST_BYTES: usize = 128 * 1024 * 1024;
const MAX_REQUEST_FILE: usize = 32 * 1024 * 1024;

/// A path without the verbatim `\\?\` prefix `canonicalize` adds on Windows.
/// TeX, `wsl.exe --cd` and the reader all expect the ordinary form.
pub(super) fn plain(path: &Path) -> PathBuf {
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    match text.strip_prefix(r"\\?\") {
        Some(rest) => PathBuf::from(rest),
        None => path.to_path_buf(),
    }
}

/// True for a network share, which a WSL distribution cannot run in.
pub(super) fn is_network(path: &Path) -> bool {
    let text = plain(path).to_string_lossy().replace('/', "\\");
    text.starts_with(r"\\")
}

/// Characters a kpathsea or MiKTeX search path gives a meaning: brace
/// expansion, the list separators, variable expansion.
fn search_safe(text: &str, unix: bool) -> bool {
    !text.contains(['{', '}', ',', ';', '$', '\0']) && (!unix || !text.contains(':'))
}

/// A directory as one search-path element, `/`-separated.
///
/// Search-path variables expand braces and commas, so a folder named
/// `Thesis, {draft}` would silently search somewhere else. Windows offers the
/// folder's short name instead; when there is none, the build stops and says
/// which folder and why, rather than compile with a library or an unsaved
/// buffer missing.
///
/// A name outside ASCII (`D:\Thèse`) is valid in a search path, but an
/// engine that reads its environment in the ANSI code page loses the letters
/// that code page lacks, so the short name, which is ASCII, is preferred.
pub(super) fn search_form(path: &Path) -> Result<String, String> {
    let plain = plain(path);
    let text = plain.to_string_lossy().replace('\\', "/");
    let safe = search_safe(&text, cfg!(unix)) && !text.starts_with("//");
    if safe && (text.is_ascii() || cfg!(unix)) {
        return Ok(text);
    }
    if let Some(short) = short_path(&plain) {
        let short = short.to_string_lossy().replace('\\', "/");
        if search_safe(&short, false) && !short.starts_with("//") && short.is_ascii() {
            return Ok(short);
        }
    }
    if safe {
        return Ok(text);
    }
    Err(format!(
        "{} cannot be used in a TeX search path: its name contains a comma, a brace, a \
         semicolon or a dollar sign, and Windows has no short name for it.",
        plain.display()
    ))
}

/// A Linux directory as one search-path element.
pub(super) fn linux_search_form(path: &str) -> Result<String, String> {
    if search_safe(path, true) {
        Ok(path.to_string())
    } else {
        Err(format!(
            "{path} cannot be used in a TeX search path: its name contains a comma, a brace, a \
             colon, a semicolon or a dollar sign."
        ))
    }
}

#[cfg(windows)]
fn short_path(path: &Path) -> Option<PathBuf> {
    use std::os::windows::ffi::{OsStrExt, OsStringExt};
    use windows::Win32::Storage::FileSystem::GetShortPathNameW;
    use windows::core::PCWSTR;
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut buffer = vec![0u16; 1024];
    // SAFETY: `wide` is NUL-terminated and outlives the call; the buffer's
    // length is passed with it.
    let length = unsafe { GetShortPathNameW(PCWSTR(wide.as_ptr()), Some(&mut buffer)) } as usize;
    if length == 0 || length >= buffer.len() {
        return None;
    }
    Some(PathBuf::from(std::ffi::OsString::from_wide(
        &buffer[..length],
    )))
}

#[cfg(not(windows))]
fn short_path(_path: &Path) -> Option<PathBuf> {
    None
}

/// What one build brings besides the folder itself.
pub(super) struct Prepared {
    /// The names the snapshot carried. Their content is in the preview's key
    /// already, so the dependency record leaves them out.
    pub carried: BTreeSet<String>,
    /// The carried `.tex` sources, for the log's file names.
    pub sources: BTreeMap<String, String>,
    /// Carried names whose bytes differ from the folder: compiled from the
    /// overlay, which TeX searches first.
    pub overlaid: BTreeSet<String>,
    /// The main file's name, which TeX is given.
    pub main: String,
    /// Warnings about the editor state TeX cannot see.
    pub warnings: Vec<Warning>,
    /// Digest of the bibliography inputs this request carries.
    pub bibliography: String,
}

/// An unsaved buffer the build cannot compile, and where the document names it.
pub(super) struct Warning {
    pub source: String,
    pub line: u32,
    /// The unsaved file it is about.
    pub file: String,
    pub message: String,
}

/// A project-relative path that cannot leave the folder it is joined to.
///
/// Unicode is allowed, because a reader's folders are their own; what is
/// refused is anything absolute, escaping with `..`, or a Windows device or
/// drive prefix.
pub(super) fn safe_relative(path: &str) -> Result<String, String> {
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

fn has_extension(name: &str, extensions: &[&str]) -> bool {
    let lower = name.to_ascii_lowercase();
    extensions
        .iter()
        .any(|extension| lower.ends_with(&format!(".{extension}")))
}

/// Write `bytes` to `target` unless it already holds them.
fn write_if_changed(target: &Path, bytes: &[u8]) -> Result<(), String> {
    let same = std::fs::metadata(target)
        .is_ok_and(|metadata| metadata.is_file() && metadata.len() == bytes.len() as u64)
        && std::fs::read(target).is_ok_and(|current| current == bytes);
    if same {
        return Ok(());
    }
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("Cannot create {}: {error}", plain(parent).display()))?;
    }
    std::fs::write(target, bytes)
        .map_err(|error| format!("Cannot write {}: {error}", plain(target).display()))
}

/// Remove every file below `dir` that is not one of `keep`, then the empty
/// folders left behind.
fn prune(dir: &Path, keep: &BTreeSet<String>) {
    fn walk(base: &Path, dir: &Path, keep: &BTreeSet<String>) -> bool {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return false;
        };
        let mut empty = true;
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(kind) = entry.file_type() else {
                empty = false;
                continue;
            };
            if kind.is_dir() && !kind.is_symlink() {
                if walk(base, &path, keep) {
                    let _ = std::fs::remove_dir(&path);
                } else {
                    empty = false;
                }
                continue;
            }
            let relative = path
                .strip_prefix(base)
                .map(|relative| relative.to_string_lossy().replace('\\', "/"))
                .unwrap_or_default();
            if keep.contains(&relative) || std::fs::remove_file(&path).is_err() {
                empty = false;
            }
        }
        empty
    }
    walk(dir, dir, keep);
}

/// Compare the request's files with the folder, write the overlay and the
/// bibliography inputs, and return what the build needs to know.
///
/// The overlay holds exactly the carried files whose bytes differ from the
/// folder's (an unsaved buffer, or a file that changed after the snapshot read
/// it): the build compiles the snapshot's content, which is what its key says.
/// Declared `.bib`/`.bst` files are written next to the outputs, where the
/// bibliography tool runs.
pub(super) fn prepare(
    root: &Path,
    overlay: &Path,
    out: &Path,
    main_file: &str,
    files: &[super::NativeFile],
    staged_bibliography: &mut BTreeMap<String, String>,
) -> Result<Prepared, String> {
    if files.is_empty() {
        return Err("The LaTeX project has no files.".into());
    }
    if files.len() > MAX_REQUEST_FILES {
        return Err("The LaTeX request carries too many files.".into());
    }
    let main = safe_relative(main_file)?;
    let mut prepared = Prepared {
        carried: BTreeSet::new(),
        sources: BTreeMap::new(),
        overlaid: BTreeSet::new(),
        main: main.clone(),
        warnings: Vec::new(),
        bibliography: String::new(),
    };
    let mut total = 0usize;
    let mut bibliography = BTreeMap::new();
    let mut texts: Vec<(String, String)> = Vec::new();
    for file in files {
        let relative = safe_relative(&file.path)?;
        let bytes = STANDARD
            .decode(&file.data)
            .map_err(|_| format!("{} is not valid project data.", file.path))?;
        if bytes.len() > MAX_REQUEST_FILE {
            return Err(format!("{} is larger than 32 MiB.", file.path));
        }
        total = total.saturating_add(bytes.len());
        if total > MAX_REQUEST_BYTES {
            return Err("The LaTeX request is larger than 128 MiB.".into());
        }
        let on_disk = crate::latex::project_file_in(root, &relative)
            .ok()
            .filter(|(_, metadata)| metadata.len() == bytes.len() as u64)
            .and_then(|(path, _)| std::fs::read(path).ok());
        if on_disk.as_deref() != Some(bytes.as_slice()) {
            write_if_changed(&overlay.join(&relative), &bytes)?;
            prepared.overlaid.insert(relative.clone());
        }
        if has_extension(&relative, &["bib", "bst"]) {
            let digest = crate::latex::digest(&bytes);
            if staged_bibliography.get(&relative) != Some(&digest) || !out.join(&relative).is_file()
            {
                write_if_changed(&out.join(&relative), &bytes)?;
            }
            bibliography.insert(relative.clone(), digest);
        }
        if has_extension(&relative, &["tex", "ltx"])
            && let Ok(text) = String::from_utf8(bytes)
        {
            texts.push((relative.clone(), text.clone()));
            prepared.sources.insert(relative.clone(), text);
        }
        prepared.carried.insert(relative);
    }
    if !prepared.carried.contains(&main) {
        return Err("The main .tex file is not part of the project snapshot.".into());
    }
    prune(overlay, &prepared.overlaid);
    // A bibliography input the document no longer declares leaves the outputs.
    for stale in staged_bibliography.keys() {
        if !bibliography.contains_key(stale) {
            let _ = std::fs::remove_file(out.join(stale));
        }
    }
    prepared.bibliography = crate::latex::digest(
        bibliography
            .iter()
            .map(|(path, digest)| format!("{path}\0{digest}\n"))
            .collect::<String>()
            .as_bytes(),
    );
    *staged_bibliography = bibliography;
    for (source, text) in &texts {
        prepared
            .warnings
            .extend(dot_relative_warnings(source, text, &prepared.overlaid));
    }
    Ok(prepared)
}

/// A name written `./chapter` is looked up in the working directory only, so
/// TeX reads the saved file there and never the overlay. Say so, by name,
/// where the document names it.
fn dot_relative_warnings(source: &str, text: &str, overlaid: &BTreeSet<String>) -> Vec<Warning> {
    let mut warnings = Vec::new();
    for (index, line) in text.lines().enumerate() {
        let code = comment_free(line);
        let mut rest = code;
        while let Some(at) = rest.find("{./") {
            let after = &rest[at + 3..];
            let Some(end) = after.find('}') else { break };
            let name = after[..end].trim();
            let unsaved = [name.to_string(), format!("{name}.tex")]
                .into_iter()
                .find(|candidate| overlaid.contains(candidate));
            if let Some(file) = unsaved {
                warnings.push(Warning {
                    source: source.to_string(),
                    line: u32::try_from(index + 1).unwrap_or(u32::MAX),
                    message: format!(
                        "{file} has unsaved changes, but ./{name} names it relative to the \
                         folder, where TeX reads the saved file. Save it, or write the name \
                         without ./."
                    ),
                    file,
                });
            }
            rest = &after[end..];
        }
    }
    warnings
}

/// A line without its TeX comment: a `%` after an even number of backslashes.
fn comment_free(line: &str) -> &str {
    let bytes = line.as_bytes();
    for (at, byte) in bytes.iter().enumerate() {
        if *byte == b'%' {
            let slashes = bytes[..at]
                .iter()
                .rev()
                .take_while(|byte| **byte == b'\\')
                .count();
            if slashes % 2 == 0 {
                return &line[..at];
            }
        }
    }
    line
}

/// The forms one build's paths take in the engine's own terms.
pub(super) struct EnginePaths {
    /// The folder, as the engine prints an absolute path inside it.
    pub root: String,
    /// The workspace: the outputs, the overlay, the libraries and the
    /// engine's own state. Nothing below it is a project file.
    pub workspace: String,
    /// The overlay, in the form its search path names it.
    pub overlay: String,
    /// The outputs, where the bibliography tool runs.
    pub out: String,
    /// True when the engine runs on Windows (case-insensitive paths).
    pub windows: bool,
}

impl EnginePaths {
    fn normal(&self, path: &str) -> String {
        let path = path.replace('\\', "/");
        if self.windows {
            path.to_lowercase()
        } else {
            path
        }
    }

    /// The rest of `path` below `dir`, in the spelling the engine printed.
    fn below<'a>(&self, path: &'a str, dir: &str) -> Option<&'a str> {
        let dir = dir.replace('\\', "/");
        let dir = dir.trim_end_matches('/');
        let normal = self.normal(path);
        let prefix = self.normal(dir);
        if !normal.starts_with(&prefix) || !normal[prefix.len()..].starts_with('/') {
            return None;
        }
        // Lower-casing can change a name's length in bytes, never in
        // characters for the letters a path holds, so skip by characters of
        // the folder as given.
        let skip = dir.chars().count() + 1;
        let start = path.char_indices().nth(skip).map(|(at, _)| at)?;
        Some(&path[start..])
    }

    /// The project name of one path the engine reported, and whether it was
    /// the overlay's copy. TeX names a file it found in its working directory
    /// relative to it; an absolute name came from a search path (the overlay,
    /// a library, the distribution) and is a project file only through the
    /// overlay, or, for a bibliography tool, below the folder.
    fn project_name(&self, path: &str, bibliography: bool) -> Option<(String, bool)> {
        let path = path.trim_end_matches('\r');
        let (relative, overlay) = if let Some(rest) = self.below(path, &self.overlay) {
            (rest, true)
        } else if bibliography && let Some(rest) = self.below(path, &self.out) {
            (rest, false)
        } else if self.below(path, &self.workspace).is_some() {
            return None;
        } else if bibliography && let Some(rest) = self.below(path, &self.root) {
            (rest, false)
        } else if is_absolute(path) {
            return None;
        } else {
            (path, false)
        };
        let relative = relative.replace('\\', "/");
        let relative = relative.trim_start_matches("./");
        safe_relative(relative).ok().map(|name| (name, overlay))
    }
}

/// What a `-recorder` file says the build read from the project: names
/// relative to the folder, `/`-separated, with the overlay's copies under
/// their project names.
pub(super) fn recorded_inputs(fls: &str, paths: &EnginePaths) -> BTreeSet<String> {
    recorded(fls, paths).map(|(name, _)| name).collect()
}

/// The names TeX read from the folder itself rather than from the overlay.
/// An overlaid name among them compiled from the saved file.
pub(super) fn read_from_folder(fls: &str, paths: &EnginePaths) -> BTreeSet<String> {
    recorded(fls, paths)
        .filter(|(_, overlay)| !*overlay)
        .map(|(name, _)| name)
        .collect()
}

fn recorded<'a>(fls: &'a str, paths: &'a EnginePaths) -> impl Iterator<Item = (String, bool)> + 'a {
    fls.lines()
        .filter_map(|line| line.strip_prefix("INPUT "))
        .filter_map(|path| paths.project_name(path, false))
}

/// The project names of the files a bibliography tool reported reading. It
/// runs beside the outputs, where the declared files were written under their
/// project names; one it found through the folder's search path is named
/// below the folder.
pub(super) fn bibliography_inputs(reads: &[String], paths: &EnginePaths) -> Vec<String> {
    let names: BTreeSet<String> = reads
        .iter()
        .filter_map(|path| paths.project_name(path, true))
        .map(|(name, _)| name)
        .collect();
    names.into_iter().collect()
}

fn is_absolute(path: &str) -> bool {
    let bytes = path.as_bytes();
    path.starts_with('/')
        || path.starts_with('\\')
        || (bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':')
}

/// The project name of a recorded input as it is spelled on disk, or None
/// when it is not a readable project file. A case-insensitive folder lets TeX
/// open `figures/Plot.png` as `figures/plot.png`; the dependency record needs
/// the file's own name to see it change.
pub(super) fn on_disk(root: &Path, relative: &str) -> Option<String> {
    let full = std::fs::canonicalize(root.join(relative)).ok()?;
    let inside = full.strip_prefix(root).ok()?;
    let name = inside
        .components()
        .map(|part| part.as_os_str().to_str())
        .collect::<Option<Vec<_>>>()?
        .join("/");
    crate::latex::project_file_in(root, &name).ok()?;
    Some(name)
}

/// The files a bibliography tool reports it read, from its `.blg`.
pub(super) fn bibliography_reads(blg: &str) -> Vec<String> {
    let mut reads = Vec::new();
    for line in blg.lines() {
        // BibTeX: `Database file #1: refs.bib`
        if let Some(rest) = line.trim().strip_prefix("Database file #")
            && let Some((_, name)) = rest.split_once(": ")
        {
            reads.push(name.trim().to_string());
        }
        // Biber: `INFO - Found BibTeX data source 'refs.bib'`
        if let Some((_, rest)) = line.split_once("Found BibTeX data source '")
            && let Some((name, _)) = rest.split_once('\'')
        {
            reads.push(name.to_string());
        }
    }
    reads
}

/// The output folders TeX could not write into: `\include{chapters/one}`
/// writes `chapters/one.aux` below the output directory, and TeX does not
/// create the folder itself.
pub(super) fn unwritable(log: &str) -> Vec<String> {
    let mut names = Vec::new();
    for line in log.lines() {
        if let Some(rest) = line
            .split_once("I can't write on file `")
            .map(|(_, rest)| rest)
            && let Some((name, _)) = rest.split_once('\'')
        {
            names.push(name.to_string());
        }
    }
    names
}

/// Create the output folders for every project name with a folder part.
pub(super) fn output_dirs<'a>(out: &Path, names: impl IntoIterator<Item = &'a String>) {
    for name in names {
        if let Some((dir, _)) = name.rsplit_once('/')
            && safe_relative(dir).is_ok()
        {
            let _ = std::fs::create_dir_all(out.join(dir));
        }
    }
}

/// Paths below `dir` with the extensions given, for the outputs' own walk.
#[cfg(test)]
pub(super) fn files_below(dir: &Path) -> BTreeSet<String> {
    let mut found = BTreeSet::new();
    let mut pending = vec![dir.to_path_buf()];
    while let Some(next) = pending.pop() {
        for entry in std::fs::read_dir(&next).into_iter().flatten().flatten() {
            let path = entry.path();
            if path.is_dir() {
                pending.push(path);
            } else if let Ok(relative) = path.strip_prefix(dir) {
                found.insert(relative.to_string_lossy().replace('\\', "/"));
            }
        }
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(path: &str, data: &[u8]) -> super::super::NativeFile {
        super::super::NativeFile {
            path: path.into(),
            data: STANDARD.encode(data),
        }
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("native-inplace-tests")
            .join(format!("{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_staged_path_cannot_escape_its_folder() {
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
    }

    #[test]
    fn only_unsaved_bytes_reach_the_overlay_and_the_folder_is_untouched() {
        let base = scratch("prepare");
        let root = base.join("root");
        let overlay = base.join("overlay");
        let out = base.join("out");
        std::fs::create_dir_all(root.join("chapters")).unwrap();
        std::fs::write(root.join("main.tex"), b"saved main").unwrap();
        std::fs::write(root.join("chapters/one.tex"), b"saved chapter").unwrap();
        std::fs::write(root.join("refs.bib"), b"@book{a}").unwrap();
        let before = files_below(&root);
        let root = std::fs::canonicalize(&root).unwrap();
        let mut staged = BTreeMap::new();

        let prepared = prepare(
            &root,
            &overlay,
            &out,
            "main.tex",
            &[
                file("main.tex", b"saved main"),
                file("chapters/one.tex", b"an unsaved edit"),
                file("refs.bib", b"@book{a}"),
            ],
            &mut staged,
        )
        .unwrap();
        assert_eq!(
            prepared.overlaid.iter().collect::<Vec<_>>(),
            ["chapters/one.tex"]
        );
        assert_eq!(
            std::fs::read(overlay.join("chapters/one.tex")).unwrap(),
            b"an unsaved edit"
        );
        assert!(
            !overlay.join("main.tex").exists(),
            "a saved file is read in place"
        );
        assert_eq!(std::fs::read(out.join("refs.bib")).unwrap(), b"@book{a}");
        assert_eq!(
            files_below(&root),
            before,
            "nothing is written into the folder"
        );

        // Saved since: the overlay copy goes.
        prepare(
            &root,
            &overlay,
            &out,
            "main.tex",
            &[
                file("main.tex", b"saved main"),
                file("chapters/one.tex", b"saved chapter"),
            ],
            &mut staged,
        )
        .unwrap();
        assert!(files_below(&overlay).is_empty());
        assert!(
            !out.join("refs.bib").exists(),
            "an undeclared input leaves the outputs"
        );
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn an_unsaved_file_named_dot_relative_is_reported() {
        let overlaid: BTreeSet<String> = ["chapter.tex".to_string()].into();
        let warnings = dot_relative_warnings(
            "main.tex",
            "\\input{./chapter}\n% \\input{./chapter}\n\\input{chapter}\n",
            &overlaid,
        );
        assert_eq!(warnings.len(), 1);
        assert_eq!(warnings[0].line, 1);
        assert_eq!(warnings[0].file, "chapter.tex");
        assert!(
            warnings[0].message.contains("chapter.tex"),
            "{}",
            warnings[0].message
        );
    }

    #[test]
    fn the_recorder_names_only_files_from_the_folder() {
        let paths = EnginePaths {
            root: "C:/Users/Ana/Thesis".into(),
            workspace: "C:/Users/Ana/AppData/Local/mdraft/ws".into(),
            overlay: "C:/Users/Ana/AppData/Local/mdraft/ws/overlay".into(),
            out: "C:/Users/Ana/AppData/Local/mdraft/ws/out".into(),
            windows: true,
        };
        // MiKTeX's spelling: a file found in the working directory is named
        // relative to it, with either separator.
        let fls = "PWD C:\\Users\\Ana\\Thesis\r\n\
            INPUT main.tex\r\n\
            INPUT .\\chapters\\two.tex\r\n\
            INPUT C:\\Users\\Ana\\AppData\\Local\\mdraft\\ws\\overlay\\chapters\\one.tex\r\n\
            INPUT ./figures/Plot.png\r\n\
            INPUT C:\\Users\\Ana\\AppData\\Local\\mdraft\\ws\\out\\main.aux\r\n\
            INPUT C:\\Users\\Ana\\AppData\\Roaming\\MiKTeX\\tex\\latex\\x\\x.sty\r\n\
            INPUT c:/users/ana/thesis/local.sty\r\n\
            INPUT ../shared/macros.tex\r\n\
            OUTPUT main.log\r\n";
        assert_eq!(
            recorded_inputs(fls, &paths).into_iter().collect::<Vec<_>>(),
            [
                "chapters/one.tex",
                "chapters/two.tex",
                "figures/Plot.png",
                "main.tex"
            ],
            "an absolute name below the folder came from a search path (a distribution \
             installed inside it), not from the document"
        );
        assert_eq!(
            read_from_folder(fls, &paths)
                .into_iter()
                .collect::<Vec<_>>(),
            ["chapters/two.tex", "figures/Plot.png", "main.tex"]
        );
        let linux = EnginePaths {
            root: "/mnt/c/Thesis".into(),
            workspace: "/mnt/c/ws".into(),
            overlay: "/mnt/c/ws/overlay".into(),
            out: "/mnt/c/ws/out".into(),
            windows: false,
        };
        assert_eq!(
            recorded_inputs(
                "INPUT ./a.tex\nINPUT /mnt/c/ws/overlay/b.tex\nINPUT /mnt/c/ws/out/a.aux\n",
                &linux
            )
            .into_iter()
            .collect::<Vec<_>>(),
            ["a.tex", "b.tex"]
        );
    }

    #[test]
    fn the_bibliography_logs_name_their_inputs() {
        let bibtex = "Database file #1: refs.bib\nDatabase file #2: C:/x/more.bib\n";
        assert_eq!(bibliography_reads(bibtex), ["refs.bib", "C:/x/more.bib"]);
        let biber = "[12] Biber.pm:384> INFO - Found BibTeX data source 'refs.bib'\n";
        assert_eq!(bibliography_reads(biber), ["refs.bib"]);
        let log = "! I can't write on file `chapters/one.aux'.\n";
        assert_eq!(unwritable(log), ["chapters/one.aux"]);

        let paths = EnginePaths {
            root: "/mnt/c/Thesis".into(),
            workspace: "/mnt/c/ws".into(),
            overlay: "/mnt/c/ws/overlay".into(),
            out: "/mnt/c/ws/out".into(),
            windows: false,
        };
        let reads = [
            "refs.bib".to_string(),
            "/mnt/c/ws/out/bib/more.bib".into(),
            "/mnt/c/Thesis/data/found.bib".into(),
            "/usr/share/texlive/texmf-dist/bibtex/bib/x.bib".into(),
            "/mnt/c/ws/texmf/0/bibtex/bib/lib.bib".into(),
        ];
        assert_eq!(
            bibliography_inputs(&reads, &paths),
            ["bib/more.bib", "data/found.bib", "refs.bib"]
        );
    }

    #[test]
    fn a_search_path_never_holds_a_brace_or_comma() {
        assert!(search_safe("C:/Users/Ana/ws", false));
        assert!(search_safe("D:/Thèse/ws", false));
        for bad in ["C:/a,b", "C:/{a}", "C:/a;b", "C:/$HOME"] {
            assert!(!search_safe(bad, false), "{bad}");
        }
        assert!(!search_safe("/mnt/c/a:b", true));
        assert!(linux_search_form("/mnt/c/Thesis, draft").is_err());
    }

    #[test]
    fn a_verbatim_path_reads_plainly_and_a_share_is_recognised() {
        assert_eq!(
            plain(Path::new(r"\\?\C:\Thesis")),
            PathBuf::from(r"C:\Thesis")
        );
        assert_eq!(
            plain(Path::new(r"\\?\UNC\server\share\Thesis")),
            PathBuf::from(r"\\server\share\Thesis")
        );
        assert!(is_network(Path::new(r"\\?\UNC\server\share\Thesis")));
        assert!(is_network(Path::new(r"\\server\share")));
        assert!(!is_network(Path::new(r"\\?\C:\Thesis")));
        assert!(!is_network(Path::new("/home/ana/thesis")));
    }
}
