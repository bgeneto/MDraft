# Open and save legacy-encoded documents without loss

**Status:** done
**Approval:** explicit user approval on 2026-11-12; execution may proceed.
**Date:** 2026-11-12
**ADR:** [Text files keep their encoding across open, save and compile](../adr/2026-11-12-text-encoding-round-trip.md)
**Backlog:** GAP-021 (UTF-16 slice and the broader-encoding slice)
**Basis:** the reported `C:\Users\bernh\Documents\LaTeX\tese\tese.tex`, its
included chapters and bibliography, and the current `read_document` guard

## Context and goal

Opening the reported thesis fails before a tab is created:

> This file is not valid UTF-8. Convert a copy to UTF-8; opening it lossily
> could destroy its original characters.

The refusal is working as designed today, but the design is wrong for ordinary
legacy projects. `tese.tex` is Windows-1252 (Latin-1), not UTF-8. Its bytes use
`0xE7` for `ç`, `0xE3` for `ã` and `0xF4` for `ô`. The same is true of
`cap01.tex` through `cap05.tex`, `apendiceA.tex`, `apendiceB.tex`,
`agradecimentos.tex`, `resumo.tex`, `dedicatoria.tex`, `epigrafe.tex`,
`aprovacao.tex`, `comandos.sty`, `pacotes.sty`, `siglas.sty`,
`tabela-simbolos.sty` and `bibliografia.bib`. A few files (`abstract.tex`,
`index.sty`, `ziffer.sty`) are ASCII-only and therefore valid UTF-8. The project
declares its intent in `pacotes.sty`:

```tex
\RequirePackage[latin1]{inputenc}
\RequirePackage[T1]{fontenc}
```

Every included file is opened through the same `read_document` call, so fixing
only the main file would leave `cap01.tex` and the rest failing in exactly the
same way. A compile also reads those files without opening tabs, so fixing only
the editor path would still corrupt the bytes a compiler or conversion sees.

Converting the project to UTF-8 is not a correct fix. It changes the bytes the
2007 preamble tells TeX to expect, can break the build, and asks a reader with
no technical knowledge to perform an encoding conversion. The application should
decode the file for display, remember the encoding, and write the same encoding
back. That is also what makes “open and press Save” safe.

The goal: open the main file and every chapter or bibliography with the right
characters, save each one byte-identically when its text has not changed, and
hand the compiler each file in its original encoding.

## Scope and non-scope

**In scope**

- Per-file decoding, in this order:
  1. reject UTF-32 with the existing explanation;
  2. honour a UTF-8, UTF-16LE or UTF-16BE byte-order mark;
  3. accept strict UTF-8 without a BOM;
  4. for bytes that are not valid UTF-8, detect a legacy encoding with
     `chardetng`;
  5. verify that decoding and re-encoding reproduces the original bytes exactly
     before accepting the file.
- Keep refusing real binary files: PDF/ZIP/PNG/GIF/JPEG/RIFF signatures, NUL
  bytes and control characters in the decoded text.
- Carry a canonical encoding label through the document payload, session,
  recovery journal, status bar and save path. The status bar stops claiming
  every document is UTF-8.
- Save in the document's own encoding, preserving BOM and line endings. A
  save that cannot represent the editor text in that encoding writes nothing
  and offers an explicit UTF-8 copy instead.
- Include files:
  - opening a chapter or `.bib` file detects its encoding independently;
  - the LaTeX project snapshot carries each file's encoding;
  - open buffers (overlays) are encoded back to their original encoding before
    the compiler sees them;
  - both the bundled engine and the installed-TeX diagnostics decode each
    source with its own encoding.
- Rust unit fixtures for Windows-1252, UTF-16LE/BE, UTF-8 BOM, invalid bytes
  and unmappable save text.
- A real-UI round-trip test using a temporary copy of the reported project:
  open the main file and a chapter, verify accents, save without edits, and
  compare every source file's SHA-256 before and after.
- Reader documentation, agent-guide architecture/catalog updates and any trap
  discovered while implementing this.

**Out of scope**

- UTF-32 support. It remains refused with an encoding explanation because
  `encoding_rs` has no UTF-32 codec.
