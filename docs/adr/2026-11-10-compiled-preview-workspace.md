# Compiler controls and diagnostics live outside rendered content

**Status:** accepted
**Date:** 2026-11-10

## Context

LaTeX and Typst Pages use the same PDF viewer, but their sticky controls and
error overlays competed with the document. A partial LaTeX PDF required a
second action to view, then appeared underneath a scrollable problems panel.
Typst returned warning headlines but discarded the remainder of successful
compiler output. Readers could mistake diagnostics for generated content.

## Decision

One compiled-preview controller owns a reserved toolbar and a separate Logs
viewport for LaTeX and Typst. A single pressed Logs button replaces the visible
preview; releasing it restores the same viewer and scroll position. Nothing
from the compiler UI is inserted into or over rendered pages. Typst retains
its distinct Document/Pages selector in the toolbar.

The preview's existing scroll element and owner stamp remain authoritative.
Foreign content and logs are retired synchronously during tab changes, through
the existing retirement seam. The waiting spinner, phase and elapsed counter
continue to belong to the active document. Logs does not permit hidden preview
geometry to drive source synchronization.

Readable partial LaTeX PDFs are staged and displayed automatically. They remain
failed builds: they cannot enable successful export, print or correspondence.
Their own Save action uses the displayed bytes, an explicit partial filename
and the captured revision set, rechecked after the save dialog.

Typst compiler stderr is retained up to 64 KiB at a UTF-8 boundary, with an
explicit truncation marker. Both successful render variants carry additive
compiler-output metadata; failures keep their string shape. Typst automatic
compilation has its own default-on preference, backward compatible with older
settings, and uses the existing cancellation command.

## Consequences

- Document typography and zoom affect rendered content, never controls/logs.
- Exactly one content viewport is visible; the hidden viewer remains mounted
  and inert so Logs does not trigger PDF rendering or lose page position.
- The ownership and spinner rules in the preview ownership ADR still apply.
- Compiler warning strings without reliable locations remain non-interactive;
  LaTeX structured diagnostics retain safe explicit source navigation.
- Saving and successful output eligibility are separate checks. A newer partial
  PDF can never cause Save to write older successful output instead.
