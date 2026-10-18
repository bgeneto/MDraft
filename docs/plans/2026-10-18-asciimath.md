# AsciiMath rendering in the AsciiDoc preview

**Status:** done
**Date:** 2026-10-18
**ADR:** `../adr/2026-10-18-asciimath.md`

## Context and goal

The AsciiDoc preview converts with `@asciidoctor/core` and draws mathematics
with KaTeX. Asciidoctor emits LaTeX as `\(...\)` / `\[...\]` and AsciiMath as
`\$...\$`; `renderMathIn` handles only the LaTeX delimiters, and KaTeX has no
AsciiMath parser. A document that uses `[asciimath]` therefore previews the
literal `\$sqrt(4) = 2\$`, and `stem:[…]` under `:stem: asciimath` is text. The
existing ADR accepted that gap.

The user approved adding `asciimath2tex` (AsciiMath → TeX, designed for KaTeX)
and asked for the smallest possible bundle: code only, no maps, and no import
that is not needed. The goal is that `[asciimath]`, `asciimath:[…]` and
`stem:[…]` under `:stem: asciimath` render through KaTeX, while `latexmath`
output and literal `\$` prose are unchanged.

## Scope and non-scope

In scope:

- Mark AsciiMath stems during conversion, so the post-DOM pass never has to
  guess from a `\$…\$` pair in prose.
- Convert the marked bodies with `asciimath2tex`, then render the TeX with the
  existing `mathNode`/KaTeX path; display inside `.stemblock`, inline elsewhere.
- A pinned dependency, dynamically imported only when an AsciiMath stem exists.
- A fixture and CDP checks for an inline radical, a block radical, a matrix and
  the absence of literal `\$` delimiters.

Out of scope:

- Automatic detection of AsciiMath written under `:stem: latexmath`. `sqrt(4)`
  remains TeX there; that is a source error, not a renderer guess.
- `:eqnums:` numbering of ordinary `[stem]` blocks. Only `\begin{equation}`
  already numbers, through KaTeX's own counter.
- Markdown `$…$`; it stays TeX.
- Pandoc exports, which receive the source and not this rendered HTML.
- MathJax, a second math renderer, or a source preprocessor.

## Approach and rejected alternatives

Asciidoctor exposes the stem type to the converter. A per-load
`ConverterCustomFactory` registers a small `Html5Converter` subclass that adds
`data-stem="asciimath"` to AsciiMath blocks and emits inline AsciiMath as
`<span data-stem="asciimath">…</span>` instead of `\$…\$`. This is a marker, not
a rewrite: every other conversion method is inherited. After DOMPurify, a DOM
pass finds the markers, parses each body with a lazily imported
`asciimath2tex`, and replaces it with a KaTeX node. Because only marked
elements are touched, a literal `\$5` in prose cannot become mathematics.

Rejected alternatives:

- **Regex over `\$…\$` in the converted HTML.** Asciidoctor also uses `\$` for
  an escaped dollar, so `\$5 and \$7` would look like one AsciiMath body. The
  converter marker is exact and costs less code than the guard would.
- **MathJax.** It supports both inputs natively but is ~34 MB unpacked and a
  second math renderer, against the existing ADR.
- **Rewriting the source.** It makes the examples correct but does not give the
  preview AsciiMath support; `[asciimath]` would still be literal.
- **Heuristics in `\(…\)`.** Treating `sqrt(` or `[[` as AsciiMath would fix the
  screenshot's first three examples but would also reinterpret legitimate TeX.
- **Importing `asciimath2tex` at the top of the module.** It would enter the
  startup bundle. The package is imported on the first AsciiMath stem instead.

## Steps

- [x] 1. Add `asciimath2tex` 1.5.0, pinned exactly, and its lockfile entry.
- [x] 2. Add the per-load converter subclass and `converter_factory` to
      `renderAsciidocPreview`; mark inline and block AsciiMath stems.
- [x] 3. Add `data-stem` to the DOMPurify allow-list.
- [x] 4. Export `mathNode` from `markdown.ts` and add `renderAsciiMathIn` in
      `asciidoc-preview.ts`, with a lazy `import("asciimath2tex")`.
- [x] 5. Extend `samples/asciidoc-tour.adoc` with inline and block AsciiMath,
      including a matrix.
