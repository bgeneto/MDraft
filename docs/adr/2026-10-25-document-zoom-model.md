# One document zoom is separate from the base font sizes

**Status:** accepted
**Date:** 2026-10-25

## Context

The old zoom commands changed `editorFontSize` by one pixel. In source-only that
was a font-size preference, in Split the preview ignored it, and in Preview-only
the command was disabled because the editor was hidden. The status chip derived a
percentage from the editor size, so it could not describe a rendered page. A
renderer that needed images, Mermaid, KaTeX, HTML or PDF pages to grow had no
state to read.

## Decision

`zoomLevel` is a persisted percentage (50–300 %, 10 % steps, default 100) and is
separate from `editorFontSize` and `bodyFontSize`, which remain the reader's
base preferences. One document zoom applies to the active view:

- Source-only scales the editor text and its line height.
- Split scales both the editor and the preview by the same percentage.
- Preview-only scales the rendered document.

`--preview-zoom` drives the DOM article. The article's `width: 100%` fills the
pane after CSS zoom; `--preview-max-width` carries the Content Width cap divided
by the zoom, because a max-width is a layout length. The HTML guest iframe uses
the same zoom with a 100 % width and height. Typst Pages multiplies the PDF.js
fit by the zoom, re-rasters the canvases at the displayed scale, and enables
horizontal scrolling above 100 %. The Typst Document/Pages switch sits outside
the zoomed article so its buttons stay at 100 %.

Reset changes only `zoomLevel`. A hand-edited file is clamped when applied, but
the stored base font sizes are never rewritten by zoom.

## Consequences

- Old settings files load at 100 % through `serde(default)`.
- A user whose old zoom commands changed `editorFontSize` keeps that value as
  their base size; Preferences still edits it.
- Exports and print do not read `zoomLevel`; their typography remains
  `bodyFontSize` and their page size is unchanged.
- CSS `zoom` must be proved on WebKitGTK; the fallback is a transform and a
  measured wrapper, not a silently Windows-only feature.
- The status chip, menu labels, toast and built-in shortcut text speak of Zoom,
  not font size.
- A future per-document or per-pane zoom is a new decision, not a reinterpretation
  of this one.
