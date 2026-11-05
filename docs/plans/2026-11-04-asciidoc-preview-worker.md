# AsciiDoc preview off the main thread

**Status:** done
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

- [x] Extract the shared batching/yield loop into `src/preview-batches.ts`;
      the sanitizer profiles and decorations stay with each renderer.
- [x] Add `renderAsciidocChunks` to `asciidoc-render.ts`: a custom HTML5
      converter wraps each top-level block in a chunk comment, the pure splitter
      removes the comments, and the marker treeprocessor records every block's
      source line. Includes come from a map instead of `readFile`.
- [x] Add `preloadAsciidocIncludes` on the main thread (scan, resolve, jail,
      read, cycle guard) and pass its map to the worker; an attribute-built
      include target returns `null` and keeps the main-thread conversion.
- [x] Split the worker per engine: `preview-worker.ts` for Markdown,
      `asciidoc-worker.ts` for AsciiDoc. Vite inlined Asciidoctor into a single
      worker otherwise, which made every Markdown session parse it.
- [x] In `doRender`, call `renderAsciidocPreviewInto` and the shared insert/yield
      loop; `renderAsciidocPreview` stays as the sync/export path and the
      fallback.
- [x] Rewrite the markers after insertion, build the source offsets and
      `data-b`, then run `renderMathIn`/`renderAsciiMathIn`/
      `decorateCodeBlocks`/`decorateLinks`/`renderMermaidIn`. Asciidoctor emits
      its own TOC and footnotes, so there is no extra heading pass.
- [x] Extend `scripts/preview-performance-test.mjs` with a generated 600 KB
      `.adoc` phase (now 14 checks).
- [x] Extend `scripts/asciidoc-export-unit.mjs` with the pure chunker and
      pre-reader (now 27 checks).

## Implementation notes and deviations

- **A comment wrapper, not a collected chunk list.** The converter wraps each
  top-level block in `<!--mdraft-chunk-->…<!--/mdraft-chunk-->`; a pure splitter
  removes the comments and returns the segments. The title and TOC stay in the
  leading segment and footnotes in the trailing one, so their placement is
  Asciidoctor's own. This is simpler than collecting converter return values and
  preserves every byte except the comments.
- **Two workers.** The plan left the worker shape open. Vite inlined the dynamic
  AsciiDoc import into the Markdown worker, growing it from 590 KB to 1 MB. Two
  entries keep the Markdown worker at 590 KB and load the 377 KB AsciiDoc worker
  only when an `.adoc` preview is rendered; each has its own single-flight
  queue.
- **The sync path shares the chunker.** `renderAsciidocPreview` now uses
  `renderAsciidocChunks` and the same DOM finish, so the export article, the
  worker and the fallback cannot drift.
- **Includes.** Preloading reuses `resolveInclude`/`foldForCompare`; a file that
  cannot be read is stored as its error string, and the include processor shows
  the same unresolved directive as before. Dynamic attribute targets use the
  main-thread conversion because their path is not known until conversion.
- **Mathematics stays on the main thread per element.** The chunker carries the
  `data-stem` markers; `renderMathIn` and `renderAsciiMathIn` run after
  insertion. These are proportional to the stems, not to the document.
- **Measured.** Chromium, 610 KB `.adoc`: the sync path 665 ms; the worker path
  156 ms total with a **22 ms** maximum main-thread gap. The worker output is
  byte-identical to the sync path (949,775 bytes, 3,161 blocks); the tour with
  its include is byte-identical too (17,379 bytes, 33 blocks).
- **Real target.** Tauri/WebKitGTK rendered `samples/asciidoc-tour.adoc` through
  `asciidoc-worker` with the include pre-read (a temporary success log confirmed
  the worker; the preview showed the included chapter in its TOC and body).
- **Not run here.** The Windows CDP suites (`asciidoc`, `preview:zoom`, `sync`,
  `preview:perf`) were not run on this Linux host; the performance script now
  covers AsciiDoc and remains the Windows gate.

## Files and modules

- `src/asciidoc-render.ts` — chunk converter, splitter, marker processor,
  include pre-reader and the worker options type.
- `src/asciidoc-preview.ts` — DOM finish: sanitize/insert batches, marker
  rewrite, source offsets, math/code/link/mermaid decorations, sync path and
  the worker path.
- `src/asciidoc-worker.ts` (new) — the AsciiDoc worker entry.
- `src/preview-worker.ts`, `src/preview-worker-client.ts` — Markdown worker,
  two-engine channel client.
- `src/preview-batches.ts` (new) — shared 64 KB batching and yield.
- `src/markdown.ts` — uses the shared batching helper.
- `src/main.ts` — `renderAsciidocPreviewInto` in `doRender`.
- `scripts/preview-performance-test.mjs`, `scripts/asciidoc-export-unit.mjs` —
  the AsciiDoc performance phase and the pure checks.
- `AGENTS.md` — counts and the worker note.

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

- `npm run asciidoc:export:unit` (28 checks): the export contract plus the
  preview chunker, the include pre-reader, the jail, dynamic targets, markers
  and an empty document. Passing on this host.
- `npm run preview:unit` (36 checks): the Markdown pipeline, unchanged by this
  plan. Passing on this host.
- Renderer goldens: the pre-refactor `renderAsciidocPreview` output for
  `samples/asciidoc-tour.adoc` (with its include) and a generated 610 KB `.adoc`
  was captured in Chromium. Both the new sync path and the worker path are
  byte-identical: 17,379 bytes / 33 blocks and 949,775 bytes / 3,161 blocks.
- `npm run preview:perf` (14 checks): the Windows CDP gate for key latency and
  long tasks on the 1.2 MB Markdown and 600 KB AsciiDoc documents. Not run on
  this Linux host.
- `npm run asciidoc` (54), `npm run preview:zoom` (24) and `npm run sync` (62)
  include AsciiDoc and remain the Windows release gate after the marker/insert
  path change.

## Acceptance criteria

- [x] With a 610 KB `.adoc` document the worker path totals 156 ms and the
      largest main-thread gap is 22 ms in Chromium; the Windows key-latency gate
      is `preview:perf` (not run on this host).
- [x] Includes, stems, tables, admonitions, the title/TOC and the source-line
      markers render byte-identically to the old renderer (goldens above).
- [x] Source mode starts no AsciiDoc conversion (the generic Source skip).
- [x] A worker failure falls back to the sync chunker + DOM path.
- [x] The export unit suite (28/28) and the pure Markdown suite (36/36) pass;
      the AsciiDoc UI suite remains the Windows gate.

## Open questions and decisions

- **Title/TOC/footnotes.** The converter leaves them in the leading/trailing
  segment, so their placement is Asciidoctor's own. Verified byte-identical on
  the tour, which has both a TOC and includes.
- **Include pre-read cost.** Reads are sequential and reuse the existing jail.
  A very large include tree delays the preview start (not typing); a dynamic
  attribute target uses the main-thread conversion. Revisit only if a measured
  document shows the pre-read as the bottleneck.
- **One worker or two.** Decided: two, because Vite inlined Asciidoctor into the
  single worker and grew the Markdown worker from 590 KB to 1 MB. Each engine
  keeps one in-flight and one pending job.
