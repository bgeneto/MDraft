# `Export › PDF` writes the PDF the document's own compiler produced

**Status:** accepted; the LaTeX non-PDF restriction below is superseded by
`2026-11-07-latex-export-routes.md`. The compiled-PDF decision itself stands for
both languages.
**Date:** 2026-11-06

## Context

MDraft had three PDF routes and no rule for choosing between them:

- `export.pdf` — the native print surface, which renders the preview's article
  through WebView2's `PrintToPdf` or WebKitGTK's print settings.
- `export.pdf.browser` — the same article printed by the reader's browser.
- A pandoc PDF route, which converts the source and asks Typst to lay it out.

For Markdown, HTML and AsciiDoc those are reasonable: the document has no
compiler of its own, so the application must supply the layout.

Typst and LaTeX are different. Each already produces a PDF with its own engine,
and the preview is drawing that PDF. A pandoc route behind the same document
would produce a second, differently-laid-out PDF from the same words, which
misleads a reader who exports what they were looking at. The Typst short-circuit
in `export.rs` already refused this for Typst, and the LaTeX experiment only ever
offered a preview button.

## Decision

`Export › PDF` writes the bytes the document's own compiler produced, for both
Typst and LaTeX. There is no pandoc PDF route for either, and
`src-tauri/src/export.rs` is deliberately untouched: its Typst short-circuit
stays as documented and now doubles as a safety net.

The command is `save_compiled_pdf`, renamed from `latex_save_pdf` because it
already served both languages and the old name described one of them.

The row is **enabled only while a current PDF exists**, reported as
`pdfPreviewAvailable`:

- always true for a LaTeX document whose last compile succeeded, because its
  preview *is* a PDF;
- true for Typst only in the Pages view, because the Document view compiles HTML
  and holds no PDF bytes at all;
- false otherwise, with a label that says why.

It **never starts a compile.** A multi-second WasmTex or Typst run behind a menu
item is indistinguishable from a hang, and the freshness check would have to
guess whether the reader wanted the new bytes or the ones on screen.

Labels name the engine — `PDF… (compiled by LuaLaTeX)`, `PDF… (compiled by
Typst)` — because a reader comparing two documents deserves to know which
compiler laid them out. They are built in Rust from the document language, so
nothing is stored and no `parse_settings` migration is needed.

Native printing (`file.print`) stays disabled for both, with a label pointing at
`Export › PDF`: the PDF already exists, so printing it is the reader's own action
on a file they own.

## Consequences

- What the reader exports is what they were looking at, byte for byte. The
  preview button and the menu row call one helper, so they cannot diverge.
- ~~A `.tex` document has no pandoc reader in this change. Every pandoc row stays
  disabled for it, and `exportWithPandoc` refuses one that arrives through a
  stale menu or a keyboard route — pandoc would otherwise parse the source with
  its Markdown reader and produce a silently wrong document.~~
  **Superseded 2026-11-07.** `src-tauri/src/export.rs` gained a `latex` reader arm
  and the frontend sends `language: "latex"`, so pandoc reads `.tex` with its own
  reader rather than the Markdown one. Every non-PDF writer is now available. See
  `2026-11-07-latex-export-routes.md`.
- The Typst Document view has a disabled PDF row. If readers report that as a
  nuisance, the fix is a separate, visible *Compile PDF* action, not a silent
  compile behind Export.
- The freshness rule is the render token, so a compile that finishes while the
  save dialog is open is caught after the dialog closes rather than writing the
  previous document's pages.
