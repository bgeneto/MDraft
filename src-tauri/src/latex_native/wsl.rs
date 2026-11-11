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
//! into shell syntax and no profile script runs. The Linux environment is passed
//! as `env -i` arguments because Windows variables do not cross into WSL unless
//! named in WSLENV. The controlled PATH drops the Windows PATH that WSL interop
//! appends. Force-killing wsl.exe ended the Linux tree on WSL 2.7.11, but that is
//! not documented, so `timeout` bounds the engine inside the distribution too.
//!
//! Listing distributions reads the registry only. Anything that looks inside a
//! distribution starts its VM, so that is an explicit reader action.

use serde::{Deserialize, Serialize};

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

/// Group `find` output lines into engine directories, in first-seen order.
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

#[cfg(all(windows, test))]
pub use platform::spec;
#[cfg(windows)]
pub use platform::{distributions, engine_spec, linux_path, look_inside, registered};

#[cfg(windows)]
mod platform {
    use std::ffi::OsString;
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
    use super::{WslCandidate, WslDistribution, group_engines, safe_distro_name, safe_linux_dir};

    const LXSS: &str = r"Software\Microsoft\Windows\CurrentVersion\Lxss";

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
        if !safe_distro_name(distro) {
            return Err("Invalid WSL distribution name.".into());
        }
        let mut args: Vec<OsString> = vec![
            "-d".into(),
            distro.into(),
            "--cd".into(),
            cwd.as_os_str().into(),
            "--exec".into(),
        ];
        args.extend(argv);
        Ok(RunSpec {
            program: wsl_exe(),
            args,
            cwd: cwd.to_path_buf(),
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
    pub fn look_inside(distro: &str, scratch: &Path) -> Result<Vec<WslCandidate>, String> {
        if !registered(distro) {
            return Err(format!("{distro} is not a registered WSL distribution."));
        }
        let home = run_quiet(&spec(
            distro,
            scratch,
            vec!["/usr/bin/printenv".into(), "HOME".into()],
            Duration::from_secs(90),
        )?)?;
        if home.status != 0 && home.console.trim().is_empty() {
            return Err(format!("{distro} did not start: {}", home.console.trim()));
        }
        let mut roots: Vec<OsString> = vec![
            "/usr/bin".into(),
            "/usr/local/bin".into(),
            "/usr/local/texlive".into(),
            "/opt/texlive".into(),
        ];
        if let Some(home) = home
            .console
            .lines()
            .map(str::trim)
            .find(|line| safe_linux_dir(line))
        {
            roots.push(format!("{home}/.TinyTeX/bin").into());
            roots.push(format!("{home}/texlive").into());
        }
        let mut argv: Vec<OsString> = vec!["/usr/bin/find".into()];
        argv.extend(roots);
        for arg in [
            "-maxdepth",
            "4",
            "(",
            "-name",
            "lualatex",
            "-o",
            "-name",
            "pdflatex",
            "-o",
            "-name",
            "xelatex",
            ")",
            "-executable",
            "-print",
        ] {
            argv.push(arg.into());
        }
        // find exits non-zero for absent roots; its stdout is still complete.
        let found = run_quiet(&spec(distro, scratch, argv, Duration::from_secs(60))?)?;
        Ok(group_engines(&found.console)
            .into_iter()
            .map(|(bin, engines)| WslCandidate {
                distro: distro.to_string(),
                bin,
                engines,
            })
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn find_output_is_grouped_by_directory_in_engine_order() {
        let output = "/usr/bin/pdflatex\n/usr/bin/lualatex\n/usr/local/texlive/2025/bin/x86_64-linux/xelatex\nfind: '/opt/texlive': No such file or directory\n/usr/bin/sh\n";
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
