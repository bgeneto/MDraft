# Preview content belongs to an owner and foreign content is removed

**Status:** accepted
**Date:** 2026-11-10

## Context

Every renderer builds off-screen and swaps on success, so a reader editing a
document keeps the last readable output while it is rebuilt. That stale-while-
revalidate behaviour is what the LaTeX progress work depends on: a failed
compile keeps the previous PDF under the problem list, and a rebuild at the tail
keeps the viewport.

The same rule was applied across tab switches, where it is wrong. Switching from
Markdown to a `.tex` tab left the Markdown document on screen for the whole
LaTeX build — minutes when packages download — under a status strip that said
"Compiling LaTeX…". The strip describes the build, not the pane's content, so it
never contradicted what the reader saw. Nothing recorded whose output was on
screen, so nothing could tell a rebuild of the same document from another
document's content.

Two smaller defects shared the cause: `commitPdfHost` mapped the previous PDF's
scroll bookmark into a new one even when the previous PDF belonged to another
document, and a switch made in Source mode left the old DOM mounted until the
next render.

The HTML preview already had the right rule: `syncGuest` resets the guest when an
HTML tab is entered and disposes it on exit, so a frame never survives into
another document.

## Decision

Preview content has an owner: either the document at one incarnation, or a LaTeX
project (the root session plus the set of files the compile contained). Every
commit stamps its owner. Every path that changes the active document calls
`invalidatePreview`, which retires the pane unless the new active document is
covered by the stamped owner.

Within one owner the last good output stays while it rebuilds, because an edit
or a re-render does not change the owner. Across owners it is removed, never
dimmed or labelled: content that is still in the DOM is selectable, searchable
and read by screen readers, so an overlay would only hide the symptom.

While the pane has no content for the active document, a waiting surface fills
it: title, phase, a spinner, and elapsed time after a threshold. It carries no
controls; Cancel, Compile and Auto-compile remain on the existing status strip.
The surface is a sibling of `#preview`, not a child, so Document Zoom cannot
scale it.

Per-tab preview slots are recorded as the direction, not implemented here.
`main.ts` touches `preview`/`previewPane` in about 120 places (anchors, word map,
scroll sync, outline, zoom, selection marks); the owner stamp and
`retirePreview()` are the seam a slot implementation replaces.

## Consequences

- A tab switch costs a fresh render for Markdown, AsciiDoc and Typst, and a
  fresh compile for LaTeX. Returning to an unchanged LaTeX tab rebuilding from
  scratch is accepted until a compile-output cache keyed by the compile inputs
  lands as its own change.
- Markdown to Markdown can show an empty pane for one worker round-trip where it
  used to show the previous document. The waiting surface only appears after
  150 ms, so this window is normally invisible; retaining rendered Markdown per
  tab is the first step of the per-tab slot direction.
- Moving between a project's root and a chapter keeps the project's PDF in both
  auto and manual mode. Moving to an unrelated `.tex` retires it. A failure
  panel belongs to the failed project's file set, so opening a chapter of that
  project keeps the problems visible.
- `latexPreview` must not be cleared by retirement: it is also the project-root
  memory that decides which file a chapter compiles against. Manual mode used to
  clear it on every switch; that block is gone.
- The rule is safe to extend per format: a renderer commits only through
  `commitPreview`, and a new language needs only an owner at its commit site.
- Anything that later retains content across owners must keep the pane's
  accessibility tree honest, which is why removal, not opacity, is the rule.
