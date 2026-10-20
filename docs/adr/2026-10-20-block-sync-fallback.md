# Block-mapped previews align words per node and fall back to the containing block

**Status:** accepted
**Date:** 2026-10-20
**Supersedes in part:** `2026-10-18-word-level-sync.md` (its block-abandonment rule and Typst Document exclusion)

## Context

`2026-10-18-word-level-sync.md` gave AsciiDoc — and later Typst Document — a
block-record path: each anchored `[data-line]` element receives a `data-b`
source range (`src0..src1`), and `blockLayout` locates each DOM `Text` node
inside that range by folding whitespace runs and running `plain.indexOf`. When
any `Text` node in a block failed to match as a whole substring, `blockLayout`
set `layout.failed = true` and abandoned the rest of the block; when a selection
landed on unmapped content, `sourceRangeFor` returned `null` and nothing was
painted.

In practice, whole-node substring matching and silent abandonment fail on
ordinary Typst Document and AsciiDoc prose:

- A single inline formula (`<math>` in Typst, `.katex` in AsciiDoc), footnote
  reference (`<sup role="doc-noteref">`), or admonition icon cell
  (`.admonitionblock td.icon`) inside a block caused `plain.indexOf` to return
  `-1` and killed every word after it.
- An internal substitution (`{atributo}` in AsciiDoc), typographic replacement
  (`'` → `’`, `--` → `—`, `...` → `…`), generated heading or caption prefix
  (`1.1 Lists`, `Table 1:`), or stripped inline call (`#text(...)[...]`) lives
  inside the **same** DOM `Text` node as the surrounding prose, so whole-node
  `indexOf` failed on the entire paragraph.
- `entry.src0 + start` added a raw DOM offset to a whitespace-folded source
  start, drifting backwards by the width of every collapsed newline and
  indentation run.
- When a selection sat inside genuinely unmapped content (a formula or attribute
  expansion), leaving `.cm-sync-word` empty while `mousedown` moved the caret to
  the block's start line made the editor highlight only the first line of the
  block (or line 1 when the block itself failed to anchor).

## Decision

Block-mapped previews (`[data-b]` in AsciiDoc and Typst Document) use a two-tier
per-node alignment bounded strictly to `block.src0..block.src1`, and fall back
to the containing block when a selection inside an anchored block covers no
mapped word:

1. **Non-prose subtrees do not enter `blockLayout`.** `bindWordMap` links every
   `Text` node inside `[data-b]` to its innermost block index (`record.block`),
   but `map.blockNodes[index]` skips descendant `[data-b]` elements and
   non-prose subtrees (`math`, `.math-inline`, `.math-display`, `.katex`,
   `[data-stem]`, `sup[role="doc-noteref"]`, `sup[role="doc-backlink"]`,
   `.admonitionblock td.icon`).
2. **Offsets translate through folded tables (`rawNodeOffsetToSource` and
   `sourceOffsetToRawNode`).** `foldWhitespace` normalizes 1-to-1 typographic
   quotes and collapses whitespace runs while recording `at: number[]` on both
   the DOM text and the block source. Offsets are mapped through both `at`
   tables rather than added as raw character deltas.
3. **Whole-node match first, sub-node word-run alignment second, never block
   abandonment.** When a `Text` node does not match as a single substring of the
   remaining folded block source, `blockLayout` aligns the node's word tokens in
   order against the remaining source words in the block, merging contiguous
   runs into `BlockNodeSpan`s and skipping only the unmatched tokens (such as an
   attribute expansion or generated number prefix). A jump over skipped source
   words is accepted only when it does not bypass a closer match for the next
   DOM word. A node that yields zero spans leaves the block cursor in place so
   subsequent `Text` nodes in the block still map.
4. **Block fallback in both directions.** When a selection in the preview sits
   inside an anchored `[data-b]` block (for example, inside an inline formula or
   on a substituted attribute value) and overlaps no `BlockNodeSpan`,
   `sourceFromPreviewSelection` falls back to `blockRangeForNode` (the
   containing block's `src0..src1`, snapped to word boundaries). Conversely, a
   source selection inside an anchored block that covers only inline markup or
   unmapped tokens resolves to the nearest mapped span or the block's DOM text
   bounds. Unanchored blocks (such as `#lorem` in Typst or `include::` in
   AsciiDoc) carry no `data-b` and continue to paint nothing.

## Consequences

- Words before and after an `{attribute}` substitution, inline formula, footnote,
  smart punctuation, or generated prefix map to their exact source words.
- Selecting inside an inline formula or substituted attribute value in an
  anchored paragraph marks the containing paragraph rather than leaving the
  editor with no `.cm-sync-word` mark.
- Word searches remain strictly bounded to `block.src0..block.src1`; no
  document-wide word search is ever performed, and unanchored generated or
  included blocks still paint nothing.
