//! HTTP transport for the two provider shapes: OpenAI-compatible
//! `chat/completions` and Anthropic's Messages API.
//!
//! Everything here is plain `reqwest` on Tauri's tokio runtime. The webview
//! never opens a socket and never sees the key: the command reads the key from
//! the credential store, this module attaches the right header and parses the
//! stream, and only text crosses the IPC boundary.

use std::net::IpAddr;
use std::time::Duration;

use serde_json::{Value, json};
use tokio::sync::watch;

use crate::ai::prompt::PromptMessage;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const IDLE_TIMEOUT: Duration = Duration::from_secs(90);
const MODELS_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Provider {
    OpenAi,
    Anthropic,
}

impl Provider {
    pub fn from_id(id: &str) -> Option<Self> {
        match id {
            "openai" => Some(Self::OpenAi),
            "anthropic" => Some(Self::Anthropic),
            _ => None,
        }
    }

    pub fn id(self) -> &'static str {
        match self {
            Self::OpenAi => "openai",
            Self::Anthropic => "anthropic",
        }
    }

    /// Anthropic has no unauthenticated mode; an OpenAI-compatible local server
    /// usually has one, so a missing key is sent as no header.
    pub fn requires_key(self) -> bool {
        matches!(self, Self::Anthropic)
    }
}

pub struct ChatConfig {
    pub provider: Provider,
    pub base_url: String,
    pub model: String,
    pub key: Option<String>,
    pub host: String,
}

pub struct Outcome {
    pub stopped: bool,
}

/// Trim, validate and canonicalise a Base URL.
///
/// The field accepts the full endpoint a reader may have copied
/// (`.../v1/chat/completions`), a trailing slash, or the bare gateway. Query
/// strings and credentials are refused: a key belongs in the credential store,
/// and a query would end up in every request line.
pub fn normalize_base_url(input: &str) -> Result<String, String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err("Set a Base URL in AI Settings first.".to_string());
    }
    let url = reqwest::Url::parse(trimmed)
        .map_err(|_| "The Base URL is not a valid http(s) address.".to_string())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("The Base URL must start with http:// or https://.".to_string());
    }
    if url.host_str().is_none() {
        return Err("The Base URL has no host.".to_string());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("Remove the user name and password from the Base URL; put the key in the API key field.".to_string());
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err("The Base URL must not contain a query or a fragment.".to_string());
    }

    let mut base = trimmed.trim_end_matches('/').to_string();
    for suffix in ["/chat/completions", "/models", "/messages"] {
        if let Some(stripped) = base.strip_suffix(suffix) {
            base = stripped.to_string();
            break;
        }
    }
    if base.is_empty() {
        return Err("The Base URL is not a valid http(s) address.".to_string());
    }
    Ok(base)
}

pub fn host_of(base_url: &str) -> String {
    reqwest::Url::parse(base_url)
        .ok()
        .and_then(|url| url.host_str().map(str::to_owned))
        .unwrap_or_else(|| base_url.to_string())
}

pub fn chat_url(base_url: &str, provider: Provider) -> String {
    match provider {
        Provider::OpenAi => format!("{base_url}/chat/completions"),
        Provider::Anthropic => {
            if base_url.ends_with("/v1") {
                format!("{base_url}/messages")
            } else {
                format!("{base_url}/v1/messages")
            }
        }
    }
}

pub fn models_url(base_url: &str, provider: Provider) -> String {
    match provider {
        Provider::OpenAi => format!("{base_url}/models"),
        Provider::Anthropic => {
            if base_url.ends_with("/v1") {
                format!("{base_url}/models")
            } else {
                format!("{base_url}/v1/models")
            }
        }
    }
}

/// Build the JSON body for one completion. Anthropic's `max_tokens` is
/// required; OpenAI-compatible servers disagree about output-limit fields, so
/// the client omits them and caps the displayed answer itself.
pub fn request_body(config: &ChatConfig, system: &str, messages: &[PromptMessage]) -> Value {
    let merged = merge_roles(messages);
    match config.provider {
        Provider::OpenAi => {
            let mut all = Vec::with_capacity(merged.len() + 1);
            all.push(json!({ "role": "system", "content": system }));
            all.extend(merged.iter().map(|message| {
                json!({ "role": message.role, "content": message.content })
            }));
            json!({
                "model": config.model,
                "messages": all,
                "stream": true,
            })
        }
        Provider::Anthropic => {
            let all: Vec<Value> = merged
                .iter()
                .map(|message| {
                    json!({ "role": message.role, "content": message.content })
                })
                .collect();
            json!({
                "model": config.model,
                "system": system,
                "messages": all,
                "max_tokens": 4096,
                "stream": true,
            })
        }
    }
}

