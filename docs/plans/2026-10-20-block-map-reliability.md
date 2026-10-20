# Reliable block-level word sync for AsciiDoc and Typst Document

**Status:** done
**Date:** 2026-10-20
**ADR:** `../adr/2026-10-20-block-sync-fallback.md` (new; written in step 1)

## Context and goal

A preview selection in **Typst Document** or **AsciiDoc** frequently leaves the
source with no golden mark (`.cm-sync-word`) at all. When the block has a
`data-line` anchor, the `mousedown` handler moves the editor's caret to the
block's first line; when the block failed to anchor, the caret stays on line 1
where the file opened. In both cases the editor's `.cm-activeLine` tint sits on
line 1 or on the block's first line with no word highlight, which reads as "the
first line is selected instead of the corresponding line". Typst **Pages** works
because it has a separate line-and-word token map (`src/typst-page-map.ts`) and
its single click explicitly highlights the paragraph; Markdown works because
`marked` emits exact per-run fragments (`[data-f]`).

Inspection of the code and the live HTML produced by `typst compile --features
html --format html` (Typst 0.15.1) and `@asciidoctor/core` shows that the
block-record path shared by **Typst Document** and **AsciiDoc** fails in seven
concrete, reproducible ways:

1. **`blockLayout` abandons the rest of a block on the first unmatched DOM `Text`
   node (`src/source-map.ts:380-396`).**
   `blockLayout` runs `plain.indexOf(folded.plain, cursor)` and on `found < 0`
   sets `layout.failed = true; break;`. A single inline formula (`<math>` in
   Typst, `.katex` / `.math-inline` in AsciiDoc), a footnote superscript
   (`<sup role="doc-noteref">1</sup>`), or an admonition icon label
   (`<td class="icon"><div class="title">Note</div></td>` vs `NOTE:` in source)
   causes `found < 0` and kills every word after it in the block (or the entire
   admonition).
2. **`blockRangeFor` and `pointForSource` mix folded and unfolded offsets
   (`src/source-map.ts:391-394, 443-444, 553-554`).**
   The node's text is located in a whitespace-folded block
   (`foldWhitespace(raw)`), which builds `at: number[]` mapping each folded
   index back to `raw`. However, `blockLayout` only stores
   `entry.src0 = block.src0 + at[found]`, and `blockRangeFor` returns
   `entry.src0 + start`, where `start` is an offset in the **unfolded**
   `node.data`. In a hard-wrapped paragraph with indentation or repeated spaces
   (e.g. inside a list item, `#block[...]`, or indented prose), each collapsed
   run shifts `entry.src0 + start` backwards by the collapsed width; `pointForSource`
   has the inverse drift (`offset - entry.src0`).
3. **Whole-`Text`-node substring matching (`plain.indexOf(folded.plain, cursor)`)
   fails whenever a single DOM `Text` node contains an internal substitution,
   typographic replacement, generated prefix, or stripped inline wrapper.**
   Simply skipping an unmatched `Text` node is not enough when the entire
   paragraph (or heading/caption) is a **single DOM `Text` node**:
   - **Attribute substitution in AsciiDoc (`samples/asciidoc-tour.adoc:88`):**
     `Um parágrafo com {atributo} que não deve ser localizado pelo texto.`
     renders as `<p>Um parágrafo com substituído que não deve ser localizado pelo texto.</p>`
     — **one** DOM `Text` node. Because `substituído` is not in the source line,
     whole-node `indexOf` returns `-1` for the entire `<p>`, losing every word
     before (`Um`, `parágrafo`, `com`) and after (`que`, ..., `texto`) the
     substitution.
   - **Typographic replacements (*smart punctuation*) in both formats:**
     Typst and Asciidoctor convert straight apostrophes `'` to `’` (`\u2019`, e.g.
     `compiler's` → `compiler’s`, `document's` → `document’s`), `"` to `“`/`”`,
     `--`/`---` to `–`/`—` (in AsciiDoc `--` becomes `\u2009\u2014\u2009` or
     `\u2014\u200b` with a zero-width space), and `...` to `…` (`\u2026\u200b`).
     Any single apostrophe, dash, or ellipsis in a paragraph makes whole-node
     `plain.indexOf` return `-1` for that `Text` node. Furthermore, `--` → `—`
     and `...` → `…` change the character length between source and DOM.
   - **Generated prefixes inside a `Text` node:**
     Typst `#set heading(numbering: "1.1")` renders `= Text` as `<h2>1 Text</h2>`
     and `== Lists` as `<h3>1.1 Lists</h3>`; AsciiDoc `:sectnums:` renders
     `<h2>1. Lists</h2>`; Typst `#figure(..., caption: [...])` renders
     `<figcaption>Table\u00a01: What this document exercises.</figcaption>`. The
     generated number prefix lives in the same `Text` node as the heading or
     caption title, so whole-node `indexOf` fails on every numbered heading and
     caption.
   - **Stripped inline wrappers in Typst Document (`samples/typst-tour.typ:72`):**
     `#text(fill: rgb("#b03030"))[Coloured text] is a normal part of the language.`
     renders in Typst HTML export as `<p>Coloured text is a normal part of the language.</p>`
     (one single `Text` node), whereas the source has `]` between `Coloured text`
     and ` is a normal`. Whole-node `indexOf` fails on the entire paragraph.
