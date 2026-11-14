use std::path::{Component, Path, PathBuf};

/// Normalize a path string lexically (resolving `.` and `..` without touching
/// the filesystem) using platform-appropriate separators so containment checks
/// work even when a virtual file does not yet exist on disk.
pub fn normalize_lexical(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(p) => out.push(p.as_os_str()),
            Component::RootDir => out.push(component.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                let can_pop = matches!(
                    out.components().next_back(),
                    Some(Component::Normal(_))
                );
                if can_pop {
                    out.pop();
                } else if !out.has_root() {
                    out.push("..");
                }
            }
            Component::Normal(part) => out.push(part),
        }
    }
    out
}

/// Check whether `child` resides inside `ancestor`.
///
/// Mirrors `src-tauri/src/typst.rs::is_within`: on Windows path comparisons
/// ignore ASCII case and tolerate trailing backslashes; on Unix paths are
/// compared literally by `Path::starts_with`.
pub fn is_within(child: &Path, ancestor: &Path) -> bool {
    #[cfg(windows)]
    {
        let strip_extended = |s: &str| {
            s.strip_prefix(r"\\?\UNC\")
                .map(|rest| format!(r"\\{rest}"))
                .or_else(|| s.strip_prefix(r"\\?\").map(str::to_owned))
                .unwrap_or_else(|| s.to_owned())
        };
        let norm = |p: &Path| -> String {
            strip_extended(&p.to_string_lossy())
                .trim_end_matches(['\\', '/'])
                .replace('/', "\\")
                .to_ascii_lowercase()
        };
        let c = norm(child);
        let a = norm(ancestor);
        if a.is_empty() {
            return false;
        }
        c == a || (c.starts_with(&a) && c.as_bytes().get(a.len()) == Some(&b'\\'))
    }
    #[cfg(not(windows))]
    {
        child.starts_with(ancestor)
    }
}

/// Canonicalize `root` if it exists on disk, falling back to lexical
/// normalization when constructing ephemeral test roots.
pub fn canonicalize_root(root: &Path) -> PathBuf {
    std::fs::canonicalize(root).unwrap_or_else(|_| normalize_lexical(root))
}

/// Convert a host path (relative to `root` or absolute) into a forward-slash
/// virtual path string guaranteed not to escape `root`.
///
/// If an existing target (or nearest existing ancestor directory) is a symlink
/// pointing outside `root`, it is rejected so symlinks cannot bypass `--root`.
pub fn validate_and_virtualize(root: &Path, canon_root: &Path, path: &Path) -> Result<String, String> {
    let joined = if path.is_absolute() {
        path.to_path_buf()
    } else {
        root.join(path)
    };
    let lexical = normalize_lexical(&joined);
    if !is_within(&lexical, &normalize_lexical(root)) && !is_within(&lexical, canon_root) {
        return Err(format!(
            "path `{}` escapes workspace root `{}`",
            path.display(),
            root.display()
        ));
    }

    // Check symlink containment against canonicalized filesystem paths.
    if joined.exists() {
        let canon = std::fs::canonicalize(&joined).map_err(|e| e.to_string())?;
        if !is_within(&canon, canon_root) {
            return Err(format!(
                "canonical path `{}` escapes root `{}`",
                canon.display(),
                canon_root.display()
            ));
        }
    } else if root.exists() {
        // Walk upwards inside `root` to catch symlinked parent directories.
        let norm_root = normalize_lexical(root);
        let mut cursor = lexical.as_path();
        while let Some(parent) = cursor.parent() {
            if !is_within(parent, &norm_root) {
                break;
            }
            if parent.exists() {
                let canon_parent = std::fs::canonicalize(parent).map_err(|e| e.to_string())?;
                if !is_within(&canon_parent, canon_root) {
                    return Err(format!(
                        "ancestor `{}` escapes root `{}`",
                        canon_parent.display(),
                        canon_root.display()
                    ));
                }
                break;
            }
            cursor = parent;
        }
    }

    relative_vpath(root, canon_root, &lexical)
}

/// Compute a normalized forward-slash path relative to `root`.
pub fn relative_vpath(root: &Path, canon_root: &Path, target: &Path) -> Result<String, String> {
    let norm_root = normalize_lexical(root);
    let norm_target = normalize_lexical(target);

    #[cfg(windows)]
    let rel = {
        let strip = |p: &Path| -> String {
            let s = p.to_string_lossy();
            s.strip_prefix(r"\\?\")
                .unwrap_or(&s)
                .replace('/', "\\")
        };
        let t_str = strip(&norm_target);
        let r_str = strip(&norm_root).trim_end_matches('\\').to_owned();
        let cr_str = strip(canon_root).trim_end_matches('\\').to_owned();
        let t_lower = t_str.to_ascii_lowercase();
        let r_lower = r_str.to_ascii_lowercase();
        let cr_lower = cr_str.to_ascii_lowercase();
        if t_lower == r_lower || t_lower == cr_lower {
            String::new()
        } else if t_lower.starts_with(&(r_lower.clone() + "\\")) {
            t_str[r_str.len() + 1..].to_owned()
        } else if t_lower.starts_with(&(cr_lower.clone() + "\\")) {
            t_str[cr_str.len() + 1..].to_owned()
        } else {
            return Err(format!(
                "path `{}` is outside workspace root `{}`",
                target.display(),
                root.display()
            ));
        }
    };

    #[cfg(not(windows))]
    let rel = {
        if let Ok(stripped) = norm_target.strip_prefix(&norm_root) {
            stripped.to_string_lossy().into_owned()
        } else if let Ok(stripped) = norm_target.strip_prefix(canon_root) {
            stripped.to_string_lossy().into_owned()
        } else {
            return Err(format!(
                "path `{}` is outside workspace root `{}`",
                target.display(),
                root.display()
            ));
        }
    };

    let clean = normalize_vpath_key(&rel);
    if clean.is_empty() {
        return Err("path points to root directory rather than a file".into());
    }
    Ok(clean)
}

/// Normalize a virtual path key to `a/b/c` without leading slashes or `..`.
pub fn normalize_vpath_key(raw: &str) -> String {
    let mut parts: Vec<&str> = Vec::new();
    for seg in raw.split(['/', '\\']) {
        match seg {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            s => parts.push(s),
        }
    }
    parts.join("/")
}

/// Verify that an existing disk file under `realized_path` stays inside
/// `canon_root` after resolving symlinks/junctions.
pub fn verify_realized_within_root(realized: &Path, canon_root: &Path) -> Result<(), String> {
    if !realized.exists() {
        return Ok(());
    }
    let canon = std::fs::canonicalize(realized).map_err(|e| e.to_string())?;
    if !is_within(&canon, canon_root) {
        return Err(format!(
            "resolved path `{}` escapes root `{}`",
            canon.display(),
            canon_root.display()
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lexical_escape_is_blocked() {
        let dir = std::env::temp_dir().join("mdraft_sec_test");
        let root = dir.join("workspace");
        let canon = normalize_lexical(&root);
        let outside = Path::new("../secret.typ");
        assert!(validate_and_virtualize(&root, &canon, outside).is_err());
    }

    #[test]
    fn inside_relative_path_normalizes_cleanly() {
        let dir = std::env::temp_dir().join("mdraft_sec_ok");
        let root = dir.join("workspace");
        let canon = normalize_lexical(&root);
        let res = validate_and_virtualize(&root, &canon, Path::new("chapters/./one.typ")).unwrap();
        assert_eq!(res, "chapters/one.typ");
    }

    #[cfg(windows)]
    #[test]
    fn windows_case_insensitive_root_check() {
        let a = Path::new(r"C:\Users\Test\Docs\");
        let c = Path::new(r"c:\users\test\docs\chapters\one.typ");
        assert!(is_within(c, a));
        let canon = a.to_path_buf();
        let rel = validate_and_virtualize(a, &canon, c).unwrap();
        assert_eq!(rel, "chapters/one.typ");
    }
}
