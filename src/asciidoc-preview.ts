//! AsciiDoc -> preview HTML.
//!
//! Asciidoctor runs in the webview, loaded on demand, and is kept to the parts
//! the editor can honour: embedded output, secure mode, a per-render extension
//! registry (so includes and the source markers cannot leak between documents)
//! and DOMPurify before anything reaches the preview.
//!
//! The `data-line` anchors are not a zip of `doc.blocks` against the DOM:
//! `convert_embedded` prepends the document title and the table of contents and
//! appends footnotes, so that zip is off by one for any titled document. A
//! treeprocessor marks every block with a unique role instead, and the marker is
//! rewritten to `data-line` / `data-line-end` after sanitising.

import DOMPurify from "dompurify";
import * as api from "./api";
import {
  AsciidocIncludeCache,
  loadAsciiMath,
  preloadAsciidocIncludes,
  renderAsciidocChunks,
  renderAsciidocForPandoc,
  type AsciidocChunks,
  type AsciidocIncludeCacheStats,
  type AsciidocIncludeMap,
} from "./asciidoc-render";
import {
  decorateCodeBlocks,
  decorateLinks,
  escapeHtml,
  mathNode,
  renderMathIn,
  renderMermaidIn,
} from "./markdown";
import type { RenderedMath } from "./preview-render";
import { batchesForChunks, settleMainThread } from "./preview-batches";
import { renderAsciidocChunksAsync } from "./preview-worker-client";

import type { BlockRange } from "./source-map";

export interface AsciidocRenderOptions {
  baseDir: string | null;
  math: boolean;
  mermaid: boolean;
  isDark: boolean;
}

export interface AsciidocRenderResult {
  html: string;
  /** True when at least two blocks carry a source line, so sync can work. */
  linesMapped: boolean;
  /**
   * Source range of every anchored block, in document order. Asciidoctor gives
   * lines and no columns, so word-level sync locates text inside these ranges by
   * search rather than from exact fragments.
   */
  blocks: BlockRange[];
}

/** Asciidoctor separates AsciiMath lines with `<br>` inside the block. */
function asciimathSegments(content: HTMLElement): string[] {
  const html = content.innerHTML.replace(/<br\s*\/?>/gi, "\n");
  const holder = document.createElement("div");
  holder.innerHTML = html;
  return (holder.textContent ?? "").split("\n");
}

/**
 * Draw the `[data-stem="asciimath"]` elements Asciidoctor marked.
 *
 * Inline stems sit in a `<span>`; block stems sit in `.stemblock > .content`.
 * The body is converted to TeX with `asciimath2tex` and then drawn by the same
 * KaTeX node Markdown and LaTeX use. A body the converter rejects is left as
 * text rather than replaced with half a formula.
 */
