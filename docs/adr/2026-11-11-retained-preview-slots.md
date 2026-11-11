# A hidden tab keeps its preview in a slot, and a return restores it before rendering

**Status:** accepted
**Date:** 2026-11-11

## Context

The ownership ADR (`2026-11-10-preview-pane-ownership.md`) made the pane retire
another document's content at the tab switch, and named per-tab preview slots as
the cleaner end state it did not build. With freshness keys
(`2026-11-11-preview-freshness-key.md`) the pane can tell when output is
current, but a retirement still destroyed it: returning to an unchanged `.tex`
tab took a snapshot and a full compile, a `.typ` tab started the compiler again,
and a Markdown tab ran the worker, KaTeX and mermaid again.

## Decision

- Compiled output is kept in a byte-bounded LRU store (`src/preview-store.ts`,
  96 MB) under its freshness key: LaTeX results and Typst results. A hit skips the
  compiler and runs the normal draw-and-commit tail. Typst sources that read any
  other file are never stored, because the key cannot see that file.
- The live preview of the three most recently hidden tabs is kept in a
  `PreviewSlot`: the article DOM or the PDF view, plus the state that makes it
  rebindable. `invalidatePreview` parks it before retiring; `displayDoc`
  restores it for the same incarnation and language, then renders as usual. The
  render's key check rebinds — or rebuilds over it when an input changed while
  the tab was hidden.
- A parked PDF view is detached: it stops observing the pane and cannot scroll
  it, and its page canvases are unpainted by its IntersectionObserver.
- HTML guests are not parked. Moving an iframe reloads it, and keeping a hidden
  one alive keeps the document's scripts running.

## Consequences

- The owner rule is unchanged: a restored slot carries its owner, so nothing
  foreign is ever shown, and the waiting surface still covers a tab without a
  slot.
- Memory is bounded by the store's budget plus three slots. A slot holds a
  parsed PDF, not its pixels.
- Any new per-document preview state in `main.ts` must be added to
  `PreviewSlot` (park and restore), or a restored preview will rebind against
  another tab's state. The LaTeX root memory (`latexPreview`,
  `latexNavigationRoot`) is the example: the slot brings back the tab's own.
- Manual-compile mode shows stored output on a tab return, because output whose
  key matches is current; it still never compiles on its own.