4. **`annotateTypstLines` (`src/typst-map.ts`) fails to attach `data-line` and
   `data-b` to paragraphs with early inline math, tables, and code blocks, and
   mis-anchors short headings onto `#set` rules or comments.**
   Tested against `samples/typst-tour.typ` compiled by Typst 0.15.1:
   - **Inline math in the first 24 characters (`samples/typst-tour.typ:31`):**
     `<p>Inline math such as <math><msup><mi>𝑎</mi><mn>2</mn></msup>...</math> flows with the text.</p>`.
     `blockText(block)` walks into `<math>`, where Typst emits Unicode
     Mathematical Italic `𝑎` (`\u{1D44E}`) instead of ASCII `a`. The 24-char
     prefix `needle` is `"inline math such as 𝑎 2"`, which does not match
     `"inline math such as a^2"` in `plain`. The `<p>` gets **neither
     `data-line` nor `data-b`**, so clicking or selecting anywhere in it leaves
     the editor on line 1 and even a block fallback has no `[data-b]` to use.
   - **Code blocks (`samples/typst-tour.typ:59`):**
     Typst highlights `<pre><code data-lang="rust">` with `<span style="color:...">`
     tokens. `blockText` joins every text node with `" "` (`parts.join(" ")`),
     turning `fn main() {` into `"fn main () {"`, while `foldSource` keeps the
     fence info word `"rust"` and strips `{}` (`"rust fn main let..."`). The
     `<pre>` block gets **neither `data-line` nor `data-b`**.
   - **Tables (`samples/typst-tour.typ:40`):**
     In `#figure(table(table.header([*Feature*], [*Status*], [*Notes*]), ...))`,
     `fold()` removes `[*` and `*]` but keeps the argument commas
     (`"feature, status, notes,"`), whereas `blockText(<figure>)` reads
     `<th>` cells as `"feature status notes"`. `plain.indexOf` returns `-1` and
     the entire `<figure>` / `<table>` gets **neither `data-line` nor `data-b`**.
   - **Comments (`//`, `//!`) and directives (`#set`, `#show`, `#let`, `#import`)
     in `foldSource` (`src/typst-map.ts:79-82`):**
     The regex `.replace(/^\s*(?:={1,6}|\+|-|\/\s*\/|\d+\.)\s+/, "")` only
     strips the `// ` prefix (keeping all the comment's words in `plain`!) and
     does not match `//!` at all; it also keeps `#set text(...)`. Consequently,
     `<h2>1 Text</h2>` (line 16, folded to `"text"`) matches `#set text(...)` on
     **line 7**!
5. **`bindWordMap` (`src/source-map.ts:145-155`) walks into nested `[data-b]`
   blocks and non-prose subtrees, and AsciiDoc (`src/asciidoc-preview.ts`)
   attaches section `data-b` to the outer `.sect1`..`.sect5` wrapper.**
   - In `bindWordMap`, `walkTextNodes(element)` walks all descendants of each
     `[data-b]` element without stopping at nested `[data-b]` elements, pushing
     every child block's text nodes into the parent container's
     `map.blockNodes[index]`. It also walks into `<math>`, `.math-inline`,
     `.math-display`, `.katex`, `[data-stem]`, `sup[role="doc-noteref"]`,
     `sup[role="doc-backlink"]`, and `.admonitionblock td.icon`.
   - In `src/asciidoc-preview.ts`, `MarkerProcessor` marks `section` AST nodes,
     which Asciidoctor renders as `<div class="sect1 mdraft-line-N">` wrapping
     the **entire section** (the `<h2>` heading plus `<div class="sectionbody">`).
     If `<div class="sect1">` carries `data-b`, then `closest("[data-b]")`
     inside an unmapped `include::` paragraph inside that section falsely
     resolves to the section header's `data-b` (breaking the include-containment
     contract in `scripts/asciidoc-test.mjs:464`), and `blinkAnchor` flashes the
     whole section instead of the `<h2>` heading.
6. **Asymmetric lookups make sync work in one direction (`Preview → Source`) and
   fail in the other (`Source → Preview`), or fail on multi-node selections:**
   - `pointForSource` (`src/source-map.ts:525-558`) only accepts offsets that
     fall inside a mapped entry. When a source selection starts or ends on
     inline markup (`**`, `_`, `\(`, `#emph[`, a link target) or unmapped tokens,
     `pointForSource` returns `null` and `rangeForSource` aborts, even when words
     inside the selection are mapped.
   - `blockForOffset` (`src/source-map.ts:410-427`) returns only **one** block
     index (the last block with `src0 <= offset` and `src1 > offset`). When two
     blocks share a source line (e.g. `<dt>` and `<dd>` on the same line of an
     AsciiDoc description list `AsciiDoc:: A plain-text...`, or `.ulist` and its
     first `li`), `Preview → Source` on `<dt>` succeeds via `map.text.get(node).block`,
     but `Source → Preview` on `AsciiDoc` checks only the last block (`<dd>`),
     misses `<dt>`, and returns `null`.
   - In `sourceFromPreviewSelection` (`src/main.ts:3068-3069`), a drag selection
     spanning two text nodes (`startNode !== endNode`) calls
     `sourceRangeFor(map, startNode, startOffset, startOffset)` and
     `sourceRangeFor(map, endNode, endOffset, endOffset)` with zero-width offsets
     instead of `(startOffset, startNode.data.length)` and `(0, endOffset)`,
     which can miss the last word when `endOffset` sits after trailing
     punctuation or whitespace in `endNode`.
