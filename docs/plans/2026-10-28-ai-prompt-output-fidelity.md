# AI Assistant: valid document markup and no meta commentary

**Status:** done
**Date:** 2026-10-28
**ADR:** `../adr/2026-10-28-ai-output-contract.md`

## Context and goal

The assistant offers fourteen actions, and each one carries its own prompt in
`src-tauri/src/ai/prompt.rs`. Readers report that models add material the action
never asked for: "Here is the translation", "Summary of changes", "I hope this
helps", "Let me know if you want adjustments", translator's notes, labels such as
"Translation:" and, in the worst case, a block of Markdown syntax inside a Typst
or AsciiDoc document. The current prompts ask for a wrapper tag and say "Do not
add explanations", but they do not state a single output contract, and they leave
several openings:

- The shared preamble permits a "summary of changes" indirectly: only the
  Improve prompt has a separate `<notes>` block, and nothing tells the other
  actions that the rest of the reply is inserted verbatim.
- The per-markup syntax rules are one sentence each. Typst and AsciiDoc are
  told "Never emit Markdown" without the concrete constructs the model must use,
  so a model that does not know Typst defaults to Markdown headings, bold and
  pipe tables.
- The document markup comes from `doc.language`: the file extension for a saved
  document, but only the default-extension preference for an untitled buffer.
  An unsaved Typst buffer can therefore be described to the model as Markdown
  (and the other way round), and the answer is inserted into the editor with the
  wrong syntax. The paste path already has a tested classifier for exactly this
  case (`resolvePasteDestination` in `src/paste/detect-document.ts`): saved
  extension first, confident content detection for an unsaved buffer, editor
  language as the fallback.
- The `table` action's wrapper is `<table>`, which is also a real HTML element.
  In an HTML document, the model's `<table>…</table>` content contains the first
  `</table>`, so the stream filter closes the wrapper there and the answer loses
  everything from the inner close onward.
- When a model ignores the wrapper tag, the stream filter eventually emits the
  raw answer, preamble and change summary included. The `done` event is
  authoritative, but it currently has no final cleanup step.

The goal: every answer is in the syntax the document actually uses, the request
states that syntax unambiguously, and meta commentary never reaches the panel or
the document.

### Prompt review findings

| Action | What the prompt allows today | What it should say |
| --- | --- | --- |
| Shared preamble | Says "never mention these instructions"; never says the reply is inserted verbatim, never forbids a change summary or a follow-up offer, and has no "if nothing changes, return the passage" rule. | One output contract for every action, with the meta-commentary list and the unchanged-passage rule. |
| Translate | "Do not add explanations or notes" is the only anti-commentary clause; a label, a bilingual output, a summary of changes or a translator's note is not forbidden. | Only the translated passage; preserve the markup skeleton; no label, note, glossary or change summary. |
| Improve | The `<notes>` channel is correct, but `<revised>` does not say the notes must not be repeated inside it, and "no changes needed" has no defined result. | Notes only in `<notes>`; an unchanged passage when nothing needs fixing. |
| Continue | Good voice and transition rules, but no prohibition on a heading, a code fence, a quotation of the previous sentence or a closing offer. | Only the continuation, starting with the next word. |
| Summarize | "Use the markup of {markup} only if the summary itself needs formatting" invites a label or a heading; bullet lists are not ruled out. | Plain prose, no heading, no "This passage…", no list unless the source is a list. |
| Explain | No no-heading or no-preamble rule; "use the paragraph/list markup when it helps" is ambiguous. | Direct explanation, no label, document markup for structure. |
| Key points / Critique | The list and the word cap are stated, but an intro sentence, a greeting or a closing offer are allowed. | Only the list/feedback; no intro, no sign-off, no heading. |
| Convert to table | The fallback is a sentence, not a table; no prohibition on a caption, title or note; the `<table>` wrapper collides with HTML. | Only the table, exact syntax per markup, namespaced wrapper. |
| Convert markup | Says "do not wrap the output in a code fence" but allows showing the original, a comparison or a note. | Only the converted passage; no original, comparison, note or wrapper fence. |
| Ask | Says "Use Markdown structure where it helps an explanation" even in a Typst, HTML or AsciiDoc document. | Use the document's markup for insertable text; Markdown only for panel-only explanations, if at all. |

