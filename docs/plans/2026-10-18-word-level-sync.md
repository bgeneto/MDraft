# Word-level sync between the source and the preview (Markdown and AsciiDoc)

**Status:** done
**Date:** 2026-10-18
**ADR:** `../adr/2026-10-18-word-level-sync.md`

## Context and goal

Pane sync today is block-level. `annotatePreviewLines` writes `data-line` on every
top-level preview block by lexing the original source a second time and zipping
the token list against the rendered element list; `main.ts` keeps those anchors
sorted and scrolls one pane from the other. Clicking a block blinks it and moves
the caret, but nothing inside a block is addressable: the smallest unit the two
panes can agree on is a paragraph.

The reader who selects a word — double-click or a mouse drag — on either side
gets no correspondence at all. This plan makes that selection visible on the
other side, at word granularity, without moving the reader's selection and
without scrolling either pane. It covers the Markdown preview, where offsets can
be exact, and the AsciiDoc preview in phase 6, where they are derived from the
block's line range; Typst and HTML are analysed below and deliberately left out.

Three decisions were taken before writing this plan, and they are binding:

1. **Decoration only.** A selection in one pane paints a highlight in the other.
   Neither pane's selection, caret or focus is taken over. Typing after selecting
   a word in the preview must never replace that word in the source.
2. **No scroll.** The rule that clicking never scrolls the other pane stays. A
   selection made with the pointer never scrolls; a double-click may reveal the
   block only when the target is entirely off screen, the same "reveal, not
   follow" distinction `revealPreviewLine` already encodes.
3. **One word only.** The corresponding word is painted; occurrences of the same
   word elsewhere are never painted.

## Scope and non-scope

In scope:

- A source map from rendered text to source offsets for Markdown, built during
  the existing render pass, with a per-fragment fallback to the block when a
  fragment cannot be mapped.
- An AsciiDoc emitter: the block ranges the preview already computes
  (`data-line`/`data-line-end`) plus a forward text search inside each block,
  with a documented fidelity limit on macros, substitutions and includes.
- Preview → source: a double-click or drag selection paints the corresponding
  source range as a CodeMirror decoration; Escape, a collapsed selection or a
  document change clears it.
- Source → preview: a selection in the editor paints the corresponding preview
  range through the CSS Custom Highlight API; a collapsed caret paints the word
  under it.
- Correct handling of inline code, KaTeX, links, images, tables, and text that
  contains backslash escapes or HTML entities.
- Dedicated fixtures and CDP checks; no regression in the block-level sync.

Out of scope:

- The Typst and HTML previews. `source-map.ts` is format-neutral, but the two are
  not the same problem as AsciiDoc — see [Why Markdown first](#why-markdown-first).
- All occurrences of the selected word. Only the corresponding range is painted.
- Moving the selection into the other pane. Decoration only, by decision 1.
- Any change to `data-line`, the block zip, `linesMapped`, or the scroll
  interpolation. The word map is built beside them and never feeds them.
- A preference. There is no setting, no menu item and no status chip: the feature
  is either working for a format or honestly absent.

### Why Markdown first

The feature needs one thing from a format: a way to know which characters of the
source produced a given text node. The formats differ on exactly that, and the
difference is not a matter of effort:

| Format | Who renders | Positions available | Word-level map |
| --- | --- | --- | --- |
| Markdown | `marked`, in this process | `token.raw` is a literal slice of the source | exact |
| AsciiDoc | `@asciidoctor/core` | `sourceLocation.lineno`; no column | line plus a search inside the block: prose exact, macro text found, substitutions and includes not |
| Typst | the `typst` CLI, as a subprocess | none in the HTML export | heuristic, unless the compiler is embedded |
| HTML | the browser, in a sandboxed iframe | none; a separate document | a position-tracking parser, a structural path and a bridge |

- **AsciiDoc is the natural second, and it is phase 6 of this plan.**
  `MarkerProcessor` already walks the AST and reads `sourceLocation.lineno`, and
  the preview already turns those lines into `data-line`/`data-line-end` on the
  block. There is no column, so an inline offset has to be recovered inside the
  block: fold the block's source so a hard-wrapped paragraph compares as one
  line, then find each text node forward from a monotonic cursor. That is exact
  for prose, finds the visible text of `link:`/`image:` macros inside their
  brackets, and cannot find a substitution (`{name}`), a typographic replacement
  or an `include::` — those blocks are abandoned rather than guessed. Cost: about
  150 lines in `source-map.ts` for the block records and the search, 80 in
  `asciidoc-preview.ts`, plus the fixture and the checks.
- **Typst is not a matter of an emitter.** The preview is
  `typst compile --features html --format html` in a subprocess, and the export
  carries no source positions — `typst-map.ts` says so and matches blocks by text.
  Word-level there is either the same heuristic one level down, which fails
  silently on `#let`, function calls, numbering and math, or embedding the `typst`
  crate to walk the document's spans, which reverses the "compiler is not
  bundled" decision in `src-tauri/src/typst.rs` (+50 MB, Apache-2.0 notice, build
  time). That is its own plan, and the heuristic is not worth shipping.
