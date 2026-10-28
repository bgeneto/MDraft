//! The AI Assistant's Rust side: commands, credential state and ownership of
//! in-flight requests.
//!
//! The webview sends a validated request and receives a stream of typed events
//! over a Tauri `Channel`. The key is read here, the request is made here, and
//! only text crosses the IPC boundary. A request can be cancelled by id while
//! it streams, and the whole map is cleared when the window closes.

pub mod prompt;
pub mod provider;
pub mod secret;
pub mod stream;

use std::collections::HashMap;
use std::sync::Mutex;

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::State;
use tokio::sync::watch;

use crate::settings::AppState;
use prompt::{AiAction, AiRequest};
use provider::{ChatConfig, Provider};

/// Runtime state that must not be persisted.
#[derive(Default)]
pub struct AiState {
    /// Keys kept for this session because the OS store refused them.
    pub keys: Mutex<HashMap<String, String>>,
    /// Cancellation senders for in-flight requests, by request id.
    pub running: Mutex<HashMap<String, watch::Sender<bool>>>,
}

/// One event on the request channel. `kind` is the tag the panel switches on.
#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum AiEvent {
    Started {
        model: String,
        host: String,
        context_chars: usize,
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
    /// `"keychain"`, `"session"` or `"none"`.
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

fn status_for(endpoint: &str, source: secret::KeySource, warning: Option<String>) -> AiKeyStatus {
    AiKeyStatus {
        source: source.id().to_string(),
        has_key: source != secret::KeySource::None,
        endpoint: endpoint.to_string(),
        keychain_available: secret::keychain_available(),
        warning,
    }
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
            let (_, source) = secret::resolve(&state.ai.keys, &provider, &base);
            (source, base)
        }
        Err(_) => (secret::KeySource::None, base_url.trim().to_string()),
    };
    Ok(status_for(&endpoint, source, None))
}

/// Store a key in the OS credential store, falling back to this session.
///
/// The fallback is reported, not hidden: a Linux session without a Secret
/// Service must still be usable, and the reader must know the key will vanish
/// on restart.
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
    match secret::keychain_set(&provider, &base, key) {
        Ok(()) => {
            secret::session_remove(&state.ai.keys, &provider, &base);
            Ok(status_for(&base, secret::KeySource::Keychain, None))
        }
        Err(message) => {
            secret::session_set(&state.ai.keys, &provider, &base, key);
            Ok(status_for(
                &base,
                secret::KeySource::Session,
                Some(format!("{message} The key is kept for this session only.")),
            ))
        }
    }
}

#[tauri::command]
pub async fn ai_clear_key(
    state: State<'_, AppState>,
    provider: String,
    base_url: String,
) -> Result<AiKeyStatus, String> {
    let base = provider::normalize_base_url(&base_url)?;
    let warning = secret::keychain_delete(&provider, &base).err();
    secret::session_remove(&state.ai.keys, &provider, &base);
    // Report what actually remains: a failed delete must not claim the key is
    // gone while it can still be read.
    let (_, source) = secret::resolve(&state.ai.keys, &provider, &base);
    Ok(status_for(&base, source, warning))
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
    let (key, _) = secret::resolve(&state.ai.keys, provider_id.id(), &base);
    let config = ChatConfig {
        provider: provider_id,
        base_url: base.clone(),
        model,
        key,
        host: provider::host_of(&base),
    };
    let models = provider::list_models(&config)
        .await
        .map_err(|message| provider::redact(&message, config.key.as_deref()))?;
    Ok(AiModelsReply { models })
}

/// Stop one request. The streaming loop notices immediately even when the
/// provider has gone quiet.
#[tauri::command]
pub fn ai_cancel(state: State<'_, AppState>, id: String) {
    if let Ok(running) = state.ai.running.lock()
        && let Some(sender) = running.get(&id)
    {
        sender.send_replace(true);
    }
}

/// Cancel everything, used while the window is closing.
#[tauri::command]
pub fn ai_cancel_all(state: State<'_, AppState>) {
    if let Ok(running) = state.ai.running.lock() {
        for sender in running.values() {
            sender.send_replace(true);
        }
    }
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
    let prepared = prompt::prepare(&request)?;
    // No key is not a configuration error. Sending no auth header is the only
    // accurate request for an endpoint whose operator never configured one;
    // the 401 handler names the endpoint when it does require a key.
    let (key, _) = secret::resolve(&state.ai.keys, provider_kind.id(), &base);

    let host = provider::host_of(&base);
    let config = ChatConfig {
        provider: provider_kind,
        base_url: base,
        model,
        key,
        host: host.clone(),
    };

    let _ = on_event.send(AiEvent::Started {
        model: config.model.clone(),
        host,
        context_chars: prepared.context_chars,
        context_truncated: prepared.context_truncated,
    });

    let (sender, mut receiver) = watch::channel(false);
    if let Ok(mut running) = state.ai.running.lock()
        && let Some(previous) = running.insert(request.id.clone(), sender)
    {
        previous.send_replace(true);
    }

    let mut filter = match prepared.action.output_tag() {
        Some(tag) => stream::TagFilter::new(
            tag,
            if prepared.action == AiAction::Improve {
                Some("notes")
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

    if let Ok(mut running) = state.ai.running.lock() {
        running.remove(&request.id);
    }

    match result {
        Ok(outcome) => {
            let (text, notes) = filter.finish();
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
