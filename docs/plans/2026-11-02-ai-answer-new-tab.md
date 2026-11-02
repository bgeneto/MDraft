# AI answer into a new tab, and a footer that means "where does this go"

**Status:** done
**Date:** 2026-11-02
**ADR:** none

## Context and goal

The AI Assistant's answer footer offers **Replace selection**, **Insert below**,
**Copy** and **Regenerate**. Two actions have no sensible destination there:
**Convert markup** produces a different markup, so replacing a Markdown passage
with Typst or leaving both markups in one buffer is wrong in both directions;
**Translate** is usually wanted as a document of its own rather than a second
language below the original. The reader asked for a way to put an answer into a
new document tab.

Adding a fifth button is not free, and this was measured rather than assumed.
The panel opens at 440 px with 24 px of footer padding, so the action row has
416 px. At 12 px in the app's UI stack the labels are 113 (Replace selection),
87 (Insert below), 49 (Copy) and 82 (Regenerate): 331 px plus three 6 px gaps =
**349 px**. A `New tab` button is 66 px, so the row becomes **421 px — 5 px over**
and `Regenerate`, being last, is orphaned on a second line.

After this change the footer holds **destinations only** — selection, below, new
tab, clipboard — and **Regenerate** moves to the answer header, where "redo this
request" belongs. `New tab` is always available, including when the document is
read-only or changed under the answer, because it never touches the buffer; that
also removes today's dead end, where the stale message can only say "insert it
below instead".

## Scope and non-scope

In scope: the footer for every action type, the header's Regenerate button, the
new-tab action and its language choice, the same action in an AI History detail
row, the host method it needs, its CSS, the suites, and the two documentation
lists that quote their counts.

Not in scope: the palette, the request/prompt layer, the history store's schema,
the answer sanitizer, document zoom or the tab strip. **Convert markup** keeps
its `Replace selection` alternative; only its primary changes.

## Approach and rejected alternatives

`AssistantHost` gains `openInNewTab(text, language)`. `main.ts` implements it
with a new `openAiDocument(text, language)` that calls `loadUntitled(text,
language)` and then marks the tab dirty (`doc.savedContent = ""`, `setDirty(true)`,
`recovery.schedule`). `loadUntitled` alone would mark it clean, because a
built-in document is reproducible; a model answer is not, so Ctrl+W must ask and
the recovery journal must hold it.

The markup the answer opens in comes from a new pure helper,
`answerLanguage(action, parameter, source)` in `src/ai/actions.ts`: `convert`
returns its target markup when that target is valid and differs from the source,
every other action returns the source. The tab therefore highlights and previews
correctly (`#preview` carries `typst-document`, the HTML guest starts, and so on).

Footer per action type (measured at 440 px; the minimum width is 320 px, where
the destinations wrap as a group):

| Action | Footer |
| --- | --- |
| Continue | `Insert` (primary), `New tab`, `Copy` |
| Summarize / Explain / Key points / Critique | `Insert below` (primary), `New tab`, `Copy` |
| Improve / Expand / Shorten / Simplify / Tone / Translate / Convert to table | `Replace selection` (primary), `Insert below`, `New tab`, `Copy` |
| Convert markup | `New tab` (primary), `Replace selection`, `Insert below`, `Copy` |
| Ask | `Copy` (primary), `Insert below`, `New tab`, `New conversation` |

`Regenerate` becomes an icon button (`.ai-regenerate`, inline SVG) in
`.ai-result-head`, left of the Result/Changes toggle, shown only in the done
state for every action except Ask; the error state keeps `Retry` in the footer.
The reader chose the icon over a labelled text button, so the word is carried by
`title` and `aria-label`, both exactly "Regenerate", plus a hover surface and a
visible focus ring — an icon-only control in this panel must never be the only
place its name exists. The ambiguous footer labels get short titles too:
`Insert below` ("Insert the answer below the current paragraph") and `New tab`
("Open the answer in a new untitled tab; this document is not changed").

Rejected alternatives:

- **Append a fifth button and keep the current labels.** Measured at 421 px
  against 416 px: it wraps and leaves `Regenerate` alone on a second row.
- **Rename `Replace selection` to `Replace` so five buttons fit (371 px).** It
  works, but it hides the qualifier that distinguishes replacing the passage
  from inserting next to it, and it leaves only 45 px of headroom.
- **Keep `Regenerate` in the footer as a labelled text button.** Measured
  `Replace selection` 113 + `Insert below` 87 + `New tab` 66 + `Copy` 49 +
  `Regenerate` 82 with four gaps = 421 px, the wrap described above. The word
  moved instead of shrinking, and the reader chose the icon for it.
- **A split `Insert below ▾` menu holding `New tab`.** Keeps the row at 369 px,
  but the action the reader says they need most would cost two clicks and be
  invisible until the caret is opened.
- **An icon-only `New tab`.** Cheapest width, but not guessable; the panel has no
  icon vocabulary outside the close button.
- **A clean new tab, like Help › Font Licences.** That document is reproduced
  from the bundle; an answer cannot be regenerated byte-for-byte, so closing it
  silently would lose work.
- **A new native menu item for this.** The action is contextual to one answer and
  the menu has no way to know which answer that is.

## Steps

- [x] Add `answerLanguage(action, parameter, source)` to `src/ai/actions.ts` and
      update the `AiApply` doc comment to describe the destinations.
- [x] Add `openInNewTab(text, language)` to `AssistantHost` and call it from a new
      `openAnswerInNewTab()` in `src/ai/assistant.ts`; close the panel first, as
      `applyAnswer` does.
- [x] Render `New tab` in all four footer layouts with the table above; it is
      disabled only when there is no complete answer (never for staleness or
      read-only). Reword the stale status and the replace tooltip to mention the
      new tab, and give `Insert below` and `New tab` the short titles above.
- [x] Move `Regenerate` into `.ai-result-head` as an icon button hidden outside
      the done state and for Ask, with `title` and `aria-label` both
      "Regenerate".
- [x] Add `New tab` to the History detail row (after `Insert below`), using the
      entry's action, parameter and language.
- [x] Implement `openAiDocument` in `src/main.ts`, mark the tab dirty, schedule
      recovery, toast "Opened the answer in a new tab — use Save As to keep a
      copy", and wire it to the host.
- [x] Style `.ai-regenerate` in `src/styles.css` to sit with the answer head
      without moving the toggle's `margin-left: auto`.
- [x] Extend `scripts/ai-unit.mjs` for `answerLanguage`; extend
      `scripts/ai-assistant-test.mjs` for the footer inventory per action type,
      the header Regenerate route, `New tab` enabled while stale, the real
      open-a-tab flow (count, active tab, dirty dot, text, original buffer
      unchanged), the Convert-to-Typst language, and the History row. Discard the
      dirty tab with `.unsaved-dialog button[data-decision="discard"]` before the
      suite closes.
- [x] Update `README.md` (the action list) and `AGENTS.md` (both AI suite
      descriptions and counts, and the release checklist totals).
- [x] Run the layers in "Tests and validation" and record the counts actually
      observed.

## Files and modules

- `src/ai/actions.ts` — the pure language rule that both the footer and History
  need, and the doc comment that defines what each apply kind means.
- `src/ai/assistant.ts` — the host contract, the four footer layouts, the header
  Regenerate button, the new-tab and History actions.
- `src/main.ts` — the new-tab implementation, dirty baseline and recovery, and
  the host wiring.
- `src/styles.css` — the icon button in the answer head.
- `scripts/ai-unit.mjs` — checks for `answerLanguage` with no application.
- `scripts/ai-assistant-test.mjs` — the UI contract for the footer and the tab.
- `README.md`, `AGENTS.md` — the user-facing description and the counts.
- `docs/plans/2026-11-02-ai-answer-new-tab.md` — this record.

## Risks and rollback

