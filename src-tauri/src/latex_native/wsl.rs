//! TeX Live inside a WSL distribution, driven from Windows MDraft.
//!
//! An ELF engine cannot be started by CreateProcess, and a `\\wsl.localhost`
//! path is only a file view, so every WSL step goes through one launcher:
//!
//! ```text
//! wsl.exe -d <distro> --cd <Windows dir> --exec /usr/bin/env -i NAME=value…
//!         /usr/bin/timeout --kill-after=5s <seconds> <program> <args>
//! ```
//!
//! `--exec` runs the program without a shell, so no path is ever interpolated
//! into shell syntax and no profile script runs. Engine and tool runs keep that
//! exact form. The one exception is discovery, which must resolve names through
//! the distribution's `PATH`: it runs a **constant** POSIX script via
//! `/bin/sh -c`, with no reader-supplied text in it. The Linux environment is
//! passed as `env -i` arguments because Windows variables do not cross into WSL
//! unless named in WSLENV. The controlled PATH drops the Windows PATH that WSL
//! interop appends. Force-killing wsl.exe ended the Linux tree on WSL 2.7.11,
//! but that is not documented, so `timeout` bounds the engine inside the
//! distribution too.
//!
//! Listing distributions reads the registry only. Anything that looks inside a
//! distribution starts its VM, so that is an explicit reader action.

use serde::{Deserialize, Serialize};

#[cfg(any(windows, test))]
use super::runner::RunOutcome;

/// How long a distribution gets to start and answer one look.
///
/// The look is a single launch now, so this covers the cold start of the
/// distribution itself rather than a sequence of probes. Starting a distro with
/// systemd and Docker integration can take a while on a busy profile.
#[cfg(any(windows, test))]
const LOOK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);

/// The last line a completed look prints, so a half-finished or crashed
/// launch is reported instead of being mistaken for "no TeX installed".
#[cfg(any(windows, test))]
const LOOK_SENTINEL: &str = "MDRAFT-LOOK-END";

/// The selected WSL engine directory, as stored in settings.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WslInstallation {
    pub distro: String,
    /// Linux absolute directory holding the engines, e.g. `/usr/bin`.
    pub bin: String,
    /// Engines found at validation; re-checked when a job starts.
    #[serde(default)]
    pub engines: Vec<String>,
    /// Helpers found at validation (bibtex, biber, kpsewhich, latexmk).
    #[serde(default)]
    pub tools: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WslDistribution {
    pub name: String,
    pub version: u32,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WslCandidate {
    pub distro: String,
    pub bin: String,
    pub engines: Vec<String>,
}

/// A Linux absolute directory that is safe to name as an argv element.
pub fn safe_linux_dir(path: &str) -> bool {
    path.starts_with('/')
        && path.len() < 512
        && !path.chars().any(|ch| ch.is_control())
        && path
            .split('/')
            .skip(1)
            .all(|part| !part.is_empty() && part != "." && part != "..")
}

/// A distribution name as WSL accepts it; it is still matched against the
/// registered list before use.
pub fn safe_distro_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'))
}

/// Group engine path lines into directories, in first-seen order.
pub fn group_engines(output: &str) -> Vec<(String, Vec<String>)> {
    let mut out: Vec<(String, Vec<String>)> = Vec::new();
    for line in output.lines().map(str::trim) {
        let Some((dir, name)) = line.rsplit_once('/') else {
            continue;
        };
        if !super::discovery::ENGINES.contains(&name) || !safe_linux_dir(dir) {
            continue;
        }
        match out.iter_mut().find(|(existing, _)| existing == dir) {
            Some((_, engines)) => {
                if !engines.iter().any(|engine| engine == name) {
                    engines.push(name.to_string());
                }
            }
            None => out.push((dir.to_string(), vec![name.to_string()])),
        }
    }
    for (_, engines) in &mut out {
        engines.sort_by_key(|engine| {
            super::discovery::ENGINES
                .iter()
                .position(|known| known == engine)
                .unwrap_or(usize::MAX)
        });
    }
    out
}

