# Raw HTML in Markdown: keep line anchors and map its text

**Status:** done
**Date:** 2026-11-10
**ADR:** `../adr/2026-11-10-raw-html-sync.md`

## Context and goal

`docs/samples/SEI_15117522_Memorando_Circular_00035_2026.md` renders
correctly, but with Scroll Sync on, the vertical panes do not follow each other
and clicking a block in the preview does not reveal its source. The document
uses two raw HTML constructs:

- one complete `<table>…</table>` block;
- two `<div>…</div>` blocks whose opening tag, Markdown paragraph and closing tag
  arrive as three separate `marked` tokens.

Measured on 2026-11-10 with the real renderer and a headless browser:

| Measurement | Value |
| --- | --- |
| Marked/render tokens that produce a line, after filtering `space`/`def`/comments | 77 |
| Rendered top-level preview elements | 73 |
| Word-map fragments | 85 |
| `renderPreviewInto(...).linesMapped` | `false` |
| `#preview [data-line]` | 0 |
| `sourceRangeFor(...)` for the table word `Modalidade` | `null` |
| `rangesForSource(...)` for `Modalidade` | `[]` |
| `rangeForSource(...)` for `Modalidade` | the *following* paragraph, not the table |

**Root cause.** `finishPreview()` assigns `data-line` only when the number of
non-silent tokens equals `host.children.length`. A raw `<div>` is one top-level
element, but it spans three marked tokens: the opening HTML token, the Markdown
paragraph token and the closing HTML token. Two such divs remove four elements
from the count, so 77 tokens meet 73 elements, the whole zip is abandoned, and
`previewLinesMapped` becomes `false`. `editor.onScroll` then returns early, and
`queuePaneScroll` never runs. The same flag disables preview-click reveal and
the block blink for the entire document. This is an all-or-nothing failure: one
cross-token HTML construct disables positional sync everywhere.

**Second gap.** `marked` emits raw HTML untouched. Its text nodes have no
`data-f` fragment, so words inside the raw HTML table are absent from the word
map. That is why a double-click on `Modalidade` paints nothing, while
`sei! assinatura eletrônica` (a normal Markdown paragraph inside a `<div>`) does
map. Worse, `pointForSource` currently snaps a source offset that sits before
the next fragment to that fragment's start, so selecting `<table…>` markup maps
to the paragraph *after* the table instead of failing safely.

**Goal.** Keep the existing line-anchor and fragment architecture, but make it
understand raw HTML that crosses token boundaries:

1. a cross-token raw HTML element gets one correct `data-line`;
2. visible text inside a raw HTML block participates in the word map;
3. a source offset that is not inside mapped text fails safely instead of
   highlighting a different block.

## Scope and non-scope

**In scope**

- Markdown preview in Split mode.
- Raw HTML blocks that `marked` already renders: tables, divs, pre/code, and
  other block-level HTML.
- Line-anchor derivation for documents where tokens and top-level elements do
  not have a 1:1 relationship.
- Word fragments inside raw HTML text, for preview → source and source → preview
  highlighting and for scroll anchors.
- The fail-safe gap rule in `pointForSource`.

**Out of scope**

- The HTML preview (`*.html` documents), which has its own guest and source map.
- AsciiDoc, Typst and LaTeX previews.
- Supporting scripts, styles or CSS semantics that DOMPurify removes. Raw HTML
  remains sanitized exactly as today.
- Rendering changes to raw HTML markup. The change only wraps visible text nodes
  in preview-only spans; tags, attributes, table structure and sanitization are
  unchanged.
- A general raw-HTML-to-Markdown conversion. This is not new Markdown syntax.
- Enabling scroll sync from the word map when line anchors fail. The existing
  ADR says the two maps fail independently; the fix is to stop line anchors from
  failing on cross-token HTML, not to bypass them.

## Approach and rejected alternatives

### Chosen approach

**1. Derive line anchors from rendered elements when the token zip is not 1:1.**

`preview-render.ts` already knows the source line of every token and the HTML
string of every chunk. When `hasRawHtml` is true, it parses the joined chunks
with `parse5` and `sourceCodeLocationInfo`. For every top-level element it finds
the chunk whose string range contains the element's start tag, then reports the
line of that chunk's token. The result is a new `elementLines` array on
`PreviewChunks`, one line per rendered top-level element. `finishPreview()` uses
it when `lines.length !== host.children.length`; otherwise the existing exact zip
stays untouched. If parsing or count validation fails, it still abandons the
anchors (the current fail-safe).

This handles opening tags, closing tags, comments, whitespace and void elements
without reimplementing HTML parsing. The sample produces 73 element lines for
73 elements, including both divs and the table.

**2. Give visible text in raw HTML blocks ordinary fragments.**