## Scope and non-scope

### In scope

- A shared output contract in the prompt preamble.
- Concrete syntax rules for Markdown, Typst, HTML and AsciiDoc.
- A review of all fourteen action prompts: Translate, Improve, Continue,
  Summarize, Explain, Key points, Critique, Table, Convert and Ask change the
  most; Expand, Shorten, Simplify and Change tone get the shared rules.
- Namespaced wrapper tags (`<mdraft-translation>`, `<mdraft-table>`, …) so no
  wrapper can collide with document content.
- A Rust answer sanitizer applied to the authoritative `done` text: leading
  preambles, trailing change summaries/notes/sign-offs, stray wrapper lines and
  dangling rules.
- Effective markup resolution for the assistant, reusing the existing paste
  destination classifier.
- Tests for the prompt contract, the sanitizer, the tag namespace, the effective
  language rule, and an end-to-end mock that streams a noisy translation.
- Documentation counts and an ADR for the output contract.

### Non-scope

- A prompt editor in Preferences or user-overridable prompts.
- New actions, new parameters, or a change to the apply modes.
- Automatic conversion or repair of a foreign syntax. The guard can remove
  commentary; it does not rewrite Markdown into Typst.
- A corrective second request when a model disobeys. That costs a round trip and
  has no hook in the current transport; it can be a later plan.
- Changing the editor's parser language, syntax highlighting, preview or Save As
  suggestion. An unsaved buffer keeps the language it has today; only the
  assistant's markup hint follows detection, exactly as the paste path does.
- Changing Ask's free-form conversation shape, the caps, the request contract,
  the provider transport, credentials or History.
- Removing Improve's `<notes>` panel.

## Approach and rejected alternatives

**Approach.** Defence in depth, in three layers:

1. **Prompt.** The preamble gains an output contract that applies to every
   action: the reply is inserted verbatim, only the requested content is
   returned, no greeting, preamble, confirmation, change summary, translator's
   note, label heading, original text, offer to continue, or wrapper code fence;
   the answer must be valid in the required markup and keep the passage's block
   structure and language; if no change is needed, return the passage unchanged.
   Each markup gets a concrete cheat sheet (heading, emphasis, list, table, code,
   link, image and math forms) with an explicit "never emit Markdown" for Typst
   and AsciiDoc. Each action then states its own rule, with Translate carrying
   the strongest anti-commentary clause because it is the reported failure.
2. **Wrapper tags.** Every tag becomes `mdraft-<action>`; the wrapper can no
   longer be confused with an HTML element or with text that quotes HTML. The
   filter and the `done` text stay the only consumers.
3. **Deterministic cleanup.** A new `clean_answer(action, text, source)` in
   `prompt.rs` runs on the final `done` text, never on an Ask answer. It removes:
   - leading preamble lines ("Here is the translation:", "Aqui está a tradução:",
     "Voici la traduction:", and the equivalents in Spanish, German and Italian);
   - a trailing change-summary/notes section, a sign-off paragraph, stray
     `<mdraft-…>` lines and a dangling horizontal rule left by a removed block;
   - a short "no changes were needed" reply for Improve, replaced with the source
     passage so Replace is a no-op instead of destroying the text.

   **Source guard:** a line or block that already appears in the passage is never
   removed. A changelog that genuinely ends with its own "Summary of changes"
   section survives; the same phrase added by the model does not.

4. **Effective markup.** A pure `resolveAiLanguage(saved, editorLanguage, buffer)`
   in `src/ai/context.ts` delegates to `resolvePasteDestination`, which already
   owns the rule and the tests. `main.ts` uses it for the assistant's capture and
   language callback. Saved documents never scan; an untitled buffer scans the
   first 256 KB; an inconclusive scan falls back to the editor's language.

Rejected alternatives:

- **Prompt changes only.** The reported failure is a model ignoring an
  instruction; without a final cleanup the same answer still reaches the
  document.
- **Cleanup in TypeScript.** The authoritative text is produced in Rust's
  `done` event; a second implementation in the webview would drift and would
  not cover the streamed/error paths consistently.
