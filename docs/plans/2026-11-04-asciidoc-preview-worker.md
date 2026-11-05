# AsciiDoc preview off the main thread

**Status:** draft
**Date:** 2026-11-04
**ADR:** `../adr/2026-11-04-preview-render-worker.md` (the worker boundary; this plan adds the second engine)

## Context and goal

The Markdown preview now renders in `src/preview-worker.ts`. AsciiDoc does not,
and the gap is measurable: a generated 610 KB `.adoc` document with 3,000
paragraphs, headings, stems and source blocks took **596 ms in one synchronous
task** in Chromium with Asciidoctor already loaded (871 ms on the cold run).
During that task the preview pane is frozen and keystrokes queue, exactly the
problem the Markdown worker fixed.

The split is not symmetric with Markdown:

- `src/asciidoc-render.ts` is DOM-free and already imported by a Node test. It
  owns `Asciidoctor.load`, the include processor and the export converter.
- `src/asciidoc-preview.ts` owns DOMPurify, the marker rewriting, KaTeX/AsciiMath
  decorations, the `data-line`/`data-line-end` markers and the word-block ranges.
- Asciidoctor returns one HTML string, not a top-level token list. The preview
  cannot reuse Markdown's `marked` chunking.
- Includes are read lazily by the conversion through
  `AsciidocRenderOptions.readFile`, which is `api.readDocument` — a Tauri call
  that a worker cannot make.

The goal is the same as the Markdown work: a render never delays a keystroke by
more than a frame or two, and a large `.adoc` document stops freezing the pane.

## Scope and non-scope

In scope:

- Run the Asciidoctor conversion and its pure post-processing in the existing
  module worker (or a sibling worker with the same client pattern).
- Emit top-level HTML chunks with source lines from a custom converter, so the
  main thread can reuse the 64 KB batched sanitise/insert path from
  `markdown.ts`.
- Pre-resolve includes on the main thread into a map passed to the worker, so
  the include jail and the Tauri file reads stay where they already are.
- Keep the AsciiMath/KaTeX decorations per chunk on the main thread (they are
  already per-element and cheap); move them only if the measurement says so.
- Keep the word-block ranges and marker rewriting on the main thread.

Non-scope:

- The HTML guest (a sandboxed iframe reload; a different problem).
- Rewriting the Asciidoctor extension registry or the export converter.
- Incremental AsciiDoc rendering.

## Approach and rejected alternatives

**Chosen:** a custom converter splits the Asciidoctor output at top-level block
boundaries into chunks with a line number each. The worker returns those chunks
plus the include map's diagnostics; the main thread runs the existing batched
`DOMPurify` + `insertBatch` pipeline, then the marker rewriting and
`renderMathIn`/`decorateCodeBlocks` per chunk. Includes are pre-read on the main
thread: scan `include::target[]` with the existing resolver, read each through
`api.readDocument`, and pass `{path: content}` to the worker. The include
processor reads from that map; a target outside the jail or missing stays the
same error the preview shows today.

Why a custom converter: Asciidoctor's HTML5 converter already calls one method
per block (`convert_paragraph`, `convert_listing`, ...). A subclass can append
the finished block HTML to a list and record the source line before returning
it. The existing treeprocessor already assigns a marker role per block; the
converter can emit the marker as a comment (removed by DOMPurify) or as the
`data-line` attribute directly. This avoids parsing HTML in a worker and avoids
a DOM implementation.

**Rejected: a DOM library in the worker (linkedom/jsdom).** A second HTML parser
and a second sanitizer surface; the project already rejects that trade-off in
the Markdown ADR.

**Rejected: split the final HTML by tags.** Asciidoctor emits tables, lists and
admonition tables with nested blocks; a string splitter cannot know a safe
boundary without a parser.

**Rejected: keep the conversion on the main thread and only batch the output.**
The conversion is the 596 ms; batching the sanitize/insert does not help it.

**Rejected: worker with synchronous file reads.** Tauri's `readDocument` is an
async IPC call; a worker cannot call it. Pre-reading includes is the only
faithful route.

## Steps

- [ ] Extract the shared batch insert/finish code from `markdown.ts` into a
      DOM-side `preview-insert.ts` so both engines use one sanitizer and one
      yielding loop.
