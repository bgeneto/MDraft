# The AI Assistant keeps its transport and its key in Rust

**Status:** accepted
**Date:** 2026-10-28

## Context

MDraft is local-first: no account, no telemetry, no network request at start-up.
The assistant the reader asked for must not weaken that. It must work with any
OpenAI-compatible `chat/completions` endpoint and with Anthropic's Messages API,
stream its answer, be stoppable mid-answer, and never put the API key where the
webview or `settings.json` can read it.

The webview cannot open a socket without changing the CSP, and a key held in
JavaScript is reachable from any script that ever runs in the main frame. The
key is also not a preference: it must not be copied into a recovery entry, a
settings snapshot or an error message.

Two provider shapes differ in more than the URL: Anthropic requires
`x-api-key`, `anthropic-version` and `max_tokens`, and its SSE events carry
`content_block_delta` objects; OpenAI-compatible servers use a bearer token and
`choices[0].delta.content`. The model also needs task-specific prompts, and the
document text must be treated as data, never as instructions.

Measured on this host: `reqwest` 0.13.5 with its default `rustls` feature enables
aws-lc-rs, while the existing `ureq` (image and pandoc downloads) enables ring;
rustls refuses to choose between two providers at runtime. Building with
`rustls-no-provider` and declaring `rustls` with `ring` keeps one provider, but
`reqwest` then requires the provider to be installed explicitly — without it,
the first AI request panics with "No rustls crypto provider is configured".

## Decision

The transport lives in Rust. `ai_complete` receives a validated request and a
Tauri `Channel<AiEvent>`, reads the key from the OS credential store (Windows
Credential Manager, macOS Keychain, Secret Service on Linux) or from a
session-only fallback when the store is unavailable, builds the provider body,
streams the SSE response with `reqwest`, and sends only text over the channel.
The webview never opens a socket and the CSP is unchanged.

There are two adapters — OpenAI-compatible Chat Completions and Anthropic
Messages — behind one `ChatConfig`. The fourteen action prompts, their output
tags, the context caps and the parameter validation live in
`src-tauri/src/ai/prompt.rs`; a streaming state machine in `stream.rs` emits only
the text inside the expected tag, removes an outer code fence at the end, and
falls back to the whole answer when the model ignores the tags. The frontend
captures the selection or paragraph, checks the session/revision/range before
applying, and writes one CodeMirror transaction so a single undo restores the
exact bytes.

The floating button is icon-only, draggable inside the source pane, and its
position is session-only: every launch computes the same bottom-right anchor.
The palette is searchable and grouped; the panel is non-modal and parameterised
actions wait for Generate.

`reqwest` is built with `rustls-no-provider`; `rustls::crypto::ring` is
installed once before the first client. Private-LAN and loopback endpoints
bypass system proxies, so a local model or the LAN validation server is not sent
through a corporate proxy.

## Consequences

- No webview socket, no CSP relaxation, and no key in `settings.json`, recovery,
  a channel event or an error message. `ai_status` reports `keychain`,
  `session` or `none`.
- A Linux session without a Secret Service can still use the assistant, but the
  key is session-only and the Preferences panel says so. The store may prompt
  the reader on first use.
- `reqwest` and `rustls` are now direct dependencies and the release binary
  carries the TLS stack twice (`ureq` and `reqwest`) unless the two are unified
  later. The provider is a one-time installation, not per request.
- Prompts are fixed. **Ask AI** is the custom prompt; there is no free-form
  prompt editor, no chat persistence and no tools. Adding an action means
  changing the catalog in `src/ai/actions.ts` and the prompt/validation in
  `prompt.rs`; the mock and live suites assert the cross-language contract.
- The live suite is opt-in (`npm run ai:live` or `npm test -- --only ai-live`)
  and reads `MDRAFT_AI_E2E_*`. The default `npm test` uses only the local mock;
  CI never contacts the LAN or a paid provider.
- Changing the endpoint invalidates the key status: the credential name includes
  the provider and the normalized base URL, so two gateways never share a key by
  accident.
