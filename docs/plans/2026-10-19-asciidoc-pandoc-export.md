# AsciiDoc pandoc exports: render with Asciidoctor, not pandoc's AsciiDoc reader

**Status:** done
**Date:** 2026-10-19
**ADR:** `../adr/2026-10-19-asciidoc-pandoc-export.md`

## Context and goal

A user exported an AsciiDoc physics worksheet to **PDF (via Typst)** and got a
PDF full of the source's preprocessing directives: `:toc!:`, `:sectnums!:`,
`:icons!:`, `:pdf-page-size:`, `:pdf-theme:`, the `ifdef::backend-pdf[]` /
`endif::[]` pairs and unresolved `{instituicao}` placeholders. The same document
previews correctly and exports cleanly through **PDF (Print)**, because both of
those use Asciidoctor. Only the pandoc path is wrong.

Measured with the managed pandoc 3.12.1:

```
$ pandoc -f asciidoc -t plain repro.adoc
:toc!: :sectnums!: :icons!: :pdf-page-size: A4 :pdf-theme:
{docdir}/fisica-theme.yml :instituicao: Universidade de Brasília ...
ifdef::backend-pdf[] :notitle: endif::[] ifndef::backend-pdf[] ...
{instituicao} / {unidade}
```

The trigger is the AsciiDoc unset-attribute syntax (`:toc!:`). Once pandoc meets
one, it stops treating the following `:name: value` lines as attributes, so the
header is emitted as prose; it also never evaluates `ifdef::`/`ifndef::` and
never substitutes document attributes. This affects every pandoc target, not
only PDF.

The goal is a **PDF (via Typst)** that preserves what the preview already
resolved — attributes, conditionals, includes and mathematics — with no
spurious source text, and without adding a dependency or a second markup
implementation. The same route should improve DOCX, ODT, LaTeX and the other
pandoc targets for AsciiDoc sources.

## Scope and non-scope

In scope:

- For an AsciiDoc document exported through pandoc, render the source with
  `@asciidoctor/core` to clean HTML first, then let pandoc read that HTML.
  - Use Asciidoctor's `backend: "pdf"` with an HTML5 converter registered for
    the `pdf` backend, so `ifdef::backend-pdf[]` content is selected and
    `ifdef::backend-html5[]` content is not, while the output stays HTML.
  - Keep the existing include processor and its document-directory jail.
  - Convert AsciiMath stems to TeX during conversion, so pandoc's HTML reader
    and Typst receive `\(…\)` / `\[…\]` rather than raw AsciiMath.
  - Strip nothing with ad-hoc string replacement; Asciidoctor already produces
    the resolved document.
- Send the rendered HTML to the existing `run_export` command with
  `language: "html"`, which already selects pandoc's HTML reader.
- Extend pandoc's HTML reader with `tex_math_single_backslash` and
  `tex_math_double_backslash`, because Asciidoctor emits `\(…\)` / `\[…\]` and
  pandoc otherwise prints them literally.
- Apply the route to every pandoc target except the AsciiDoc target itself. An
  AsciiDoc-to-AsciiDoc export should keep reading the original AsciiDoc source;
  turning it into HTML first would only lose information.
- Shared Asciidoctor loading, include handling and AsciiMath loading move to a
  module that can be exercised by Node without a DOM.
- A unit suite for the renderer, an export-reader check for the HTML math
  extensions, and updated user documentation.

Out of scope:

- Reproducing an Asciidoctor PDF theme (`:pdf-theme:`, `:pdf-page-size:`) in the
  Typst output. Pandoc never honoured those either, and the user who wants the
  themed layout has **PDF (Print)**. The Typst PDF uses pandoc's own clean
  layout.
- Replacing pandoc's AsciiDoc **output** writer. The AsciiDoc target keeps the
  source as its input.
