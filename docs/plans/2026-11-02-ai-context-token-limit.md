# AI Assistant: a configurable token context budget

**Status:** done
**Date:** 2026-11-02
**ADR:** `../adr/2026-11-02-ai-context-budget.md`

## Context and goal

The assistant has a hard-coded character limit that has nothing to do with a
model's context window. When a selection is too large, every rewrite and
understanding row in the palette is disabled with:

> Select a shorter passage — up to 24,000 characters.

Today that number exists twice: `src/ai/assistant.ts` refuses the row in the
webview, and `src-tauri/src/ai/prompt.rs` refuses the same request again. The
other context caps are hard-coded characters too:

| Part | Current cap |
| --- | --- |
| Selection or current paragraph for a rewrite/understanding action | 24,000 characters |
| Continue's selection and preceding text | 12,000 characters each |
| Ask's selection context | 24,000 characters |
| Ask history | 24,000 characters in total, 8,000 per turn |
| Ask's free-form instruction | 4,000 characters |
| Streamed answer | 32,000 characters |

The application already estimates tokens for the status bar with
`tokenx-rs` (`src-tauri/src/tokens.rs`, shown as `6,823 tokens` beside the word
count). That estimate is the right unit for a context limit: it is model
agnostic, fast, and already on screen. The goal is one user setting measured in
approximate tokens, defaulting to **8,192** and adjustable up to a hard
**32,768**, with the palette and the backend agreeing on the same number.

## Scope and non-scope

### In scope

- A new `aiContextTokens` setting, persisted in `settings.json`, default 8,192,
  clamped to 1,024–32,768 on both load and save.
- A numbered **Context limit** row in Preferences › AI Assistant.
- A Rust `AiLimits` value derived from that setting: the passage/Ask context
  budget, a Continue share (half), and a per-turn history share (a quarter).
- Token-based trimming helpers that reuse `tokens::estimate_tokens`; no second
  tokenizer in TypeScript.
- `prompt::prepare` taking those limits, so a rewrite over the budget is refused
  and Continue, Ask and history are trimmed to fit the same document-text
  budget.
- The palette's refusal text naming tokens, obtained from the existing
  `count_tokens` command.
- The panel's context summary showing tokens when the count is known, and the
  `started` event reporting the number of document-context tokens actually
  sent.
- Unit and UI tests for the setting, the clamp, the derived caps, the trimming,
  the refusal, and the Preferences row.
- An ADR recording that document context is budgeted in estimated tokens and
  that Rust remains the authority.

### Non-scope

- A model-specific BPE tokenizer (`tiktoken-rs` or a per-provider vocabulary).
  The estimate stays approximate, as the status bar already is.
- Changing the output cap (32,000 characters) or the free-form instruction cap
  (4,000 characters). Those are not document context.
- Per-provider or per-model limits. One reader-facing budget is the goal.
- Counting the system prompt, wrapper tags or the model's chat template against
  the budget. The setting governs **document text**, not the full prompt.
- Changing Ask history retention, the palette's action list, the prompt text,
  streaming, credentials, or the panel's layout.
- A frontend trim of the Continue context preview. The request itself is
  token-trimmed in Rust; the preview stays a character-capped display and will
  say so instead of claiming to be exact.

## Approach and rejected alternatives

**Approach.** One setting, one budget, and one estimator.

1. **Setting.** `Settings.ai_context_tokens` (`aiContextTokens` in the
   frontend) gets `#[serde(default = "default_ai_context_tokens")]`, so an older
   `settings.json` loads with 8,192. `parse_settings` and `AppState::save` clamp
   it to 1,024–32,768, exactly as the recent-list and tab caps are enforced at
   the same two boundaries. The Preferences row is a `number` row with
   `min: 1024`, `max: 32768`, `step: 256` and `suffix: "tokens"`.

2. **Derived limits.** A new `src-tauri/src/ai/limits.rs` owns:

   ```text
   context        = clamp(setting, 1024, 32768)
   continue_part  = max(256, context / 2)
   history_turn   = max(256, context / 4)
   ```

   `AiLimits::from_context_tokens` clamps, `AiLimits::default()` uses 8,192,
   and unit tests pin the derivation. `ai_complete` already clones settings, so
   it passes `AiLimits::from_context_tokens(settings.ai_context_tokens)` to
   `prompt::prepare`.

