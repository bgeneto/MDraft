# Disable reasoning (thinking) for the AI Assistant

**Status:** done
**Date:** 2026-11-02
**ADR:** none

## Context and goal

The assistant sends one request shape: `model`, `messages`, `stream` for an
OpenAI-compatible server, and `model`, `system`, `messages`, `max_tokens`,
`stream` for Anthropic. Nothing in the body asks either provider to skip
reasoning, and both have moved their defaults toward thinking:

- OpenAI's GPT-5.2 and later default to `reasoning_effort: "none"` on their own,
  but GPT-5, GPT-5.5 and GPT-6 variants default to `medium` (or think always).
- Anthropic's Claude 5 generation thinks by default: Opus 5, Sonnet 5, Haiku 5.5
  and Sonnet 5.5 all begin with adaptive thinking when the `thinking` field is
  omitted.

Thinking is invisible to this application — `parse_openai` ignores
`reasoning_content` deltas and `parse_anthropic` ignores `thinking_delta` — so
the only symptom the reader sees is a first visible token that arrives many
seconds after Generate. For a writing assistant that edits a selected paragraph,
that delay is the dominant cost, and the answer is usually not better for it.

**Goal:** an opt-in **Disable reasoning (thinking)** checkbox that adds the
provider's own "no reasoning" request field, plus a **Test** action that makes
one short request and reports whether the configured model accepts it, because
the field is not universally supported and a rejection is a hard HTTP 400.

### What the providers actually accept (checked 2026-11-02)

| Provider | Field | Notes |
| --- | --- | --- |
| OpenAI-compatible (`/chat/completions`) | `"reasoning_effort": "none"` | The native OpenAI switch. GPT-5.1 introduced `none`; GPT-5.2 defaults to it. `gpt-4o`, `gpt-4.1` and `gpt-3.5` reject the parameter outright with `400 Unrecognized request argument supplied: reasoning_effort`; `o1-mini` does not support it; GPT-6 Astra rejects `none` specifically, while accepting other efforts. llama.cpp forwards `reasoning_effort: "none"` as "thinking off"; vLLM, Ollama and gateways vary. |
| Anthropic (`/v1/messages`) | `"thinking": {"type": "disabled"}` | Accepted by Opus/Sonnet/Haiku 4.5, 4.6, 4.7, 4.8 and by Opus 5, Sonnet 5 and Haiku 5.5 (at effort `high` or below; this client sends no effort, so the default is in range). Rejected with 400 by models whose thinking is always on: Opus 5.5, Fable 5/5.1, Mythos 5/5.1, Mythos Preview. **Sonnet 5.5 is the exception:** it rejects `disabled` and tells the caller to send `{"type": "between_tools"}`, which turns off up-front thinking. |

Two consequences drive the design. First, the field cannot be sent
unconditionally: it would break `gpt-4o`, the most common cheap OpenAI model.
Second, "accepted" and "thinking really stopped" are different claims: a gateway
may accept and ignore the field, so the test reports what it can prove and says
so.

## Scope and non-scope

**In scope**

- One persisted boolean, `aiDisableReasoning` / `ai_disable_reasoning`, off by
  default.
- The body field for both provider shapes, in every request the assistant makes
  (actions and the file-name suggestion).
- A `ai_test_reasoning` command and a **Test with the configured model** button.
- An Anthropic-only retry with `between_tools` when the provider's 400 names it:
  same intent, the only value that model family accepts.
- A hint appended to a 400/422 error that names reasoning/thinking, pointing at
  the setting.
- Unit tests, mock-endpoint checks, and the documentation the change touches.

**Non-scope**

- An effort selector (`low`/`medium`/`high`/`xhigh`). The request is "off", and
  any effort still reasons.
- Migrating to the Responses API.
- Inferring capability from the model id. A Base URL serves any model under any
  name, and a gateway may alias it.
- Persisting the test result. It is a session answer, cleared when the endpoint
  or model changes, like the fetched model list.
- Automatic retry without the field on an OpenAI-compatible 400. That doubles a
  failed request and hides that the setting did nothing; the test button and the
  error hint are the honest route.
- Filtering reasoning deltas. Already ignored by both parsers.

## Approach and rejected alternatives

