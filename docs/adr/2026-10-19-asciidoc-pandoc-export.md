# AsciiDoc pandoc exports are rendered by Asciidoctor to HTML, not read by pandoc's AsciiDoc reader

**Status:** accepted
**Date:** 2026-10-19

## Context

A physics worksheet previewed correctly and printed correctly through
**PDF (Print)**, but **PDF (via Typst)** showed the source's preprocessing
directives: `:toc!:`, `:sectnums!:`, `:icons!:`, `:pdf-page-size:`, `:pdf-theme:`,
the `ifdef::backend-pdf[]` / `endif::[]` pairs and unresolved `{instituicao}`
placeholders.

Measured with pandoc 3.12.1:

```text
$ pandoc -f asciidoc -t plain repro.adoc
:toc!: :sectnums!: :icons!: :pdf-page-size: A4 :pdf-theme:
{docdir}/fisica-theme.yml :instituicao: Universidade de Brasília ...
ifdef::backend-pdf[] :notitle: endif::[] ifndef::backend-pdf[] ...
{instituicao} / {unidade}
```

The unset-attribute syntax (`:toc!:`) makes pandoc stop recognising every
following `:name: value` line, so the whole document header becomes prose. The
reader also never evaluates `ifdef::`/`ifndef::` and never substitutes document
attributes. This affects every pandoc target, not only PDF.

The application already has an AsciiDoc authority for the preview:
`@asciidoctor/core`, which resolves attributes, unset attributes, conditionals,
includes, LaTeX and AsciiMath. Using a second, incomplete reader for export is
what produced the two different documents.

## Decision

Before any pandoc export of an AsciiDoc document, the frontend renders the
source with Asciidoctor to **clean HTML** and sends that HTML to `run_export`
with `language: "html"`. The AsciiDoc target itself is the exception: it keeps
the original source, because writing AsciiDoc back to AsciiDoc should not pass
through HTML.

The renderer:

- uses `backend: "pdf"` with an `Html5Converter` registered under the `"pdf"`
  backend name. This selects `ifdef::backend-pdf[]` content while keeping the
  output HTML; `backend: "pdf"` without a registered converter fails with
  `missing converter for backend 'pdf'`;
- installs the preview's include processor and document-directory jail, so
  includes are read through `read_document` and cannot escape the folder;
- converts AsciiMath stems to TeX during conversion (`\(…\)` inline,
  `\[…\]` display), because pandoc's HTML reader understands TeX delimiters but
  not AsciiMath. A rejected body becomes escaped literal text rather than aborting
  the export;
- omits the preview's KaTeX, highlight.js and `data-line` decorations, because
  pandoc needs semantic HTML and the source math delimiters.

The backend uses pandoc's HTML reader with `tex_math_single_backslash` and
`tex_math_double_backslash`. Without those extensions pandoc prints
`\(…\)`/`\[…\]` as literal text; measured, a preview HTML containing KaTeX spans
loses the formula entirely (`No instante e .`).

## Consequences

- AsciiDoc attributes, unset attributes, conditionals, includes and both math
  syntaxes are resolved for DOCX, ODT, LaTeX, EPUB and PDF (via Typst). The
  spurious source text is gone.
- The Asciidoctor PDF theme is still not applied to the Typst output. Pandoc
  never honoured it either; the themed layout remains **PDF (Print)**. The
  Typst route uses pandoc's own clean layout.
- A `:toc:` arrives as Asciidoctor's static contents list, without page numbers.
  A user who wants pandoc's numbered TOC can add `--toc` to the format's Extra
  Arguments.
- The export now depends on the same lazy Asciidoctor chunk the preview already
  loads. No dependency, no network request and no persisted format changed.
- Local images remain subject to pandoc/Typst's Windows path limitation:
  pandoc resolves them to `C:/…`, which Typst refuses with
  `path contains invalid component "C:"`. The route deliberately does not add
  `--resource-path`, which would turn a missing image into a failed export.
- The preview and the export share the loader, the include processor and the
  AsciiMath parser, so a fix to the include jail applies to both. They do not
  share the post-DOM decorations.
