# A LaTeX document exports its compiled PDF, and pandoc reads it as LaTeX

**Status:** accepted
**Date:** 2026-11-07
**Supersedes:** the LaTeX non-PDF restriction in `2026-11-06-native-pdf-export.md`

## Context

`2026-11-06-native-pdf-export.md` decided that `Export › PDF` writes the bytes the
document's own compiler produced. That half still holds and is not changed here.

Its second consequence — "A `.tex` document has no pandoc reader in this change.
Every pandoc row stays disabled for it" — was true of the code at that moment and
stopped being true almost immediately. `src-tauri/src/export.rs` gained a `latex`
arm in `reader_arguments`, so `-f latex` replaced the Markdown reader, and
`src/main.ts` began sending `language: "latex"` with the request. The gate did
not move with it, and it existed in two independent places:

- `latexCommandRefused` in `src/main.ts` refused **every** `export.*` id, plus
  `format.document` and `file.print`, before any handler ran. The reader saw
  *"LaTeX exports its own PDF through the preview; export formats arrive with
  it"* — a sentence describing a state that no longer existed.
- `apply_export_availability` in `src-tauri/src/menu.rs` disabled every
  configured Pandoc format for LaTeX, using a comment that repeated the same
  stale claim.

The cost was concrete. Measured against the managed Pandoc 3.12.1 with no `tex`,
`lualatex`, `pdflatex` or `bibtex` on `PATH`, a `.tex` sample produced nonempty
output through **74 of 76** non-PDF writers. DOCX, ODT, EPUB and RTF are formats
LaTeX cannot write itself, so refusing them was not protecting the reader from a
wrong document — it was withholding real output. The two empty writers were
`bibtex` and `biblatex`, which emit citation data rather than a document.

## Decision

**PDF keeps the compiled route; every other format goes through pandoc's own
LaTeX reader.**

- `Export › PDF` writes the bytes the preview is drawing, byte for byte, for both
  LaTeX and Typst. It never starts a compile. A stale or missing preview is
  refused with a reason. This part of the 2026-11-06 decision is unchanged.
- The built-in `export.pandoc.pdf` row ("PDF (via Typst)") is disabled for LaTeX
  with an explicit explanation, because converting LaTeX to Typst for PDF would
  change the layout and require a second engine that the preview does not use.
- `export.pdf.browser` stays disabled for LaTeX, as before: it re-renders the
  document to HTML and prints that, contradicting the compiled PDF.
- Every other configured format, `Export › HTML` and a new
  **More Pandoc formats…** chooser run pandoc with `-f latex`. The chooser lists
  what the *installed* pandoc advertises through `--list-output-formats`, so a
  pandoc update adds writers without a settings migration and without a row per
  writer in Preferences.

**The source of truth is the project snapshot, not the file on disk.** A LaTeX
conversion writes the bounded, project-confined snapshot — the same one the
preview compiles, including unsaved buffers — into an export-owned scratch
directory and hands pandoc that copy. Two consequences follow and both are
required:

- An unsaved edit in the root or in an `\input` chapter reaches the export. The
  alternative, passing `input_path` and letting pandoc read the disk, silently
  exports a different document than the one on screen.
- Nothing is ever written back into the project. The scratch copy is removed
  when the export returns, so the reader's files are untouched even when the
  conversion fails.

**Two commands, both validated.** `pandoc_list_writers` is read-only and caches
its answer against the resolved binary and version, so a pandoc update
invalidates it and a menu open does not spawn a process each time.
`run_pandoc_writer` takes a writer id, the source, the destination and an
optional snapshot; it refuses a writer the installed binary does not advertise,
and it refuses an id that is not a strict safe identifier. Neither takes an
executable path or a shell string from the UI.

## Consequences

- A `.tex` author gains DOCX, ODT, EPUB, RTF, Markdown and the rest of pandoc's
  writer list without a TeX distribution and without Typst. The compiled PDF
  remains the authoritative layout; pandoc is a converter and drops what it has
  no concept of. That limitation is stated in the documentation rather than
  papered over.
- The snapshot copy means a conversion costs a directory write of the project
  (bounded at 64 MiB by the existing snapshot limits), not a re-read of every
  file by pandoc. It also means a relative `\includegraphics` resolves inside the
  scratch copy, so a text writer's links must be rewritten to the original
  resources or they would dangle once the copy is gone.
- `--citeproc` runs for readable writers when the project declares a
  bibliography, so a citation renders as text instead of `[?]`. Bibliography-only
  writers (`bibtex`, `biblatex`, `csljson`) produce citation data, and pandoc's
  LaTeX reader does not carry the entries, so an empty result is reported as
  that limitation rather than as a successful empty file.
- `chunkedhtml` writes one ZIP rather than a directory tree, because the save
  dialog names one file and a scatter of HTML would need a folder the reader did
  not choose.
- A writer that disappears after a pandoc update fails with a named error at
  execution, not with a stale menu row that appears to work.
- The one rule a future change must respect: **availability is decided once, from
  the document language and the installed tools, and every path that draws or
  updates the menu uses that same rule.** Two independent gates is what produced
  the defect this ADR records.