A boolean setting is threaded into `ChatConfig`, and `request_body` adds exactly
one field per provider. `stream` and the probe share one POST helper so the
Anthropic `between_tools` translation exists once. The probe is a non-streaming
`chat/completions` or `messages` call with a two-word prompt, the same key and
the same reasoning field Generate would send; its reply distinguishes "accepted"
from "the provider refused" from a transport/auth error.

The test is a real request on purpose. The alternative — a `HEAD`, a `/models`
inspection or a static model table — cannot see the request schema the endpoint
actually enforces, which is the only thing that matters. The help text and the
result sentence both say that acceptance is not proof the model stopped
reasoning.

**Rejected alternatives**

1. *Send `reasoning_effort: "none"` always.* Breaks `gpt-4o`/`gpt-4.1` with a
   400 on every Generate, and changes the request for readers who never asked
   for it.
2. *Choose by model-name prefix.* The id is free text and endpoints alias it;
   `openai/gpt-5` through a router and a local `Qwen3.8-27B` are the same code
   path. Capability claims from names would be wrong in both directions.
3. *A three-way select (default / off / low).* "Low" still thinks; it does not
   deliver the TTFT the reader wants, and it adds a second protocol surface.
4. *`chat_template_kwargs: {"enable_thinking": false}` instead.* That is
   llama.cpp/vLLM vocabulary, not OpenAI's. A strict OpenAI-compatible server
   rejects unknown body fields; `reasoning_effort` is the only spelling at least
   one major server family honours natively.
5. *A persisted "this model supports it" flag.* The endpoint, model and server
   version all change under the same settings file; a stale yes would silently
   skip the field and a stale no would disable a working option.

## Steps

- [x] `settings.rs`: add `ai_disable_reasoning: bool` (`#[serde(default)]`,
      default `false`) and a unit test that an older file loads it as `false`
      and a file with `true` round-trips.
- [x] `provider.rs`: add `disable_reasoning: bool` to `ChatConfig`; add the
      OpenAI `reasoning_effort: "none"` and Anthropic `thinking: {"type":
      "disabled"}` fields in `request_body`.
- [x] `provider.rs`: extract the chat POST into one helper used by `stream` and
      the probe; on Anthropic 400 whose body contains `between_tools`, rebuild
      the body once with that value and retry.
- [x] `provider.rs`: `probe_reasoning(config)` — one non-streaming request with
      a two-word prompt, `max_tokens: 16` for Anthropic only (the OpenAI shape
      deliberately keeps omitting output limits), 60 s timeout, returning
      `accepted` plus a sentence or the provider's detail.
- [x] `provider.rs`: when a 400/422 body names `reasoning` or `thinking`, append
      one sentence naming the setting. Unit-test the predicate.
- [x] `mod.rs`: pass `settings.ai_disable_reasoning` into `ChatConfig`; add the
      `ai_test_reasoning` command with redaction and the same key resolution as
      `ai_fetch_models`; register it in `lib.rs`.
- [x] `naming.rs`: pass the same flag, so a suggested file name does not wait
      for thinking either.
- [x] `api.ts`: `aiDisableReasoning` on `Settings`, the probe reply type and the
      `aiTestReasoning` wrapper.
- [x] `preferences.ts`: the checkbox, the Test button and a note row; add
      `"reasoning"` to the note union and a `testing` flag; clear the note when
      Provider, Base URL or Model changes, like the model list.
- [x] `scripts/ai-assistant-test.mjs`: mock modes that accept, reject and name
      `between_tools`, and checks for the OpenAI and Anthropic bodies, the
      button's three answers, the error hint and the cleared note.
- [x] Update the counts (three places in `AGENTS.md`) and the AI paragraph in
      `README.md`.
