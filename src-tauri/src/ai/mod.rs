//! The AI Assistant's Rust side: commands, credential state and ownership of
//! in-flight requests.
//!
//! The webview sends a validated request and receives a stream of typed events
//! over a Tauri `Channel`. The key is read here, the request is made here, and
//! only text crosses the IPC boundary. A request can be cancelled by id while
//! it streams, and the whole map is cleared when the window closes.

pub mod limits;
pub mod naming;
pub mod prompt;
pub mod prompts_file;
pub mod provider;
pub mod secret;
pub mod stream;

use std::collections::HashMap;
use std::sync::Mutex;

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::State;
use tokio::sync::watch;

use crate::cancel_registry::{CancelRegistry, Ticket};
use crate::settings::AppState;
use limits::AiLimits;
use prompt::{AiAction, AiRequest};
use provider::{ChatConfig, Provider};

/// Runtime state that must not be persisted.
#[derive(Default)]
pub struct AiState {
    /// Keys kept for this session because the OS store refused them.
    pub keys: Mutex<HashMap<String, String>>,
    /// Cancellation senders for in-flight requests, by request id, plus the
    /// cancels that reached Rust before their request registered.
    running: Mutex<CancelRegistry<watch::Sender<bool>>>,
}

impl AiState {
    /// Register a request's cancellation sender for as long as the guard lives.
    ///
    /// Called first in a command, before settings or the prompt file are read:
    /// that keeps the unregistered window small, and a Cancel that still
    /// arrives inside it is held by the registry and applied here.
    pub fn register(&self, id: &str, sender: watch::Sender<bool>) -> Registration<'_> {
        let ticket = self
            .running
            .lock()
            .ok()
            .map(|mut running| running.register(id, sender).0);
        Registration {
            state: self,
            id: id.to_string(),
            ticket,
        }
    }

    pub fn cancel(&self, id: &str) {
        if let Ok(mut running) = self.running.lock() {
            running.cancel(id);
        }
    }

    pub fn cancel_all(&self) {
        if let Ok(mut running) = self.running.lock() {
            running.cancel_all();
        }
    }
}

/// A registered request; dropping it forgets the request on every return path.
pub struct Registration<'a> {
    state: &'a AiState,
    id: String,
    ticket: Option<Ticket>,
}

impl Drop for Registration<'_> {
    fn drop(&mut self) {
        if let (Some(ticket), Ok(mut running)) = (self.ticket, self.state.running.lock()) {
            running.finish(&self.id, ticket);
        }
    }
}

/// One event on the request channel. `kind` is the tag the panel switches on.
#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum AiEvent {
    Started {
        model: String,
        host: String,
        context_tokens: usize,
        context_truncated: bool,
    },
    Delta {
        text: String,
    },
    Done {
        text: String,
        notes: String,
        truncated: bool,
        stopped: bool,
    },
    Error {
        message: String,
    },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiKeyStatus {
    /// `"keychain"`, `"file"`, `"session"` or `"none"`.
    pub source: String,
    pub has_key: bool,
    pub endpoint: String,
    pub keychain_available: bool,
    pub warning: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiModelsReply {
    pub models: Vec<String>,
}

/// What the reasoning test found.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiReasoningProbe {
    /// Whether the endpoint accepted a request that asked for no reasoning.
    pub accepted: bool,
    /// The sentence shown under the checkbox.
    pub message: String,
}

/// Where the reader's prompt overrides live: beside `settings.json`, so the
/// portable build's directory override covers it with no extra work.
pub(crate) fn prompts_path(state: &AppState) -> std::path::PathBuf {
    state.config_file.with_file_name(prompts_file::FILE_NAME)
}

/// What the Preferences panel says about the prompt file.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiPromptsStatus {
    pub path: String,
    pub exists: bool,
    /// Sections that differ from the built-in prompt.
    pub custom: usize,
    /// Sections the file can carry: the preamble, every action and the filename
    /// prompt.
    pub total: usize,
    /// Why the file could not be used, when it could not.
    pub error: Option<String>,
}

/// Whether the reader has edited any prompt, and where the file is.
///
/// Read-only on purpose: opening Preferences must not create a file.
#[tauri::command]
pub fn ai_prompts_status(state: State<'_, AppState>) -> AiPromptsStatus {
    let path = prompts_path(&state);
    let exists = path.is_file();
    let (custom, error) = if exists {
        match prompts_file::load(&path) {
            Ok(overrides) => (overrides.customised(), None),
            Err(message) => (0, Some(message)),
        }
    } else {
        (0, None)
    };
    AiPromptsStatus {
        path: path.to_string_lossy().to_string(),
        exists,
        custom,
        total: prompts_file::sections().len(),
        error,
    }
}

