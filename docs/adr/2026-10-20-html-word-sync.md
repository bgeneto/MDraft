# HTML word positions live in a host-side table built from the preview parse

**Status:** accepted
**Superseded in part by:** `2026-10-22-selection-highlighting.md` (validated multi-node selections, full entity boundaries, reverse highlighting and frame/focus lifetime).
**Date:** 2026-10-20
**Supersedes in part:** `2026-10-18-word-level-sync.md` (its HTML exclusion)

## Context

The HTML preview is an opaque-origin iframe. `buildHtmlPreview` already parses the
document with parse5 and `sourceCodeLocationInfo` to splice line anchors and the
bridge, then serves a copy. It never reserialises: a DOM round trip can normalise
quotes, escape script text and reorder malformed markup.

A click in the guest therefore had only a line number. The source mark stopped at
block granularity, while Markdown, AsciiDoc and Typst already mapped words. Making
the behaviour equal needed word positions, and the two obvious routes are both
wrong: injecting `<span>`s into the preview changes the user's document and its
selectors; searching the source for the selected word marks the first occurrence,
not the clicked one.

## Decision

The host records a table while it walks the parse5 tree. For every stamped block
element it splices a preview-only `data-mdraft-n` id, and for every text node under
that element it records the source offsets, the text-node index, and the decoded
text. The table is rebuilt with the preview copy and is never sent to the guest.

The bridge reports `{ n, index, start, end, sample }` on a double-click or a
settled drag. Those are offsets inside one text node — the guest's DOM node, not a
source offset. The host resolves the entry, checks that the recorded decoded text
still matches `sample` at those offsets, and converts the decoded offsets back to
source offsets. A mismatch paints no word and keeps the existing line reveal.

No span is injected, no source search is attempted, and nothing is written back to
the file. The single click keeps its current line reveal and block blink.

## Consequences

- HTML gains word-level preview → source sync without a new dependency, because
  the parse and the walk already existed. The table costs memory proportional to
  the preview's text and is built once per render, not per keystroke.
- A document whose own scripts rewrite the marked DOM fails the sample check and
  degrades to the line reveal. That is deliberate: a wrong word is worse than no
  word.
- A parser repair that splits or merges text nodes differently from parse5's tree
  also fails the check. The failure is the old behaviour, not a wrong mark.
- Source → HTML-guest highlighting remains out of scope. It would need the same
  table in the other direction and a paint inside the guest, which is a larger
  change than the source mark this decision serves.