async function renderAsciiMathIn(host: HTMLElement): Promise<number> {
  const elements = Array.from(host.querySelectorAll<HTMLElement>('[data-stem="asciimath"]'));
  if (elements.length === 0) return 0;

  let parser: { parse(input: string): string };
  try {
    const Parser = await loadAsciiMath();
    parser = new Parser();
  } catch {
    return 0;
  }
  let count = 0;

  for (const element of elements) {
    const block = element.classList.contains("stemblock");
    const target = block ? element.querySelector<HTMLElement>(".content") : element;
    if (!target) continue;

    const segments = block ? asciimathSegments(target) : [target.textContent ?? ""];
    const rendered: Node[] = [];
    let failed = false;
    for (const raw of segments) {
      // The block converter leaves Asciidoctor's `\$...\$` around the body;
      // inline stems were already emitted without it.
      const body = raw.replace(/\\\$/g, "").trim();
      if (!body) continue;
      try {
        rendered.push(mathNode({ body: parser.parse(body), display: block }));
      } catch {
        failed = true;
        break;
      }
    }
    if (failed || rendered.length === 0) continue;

    if (block) {
      const fragment = document.createDocumentFragment();
      rendered.forEach((node, index) => {
        if (index > 0) fragment.appendChild(document.createElement("br"));
        fragment.appendChild(node);
      });
      target.replaceChildren(fragment);
    } else {
      element.replaceWith(...rendered);
    }
    count += rendered.length;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

/**
 * The DOM sanitising profile shared by the preview and the pandoc export.
 *
 * The export never inserts its HTML into the application, but it does hand it
 * to pandoc, so raw HTML blocks from an AsciiDoc document still pass through a
 * sanitiser at the boundary. The allow-list is the preview's: it keeps the
 * table, list and stem attributes the converter emits and removes scripts,
 * forms and embedded documents.
 */
function sanitizeAsciidoc(raw: string): string {
  return DOMPurify.sanitize(raw, {
    ADD_ATTR: [
      "align",
      "checked",
      "colspan",
      "data-lang",
      "data-mdraft-math",
      "data-stem",
      "data-title",
      "data-value",
      "disabled",
      "id",
      "reversed",
      "rowspan",
      "start",
      "type",
    ],
    FORBID_TAGS: [
      "script",
      "iframe",
      "object",
      "embed",
      "form",
      "textarea",
      "select",
      "button",
      "base",
    ],
    USE_PROFILES: { html: true },
  });
}

/** Insert one sanitised batch into the live host. */
function insertAsciidocBatch(host: HTMLElement, batch: readonly string[]): void {
  const holder = document.createElement("div");
  holder.innerHTML = sanitizeAsciidoc(batch.join(""));
  while (holder.firstChild) host.appendChild(holder.firstChild);
}

const previewIncludeCache = new AsciidocIncludeCache();

/** Invalidate cached AsciiDoc includes (called on save, dirty buffer edits, or reload). */
export function invalidateAsciidocIncludeCache(path?: string): void {
  previewIncludeCache.invalidate(path);
}

/** Expose include cache telemetry (hits, misses, IPC reads) for benchmarks and diagnostics. */
export function asciidocIncludeCacheStats(): AsciidocIncludeCacheStats {
  return previewIncludeCache.stats();
}

function restoreAsciidocMath(host: HTMLElement, maths: readonly RenderedMath[] | undefined): void {
  if (!maths || maths.length === 0) return;
  const placeholders = Array.from(host.querySelectorAll<HTMLElement>("span[data-mdraft-math]"));
  for (const placeholder of placeholders) {
    const idx = Number(placeholder.getAttribute("data-mdraft-math"));
    if (!Number.isInteger(idx) || idx < 0 || idx >= maths.length) {
      placeholder.remove();
      continue;
    }
    placeholder.replaceWith(mathNode(maths[idx]));
  }
}

function scheduleDeferredMermaid(
  host: HTMLElement,
  isDark: boolean,
  cancelled: () => boolean,
): void {
  if (!host.querySelector(".mermaid[data-mermaid]")) return;
  const run = (): void => {
    if (cancelled()) return;
    void renderMermaidIn(host, isDark, cancelled);
  };
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(run);
  } else {
    setTimeout(run, 0);
  }
}

/** Everything after the HTML is inserted EXCEPT Mermaid diagrams: line markers,
 * source offsets, restoring pre-rendered KaTeX placeholders (with fallback for
 * unrendered delimiters/stems), code highlighting, and links. */
async function finalizeAsciidocDom(
  host: HTMLElement,
  chunks: AsciidocChunks,
  options: AsciidocRenderOptions,
  source: string,
): Promise<{ linesMapped: boolean; blocks: BlockRange[] }> {
  const lines = source.split("\n").length;
  const sorted = chunks.marks.slice().sort((a, b) => a.line - b.line);
  const ranges = new Map<string, { line: number; end: number }>();
  sorted.forEach((mark, index) => {
    const next = sorted[index + 1];
    ranges.set(mark.marker, {
      line: mark.line,
      end: next ? Math.max(mark.line, next.line - 1) : Math.max(mark.line, lines),
    });
  });

  for (const element of Array.from(host.querySelectorAll("[class]"))) {
    const marker = Array.from(element.classList).find((name) => name.startsWith("mdraft-line-"));
    if (!marker) continue;
    const range = ranges.get(marker);
    element.classList.remove(marker);
    if (element.classList.length === 0) element.removeAttribute("class");
    if (range) {
      const target = element.matches(".sect1, .sect2, .sect3, .sect4, .sect5")
        ? (element.querySelector<HTMLElement>(
            ":scope > h2, :scope > h3, :scope > h4, :scope > h5, :scope > h6",
          ) ?? element)
        : element;
      target.setAttribute("data-line", String(range.line));
      target.setAttribute("data-line-end", String(range.end));
    }
  }

  if (chunks.hasHeader && !chunks.notitle) {
    const title = host.querySelector("h1");
    if (title) {
      title.setAttribute("data-line", "1");
      title.setAttribute("data-line-end", "1");
    }
  }

  const lineOffsets: number[] = [0];
  for (let i = 0; i < source.length; i += 1) {
    if (source.charCodeAt(i) === 10) lineOffsets.push(i + 1);
  }
  const blocks: BlockRange[] = [];
  for (const element of Array.from(host.querySelectorAll<HTMLElement>("[data-line]"))) {
    const start = Number(element.dataset.line);
    const end = Number(element.dataset.lineEnd ?? element.dataset.line);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    const src0 = lineOffsets[Math.max(0, start - 1)] ?? 0;
    const src1 = end < lineOffsets.length ? lineOffsets[end] : source.length;
    element.dataset.b = String(blocks.length);
    blocks.push({ src0, src1 });
  }

  if (options.math) {
    restoreAsciidocMath(host, chunks.maths);
    if (!chunks.mathRendered && /\\[([]/.test(host.textContent ?? "")) {
      renderMathIn(host);
    }
    if (host.querySelector('[data-stem="asciimath"]') !== null) {
      await renderAsciiMathIn(host);
    }
  }
  decorateCodeBlocks(host, options.mermaid);
  decorateLinks(host, options.baseDir);

  return { linesMapped: host.querySelectorAll("[data-line]").length >= 2, blocks };
}

/**
 * Synchronous DOM completion (including blocking Mermaid) for exports and
 * headless tests.
 */
async function finishAsciidoc(
  host: HTMLElement,
  chunks: AsciidocChunks,
  options: AsciidocRenderOptions,
  source: string,
): Promise<{ linesMapped: boolean; blocks: BlockRange[] }> {
  const done = await finalizeAsciidocDom(host, chunks, options, source);
  await renderMermaidIn(host, options.isDark);
  return done;
}

/** Render AsciiDoc synchronously. Used by the export article and as the fallback. */
export async function renderAsciidocPreview(
  source: string,
  options: AsciidocRenderOptions,
): Promise<AsciidocRenderResult> {
  try {
    if (!source.trim()) return { html: "", linesMapped: false, blocks: [] };
    const chunks = await renderAsciidocChunks(source, {
      baseDir: options.baseDir,
      math: options.math,
      readFile: async (path) => (await api.readDocument(path)).content,
    });
    const host = document.createElement("div");
    for (const batch of batchesForChunks(chunks.chunks)) insertAsciidocBatch(host, batch);
    const done = await finishAsciidoc(host, chunks, options, source);
    return { html: host.innerHTML, ...done };
  } catch (error) {
    return {
      html: `<pre class="asciidoc-error">${escapeHtml(String(error))}</pre>`,
      linesMapped: false,
      blocks: [],
    };
  }
}

/**
 * Paint the AsciiDoc preview from the worker, yielding between batches.
 *
 * Includes are read on the main thread first because the worker cannot call the
 * Tauri command. A document whose include path is built from an attribute
 * cannot be pre-read; it stays on the main-thread conversion rather than risking
 * the wrong file. A worker failure falls back the same way.
 */
export async function renderAsciidocPreviewInto(
  host: HTMLElement,
  source: string,
  options: AsciidocRenderOptions,
  cancelled: () => boolean,
): Promise<{ linesMapped: boolean; blocks: BlockRange[] } | null> {
  try {
    if (!source.trim()) {
      host.replaceChildren();
      return { linesMapped: false, blocks: [] };
    }
    const readFile = async (path: string) => (await api.readDocument(path)).content;
    const cachedReadFile = (path: string) => previewIncludeCache.readThrough(path, readFile);
    let includes: AsciidocIncludeMap | null = null;
    try {
      includes = await preloadAsciidocIncludes(source, {
        baseDir: options.baseDir,
        readFile,
        cache: previewIncludeCache,
      });
    } catch {
      includes = null;
    }
    if (cancelled()) return null;

    let chunks: AsciidocChunks;
    if (includes) {
      const outcome = await renderAsciidocChunksAsync(source, {
        baseDir: options.baseDir,
        math: options.math,
        includes,
      });
      if (outcome.kind === "superseded") return null;
      if (outcome.kind === "fallback") {
        if (cancelled()) return null;
        chunks = await renderAsciidocChunks(source, {
          baseDir: options.baseDir,
          math: options.math,
          readFile: cachedReadFile,
        });
      } else {
        chunks = outcome.data;
      }
    } else {
      chunks = await renderAsciidocChunks(source, {
        baseDir: options.baseDir,
        math: options.math,
        readFile: cachedReadFile,
      });
    }
    if (cancelled()) return null;

    // Build in a detached container and swap once; appending batches to the
    // live pane forced a layout of the growing document per batch.
    const staging = document.createElement("div");
    let lastYield = performance.now();
    for (const batch of batchesForChunks(chunks.chunks)) {
      if (cancelled()) return null;
      insertAsciidocBatch(staging, batch);
      lastYield = await settleMainThread(lastYield);
      if (cancelled()) return null;
    }
    const done = await finalizeAsciidocDom(staging, chunks, options, source);
    if (cancelled()) return null;
    const fragment = document.createDocumentFragment();
    while (staging.firstChild) fragment.appendChild(staging.firstChild);
    host.replaceChildren(fragment);
    if (options.mermaid) scheduleDeferredMermaid(host, options.isDark, cancelled);
    return done;
  } catch (error) {
    if (cancelled()) return null;
    host.innerHTML = `<pre class="asciidoc-error">${escapeHtml(String(error))}</pre>`;
    return { linesMapped: false, blocks: [] };
  }
}

/**
 * The AsciiDoc buffer as clean HTML for a pandoc export.
 *
 * The preview's decorations are deliberately absent: pandoc needs semantic
 * HTML (`<pre><code>`, `\(…\)`) rather than KaTeX spans, highlight.js tokens or
 * `data-line` anchors. Includes are read through the same command and jail the
 * preview uses. A conversion failure is thrown rather than turned into an
 * error box, because an export must stop instead of writing a PDF of the error
 * message.
 */
export async function renderAsciidocForExport(
  source: string,
  options: { baseDir: string | null },
): Promise<string> {
  const raw = await renderAsciidocForPandoc(source, {
    baseDir: options.baseDir,
    readFile: async (path) => (await api.readDocument(path)).content,
  });
  return raw ? sanitizeAsciidoc(raw) : "";
}