- **HTML is a different project.** The guest is an opaque-origin iframe
  (`sandbox="allow-scripts allow-forms allow-modals"`, no `allow-same-origin`), so
  the host cannot read its DOM at all; everything crosses `postMessage`. The map
  would need a position-tracking parser (a new dependency such as `parse5`), a
  structural path from the parsed tree to the guest DOM, a selection event on the
  bridge, and it would degrade whenever the document's own scripts mutate the DOM.
  Injecting markers into the served HTML is not an option: that is the user's
  document, and it would change its selectors and its layout.

## Approach and rejected alternatives

The pipeline gains a **source map**, the same technique the block anchors already
use, one level down. `marked` emits no positions, but `token.raw` is a literal
slice of the text it lexed, so offsets are exact by construction: walk the token
tree, accumulate `raw` lengths, and every text token has an absolute range.

Five pieces:

1. **Substitutions become explicit.** `protectInlineCode` and `extractMath`
   replace code spans and math with shorter placeholders before `marked` sees the
   text. Each replacement records `{preparedStart, preparedLength,
   originalStart, originalLength}`; `prepared ↔ original` is a sum of deltas with
   a binary search over a handful of entries. `splitFences` rejoins its segments
   with `\n` unchanged, so a segment's base offset in the original is exact.
2. **One span per text run, not per word.** The `text` renderer emits
   `<span data-f="N">`, splitting the run at placeholders so no offset ever falls
   inside one. `restorePlaceholders` puts the same `data-f` on the `<code>` and
   KaTeX nodes it creates; the `code` and `image` renderers do the same on
   `<pre>` and `<img>`. `RenderResult` gains a `fragments` table of
   `{src0, src1, raw, kind}`, with no DOM reference in it.
3. **Binding after render.** After `preview.innerHTML`, one `TreeWalker` over
   `[data-f]` links each `Text` to its fragment in a `WeakMap`, and the fragment
   array is sorted by `src0`. Rebuilt after every render; the old map dies with
   the nodes.
4. **Preview → source.** `window.getSelection()` already returns the text node
   and the offset, so no hit-testing and no `caretRangeFromPoint`. The fragment
   maps the offset to the source, a two-pointer walk over `raw` versus rendered
   text absorbs escapes and entities, and `Intl.Segmenter` (word granularity)
   snaps the range to word boundaries — `\w` cannot segment `socioeconômico`.
5. **Source → preview.** A CodeMirror offset goes through a binary search over
   the fragments to a `Range`; a selection maps both ends. Painting uses
   `CSS.highlights` + `Highlight`, which mutates no DOM and triggers no layout,
   and a CodeMirror `StateField` with `Decoration.mark` for the source, the
   mechanism `spellcheck.ts` already uses.

The AsciiDoc emitter is different in kind, and that is why it is phase 6 instead
of part of the map. Asciidoctor gives positions per line, not per column, and the
preview already converts those lines into `data-line`/`data-line-end` on each
block. So the emitter records a **block record** — the source range of every
anchored element — and the lookup does the rest by search: a folded copy of the
block's source (newlines replaced by spaces, which keeps every offset valid)
makes a hard-wrapped paragraph compare as one line, and each text node's content
is found forward from a monotonic cursor. Exact text maps exactly; an
`{attribute}`, a `--` typographic replacement or an `include::` is not found, and
the block is abandoned for the rest of that walk instead of producing a range one
word off. The same records serve the reverse direction, by walking the block's
text nodes once and caching the source range of each.