/// Turn one completed look into candidates.
///
/// A failed launch used to return an empty list, which the panel showed as "no
/// TeX was found": the reader could not tell a missing installation from WSL
/// failing to answer, and clicking again was the only recourse. Only a script
/// that reached its sentinel may report no engines; anything else is an error
/// the panel can show.
#[cfg(any(windows, test))]
fn parse_look(distro: &str, outcome: &RunOutcome) -> Result<Vec<WslCandidate>, String> {
    if outcome.console.contains(LOOK_SENTINEL) {
        return Ok(group_engines(&outcome.console)
            .into_iter()
            .map(|(bin, engines)| WslCandidate {
                distro: distro.to_string(),
                bin,
                engines,
            })
            .collect());
    }
    if outcome.timed_out {
        return Err(format!(
            "{distro} did not answer within {} seconds while looking for TeX. The distribution may still be starting; try again.",
            LOOK_TIMEOUT.as_secs()
        ));
    }
    let detail = outcome.console.trim();
    let detail = if detail.is_empty() {
        String::new()
    } else {
        format!("\n\n{}", detail.chars().take(600).collect::<String>())
    };
    Err(format!(
        "Looking inside {distro} stopped before it finished (wsl.exe exit {}). The distribution may still be starting; try again.{detail}",
        outcome.status
    ))
}

#[cfg(all(windows, test))]
pub use platform::spec;
#[cfg(windows)]
pub use platform::{distributions, engine_spec, linux_path, look_inside, registered};

#[cfg(windows)]
mod platform {
    use std::ffi::{OsStr, OsString};
    use std::path::{Path, PathBuf};
    use std::sync::atomic::AtomicBool;
    use std::time::Duration;

    use windows::Win32::Foundation::ERROR_SUCCESS;
    use windows::Win32::System::Registry::{
        HKEY, HKEY_CURRENT_USER, KEY_READ, RRF_RT_REG_DWORD, RRF_RT_REG_SZ, RegCloseKey,
        RegEnumKeyExW, RegGetValueW, RegOpenKeyExW,
    };
    use windows::core::{PCWSTR, PWSTR};

    use super::super::runner::{self, RunOutcome, RunSpec};
    use super::{LOOK_TIMEOUT, WslCandidate, WslDistribution, safe_distro_name};

    const LXSS: &str = r"Software\Microsoft\Windows\CurrentVersion\Lxss";

