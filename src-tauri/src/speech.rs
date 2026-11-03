//! Read Aloud's Linux backend, through speech-dispatcher.
//!
//! WebKitGTK on Ubuntu is built without the Web Speech synthesis API: measured
//! with WebKitGTK 2.52.6, `'speechSynthesis' in window` is `false`. Installing
//! speech-dispatcher cannot change that. The system already exposes the voices
//! through `spd-say`, so this module drives that command directly:
//!
//! - `speech_status` lists the default voice for every language and caches it;
//! - `speech_speak` runs one sentence with `spd-say -w` and resolves when it has
//!   been spoken, which is what advances the frontend's sentence queue;
//! - `speech_stop` kills the waiting child and cancels the connection's queue.
//!
//! `spd-say` is part of the `speech-dispatcher` package and is also present on
//! Fedora and Arch, so no header, linker dependency or bundled engine is pulled
//! in. Windows and macOS keep using the webview's own Web Speech catalogue.

use serde::Serialize;
use std::process::Child;
use std::sync::{Arc, Mutex};

use tauri::State;

/// One voice the system can use. The shape matches `VoiceOption` in
/// `src/read-aloud.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechVoice {
    pub name: String,
    pub lang: String,
    pub local: bool,
    pub is_default: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechStatus {
    pub available: bool,
    /// Why the service cannot be used, when it cannot. `None` when it can.
    pub reason: Option<String>,
    pub voices: Vec<SpeechVoice>,
}

/// The process's current `spd-say -w` child and the parsed catalogue.
#[derive(Default)]
pub struct SpeechState {
    current: Arc<Mutex<Option<Child>>>,
    voices: Arc<Mutex<Option<Vec<SpeechVoice>>>>,
}

/// The sentence cap the frontend already applies. This is a second bound so a
/// malformed IPC call cannot hand an unbounded string to a child process.
const MAX_SPEECH_CHARS: usize = 10_000;

// The four `spd-say` helpers below exist for the Linux backend and for the
// tests, which run on every platform. On Windows and macOS the non-Linux
// `status_blocking`/`speak_blocking` never call them, so an ungated definition
// is dead code there and `cargo clippy --all-targets -- -D warnings` fails on
// `function ... is never used`. Keeping `test` in the gate is what lets the
// parser and argument tests run on every host.

/// `spd-say` wants -100..100, where 0 is the synthesiser's normal pace. The
/// frontend uses the Web Speech 0.5..2.0 scale, so 1.0 maps to 0 and each 0.5
/// step is fifty points.
#[cfg(any(target_os = "linux", test))]
pub(crate) fn rate_to_spd(rate: f64) -> i32 {
    if !rate.is_finite() {
        return 0;
    }
    let clamped = rate.clamp(0.5, 2.0);
    ((clamped - 1.0) * 100.0).round() as i32
}

/// The base ISO code `spd-say -l` expects. A regional tag (`pt-BR`) is reduced
/// to `pt`; the named voice carries the region when there is one.
#[cfg(any(target_os = "linux", test))]
pub(crate) fn spd_language(tag: &str) -> String {
    let normalized = tag.trim().replace('_', "-");
    if normalized.is_empty() || normalized.eq_ignore_ascii_case("auto") {
        return String::new();
    }
    normalized
        .split('-')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase()
}

/// Parse `spd-say -L`.
///
/// The output is a fixed-width table whose NAME column contains spaces and
/// variants (`English (America)+David`), so the last two whitespace-separated
/// fields are LANGUAGE and VARIANT. Only the `none` variant is kept: the full
/// list is 14,806 rows on espeak-ng, while one default per language is 141 and
/// is what a voice picker can present. The first `none` row of each language is
/// marked as its default.
#[cfg(any(target_os = "linux", test))]
pub(crate) fn parse_voices(output: &str) -> Vec<SpeechVoice> {
    let mut voices = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut first_for_language = std::collections::HashSet::new();
    for line in output.lines() {
        let tokens: Vec<&str> = line.split_whitespace().collect();
        if tokens.len() < 3 {
            continue;
        }
        let variant = tokens[tokens.len() - 1];
        if variant != "none" {
            continue;
        }
        let lang = tokens[tokens.len() - 2];
        let name = tokens[..tokens.len() - 2].join(" ");
        if name.is_empty() || lang.is_empty() || !seen.insert(name.clone()) {
            continue;
        }
        let is_default = first_for_language.insert(lang.to_string());
        voices.push(SpeechVoice {
            name,
            lang: lang.to_string(),
            local: true,
            is_default,
        });
    }
    voices
}