7. **Typst Document does not repaint the preview highlight after a render
   (`src/main.ts:854`).**
   The AsciiDoc (`src/main.ts:1019`) and Markdown (`src/main.ts:1051`) paths call
   `syncPreviewFromSource()` after `bindPreviewWords`; `renderTypstPreview` does
   not. Because `bindPreviewWords` calls `clearPreviewWords()` (added for the
   pulse in `0.4.2`), every Typst Document render erases the `Source → Preview`
   highlight until the cursor moves again.

The goal: a preview selection in Typst Document or AsciiDoc reliably marks the
corresponding source text — the exact word or phrase when the words map, the
containing block (paragraph) when the selection is inside unmapped content
(inline math, attribute substitution), and never a guessed wrong word or silent
no-op on an anchorable block. `Source → Preview` paints the corresponding range
in the other direction and survives re-renders.

## Scope and non-scope

In scope:

- `src/source-map.ts`:
  - Stop `bindWordMap`'s `[data-b]` walk from descending into nested `[data-b]`
    elements or non-prose subtrees (`math`, `.math-inline`, `.math-display`,
    `.katex`, `[data-stem]`, `sup[role="doc-noteref"]`,
    `sup[role="doc-backlink"]`, `.admonitionblock td.icon`), while still linking
    every DOM text node inside `[data-b]` to its innermost `block` index so the
    block fallback works on math and footnotes.
  - Normalize 1-to-1 typographic characters (`’`/`‘`/`\u02bc` → `'`,
    `“`/`”` → `"`, `\u00a0` → `" "`) in `foldWhitespace` so smart quotes and
    non-breaking spaces never break whole-node matches or offset tables.
  - Map offsets through the folded text (`rawNodeOffsetToSource` and its inverse
    `sourceOffsetToRawNode`) using `nodeFolded.at` and `blockFolded.at` instead
    of `entry.src0 + start`.
  - When a `Text` node does not match as a single substring of the block's
    `plain` (because of an internal `{attribute}` substitution, `--` → `—`,
    `...` → `…`, a generated heading/caption number prefix `"1.1 "`, or stripped
    `#text(...)[...]` markup), fall back to **per-node word-run alignment**
    within that `Text` node against the remaining block source, keeping the
    forward cursor and skipping only the unmatched words (such as `substituído`
    or `"1.1"`). Continue to the next `Text` node instead of aborting the block.
  - Export `blockRangeForNode(map, node)` for the block fallback.
  - In `pointForSource` and `endPointForSource`, check all candidate blocks
    covering `offset` (innermost first), and provide a within-block gap/fallback
    lookup so selections starting or ending on inline markup still resolve to
    the nearest mapped word or the block's text bounds.
- `src/typst-map.ts`:
  - Fix `blockText`, `fold`, and `foldSource` so paragraphs with early inline
    math (`<math>`), code blocks (`<pre><code>`), tables (`#figure(table(...))`),
    and headings after `#set` rules or `//` / `//!` comments all receive accurate
    `data-line` and `data-b` ranges.
- `src/asciidoc-preview.ts`:
  - Move section `data-line`, `data-line-end`, and `data-b` from the outer
    `.sect1`..`.sect5` wrapper onto its direct heading element (`h2`..`h6`), so
    unmapped `include::` blocks inside a section do not inherit the section's
    `data-b` and `blinkAnchor` flashes only the heading.
- `src/main.ts`:
  - Pass `(startOffset, startNode.data.length)` and `(0, endOffset)` for
    multi-node selections in `sourceFromPreviewSelection`, and fall back to
    `blockRangeForNode` (snapped to words) when the exact word range is `null`.
  - Call `syncPreviewFromSource()` after `bindPreviewWords` in
    `renderTypstPreview`.
- Unit and integration tests in `scripts/block-map-unit.mjs` (new),
  `scripts/asciidoc-test.mjs`, and `scripts/typst-preview-test.mjs`, plus ADR
  `docs/adr/2026-10-20-block-sync-fallback.md`.

Out of scope:

- Markdown's exact `[data-f]` fragment pipeline and HTML's `parse5` table.
- Source → Typst Pages PDF text-layer highlighting (Pages is a canvas + PDF.js
  text layer, not a `WordMap` consumer).
- Embedding the Typst compiler or `typst.ts`, or adding a full parser for Typst
  or AsciiDoc in the frontend.
- Changing what a single click does in Document/AsciiDoc/Markdown: a single
  click still reveals the line and blinks the block; a double-click or drag
  selection paints `.cm-sync-word`.

## Approach and rejected alternatives

### 1. Folded-offset translation (`rawNodeOffsetToSource` and `sourceOffsetToRawNode`)

`foldWhitespace(text)` collapses every contiguous whitespace run to a single `" "`
and records `at: number[]`, where `at[k]` is the raw index in `text` where the
`k`-th folded character began. Extend `foldWhitespace` to also normalize
1-to-1 typographic characters that do not change UTF-16 length:
- `[\u2018\u2019\u02bc]` → `'`
- `[\u201c\u201d]` → `"`
- `\u00a0` → whitespace (collapsed by `\s`)