- Fixing pandoc/Typst image handling on Windows. Pandoc resolves a local image
  to an absolute `C:/…` path and Typst refuses drive-letter absolute paths; that
  is a separate, pre-existing limitation of every pandoc PDF export with local
  images. This plan deliberately does not add `--resource-path`, which would
  turn a missing image into a hard error.
- A silent PDF path; the save dialog is unchanged.
- A new dependency. `@asciidoctor/core` and `asciimath2tex` are already
  bundled, lazily.

## Approach and rejected alternatives

Asciidoctor is already the AsciiDoc authority in this application. It resolves
document attributes, unset attributes, conditionals, includes, AsciiMath and
LaTeX. The new path asks it for the **PDF backend's document as HTML** and hands
that HTML to pandoc:

```
AsciiDoc source
  -> Asciidoctor (backend: pdf, HTML5 converter registered for "pdf",
                  existing include processor, AsciiMath -> TeX)
  -> clean HTML
  -> pandoc -f html+tex_math_single_backslash+tex_math_double_backslash
  -> PDF (via Typst), DOCX, LaTeX, ...
```

Backend selection matters. Setting `backend: "pdf"` without registering a
converter makes Asciidoctor fail with *"missing converter for backend 'pdf'"*;
registering the existing `Html5Converter` subclass under the name `"pdf"` gives
HTML output while the `backend-pdf` conditional is true and `backend-html5` is
false. That is the exact combination the export needs.

The preview keeps `backend: "html5"` and its KaTeX pass. The two paths share
the loader, the include jail and the AsciiMath parser, but not the post-DOM
decorations: an export must hand pandoc semantic HTML (`<pre><code>`, raw
`\(…\)`), not KaTeX spans or highlight.js token spans.

Rejected alternatives:

- **Preprocess the AsciiDoc source for pandoc in Rust.** It would have to
  reimplement unset attributes, `ifdef`/`ifndef`, includes, attribute
  substitution and AsciiMath; pandoc's reader also mishandles other constructs
  (`*bold*`, subscripts, `:toc:`). This duplicates Asciidoctor and fixes only
  the symptoms in the screenshot.
- **Keep pandoc's AsciiDoc reader and strip the offending lines with a regex.**
  The same regex would have to understand nested conditionals, attribute
  continuation and includes. It would silently drop legitimate text and never
  fix the unresolved attributes.
- **Render AsciiDoc to DocBook and feed pandoc's DocBook reader.** It preserves
  structure well, but AsciiMath arrives as untagged `<mathphrase>` and would
  need a second conversion pass, and the HTML route already has the AsciiMath
  converter. No measured benefit over HTML for this document.
- **Use the preview HTML (with KaTeX) and hand it to pandoc.** Measured: pandoc
  drops KaTeX's spans and the formula disappears (`No instante e .`). The
  export needs the source delimiters, not the rendered DOM.
- **Use `PDF (Print)` internally.** It produces a good PDF but does not exercise
  the requested Typst engine and ignores the format's configured arguments.
- **Add `--resource-path` for local images.** Measured: pandoc then resolves the
  image to `C:/…`, Typst fails with `path contains invalid component "C:"` and
  the export writes no PDF. Leaving it out keeps the export alive and matches
  the existing Markdown behaviour (the image is replaced by its description).

## Steps

- [x] 1. Add `src/asciidoc-render.ts` with the shared Asciidoctor loader, the
      AsciiMath parser loader, the include processor factory (moved verbatim
      from `src/asciidoc-preview.ts`) and `renderAsciidocForPandoc`.
- [x] 2. In that module, register an HTML5 converter under the `"pdf"` backend.
      Override `convert_inline_quoted` and `convert_stem` for AsciiMath:
      - inline: `<span class="math">\(tex\)</span>`;
      - block: one `<div class="math">\[tex\]</div>` per non-empty line;
      - escape the TeX for HTML and fall back to escaped literal text if
        `asciimath2tex` rejects a body.