/// Write every built-in prompt to the file, replacing what is there.
///
/// Two callers: opening the file for the first time, and **Reset prompts to
/// defaults**. Reset is the recovery path for an edit that broke an action, so
/// it must work without reading the old content — this writes from the
/// constants and never parses what it replaces.
#[tauri::command]
pub fn ai_export_prompts(state: State<'_, AppState>) -> Result<String, String> {
    let path = prompts_path(&state);
    prompts_file::write_defaults(&path)?;
    Ok(path.to_string_lossy().to_string())
}

fn status_for(endpoint: &str, source: secret::KeySource, warning: Option<String>) -> AiKeyStatus {
    AiKeyStatus {
        source: source.id().to_string(),
        has_key: source != secret::KeySource::None,
        endpoint: endpoint.to_string(),
        keychain_available: secret::keychain_available(),
        warning,
    }
}

/// The fallback file beside `settings.json`.
fn keys_path(state: &AppState) -> std::path::PathBuf {
    secret::keys_file(&state.config_file)
}

/// The key for an endpoint, from the session, the keychain or the private
/// fallback file, in that order. Every request path uses this one function so
/// the precedence cannot drift between status, model listing and generation.
pub(crate) fn resolve_key(
    state: &AppState,
    provider: &str,
    base_url: &str,
) -> (Option<String>, secret::KeySource) {
    secret::resolve(&state.ai.keys, provider, base_url, &keys_path(state))
}

/// Where the key for this endpoint currently comes from.
///
/// Deliberately forgiving while the reader types: an invalid URL reports `none`
/// with the text as typed rather than throwing at the Preferences panel.
#[tauri::command]
pub async fn ai_status(
    state: State<'_, AppState>,
    provider: String,
    base_url: String,
) -> Result<AiKeyStatus, String> {
    let normalized = provider::normalize_base_url(&base_url);
    let (source, endpoint) = match normalized {
        Ok(base) => {
            let (_, source) = resolve_key(&state, &provider, &base);
            (source, base)
        }
        Err(_) => (secret::KeySource::None, base_url.trim().to_string()),
    };
    Ok(status_for(&endpoint, source, None))
}

/// Store a key in the OS credential store, falling back to a private file and
/// then to this session.
///
/// The fallback is reported, not hidden: a Linux session without a usable
/// Secret Service must survive a restart, and the reader must know where the key
/// went. The file is `0600`, separate from `settings.json`, and explicitly not
/// encrypted; the UI says so. A later successful keychain write removes it.
///
/// Split from the command so the refused-keychain branch is testable without a
/// real Secret Service.
fn store_key(
    keys: &Mutex<HashMap<String, String>>,
    keys_path: &std::path::Path,
    provider: &str,
    base: &str,
    key: &str,
    keychain: Result<(), String>,
) -> (secret::KeySource, Option<String>) {
    match keychain {
        Ok(()) => {
            secret::session_remove(keys, provider, base);
            let _ = secret::file_delete(keys_path, provider, base);
            (secret::KeySource::Keychain, None)
        }
        Err(message) => match secret::file_set(keys_path, provider, base, key) {
            Ok(()) => {
                secret::session_remove(keys, provider, base);
                (
                    secret::KeySource::File,
                    Some(format!(
                        "{message} The key is saved in a private file and will survive a restart; \
                         the system keychain is still preferred. The file is readable only by \
                         your user account, but it is not encrypted."
                    )),
                )
            }
            Err(file_error) => {
                secret::session_set(keys, provider, base, key);
                (
                    secret::KeySource::Session,
                    Some(format!(
                        "{message} {file_error} The key is kept for this session only."
                    )),
                )
            }
        },
    }
}

#[tauri::command]
pub async fn ai_set_key(
    state: State<'_, AppState>,
    provider: String,
    base_url: String,
    key: String,
) -> Result<AiKeyStatus, String> {
    let base = provider::normalize_base_url(&base_url)?;
    let key = key.trim();
    if key.is_empty() {
        return Err("Type the API key first.".to_string());
    }
    let path = keys_path(&state);
    let keychain = secret::keychain_set(&provider, &base, key);
    let (source, warning) = store_key(&state.ai.keys, &path, &provider, &base, key, keychain);
    Ok(status_for(&base, source, warning))
}

#[tauri::command]
pub async fn ai_clear_key(
    state: State<'_, AppState>,
    provider: String,
    base_url: String,
) -> Result<AiKeyStatus, String> {
    let base = provider::normalize_base_url(&base_url)?;
    let path = keys_path(&state);
    let mut warnings = Vec::new();
    if let Err(message) = secret::keychain_delete(&provider, &base) {
        warnings.push(message);
    }
    if let Err(message) = secret::file_delete(&path, &provider, &base) {
        warnings.push(message);
    }
    secret::session_remove(&state.ai.keys, &provider, &base);
    // Report what actually remains: a failed delete must not claim the key is
    // gone while it can still be read.
    let (_, source) = resolve_key(&state, &provider, &base);
    Ok(status_for(
        &base,
        source,
        if warnings.is_empty() {
            None
        } else {
            Some(warnings.join(" "))
        },
    ))
}

