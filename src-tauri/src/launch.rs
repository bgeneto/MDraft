//! Second-launch handoff and initial multi-file argv.
//!
//! The single-instance plugin stops a second process before it creates a
//! WebView, but it only hands us `(args, cwd)`. This module turns those into
//! document paths, queues them for a webview that may not have installed its
//! listener yet, and focuses the one window that owns them.

use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Default)]
pub struct LaunchState {
    /// Paths forwarded before the frontend asked for them. Drained once, so a
    /// second launch during start-up is not lost.
    forwarded: Mutex<Vec<String>>,
}

/// Resolve the arguments of a launch into document paths.
///
/// The executable is `args[0]`; switches are ignored until `--`, after which a
/// token may legitimately begin with `-`. A relative path is resolved against
/// the launch's working directory, never against the already-running process's
/// directory. Existence is deliberately not checked: the UI must be able to
/// report a missing path instead of the path silently disappearing.
pub(crate) fn launch_paths(args: &[String], cwd: &Path) -> Vec<String> {
    let mut paths = Vec::new();
    let mut seen = Vec::new();
    let mut literal = false;

    for token in args.iter().skip(1) {
        if !literal && token == "--" {
            literal = true;
            continue;
        }
        if !literal && token.starts_with('-') {
            continue;
        }
        if token.is_empty() {
            continue;
        }

        let candidate = PathBuf::from(token);
        let resolved = if candidate.is_absolute() {
            candidate
        } else {
            cwd.join(candidate)
        };
        let value = normalize(resolved).to_string_lossy().to_string();
        let key = path_key(&value);
        if seen.contains(&key) {
            continue;
        }
        seen.push(key);
        paths.push(value);
    }

    paths
}

fn normalize(path: PathBuf) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if !out.pop() && !out.has_root() {
                    out.push("..");
                }
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// The platform's path identity, used only to drop duplicate arguments.
fn path_key(path: &str) -> String {
    let normalized = path.replace('\\', "/").trim_end_matches('/').to_string();
    if cfg!(windows) {
        normalized.to_lowercase()
    } else {
        normalized
    }
}

/// Every path the first launch was given (`mdraft a.md b.md`).
#[tauri::command]
pub fn startup_files() -> Vec<String> {
    let args: Vec<String> = std::env::args().collect();
    let cwd = std::env::current_dir().unwrap_or_default();
    launch_paths(&args, &cwd)
}

/// Drain paths forwarded before the frontend installed its `open-files`
/// listener. Calling this with an empty queue is harmless.
#[tauri::command]
pub fn take_forwarded_paths(state: State<'_, LaunchState>) -> Vec<String> {
    drain(&state)
}

fn enqueue(state: &LaunchState, paths: &[String]) {
    let Ok(mut queue) = state.forwarded.lock() else {
        return;
    };
    for path in paths {
        let key = path_key(path);
        if !queue.iter().any(|queued| path_key(queued) == key) {
            queue.push(path.clone());
        }
    }
}

fn drain(state: &LaunchState) -> Vec<String> {
    state
        .forwarded
        .lock()
        .map(|mut paths| std::mem::take(&mut *paths))
        .unwrap_or_default()
}

/// Plugin callback for a second launch.
///
/// Queue first, then emit: the frontend may install its listener a few
/// milliseconds after start-up, and the queue is what makes that window safe.
/// Emitting as well keeps a normal, already-running window immediate; opening
/// a path that arrived through both routes focuses the existing tab instead of
/// duplicating it.
pub fn on_second_instance<R: tauri::Runtime>(
    app: &AppHandle<R>,
    args: Vec<String>,
    cwd: String,
) {
    let paths = launch_paths(&args, Path::new(&cwd));
    if !paths.is_empty() {
        if let Some(state) = app.try_state::<LaunchState>() {
            enqueue(&state, &paths);
        }
        let _ = app.emit("open-files", paths);
    }

    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    #[test]
    fn skips_the_executable_and_switches() {
        let paths = launch_paths(
            &args(&["mdraft.exe", "--flag", "notes.md", "--", "-dashed.md"]),
            Path::new("base"),
        );
        assert_eq!(
            paths,
            vec![
                Path::new("base").join("notes.md").to_string_lossy().to_string(),
                Path::new("base").join("-dashed.md").to_string_lossy().to_string(),
            ]
        );
        assert!(launch_paths(&[], Path::new("base")).is_empty());
        assert!(launch_paths(&args(&["mdraft.exe"]), Path::new("base")).is_empty());
    }

    #[test]
    fn resolves_relative_paths_against_the_launch_directory() {
        let paths = launch_paths(
            &args(&["mdraft.exe", "sub/../notes.md", "./other.md"]),
            Path::new("base"),
        );
        assert_eq!(
            paths,
            vec![
                Path::new("base").join("notes.md").to_string_lossy().to_string(),
                Path::new("base").join("other.md").to_string_lossy().to_string(),
            ]
        );
    }

    #[test]
    fn keeps_missing_paths_and_deduplicates() {
        let paths = launch_paths(
            &args(&["mdraft.exe", "missing.md", "missing.md", "notes.md", "./notes.md"]),
            Path::new("base"),
        );
        assert_eq!(
            paths,
            vec![
                Path::new("base").join("missing.md").to_string_lossy().to_string(),
                Path::new("base").join("notes.md").to_string_lossy().to_string(),
            ]
        );
    }

    #[test]
    fn keeps_absolute_paths_and_their_spacing() {
        let absolute = std::env::temp_dir().join("notas da aula.md");
        let absolute_text = absolute.to_string_lossy().to_string();
        let paths = launch_paths(
            &args(&["mdraft.exe", &absolute_text, "ação.md"]),
            Path::new("base"),
        );
        assert_eq!(paths[0], absolute_text);
        assert_eq!(
            paths[1],
            Path::new("base")
                .join("ação.md")
                .to_string_lossy()
                .to_string()
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_path_identity_ignores_case() {
        let paths = launch_paths(
            &args(&["mdraft.exe", "C:\\Docs\\A.md", "c:\\docs\\a.md"]),
            Path::new("base"),
        );
        assert_eq!(paths.len(), 1);
    }

    #[cfg(not(windows))]
    #[test]
    fn unix_path_identity_keeps_case() {
        let paths = launch_paths(
            &args(&["mdraft.exe", "/docs/A.md", "/docs/a.md"]),
            Path::new("base"),
        );
        assert_eq!(paths.len(), 2);
    }

    #[test]
    fn a_forwarded_path_is_queued_once_and_drained_once() {
        let state = LaunchState::default();
        enqueue(&state, &args(&["notes.md"]));
        enqueue(&state, &args(&["notes.md", "other.md"]));
        assert_eq!(drain(&state), vec!["notes.md", "other.md"]);
        assert!(drain(&state).is_empty());
    }
}