- [x] 3. In `src/asciidoc-preview.ts`, import the shared loader and include
      factory, keep the preview's marker processor and KaTeX converter, and add
      `renderAsciidocForExport(source, { baseDir })`. The wrapper reads includes
      through `api.readDocument` and sanitises the result with the same
      DOMPurify profile the preview uses.
- [x] 4. In `src/main.ts`, render AsciiDoc to HTML before `api.runExport` for
      every pandoc target except `format.extension === "adoc"`, and send
      `language: "html"`. Leave the source, `inputPath`, save dialog and
      after-export behaviour unchanged.
- [x] 5. In `src-tauri/src/export.rs`, change the HTML reader to
      `html+tex_math_single_backslash+tex_math_double_backslash` and add tests:
      the long/short `--from` replacement still works, the math extensions are
      present, and the user's extra arguments still come last.
- [x] 6. Add `scripts/asciidoc-export-unit.mjs` (no application): unset
      attributes, attribute substitution, `backend-pdf` vs `backend-html5`
      conditionals, include expansion, include escape refusal, AsciiMath inline
      and block conversion, LaTeX inline/display preservation, title and the
      absence of source directives in the output.
- [x] 7. Add the suite to `scripts/test-all.mjs`, `package.json` and the
      Testing/Repository scripts tables in `AGENTS.md`; update the export suite
      count after its new check.
- [x] 8. Extend `scripts/export-test.mjs` with a check that an HTML source
      containing `\(x^2\)` and `\[…\]` keeps its mathematics through the HTML
      reader, and record the new count.
- [x] 9. Update `docs/export.md` and `docs/guide.md`: AsciiDoc pandoc exports
      are rendered by Asciidoctor to HTML first; attributes, conditionals and
      includes are resolved; the Asciidoctor PDF theme is not carried into the
      Typst layout. Remove the old claim that `include::` and `:toc:` are not
      expanded.
- [x] 10. Write the ADR and add a `Superseded in part by` line to
      `docs/adr/2026-10-17-asciidoc.md`. Record the new traps in `AGENTS.md`.
- [x] 11. Run the validation below, manually export an AsciiDoc document with
      unset attributes and conditionals to PDF (via Typst), and inspect the
      text of the resulting PDF.

### Deviations

- The unit suite has **17** checks, not 14: the include-refusal rule is split
  into "not read" and "explained", and the empty-document check was added.
- The manual end-to-end check was automated without changing the application: a
  temporary CDP driver emitted the same `menu` event the native menu sends, and
  a PowerShell `SendKeys` filled the native save dialog. The resulting PDF was
  inspected with PDF.js.
- A multi-line AsciiMath block is emitted as one display block per line, not
  one display block joined with TeX's `\\`. Measured with Typst: `\\` is
  rejected with `unexpected control sequence \\`, and the PDF falls back to
  literal TeX. One block per line also matches the preview, which draws each
  line separately.
- The Rust suite gained one test, so its counts moved from 91/90 to 92/91.
- `src/api.ts`'s `language` comment was updated to name the rendered-HTML case.
- The trap about Typst's drive-letter image paths was recorded in `AGENTS.md`
  during validation; it is a pre-existing limitation, not a regression.

## Files and modules

- `src/asciidoc-render.ts` — new shared Asciidoctor module and the export
  renderer; no DOM, so Node can test it.
- `src/asciidoc-preview.ts` — use the shared loader/include factory; add the
  sanitising export wrapper; preview output must not change.
- `src/main.ts` — the one call site that turns an AsciiDoc buffer into HTML
  before a pandoc export.
- `src-tauri/src/export.rs` — HTML reader extensions and their unit tests.
- `scripts/asciidoc-export-unit.mjs` — the new pure suite.
- `scripts/export-test.mjs` — one new backend/reader assertion and the count.
- `scripts/test-all.mjs` — register the unit suite.
- `package.json` — the npm alias for the new suite.
- `AGENTS.md` — script table, Testing table, layer count, export count, traps.
- `docs/export.md`, `docs/guide.md` — the user-facing description and gaps.
- `docs/adr/2026-10-19-asciidoc-pandoc-export.md` — the durable decision.
- `docs/adr/2026-10-17-asciidoc.md` — supersession pointer only.
- `docs/plans/2026-10-19-asciidoc-pandoc-export.md` — this plan.