When a node's folded string `nodeFolded.plain` matches the block's `blockFolded.plain`
at index `found`, every character in `nodeFolded.plain` has a known index in
`blockFolded.plain` (`found + k`) and therefore a known raw offset in the block
source (`block.src0 + blockFolded.at[found + k]`):

- **Raw node offset → folded node index (`rawToFoldedIndex(nodeText, nodeAt, rawOffset, bias)`):**
  `nodeAt` is strictly increasing. Binary-search the largest `k` with
  `nodeAt[k] <= rawOffset`.
  - If `rawOffset === nodeAt[k]`, the folded index is `k`.
  - If `rawOffset > nodeAt[k]`: when `nodeFolded.plain[k] === " "` (meaning
    `rawOffset` sits inside or at the end of a collapsed whitespace run in
    `nodeText`), `bias === "start"` advances to `k + 1` (the character after the
    whitespace run) and `bias === "end"` stays at `k` (or `k + 1` clamped).
- **Folded node index → source raw offset (`rawNodeOffsetToSource`):**
  For a start boundary at folded index `k`: `block.src0 + blockAt[found + k]`.
  For an end boundary at raw offset `end`: map the last included character
  (`end - 1`, or `start` when `end === start`) to folded index `kLast`, and take
  `block.src0 + blockAt[found + kLast] + 1` (when that character is non-whitespace;
  if it is whitespace, the end of the previous non-whitespace character).
- **Inverse (`sourceOffsetToRawNode`):**
  Binary-search `blockAt` for `localOffset = sourceOffset - block.src0` to get
  `blockFoldedIndex`, subtract `found` to get `nodeFoldedIndex = blockFoldedIndex - found`,
  and return `nodeAt[nodeFoldedIndex]`.

### 2. Two-tier node mapping in `blockLayout`: whole-node match first, word-run fallback second

Inside `blockLayout(map, index)`:

1. **Tier 1 (Whole-node match):**
   Compute `folded = foldWhitespace(node.data)`. Strip leading/trailing `" "` from
   `folded.plain` (adjusting its `at` slice accordingly) so boundary whitespace
   between inline elements (`<strong>strong</strong> text`) never fails because
   the adjacent node already consumed the space in `plain`.
   If `trimmed.plain.length > 0` and `plain.indexOf(trimmed.plain, cursor)`
   succeeds at `found`:
   - Record a whole-node `BlockNodeSpan` covering `[trimmedStart, trimmedEnd]` in
     `node.data` mapped to `found` in `blockFolded`, and advance
     `cursor = found + trimmed.plain.length`.
2. **Tier 2 (Sub-node word-run alignment when whole-node match returns `-1`):**
   When `plain.indexOf(trimmed.plain, cursor)` returns `-1`, the `Text` node
   contains at least one discrepancy (e.g. `{atributo}` → `substituído`,
   `--` → `—`, `...` → `…`, generated heading/caption prefix `"1.1 "` /
   `"Table 1: "`, or stripped `#text(...)[...]` brackets).
   Instead of discarding the whole `Text` node or aborting the block:
   - Tokenize `node.data` into words (` WORD = /[\p{L}\p{N}_'’\u00ad]+/gu `, with
     `\u00ad` stripped and `’` normalized to `'`).
   - Tokenize the remaining block slice `plain.slice(cursor)` into words with
     their folded offsets `cursor + match.index`.
   - Walk the node's words in order against the remaining block words:
     - If `nodeWords[w]` matches the next available source word (or a source
       word ahead), we only accept a jump over skipped source words when:
       - the word itself is at least 3 characters AND appears uniquely in the
         lookahead window (or starts a 2+ word consecutive match with
         `nodeWords[w + 1]`), AND
       - it does not jump past a source word that matches `nodeWords[w + 1]`
         closer to `cursor` (which is what prevents a substituted word like
         `substituído` from jumping to the end of the paragraph over `"que"`,
         `"não"`, `"deve"`!).
     - Consecutive matched words that are separated only by identical folded
       characters in both `nodeFolded` and `blockFolded` merge into a single
       `BlockNodeSpan`; otherwise each matched word (or run) is stored as a
       `BlockNodeSpan` on that `Text` node, and `cursor` advances to the end of
       the matched word in `plain`.
     - Unmatched words in `node.data` (such as `substituído` from `{atributo}`,
       or `"1.1"` in `<h3>1.1 Lists</h3>`, or `"Table 1:"` in `<figcaption>`)
       simply get no `BlockNodeSpan` and do **not** advance `cursor`.
3. **Never `break` out of the `for (const node of nodes)` loop.**
   If a node has zero matched spans (e.g. an admonition's `"Note"` icon title if
   reached, or a wholly substituted node), `cursor` stays where it is and the
   next `Text` node in the block is still processed.

With this two-tier layout, a `Text` node maps to `spans: BlockNodeSpan[]` (one
span for normal nodes, multiple word/run spans for nodes containing an internal
substitution or typographic replacement, or zero spans when nothing in the node
is in the source):
- Selecting `"Um"`, `"parágrafo"` (before `{atributo}`) or `"localizado"`,
  `"texto"` (after `{atributo}`) in the **same `<p>`** hits its exact
  `BlockNodeSpan` and highlights that **exact word** in the source!