/// Anthropic rejects two consecutive messages with the same role. Coalescing is
/// harmless for OpenAI and keeps one message pipeline for both providers.
fn merge_roles(messages: &[PromptMessage]) -> Vec<PromptMessage> {
    let mut merged: Vec<PromptMessage> = Vec::new();
    for message in messages {
        if let Some(last) = merged.last_mut()
            && last.role == message.role
        {
            last.content.push_str("\n\n");
            last.content.push_str(&message.content);
            continue;
        }
        merged.push(message.clone());
    }
    merged
}

fn auth(
    request: reqwest::RequestBuilder,
    config: &ChatConfig,
) -> reqwest::RequestBuilder {
    match config.provider {
        Provider::OpenAi => match &config.key {
            Some(key) => request.bearer_auth(key),
            None => request,
        },
        Provider::Anthropic => {
            let request = request.header("anthropic-version", "2023-06-01");
            match &config.key {
                Some(key) => request.header("x-api-key", key),
                None => request,
            }
        }
    }
}

fn build_client(base_url: &str) -> Result<reqwest::Client, String> {
    install_crypto_provider();
    let host = host_of(base_url);
    let mut builder = reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        // A redirect could forward the key to another host. The configured
        // endpoint is the only endpoint.
        .redirect(reqwest::redirect::Policy::none())
        .user_agent(concat!("MDraft/", env!("CARGO_PKG_VERSION")));
    if is_private_host(&host) {
        // A local model or the LAN validation server must not be sent through
        // a corporate proxy that cannot reach it.
        builder = builder.no_proxy();
    }
    builder
        .build()
        .map_err(|error| format!("Could not prepare the request: {error}"))
}

/// Install the ring provider once.
///
/// `reqwest` is built with `rustls-no-provider` so that it cannot pull in
/// aws-lc-rs beside `ureq`'s ring (Cargo features are additive, and rustls
/// refuses to choose between two providers). The cost is that nothing installs
/// a default provider for us: building a Client without this panics with
/// "No rustls crypto provider is configured".
fn install_crypto_provider() {
    use std::sync::Once;
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
}

/// Loopback and RFC 1918 / link-local addresses, plus `.localhost` names.
pub fn is_private_host(host: &str) -> bool {
    let host = host.trim_matches(['[', ']']);
    if host.eq_ignore_ascii_case("localhost") || host.to_ascii_lowercase().ends_with(".localhost") {
        return true;
    }
    match host.parse::<IpAddr>() {
        Ok(IpAddr::V4(address)) => {
            address.is_loopback() || address.is_private() || address.is_link_local()
        }
        Ok(IpAddr::V6(address)) => {
            address.is_loopback() || address.is_unique_local() || address.is_unicast_link_local()
        }
        Err(_) => false,
    }
}