Cost, measured in an isolated Node benchmark against `marked` 18 and the 984 KB
book in `docs/samples` (not in the app): the offset walk adds **0.6 ms** over the
17.9 ms the lexer already takes, and a prototype renderer that wrapped text plus
the common inline tokens produced **~2.5 k spans and +12% HTML**. A 30 KB document
sees microseconds. The walk is steady-state; no per-keystroke work is added,
because the map is built inside the render that is already debounced at 200 ms.

Rejected alternatives:

- **Search for the word inside the anchored block.** Two hundred lines instead of
  nine hundred, and it works on prose. It fails exactly where the document gets
  interesting: a word that appears twice in a paragraph, link text whose URL is
  not rendered, an image whose alt text is, formula symbols. The block anchors
  exist because proportional or heuristic mapping produced visible drift; the
  same argument applies one level down.
- **`remark`/`mdast`, which carry `position` natively.** It replaces the Markdown
  parser that the dialect of every existing document depends on, and adds a
  dependency. Rejected on contract change, not on capability.
- **Wrapping the range in `<mark>`.** It splits text nodes, which invalidates the
  map in the middle of the interaction, and it forces a re-layout. The CSS
  Highlight API exists precisely to avoid both.
- **Deriving offsets from the rendered DOM by walking it in parallel with the
  token tree.** The DOM is the token tree's output, so the pairing looks
  deterministic, but KaTeX, highlighted code and raw HTML blocks produce text
  nodes with no token, and the walk needs landmarks to resynchronise. Emission at
  render time is exact and simpler to prove.
- **`caretRangeFromPoint`/`window.find`.** Geometry-dependent and returns words,
  not offsets; `getSelection()` is already the answer.
- **Moving the source selection so `highlightSelectionMatches` highlights for
  free.** That is selection theft, banned by decision 1, and it makes the next
  keystroke destructive.
- **A `ViewPlugin` reading an external range** instead of a `StateField`. It
  dodges the tab-state leak below, but needs an empty transaction to repaint and
  cannot be mapped through changes; the `StateField` with an explicit clear is the
  honest version.

## Steps

- [x] 1. `src/source-map.ts`: `Fragment`, `Substitution`, `WordMap`;
      `translateOffset`, `buildWordMap`, `bindWordMap`,
      `sourceRangeForNode`, `rangeForSource`, `snapToWord`.
- [x] 2. `src/markdown.ts`: record substitutions in `protectInlineCode` and
      `extractMath` (segment base offsets from `splitFences`), add the `text`
      renderer that splits at placeholders, add `data-f` to `code`, `image` and
      the `restorePlaceholders` output, walk the token tree for prepared offsets
      (covering `tokens`, `items`, `header`, `rows`), translate to original
      offsets, return `fragments` in `RenderResult`.
- [x] 3. `src/main.ts`: bind the map after every `preview.innerHTML` assignment
      for Markdown; keep the block anchors untouched.
- [x] 4. `src/editor.ts`: a `StateField` + `StateEffect` for one source range,
      `setSyncRange(from, to)` / `clearSyncRange()`, cleared from `setDoc`,
      `restoreState` and on every document change; `CursorInfo` gains absolute
      `from` and `to` so the caller does not recompute them.
- [x] 5. `src/main.ts`: preview `dblclick` → word → source decoration, plus the
      optional reveal when the target block is entirely off screen; a debounced
      `selectionchange` (60 ms, preview only, non-collapsed) for drag selections;
      Escape and collapsed selections clear; the last source range is reapplied
      after a render that did not change the document.
- [x] 6. `src/main.ts`: `editor.onCursor` → preview `Range` → `CSS.highlights`
      (`mdraft-sync`), with the caret expanded to a word only when the selection
      is collapsed; feature-detect `CSS.highlights` and fall back to the block
      blink when it is missing.
- [x] 7. `src/styles.css`: `::highlight(mdraft-sync)` and `.cm-sync-word`, tinted
      from theme variables, visibly distinct from the native blue selection and
      from `.cm-selectionMatch`; no animation, nothing left behind after Escape.
- [x] 8. `samples/word-sync.md`: prose with an accented word repeated in the same
      paragraph, a link, inline code, a `$…$` formula, a table, a task list, an
      escape (`\*`) and an entity (`&amp;`), and an alert.