- Selecting `"substituído"` (the `{atributo}` expansion itself) hits no
  `BlockNodeSpan` covering those offsets in `node.data`, so `sourceRangeFor`
  returns `null` and `sourceFromPreviewSelection` falls back to
  `blockRangeForNode` — highlighting the paragraph!

### 3. Clean DOM walk in `bindWordMap` (`src/source-map.ts`)

When binding `[data-b]` elements in `bindWordMap`:
- Every `Text` node inside `element` (that does not belong to a deeper `[data-b]`
  descendant) gets `record.block = index` in `map.text`, so `blockRangeForNode`
  always knows which block owns the node.
- However, `map.blockNodes[index]` (the list of `Text` nodes that `blockLayout`
  matches against the source) **skips**:
  1. Any node inside a descendant `[data-b]` element (`node.parentElement?.closest("[data-b]") !== element`).
  2. Any node inside non-prose/generated subtrees:
     `math, .math-inline, .math-display, .katex, [data-stem], sup[role="doc-noteref"], sup[role="doc-backlink"], .admonitionblock td.icon`.
- Result: selecting inside an inline `<math>` or `.katex` formula finds
  `record.block >= 0` (or `closest("[data-b]")`), has no `BlockNodeSpan` in
  `layout`, gets `null` from `sourceRangeFor`, and cleanly triggers the
  **block fallback** (`blockRangeForNode`), painting the containing paragraph in
  the editor without `<math>`'s internal nodes (`"𝑎"`, `"2"`, `"π"`) ever
  polluting `blockLayout`!

### 4. Block fallback in both directions (`Preview ↔ Source`)

- **`Preview → Source` (`blockRangeForNode` + `sourceFromPreviewSelection`):**
  Export `blockRangeForNode(map: WordMap, node: Node): BlockRange | null` from
  `src/source-map.ts`, which looks up `map.text.get(node)?.block` or walks up
  `node.parentElement?.closest<HTMLElement>("[data-b]")` and returns
  `map.blocks[blockIndex]`.
  In `sourceFromPreviewSelection` (`src/main.ts`):
  - When `startNode === endNode`: try `sourceRangeFor(map, startNode, startOffset, endOffset)`.
    If it returns `null`, fall back to `blockRangeForNode(map, startNode)`
    (widened/trimmed with `snapToWords(map.source, block.src0, block.src1) ?? block`).
  - When `startNode !== endNode`: call
    `sourceRangeFor(map, startNode, startOffset, startNode.data.length)` and
    `sourceRangeFor(map, endNode, 0, endOffset)`. If either end is `null`, fall
    back to `blockRangeForNode` for that end (`startBlock.src0` / `endBlock.src1`).
- **`Source → Preview` (`pointForSource`, `endPointForSource`, `rangeForSource`):**
  - Replace the single-block `blockForOffset` lookup with
    `blocksForOffset(map, offset): number[]`, returning all blocks whose
    `src0 <= offset && offset <= src1`, ordered from deepest/most specific
    (smallest `src1 - src0`, latest in DOM order) to outermost. This fixes
    same-line sibling blocks such as `<dt>` and `<dd>` in AsciiDoc description
    lists.
  - First pass across `blocksForOffset`: look for a `BlockNodeSpan` whose
    `src0 <= offset && offset <= src1`, and convert `offset` via
    `sourceOffsetToRawNode`.
  - Second pass (gap fallback when `offset` sits on inline markup like `**`,
    `\(`, `#emph[`, or `{atributo}` inside a mapped block):
    - For `bias === "start"`: choose the first `BlockNodeSpan` in the block with
      `span.src0 >= offset` (returning `{ node: span.node, offset: span.dom0 }`);
      if none exists after `offset`, use the first mapped node in the block (or
      `map.blockNodes[block][0]` at offset `0`).
    - For `bias === "end"`: choose the last `BlockNodeSpan` in the block with
      `span.src1 <= offset` (returning `{ node: span.node, offset: span.dom1 }`);
      if none exists before `offset`, use the last mapped node in the block (or
       the last node in `map.blockNodes[block]` at `node.data.length`).
  - In `rangeForSource(map, from, to)`: if `start` and `endPoint` invert or collapse
    because the selection was entirely inside an unmapped construct (e.g. a
    formula or `{atributo}`), widen to the block's first and last text nodes so
    the preview highlights the block rather than nothing.

### 5. Reliable block anchoring in Typst Document (`src/typst-map.ts`) and AsciiDoc (`src/asciidoc-preview.ts`)