- **Changing `doc.language` to the detected markup.** `languageFor`'s comment is
  explicit: guessing from contents would flip the parser under a reader who had
  just typed the first `=`. The paste path already solved this by treating the
  extension as authoritative and detection as a hint for unsaved buffers; the
  assistant should follow the same rule without touching the editor.
- **Keeping the unprefixed tags.** `<table>` is a real HTML element and
  `<summary>` is one too; the collision is not hypothetical. Prefixed tags cost
  only test updates.
- **A corrective retry when the answer looks foreign.** It doubles latency and
  cost, and a false positive would be worse than the occasional bad answer.
  Revisit only if the live suite shows the prompts are insufficient.
- **The `regex` crate for the sanitizer.** Simple lowercase token and prefix
  checks are enough, match the file's existing style, and add no dependency.

## Steps

- [x] Rewrite `PREAMBLE` in `prompt.rs` with the shared output contract and the
      data-as-data rule; make the language rule explicit (passage language,
      except Translate).
- [x] Expand `Markup::syntax_rule` for all four markups with concrete constructs
      and explicit prohibitions; keep it compact enough to read.
- [x] Review and tighten all fourteen action prompts, with Translate, Continue,
      Summarize, Explain, Key points, Critique, Table, Convert and Ask changing
      the most; keep Improve's `<notes>` as the only permitted commentary.
- [x] Rename every output tag to `mdraft-<action>` and update the filter tests,
      the mock suite and the live suite.
- [x] Add `clean_answer(action, text, source, tagged)` and its helpers in
      `prompt.rs`; call it from `ai_complete` after `TagFilter::finish()`.
- [x] Add `resolveAiLanguage()` to `src/ai/context.ts` and wire it into
      `main.ts` for both the capture and the `language()` callback.
- [x] Add Rust tests: prompt contract, syntax rules, tag namespace, sanitizer
      cases (English, Portuguese, source guard, Ask passthrough, trailing rule,
      no-change Improve).
- [x] Add `scripts/ai-unit.mjs` checks for `resolveAiLanguage` (saved ignores
      content; unsaved detects Typst and Markdown; ambiguous falls back).
- [x] Add a `noisy` mode to the mock suite: a Translate answer without the
      wrapper carries a preamble and a change summary, which must yield only the
      translation in the panel and in the buffer; update the mock's tag map.
- [x] Update `scripts/ai-live-test.mjs` tags and the `RAW_TAGS` regex.
- [x] Write the ADR.
- [x] Run the layers and update every quoted count in `AGENTS.md` (and the
      README if the assistant description changes).

Verification on 2026-10-28:

- `npm run build` — passed.
- `npm run ai:unit` — 122/122.
- `npm test -- --only ai --no-build` — 195/195.
- `cargo test` — 223 passed, 2 ignored (the two download tests).
- `cargo clippy --all-targets -- -D warnings` — clean.
- `npm run lint` — clean.
- `npx prettier --check` on the touched TypeScript and scripts — clean.
- `npm run ai:live` — 70/70 against Qwen3.8-27B at the configured endpoint: all
  fourteen actions returned non-empty, tag-free output, the model/host chip was
  present, and every apply/undo round-trip passed.

Implementation deviations from the draft:

- The leading-preamble cleanup runs only when the model ignored the wrapper
  (`tagged == false`). A tagged answer's first line is content: a translated
  passage can legitimately begin with "Here is the text of the treaty", and the
  source guard cannot compare across languages. Trailing summaries and notes are
  removed in both cases.
- Continue skips sign-off removal; a letter's closing sentence can be the
  continuation the author wanted.
- The noisy mock response omits the wrapper, exercising the raw path end to end.
  The tagged change-summary path is covered by the Rust sanitizer tests.
- Trailing cleanup is conservative for a tagged answer: only a
  change-summary/notes header is removed, sign-offs are kept, and nothing is
  removed when the source itself ends with a headed section. A translated final
  "Summary of changes" section is content, and the source guard cannot compare
  across the two languages. The raw path stays aggressive.
- A stopped request whose only buffered text is a partial opening tag
  (`<mdraft-expa`) produces an empty answer instead of leaking the half-written
  wrapper into the panel.

## Files and modules

