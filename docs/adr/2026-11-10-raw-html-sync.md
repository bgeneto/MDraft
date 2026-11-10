# Raw HTML text is a Markdown fragment, and element lines come from the rendered tree

**Status:** accepted
**Date:** 2026-11-10

## Context

A raw HTML block in a Markdown document is not one Markdown token. Marked emits
the opening tag, the Markdown inside it and the closing tag separately. In
`docs/samples/SEI_15117522_Memorando_Circular_00035_2026.md`, two `<div>` blocks
therefore produced 77 token lines but only 73 top-level preview elements. The
line-anchor zip required an exact count, so it dropped every `data-line` in the
document. `previewLinesMapped` became false and scroll sync, preview-click reveal
and the block blink all stopped for the whole file.

The same document also showed the second half of the gap: marked passes raw HTML
through untouched, so text inside `<table>` cells had no `data-f` fragment. A
double-click on `Modalidade` painted nothing, and a source selection of that word
produced no preview range. An offset inside the raw table markup snapped to the
next fragment and painted the paragraph *after* the table.

## Decision

Raw HTML that Markdown already renders uses the same source-map primitives as
Markdown text:

1. **Visible text nodes in a block-level raw HTML token are `data-f` text
   fragments.** `parse5` supplies their exact offsets in the token; the renderer
   wraps each raw text run in the existing fragment span and records a normal
   `Fragment { src0, src1, raw, kind: "text" }`. Script, style, textarea, title,
   noscript, template, form-option and foreign-content (SVG/MathML) text is
   skipped. Code and math placeholders stay untouched and are restored later.
2. **Line anchors may come from rendered elements instead of token order.**
   When `hasRawHtml` is true, `renderChunks` parses the joined chunks with
   `parse5`, finds each top-level element's opening tag, and reports the source
   line of the chunk that contains it as `elementLines`. `finishPreview` uses
   that list only when the token list does not match `host.children`; otherwise
   the existing exact zip is unchanged. Any missing source location or count
   disagreement drops the annotation, as before.
3. **A fragment-gap lookup never crosses a source line.** `pointForSource` may
   still snap a selection on Markdown syntax to a word later on the same line.
   If the next fragment begins on another line, the offset is unmapped and the
   callers paint nothing rather than a different block.

The two maps remain independent: a failure to build fragments does not remove
line anchors, and a failure to derive element lines does not disable word sync.

## Consequences

- Cross-token raw HTML no longer disables positional sync. The reported sample
  now has 73 anchors for 73 top-level elements, and the table's cell words are
  ordinary fragments in both directions.
- Raw HTML visible text gains one preview-only inline span per text run, the
  same cost Markdown text already pays. Tags, attributes, sanitization and table
  structure are unchanged; a selector that assumes a raw element has only text
  children could notice the span.
- `parse5` is now imported by the Markdown preview worker. It was already a
  dependency for the HTML preview and its source map; no new package is added.
  The line pass runs only for documents that contain raw HTML and is measured by
  the over-1-MiB raw HTML preview test.
- Foreign content, scripts and styles remain unmapped. A source selection there
  paints nothing; it must not be silently attributed to the next Markdown block.
- A future renderer that emits raw HTML must keep the token's source range exact,
  because both the fragment offsets and the element lines are derived from it.
