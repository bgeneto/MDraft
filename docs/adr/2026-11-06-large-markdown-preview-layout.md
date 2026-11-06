# Keep large independent Markdown paragraphs in deferred-layout groups

**Status:** accepted

**Date:** 2026-11-06

## Context

On the Windows reference host, swapping a 10.8 MB CRLF file with 72,000
paragraphs into the preview caused sampled input delays of up to 943–953 ms.
The worker alone cannot prevent the webview from laying out the resulting DOM.
Removing off-screen content would change browser search, selection and
accessibility contracts.

## Decision

The live Markdown preview may group at least 10,000 independently rendered
paragraphs into containers of 64 blocks, after each batch is sanitized. Every
paragraph and its source-line anchor remain in the DOM. The containers use
`content-visibility: auto` with an estimated intrinsic height; these styles are
assigned to the created containers, so raw HTML cannot acquire them just by
using the same class name. The optimization
is used only when the parser reports no raw HTML, every nonempty chunk is a
paragraph, the line count matches and the webview supports the CSS feature.
Unexpected sanitized nodes or a line mismatch flatten the staging tree back to
the ordinary representation. Exports retain their original ungrouped tree.
Word and scroll maps are built in generation-cancelable slices, and become
visible together only after they are complete.

## Consequences

The initial height is an estimate and layout can still be expensive on extreme
documents, large indivisible blocks, or unsupported webviews. Changes to preview
styles, source anchors or navigation must test group boundaries, zoom, search,
selection, scrolling and accessibility. This does not virtualize or remove DOM
nodes; memory remains proportional to the document and its maps. Rollback can
remove grouping while retaining the independent worker and path fixes.
