# Word-level sync maps rendered text to source offsets at render time

**Status:** accepted
**Superseded in part by:** `2026-10-20-html-word-sync.md` (the HTML exclusion only)
**Date:** 2026-10-18

## Context

The panes synchronised at block granularity only. `annotatePreviewLines` writes
`data-line` on every top-level preview block by lexing the original markdown a
second time and zipping the token list against the rendered element list; nothing
inside a block was addressable. Selecting a word on either side produced no
correspondence on the other.

The feature needs one thing from a format: which characters of the source
produced a given text node. The four previews answer that very differently, and
the difference is structural, not a matter of effort.

- **Markdown** is rendered in this process by `marked`, whose `token.raw` is a
  literal slice of the text it lexed. Offsets are exact by construction.
- **AsciiDoc** is converted by `@asciidoctor/core`, whose AST carries
  `sourceLocation.lineno` and no column. Offsets have to be recovered inside the
  block's line range.
- **Typst** is compiled by the `typst` CLI in a subprocess, and its HTML export
  carries no positions at all; the existing block map is already a text
  heuristic.
- **HTML** is rendered by the browser inside an opaque-origin iframe. There are
  no positions to take, and the document's own scripts may mutate the DOM.

Measured on the 984 KB book in `docs/samples`, against `marked` 18: lexing costs
17.9 ms, walking the token tree for offsets adds 0.6 ms, and instrumenting the
common inline tokens produced about 2.5 k spans and 12% more HTML. The map is
built inside the render pass that is already debounced at 200 ms, so typing adds
no work.

## Decision

Word positions are **derived at render time in the webview and kept as data**,
not recovered by searching the rendered DOM later.

- Markdown emits one `<span data-f="N">` per text run, never per word. A fragment
  table of `{src0, src1, raw, kind}` is returned beside the HTML, with no DOM
  reference in it; `bindWordMap` links the table to the live text nodes after
  `innerHTML`.
- Code spans and mathematics are replaced by placeholders before `marked` sees
  the source. Each replacement records its prepared and original range; a
  fragment's offsets are translated back through that list, so an offset is
  never guessed.
- Preview → source reads `window.getSelection()`, which already names the text
  node and the offset: no hit-testing, no `caretRangeFromPoint`. Source →
  preview is a binary search over the fragment table to a `Range`.
- The preview is painted with the **CSS Custom Highlight API**
  (`CSS.highlights`), which mutates no DOM and triggers no layout. Wrapping
  ranges in `<mark>` was rejected: it splits text nodes, invalidates the map
  mid-interaction and forces a re-layout.
- The source is painted with a CodeMirror `StateField` and `Decoration.mark`,
  the mechanism `spellcheck.ts` already uses.
- **Decoration never takes the selection.** A selection in one pane paints the
  other; neither pane's selection, caret or focus moves. Steering the source
  selection to get `highlightSelectionMatches` for free would make the next
  keystroke destructive.
- **Selection never scrolls a pane.** A pointer gesture paints where it is; a
  double-click may reveal the block only when it is entirely off screen, the
  "reveal, not follow" rule the scroll sync already follows.
- Only the corresponding word is painted. Occurrences elsewhere are not.
- AsciiDoc uses **block records** instead of per-run fragments: the source range
  of each `data-line` element, plus a forward search for each text node inside
  it, folding the block's whitespace so a hard-wrapped paragraph compares as one
  line. A substitution, a typographic replacement or an include is not found and
  the block is abandoned for the rest of the walk rather than producing a range
  one word off.
- Typst and HTML are out of scope until they can supply positions. Typst would
  mean embedding the compiler, reversing the "not bundled" decision in
  `src-tauri/src/typst.rs`; HTML would mean a position-tracking parser, a
  structural path and a bridge, and would still degrade under the document's own
  scripts.

## Consequences

- Markdown pays about 12% more HTML and one DOM node per inline text run. The
  fragment table is rebuilt on every render and dies with the nodes; nothing
  persists between renders, tabs or documents.
- Any change to `protectInlineCode`, `extractMath` or the renderer must keep
  recording ranges. A missed substitution shifts every offset after it, so the
  block line computed from the prepared tree is compared with the line computed
  from the original tree in a test.
- The block anchors (`data-line`, `linesMapped`, scroll interpolation) are
  untouched and never fed by the word map; the two maps fail independently.
- AsciiDoc fidelity is bounded by what a search can find: prose and a macro's
  visible text work; attribute substitutions and included content do not, and
  the failure is a missing highlight rather than a wrong one.
- The feature depends on `Intl.Segmenter` and `CSS.highlights`. The first is
  present everywhere this app runs; the second is feature-detected, and where it
  is missing the block blink remains and no DOM-mutating substitute is attempted.
- A future format feeds the same module: an emitter produces fragments or block
  records, and the binding, both lookups, the word snapping and the painting are
  shared.
