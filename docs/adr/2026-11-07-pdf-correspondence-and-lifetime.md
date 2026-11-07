# PDF correspondence uses verified text links without SyncTeX

**Status:** accepted
**Date:** 2026-11-07

## Context

SyncTeX linked LaTeX lines to PDF regions but could not verify the exact word
selected, and the inverse selection path did not paint the source. The user also
reported that PDF rebuilds could discard the reading position. In the measured
offline probe recorded in the associated plan, SyncTeX added 20,390 bytes for
the reference and 77,353 bytes for a 16-page prose document, plus read and parse
work. Three-run median compilation differences were small on those fixtures;
they do not establish the cost for larger documents or peak memory.

## Decision

The shared PDF.js viewer matches literal source prose and supported math tokens against its text layer.
Both selection directions and scrolling use the same accepted word links.
LaTeX candidates come from the pinned syntax service, with conditional regions
excluded and project files restricted to reachable literal includes. Matches are
heuristic, not TeX execution provenance: ambiguous, generated or unsupported
content must not be presented as a verified word. MDraft does not inject,
request or read SyncTeX. An author's explicit `\synctex` remains untouched.

Standard `verbatim` and `verbatim*` bodies contribute literal word candidates.
A restricted math reader also exposes safe literal tokens; a unique inline or
display equation is mapped as one atomic source range. A superscript or
subscript emitted by PDF.js on an immediately adjacent text line is accepted
only when its token is unique in the same reading region. Other split,
macro-expanded, duplicated or transformed equations stay unmapped.

Pure parsing and matching run in a cancellable worker; DOM range binding and
scroll-region preparation yield in batches. PDF text and copying remain usable
when mapping cannot run or exceeds the configured limits. A replacement PDF is
prepared while the previous one remains visible, and its viewport is restored
using the latest reading position and, where valid, a source bookmark.

## Consequences

The approach removes MDraft's SyncTeX generation and parser cost from ordinary
compiles but gives up SyncTeX's geometric evidence for figures, unsupported math
and macro-generated text. An author-written `\synctex=1` can still ask the
engine to generate a virtual sidecar; MDraft ignores it. It cannot promise
provenance for arbitrary TeX programs. Worker failure and
large inputs leave the PDF usable without correspondence rather than moving an
unbounded parser to the UI thread. Changes to matching must preserve file and
snapshot ownership and reject uncertainty; changes to PDF lifecycle must keep
typing, selection, copy and manual scrolling responsive during replacement.
