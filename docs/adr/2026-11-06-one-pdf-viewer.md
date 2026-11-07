# The PDF page viewer stays one source-neutral component

**Status:** accepted
**Date:** 2026-11-06

The LaTeX-specific SyncTeX lookup below is superseded by
[`2026-11-07-pdf-correspondence-and-lifetime.md`](2026-11-07-pdf-correspondence-and-lifetime.md).
The decision to share one PDF viewer remains in force.

## Context

The Typst Pages view draws the compiler's PDF with PDF.js and maps a click back
to the source line that produced it. The LaTeX experiment needed the same thing:
draw a PDF, select its text, click a location to reach the source.

The obvious shortcut was a second viewer for LaTeX. That would have duplicated
page lifecycle (create, dispose, cancel), zoom, the text layer, selection
geometry, the sync highlight, Escape handling and the reduced-motion behaviour —
roughly the whole of `src/typst-pdf.ts` — and left two places to fix every future
PDF bug. It would also have made the word-sync and scroll-sync work
language-specific by construction.

## Decision

One viewer, source-neutral, in `src/typst-pdf.ts`. It draws a PDF and reports
page coordinates; what those coordinates *mean* is the caller's business.

The per-language part is a source-lookup callback, not a second component:

- Typst supplies its prose index (`src/typst-page-map.ts`) and the line
  annotation the Document view already uses.
- LaTeX supplies `latexSourceAt` on the SyncTeX result, which resolves a page
  coordinate to a file and line. It fails closed on ambiguity, exactly as the
  Typst map does: a region that maps to several lines paints nothing rather than
  guessing.

`showRegions` already existed for the Typst map and is reused for LaTeX, so the
highlight, the blink and the "never take the editor's selection" rule are one
implementation.

## Consequences

- A future PDF-rendered markup adds a lookup function, not a viewer.
- The viewer cannot assume its document is Typst: anything that reads the source
  through a language-specific path must go through the callback. A shortcut that
  reaches for `doc.language === "typst"` inside the viewer would reintroduce the
  duplication this decision exists to prevent.
- SyncTeX maps one region to several lines more often than the Typst prose index
  does, so the fail-closed rule matters more here: an ambiguous LaTeX click
  paints nothing, and the reader clicks a narrower spot.
- Bidirectional Sync Scroll for LaTeX is a second implementation behind the
  viewer's interface, not a change to the viewer.