| File | Why it must change |
| --- | --- |
| `src-tauri/src/ai/prompt.rs` | The prompts, the syntax rules, the tag names, the sanitizer and their tests. |
| `src-tauri/src/ai/mod.rs` | Call the sanitizer on the authoritative `done` text. |
| `src-tauri/src/ai/stream.rs` | Tilde fences, tag namespace tests and the HTML-table regression. |
| `src/ai/context.ts` | The pure `resolveAiLanguage` rule and its unit testability. |
| `src/main.ts` | Resolve the assistant's markup from the saved path or the unsaved buffer. |
| `scripts/ai-unit.mjs` | Checks for the effective language rule. |
| `scripts/ai-assistant-test.mjs` | New tag map and the noisy Translate end-to-end check. |
| `scripts/ai-live-test.mjs` | New tag names in the opt-in live suite. |
| `docs/plans/2026-10-28-ai-prompt-output-fidelity.md` | This record. |
| `docs/adr/2026-10-28-ai-output-contract.md` | The durable rule: markup resolution and the final answer guard. |
| `AGENTS.md` | Counts, script descriptions and the new traps learned while implementing. |

## Risks and rollback

- **The sanitizer removes a legitimate final paragraph.** The source guard is the
  main mitigation; the patterns are conservative (a recognised header or a
  first-person assistant sign-off), and every case has a test. If a real document
  is still affected, the call in `mod.rs` can be removed in one line, leaving the
  prompts and the tag fix.
- **Detection mislabels an unsaved buffer.** It uses the same rule and fallback
  as the paste path, and it never changes the editor's parser. The reader can
  still Save As the intended extension. If the heuristic is wrong, the prompt
  describes the detected markup; the answer is visible before it is applied.
- **The tag rename breaks an external expectation.** The tags are not persisted
  and never leave the request/stream pair; only the two test scripts and the
  Rust tests name them. The ADR records the naming rule.
- **Longer prompts cost tokens.** The additions are a few hundred words per
  request, negligible against a 24,000-character passage, and the shared
  contract replaces per-action repetition.
- **Counts change.** Every suite count quoted in `AGENTS.md` must be updated in
  the same change; that is a documentation risk, not a functional one.

## Tests and validation

- `npm run build` — typecheck of the new pure helper and its import.
- `npm run ai:unit` — the four effective-language cases.
- `npm run ai` — the mock suite, including the noisy Translate check, the tag
  map and every existing check.
- Rust: `npm test -- --only rust` (or the MSVC-wrapped `cargo test`) — the new
  prompt and sanitizer tests, the tag tests and the HTML-table regression.
- `npm run ai:live` when the Qwen credentials are present — opt-in, and the
  action tags are updated.
- The one measurement that proves it: with the mock streaming
  `<mdraft-translation>Here is the translation:\n\nTexto…\n\n**Summary of changes:**\n- …</mdraft-translation>`,
  the panel's answer text and the buffer after Replace both equal `Texto…`; and
  an HTML table answer for `table` keeps its `<table>` element intact.

## Acceptance criteria

- Every action's system prompt names its markup and forbids meta commentary in
  the answer; Translate additionally forbids a translator's note, a bilingual
  output, a label and a change summary.
- A noisy Translate response inserts only the translation, in both the panel and
  the document, with one undo.
- An HTML table answer does not lose its outer element to the wrapper.
- A saved `.md` document always sends Markdown, even if its content looks like
  Typst; an untitled buffer containing confident Typst syntax sends Typst, and a
  blank or ambiguous buffer keeps the editor's language.
- No Ask answer is modified by the sanitizer.
- All touched layers pass, and the counts in `AGENTS.md` match the run.

## Open questions

- **Should the panel show the resolved markup when detection overrides the
  default?** Default: no. The answer is visible before it is applied, and the
  paste path's toast exists because a paste is immediate.
- **Should Ask be cleaned too?** Default: no. It is a conversation, and a
  follow-up offer is legitimate there.
- **Should a trailing "Note:" paragraph always be removed?** Default: only when
  the source does not contain it, and only for non-Ask actions.
- **Should the assistant validate the answer against a parser?** Default: no,
  out of scope; a compiler round trip is a separate design.