/// Stream one completion, calling `on_text` for each text delta.
pub async fn stream(
    config: &ChatConfig,
    system: &str,
    messages: &[PromptMessage],
    cancel: &mut watch::Receiver<bool>,
    mut on_text: impl FnMut(&str),
) -> Result<Outcome, String> {
    let client = build_client(&config.base_url)?;
    let url = chat_url(&config.base_url, config.provider);
    let request = client
        .post(&url)
        .header("accept", "text/event-stream")
        .header("cache-control", "no-cache")
        .json(&request_body(config, system, messages));
    let request = auth(request, config);

    let response = request
        .send()
        .await
        .map_err(|error| transport_error(&error, &config.host))?;
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(http_error(
            status.as_u16(),
            &body,
            &config.host,
            &config.base_url,
        ));
    }

    let mut response = response;
    let mut buffer = String::new();
    let mut finished = false;
    let mut stopped = false;

    while !finished {
        tokio::select! {
            changed = cancel.changed() => {
                if changed.is_err() || *cancel.borrow() {
                    stopped = true;
                }
                break;
            }
            result = tokio::time::timeout(IDLE_TIMEOUT, response.chunk()) => {
                match result {
                    Err(_) => {
                        return Err(format!(
                            "The provider stopped sending data for {} seconds. Check the endpoint and try again.",
                            IDLE_TIMEOUT.as_secs()
                        ));
                    }
                    Ok(Err(error)) => return Err(transport_error(&error, &config.host)),
                    Ok(Ok(None)) => break,
                    Ok(Ok(Some(bytes))) => {
                        buffer.push_str(&String::from_utf8_lossy(&bytes));
                        let mut event_finished = false;
                        drain_sse(&mut buffer, |data| {
                            let done = match config.provider {
                                Provider::OpenAi => parse_openai(data, &mut on_text)?,
                                Provider::Anthropic => parse_anthropic(data, &mut on_text)?,
                            };
                            if done {
                                event_finished = true;
                            }
                            Ok(())
                        })?;
                        finished = event_finished;
                    }
                }
            }
        }
    }

    Ok(Outcome { stopped })
}

/// Parse one complete SSE block from `buffer`, keeping the incomplete tail.
fn drain_sse(
    buffer: &mut String,
    mut on_data: impl FnMut(&str) -> Result<(), String>,
) -> Result<(), String> {
    let mut consumed = 0;
    let mut data = String::new();
    while let Some(relative) = buffer[consumed..].find('\n') {
        let end = consumed + relative;
        let line = buffer[consumed..end].trim_end_matches('\r');
        consumed = end + 1;
        if line.is_empty() {
            if !data.is_empty() {
                on_data(&data)?;
                data.clear();
            }
            continue;
        }
        if let Some(value) = line.strip_prefix("data:") {
            if !data.is_empty() {
                data.push('\n');
            }
            data.push_str(value.strip_prefix(' ').unwrap_or(value));
        }
        // `event:`, `id:`, `retry:` and `:` comments carry no text.
    }
    buffer.drain(..consumed);
    Ok(())
}

fn parse_openai(data: &str, on_text: &mut impl FnMut(&str)) -> Result<bool, String> {
    if data.trim() == "[DONE]" {
        return Ok(true);
    }
    let Ok(value) = serde_json::from_str::<Value>(data) else {
        // A keepalive or an unknown event is not an answer and not an error.
        return Ok(false);
    };
    if let Some(error) = value.get("error") {
        return Err(provider_error_message(error));
    }
    if let Some(text) = value
        .pointer("/choices/0/delta/content")
        .and_then(Value::as_str)
    {
        on_text(text);
        return Ok(false);
    }
    if let Some(text) = value
        .pointer("/choices/0/message/content")
        .and_then(Value::as_str)
    {
        // A server that ignored `stream: true`.
        on_text(text);
        return Ok(true);
    }
    if let Some(text) = value.pointer("/choices/0/text").and_then(Value::as_str) {
        on_text(text);
        return Ok(false);
    }
    Ok(false)
}

fn parse_anthropic(data: &str, on_text: &mut impl FnMut(&str)) -> Result<bool, String> {
    let Ok(value) = serde_json::from_str::<Value>(data) else {
        return Ok(false);
    };
    match value.get("type").and_then(Value::as_str) {
        Some("content_block_delta") => {
            if let Some(text) = value.pointer("/delta/text").and_then(Value::as_str) {
                on_text(text);
            }
            Ok(false)
        }
        Some("message_stop") => Ok(true),
        Some("error") => Err(provider_error_message(&value)),
        _ => Ok(false),
    }
}

fn provider_error_message(value: &Value) -> String {
    let message = value
        .pointer("/error/message")
        .or_else(|| value.get("message"))
        .and_then(Value::as_str)
        .map(sanitize)
        .unwrap_or_else(|| "The provider reported an error.".to_string());
    format!("The provider reported an error: {message}")
}