3. **Token trimming.** `src-tauri/src/tokens.rs` gains two pure helpers:

   - `take_first_tokens(text, limit)` — the longest prefix whose estimate is at
     most `limit`;
   - `take_last_tokens(text, limit)` — the shortest suffix whose estimate is at
     most `limit`.

   Both binary-search character boundaries, so they never split a UTF-8 code
   point, and both use `estimate_tokens` (the status bar's counter) rather than
   a second heuristic. `prompt.rs` uses them for the passage, Continue's
   preceding text and each history turn.

4. **Assembly.** `prompt::prepare(request, limits)`:

   - **Rewrite / understanding:** if the passage exceeds `limits.context`,
     return the refusal. It is not trimmed, because applying a rewritten part
     over the whole range would be wrong.
   - **Continue:** the selection and the preceding text are each capped at
     `limits.continue_part` with `take_last_tokens`; the preceding keeps its
     existing paragraph-boundary rule. Together they stay within the budget.
   - **Ask:** the instruction keeps its 4,000-character cap and is measured
     first; the selection is then capped at
     `limits.context.saturating_sub(instruction_tokens)` with
     `take_first_tokens`. History turns are capped per turn at
     `limits.history_turn`, then whole pairs are dropped from the front until
     the remaining history fits
     `limits.context - (passage + instruction)`. The total document text
     therefore stays within the budget.
   - **All actions:** `Prepared.context_chars` becomes `context_tokens`, and
     `AiEvent::Started.context_chars` becomes `context_tokens`. The number is
     the sum of the document text actually sent (passage, preceding,
     instruction, history). `context_truncated` still says whether anything was
     dropped. The panel reports the number after `started`; the field is not
     persisted, so renaming it is a one-layer contract change.

5. **Frontend gating.** `AssistantConfig` gains `contextTokens`, read from
   settings in the `main.ts` host. The host gains
   `estimateTokens(text): Promise<number>`, implemented with the existing
   `api.countTokens` (`count_tokens`), so the webview never reimplements the
   estimator. A small cache keyed by the passage text, with at most a handful of
   entries, avoids recounting on every palette keystroke. `reasonFor` then:

   - shows `Select a shorter passage — up to 8,192 tokens.` when the cached
     count is over `config.contextTokens`;
   - allows the row when the text is no longer than the limit, because the
     estimator can never return more tokens than characters;
   - shows `Measuring the passage…` only while a longer text's count is still
     in flight, then re-renders with the real reason;
   - falls back to allowing the row if the count fails, because Rust will
     refuse the request with the same token-based message.

6. **Panel display.** The context summary uses the cached token count when it is
   known, falling back to characters until it arrives. After `started`, it
   appends the authoritative `contextTokens` and, when `contextTruncated` is
   set, `trimmed to fit`. The details label changes from "exact context" to
   "context preview", because the Continue preview is a character-capped display
   while the request itself is token-trimmed in Rust.

7. **Frontend history.** `trimHistory` stops applying its 24,000-character cap;
   it keeps only the 12-turn cap and lets Rust drop pairs against the token
   budget. Without this, a 24,000-character frontend cap (roughly 4,000–6,000
   tokens) would make a configured 8,192-token history budget unreachable.

**Rejected alternatives.**

- **Keep characters and convert them with a fixed ratio.** 24,000 characters is
  not a model limit; a ratio of 4 or 6 would encode a guess in two layers and
  would still not match the status bar. The estimator already exists.
- **A setting per cap.** Selection, Continue, history and per-turn rows would
  multiply the context, not bound it, and make the panel long. One budget with
  documented shares is simpler and keeps the total inside the number the reader
  chose.
- **A TypeScript token estimator.** It would duplicate `tokenx-rs` and drift
  from the status bar's number. The existing `count_tokens` command is the one
  source, and the estimate is cheap on the blocking pool.
- **A real BPE tokenizer.** `tiktoken-rs` embeds 8.7 MB of vocabulary tables,
  needs a target vocabulary, and takes 40–57 ms per megabyte. The status bar
  deliberately rejected it; the AI budget should not reverse that decision
  without a model-specific reason.
- **Refusing Ask and Continue instead of trimming.** The current contract trims
  and reports `contextTruncated`; refusing would turn a usable conversation into
  an error.
- **Counting the full prompt against the budget.** The chat template, system
  message and answer reserve differ by provider and model. The setting owns the
  document text; the help text tells the reader to leave room for the rest.

## Steps

- [x] Add `Settings.ai_context_tokens` with the serde default, the 1,024/32,768
      constants, the default 8,192, and the clamp in `parse_settings` and
      `AppState::save`; add Rust tests for default, load clamp and save clamp.
- [x] Add `src-tauri/src/ai/limits.rs` with `AiLimits`, the derived Continue and
      history shares, and unit tests; declare it in `ai/mod.rs`.
- [x] Add `take_first_tokens` / `take_last_tokens` to `tokens.rs` with UTF-8 and
      limit tests.
- [x] Change `prompt::prepare` to take `AiLimits`; replace the character caps
      for the passage, Continue, Ask and history with token trimming; rename
      `context_chars` to `context_tokens`; update the refusal text.
- [x] Pass the limits from `ai_complete`; rename the `started` field in
      `ai/mod.rs` and `src/api.ts`.
- [x] Add `aiContextTokens` to the frontend `Settings` interface and the
      **Context limit** number row to Preferences › AI Assistant.
- [x] Add `contextTokens` to `AssistantConfig`, `estimateTokens` to
      `AssistantHost`, and the token cache and new reason text in
      `src/ai/assistant.ts`; wire the host in `main.ts`.
- [x] Show token counts in the panel's context summary and update its label;
      remove the frontend history character cap and adjust `trimPreceding`'s
      wording.
- [x] Update `scripts/ai-unit.mjs` for `trimHistory`; add a UI check for the
      default, the clamp, a lowered limit and the palette refusal in
      `scripts/ai-assistant-test.mjs`; restore the setting in its `finally`.
- [x] Write the ADR, update the README's assistant paragraph and the counts and
      code map in `AGENTS.md`, and leave this plan with its final status and
      verification numbers.

Verification on 2026-11-02:

- `npm run build` — passed.
- `cargo test` — 241 passed, 2 ignored (the two download tests). The new tests
  cover the settings default and both clamps, the `AiLimits` shares,
  token-bounded cutoffs, the 1,024-token refusal, Continue's paragraph boundary
  and the Ask history/passage budget.
- `cargo clippy --all-targets -- -D warnings` — clean.
- `npm run ai:unit` — 128/128.
- `npm run ai` — 221/221 against a local mock. The installed MDraft was running,
  so the suite used a disposable build with identifier
  `io.github.bernh.mdraft.aicontexttest` and its own settings/profile; the
  normal release binary was rebuilt afterwards.
- `npm run lint` — clean.
- Prettier check on every touched TypeScript and script file — clean. A
  repository-wide `npm run format:check` also covers the separate, uncommitted
  statistics work in the tree; those files were not touched here.

Implementation deviations from the draft:

- Ask's instruction is capped by the context budget as well as its 4,000
  characters, so a 1,024-token budget cannot be exceeded by a long CJK
  question. The passage then receives only what the question leaves.
- The panel's label is **context preview** before a request and reports
  **N tokens sent** after `started`, because the Continue preview is still a
  character-capped display rather than the exact trimmed text.
- The frontend history cap is now turn-only. Rust owns the token cap, and the
  `ai-unit` check asserts that a six-turn history is not silently reduced by a
  character count.
- The 12 new Rust tests and 10 new UI checks: the Windows total is 241 passed,
  and the mock suite is 221/221. The `AGENTS.md` counts were updated in the same
  change.

## Files and modules

| File | Why it must change |
| --- | --- |
| `src-tauri/src/settings.rs` | The new persisted field, its default, its clamp at load/save, and tests. |
| `src-tauri/src/ai/limits.rs` | New: the default/range constants and the derived Continue and history shares. |
| `src-tauri/src/ai/mod.rs` | Build `AiLimits` from settings when a request starts; rename the `started` field. |
| `src-tauri/src/ai/prompt.rs` | Token caps, trimming, the refusal text, `context_tokens`, and the prompt tests. |
| `src-tauri/src/tokens.rs` | Reusable token-bounded prefix/suffix helpers and their tests. |
| `src/api.ts` | `Settings.aiContextTokens` and the `started` event's `contextTokens`. |
| `src/preferences.ts` | The **Context limit** number row and its help text. |
| `src/ai/assistant.ts` | Config, the token cache, `reasonFor`, the context summary and the history cap. |
| `src/ai/context.ts` | Remove the frontend's character cap from `trimHistory`; keep the display-only `trimPreceding`. |
| `src/main.ts` | Pass the setting into `AssistantConfig` and implement `estimateTokens`. |
| `scripts/ai-unit.mjs` | The history-cap test now reflects that Rust owns the token cap. |
| `scripts/ai-assistant-test.mjs` | Preferences coverage, the lowered-limit palette refusal, and the cleanup of the new setting. |
| `README.md` | One sentence describing the configurable token budget. |
| `AGENTS.md` | Updated suite counts, the AI test description and the AI code map. |
| `docs/adr/2026-11-02-ai-context-budget.md` | The durable rule: estimated tokens, one budget, Rust owns the cap. |
| `docs/plans/2026-11-02-ai-context-token-limit.md` | This record. |

## Risks and rollback

- **The default is larger than the old character cap for English.** 8,192 tokens
  is roughly 40,000–50,000 English characters, about twice the old 24,000. This
  is the requested default, but it can raise request cost. The Preferences row
  makes the number visible, the help text says to leave room for the model's
  context window, and the reader can lower it.
- **A provider's real tokenizer disagrees with the estimate.** The status bar
  already says "within about 10% of cl100k and o200k"; the budget inherits that
  approximation. A model can still reject a request that the estimate thought
  fit. The help text treats the setting as a budget, not a guarantee.
- **The frontend count is asynchronous.** A row can briefly say "Measuring the
  passage…" for a large selection. The cache keeps it to one count per passage,
  and the backend independently refuses an over-budget rewrite, so the race
  cannot send a request the reader did not intend.
- **Token trimming can cut mid-word for Ask's selection.** The existing
  character trim did the same, and Ask context is context, not a rewrite. The
  Continue path still drops forward to a paragraph boundary; rewrites are
  refused rather than trimmed.
- **Downgrade.** An older build ignores the unknown `aiContextTokens` key and
  falls back to its character caps; the new build clamps a hand-edited value.
  Rollback is removing the row and the token caps; leaving the key in
  `settings.json` is harmless.
- **Counts in `AGENTS.md` change.** Update them in the same change. A stale count
  is a documentation failure, not a functional one.

## Tests and validation

- `npm run build` — the new `Settings` field, `AssistantConfig` field and
  `started` field typecheck.
- `npm run test:rust` or the MSVC-wrapped `cargo test` — token helpers,
  `AiLimits`, the settings default/clamp, the token refusal, Continue/Ask/history
  trimming, and the existing prompt tests. Add:
  - a 1,024-token custom limit refusing a 1,025-token rewrite and allowing a
    1,024-token one;
  - a CJK selection, proving the helpers do not split a code point;
  - a history case where the remaining budget after the passage drops whole
    pairs;
  - a settings file with a missing key, an over-max value and an under-min value.
- `npm run ai:unit` — `trimHistory` keeps twelve turns without a character cap,
  and the existing pure helpers still pass.
- `npm run ai` — the mock suite:
  - the AI Preferences section contains **Context limit**;
  - its default is 8,192 and its input carries the 1,024/32,768 bounds;
  - setting it to 1,024 persists through `get_settings`;
  - with the limit at 1,024, a selection over that budget disables the rewrite
    rows with `up to 1,024 tokens`, and clicking one shows the toast;
  - restoring 8,192 re-enables the same rows (or a smaller passage);
  - the suite's `finally` restores `aiContextTokens` along with the other AI
    settings.
- The one measurement that proves it: with the mock endpoint configured, a
  passage of about 3,000 estimated tokens and a limit of 1,024, the palette row
  is disabled and reads `up to 1,024 tokens`; with the limit raised to 8,192 the
  same row is enabled and the request reaches the mock. The same passage is
  independently refused by `prompt::prepare` when sent without the UI gate.
- `npm run lint`, `npm run format:check` and `npm run knip` if the new module's
  imports are not obviously covered.

## Acceptance criteria

- Preferences › AI Assistant contains a **Context limit** row with a default of
  8,192, a minimum of 1,024, a maximum of 32,768 and a `tokens` suffix; changing
  it survives a restart and is written to `settings.json`.
- A settings file without `aiContextTokens` loads at 8,192; a value below 1,024
  or above 32,768 is clamped on load and on save.
- A rewrite or understanding action whose passage exceeds the configured
  token budget is disabled in the palette with a message that names the
  configured number of tokens, and the backend independently refuses the same
  request with the same token-based reason.
- Continue's selection and preceding text, Ask's selection, and Ask history all
  fit the configured document-context budget; `context_truncated` is set when
  anything is dropped and `context_tokens` reports the number actually sent.
- The token count shown for the budget comes from the same estimator as the
  status bar; no TypeScript tokenizer is added.
- The assistant's Preferences section, the palette reason and the panel summary
  never mention 24,000 characters as a limit.
- All touched layers pass and the counts in `AGENTS.md` match the run.

## Open questions

- **Minimum value.** Default: 1,024 tokens. It leaves useful room for the system
  prompt and a short answer while allowing the limit to be lowered well below
  the default. A 256-token floor is possible if the reader wants to test tiny
  contexts, but it produces very little usable context.
- **Should Continue and history be separate settings?** Default: no. They are
  derived as half and a quarter of the one budget. Separate rows would multiply
  the context and add UI without a reported need.
- **Should the palette show the budget on enabled rows too?** Default: no. The
  number is in Preferences and in the disabled-row reason; an enabled row keeps
  its action description.
- **Should the panel preview be token-trimmed to match the request exactly?**
  Default: no in this change. Rust sends the authoritative trim; the panel shows
  a character-capped preview, is labelled "context preview", and reports the
  actual token count after `started`. A later change can expose the prepared
  text if readers ask for byte-exact previews.