/// Build the `spd-say -w` command line. Kept pure so the test can inspect it
/// without starting a process.
#[cfg(any(target_os = "linux", test))]
pub(crate) fn speak_arguments(text: &str, lang: &str, voice: &str, rate: f64) -> Vec<String> {
    let mut arguments = vec![
        "-w".to_string(),
        "-N".to_string(),
        "MDraft".to_string(),
        "-n".to_string(),
        "mdraft".to_string(),
        "-r".to_string(),
        rate_to_spd(rate).to_string(),
    ];
    let voice = voice.trim();
    if !voice.is_empty() {
        arguments.push("-y".to_string());
        arguments.push(voice.to_string());
    } else {
        let language = spd_language(lang);
        if !language.is_empty() {
            arguments.push("-l".to_string());
            arguments.push(language);
        }
    }
    arguments.push("--".to_string());
    arguments.push(text.to_string());
    arguments
}

#[cfg(target_os = "linux")]
fn status_blocking(cache: &Arc<Mutex<Option<Vec<SpeechVoice>>>>) -> SpeechStatus {
    if let Ok(cache) = cache.lock()
        && let Some(voices) = cache.as_ref()
        && !voices.is_empty()
    {
        return SpeechStatus {
            available: true,
            reason: None,
            voices: voices.clone(),
        };
    }

    let output = match std::process::Command::new("spd-say").arg("-L").output() {
        Ok(output) => output,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return SpeechStatus {
                available: false,
                reason: Some(
                    "Read Aloud needs speech-dispatcher. Install it and a synthesiser with: \
                     sudo apt install speech-dispatcher espeak-ng (use your distribution's \
                     package manager elsewhere), then test it with: spd-say \"Hello\"."
                        .to_string(),
                ),
                voices: Vec::new(),
            };
        }
        Err(_) => {
            return SpeechStatus {
                available: false,
                reason: Some(
                    "speech-dispatcher could not be started. Test it in a terminal with: \
                     spd-say \"Hello\"."
                        .to_string(),
                ),
                voices: Vec::new(),
            };
        }
    };

    let text = String::from_utf8_lossy(&output.stdout);
    let voices = parse_voices(&text);
    if voices.is_empty() {
        return SpeechStatus {
            available: false,
            reason: Some(
                "speech-dispatcher reported no voices. Install a synthesiser such as espeak-ng: \
                 sudo apt install espeak-ng, then test it with: spd-say \"Hello\"."
                    .to_string(),
            ),
            voices,
        };
    }

    if let Ok(mut cache) = cache.lock() {
        *cache = Some(voices.clone());
    }
    SpeechStatus {
        available: true,
        reason: None,
        voices,
    }
}

#[cfg(not(target_os = "linux"))]
fn status_blocking(_cache: &Arc<Mutex<Option<Vec<SpeechVoice>>>>) -> SpeechStatus {
    SpeechStatus {
        available: false,
        reason: Some("Read Aloud uses the webview's own speech synthesis here.".to_string()),
        voices: Vec::new(),
    }
}

#[cfg(target_os = "linux")]
fn stop_blocking(current: &Arc<Mutex<Option<Child>>>) {
    if let Ok(mut slot) = current.lock()
        && let Some(mut child) = slot.take()
    {
        let _ = child.kill();
        let _ = child.wait();
    }
    // The waiting child may already have handed the text to the daemon; this
    // clears what the daemon still has queued for this connection. Errors are
    // ignored: stopping should never fail because the service is gone.
    let _ = std::process::Command::new("spd-say")
        .args(["-C", "-N", "MDraft", "-n", "mdraft"])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
}