/// Explain a `/models` body that is not a model list.
///
/// The first live report only said "not JSON"; an empty 200 from a wrong Base
/// URL and an HTML page from a gateway login both looked identical. Naming the
/// status, content type, byte count and a short body slice turns that into one
/// actionable message.
fn model_list_error(
    status: u16,
    content_type: &str,
    bytes: &[u8],
    base_url: &str,
    error: &serde_json::Error,
) -> String {
    let content_type = content_type.trim();
    if bytes.is_empty() {
        return format!(
            "The endpoint returned an empty response for the model list (HTTP {status}). Check the Base URL ({base_url}); it usually ends with /v1."
        );
    }
    let snippet = sanitize(&String::from_utf8_lossy(bytes));
    if content_type.to_ascii_lowercase().contains("html")
        || snippet.trim_start().starts_with('<')
    {
        return format!(
            "The endpoint returned an HTML page instead of a model list (HTTP {status}). Check the Base URL ({base_url}); it usually ends with /v1."
        );
    }
    let type_note = if content_type.is_empty() {
        "no content type"
    } else {
        content_type
    };
    let detail: String = snippet.chars().take(160).collect();
    format!(
        "The endpoint did not return a model list as JSON (HTTP {status}, {type_note}, {} bytes): {detail}. Check the Base URL ({base_url}). {error}",
        bytes.len()
    )
}

fn http_error(status: u16, body: &str, host: &str, base_url: &str) -> String {    match status {
        401 | 403 => format!(
            "The API key was rejected by {host}. Open AI Settings and check the key for this endpoint."
        ),
        404 => format!(
            "The endpoint answered 404 Not Found. Check the Base URL ({base_url}); it usually ends with /v1."
        ),
        429 => "The provider is rate limiting requests. Wait a moment and try again.".to_string(),
        _ => {
            let detail = serde_json::from_str::<Value>(body)
                .ok()
                .and_then(|value| {
                    value
                        .pointer("/error/message")
                        .or_else(|| value.get("message"))
                        .and_then(Value::as_str)
                        .map(sanitize)
                })
                .filter(|detail| !detail.is_empty());
            match detail {
                Some(detail) => {
                    format!("The provider answered HTTP {status}: {detail}")
                }
                None => format!("The provider answered HTTP {status}."),
            }
        }
    }
}

fn transport_error(error: &reqwest::Error, host: &str) -> String {
    if error.is_timeout() {
        format!("The provider at {host} did not answer in time.")
    } else if error.is_connect() {
        format!(
            "Could not reach {host}. Check the Base URL, the network, and that the server is running."
        )
    } else if error.is_decode() {
        "The provider sent a response MDraft could not read.".to_string()
    } else {
        format!("The request to {host} failed: {}", sanitize(&error.to_string()))
    }
}

/// Remove a live API key from provider text before it reaches the UI.
///
/// A provider's error body is not under our control; some servers echo request
/// headers. The key must never appear in a toast, the panel or a log.
pub fn redact(text: &str, key: Option<&str>) -> String {
    match key {
        Some(key) if !key.is_empty() => text.replace(key, "[redacted]"),
        _ => text.to_string(),
    }
}

/// Collapse whitespace and cut a provider message to something a toast can show.
fn sanitize(text: &str) -> String {
    let collapsed = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut result: String = collapsed.chars().take(240).collect();
    if collapsed.chars().count() > 240 {
        result.push('…');
    }
    result
}