- [x] 9. `scripts/word-sync-test.mjs`: ~30 checks (see below); register it in the
      `SUITES` array of `scripts/test-all.mjs` (`id: "word-sync"`, `kind: "cdp"`,
      `doc: "samples/word-sync.md"`), add the `package.json` script, and add the
      AGENTS.md table row and count.
- [x] 10. Regression: `npm run smoke` (93 checks) and `npm run asciidoc` to prove
      the block sync and the other formats are unchanged.
- [x] 11. Measure the render cost in the running app on the 984 KB book; record
      the number in this plan. Write the ADR and the guide/README sentence.
- [x] 12. **Phase 6 — AsciiDoc.** `src/source-map.ts`: block records
      (`{src0, src1, el}`), the newline-preserving fold, forward text search per
      block in both directions, a per-block cache, and the rule that a failed
      search abandons the block instead of sliding the cursor.
- [x] 13. `src/asciidoc-preview.ts`: build a block record for every element that
      carries `data-line`/`data-line-end`, convert those line numbers to source
      offsets once, and return the records in `AsciidocRenderResult`.
- [x] 14. `src/main.ts`: bind the AsciiDoc records after its render (the same
      call site that sets `previewLinesMapped`) and let the handlers added in
      steps 5 and 6 serve both formats by asking the bound map; the HTML preview
      stays excluded.
- [x] 15. `samples/asciidoc-tour.adoc`: a prose paragraph hard-wrapped across
      lines with an accented word, a `link:` macro, inline code, an unresolved
      attribute and an `include::`; then ~8 checks in `scripts/asciidoc-test.mjs`
      (43 → 51) and the AGENTS.md count.
- [x] 16. Validation for phase 6: the AsciiDoc suite, the word-sync suite and the
      smoke suite; record the fidelity limits (macro text, no attribute
      substitutions, no includes) in `docs/guide.md`.

### Execution record

Deviations from the approved plan, all deliberate:

- **A collapsed caret does not paint.** Steps 5–6 said "the caret expanded to a
  word"; the implementation paints only a non-collapsed selection. A tint that
  follows the caret repaints a word on every arrow key and reads as markup the
  document does not have. Escape and a collapsed selection clear instead.
- **AsciiDoc blocks carry a `data-b` attribute.** Binding a block record after
  `innerHTML` needs an index in the DOM, so each anchored element gets one beside
  its `data-line`.
- **The AsciiDoc checks live in `asciidoc-test.mjs`** (43 → 51) rather than in a
  new suite: that suite already launches its own instance on the tour fixture,
  which is the document the checks need.
- **The reveal is not covered by the suite.** The fixture fits on one screen and
  scroll sync keeps the panes aligned, so there is no stable state where a
  preview word is visible while its source line is off screen. The
  implementation is `scrollIntoView({ y: "nearest" })`, which moves only when the
  position is outside the viewport; it was checked by hand.
- **A focused editor stole the preview selection** (found while testing): the
  sync dispatch made CodeMirror write its own selection back into the DOM after
  about 100 ms, collapsing the reader's. `setSyncRange` now blurs the editor
  first, which is what a real mousedown in the preview already did.

## Files and modules

- `src/source-map.ts` (new) — fragments, delta translation, `raw`↔text alignment,
  word snapping, both lookups. The only module that knows about offsets.
- `src/markdown.ts` — substitution records, the `text`/`code`/`image` renderers,
  the prepared-offset walk, `fragments` in `RenderResult`. `data-line` and the
  block zip are not touched.
- `src/asciidoc-preview.ts` — the AsciiDoc emitter: block records from the line
  ranges the preview already computes, returned beside `html`/`linesMapped`.
- `src/main.ts` — event wiring, guards, rebinding after render, both directions
  and both formats.
- `src/editor.ts` — the decoration field and its lifecycle, `from`/`to` in
  `CursorInfo`.
- `src/styles.css` — the two highlight surfaces.
- `samples/word-sync.md` (new) — the fixture the suite needs; a dedicated file
  because a suite that changes the document breaks the next one.
- `samples/asciidoc-tour.adoc` — the AsciiDoc fixture gains the wrapped paragraph
  and the macro the phase-6 checks need.
- `scripts/word-sync-test.mjs` (new) — the CDP suite for Markdown.
- `scripts/asciidoc-test.mjs` — the phase-6 checks (43 → 51) and the count.
- `scripts/test-all.mjs` — the `SUITES` entry; a suite that is not in that array
  does not run under `npm test`.