#[cfg(not(target_os = "linux"))]
fn stop_blocking(_current: &Arc<Mutex<Option<Child>>>) {}

#[cfg(target_os = "linux")]
fn speak_blocking(
    current: &Arc<Mutex<Option<Child>>>,
    text: String,
    lang: String,
    voice: String,
    rate: f64,
) -> Result<(), String> {
    let arguments = speak_arguments(&text, &lang, &voice, rate);
    let child = std::process::Command::new("spd-say")
        .args(&arguments)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                "Read Aloud needs speech-dispatcher: sudo apt install speech-dispatcher espeak-ng."
                    .to_string()
            } else {
                "speech-dispatcher could not start.".to_string()
            }
        })?;

    {
        let mut slot = current
            .lock()
            .map_err(|_| "Read Aloud's speech state is unavailable.".to_string())?;
        if let Some(mut previous) = slot.take() {
            let _ = previous.kill();
            let _ = previous.wait();
        }
        *slot = Some(child);
    }

    loop {
        std::thread::sleep(std::time::Duration::from_millis(30));
        let mut slot = current
            .lock()
            .map_err(|_| "Read Aloud's speech state is unavailable.".to_string())?;
        let Some(active) = slot.as_mut() else {
            // Stop took the child out. The queue has already been stopped, so
            // this is a normal end rather than an error.
            return Ok(());
        };
        match active.try_wait() {
            Ok(Some(status)) => {
                slot.take();
                return if status.success() {
                    Ok(())
                } else {
                    Err("speech-dispatcher could not speak the text. Test it with: spd-say \"Hello\"."
                        .to_string())
                };
            }
            Ok(None) => {}
            Err(_) => {
                let _ = slot.take();
                return Err("speech-dispatcher stopped answering.".to_string());
            }
        }
    }
}

#[cfg(not(target_os = "linux"))]
fn speak_blocking(
    _current: &Arc<Mutex<Option<Child>>>,
    _text: String,
    _lang: String,
    _voice: String,
    _rate: f64,
) -> Result<(), String> {
    Err("The system speech service is only used on Linux.".to_string())
}

/// The voices speech-dispatcher can offer, plus why it cannot when it cannot.
#[tauri::command]
pub async fn speech_status(state: State<'_, SpeechState>) -> Result<SpeechStatus, String> {
    let cache = state.voices.clone();
    tauri::async_runtime::spawn_blocking(move || status_blocking(&cache))
        .await
        .map_err(|_| "The speech service check could not run.".to_string())
}

/// Speak one sentence and resolve when it has been spoken.
#[tauri::command]
pub async fn speech_speak(
    state: State<'_, SpeechState>,
    text: String,
    lang: String,
    voice: String,
    rate: f64,
) -> Result<(), String> {
    if text.trim().is_empty() {
        return Err("There is nothing to speak.".to_string());
    }
    if text.chars().count() > MAX_SPEECH_CHARS {
        return Err("That sentence is too long to speak.".to_string());
    }
    let current = state.current.clone();
    tauri::async_runtime::spawn_blocking(move || speak_blocking(&current, text, lang, voice, rate))
        .await
        .map_err(|_| "The speech request could not run.".to_string())?
}