/// Fetch the model list from the configured endpoint.
pub async fn list_models(config: &ChatConfig) -> Result<Vec<String>, String> {
    let client = build_client(&config.base_url)?;
    let url = models_url(&config.base_url, config.provider);
    let request = client
        .get(&url)
        .timeout(MODELS_TIMEOUT)
        .header("accept", "application/json");
    let request = auth(request, config);
    let response = request
        .send()
        .await
        .map_err(|error| transport_error(&error, &config.host))?;
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(http_error(
            status.as_u16(),
            &body,
            &config.host,
            &config.base_url,
        ));
    }
    let value: Value = {
        // Read the bytes once so a bad body can be described (empty, HTML,
        // compressed by a proxy that ignored our features) instead of the
        // useless "not JSON" that made the first live report hard to diagnose.
        let content_type = response
            .headers()
            .get("content-type")
            .and_then(|value| value.to_str().ok())
            .unwrap_or("")
            .to_string();
        let bytes = response
            .bytes()
            .await
            .map_err(|error| transport_error(&error, &config.host))?;
        serde_json::from_slice(&bytes).map_err(|error| {
            model_list_error(
                status.as_u16(),
                &content_type,
                &bytes,
                &config.base_url,
                &error,
            )
        })?
    };
    let items = value
        .get("data")
        .and_then(Value::as_array)
        .or_else(|| value.get("models").and_then(Value::as_array))
        .or_else(|| value.as_array());
    let mut models: Vec<String> = items
        .into_iter()
        .flatten()
        .filter_map(|item| {
            item.get("id")
                .or_else(|| item.get("name"))
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .filter(|id| !id.is_empty())
        .collect();
    models.sort();
    models.dedup();
    models.truncate(200);
    Ok(models)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message(role: &str, content: &str) -> PromptMessage {
        PromptMessage {
            role: role.into(),
            content: content.into(),
        }
    }

    #[test]
    fn base_url_is_normalised() {
        assert_eq!(
            normalize_base_url(" http://192.168.61.9:4000/v1/ ").unwrap(),
            "http://192.168.61.9:4000/v1"
        );
        assert_eq!(
            normalize_base_url("https://api.openai.com/v1/chat/completions").unwrap(),
            "https://api.openai.com/v1"
        );
        assert_eq!(
            normalize_base_url("https://api.anthropic.com/v1/messages").unwrap(),
            "https://api.anthropic.com/v1"
        );
    }

    #[test]
    fn base_url_rejects_what_cannot_be_used() {
        assert!(normalize_base_url("").is_err());
        assert!(normalize_base_url("ftp://example.com").is_err());
        assert!(normalize_base_url("https://example.com/v1?key=secret").is_err());
        assert!(normalize_base_url("https://user:pass@example.com/v1").is_err());
    }

    #[test]
    fn urls_join_per_provider() {
        assert_eq!(
            chat_url("https://api.openai.com/v1", Provider::OpenAi),
            "https://api.openai.com/v1/chat/completions"
        );
        assert_eq!(
            chat_url("https://api.anthropic.com", Provider::Anthropic),
            "https://api.anthropic.com/v1/messages"
        );
        assert_eq!(
            chat_url("https://api.anthropic.com/v1", Provider::Anthropic),
            "https://api.anthropic.com/v1/messages"
        );
        assert_eq!(
            models_url("http://127.0.0.1:11434/v1", Provider::OpenAi),
            "http://127.0.0.1:11434/v1/models"
        );
    }

    #[test]
    fn private_hosts_bypass_proxies() {
        assert!(is_private_host("127.0.0.1"));
        assert!(is_private_host("localhost"));
        assert!(is_private_host("192.168.61.9"));
        assert!(is_private_host("10.0.0.5"));
        assert!(is_private_host("172.16.4.2"));
        assert!(is_private_host("::1"));
        assert!(!is_private_host("api.openai.com"));
        assert!(!is_private_host("8.8.8.8"));
    }

    #[test]
    fn openai_body_has_one_system_message_and_streams() {
        let config = ChatConfig {
            provider: Provider::OpenAi,
            base_url: "https://api.openai.com/v1".into(),
            model: "gpt-test".into(),
            key: None,
            host: "api.openai.com".into(),
        };
        let body = request_body(
            &config,
            "system text",
            &[message("user", "hello"), message("assistant", "hi"), message("user", "again")],
        );
        assert_eq!(body["model"], "gpt-test");
        assert_eq!(body["stream"], true);
        assert_eq!(body["messages"][0]["role"], "system");
        assert_eq!(body["messages"][0]["content"], "system text");
        assert_eq!(body["messages"].as_array().unwrap().len(), 4);
    }

    #[test]
    fn anthropic_body_uses_its_own_fields() {
        let config = ChatConfig {
            provider: Provider::Anthropic,
            base_url: "https://api.anthropic.com".into(),
            model: "claude-test".into(),
            key: None,
            host: "api.anthropic.com".into(),
        };
        let body = request_body(&config, "system text", &[message("user", "hello")]);
        assert_eq!(body["system"], "system text");
        assert_eq!(body["max_tokens"], 4096);
        assert_eq!(body["stream"], true);
        assert!(body.get("messages").is_some());
    }

    #[test]
    fn consecutive_roles_are_merged() {
        let merged = merge_roles(&[message("user", "a"), message("user", "b")]);
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].content, "a\n\nb");
    }

    #[test]
    fn sse_blocks_survive_a_split_between_chunks() {
        let mut buffer = String::from("data: {\"choices\":[{\"delta\":{\"content\":\"Hel");
        let mut events = Vec::new();
        drain_sse(&mut buffer, |data| {
            events.push(data.to_string());
            Ok(())
        })
        .unwrap();
        assert!(events.is_empty());
        buffer.push_str("lo\"}}]}\n\n");
        drain_sse(&mut buffer, |data| {
            events.push(data.to_string());
            Ok(())
        })
        .unwrap();
        assert_eq!(events.len(), 1);
        assert!(events[0].contains("Hello"));
    }

    #[test]
    fn sse_handles_crlf_and_multiline_data() {
        let mut buffer = String::from("data: one\r\ndata: two\r\n\r\n");
        let mut events = Vec::new();
        drain_sse(&mut buffer, |data| {
            events.push(data.to_string());
            Ok(())
        })
        .unwrap();
        assert_eq!(events, vec!["one\ntwo"]);
    }

    #[test]
    fn openai_delta_done_and_error() {
        let mut events: Vec<String> = Vec::new();
        {
            let mut emit = |value: &str| events.push(value.to_string());
            assert!(
                !parse_openai(r#"{"choices":[{"delta":{"content":"Hi"}}]}"#, &mut emit).unwrap()
            );
            assert!(parse_openai("[DONE]", &mut emit).unwrap());
            assert!(parse_openai(r#"{"error":{"message":"bad key"}}"#, &mut emit).is_err());
            // A keepalive line is not an error.
            assert!(!parse_openai("ping", &mut emit).unwrap());
        }
        assert_eq!(events, vec!["Hi"]);
    }

    #[test]
    fn anthropic_delta_done_and_error() {
        let mut events: Vec<String> = Vec::new();
        {
            let mut emit = |value: &str| events.push(value.to_string());
            assert!(
                !parse_anthropic(
                    r#"{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}"#,
                    &mut emit
                )
                .unwrap()
            );
            assert!(parse_anthropic(r#"{"type":"message_stop"}"#, &mut emit).unwrap());
            assert!(
                parse_anthropic(r#"{"type":"error","error":{"message":"nope"}}"#, &mut emit)
                    .is_err()
            );
        }
        assert_eq!(events, vec!["Hi"]);
    }

    #[test]
    fn provider_text_cannot_leak_the_key() {
        assert_eq!(
            redact("bad key sk-test-123 here", Some("sk-test-123")),
            "bad key [redacted] here"
        );
        assert_eq!(redact("no key", None), "no key");
        assert_eq!(redact("no key", Some("")), "no key");
    }

    #[test]
    fn model_list_errors_name_the_problem() {
        let empty = serde_json::from_slice::<Value>(b"").unwrap_err();
        let empty_message = model_list_error(200, "", b"", "http://host/v1", &empty);
        assert!(empty_message.contains("empty response"));
        assert!(empty_message.contains("http://host/v1"));

        let html = b"<!doctype html><title>gateway</title>";
        let html_error = serde_json::from_slice::<Value>(html).unwrap_err();
        let html_message =
            model_list_error(200, "text/html; charset=utf-8", html, "http://host/v1", &html_error);
        assert!(html_message.contains("HTML page"));

        let bad = b"{not json";
        let bad_error = serde_json::from_slice::<Value>(bad).unwrap_err();
        let bad_message =
            model_list_error(200, "application/json", bad, "http://host/v1", &bad_error);
        assert!(bad_message.contains("did not return a model list as JSON"));
        assert!(bad_message.contains("{not json"));
    }

    #[test]
    fn a_provider_message_is_collapsed_and_cut() {
        let long = format!("line one\n{}", "x".repeat(400));
        let text = sanitize(&long);
        assert!(!text.contains('\n'));
        assert!(text.chars().count() <= 241);
        assert!(text.ends_with('…'));
    }
}