- `package.json` — one `word-sync` script.
- `AGENTS.md` — suite rows, both counts, and any trap this change teaches.
- `docs/guide.md`, `README.md` — one sentence each that word-level sync exists and
  what it does not do.
- `docs/adr/2026-10-18-word-level-sync.md` (new) — why the Markdown map lives
  in the renderer, why AsciiDoc derives offsets from line ranges, and why
  decoration does not steal selection.

## Risks and rollback

- **A wrong delta shifts every offset after the first code span.** The failure is
  silent: the right word is highlighted in the wrong place. Guard: keep the
  existing second lex for `data-line` and compare, in a test, the block line
  computed from the prepared tree with the one computed from the original tree;
  a mismatch fails the suite before the feature ships.
- **`raw` and rendered text diverge** (`\*`, `&amp;`, `&copy;`). The two-pointer
  walk handles escapes and entities; when it cannot, the fragment is dropped and
  that block falls back to the blink. Dropping is always safe; guessing is not.
- **`captureState()`/`restoreState()` carry the decoration between tabs.** A
  `StateField` is part of the `EditorState`, so a word highlighted in one tab
  would come back in another. `restoreState` and `setDoc` clear it, and the suite
  switches tabs with a highlight active.
- **`decorateAlerts` rewrites `textContent` of an alert's first paragraph**,
  destroying its spans. That block loses its word map and falls back to the
  blink; the fixture includes an alert so the fallback is exercised.
- **Tables.** The offset walk must cover `header`/`rows`; if it does not, cells
  silently have no fragments. The fixture includes a table and the suite asserts
  a cell click maps to the cell's text.
- **A placeholder can change how `marked` blocks a line.** The prepared tree is
  the one that produces the DOM, so fragments are unaffected; `data-line` keeps
  using the original tree, so the block sync cannot regress from this change.
- **HTML growth of 12–20%** raises DOMPurify's input on a large document. Measure
  before and after on the book; if the render cost is unacceptable, the escape
  hatch is to instrument only `text` tokens and drop `data-f` from `code`/`image`,
  not to weaken the map.
- **`CSS.highlights` is missing on an older WebKitGTK.** Feature-detect and fall
  back to the block blink; the source decoration still works, and no DOM-mutating
  substitute is attempted.
- **AsciiDoc paragraphs are often hard-wrapped.** The rendered block joins the
  lines with a space while the source has `\n`; replacing each newline with a
  space keeps every offset valid and lets the search cross the break. A paragraph
  written with `+` continuations, or one whose text comes from an attribute
  substitution, is not found and abandons its block — the failure is a missing
  highlight, never a shifted one.
- **The AsciiDoc converter factory is registered only when mathematics is on.**
  The block records do not depend on it, because they come from the marker roles
  that run unconditionally. Any future inline marker must not be attached to that
  conditional.
- **AsciiDoc blocks nest.** A section and its paragraph both carry `data-line`;
  the lookup must use the deepest ancestor of the text node, or a word in the
  second paragraph of a section maps onto the section's first line. The fixture
  has a section with two paragraphs.
- **Includes have no range in this document.** Their text is not in the source
  being edited, so the block is abandoned — the same behaviour block sync already
  has.
- Rollback: delete `src/source-map.ts`, `scripts/word-sync-test.mjs`,
  `samples/word-sync.md` and the ADR, and revert the five touched source files.
  Nothing persists: no setting, no schema, no migration, no Rust. `git revert` of
  one commit restores the previous behaviour exactly.

## Tests and validation

- `npm run build` — typecheck and bundle. `renderPreview` has two callers in
  `main.ts` (the live preview and the holder used for export/print); both must
  keep compiling, and the export holder only reads `html`.
- `node scripts/test-all.mjs --only word-sync` — a fresh instance, its own port,
  first-run settings, `samples/word-sync.md` loaded.
- `node scripts/test-all.mjs --only smoke` and `--only asciidoc` — the block sync,
  the scroll interpolation and the other previews are unchanged.