## Risks and rollback

- **Asciidoctor output is not pandoc's AsciiDoc AST.** Some constructs may map
  differently (admonitions become HTML tables, a static `:toc:` becomes a list).
  The unit suite and a manual PDF comparison are the guard. The preview and
  native exports are untouched.
- **AsciiMath conversion could fail.** The converter catches parser failures
  and emits escaped literal text, so a bad formula cannot abort the export; the
  unit suite exercises a radical and a multi-line block.
- **The PDF layout no longer uses the Asciidoctor theme.** This is accepted:
  pandoc's Typst layout is clean and the themed route remains PDF (Print). The
  documentation says so.
- **Images on Windows still need the known Typst path fix.** No new failure is
  introduced; the route does not add `--resource-path`.
- **The shared include processor could regress the preview.** Its code is moved,
  not rewritten; `npm run asciidoc` covers includes, attributes, stems, toc and
  the include jail.
- **Rollback:** revert the branch. There is no settings or schema change, no new
  dependency and no persisted format. The plan and ADR stay as the record.

## Tests and validation

- `npm run build` — **PASS**, typecheck and frontend bundle.
- `npm run asciidoc:export:unit` — **17/17** checks.
- `npm run test:rust` — **91 passed, 1 ignored** (92 total); includes the new
  HTML-reader math test.
- `npm run asciidoc` — **51/51** preview checks, with the same fixture.
- `npm run export` against a running window with pandoc — **36/36** checks,
  including the rendered-HTML math reader.
- `npm run test -- --only asciidoc-export-unit` — **17/17**, proving the suite is
  wired into the harness.
- Combined run of `asciidoc-export-unit`, `asciidoc` and `export` on the same
  build — **17/17, 51/51, 36/36**.
- End-to-end: opened a fixture with `:toc!:`/`:sectnums!:`/`:icons!:`,
  `ifdef::backend-pdf[]`, `{attribute}` references, `latexmath` and `asciimath`;
  emitted the menu event and filled the save dialog. The PDF text was
  `Física 1 - Lista extra ... PDF-ONLY-MARKER ... Universidade de Brasília /
  Faculdade UnB Planaltina / 10,0 ... √9 = 3`: no directives, no placeholders,
  no HTML-only marker, and both formulas typeset.

## Acceptance criteria

- A PDF (via Typst) of a document with `:toc!:`/`:sectnums!:`/`:icons!:` no
  longer contains `:toc!`, `:sectnums!`, `:icons!`, `ifdef::`, `endif::` or
  unresolved `{attribute}` text.
- `ifdef::backend-pdf[]` content is present and `ifndef::backend-pdf[]` content
  is absent in that PDF.
- `include::` content, document attributes and `latexmath`/`asciimath` appear
  resolved and typeset.
- The preview, HTML export and PDF (Print) of the AsciiDoc fixture are
  unchanged.
- DOCX/ODT/LaTeX exports of AsciiDoc use the same rendered HTML and no longer
  print the directives.
- No new dependency; Asciidoctor and AsciiMath remain lazily loaded.
- `npm run build`, the new unit suite, `npm run test:rust`, `npm run asciidoc`
  and `npm run export` pass.

## Open questions

- Should the AsciiDoc target itself (`-t asciidoc`) also use the rendered HTML?
  Default: no, it stays on the original source; only the other targets change.
- Should `:toc:` be turned into pandoc's `--toc` with page numbers instead of
  Asciidoctor's static list? Default: no for this change; the source's own TOC
  is preserved as a list, and `--toc` can be added per format.
- Should a future change copy local images to a temporary directory so Windows
  Typst can reach them? Default: separate issue; not part of this plan.
