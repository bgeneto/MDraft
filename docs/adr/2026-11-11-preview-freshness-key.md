# A preview is current when its freshness key matches, not when a render token says so

**Status:** accepted
**Date:** 2026-11-11

## Context

The pane learned that it was out of date only as a side effect of
`renderToken`: every `scheduleRender` bumped it, and every renderer rebuilt.
Three things followed, all measured at the IPC boundary by
`scripts/preview-freshness-test.mjs` against the build before the change:

- a theme toggle on a `.tex` tab started 2 LaTeX renders, the syntax palette 4,
  the content width 2, and an `.html` tab installed 3 new guests — none of them
  inputs of the output;
- a save of a LaTeX buffer the preview already showed, an edit undone before the
  debounce ran, and a move between chapters of one project each recompiled the
  whole project;
- the only reuse in the app, `lastTypstRender`, was per-tab and Typst-only.

`latex_project_snapshot` already returned `generation`, SHA-256 over the path and
content of every file the compile reads with the open buffers overlaid, plus the
local library revision. Nothing in the frontend read it.

## Decision

Every successful commit records a freshness key built by
`src/preview-freshness.ts`, one function per language whose parameters are
exactly that output's inputs:

- Markdown/AsciiDoc — session, incarnation, a 64-bit fingerprint of the text,
  folder, path, math, mermaid;
- HTML — the same identity and text, folder, name, scripts, allowed roots;
- Typst — identity, **revision**, path, text, view, image root (the revision
  stays until the compiler's disk dependencies are fingerprinted);
- LaTeX — root identity, the snapshot's `generation`, and the engine identity.

`commitPreview(owner, key)` stores it as `committedKey`. A render whose wanted
key equals it, under an owner that covers the active document, rebinds instead of
building: word map, render token, active chapter, warnings and status. The key is
cleared — so the next render builds — by a retirement, an HTML guest reset, any
failure or note commit, Compile, and an engine or library change.

The theme is not an input. A theme change redraws mermaid diagrams in place
(`retheme()`), because PDFs go dark through a CSS filter and code colours are a
stylesheet; the palette and content width are layout.

## Consequences

- A key that misses an input shows an old preview as current. Every input is
  changed one at a time in `scripts/preview-freshness-unit.mjs`; a new input of a
  renderer must be added to its key function and to that test in the same change.
- Settings that only restyle the pane must not call `scheduleRender`. Ask whether
  the compiled output's bytes change; if only CSS does, it is layout, like zoom.
- Compile is a force, not a request: it clears `committedKey` and always builds.
- Keys live only in memory and only for what is on screen. Retaining output
  across a tab switch (a compiled-PDF store, retained preview slots) is the next
  step of `../plans/2026-11-11-preview-freshness-and-cache.md` and reuses these
  keys; it does not need a new identity scheme.
- Typst returns within one revision only. Lifting that needs the compiler's
  dependency list from `render_typst`, an additive command change.