    /// The one script a look runs, as a compile-time constant: nothing the
    /// reader typed is interpolated into shell syntax.
    ///
    /// `command -v` is how a terminal's `which` locates an engine, so an
    /// installation on the distribution's PATH is found even when it is not in
    /// one of the standard trees. Since `PATH` here is the distribution's own
    /// (the inherited Windows PATH is dropped), Windows executables under
    /// `/mnt` can never be selected as an engine.
    pub(super) const LOOK_SCRIPT: &str = r#"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH
for engine in lualatex pdflatex xelatex; do
  found=$(command -v "$engine" 2>/dev/null) || continue
  case "$found" in
    /*) ;;
    *) continue ;;
  esac
  case "$found" in
    /mnt/*) continue ;;
  esac
  [ -x "$found" ] || continue
  printf '%s\n' "$found"
done
for dir in "$HOME/.TinyTeX/bin" "$HOME/.TinyTeX/bin"/* "$HOME/.local/bin" "$HOME/bin" \
  "$HOME/texlive"/*/bin "$HOME/texlive"/*/bin/* \
  /usr/local/texlive/*/bin /usr/local/texlive/*/bin/* \
  /opt/texlive/*/bin /opt/texlive/*/bin/* \
  "$HOME/.nix-profile/bin" /nix/var/nix/profiles/default/bin /run/current-system/sw/bin; do
  [ -d "$dir" ] || continue
  for engine in lualatex pdflatex xelatex; do
    [ -x "$dir/$engine" ] && printf '%s/%s\n' "$dir" "$engine"
  done
done
printf '%s\n' "MDRAFT-LOOK-END"
"#;

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(Some(0)).collect()
    }

    fn reg_string(key: HKEY, name: &str) -> Option<String> {
        let name = wide(name);
        let mut size = 0u32;
        let status = unsafe {
            RegGetValueW(
                key,
                None,
                PCWSTR(name.as_ptr()),
                RRF_RT_REG_SZ,
                None,
                None,
                Some(&mut size),
            )
        };
        if status != ERROR_SUCCESS || size == 0 {
            return None;
        }
        let mut buffer = vec![0u16; (size as usize).div_ceil(2)];
        let status = unsafe {
            RegGetValueW(
                key,
                None,
                PCWSTR(name.as_ptr()),
                RRF_RT_REG_SZ,
                None,
                Some(buffer.as_mut_ptr() as *mut _),
                Some(&mut size),
            )
        };
        if status != ERROR_SUCCESS {
            return None;
        }
        let end = buffer
            .iter()
            .position(|&ch| ch == 0)
            .unwrap_or(buffer.len());
        Some(String::from_utf16_lossy(&buffer[..end]))
    }

    fn reg_dword(key: HKEY, name: &str) -> Option<u32> {
        let name = wide(name);
        let mut value = 0u32;
        let mut size = 4u32;
        let status = unsafe {
            RegGetValueW(
                key,
                None,
                PCWSTR(name.as_ptr()),
                RRF_RT_REG_DWORD,
                None,
                Some(&mut value as *mut u32 as *mut _),
                Some(&mut size),
            )
        };
        (status == ERROR_SUCCESS).then_some(value)
    }

    /// Registered distributions, from the registry only: nothing starts.
    pub fn distributions() -> Vec<WslDistribution> {
        let mut out = Vec::new();
        let mut root = HKEY::default();
        let path = wide(LXSS);
        if unsafe {
            RegOpenKeyExW(
                HKEY_CURRENT_USER,
                PCWSTR(path.as_ptr()),
                None,
                KEY_READ,
                &mut root,
            )
        } != ERROR_SUCCESS
        {
            return out;
        }
        for index in 0..64u32 {
            let mut name = [0u16; 256];
            let mut length = name.len() as u32;
            let status = unsafe {
                RegEnumKeyExW(
                    root,
                    index,
                    Some(PWSTR(name.as_mut_ptr())),
                    &mut length,
                    None,
                    None,
                    None,
                    None,
                )
            };
            if status != ERROR_SUCCESS {
                break;
            }
            let subkey = String::from_utf16_lossy(&name[..length as usize]);
            let full = wide(&format!("{LXSS}\\{subkey}"));
            let mut key = HKEY::default();
            if unsafe {
                RegOpenKeyExW(
                    HKEY_CURRENT_USER,
                    PCWSTR(full.as_ptr()),
                    None,
                    KEY_READ,
                    &mut key,
                )
            } != ERROR_SUCCESS
            {
                continue;
            }
            let distro = reg_string(key, "DistributionName");
            // State 1 is "installed"; other values are installing or uninstalling.
            let state = reg_dword(key, "State").unwrap_or(1);
            let version = reg_dword(key, "Version").unwrap_or(2);
            unsafe {
                let _ = RegCloseKey(key);
            }
            let Some(distro) = distro else { continue };
            if state != 1
                || !safe_distro_name(&distro)
                || distro.to_ascii_lowercase().starts_with("docker-desktop")
            {
                continue;
            }
            out.push(WslDistribution {
                name: distro,
                version,
            });
        }
        unsafe {
            let _ = RegCloseKey(root);
        }
        out
    }

    pub fn registered(distro: &str) -> bool {
        distributions().iter().any(|entry| entry.name == distro)
    }

    fn wsl_exe() -> PathBuf {
        // The Store build of WSL installs the real CLI under Program Files and
        // leaves System32\wsl.exe as a stub that re-launches it. That stub
        // doubles every launch (and its console allocation), which is exactly
        // the kind of delay a reader notices while a distribution starts.
        for key in ["ProgramW6432", "ProgramFiles"] {
            if let Ok(base) = std::env::var(key) {
                let candidate = PathBuf::from(base).join("WSL").join("wsl.exe");
                if candidate.is_file() {
                    return candidate;
                }
            }
        }
        let system = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
        PathBuf::from(system).join("System32").join("wsl.exe")
    }

    /// The Windows environment wsl.exe itself needs. The Linux side gets its
    /// own exact environment through `env -i`.
    fn host_environment() -> Vec<(String, String)> {
        let mut env = Vec::new();
        for key in [
            "SYSTEMROOT",
            "WINDIR",
            "COMSPEC",
            "PATHEXT",
            "USERPROFILE",
            "LOCALAPPDATA",
            "APPDATA",
            "TEMP",
            "TMP",
            "PROGRAMDATA",
            "NUMBER_OF_PROCESSORS",
            "PROCESSOR_ARCHITECTURE",
        ] {
            if let Ok(value) = std::env::var(key) {
                env.push((key.to_string(), value));
            }
        }
        let system = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
        env.push(("PATH".into(), format!("{system}\\System32;{system}")));
        // wsl.exe's own messages are UTF-16 unless this is set.
        env.push(("WSL_UTF8".into(), "1".into()));
        env
    }

    /// One launch: `wsl.exe -d <distro> --cd <cwd> --exec <argv…>`.
    pub fn spec(
        distro: &str,
        cwd: &Path,
        argv: Vec<OsString>,
        timeout: Duration,
    ) -> Result<RunSpec, String> {
        launch(distro, cwd.as_os_str(), cwd, argv, timeout)
    }

    /// A look runs in the distribution's own home. Discovery only reads the
    /// distribution, so it must not depend on Windows drives being mounted
    /// there, and the job directory only holds the Windows-side output file.
    fn home_spec(
        distro: &str,
        process_cwd: &Path,
        argv: Vec<OsString>,
        timeout: Duration,
    ) -> Result<RunSpec, String> {
        launch(distro, OsStr::new("~"), process_cwd, argv, timeout)
    }

    fn launch(
        distro: &str,
        distro_cwd: &OsStr,
        process_cwd: &Path,
        argv: Vec<OsString>,
        timeout: Duration,
    ) -> Result<RunSpec, String> {
        if !safe_distro_name(distro) {
            return Err("Invalid WSL distribution name.".into());
        }
        let mut args: Vec<OsString> = vec![
            "-d".into(),
            distro.into(),
            "--cd".into(),
            distro_cwd.into(),
            "--exec".into(),
        ];
        args.extend(argv);
        Ok(RunSpec {
            program: wsl_exe(),
            args,
            cwd: process_cwd.to_path_buf(),
            env: host_environment(),
            timeout,
        })
    }

    /// Run an engine or helper inside the distribution with an exact
    /// environment and an in-distribution time limit.
    pub fn engine_spec(
        distro: &str,
        cwd: &Path,
        env: &[(String, String)],
        program: &str,
        args: &[OsString],
        timeout: Duration,
    ) -> Result<RunSpec, String> {
        let mut argv: Vec<OsString> = vec!["/usr/bin/env".into(), "-i".into()];
        for (key, value) in env {
            argv.push(format!("{key}={value}").into());
        }
        argv.push("/usr/bin/timeout".into());
        argv.push("--kill-after=5s".into());
        argv.push(timeout.as_secs().max(1).to_string().into());
        argv.push(program.into());
        argv.extend(args.iter().cloned());
        // The Windows-side limit leaves room for the in-distribution one to act first.
        spec(distro, cwd, argv, timeout + Duration::from_secs(15))
    }

    fn run_quiet(spec: &RunSpec) -> Result<RunOutcome, String> {
        runner::run(spec, &AtomicBool::new(false))
    }

    /// The Linux form of a Windows directory, via the distribution's own
    /// `wslpath` (the automount root is configurable, so /mnt is never assumed).
    pub fn linux_path(distro: &str, windows: &Path, scratch: &Path) -> Result<String, String> {
        let outcome = run_quiet(&spec(
            distro,
            scratch,
            vec![
                "/usr/bin/wslpath".into(),
                "-u".into(),
                windows.as_os_str().into(),
            ],
            Duration::from_secs(60),
        )?)?;
        let path = outcome
            .console
            .lines()
            .map(str::trim)
            .find(|line| !line.is_empty())
            .unwrap_or("")
            .to_string();
        if outcome.status != 0 || !path.starts_with('/') || path.chars().any(|ch| ch.is_control()) {
            return Err(format!(
                "{distro} cannot reach {}. Check that Windows drives are mounted in that distribution (automount in /etc/wsl.conf). (wsl.exe exit {}: {})",
                windows.display(),
                outcome.status,
                outcome.console.trim()
            ));
        }
        Ok(path)
    }

    /// Look inside one distribution for TeX engines. Starts its VM.
    ///
    /// One launch, not a `printenv` followed by a `find`: the shell resolves
    /// each engine the way `which` does (the distribution's PATH) and also
    /// checks the versioned TeX Live and TinyTeX layouts, then prints one
    /// absolute path per line. A second attempt covers a distribution that was
    /// still coming up; a launch that never reaches the sentinel is an error,
    /// never an empty result.
    pub fn look_inside(distro: &str, scratch: &Path) -> Result<Vec<WslCandidate>, String> {
        if !registered(distro) {
            return Err(format!("{distro} is not a registered WSL distribution."));
        }
        let mut last = None;
        for attempt in 0..2 {
            if attempt > 0 {
                std::thread::sleep(Duration::from_millis(300));
            }
            let spec = home_spec(
                distro,
                scratch,
                vec!["/bin/sh".into(), "-c".into(), LOOK_SCRIPT.into()],
                LOOK_TIMEOUT,
            )?;
            let outcome = match run_quiet(&spec) {
                Ok(outcome) => outcome,
                Err(error) => {
                    last = Some(error);
                    continue;
                }
            };
            match super::parse_look(distro, &outcome) {
                Ok(candidates) => return Ok(candidates),
                Err(error) => last = Some(error),
            }
        }
        Err(last.unwrap_or_else(|| format!("Could not look inside {distro}.")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn engine_paths_are_grouped_by_directory_in_engine_order() {
        let output = "/usr/bin/pdflatex\n/usr/bin/lualatex\n/usr/local/texlive/2025/bin/x86_64-linux/xelatex\nMDRAFT-LOOK-END\n";
        assert_eq!(
            group_engines(output),
            vec![
                (
                    "/usr/bin".to_string(),
                    vec!["lualatex".to_string(), "pdflatex".to_string()]
                ),
                (
                    "/usr/local/texlive/2025/bin/x86_64-linux".to_string(),
                    vec!["xelatex".to_string()]
                ),
            ]
        );
    }

    #[test]
    fn a_finished_look_returns_the_engines_it_found() {
        let outcome = RunOutcome {
            status: 0,
            console: "/usr/bin/xelatex\n/usr/bin/lualatex\nMDRAFT-LOOK-END\n".into(),
            ..Default::default()
        };
        let candidates = parse_look("Debian", &outcome).unwrap();
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].distro, "Debian");
        assert_eq!(candidates[0].bin, "/usr/bin");
        assert_eq!(
            candidates[0].engines,
            vec!["lualatex".to_string(), "xelatex".to_string()]
        );
    }

    #[test]
    fn a_finished_look_without_engines_is_an_empty_result() {
        let outcome = RunOutcome {
            status: 0,
            console: "MDRAFT-LOOK-END\n".into(),
            ..Default::default()
        };
        assert!(parse_look("Debian", &outcome).unwrap().is_empty());
    }

    #[test]
    fn a_look_that_never_finished_is_an_error_not_an_empty_result() {
        let outcome = RunOutcome {
            status: 1,
            console: "wsl: the distribution is starting".into(),
            ..Default::default()
        };
        let error = parse_look("Debian", &outcome).unwrap_err();
        assert!(error.contains("stopped before it finished"), "{error}");
        assert!(error.contains("exit 1"), "{error}");
    }

    #[cfg(windows)]
    #[test]
    fn the_look_script_prints_the_sentinel_the_parser_waits_for() {
        assert!(platform::LOOK_SCRIPT.contains(LOOK_SENTINEL));
        assert!(platform::LOOK_SCRIPT.contains("command -v"));
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "requires MDRAFT_TEST_WSL_DISTRO"]
    fn an_explicit_look_finds_the_engines_in_a_distribution() {
        let distro = std::env::var("MDRAFT_TEST_WSL_DISTRO").unwrap();
        let scratch = std::env::temp_dir().join(format!("mdraft-wsl-look-{}", std::process::id()));
        std::fs::create_dir_all(&scratch).unwrap();
        let candidates = super::look_inside(&distro, &scratch).unwrap();
        let _ = std::fs::remove_dir_all(&scratch);
        assert!(
            !candidates.is_empty(),
            "{distro} has no LuaLaTeX, pdfLaTeX or XeLaTeX"
        );
        for candidate in candidates {
            assert!(safe_linux_dir(&candidate.bin), "{}", candidate.bin);
            assert!(!candidate.engines.is_empty());
            println!(
                "{}: {} ({})",
                candidate.distro,
                candidate.bin,
                candidate.engines.join(", ")
            );
        }
    }

    #[test]
    fn names_and_paths_are_validated_before_they_become_arguments() {
        assert!(safe_distro_name("Debian"));
        assert!(safe_distro_name("Ubuntu-24.04"));
        assert!(!safe_distro_name("Debian; rm"));
        assert!(!safe_distro_name(""));
        assert!(safe_linux_dir("/usr/local/texlive/2025/bin/x86_64-linux"));
        assert!(!safe_linux_dir("usr/bin"));
        assert!(!safe_linux_dir("/usr/../etc"));
        assert!(!safe_linux_dir("/usr/bin\n/etc"));
    }

    #[test]
    fn older_settings_have_no_wsl_selection() {
        let settings: crate::settings::Settings = serde_json::from_str("{}").unwrap();
        assert!(settings.latex_native_wsl.is_none());
    }
}
