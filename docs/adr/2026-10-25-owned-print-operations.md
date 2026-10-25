# Own PDF output and keep print surfaces alive for their full operation

**Status:** accepted
**Date:** 2026-10-25
**Supersedes:** `2026-10-25-native-print-surface.md`

## Context

The corrective review reproduced deletion of an existing PDF after driver
failure, scripts executing inside encoded child frames, and competing requests
destroying each other's single-label print surface. Real Ctrl+P reached the
native API but immediate surface disposal prevented usable print UI.

## Decision

Rust serializes native print/PDF jobs. A direct PDF job reserves an exclusive
temporary sibling on the target volume, writes there, validates the PDF header
and final envelope marker, then renames over the destination. Failure cleans
only that owned sibling. Envelope validation is intentionally not a full PDF
parser; Poppler validates real output in tests.

The native article has a first-position CSP blocking document scripts, frames
and objects. Rust owns the initial doctype/head boundary instead of scanning an
untrusted doctype for its first `>`; quoted identifiers cannot swallow the policy.
Navigation is confined to its own article and initial blank page.
Host-injected readiness instrumentation remains separate from document scripts.
The surface has no Tauri capability. Parsed HTML detection routes active content,
including child frames and encoded active URLs, to the explicit browser fallback.

Direct PDF keeps its surface hidden. Print uses a visible owned preview window.
On Windows, `ShowPrintUI` returning is not accepted as evidence that the user
finished printing. Its surface stays alive until the reader closes the preview
window, whose title explains this. Windows reports only a dialog interaction,
not a selected path or a claimed print-versus-cancel result. Linux uses GTK's
dialog response; bounded GTK pumping also limits silent PDF operations.

Retain all three PDF entries: preview-faithful native PDF, browser printing,
and typeset/direct Typst PDF. Existing command names, settings and format IDs
remain compatible. Generated publication URLs use explicit HTTPS for `//host`
network references; backslash UNC paths retain file semantics.

## Consequences

The single-operation queue remains occupied while its print preview is open.
Close that preview to allow queued work to continue. Destination files survive
preparation, writing, verification and replacement failures. Print warnings
still report missing resources. Browser handoff cannot report its final output
path, and Typst documents retain their compiler-owned route.

No unprivileged print window may acquire a capability in future changes. Tests
must exercise actual UI lifetime and adverse content, not just API return codes.