- UTF-16 without a byte-order mark, and “Reopen with Encoding…” / a manual
  encoding picker. The automatic detector plus byte-for-byte round-trip is this
  slice; a picker is the next GAP-021 slice if a real misdetection appears.
- Automatic in-place conversion to UTF-8, and changing the read-only attribute.
  An encoding change is a document change and must be an explicit copy.
- A new large-file policy, workspace search, or changes to binary open/drop
  classification beyond what encoding decoding requires.
- Making pandoc's LaTeX reader honour legacy input encoding. Export keeps the
  raw project bytes; pandoc 3.8.3 was measured on the reported `tese.tex` and
  warns `is not UTF-8 encoded: falling back to latin1`, so no transcode is
  needed for this slice. A future pandoc without that fallback is a separate
  follow-up.
- The existing `lossy` recovery compatibility path. Old journal entries keep
  loading; new entries never produce replacement characters.

## Approach and rejected alternatives

### Chosen approach

Add one small Rust module, `text_encoding.rs`, owning decode, encode and
canonical labels. `documents.rs`, `latex.rs` and `recovery.rs` use it instead of
each having their own UTF-8 assumption.

Decoding is deliberately conservative:

1. UTF-32 BOMs are identified before NUL classification and refused as an
   unsupported encoding, not as a binary file.
2. `Encoding::for_bom` handles UTF-8/UTF-16LE/UTF-16BE. A BOM is authoritative.
3. Valid UTF-8 without a BOM is accepted as UTF-8.
4. Otherwise `chardetng` guesses a legacy encoding. UTF-8 is disallowed as a
   guess because valid UTF-8 was already handled. ISO-2022-JP is disabled:
   this is source code and prose, not email.
5. The guess is accepted only if strict decoding reports no malformed bytes,
   the decoded text contains no control characters, and re-encoding the text
   produces exactly the input bytes. If not, the file is refused with a
   binary/unknown-encoding message. This is the property that makes an
   unmodified Save byte-identical rather than merely “looks right”.
6. If `chardetng` guesses Windows-1250 but Windows-1252 decodes the same bytes
   to the same text, Windows-1252 is preferred. The reported Portuguese files
   hit this case: every non-ASCII byte they contain maps identically in both
   encodings, but a later `ã` would not.

Saving uses the same module. For UTF-8, UTF-16LE and UTF-16BE the encoder adds
the remembered BOM. `encoding_rs` has no UTF-16 encoder, so UTF-16 is written
from `String::encode_utf16()` with explicit little/big-endian bytes; this is a
trap to record. For every other encoding, `Encoding::encode` must report no
unmappable character. If it does, no temporary file is created and no disk
bytes change.

`DocumentPayload` gains `encoding`. `Session` gains `encoding` and a runtime
`encodingBlocked` flag; `RecoveryEntry` gains an optional `encoding`, so an old
journal loads as `None` and the caller supplies the UTF-8 or disk fallback.
`write_document` and `write_document_checked` gain an optional `encoding`
argument, omitted by old callers and defaulting to UTF-8. The checked writer
returns `written: false, change: "encoding"` for an unmappable character,
following the existing conflict convention rather than adding a second error
channel. The unchecked writer is used by export paths that always pass UTF-8,
so it keeps its `SavedInfo` return and reports an unmappable character as an
ordinary error.

The LaTeX overlay gains `encoding`, `hadBom` and `lineEnding`. `latex_project_snapshot`
encodes each overlay with the session's encoding and reports a clear compile
error if the unsaved text no longer fits it. Each `ProjectFile` also reports
the encoding detected from its bytes. The bundled compiler receives UTF-8
sources as strings and legacy sources as raw bytes; reference scanning and
diagnostics use the decoded text. The installed-TeX adapter uses the same
per-file decoding for its line labels. This is what keeps `cap01.tex` correct
without requiring the reader to open it first.

### Rejected alternatives

- **Ask the reader to convert a copy to UTF-8.** The reported UX and the
  project's `inputenc[latin1]` both rule it out. It also makes every include a
  separate manual task.
- **Open with `String::from_utf8_lossy` and warn.** Replacement characters are
  data loss, and saving would rewrite bytes the reader never changed.
