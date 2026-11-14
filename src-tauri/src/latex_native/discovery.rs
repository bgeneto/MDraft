//! Finding installed TeX distributions without launching anything.
//!
//! Discovery is metadata only. Even `lualatex --version` executes external code,
//! and the repository's rule is that the network and process boundary is proven
//! before MDraft runs an installed engine — so this module only looks at
//! directory entries. Validation, which does execute probes, is a separate,
//! explicit step.

use std::path::{Path, PathBuf};

/// The engines the native backend can select.
pub const ENGINES: &[&str] = &["lualatex", "pdflatex", "xelatex"];

/// The auxiliary tools a build may use, in the order preferences reports them.
pub const TOOLS: &[&str] = &["latexmk", "bibtex", "biber", "kpsewhich"];

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    /// The directory the engines live in, as found.
    pub directory: String,
    /// The inferred distribution root (the tree that owns `texmf`), if any.
    pub root: Option<String>,
    /// `"path"` or `"standard"`, so the panel can explain where it came from.
    pub source: String,
    /// A readable distribution name, e.g. `MiKTeX` or `TeX Live`.
    pub distribution: String,
    /// Engine ids present in `directory`.
    pub engines: Vec<String>,
}

/// The executable suffix this platform uses.
pub fn exe(name: &str) -> String {
    if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    }
}

pub fn engine_path(directory: &Path, engine: &str) -> PathBuf {
    directory.join(exe(engine))
}

pub fn has_engine(directory: &Path, engine: &str) -> bool {
    // Installed engines are often symlinks (Debian's /usr/bin/lualatex and
    // MacTeX's /Library/TeX/texbin both are), and the installed distribution is
    // the reader's choice, not a confined project path. Follow the link.
    std::fs::metadata(engine_path(directory, engine)).is_ok_and(|meta| meta.is_file())
}

/// Whether a string names one of the engines we support.
pub fn known_engine(value: &str) -> Option<&'static str> {
    ENGINES.iter().copied().find(|engine| *engine == value)
}

/// A readable name for the distribution a binary directory belongs to.
pub fn distribution_name(directory: &str) -> String {
    let lower = directory.to_ascii_lowercase();
    if lower.contains("miktex") {
        "MiKTeX".into()
    } else if lower.contains("macports") {
        "MacPorts TeX Live".into()
    } else if lower.contains("homebrew") || lower.contains("/opt/homebrew/") {
        "Homebrew TeX Live".into()
    } else if lower.contains("tinytex") {
        "TinyTeX".into()
    } else if lower.contains("texlive") || lower.contains("/texmf") {
        "TeX Live".into()
    } else if lower.contains("texbin") {
        "MacTeX".into()
    } else if lower.contains("tex") {
        "TeX distribution".into()
    } else {
        directory.to_string()
    }
}

/// Walk up from a binary directory to the tree that owns the distribution.
///
/// The shapes this recognises are the ones the supported installers produce:
/// `…/texlive/2025/bin/x86_64-linux`, `…/MiKTeX/miktex/bin/x64`, and the
/// portable MiKTeX layout `…/install/texmfs/install/miktex/bin/x64`. The walk is
/// bounded to four levels and stops at a drive/root, so it can never select an
/// unrelated ancestor.
pub fn infer_root(bin: &Path) -> Option<PathBuf> {
    let mut best = None;
    let mut current = bin.to_path_buf();
    for _ in 0..5 {
        let parent = current.parent()?;
        let Some(_) = parent.parent() else {
            break;
        };
        let candidate = parent.to_path_buf();
        if has_distribution_marker(&candidate) {
            // Keep walking: a portable MiKTeX has `texmfs` one level above the
            // `texmf` tree, and the whole portable root is what needs the grant.
            best = Some(candidate.clone());
        }
        current = candidate;
    }
    best
}
fn has_distribution_marker(path: &Path) -> bool {
    if path.file_name().is_some_and(|name| {
        let name = name.to_string_lossy().to_ascii_lowercase();
        name == "texmfs" || name == "texmf" || name.starts_with("texmf-")
    }) {
        return true;
    }
    let Ok(entries) = std::fs::read_dir(path) else {
        return false;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
        if name == "texmf" || name.starts_with("texmf-") || name == "texmfs" {
            return true;
        }
    }
    false
}

