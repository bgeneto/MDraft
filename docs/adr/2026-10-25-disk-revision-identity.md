# A disk revision is identified by the SHA-256 of its raw bytes

**Status:** accepted
**Date:** 2026-10-25

## Context

GAP-002's external-change guard compared a remembered `mtime` and size with a
fresh stat before an in-place save. A probe showed the obvious limit: different
bytes with the same length and a restored timestamp were classified as
`unchanged`, so a manual save or Auto Save could overwrite them. The stat and
the write were also separate IPC commands, leaving an external writer free to
land between the check and the replacement.

Metadata cannot answer "are these the bytes I read?" and no portable filesystem
compare-and-swap exists for ordinary documents, especially on network shares.
The check had to move next to the write and compare content.

Measured with the `sha2` dependency already used for download verification, on
this host and a warm cache: 2,534 bytes in 35 µs, 44,563 bytes in 12 µs, and
10 MiB in 2.3 ms. Reading the file is the larger cost for a large document, and
the check runs only on open, save and explicit Keep my version — never on the
2.5 s disk poll.

## Decision

The identity of a disk revision is the SHA-256 of the file's raw bytes, before
BOM stripping and line-ending normalisation. A document payload carries
`sha256`; a session keeps it beside `modifiedMs` and `size`; a recovery entry
keeps the digest of the revision it was journaled from (`baseSha256`, optional
so older journals load).

The editor saves through `write_document_checked`, which receives the expected
digest and validates it inside the Rust command:

1. once before creating a temporary sibling;
2. again immediately before the rename.

A mismatch returns `written: false` with `change: "modified"` or `"deleted"` —
a normal conflict, not an I/O error — and leaves the reader's text, dirty state
and recovery entry untouched. A match returns the digest of the bytes actually
written, including the restored BOM and EOL, which becomes the next baseline.
`fingerprint_document` supplies the current digest for **Keep my version**.

`write_document` keeps its existing signature and behaviour for callers that
have no baseline, such as HTML export. Polling stays stat-based. The remaining
interval between the second read and the rename is documented; it is narrower
than the previous stat-then-write window and fails safe, but it is not a
filesystem compare-and-swap.

## Consequences

- Hashing is part of open, save and Keep my version; it is not part of polling.
- A recovered buffer is checked against the revision its journal recorded, not
  against whatever is on disk after the crash. Journals from older builds have
  no digest and keep the stat guarantee for their first launch.
- BOM and EOL changes are different revisions, because the digest is taken
  before decoding.
- `DocumentPayload`, `RecoveryEntry` and the command table gained additive
  fields/commands. Old settings and old journals still load; the existing
  `write_document` contract is unchanged.
- No lock is taken and no absolute compare-and-swap is promised. A conflict is
  always safe (it refuses and asks), but a rare race can still let an external
  writer replace the target after the final check.
- A future change must not move validation back to a separate command or to
  the frontend: the raw bytes are only available in Rust.
