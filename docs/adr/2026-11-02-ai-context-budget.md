# AI Assistant document context is budgeted in estimated tokens

**Status:** accepted
**Date:** 2026-11-02

## Context

The assistant's passage limit was 24,000 characters, enforced once in the
webview and again in Rust. A character count does not describe a model's context
window: 24,000 characters of English is roughly 4,000-6,000 tokens, while the
same number of CJK characters is close to 24,000 tokens. The application already
estimates tokens for the status bar with `tokenx-rs`, in
`src-tauri/src/tokens.rs`. That estimate is model agnostic, takes about 4.6 ms
per megabyte, and is what the reader already sees beside the word count.

The assistant also had separate character caps for Continue's preceding text
(12,000), Ask's selection context (24,000) and Ask's history (24,000 in total,
8,000 per turn). They shared no unit with the setting a reader could understand,
and the frontend history trim could silently make a larger backend budget
unreachable.

## Decision

The document text sent with one AI request is bounded by one user setting,
`aiContextTokens`, measured in the **approximate tokens from the existing
estimator**. The budget covers the passage, Continue's preceding text, and
Ask's question and history. The default is 8,192; Rust clamps the value to
1,024-32,768 on load and on save, and Preferences › AI Assistant exposes the same
range.

Rust remains the authority. `src-tauri/src/ai/limits.rs` derives the shares:

- the passage and Ask's selection draw from the whole `context` budget;
- Continue's selection and preceding text each get `context / 2`;
- one history turn gets `context / 4`, and whole pairs are dropped from the front
  until the remaining history fits what the passage and question leave.

A rewrite or understanding action over the budget is refused rather than
trimmed: applying a partial rewrite over a whole selection would corrupt it.
Ask and Continue trim and report `contextTruncated`.

The webview never implements a second tokenizer. Its palette obtains the count
from the existing `count_tokens` command, which calls the same
`tokens::estimate_tokens` as the status bar. The frontend's `trimHistory` keeps
only the twelve-turn cap; token trimming belongs to Rust.

The output cap (32,000 characters) and Ask's free-form question cap (4,000
characters) remain character-based: they bound the answer and the question, not
document context.

## Consequences

- One setting now means one document-context budget. Enlarging it can raise
  request cost and may exceed a model's own window; the Preferences help tells
  the reader to leave room for the system prompt and the answer. The application
  cannot know a provider's chat template or output reserve.
- The estimate is approximate, within about 10% of cl100k and o200k on the
  repository's fixture. A provider can still reject a request the estimate
  thought fit; that is a budget, not a guarantee.
- The four former constants (`MAX_SELECTION`, `MAX_CONTINUE`,
  `MAX_ASK_CONTEXT`, `MAX_HISTORY_CHARS`) are gone. Future context work must
  derive from `AiLimits` rather than add another character constant.
- A settings file written before this change loads with 8,192 tokens. An older
  build ignores the unknown `aiContextTokens` key and falls back to its old
  character caps, so a downgrade is safe.
- A real BPE tokenizer remains rejected: 8.7 MB of vocabulary tables and a
  model-specific choice are the wrong trade for a status bar and a guard rail.