- **In `src/typst-map.ts` (`annotateTypstLines`, `blockText`, `fold`, `foldSource`):**
  - `blockText(element)`:
    - Skip `<math>`, `<sup role="doc-noteref">`, and `<sup role="doc-backlink">`
      when collecting text for the block's search needle (unless `element` itself
      is `<math display="block">`, which has no prose). That way,
      `<p>Inline math such as <math>...</math> flows with the text.</p>` produces
      `"Inline math such as flows with the text."` instead of `"Inline math such as 𝑎 2..."`.
    - Inside `<pre>` or `<code>`, read `element.textContent` directly instead of
      joining child `<span>` text nodes with `" "`, preserving `"fn main() {"`
      instead of `"fn main () {"`.
  - `fold(text)`:
    - Normalize curly quotes/apostrophes (`[\u2018\u2019\u02bc]` → `'`,
      `[\u201c\u201d]` → `"`), strip inline `#func(...)` call headers before `[`
      (e.g. `#link("...")[link]` → `link`, `#text(...)[Coloured text]` →
      `Coloured text`, `#footnote[...]` removed from inline line), strip inline
      `$...$` math when building the prose search string, and replace punctuation
      `[,.;:!?()"'/*_`#$\\{}[\]]` uniformly so `[*Feature*], [*Status*]` and
      `<th>Feature</th><th>Status</th>` fold to the same words `"feature status"`.
  - `foldSource(source)`:
    - Skip comment lines (`^\s*\/\/`) completely (push `starts` and append `""`,
      never keeping comment words in `plain`).
    - Skip pure non-rendered directive/rule lines
      (`^\s*#(?:set|show|import|include|let|v|h|pagebreak|colbreak)\b` when the
      line has no `[...]` content body) and code-fence delimiter lines
      (`^\s*(?:`{3,}|~{3,})`).
    - For short needles (`needle.length < 12`, such as `= Text` → `"text"` or
      `= Code` → `"code"`), require word-boundary matching in `plain` (and for
      `h1`..`h6` elements, prefer matching lines that start with `={1,6}\s` in
      source!) so a heading like `= Text` can never match the word `"text"`
      inside an earlier paragraph or rule.
    - When a paragraph's 24-char prefix fails because an inline `$...$` formula
      was in the first 24 characters, also try matching the longest prose run in
      `blockText(block)` (e.g. `"flows with the text. display"` after the math).
- **In `src/asciidoc-preview.ts` (`renderAsciidocPreview`):**
  - When transferring `mdraft-line-N` markers to `data-line` / `data-line-end`
    (lines 302-314): if `element` is a section container
    (`element.matches(".sect1, .sect2, .sect3, .sect4, .sect5")`), attach
    `data-line` and `data-line-end` to its direct heading child
    (`element.querySelector(":scope > h2, :scope > h3, :scope > h4, :scope > h5, :scope > h6") ?? element`)
    instead of the outer `.sectN` wrapper.
    - This ensures `data-b` is placed on the `<h2>`..`<h6>` heading, not on the
      `<div class="sectN">` wrapper around the whole chapter.
    - Unmapped `include::` content inside a section therefore has
      `closest("[data-b]") === null` (keeping `includeAnchored === false` in
      `scripts/asciidoc-test.mjs`), and `blinkAnchor` flashes the heading rather
      than the entire section.

### 6. Repaint Typst Document after binding (`src/main.ts`)

Add `syncPreviewFromSource()` immediately after `updateActiveOutline()` at the
end of the `rendered.kind === "document"` branch in `renderTypstPreview`
(`src/main.ts:858`), matching the AsciiDoc and Markdown branches of `doRender()`.

### Rejected alternatives

- **Whole-node skip without sub-node word fallback in `blockLayout`.** Fails
  whenever an attribute substitution (`{atributo}`), smart apostrophe (`’`),
  em-dash (`—`), numbered heading (`1.1 Lists`), or stripped `#text(...)[...]`
  sits inside a single DOM `Text` node: skipping the node skips the entire
  paragraph and forces the block fallback even on plain words before and after
  the substitution, failing Acceptance Criterion #2.
- **Leaving `src/typst-map.ts` unchanged.** Tested against `samples/typst-tour.typ`:
  paragraphs with inline math in the first 24 chars, `#figure(table(...))`, and
  `<pre><code>` get neither `data-line` nor `data-b`, and `= Text` anchors onto
  `#set text` on line 7. Without `data-b`, even the block fallback in
  `source-map.ts` cannot fire.
- **Keeping `data-b` on AsciiDoc `.sect1`..`.sect5` wrappers.** Makes
  `closest("[data-b]")` true for every descendant inside a section, including
  `include::` content that `scripts/asciidoc-test.mjs` explicitly requires to
  stay unmapped.
- **Exact Typst compiler spans or `typst.ts` WASM.** Rejected in
  `docs/adr/2026-10-18-typst-pdf-pages.md` (+50 MB / 13.7 MB compressed and a
  second compiler).
- **Searching the whole document for the selected word.** Wrong for repeated
  words; bounding the search to `block.src0..block.src1` is what makes word
  mapping safe.

## Steps

- [x] 1. Write `docs/adr/2026-10-20-block-sync-fallback.md`: exact word when the
      word maps inside its `[data-b]` block; the block (`src0..src1`) when the
      selection is inside unmapped content (math, attribute substitution) in
      either direction; never a guessed word outside the block. Add a
      "Superseded in part by" pointer to `docs/adr/2026-10-18-word-level-sync.md`.