/// Stop the current sentence and clear anything already queued.
#[tauri::command]
pub async fn speech_stop(state: State<'_, SpeechState>) -> Result<(), String> {
    let current = state.current.clone();
    tauri::async_runtime::spawn_blocking(move || stop_blocking(&current))
        .await
        .map_err(|_| "The speech request could not be stopped.".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "\
                     NAME                 LANGUAGE                  VARIANT
                Afrikaans                       af                     none
           Afrikaans+Adam                       af                     Adam
         English (America)                    en-US                     none
English (America, New York City)          en-US-NYC                     none
        Portuguese (Portugal)                    pt                     none
Portuguese (Portugal)+Maria                    pt                  Maria
";

    #[test]
    fn parses_only_the_default_voice_for_each_language() {
        let voices = parse_voices(SAMPLE);
        assert_eq!(voices.len(), 4);
        assert_eq!(voices[0].name, "Afrikaans");
        assert_eq!(voices[0].lang, "af");
        assert!(voices[0].is_default);
        assert_eq!(voices[1].name, "English (America)");
        assert_eq!(voices[1].lang, "en-US");
        assert!(voices[1].is_default);
        assert_eq!(voices[2].name, "English (America, New York City)");
        assert_eq!(voices[2].lang, "en-US-NYC");
        assert!(voices[2].is_default);
        assert_eq!(voices[3].name, "Portuguese (Portugal)");
        assert!(!voices.iter().any(|voice| voice.name.ends_with("+Adam")));
        assert!(!voices.iter().any(|voice| voice.name.ends_with("+Maria")));
        assert!(voices.iter().all(|voice| voice.local));
    }

    #[test]
    fn duplicate_names_are_kept_once() {
        let output = "English (America) en-US none\nEnglish (America) en-US none\n";
        assert_eq!(parse_voices(output).len(), 1);
    }

    #[test]
    fn the_header_and_short_lines_are_ignored() {
        assert!(parse_voices("").is_empty());
        assert!(parse_voices("NAME LANGUAGE VARIANT").is_empty());
        assert!(parse_voices("only one").is_empty());
    }

    #[test]
    fn rate_maps_onto_spd_say_scale() {
        assert_eq!(rate_to_spd(1.0), 0);
        assert_eq!(rate_to_spd(0.5), -50);
        assert_eq!(rate_to_spd(2.0), 100);
        assert_eq!(rate_to_spd(0.1), -50, "clamped below");
        assert_eq!(rate_to_spd(9.0), 100, "clamped above");
        assert_eq!(rate_to_spd(f64::NAN), 0);
    }

    #[test]
    fn language_tags_are_reduced_to_their_base_code() {
        assert_eq!(spd_language("pt-BR"), "pt");
        assert_eq!(spd_language("en_US"), "en");
        assert_eq!(spd_language("auto"), "");
        assert_eq!(spd_language("  "), "");
    }

    #[test]
    fn a_named_voice_wins_over_the_language() {
        let arguments = speak_arguments("Olá", "pt-BR", "Portuguese (Portugal)", 1.0);
        assert!(
            arguments
                .windows(2)
                .any(|pair| pair == ["-y", "Portuguese (Portugal)"])
        );
        assert!(!arguments.iter().any(|argument| argument == "-l"));
        assert_eq!(arguments.last().map(String::as_str), Some("Olá"));
        assert_eq!(arguments[arguments.len() - 2], "--");
    }

    #[test]
    fn without_a_voice_the_language_is_passed() {
        let arguments = speak_arguments("Hello", "en-US", "", 1.5);
        assert!(arguments.windows(2).any(|pair| pair == ["-l", "en"]));
        assert!(arguments.windows(2).any(|pair| pair == ["-r", "50"]));
        assert!(!arguments.iter().any(|argument| argument == "-y"));
    }

    /// The fixture above is a hand-written table. This one checks the real
    /// command's current format on a host that has speech-dispatcher; it is
    /// ignored because a CI runner need not have a voice installed.
    #[cfg(target_os = "linux")]
    #[test]
    #[ignore = "uses the host's speech-dispatcher and installed voices"]
    fn the_host_speech_service_reports_default_voices() {
        let cache = Arc::new(Mutex::new(None));
        let status = status_blocking(&cache);
        assert!(status.available, "{:?}", status.reason);
        assert!(
            status.voices.len() > 50,
            "expected the default voice per language, got {}",
            status.voices.len()
        );
        assert!(
            status
                .voices
                .iter()
                .any(|voice| voice.lang.starts_with("en"))
        );
        assert!(status.voices.iter().all(|voice| voice.local));
    }
}