/// Append a directory once.
fn push_dir(out: &mut Vec<(PathBuf, &'static str)>, path: PathBuf, source: &'static str) {
    if !out.iter().any(|(existing, _)| existing == &path) {
        out.push((path, source));
    }
}

/// The directories a search may inspect, in the order they are shown.
///
/// Bounded on purpose: PATH entries, a short list of platform-standard
/// locations, and at most one level of version-named children under the TeX Live
/// roots. There is no disk walk, and a directory that does not exist costs one
/// failed metadata call.
pub fn search_directories() -> Vec<(PathBuf, &'static str)> {
    let mut out: Vec<(PathBuf, &'static str)> = Vec::new();

    for entry in std::env::var_os("PATH")
        .unwrap_or_default()
        .to_string_lossy()
        .split(if cfg!(windows) { ';' } else { ':' })
    {
        let path = PathBuf::from(entry);
        if path.is_absolute() && out.len() < 64 {
            push_dir(&mut out, path, "path");
        }
    }

    if cfg!(windows) {
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            let local = PathBuf::from(local);
            push_dir(
                &mut out,
                local.join("Programs/MiKTeX/miktex/bin/x64"),
                "standard",
            );
            push_dir(
                &mut out,
                local.join("Programs/MiKTeX/miktex/bin"),
                "standard",
            );
            push_dir(
                &mut out,
                local.join("Programs/MiKTeX/miktex/bin/x86"),
                "standard",
            );
        }
        if let Some(program_files) = std::env::var_os("ProgramFiles") {
            let program_files = PathBuf::from(program_files);
            push_dir(
                &mut out,
                program_files.join("MiKTeX/miktex/bin/x64"),
                "standard",
            );
            push_dir(
                &mut out,
                program_files.join("MiKTeX/miktex/bin"),
                "standard",
            );
        }
        if let Some(program_files) = std::env::var_os("ProgramFiles(x86)") {
            push_dir(
                &mut out,
                PathBuf::from(program_files).join("MiKTeX/miktex/bin"),
                "standard",
            );
        }
        push_dir(&mut out, PathBuf::from("C:/texlive"), "standard");
    } else if cfg!(target_os = "macos") {
        push_dir(&mut out, PathBuf::from("/Library/TeX/texbin"), "standard");
        push_dir(&mut out, PathBuf::from("/usr/local/texlive"), "standard");
        push_dir(&mut out, PathBuf::from("/opt/homebrew/bin"), "standard");
        push_dir(&mut out, PathBuf::from("/usr/local/bin"), "standard");
        if let Some(home) = std::env::var_os("HOME") {
            push_dir(
                &mut out,
                PathBuf::from(home).join("Library/TinyTeX/bin"),
                "standard",
            );
        }
    } else {
        push_dir(&mut out, PathBuf::from("/usr/bin"), "standard");
        push_dir(&mut out, PathBuf::from("/usr/local/bin"), "standard");
        push_dir(&mut out, PathBuf::from("/usr/local/texlive"), "standard");
        push_dir(&mut out, PathBuf::from("/opt/texlive"), "standard");
        if let Some(home) = std::env::var_os("HOME") {
            push_dir(
                &mut out,
                PathBuf::from(&home).join(".TinyTeX/bin"),
                "standard",
            );
            push_dir(&mut out, PathBuf::from(home).join(".local/bin"), "standard");
        }
    }

    // Version-named children of the TeX Live roots, one level deep, newest
    // first. Installing a new year must not require editing the search list.
    let mut versions: Vec<(PathBuf, &'static str)> = Vec::new();
    for (directory, source) in &out {
        if !directory
            .file_name()
            .is_some_and(|name| name.eq_ignore_ascii_case("texlive"))
        {
            continue;
        }
        let Ok(entries) = std::fs::read_dir(directory) else {
            continue;
        };
        for entry in entries.flatten() {
            if !entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                continue;
            }
            let bin = entry
                .path()
                .join(if cfg!(windows) { "bin/windows" } else { "bin" });
            let Ok(bins) = std::fs::read_dir(&bin) else {
                continue;
            };
            for arch in bins.flatten() {
                if arch.file_type().is_ok_and(|kind| kind.is_dir()) {
                    versions.push((arch.path(), *source));
                }
            }
        }
    }
    versions.sort_by(|left, right| right.0.cmp(&left.0));
    for (path, source) in versions {
        push_dir(&mut out, path, source);
    }

    out
}

/// Every directory that contains at least one supported engine.
pub fn discover() -> Vec<Candidate> {
    let mut candidates: Vec<Candidate> = Vec::new();
    for (directory, source) in search_directories() {
        let engines: Vec<String> = ENGINES
            .iter()
            .filter(|engine| has_engine(&directory, engine))
            .map(|engine| (*engine).to_string())
            .collect();
        if engines.is_empty() {
            continue;
        }
        let root = infer_root(&directory).map(|root| root.display().to_string());
        let candidate = Candidate {
            directory: directory.display().to_string(),
            distribution: distribution_name(&directory.display().to_string()),
            root,
            source: source.to_string(),
            engines,
        };
        if !candidates
            .iter()
            .any(|existing| same_path(&existing.directory, &candidate.directory))
        {
            candidates.push(candidate);
        }
    }
    candidates
}

/// Windows paths compare case-insensitively; the rest compare exactly.
pub fn same_path(left: &str, right: &str) -> bool {
    if cfg!(windows) {
        left.eq_ignore_ascii_case(right)
    } else {
        left == right
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "mdraft-discovery-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn a_binary_directory_is_a_candidate_and_an_empty_one_is_not() {
        let root = temp("candidate");
        let bin = root.join("bin/x64");
        fs::create_dir_all(&bin).unwrap();
        fs::write(engine_path(&bin, "lualatex"), b"").unwrap();
        assert!(has_engine(&bin, "lualatex"));
        assert!(!has_engine(&bin, "pdflatex"));
        assert_eq!(known_engine("xelatex"), Some("xelatex"));
        assert_eq!(known_engine("sh"), None);
    }

    #[test]
    fn the_root_is_the_ancestor_that_owns_texmf() {
        let root = temp("root");
        fs::create_dir_all(root.join("2025/texmf-dist")).unwrap();
        let bin = root.join("2025/bin/x86_64-linux");
        fs::create_dir_all(&bin).unwrap();
        assert_eq!(infer_root(&bin), Some(root.join("2025")));
    }

    #[test]
    fn a_portable_miktex_layout_is_recognised() {
        let root = temp("miktex");
        fs::create_dir_all(root.join("texmfs/install/texmf")).unwrap();
        let bin = root.join("texmfs/install/miktex/bin/x64");
        fs::create_dir_all(&bin).unwrap();
        assert_eq!(infer_root(&bin), Some(root.to_path_buf()));
    }

    #[test]
    fn an_unrelated_directory_has_no_root() {
        let root = temp("plain");
        let bin = root.join("bin");
        fs::create_dir_all(&bin).unwrap();
        assert_eq!(infer_root(&bin), None);
    }

    #[test]
    fn distribution_names_are_readable() {
        assert_eq!(
            distribution_name("/usr/local/texlive/2025/bin/x"),
            "TeX Live"
        );
        assert_eq!(
            distribution_name("C:/Users/x/AppData/Local/Programs/MiKTeX/miktex/bin/x64"),
            "MiKTeX"
        );
        assert_eq!(distribution_name("/Library/TeX/texbin"), "MacTeX");
        assert_eq!(
            distribution_name("/home/x/.TinyTeX/bin/x86_64-linux"),
            "TinyTeX"
        );
    }

    #[test]
    fn path_identity_follows_the_platform() {
        if cfg!(windows) {
            assert!(same_path("C:/TeX", "c:/tex"));
        } else {
            assert!(!same_path("/TeX", "/tex"));
        }
    }
}