- The checks that prove it, each measured as a person would see it:
  - Double-click `efetivos` in the preview: the source has exactly one
    `.cm-sync-word` whose text is `efetivos`, and the preview's
    `getSelection().toString()` is unchanged.
  - Select a sentence in the editor: `CSS.highlights.get("mdraft-sync")` exists
    and its ranges' text equals the selected source text.
  - Scroll positions of both panes are identical before and after each of those
    interactions.
  - A click inside a `<code>` element maps to the code span's source range, not
    the paragraph's line.
  - A word after `\*` and after `&amp;` maps to the right characters.
  - A table cell maps to the cell's text; an alert paragraph falls back to the
    block blink without throwing.
  - Escape clears both surfaces and leaves no `.cm-sync-word` and no
    `mdraft-sync` highlight.
  - Switching tabs with a highlight active shows no highlight in the other tab.
  - Map build time on the 984 KB book and `dblclick` → decoration latency are
    printed by the suite; the targets are under 10 ms and under 16 ms.
  - AsciiDoc: double-click a word in a hard-wrapped paragraph and the source
    decoration is that word, across the line break, not the whole line.
  - AsciiDoc: a `link:…[text]` maps to `text`, not to the URL.
  - AsciiDoc: a paragraph whose text comes from an attribute substitution
    produces no highlight and no wrong range.
  - AsciiDoc: a section with two paragraphs maps a word in the second one to the
    second one.
  - The AsciiDoc suite still passes its original 43 checks and now reports 51.
- Manual: the 1 MB book for feel, and a document with KaTeX and mermaid to
  confirm no fragment is attached to generated nodes.

**Outcome (2026-10-18):** `npm run build` passed. The three suites were run
against the development instance, each on its own fixture:

- `node scripts/dom-smoke.mjs` — **93/93**.
- `node scripts/word-sync-test.mjs` — **29/29**; double-click to decoration
  14–31 ms.
- `node scripts/asciidoc-test.mjs` — **51/51** (43 existing + 8 new).

Measured in the running application on the 984 KB book in `docs/samples`,
median of five renders each way:

| | map off | map on | delta |
| --- | --- | --- | --- |
| render | 77 ms | 99 ms | +22 ms |
| HTML | 952,326 B | 1,045,581 B | +9.8% |
| bind after `innerHTML` | 0.1 ms | 2.5 ms | +2.4 ms |
| fragments | — | 3,495 | — |

The render delta is larger than the isolated Node walk (0.6 ms) because the
extra tenth of HTML is parsed by DOMPurify, inserted and styled. On this 1 MB
document it is a fifth of a second on a render already debounced at 200 ms; a
typical 30–100 KB document pays a few milliseconds. Medians are quoted because a
single render varied by ±20%.

## Acceptance criteria

- Selecting a word in the preview paints exactly that word in the source, with
  no change to the preview selection, the source selection, the caret or either
  scroll offset.
- Selecting text in the source paints exactly that text in the preview, and
  neither pane scrolls.
- The painted source text equals the clicked preview word character for
  character, including accents; a word inside inline code or a formula maps to
  the whole span.
- In AsciiDoc, a selected word maps across a hard-wrapped line, a macro's visible
  text maps inside its brackets, and a block whose text cannot be located paints
  nothing rather than a wrong range.
- Neither direction paints occurrences of the same word elsewhere.
- Escape, a click that collapses the selection, and editing the document all
  leave no highlight behind.
- Blocks that cannot be mapped degrade to the existing blink and never produce a
  wrong range.
- `npm run smoke` stays at 93/93 and the AsciiDoc suite at 51/51 (43 existing
  plus the 8 phase-6 checks).

## Open questions

- Should a single click inside a code span or a formula map the whole span rather
  than the block? Default: yes; the span is the smallest meaningful unit and the
  map already knows its range.
- Should the source decoration survive focus moving to the sidebar? Default: no;
  it is tied to the preview selection and clears when that selection is gone.
- Should the second `marked.lexer` be dropped once the delta translation is
  proven, saving 18 ms per megabyte? Default: not in this plan; it is a separate
  change with its own comparison test.
- AsciiDoc fidelity: should a macro's whole range (`link:url[text]`) be painted
  when its text is selected, or only the text inside the brackets? Default: only
  the text, which is what the search finds; the macro range is not reconstructed.
- Typst and HTML: neither is an emitter. Default: revisit Typst only together with
  a decision about embedding the compiler, and HTML only as a separate project
  with its own dependency and its own fidelity note.