- [ ] Add `renderAsciidocChunks` to `asciidoc-render.ts`: load Asciidoctor with
      a custom HTML5 converter that emits `{html, line}[]`, and accept the
      include map instead of `readFile`.
- [ ] Add the include pre-reader on the main thread (scan, resolve, jail, read,
      cycle guard) and pass its map to the worker.
- [ ] Extend the worker protocol with a `language: "asciidoc"` job; keep the
      Markdown job unchanged.
- [ ] In `doRender`, call the AsciiDoc worker path and the shared insert loop;
      keep the current synchronous `renderAsciidocPreview` as the fallback.
- [ ] Rewrite the per-block markers on the main thread, then
      `renderMathIn`/`decorateCodeBlocks`/`decorateLinks` per chunk and the
      final heading/TOC passes.
- [ ] Add `scripts/asciidoc-preview-performance-test.mjs` (or extend
      `preview-performance-test.mjs`) with a generated 600 KB `.adoc` document;
      assert the same 150 ms key/task ceiling.
- [ ] Add the pure chunker to `preview-render-unit.mjs` or a sibling app-free
      unit test.

## Files and modules

- `src/asciidoc-render.ts` — custom chunk converter, include-map option.
- `src/asciidoc-preview.ts` — split the pure conversion from the DOM
  decorations; keep the marker rewriting.
- `src/preview-worker.ts`, `src/preview-worker-client.ts` — a second job kind.
- `src/markdown.ts` / `src/preview-insert.ts` — shared batched insertion.
- `src/main.ts` — include pre-read, worker call, fallback.
- `scripts/preview-performance-test.mjs` or a sibling — the 600 KB check.
- `AGENTS.md` — the new script and the testing row.

## Risks and rollback

- **Include behaviour.** A missed include, a changed cycle guard or a path that
  now resolves differently is user-visible content loss. The pre-reader must
  reuse `resolveInclude`/`foldForCompare` and the existing error text. Compare
  the worker output with the current `asciidoc-test.mjs` fixture (includes,
  stems, tables, admonitions) before switching the default.
- **Marker order.** The title, TOC, footnotes and section wrappers are not
  ordinary blocks. The converter must emit them as chunks in document order, and
  the marker rewrite must still find every block. A count mismatch must drop the
  line mapping, exactly as the Markdown fail-safe does.
- **Chunk boundaries.** A list or table is one top-level chunk; do not split
  inside it. The sanitizer options are the same set as Markdown's.
- **Fallback.** Any worker error or unsupported include must render through the
  current path, not show an empty pane.
- **Rollback.** The worker branch is one function call; reverting it restores
  `renderAsciidocPreview` on the main thread. No settings or persisted data
  change.

## Tests and validation

- `npm run preview:unit` (extended) or a new app-free AsciiDoc chunk test:
  chunk count, line markers, include map, title/TOC, stem and table blocks.
- `npm run asciidoc` (54 checks) and `npm run asciidoc:export:unit` (17): the
  preview and export still agree, includes are still jailed, and the reference
  document renders.
- The generated 600 KB `.adoc` performance test: p95 < 100 ms, max < 150 ms for
  a key while the render runs; no main-thread task over 150 ms.
- `npm run preview:zoom` and `npm run sync` include AsciiDoc; they must stay
  green after the marker/insert path changes.
- Manual Linux probe (the CDP suites are Windows-only): key-event age and
  `top` on the generated document.

## Acceptance criteria

- With a 600 KB `.adoc` document in Split, a keystroke during a render appears
  within 150 ms (p95 100 ms); no single main-thread task exceeds 150 ms.
- Includes, stems, tables, admonitions, the title/TOC and the source-line
  markers render exactly as before.
- Source mode starts no AsciiDoc conversion.
- A worker failure falls back to the current main-thread path.
- The AsciiDoc suites and the export unit test pass.

## Open questions

- Does the custom converter preserve Asciidoctor's footnote placement and the
  TOC insertion exactly? Default: capture the title/TOC/footnote chunks from the
  converter's own calls; if not possible, leave them in one leading/trailing
  chunk (they are small).
- How many includes can be pre-read before the wait itself is noticeable?
  Default: read them in parallel and cap the total at the existing document
  size limit; a document with a very large include tree stays on the main
  fallback.
- Should the chunk protocol live in the existing worker or a sibling? Default:
  the existing worker, tagged by language, so there is one lifecycle and one
  pending-request policy.
