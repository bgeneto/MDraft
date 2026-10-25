# Document operations belong to a session and a revision

**Status:** accepted
**Date:** 2026-10-25

## Context

Deferred-IO probes reproduced three loss paths in the shell: a save cleared
newer typing and its recovery; an automatic reload replaced typing after its
read began; Save As applied the initiating buffer's result to a different active
tab. Native two-button unsaved prompts also conflated dismissal with discard,
and lossy decoding allowed binary/unsupported text to be rewritten.

## Decision

`src/document-lifecycle.ts` owns operation snapshots, session/destination save
queues, guarded read/write completion and close decisions. It receives IO,
recovery and UI callbacks; the tested controller is the one used by `main.ts`.
The shell keeps editor/view ownership and rendering. Rust keeps filesystem
validation and atomic replacement.

Every session has a runtime-only content revision. Reads validate session,
path, revision, baseline and operation generation before replacing text. Saves
record the exact bytes submitted as the new baseline; later edits stay dirty
and journaled. Save As captures its session before opening the picker and does
not read the saved snapshot back over the live buffer. Another open tab's path
is refused as a Save As destination; buffers are never merged or discarded on
the basis of a stale overwrite confirmation.

Export entry points capture text, title, path, language, write format and image
root before their first await. HTML, Print and Pandoc assembly consume that
snapshot through picker, renderer and tool-lookup delays; they never reread the
active tab to complete an already started export.

Closing uses explicit Save/Discard/Cancel results. Bulk/window operations
collect decisions before removing tabs or journals, revalidate them before
commit, and cancel on dismissal, failed saves, conflicts or newer revisions.
Only the short close-commit phase makes the document surface inert. Preferences
retains its independent non-modal behavior.

Rust refuses binary, invalid UTF-8 and UTF-16/32 input before normalization and
validates existing write destinations. UTF-8 BOM/EOL behavior and command
payloads remain unchanged. Legacy lossy recovery is retained; Auto Save is
blocked and manual saving offers an acknowledged UTF-8 copy. Atomic writes use
exclusively created, unique temporary siblings.

## Consequences

Delayed IO is tested deterministically without freezing normal typing or
depending on the active global tab. Runtime revisions must be incremented for
background transformations as well as live changes and undo/redo. Recovery
cleanup is part of the operation rather than an unconditional success side
effect.

No settings/recovery migration, new dependency or public command shape is
introduced. Unsupported encodings are refused rather than guessed. Content-based
external disk revision validation and the remaining filesystem check/replace
race stay explicit follow-up work in GAP-032; this decision does not promise
filesystem compare-and-swap across external processes.