- [x] Run the gates listed under [Tests and validation](#tests-and-validation).

**Deviations**

- The `button` row gained an optional `disabledTitle`, so the test button does
  not show the preset rows' "This preset is already at its defaults." while a
  request is in flight.
- The mock suite landed at **294** checks (+10), not the six the estimate below
  named; the extra four prove that the box is off by default, that the test
  works before opting in, that the tick is what adds the field, and that
  unticking removes it.

## Files and modules

| File | Why |
| --- | --- |
| `src-tauri/src/settings.rs` | The persisted boolean and its default. |
| `src-tauri/src/ai/provider.rs` | Body fields, the shared POST helper, the probe, the error hint, unit tests. |
| `src-tauri/src/ai/mod.rs` | Threads the setting into requests; the new command. |
| `src-tauri/src/ai/naming.rs` | The file-name request is a completion like any other. |
| `src-tauri/src/lib.rs` | Registers `ai_test_reasoning`. |
| `src/api.ts` | `Settings` field, probe types, wrapper. |
| `src/preferences.ts` | The checkbox, button, result note and state. |
| `scripts/ai-assistant-test.mjs` | Proves the wire bodies and the button's three outcomes against a real mock. |
| `AGENTS.md` | Check counts are a contract; three places quote the AI suite. |
| `README.md` | The AI bullet lists what Preferences offers. |

## Risks and rollback

- **A model rejects the field and every Generate fails.** Opt-in, the help text
  says so, the Test button answers before the first Generate, and the 400 hint
  names the setting. A reader who never ticks the box sees no change.
- **A gateway accepts and ignores the field.** The answer is still correct, just
  slow; the test's sentence says acceptance is not proof.
- **Anthropic's `between_tools` retry fires on a model that accepts both.**
  It cannot: the retry only runs after a 400 whose body names `between_tools`.
- **A picky server rejects the added field for another reason.** Same as the
  first risk; the provider's literal message is shown, so the cause is visible.
- **Rollback.** Unchecking removes the field from every request; reverting the
  commit leaves one unknown key in `settings.json`, which an older build ignores
  (`Settings` has no `deny_unknown_fields`) and the next save drops.

## Tests and validation

- `cargo test` (`npm run test:rust`): body tests for both providers with the
  flag on and off, the Anthropic retry predicate, the error-hint predicate, the
  new settings default and round trip.
- `npm run ai`: mock checks that
  - Generate with the box on sends `reasoning_effort: "none"` (OpenAI) and
    `thinking.type === "disabled"` (Anthropic),
  - the box off sends neither,
  - the Test button reports accepted when the mock answers 200,
  - it reports the provider's detail when the mock answers 400,
  - an Anthropic 400 naming `between_tools` is retried once with that value and
    succeeds,
  - a Generate rejected with 400 shows the hint naming Preferences › AI
    Assistant,
  - changing the Model clears the test note.
- `npm run ai:unit`: unchanged (no frontend module logic changes).
- `npm run build`, `npm run format:check`, `npm run lint`, `npm run knip`, and
  `cargo clippy --all-targets -- -D warnings` — the Quality gates, before
  pushing.
- Manual, when credentials are available: the Test button against the configured
  Qwen gateway, then Generate with the box on and compare the time to the first
  visible token with the box off.

The measurement that proves it works is the request body the mock records, not
the checkbox's own state: a checkbox that stores a boolean and a request that
never carries the field would otherwise pass.

**Recorded results:** `npm run ai` 294/294; `cargo test --lib ai::` 109 passed
(17 in `provider`); `cargo test --lib settings::` 31 passed; `npm run build`,
`format:check`, `lint`, `knip` and `cargo clippy --all-targets -- -D warnings`
clean.

## Acceptance criteria

- Preferences › AI Assistant shows **Disable reasoning (thinking)**, off by
  default, with help that names both protocol fields, says the option is a
  request rather than a guarantee, and points at the test.
- With it on, an OpenAI-compatible request body contains
  `"reasoning_effort": "none"` and an Anthropic body contains
  `"thinking": {"type": "disabled"}`; with it off, neither field is present.
- **Test with the configured model** sends one short request and prints either
  "accepted" or the provider's literal refusal, under the checkbox.
- A Generate that the endpoint refuses with 400/422 because of the field ends
  with a sentence that tells the reader to turn the setting off.
- A model whose thinking is always on gets its provider error verbatim, not a
  silently unmodified request.
- Existing `settings.json` files load unchanged; the boolean defaults to `false`.
- The new checks pass and the quoted counts in `AGENTS.md` match the suite.

## Open questions

All three were accepted as written and are now the implementation:

1. The probe result does not survive closing Preferences; it is session state
   like the fetched model list, and the endpoint can change.
2. Sonnet 5.5 is not sent `between_tools` up front; the reactive retry avoids a
   model-name rule and costs one request only on the model that needs it.
3. The flag is not sent to `ai_fetch_models`; `/models` has no body.

Also settled during approval: the test button works while the checkbox is off,
and an OpenAI-compatible refusal is **not** retried without the field — Generate
fails, with a message naming the setting, rather than quietly changing the
request.