In the mapped renderer, override `html(token)` for block-level raw HTML tokens.
Use `parse5` source locations to find visible text nodes in `token.raw`, split
them at `@@CODE`/`@@MATH` placeholders, and wrap each raw text piece in the
existing `<span data-f="N">` form. Push a normal `Fragment { src0, src1, raw,
kind: "text" }` for each piece, translated through the existing `sourceOf`
substitution map. This makes table cells, one-line raw HTML divs and other raw
HTML text indistinguishable from Markdown text to the existing binder, scroll
index and both highlight directions.

Skip text inside `script`, `style`, `textarea`, `title`, `noscript`, `template`,
`option`/`optgroup` and foreign content (`<svg>`, `<math>`). Skip placeholders:
they are restored later as code/formula nodes and must not become text
fragments.

**3. Make the gap fallback line-scoped.**

`pointForSource` may still snap an offset that sits on Markdown syntax (for
example the `**` before a bold word). Keep that convenience only when the next
fragment starts on the same source line as the offset. If the gap crosses a line
boundary, return `null`. A raw HTML tag line then paints nothing instead of
painting the next paragraph, while existing same-line markup behavior stays.

### Rejected alternatives

- **Count opening tags / track HTML depth while zipping.** Reimplements the HTML
  parser and gets void elements, implied end tags, comments and foster parenting
  wrong. `parse5` already answers this question correctly.
- **Disable word sync when line anchors fail.** Does not fix the document, and
  makes one map's failure take the other map with it.
- **Use only `data-b` block records for raw HTML text.** This would avoid touching
  raw HTML text, but it maps repeated words approximately and would require
  making block lookups take precedence over fragments in every source→preview
  path. The fragment contract is exact and already supports raw HTML text runs.
- **Wrap every raw HTML element.** Changes structure and can interact with user
  CSS. Wrapping only text runs in inline spans is the smallest DOM change and
  matches what Markdown text already does.
- **Parse the full document with `parse5` on every render.** Unnecessary for the
  overwhelming majority of Markdown documents. Do it only when `hasRawHtml` is
  true and only in the worker.

## Steps

- [x] Add HTML text-slot discovery to the mapped Markdown renderer; wrap
      block-level raw HTML text in `data-f` spans and emit exact fragments.
- [x] Add per-token line information and `elementLines` for raw HTML documents.
- [x] Use `elementLines` in `finishPreview` when the token/element counts differ;
      report the actual anchored count from `describePreview` instead of the
      token count.
- [x] Validate the new `elementLines` field in `preview-worker-client.ts`.
- [x] Make `pointForSource`'s fragment gap fallback line-scoped.
- [x] Add unit, DOM and end-to-end coverage described below.
- [x] Update the preview/sync catalog, add the trap entry, and write the ADR.

Deviation: the DOM suite also asserts that same-line Markdown syntax still
snaps to its word, which is the positive control for the new line-scoped gap
rule. That adds one check beyond the original list.

## Files and modules

| File | Why |
| --- | --- |
| `src/preview-render.ts` | Raw HTML text slots, fragment emission, per-token lines and `elementLines`. |
| `src/markdown.ts` | Use `elementLines`; report actual anchors; keep the existing sanitizer, which already allows `data-f`. |
| `src/preview-worker-client.ts` | Accept `elementLines` from the worker envelope. |
| `src/source-map.ts` | Same-line gap fallback; no cross-block snap. |
| `scripts/preview-render-unit.mjs` | Pure fragment and `elementLines` assertions, including SVG/script skips. |
| `scripts/preview-dom-test.mjs` | Real DOM: sample file `linesMapped`, data-line count, both mapping directions, table cells, fail-safe markup offsets. |
| `scripts/word-sync-test.mjs` | End-to-end scroll and word sync on a temporary raw-HTML fixture. |
| `docs/agent-guide/catalog/preview-and-sync.md` | Updated test counts and what each suite now covers. |
| `docs/agent-guide/traps/preview-and-sync.md` | Append the cross-token `data-line` trap. |
| `docs/adr/2026-11-10-raw-html-sync.md` | Durable decision: raw HTML text is fragments; element lines derive from rendered positions. |

No new dependency: `parse5` is already used by `html-preview.ts` and
`html-source-map.ts`.

## Risks and rollback

- **CSS that depends on direct text children.** A text run becomes
  `<span data-f>` inside the raw element. Inline spans are transparent for
  normal layout and inherited text styles, but a selector such as
  `td > div` is unaffected while `td:nth-child(...)` is unaffected too; a
  selector that assumes `element.firstChild.nodeType === 3` would notice. This
  is the same trade-off Markdown text already makes. Rollback: remove the HTML
  renderer override; line anchors remain fixed independently.
- **parse5 and browser parsing disagree.** If the top-level element counts
  differ, `elementLines` is discarded and behavior returns to today's fail-safe
  (no anchors). No wrong line is assigned.
- **Malformed raw HTML reorders text nodes.** Fragments are emitted in source
  order and bound by `data-f` index, so word mapping does not depend on DOM
  order. A source→preview range can still be approximate only where the DOM
  itself reorders content.
