# AsciiMath is converted to TeX with asciimath2tex before KaTeX

**Status:** accepted
**Date:** 2026-10-18

## Context

The AsciiDoc preview uses `@asciidoctor/core` and KaTeX. Asciidoctor does not
render mathematics; it wraps the body in the delimiters the renderer expects:
`\(...\)` / `\[...\]` for `latexmath`, and `\$...\$` for `asciimath`
(`BLOCK_MATH_DELIMITERS.asciimath`). The previous AsciiMath decision was to leave
that second form as text, because KaTeX has no AsciiMath parser and a second
math renderer was out of scope.

That left a visible gap: `[asciimath]` blocks and `:stem: asciimath` documents
displayed literal `\$…\$`, while `stem:[sqrt(4)]` under `:stem: latexmath`
became italic letters (TeX treats `sqrt` as four variables), not a radical.
Neither case is a KaTeX error, so nothing warned.

`asciimath2tex` 1.5.0 is an Apache-2.0 library whose stated purpose is to use
KaTeX with AsciiMath. Its ES module is 25,335 bytes; the package's 412 KB
unpacked size is mostly source maps and type declarations, which the bundler
does not include.

## Decision

AsciiMath is rendered by converting it to TeX **in the webview**, then drawing
the result with the existing KaTeX pipeline:

- `asciimath2tex` is pinned exactly (`1.5.0`) and imported with a dynamic
  `import()` only when the converted document contains an AsciiMath stem. It is
  not in the startup bundle.
- The per-load HTML5 converter is extended to mark stems instead of relying on
  their delimiters. `convert_stem` adds `data-stem="asciimath"` to an AsciiMath
  `.stemblock`; `convert_inline_quoted` emits inline AsciiMath as
  `<span data-stem="asciimath">…</span>` rather than `\$…\$`. Every other
  conversion method is inherited. The factory is created per render, like the
  include and marker registries, so nothing is global.
- After DOMPurify, `renderAsciiMathIn` finds the marked elements, parses each
  body with `asciimath2tex`, and replaces it with a `mathNode` (display inside
  `.stemblock`, inline otherwise). A marker is exact: a literal `\$5` in prose
  is not matched.
- The custom converter adds `data-stem` to the sanitizer's `ADD_ATTR` list.
- `mathNode` is exported from `markdown.ts`; Markdown's own math path is
  unchanged.

`stem:[…]` under `:stem: latexmath` remains LaTeX. The renderer does not guess
that its content is AsciiMath, and no heuristic converts `sqrt(` or `[[` in a
LaTeX body. **`math:[…]` and `stem:[…]` under `:stem: asciimath` follow the
declared interpreter**, because Asciidoctor hands the converter the resolved
type.

`:eqnums:` is still not interpreted by the embedded HTML backend. `(1)` beside
`\begin{equation}` is KaTeX's `equation` environment and its CSS counter, not
Asciidoctor's attribute.

## Consequences

- `[asciimath]`, `asciimath:[…]` and documents with `:stem: asciimath` preview
  through the same KaTeX node, CSS and fonts as LaTeX. No MathJax, no CDN, no
  startup cost.
- The cost is one lazy chunk of about the module's 25 KB, paid on the first
  AsciiMath stem. A document with only `latexmath` never loads it. The measured
  Vite chunk is 25,178 bytes (6,190 bytes gzip); the startup entry contains only
  the dynamic-import path.
- The HTML and Print exports reuse `renderAsciidocPreview`, so they carry the
  converted formulas and the existing KaTeX stylesheet without a second path.
- Pandoc exports still receive the original AsciiDoc; pandoc has its own
  AsciiMath handling for `-f asciidoc`, which is outside this preview pipeline.
- The custom converter is a per-load subclass. A future change to
  `convert_stem` or `convert_inline_quoted` in `@asciidoctor/core` must be
  checked against it; the suite's AsciiMath and LaTeX cases are the guard.
- A multi-line `[asciimath]` block is emitted as `\$line\$<br>\$line\$` by
  Asciidoctor. The preview splits it into one display node per line; a single
  display body containing the original newlines is not attempted.
- `:eqnums:` remains a documented non-feature. Numbering ordinary `[stem]`
  blocks would be a separate decision.