- [x] 2. `src/source-map.ts`:
      - Update `foldWhitespace` to normalize 1-to-1 typographic quotes/spaces
        (`[\u2018\u2019\u02bc]` → `'`, `[\u201c\u201d]` → `"`, `\u00a0` → `" "`).
      - Add and export pure helpers `rawNodeOffsetToSource` and
        `sourceOffsetToRawNode` (translating through `nodeFolded.at` and
        `blockFolded.at`).
      - Update `bindWordMap` so `map.blockNodes[index]` skips descendant
        `[data-b]` elements and non-prose subtrees (`math`, `.math-inline`,
        `.math-display`, `.katex`, `[data-stem]`, `sup[role="doc-noteref"]`,
        `sup[role="doc-backlink"]`, `.admonitionblock td.icon`), while keeping
        `record.block` set to the innermost `[data-b]` on every `Text` node.
      - Update `blockLayout` to use the two-tier strategy (whole-node folded
        match first; per-node word-run alignment second; never aborting the
        remaining nodes in the block).
      - Export `blockRangeForNode(map, node)` for the preview→source fallback.
      - Update `pointForSource`, `endPointForSource`, and `rangeForSource` to
        check all candidate blocks covering `offset` (`blocksForOffset`) and fall
        back to the nearest mapped span or block text bounds when `offset` sits
        in inline markup or an unmapped span.
- [x] 3. `src/typst-map.ts`:
      - In `blockText`: skip `math`, `sup[role="doc-noteref"]`, and
        `sup[role="doc-backlink"]`; read `pre`/`code` `textContent` without
        inserting spaces between token `<span>`s.
      - In `fold` and `foldSource`: skip comment lines (`^\s*\/\/`) and pure
        directive/rule/fence lines; strip inline `#func(...)` headers before `[`
        and inline `$...$` math; normalize quotes/punctuation so headings,
        paragraphs with early math, tables, and code blocks all receive accurate
        `data-line` and `data-b` ranges.
- [x] 4. `src/asciidoc-preview.ts`:
      - Attach section `data-line` / `data-line-end` (and thus `data-b`) to the
        section's direct heading element (`h2`..`h6`) rather than the outer
        `.sect1`..`.sect5` wrapper.
- [x] 5. `src/main.ts`:
      - In `sourceFromPreviewSelection`: use `(startOffset, startNode.data.length)`
        and `(0, endOffset)` for multi-node selections, and fall back to
        `blockRangeForNode` (snapped to words via `snapToWords`) when the exact
        range is `null`.
      - In `renderTypstPreview`: call `syncPreviewFromSource()` after
        `bindPreviewWords` in the `document` branch.
- [x] 6. Add `scripts/block-map-unit.mjs`, wire it into `package.json`,
      `scripts/test-all.mjs`, and `AGENTS.md`, and extend
      `scripts/asciidoc-test.mjs` and `scripts/typst-preview-test.mjs`.
- [x] 7. Run validation layers (`npm run build`, `npm run block:map:unit`,
      `npm run word-sync`, `npm run asciidoc`, `npm run typst:preview`,
      `npm run smoke`) and update check counts in script headers and `AGENTS.md`.

## Files and modules

- `src/source-map.ts` — folded-offset conversion (`rawNodeOffsetToSource`,
  `sourceOffsetToRawNode`), two-tier `blockLayout` (whole-node + word-run
  fallback), clean `bindWordMap` `[data-b]` walk, `blockRangeForNode`, and
  multi-candidate + gap-tolerant reverse lookup (`pointForSource`,
  `rangeForSource`).
- `src/typst-map.ts` — `blockText`, `fold`, `foldSource`, and
  `annotateTypstLines` so Typst Document headings, math paragraphs, tables, and
  code blocks anchor reliably.
- `src/asciidoc-preview.ts` — place section `data-line`/`data-line-end`/`data-b`
  on `h2`..`h6` instead of `.sect1`..`.sect5`.
- `src/main.ts` — `sourceFromPreviewSelection` block fallback and multi-node
  boundary slices; `syncPreviewFromSource()` call in `renderTypstPreview`.
- `samples/typst-pages.typ` — add an inline formula (`$T = 2 pi sqrt(L / g)$`) in
  the Discussion paragraph so the Typst preview suite exercises a Document
  paragraph containing both inline math and a hard-wrapped phrase after it
  without changing the 2-page / 2-column layout in Pages view.
- `scripts/block-map-unit.mjs` — new `kind: "node"` unit suite testing pure
  offset translation and block word-run alignment without launching the app.
- `scripts/asciidoc-test.mjs` — test words before and after `{atributo}` in the
  same paragraph, the block fallback on `substituído`, admonition word sync, and
  source→preview selection that includes inline markup (`*strong*`).
- `scripts/typst-preview-test.mjs` — in Document view, test selecting a phrase
  after inline math on a wrapped line, selecting inside inline math (block
  fallback), and source→preview highlight surviving a Document re-render.
- `scripts/test-all.mjs`, `package.json`, `AGENTS.md` — register
  `block:map:unit` (`block-map-unit`) and update check counts.
- `docs/adr/2026-10-20-block-sync-fallback.md` and the pointer in
  `docs/adr/2026-10-18-word-level-sync.md`.

No Rust changes, no new dependency, no `#[tauri::command]` or `settings.json`
schema change.

## Risks and rollback

- **A block fallback marks the whole paragraph when a word is genuinely
  unmapped (e.g. inside a formula or attribute substitution).** That is the
  intended, honest result; the alternative is the current silent failure where
  only line 1 or the block's first line shows `.cm-activeLine`.
- **Generated `#lorem` blocks in Typst Document must still paint nothing.**
  `annotateTypstLines` finds no match for `#lorem` in the source, so `#lorem`'s
  `<p>` gets neither `data-line` nor `data-b`. Because it has no `[data-b]`,
  `blockRangeForNode` returns `null` and `typst-preview-test.mjs`'s
  `"generated Document text paints nothing"` check stays green.