- **Convert every legacy file to UTF-8 on open or save.** It breaks the
  document's declared encoding and is an unrequested file-format change. The
  added characters may even be inside a macro whose source bytes matter.
- **Fall back to Windows-1252 only.** It fixes this thesis but silently
  misreads Shift_JIS, GBK, Big5 and other legacy projects. `chardetng` is the
  small, pure-Rust detector built for this, with no C build and no network.
- **Trust the detector without a round-trip check.** A wrong guess that
  re-encodes differently would corrupt the file on the next Save. Rejecting
  any candidate that does not round-trip is the safety boundary.
- **Fix `read_document` only and leave the LaTeX snapshot UTF-8.** The main
  file and every included chapter would compile as mojibake even though the
  editor looked correct.
- **Use a user-selected encoding for every file.** It is the right fallback
  for a genuinely ambiguous file, but making it the default repeats the manual
  problem. Automatic detection with a future override is the better order.

## Steps

- [x] Add `encoding_rs` and `chardetng` to `src-tauri/Cargo.toml`; add
      `text_encoding.rs` with decode, encode, canonical label and byte-round-trip
      helpers plus unit tests.
- [x] Replace `validated_text` in `documents.rs` with the shared decoder, add
      `encoding` to `DocumentPayload`, and add optional `encoding` to both write
      commands. Return the non-destructive `change: "encoding"` outcome.
- [x] Add `encoding` to `RecoveryEntry` (Rust and TypeScript) as an optional
      value (old journals load without it), and persist/restore it through
      `recovery.ts`, `sessions.ts` and `main.ts`.
- [x] Carry `encoding` through `api.ts`, `document-lifecycle.ts`, the status
      bar, Save/Save As/Auto Save, reload, conflict metadata updates and
      recovery restore. Add the runtime `encodingBlocked` notice and the
      “Save a UTF-8 copy…” action.
- [x] Extend `latex.rs` overlays with `encoding`/`hadBom`, report each
      `ProjectFile`'s encoding, encode overlays before compilation, and use the
      shared decoder for reference scanning. Fail a compile with a named file
      when unsaved text cannot be encoded.
- [x] Update `latex.ts`, `latex-native.ts` and `main.ts` so bundled sources,
      installed-TeX sources, reference validation and diagnostic line text use
      each file's reported encoding.
- [x] Update the reader guide, architecture/code map, test catalog and any trap
      entry. Update `AGENTS.md` test counts only if a layer's count changes.
- [x] Run the Rust tests and the affected app-free/UI layers; then exercise a
      temporary copy of the reported thesis and record the before/after hashes.

## Files and modules