The head is the one place this layout can run out of room: in the Changes view at
the 320 px minimum width the row measures 345 px against 296 px available
(`Answer` 37 + summary 111 + icon 26 + `Result│Changes` 103 + gaps). Let the head
wrap rather than clip, and check that combination in the suite; in the normal
Result view the row is 234 px and fits at every width.

`openAiDocument` mutates `savedContent` after `loadUntitled`, which also sets it;
the assignment order is the contract. If a future change makes `loadUntitled`
compute dirty state later, the baseline must stay empty or the tab will look
saved and lose the answer on a silent close.

No settings field, no persisted schema and no Rust command changes, so rollback
is this commit alone, with no migration. If the icon proves hard to find in use,
the fallback is the rejected five-button row above: one label change and one
deleted icon.

## Tests and validation

- `npm run ai:unit` — **136/136**. `answerLanguage` for convert with a valid
  target, an invalid or absent parameter, the same markup as the source, and
  every other action.
- `npm run ai` — the footer for each action type, `New tab` still enabled in the
  stale footer, the four destinations on one measured row, the header Regenerate
  re-issuing exactly one request, the new tab flow (tab count +1, active, dirty
  dot, the answer as the buffer, the original tab clean and without the answer,
  close asks and Discard removes it), the same route from a History detail,
  Convert making New tab primary and opening a Typst buffer, and the History row.
  Every check this plan adds passed in the runs below; see the note on the
  concurrent session.
- `npm run build`, `npm run lint`, `npm run format:check`, `npm run knip` — all
  clean.
- The measurement that proves it: `{"rows":1,"overflow":0,"inside":true}` for the
  rewrite footer at the 440 px panel, a generated tab whose `.doc-tab` carries
  `is-dirty` and whose buffer is the answer, and `view.typstDocument` checked for
  a Convert → Typst tab.

Run on 2026-11-02 against a disposable build with its own identifier
(`io.github.bernh.mdraft.aitest`), because the installed application was open:
`npm run ai:unit` 136/136, `npm run build`, `npm run lint`, `npm run format:check`
and `npm run knip` clean, and nine full `npm run ai` runs. The suite was 249/249
before the last check was added, and every check added here passed from run 5
onward.

Two deviations to record:

- Another session is editing this checkout at the same time (it committed this
  plan, rewrote a translation prompt in `src-tauri/src/ai/prompt.rs` and added an
  uncommitted "Typed parameters" block at the end of `scripts/ai-assistant-test.mjs`).
  That block is red in the final runs — it types into the translate field with
  CDP and the field does not always hold focus — and it is not part of this
  change. This plan alone takes the suite from 221 to 250; the four checks in
  that block are why `AGENTS.md` documents 254.
- Two fixes in the suite belong to this change even though the plan did not name
  them: `clickFooter`/`footerButtons` are now scoped to `.ai-panel`, because a
  History detail owns the same `.ai-footer-actions` class and sits earlier in the
  DOM, so "New tab" could click a remembered answer; and the palette-footer check
  trims its labels, which it must because those buttons carry an SVG icon and
  template whitespace (that check was already red before this work).

## Acceptance criteria

- Every answer that can be applied can also be opened in its own untitled tab,
  including while the source document is read-only or has changed since capture.
- `New tab` never modifies the source document and never closes over a stale
  target: it is not gated by `canApply()`'s `canWrite()`/`stale()` conditions.
- The new tab's language is the target markup for Convert and the source markup
  otherwise; the preview renders it accordingly.
- The new tab is dirty: the tab strip shows its dot, Ctrl+W asks, and the
  recovery journal holds the text.
- No action's footer exceeds the 416 px row at the default panel width; at the
  320 px minimum it wraps between the destinations and the clipboard.
- `Regenerate` is reachable from the answer head in every done state except Ask,
  its `title` and `aria-label` both read "Regenerate", and the error state keeps
  `Retry`.
- The checks added by this plan pass; the documented counts are 254 for
  `npm run ai` (29 of them from this plan, four from the concurrent block
  described below) and 136 for `npm run ai:unit`.

## Open questions

None. The reader chose "destinations only", an icon-only `Regenerate`, and
`New tab` as Convert markup's primary.