- [x] 6. Add the four preview checks to `scripts/asciidoc-test.mjs`; update the
      suite count in `AGENTS.md`.
- [x] 7. Update `docs/guide.md`, `README.md` and the old AsciiDoc ADR pointer.
- [x] 8. Write the new ADR and record its decision.
- [x] 9. Run the typecheck, the build, the AsciiDoc suite and a startup-size
      comparison; record the measured bundle cost.

## Files and modules

- `package.json`, `package-lock.json` — the pinned dependency and lock entry.
- `src/asciidoc-preview.ts` — converter factory, stem markers, AsciiMath pass.
- `src/markdown.ts` — export `mathNode`; no change to Markdown math.
- `samples/asciidoc-tour.adoc` — the CDP fixture.
- `scripts/asciidoc-test.mjs` — the four new assertions and the count.
- `docs/guide.md`, `README.md` — the user-facing statement that AsciiMath now
  previews, and the remaining `:stem: latexmath` rule.
- `AGENTS.md` — the suite count and release-check sum.
- `docs/adr/2026-10-18-asciimath.md` — the durable decision.
- `docs/adr/2026-10-17-asciidoc.md` — a `Superseded in part by` pointer only.

## Risks and rollback

- The converter subclass could change output for constructs that are not stem
  blocks. It inherits every method and overrides only `convert_inline_quoted`
  and `convert_stem`; the full AsciiDoc suite is the guard.
- `data-stem` could be stripped by DOMPurify. Add it to `ADD_ATTR` and assert the
  rendered result, not the attribute.
- The dynamic import could fail. The pass leaves the text as it is and does not
  throw into the preview; the error box remains reserved for conversion errors.
- Multi-line AsciiMath blocks are emitted as `\$line\$<br>\$line\$`; the pass
  splits on `<br>` and renders each line as its own display node. The fixture
  covers the single-line path; the multi-line split is not exercised by the
  suite yet.
- Apache-2.0 licence. No runtime network; Vite bundles only the imported module,
  not the package's maps or type declarations.
- Rollback: remove the dependency and the two `data-stem` branches; the rest of
  the preview is untouched. The plan and ADR stay as the record.

## Tests and validation

- `npm run build` — typecheck and frontend bundle; confirms the import type and
  that Vite emits a separate lazy chunk.
- `node scripts/test-all.mjs --only asciidoc` — builds, starts a fresh instance
  on its own port with `samples/asciidoc-tour.adoc`, and runs the suite.
- The one measurement that proves it: the inline AsciiMath `sqrt` has a
  `.hide-tail` box with width > 0, the block `sqrt` likewise, and the matrix's
  `.mtable` has both width and height; the preview text contains no `\$`.
- Compare `dist/assets` before and after: the startup entry must not include
  `asciimath2tex`; a new lazy chunk of roughly the module's 25 KB is expected.

**Outcome (2026-10-18):** `npm run build` passed. `node scripts/test-all.mjs
--only asciidoc` passed **39/39 checks** in 26.2 s, including the four new
AsciiMath assertions. Vite emitted `dist/assets/asciimath2tex-DXN51ywS.js` at
25,178 bytes (6,190 bytes gzip); the startup entry contains only its dynamic
import path, not the parser.

## Acceptance criteria

- `asciimath:[sqrt(9) = 3]` in a `:stem: latexmath` document shows a radical,
  not the text `sqrt(9)`.
- A `[asciimath]` block with `sqrt(4) = 2` shows a radical and no `\$`.
- A `[asciimath]` block with `[[a,b],[c,d]]((n),(k))` shows a matrix table with
  positive width and height.
- The existing `latexmath` fraction still has a positive `.frac-line` width.
- A literal `\$` in prose is not converted (no marker, no replacement).
- The startup bundle does not contain `asciimath2tex`; only the lazy chunk does.

## Open questions

- Should ordinary `[stem]` blocks eventually honour `:eqnums:`? Default: no;
  KaTeX's `equation` environment remains the only numbered form.
- Should `stem:[…]` under `:stem: latexmath` warn when it looks like AsciiMath?
  Default: no; a wrong interpreter is a source problem, and a heuristic would
  misfire.
