# The AI Assistant keeps ten successful answers in memory only

**Status:** accepted
**Date:** 2026-10-28

## Context

Applying an assistant answer closes its panel, and opening another action
replaces the panel state. The question, captured context and answer were then
lost, including an answer the reader had not copied or inserted. Ask already
kept a conversation while its panel stayed open, but no action survived the
panel, and that history was conversation-scoped rather than request-scoped.

The assistant handles document excerpts and model answers. Persisting them in
`settings.json` would put that text on disk in plain view, grow a settings file
that is read synchronously at start-up, and require a cache-shaped field in a
user-preference schema. The repository's assistant was also built around a
strict rule: no start-up network activity and no key or document text written
outside the OS credential store.

The reader asked for a small history: the last ten requests only. They chose a
session-only store over a persisted one, successful answers only, Ask recorded
per exchange, and Copy/Insert below as the only actions on an old answer.

## Decision

The AI Assistant keeps the ten most recent **successful** requests in memory for
the life of the process. An entry records the action, parameter, Ask question,
captured-context summary and exact context, answer, notes, model, endpoint,
document name, language, timestamp and truncation flag. Regenerate and Retry
reuse the request's entry id and replace that entry instead of adding a second
one; a changed parameter starts a new id. Stopped, failed and empty responses
are not stored.

History lives in `src/ai/history.ts` as pure data plus cap/replace/format
helpers, and in the assistant's closure as the session's array. It is reached
from the palette footer, opens in a non-modal popover, and offers a list, a
detail view, Copy, Insert below the current paragraph, Clear history and an
empty state. Nothing in this feature reads or writes a file. The floating
button's Reset position command moved to Preferences › AI Assistant so History
could take its palette slot.

## Consequences

- Closing MDraft discards the history. A crash or restart cannot recover it;
  that is the accepted cost of keeping document excerpts off disk.
- No settings migration, recovery-journal field or Rust command was needed, and
  older settings files keep loading unchanged.
- The list holds at most ten entries, with each answer already capped by the
  provider's 32,000-character output limit. Memory stays bounded; no cleanup
  timer or database exists.
- A regenerated answer replaces the old one, so the previous wording is gone
  unless the reader copied it. The live panel still shows the current answer,
  and the history is the record of the latest successful result for that
  request.
- History is a viewing surface, not a second editor path: it has no Replace, and
  an old answer cannot silently overwrite a selection captured in another
  revision. Insert below is additive and one undo removes it.
- Any future request for persistent or cross-window history needs a new ADR and
  an explicit answer about where the document text is stored.