- **Cost on huge raw HTML.** `parse5` measured about 30–47 ms for a 1 MiB raw
  HTML fragment on this host, in the worker. The existing over-1-MiB preview DOM
  test will catch a regression. If it becomes unacceptable, the fallback is to
  compute `elementLines` only for documents below a measured size and keep the
  current no-anchor behavior above it.
- **Rollback.** The line-anchor change and the raw-HTML fragment change are
  separable. Reverting `preview-render.ts`/`markdown.ts` restores the current
  behavior without touching other documents; `source-map.ts`'s line-scoped gap
  rule can stay or be reverted on its own.

## Tests and validation

1. `npm run preview:unit` — new pure checks:
   - `<table>` cell text, one-line raw HTML div text and multi-token div
     Markdown text all produce exact fragments whose source slice equals the
     rendered word.
   - `elementLines` for `<div>\n\ntext\n\n</div>\n\nafter` has two entries (the div
     and the following paragraph) while the existing token `lines` has four; the
     paragraph inside the div still has a fragment.
   - `<svg><text>label</text></svg>` and `<script>bad()</script>` text is not
     wrapped or fragmented.
   - Mapped and plain renders still have identical visible text.
2. `npm run preview:dom` — new checks:
   - Render the actual `docs/samples/SEI_15117522_Memorando_Circular_00035_2026.md`;
     `linesMapped === true`, `#preview [data-line]` is non-zero, table and div
     text words map through `bindWordMapAsync`.
   - `rangesForSource` for `Modalidade` returns the table cell, not the later
     paragraph; a markup-only source range paints nothing rather than the next
     paragraph.
   - The existing over-1-MiB raw HTML and sanitizer checks still pass.
3. `npm run word-sync` — new temporary fixture with a raw HTML table and a
   `<div>` around Markdown text:
   - Scrolling the source moves the preview; scrolling the preview moves the
     source.
   - Double-clicking a table cell word paints the source word.
   - Selecting a table cell word in the source paints that cell in the preview.
4. `npm run sync` — the existing content-pair matrix must keep passing; raw HTML
   must not change Markdown, AsciiDoc, Typst or HTML synchronization.
5. `npm run smoke` and `npm run audit` on the sample; `npm run build`;
   `npm run format:check`; `npm run lint`.

The measurement that proves the fix is the first DOM check: for the reported
sample, `linesMapped` changes from `false` to `true` and `[data-line]` changes
from 0 to 73.

### Execution record

- `npm run preview:unit` — 183/183.
- `npm run preview:dom` — 32/32, including the reported sample: 73 anchors for
  73 top-level elements, 104 fragments, table and div mapping in both
  directions, and a markup offset that paints nothing.
- `npm test -- --only word-sync` — 111/111; the raw-HTML fixture passes both
  scroll directions and table-word correspondence.
- `npm test -- --only sync,smoke --no-build` — `sync` 62/62, `smoke` 117/117.
- `npm run sync:unit` — 29/29; `npm run preview:worker:unit` — 18/18;
  `npm run block:map:unit` — 22/22.
- `npx tsc --noEmit`, `npx eslint` on the four changed source files, Prettier on
  every changed source/script, and `npm run build` pass.
- The reported sample went from 0 anchors to 73 and from 85 to 104 fragments;
  `linesMapped` is `true`. The two extra `data-f` spans inside the raw table
  cover its cell text exactly.

`smoke` reports 117 checks rather than the catalog's pre-existing 116; that
count difference is in the suite itself, not in this change's assertions.

## Acceptance criteria

- Opening the reported sample in Split with Scroll Sync on: scrolling either
  pane follows the other through the table and both divs.
- The preview has a `data-line` anchor on every top-level element, including the
  two divs and the raw table.
- Double-clicking `Modalidade` (raw HTML table) or `sei!` (Markdown paragraph
  inside a div) marks the corresponding source word.
- Selecting `Modalidade` or `sei!` in the source paints the corresponding
  preview text; selecting only the raw HTML tag markup paints nothing rather
  than a different paragraph.
- Documents without raw HTML keep exactly the same anchors, fragments and sync
  behavior; all existing preview/word-sync/scroll suites pass.
- The sanitizer still removes scripts, event handlers and forbidden tags, and
  raw HTML visible text is unchanged.

## Open questions

- Should raw HTML text inside `<pre>`/`<code>` also be wrapped, or left
  unfragmented to avoid any copy/paste difference? Default: wrap it, because a
  span does not change `textContent` or whitespace, and the existing code-fence
  fragment is atomic. Revisit only if a test shows a difference.
- Should the line-anchor fix be limited to Markdown? Default: yes. AsciiDoc and
  Typst have their own anchored renderers and are not touched.
- Should `elementLines` be computed when the preview is not in Split? Default:
  yes for raw HTML only, because the synchronous export path already computes
  line data and line anchors are part of `RenderResult`; the cost is removed
  from the UI thread by the worker.