| File | Why it changes |
| --- | --- |
| `src-tauri/Cargo.toml` | Adds `encoding_rs` (already in the lock through reqwest's `charset` feature) and `chardetng` (~56 KB source, Apache-2.0/MIT). |
| `src-tauri/src/text_encoding.rs` (new) | One owner for BOM delivery, strict decoding, legacy detection, control validation, BOM/EOL-aware encoding and the round-trip guarantee. |
| `src-tauri/src/lib.rs` | Declares the new module. |
| `src-tauri/src/documents.rs` | Payload encoding, decode-on-read, encode-on-write, destination validation and the encoding refusal outcome. |
| `src-tauri/src/recovery.rs` | Persists the per-buffer encoding; old entries load with no field and use the disk/UTF-8 fallback. |
| `src-tauri/src/latex.rs` | Per-file encoding and line ending in overlays and snapshots; re-encodes unsaved buffers before the compiler sees them. |
| `src/api.ts` | Payload/recovery/write contracts and the `"encoding"` change value. |
| `src/sessions.ts` | `encoding` and runtime `encodingBlocked` on every document. |
| `src/document-lifecycle.ts` | Passes the encoding to writes and reports an unmappable save without touching disk. |
| `src/recovery.ts` | Journals the encoding. |
| `src/main.ts` | Status bar, open/reload/restore, Save As copy action, notices, LaTeX overlays and export snapshots. |
| `src/latex.ts` | Decodes each project source for validation/diagnostics while handing legacy bytes to the compiler. |
| `src/latex-native.ts` | Decodes installed-TeX diagnostic sources with each file's encoding. |
| `scripts/p0-unit.mjs`, `scripts/p0-lifecycle-test.mjs`, `scripts/latex-*.mjs` | Fixtures and acceptance checks for sessions, recovery, opening/saving and project snapshots. |
| `docs/guide.md`, `docs/agent-guide/architecture.md`, `docs/agent-guide/catalog/*.md`, `docs/agent-guide/traps/*.md` | Reader behaviour, code map, test descriptions and any non-obvious lesson; the UTF-16 encoder limitation is documented in `text_encoding.rs` itself. |
| `docs/adr/2026-11-12-text-encoding-round-trip.md` (new) | Durable decision: bytes round-trip, the original encoding is the default, and conversion is explicit. |

## Risks and rollback

- **A wrong detector guess could still show mojibake.** It cannot corrupt an
  unedited save because the round-trip check must pass. An edited save could
  write the wrong interpretation; the status bar makes the encoding visible,
  and the manual picker is the next GAP-021 slice. The initial implementation
  should prefer refusing an ambiguous candidate over opening it with a label it
  cannot reproduce.
- **Binary data that happens to decode as Windows-1252.** The control-character
  and signature checks reject the common cases. The round-trip check does not
  make random binary meaningful, so the validation order stays: signatures,
  UTF-8, detector, decoded-control check, round-trip.
- **UTF-16 encoding is not in `encoding_rs`.** Using `Encoding::encode` on
  UTF-16 would silently produce UTF-8 through its output-encoding rule. The
  dedicated UTF-16 encoder and byte tests prevent that. Record it as a trap.
- **wasmtex may treat the main file differently from other inputs.** It accepts
  `Uint8Array` for every file; the project suite must prove that a legacy main
  file and a legacy chapter both compile or fail with a named engine
  compatibility message, never silently as UTF-8.
- **A conversion or export may disagree with the editor.** The snapshot keeps
  raw bytes; the test checks the snapshot bytes, not just the visible text. If
  pandoc mojibakes a legacy project, record it as a separate export gap rather
  than converting the user's project in place.
- **Read-only source files.** Several thesis sources carry the Windows
  read-only attribute. The application continues to respect it and opens them
  read-only; the fix is not permission to rewrite the filesystem. The test uses
  a writable temporary copy.
- **Rollback.** Revert the branch or the individual files. Old recovery
  journals load with no encoding field and fall back to the disk document or
  UTF-8; old `write_document`
  callers keep working because `encoding` is optional. No settings schema or
  menu event changes.

## Tests and validation

Rust (`npm run test:rust`):

- Windows-1252 Portuguese fixture opens with `ç/ã/ô`, reports
  `windows-1252`, and saves identical bytes with no edits.
- UTF-16LE and UTF-16BE with a BOM open and save with the same BOM and bytes.
- UTF-8 with a BOM keeps the BOM; UTF-8 without a BOM is unchanged.
- A sufficiently long Shift_JIS or GBK fixture is detected as that encoding and
  round-trips; a detector guess that cannot reproduce the original bytes is
  refused rather than opened as Windows-1252.
- A candidate that fails strict decoding, contains C1 controls, or fails the
  byte round-trip is refused; PDF/PNG/ZIP/NUL fixtures remain refused.
- Saving a Windows-1252 document containing `😀` returns
  `written: false, change: "encoding"` and leaves the destination bytes and
  temporary siblings untouched.
- Overwriting an existing Windows-1252 destination with an explicit Windows-1252
  writer preserves its bytes; an explicit UTF-8 writer produces UTF-8.

App-free and UI layers:

- `npm run p0:unit` covers the session/recovery encoding fields and defaults.
- `npm run p0:lifecycle` opens a Windows-1252 fixture, checks the accented text,
  saves unchanged and compares bytes; also opens a UTF-16 fixture instead of
  expecting the old refusal.
- `npm run latex:project` or the nearest available LaTeX layer checks a
  snapshot with one UTF-8 chapter and one Windows-1252 chapter: each project
  file's bytes and reported encoding are correct, and an unsaved edit in the
  legacy chapter is encoded back before compilation.
- `npm run latex:native:unit` covers per-file decoding of diagnostic sources.
- `npm run build`, `npm run lint`, `npm run format:check`, `npm run knip` and
  `cargo clippy --all-targets -- -D warnings` before the release path.

The one measurement that proves the result: on a temporary copy of the
reported project, open `tese.tex` and `cap01.tex`, confirm the accented words,
press Save without editing, and compare SHA-256 for every `.tex`, `.sty` and
`.bib` file before and after. Every hash must be identical. Then compile or
export with the available engine and inspect the same accented words in the
output.

## Acceptance criteria

- Opening `tese.tex`, `cap01.tex` and `bibliografia.bib` shows the correct
  Portuguese characters; no “not valid UTF-8” dialog appears for a file whose
  encoding is supported.
- The status bar names the actual encoding, for example `Windows-1252 · CRLF`,
  and no longer labels every saved file UTF-8.
- Saving an unedited legacy document produces byte-identical content, including
  its BOM and line endings.
- Editing and saving a supported legacy document keeps its encoding; the
  accents are not replaced with `?`, `\uFFFD` or numeric character references.
- A character the original encoding cannot represent is never written; the
  document is left untouched and the reader is offered a UTF-8 copy.
- A LaTeX snapshot preserves each file's own bytes, including included chapters
  that were never opened, and the compiler receives the encoding the document
  declares.
- UTF-32, binary files and genuinely undecodable bytes still fail safely with
  an explanation, never with a lossy buffer.

## Validation record

- `cargo test --lib` (with `TEMP`/`TMP` pointed at
  `src-tauri/target/test-tmp`, per the existing sandbox trap): **436 passed,
  0 failed, 7 ignored**. This includes an edit round-trip that writes
  `café ação` back as the Windows-1252 bytes and reopens it.
- `cargo clippy --all-targets -- -D warnings`: passed.
- `npm run build`: passed.
- `npm run p0:unit`: **170/170**.
- `npm test -- --only p0-lifecycle --no-build --keep`: **46/46**, including the
  UTF-16 and Windows-1252 open/save checks and the status bar labels.
- `npm test -- --only latex-project --no-build --keep`: **16/16**.
- `npm run latex:sdk:unit` 35/35, `latex:native:unit` 27/27,
  `latex:references:unit` 68/68, `latex:diagnostics:unit` 27/27 and
  `latex:correspondence:unit` 7/7.
- `npm run test:sessions` 60/60 and `npm run tabs:restore:unit` 33/33.
- `npm run knip`: passed.
- A temporary Rust probe decoded **all 23** `.tex`, `.sty` and `.bib` files of
  the reported thesis, then re-encoded each one and compared the bytes. Every
  file was exact; all are UTF-8 or Windows-1252. The probe was removed after
  use because it named a user path.
- Pandoc 3.8.3 on the reported `tese.tex` warns
  `is not UTF-8 encoded: falling back to latin1`, so its reader handles the raw
  project bytes without a transcode.
- One initial `p0-lifecycle` invocation exited 13 after 8 checks without
  printing a failing assertion; the immediate `--no-build --keep` rerun passed
  46/46 and its log contains no failure.
- `npm run lint` still reports three pre-existing errors in
  `src/latex-outline.ts`, `src/paste/render-latex.ts` and
  `src/spelling/replacement.ts`; `npm run format:check` still fails on the
  pre-existing broken `site/pt-br/index.html` link. The files this change
  touched are formatted.

## Open questions

- **Manual override.** If `chardetng` cannot confidently decode a real file,
  should the next slice expose “Reopen with Encoding…” in the status bar or the
  File menu? Default: defer until a concrete misdetection appears; the
  round-trip guarantee is this slice's safety net.
- **Pandoc export.** Measured with pandoc 3.8.3 on the reported `tese.tex`; it
  warns `is not UTF-8 encoded: falling back to latin1`. No transcode is needed
  for this slice. If a future pandoc drops the fallback, record a separate
  export follow-up rather than changing the compile bytes.
- **Statistics.** For a dirty legacy buffer, “Document length” remains the
  UTF-8 measure of the text, while the file on disk is smaller. Default: keep
  the existing label and leave the exact encoded size to a later statistics
  change.