/// Fetch the endpoint's model list. Nothing is requested until the reader
/// presses Fetch.
#[tauri::command]
pub async fn ai_fetch_models(
    state: State<'_, AppState>,
    provider: String,
    base_url: String,
    model: String,
) -> Result<AiModelsReply, String> {
    let provider_id = provider::Provider::from_id(&provider)
        .ok_or_else(|| "Choose a provider in AI Settings.".to_string())?;
    let base = provider::normalize_base_url(&base_url)?;
    // The key is optional for every provider and host: a local engine usually
    // needs none, and a hosted endpoint answers 401 when it wants one. Let the
    // request be the authority instead of refusing before the reader's server
    // has had a chance to answer.
    let (key, _) = resolve_key(&state, provider_id.id(), &base);
    let config = ChatConfig {
        provider: provider_id,
        base_url: base.clone(),
        model,
        key,
        host: provider::host_of(&base),
        // `/models` has no request body, so the reasoning preference cannot
        // apply to it; the field is here only because the config is shared.
        disable_reasoning: false,
    };
    let models = provider::list_models(&config)
        .await
        .map_err(|message| provider::redact(&message, config.key.as_deref()))?;
    Ok(AiModelsReply { models })
}

/// Try one short request with reasoning off.
///
/// The preference is off by default and a model can refuse the field, so the
/// reader needs the answer before Generate meets one. Deliberately independent
/// of `ai_enabled` and of the saved checkbox: Preferences may be open while the
/// assistant is still being configured, and the question is what the *model*
/// accepts. A refusal is an answer, not an error; transport and auth failures
/// still are.
#[tauri::command]
pub async fn ai_test_reasoning(
    state: State<'_, AppState>,
    provider: String,
    base_url: String,
    model: String,
) -> Result<AiReasoningProbe, String> {
    let provider_kind = Provider::from_id(&provider)
        .ok_or_else(|| "Choose a provider in AI Settings.".to_string())?;
    let base = provider::normalize_base_url(&base_url)?;
    let model = model.trim().to_string();
    if model.is_empty() {
        return Err("Set a model in AI Settings first.".to_string());
    }
    let (key, _) = resolve_key(&state, provider_kind.id(), &base);
    let config = ChatConfig {
        provider: provider_kind,
        base_url: base.clone(),
        model,
        key,
        host: provider::host_of(&base),
        // Whatever the checkbox currently says, the test asks the endpoint
        // whether it accepts the field at all.
        disable_reasoning: true,
    };
    let probe = provider::probe_reasoning(&config)
        .await
        .map_err(|message| provider::redact(&message, config.key.as_deref()))?;
    Ok(AiReasoningProbe {
        accepted: probe.accepted,
        // The refusal quotes provider text, which may echo a request; the same
        // redaction as an error path.
        message: provider::redact(&probe.message, config.key.as_deref()),
    })
}

/// Stop one request. The streaming loop notices immediately even when the
/// provider has gone quiet.
#[tauri::command]
pub fn ai_cancel(state: State<'_, AppState>, id: String) {
    // An id that has not registered yet is remembered, not ignored: the
    // command that starts it may still be on its way.
    state.ai.cancel(&id);
}

/// Cancel everything, used while the window is closing.
#[tauri::command]
pub fn ai_cancel_all(state: State<'_, AppState>) {
    state.ai.cancel_all();
}

