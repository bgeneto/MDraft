# Text files keep their encoding across open, save and compile

**Status:** accepted
**Date:** 2026-11-12

## Context

MDraft refused every file that was not valid UTF-8. The reported thesis is a
2007 LaTeX project whose main file, chapters, bibliography and style files are
Windows-1252, and whose `pacotes.sty` declares `\RequirePackage[latin1]{inputenc}`.
Every included chapter failed with the same "not valid UTF-8" dialog. Converting
the project to UTF-8 would change the bytes the preamble expects and would ask a
reader with no technical knowledge to perform a format conversion.

The document-operation ADR of 2026-10-25 established that Rust owns filesystem
validation and atomic replacement, and that lossy decoding must never authorize
a later write. That ownership stays. This decision replaces only its statement
that invalid UTF-8 and UTF-16 are refused.

## Decision

`src-tauri/src/text_encoding.rs` owns text decoding and encoding. A file is
accepted as UTF-8, as BOM-marked UTF-16LE/BE, or as a `chardetng` legacy guess
only when strict decoding and re-encoding reproduce every input byte exactly.
Real binary signatures and decoded control characters are still refused.

The encoding is part of a document's identity in `DocumentPayload`, `Session`
and the recovery journal. Save writes the same encoding, BOM and line endings.
A character the encoding cannot represent leaves the destination untouched and
offers an explicit UTF-8 copy; there is no silent conversion. LaTeX project
overlays are encoded back before the compiler sees them, and every project file
reports its encoding so diagnostics decode it correctly. The status bar names
the encoding in use.

## Consequences

An unmodified legacy document saves byte-identically, and an edited one keeps
its format. A wrong detector guess cannot corrupt an unedited save because the
round-trip check rejects it; the status bar makes the choice visible, and a
manual "Reopen with Encoding" picker remains the next GAP-021 slice. UTF-32 and
BOM-less UTF-16 remain refused with an explanation. Files whose new text no
longer fits the original encoding need the explicit UTF-8 copy, which is a
document change rather than a hidden side effect. Every future command that
reads or writes a text document must use the shared module instead of assuming
UTF-8.
