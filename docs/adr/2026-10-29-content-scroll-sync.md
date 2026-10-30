# Scroll sync maps verified content pairs in CSS pixels, not page fractions

**Status:** accepted
**Date:** 2026-10-29

## Context

The five preview modes already had different mapping strengths. Markdown,
AsciiDoc and Typst Document carried block anchors; HTML supplied measured
guest-element tops; Typst Pages supplied word correspondence for selection but
no continuous scroll correspondence. The shared block path interpolated between
block starts, and Source and Preview used the same twelve-pixel intent but
different coordinate systems: CodeMirror's `lineBlockTop` is document-relative,
`scrollTop` includes padding, a preview block's `offsetTop` is not its screen
position, and the HTML guest is a separate document inside a CSS-zoomed iframe.

Measured baseline before the change, in CSS pixels, over forty probes per mode:
Markdown and AsciiDoc 12.86 median / 13.51 p95, Typst Document 12.60 / 13.76,
HTML 13.88 / 14.41. Typst Pages had no scroll sync at all: 1269.49 / 3222.65
and twenty unavailable source rectangles. A global page fraction and a
source-line fraction both drift at page margins, full-width bands, columns,
wrapped lines and unequal page sizes.

## Decision

Scroll correspondence is a **local correction between verified content pairs**,
not a global ratio and not a second text search.

- A pair is `(source offset, origin screen Y, target screen Y, region)`. The
  desired correction is `targetScroll += targetScreenY - originScreenY`,
  clamped to the target's scroll range. All geometry is CSS pixels in one
  screen coordinate system; each pane's own scroll container converts once.
  CodeMirror's `documentTop`, `scaleY` and padding are part of that conversion.
- A pure `ScrollIndex` sorts anchors by source offset; a pure
  `scrollCorrection()` collapses equal-height rows, chooses the nearest row to
  the reference, interpolates only between compatible rows in the same region,
  refuses a slope through a column/page/reset or a source discontinuity, and
  holds the last alignment when no safe pair is within the bounded
  neighbourhood. Equal rows are intervals with a stable representative.
- Typst Pages exposes only the **accepted** word links that already drive
  selection. `TypstPageMap` returns immutable source/PDF identities; the PDF
  adapter converts them with each page's shell, fit and text-layer rectangles.
  Regions are page/band/column reading regions. A two-column transition is one
  deliberate reposition; the reverse direction retains the last region while it
  is visible, starts with the first visible body region without context, and
  uses an explicit wheel over a body column to choose another column. A wheel
  also triggers the correction when the pane is already at the page top and the
  scroll offset would not change.
- A pointer is one-shot and expiring. A wheel event sets it; a bookmark or a
  refinement read must not consume it. A correction queued before a newer
  gesture is discarded by the input epoch and by the active-drag state, so a
  selection reveal cannot be pulled away by a pending follow.
- Flowing previews add strict word anchors from the existing word maps and
  measure their wrapped rectangles. The whole-block interpolation remains the
  fallback when a fragment is atomic, transformed, generated, ambiguous or not
  in the current DOM. Selection fallbacks and block fallbacks are explicitly
  not fine geometry.
- The HTML guest keeps its opaque-origin sandbox. The host sends only bounded
  decoded identities and receives bounded geometry; source offsets never enter
  the guest. The iframe's CSS zoom is carried on the layout and geometry, so
  guest CSS pixels are converted to host pixels and back for both the fine and
  coarse paths.
- Work is coalesced to one animation frame, geometry is read before it is
  written, indices are built per render, and no compilation, filesystem IPC,
  network request or full-document text search runs on the scroll path.
- Render/session tokens, the source snapshot and the input epoch invalidate
  replies and corrections. Scroll changes offsets only; it never moves the caret,
  focus or selection, and there is no smooth animation.

The existing Sync scroll preference, Split-only operation, keyboard reveal,
click blink, selection semantics, PDF export and settings schema are unchanged.
No compiler, package, Tauri command or migration is added.

## Consequences

The 100% content-pair measurements after the change are 0.13/0.30 px median/p95
for Markdown and AsciiDoc, 0.11/0.20 for Typst Document, 0.19/0.85 for Typst
Pages (maximum 1.14) and 0.16/0.29 for HTML. The source direction at 50, 150 and
300% settles below 0.4 px. Pages now has a deterministic column handoff, tab
placement survives a re-render, and the HTML guest follows the document zoom
without mixing guest and host pixels.

The limits are deliberate. Formulas, generated text, macro expansions,
different-line-width wrapping, page margins, inter-page gaps and
indistinguishable repeated passages may have no verified pair; the panes then
hold or fall back to the bounded block path rather than inventing a destination.
Vertical position alone cannot distinguish two columns, so the reverse branch
needs the reader's established region or an explicit gesture. The reverse
direction at a non-100% zoom is not asserted by the Node suite because its
chosen pair lives inside the guest probe; the 100% matrix asserts both
directions. A compiler-span integration would widen provenance but is a separate
architectural project, not a flag on the current CLI.

The decision extends `2026-10-18-typst-pdf-pages.md` (the PDF/window contract),
`2026-10-20-block-sync-fallback.md` (the safe block path) and
`2026-10-22-selection-highlighting.md` (verified correspondence), and it respects
`2026-10-25-document-zoom-model.md` (zoom is a layout scale, not a new
coordinate system).