/// Run one action and stream its answer over `on_event`.
///
/// Errors are reported as an [`AiEvent::Error`] because the panel owns the
/// display; the command itself resolves so there is one channel of truth.
#[tauri::command]
pub async fn ai_complete(
    state: State<'_, AppState>,
    request: AiRequest,
    on_event: Channel<AiEvent>,
) -> Result<(), String> {
    let (sender, mut receiver) = watch::channel(false);
    let registration = state.ai.register(&request.id, sender);
    let settings = state
        .settings
        .lock()
        .map_err(|_| "Settings are unavailable.".to_string())?
        .clone();
    if !settings.ai_enabled {
        return Err("Enable the AI Assistant in Preferences first.".to_string());
    }
    let provider_kind = Provider::from_id(&settings.ai_provider)
        .ok_or_else(|| "Choose a provider in AI Settings.".to_string())?;
    let base = provider::normalize_base_url(&settings.ai_base_url)?;
    let model = settings.ai_model.trim().to_string();
    if model.is_empty() {
        return Err("Set a model in AI Settings first.".to_string());
    }
    let prepared = prompt::prepare(
        &request,
        AiLimits::from_context_tokens(settings.ai_context_tokens),
        &prompts_file::load(&prompts_path(&state))?,
    )?;
    // No key is not a configuration error. Sending no auth header is the only
    // accurate request for an endpoint whose operator never configured one;
    // the 401 handler names the endpoint when it does require a key.
    let (key, _) = resolve_key(&state, provider_kind.id(), &base);

    let host = provider::host_of(&base);
    let config = ChatConfig {
        provider: provider_kind,
        base_url: base,
        model,
        key,
        host: host.clone(),
        disable_reasoning: settings.ai_disable_reasoning,
    };

    let _ = on_event.send(AiEvent::Started {
        model: config.model.clone(),
        host,
        context_tokens: prepared.context_tokens,
        context_truncated: prepared.context_truncated,
    });

    let mut filter = match prepared.action.output_tag() {
        Some(tag) => stream::TagFilter::new(
            tag,
            if prepared.action == AiAction::Improve {
                Some(prompt::NOTES_TAG)
            } else {
                None
            },
        ),
        None => stream::TagFilter::passthrough(),
    };

    let result = provider::stream(
        &config,
        &prepared.system,
        &prepared.messages,
        &mut receiver,
        |delta| {
            let visible = filter.feed(delta);
            if !visible.is_empty() {
                let _ = on_event.send(AiEvent::Delta { text: visible });
            }
        },
    )
    .await;

    drop(registration);

    match result {
        Ok(outcome) => {
            let tagged = filter.used_tag();
            let (text, notes) = filter.finish();
            // `done` is authoritative: the panel replaces whatever it streamed
            // with this text, and this text is what Apply writes. It is the one
            // place that can remove commentary a model added despite the prompt.
            let source = if prepared.action == AiAction::Continue {
                format!("{}{}", request.preceding, request.selection)
            } else {
                request.selection.clone()
            };
            let text = prompt::clean_answer(prepared.action, &text, &source, tagged);
            if text.trim().is_empty() && !outcome.stopped {
                let _ = on_event.send(AiEvent::Error {
                    message: "The model returned an empty answer. Try again.".to_string(),
                });
            } else {
                let _ = on_event.send(AiEvent::Done {
                    text,
                    notes,
                    truncated: filter.truncated(),
                    stopped: outcome.stopped,
                });
            }
        }
        Err(message) => {
            let _ = on_event.send(AiEvent::Error {
                message: provider::redact(&message, config.key.as_deref()),
            });
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static NEXT: AtomicUsize = AtomicUsize::new(0);

    struct TempDir(std::path::PathBuf);

    impl TempDir {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "mdraft-key-store-{}-{}-{name}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }

        fn keys(&self) -> std::path::PathBuf {
            self.0.join(secret::KEYS_FILE)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn a_refused_keychain_falls_back_to_the_private_file() {
        let dir = TempDir::new("refused");
        let path = dir.keys();
        let keys = Mutex::new(HashMap::new());
        let (source, warning) = store_key(
            &keys,
            &path,
            "openai",
            "http://a/v1",
            "key-a",
            Err("The system credential store refused the key.".to_string()),
        );
        assert_eq!(source, secret::KeySource::File);
        assert!(
            warning
                .as_deref()
                .is_some_and(|text| text.contains("private file"))
        );
        assert_eq!(
            secret::file_get(&path, "openai", "http://a/v1"),
            Some("key-a".to_string())
        );
        assert_eq!(secret::session_get(&keys, "openai", "http://a/v1"), None);
    }

    #[test]
    fn a_successful_keychain_write_removes_the_older_file_entry() {
        let dir = TempDir::new("migrate");
        let path = dir.keys();
        secret::file_set(&path, "openai", "http://a/v1", "old-key").unwrap();
        let keys = Mutex::new(HashMap::new());
        let (source, warning) = store_key(&keys, &path, "openai", "http://a/v1", "new-key", Ok(()));
        assert_eq!(source, secret::KeySource::Keychain);
        assert!(warning.is_none());
        assert_eq!(secret::file_get(&path, "openai", "http://a/v1"), None);
    }

    #[test]
    fn an_unwritable_file_keeps_the_key_for_the_session() {
        let dir = TempDir::new("unwritable");
        let blocker = dir.0.join("not-a-directory");
        fs::write(&blocker, b"x").unwrap();
        let path = blocker.join(secret::KEYS_FILE);
        let keys = Mutex::new(HashMap::new());
        let (source, warning) = store_key(
            &keys,
            &path,
            "openai",
            "http://a/v1",
            "key-a",
            Err("The system credential store refused the key.".to_string()),
        );
        assert_eq!(source, secret::KeySource::Session);
        assert!(
            warning
                .as_deref()
                .is_some_and(|text| text.contains("session only"))
        );
        assert_eq!(
            secret::session_get(&keys, "openai", "http://a/v1"),
            Some("key-a".to_string())
        );
    }
}