- **Included files (`include::`) in AsciiDoc must still have no block range.**
  Moving section `data-b` from `.sect1`..`.sect5` onto `h2`..`h6` ensures an
  included paragraph inside a section does not inherit `data-b` from the section
  wrapper, keeping `"included content has no block range"` in
  `scripts/asciidoc-test.mjs` green.
- **Word-run fallback after an unmatched token could jump to a later repeated
  word.** Guarded by checking that a lookahead match in the source does not skip
  over a source word that matches the next DOM word closer to `cursor`, and
  requiring >= 3 chars (or a 2-word run) when jumping past skipped source tokens.
  Pinned in `scripts/block-map-unit.mjs`.
- **Adding inline math to `samples/typst-pages.typ` must not push Pages view onto
  a 3rd page.** Adding `$T = 2 pi sqrt(L / g)$` to the Discussion paragraph on
  page 2 (which is only 5 lines long) keeps the fixture at 2 pages and 2 columns.
- Rollback is a revert of the branch; no settings or persisted state are touched.

## Tests and validation

Run the cheapest layer that can catch each mistake first:

1. `npm run build` — TypeScript typecheck and Vite bundle.
2. `npm run block:map:unit` (`node scripts/block-map-unit.mjs`) — new unit layer
   (no app required). Pins:
   - `rawNodeOffsetToSource` on `"one\n    two three"` maps a selection on
     `three` to the exact source offsets of `three`, not `two`.
   - A selection after a double space or CRLF maps to the word after it.
   - A selection starting inside a collapsed whitespace run maps cleanly to the
     word boundary.
   - Single-node word-run fallback on `"Um parágrafo com substituído que não deve"`
     against `"Um parágrafo com {atributo} que não deve"`: `"parágrafo"` (before)
     and `"deve"` (after) both return their exact word ranges, while
     `"substituído"` returns `null` (triggering the block fallback).
   - A repeated word after `{atributo}` does not cause `"substituído"` to jump
     past `"que não deve"`.
   - Smart punctuation (`compiler’s`, `—`, `…`) and numbered heading prefixes
     (`"1.1 Lists"` vs `"== Lists"`) map the prose words accurately.
3. `npm run word-sync` — 33/33 checks on `samples/word-sync.md` to prove
   Markdown's exact fragment path did not regress.
4. `npm run asciidoc` — `scripts/asciidoc-test.mjs` against
   `samples/asciidoc-tour.adoc`:
   - Word before (`"parágrafo"`) and word after (`"localizado"`) `{atributo}` on
     line 88 both paint the exact word in the source.
   - Selecting `"substituído"` paints the block (`Um parágrafo com {atributo}...`),
     not `null` and not a wrong word.
   - Selecting a word inside the `NOTE:` admonition (`"admonition"`) paints that
     word in the source.
   - Selecting `*strong*` (including the `*` markup) in the source paints
     `"strong"` in the preview.
   - Included content still has no block range (`includeAnchored === false`).
5. `npm run typst:preview` — `scripts/typst-preview-test.mjs` against
   `samples/typst-pages.typ`:
   - In Document view, selecting `"measuring the length carefully"` on a wrapped
     line after inline math paints that exact phrase in the source.
   - Selecting inside the inline math in Document view paints the containing
     paragraph in the source (block fallback).
   - Selecting a word in the source in Document view paints `mdraft-sync` /
     `mdraft-sync-peak` in the preview and survives a re-render.
   - All existing Document and Pages checks (including `#lorem` painting nothing)
     pass.
6. `npm run smoke` — 105/105 checks, including `.sync-blink` and pane sync.

## Acceptance criteria

- In a Typst Document paragraph containing inline math and a hard wrap, selecting
  `"measuring the length carefully"` in the preview paints that exact phrase in
  `.cm-sync-word` in the source, not the first line and not an empty mark;
  selecting inside the inline math paints the paragraph.
- In Typst Document, headings after `#set` rules or `//` comments, tables
  (`#figure(table(...))`), code blocks (`<pre><code>`), numbered headings
  (`1.1 Lists`), and paragraphs with `#text(...)[...]` all receive `data-line`
  and `data-b` and map words in both directions.
- In an AsciiDoc paragraph with an attribute substitution (`{atributo}`) or
  smart punctuation (`’`, `—`, `…`), selecting a word before or after the
  substitution in the same `<p>` paints that exact word in the source; selecting
  the substituted word itself paints the paragraph; selecting a word in a `NOTE:`
  admonition paints that word.
- Selecting a source range that includes inline markup (`*strong*`, `#emph[...]`)
  paints the corresponding preview text in `CSS.highlights`.
- A Typst Document re-render does not erase an active `Source → Preview`
  highlight when the editor selection is unchanged.
- Generated `#lorem` text in Typst Document and `include::` blocks in AsciiDoc
  remain unmapped and paint nothing.
- `npm run block:map:unit`, `npm run word-sync`, `npm run asciidoc`,
  `npm run typst:preview`, and `npm run smoke` all pass.

## Open questions

- None. The fallback is the containing block (`src0..src1`, snapped to word
  boundaries), applied only when the selected text is inside an anchored
  `[data-b]` block whose exact word could not be mapped; unanchored generated or
  included blocks still paint nothing.
