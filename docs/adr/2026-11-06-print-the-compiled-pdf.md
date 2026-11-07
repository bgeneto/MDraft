# Printing a LaTeX document prints the compiled PDF, never a re-render

**Status:** accepted
**Date:** 2026-11-06

## Context

LaTeX and Typst both produce their own PDF. Until now `File › Print` was
disabled for both, with the label pointing at `Export › PDF` (decision D11 in
`docs/plans/2026-11-06-latex-product-integration.md`). The reasoning was that the
PDF already exists, so printing it is the reader's own action on a file they own.

That left a gap a reader notices: every other language has a working Print row,
and a `.tex` author has to export first and then find the file. The maintainer
asked for Print to work.

Two shapes were available:

1. **Print the compiled PDF.** The bytes already exist and are exactly what the
   preview shows.
2. **Re-render the document to HTML and print that.** This is what
   `export.pdf.browser` does for the other four languages.

Shape 2 is the route the maintainer rejected earlier for LaTeX, when the plan
proposed a pandoc PDF: it produces a *second layout* of the same document, and
that layout contradicts the preview sitting beside it. A reader comparing the two
would see different page breaks, different fonts and different line lengths, with
no way to tell which is "the" document.

There is also a platform constraint that decides the mechanism. WebView2 exposes
no print UI of its own: `window.print()` inside the application fires no dialog
and prints nothing. That is why `print_document` writes an HTML file and hands it
to the system browser rather than calling `print()` in-process.

## Decision

**`File › Print` is enabled for LaTeX and prints the compiled PDF.**

It writes the bytes the preview is holding to a temporary `.pdf` and opens it in
the system's default PDF viewer, which owns the print dialog. The command is
`print_compiled_pdf`, the PDF sibling of `print_document`: same temporary
directory, same "write then open" shape, same refusal to invent content.

It **refuses a stale preview**, exactly as `Export › PDF` does, and says why. It
never starts a compile of its own: a Print row that silently triggers a
multi-second LuaLaTeX run would be a surprise, and the preview is already the
authority on what is current.

`export.pdf.browser` stays disabled for LaTeX. The two rows now differ honestly:
Print prints the compiled document, and the browser route — which re-renders —
is not offered at all.

## Consequences

- A `.tex` author has the same Print row as every other language, and what comes
  out is what the preview shows.
- The application gains one command and one temporary file per print. The file is
  replaced on every print, the same way `print_document` replaces its HTML.
- The system PDF viewer is now a dependency of Print for LaTeX, as the system
  browser already is for the other four. Neither is bundled; both are part of a
  desktop.
- Decision D11 is narrowed rather than reversed: printing is no longer disabled,
  but it still never produces a second layout. The part of D11 that mattered —
  "one PDF, the compiler's" — is unchanged.
- Typst's `Pages` view keeps its own Print behaviour; this ADR covers LaTeX and
  does not change Typst.
