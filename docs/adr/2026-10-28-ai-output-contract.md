# The AI Assistant resolves one markup and guards the answer after the stream

**Status:** accepted
**Date:** 2026-10-28

## Context

The assistant's fourteen actions each carry a prompt. Models add material the
action did not ask for — "Here is the translation", "Summary of changes",
translator's notes, closing offers — and the panel shows it because the text
inside the wrapper tag is the answer. A model that ignores the wrapper is worse:
its whole reply reaches `done`. The prompts had no shared output contract, and
the per-markup rules were one sentence each, so a model that did not know Typst
or AsciiDoc fell back to Markdown.

The document markup also came from `doc.language`. That is the file extension
for a saved document, which is authoritative, but only the default-extension
preference for an unsaved buffer. An unsaved Typst buffer could therefore be
described to the model as Markdown, and the answer would be inserted into the
editor with the wrong syntax. The paste path already solved the same problem in
`resolvePasteDestination`: saved extension first, confident content detection
for an unsaved buffer, editor language as the fallback.

Separately, the `table` action's wrapper was `<table>`, a real HTML element. In
an HTML answer the stream filter closed the wrapper at the first inner
`</table>` and discarded the rest of the table.

## Decision

1. **Effective markup.** The assistant resolves the markup with
   `resolveAiLanguage()` in `src/ai/context.ts`, which delegates to the paste
   path's `resolvePasteDestination()`. A saved document's extension is
   authoritative. An unsaved buffer is classified from its first 256 KB; an
   inconclusive result falls back to the editor's language. Detection never
   changes `doc.language`, syntax highlighting, preview or Save As.
2. **Shared output contract.** The prompt preamble says the reply is inserted
   verbatim, allows only the requested content, forbids greetings, preambles,
   confirmations, change summaries, translator's notes, label headings, original
   text, follow-up offers and a wrapper code fence, requires the target markup,
   preserves block order and language, and returns the passage unchanged when
   nothing needs fixing. Each markup has a concrete syntax rule, and Translate
   repeats the prohibitions because it is the reported failure. Improve's
   `<mdraft-notes>` is the only permitted commentary channel.
3. **Namespaced wrappers.** Every wrapper is `mdraft-<action>`
   (`<mdraft-translation>`, `<mdraft-table>`, …), so no wrapper can collide with
   the document's own HTML or with text that quotes it.
4. **Final answer guard.** `clean_answer(action, text, source, tagged)` in
   `src-tauri/src/ai/prompt.rs` runs on the authoritative `done` text. It removes
   a leading preamble when the model ignored the wrapper, a trailing change
   summary or notes section, assistant sign-offs, stray wrapper lines and a
   dangling rule. A tagged answer is treated more conservatively than a raw one:
   its first line is content, sign-offs are not removed (a translated letter
   closing can be the real final sentence), and a trailing headed section is
   kept when the source itself ends with a headed section (a translated
   "Summary of changes" section is content, and the source guard compares
   against the original language). It never removes a line or block the source
   passage already contains. Ask is untouched. Continue keeps sign-offs, because
   a letter's closing sentence can be the continuation the author wanted. An
   Improve answer that only says no changes were needed returns the source
   passage, so Replace is a no-op instead of destroying the text.

## Consequences

- A new action must supply a `mdraft-*` tag, a prompt with the shared contract,
  and — if its answer can carry commentary — a sanitizer case and its tests.
- The guard is not a syntax converter. Foreign markup in a model answer remains
  possible; a corrective retry or a parser validation would need a new decision.
- Renaming a wrapper tag is test-visible but not persisted: the tags never leave
  the request/stream pair and never enter settings or the recovery journal.
- The source guard deliberately prefers a possibly untidy answer over deleting
  real content. A future tightening must keep that bias.
- The editor's parser language and the assistant's markup can differ for an
  unsaved buffer, exactly as they already can for a paste. The answer is shown
  before it is applied; the reader still chooses the extension on Save As.
