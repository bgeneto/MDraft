//! AsciiDoc -> clean HTML for pandoc, and the pieces the preview shares.
//!
//! Pandoc's own AsciiDoc reader is not AsciiDoc enough for an export: it treats
//! an unset attribute (`:toc!:`) as the end of the attribute block and prints
//! that line and every `:name: value` below it as prose, never evaluates
//! `ifdef::…[]` / `ifndef::…[]`, and leaves `{attribute}` references untouched.
//! Asciidoctor already resolves all of that for the preview, so an export asks
//! it for the same document as HTML and hands that to pandoc's mature HTML
//! reader. The route is documented in
//! `docs/adr/2026-10-19-asciidoc-pandoc-export.md`.
//!
//! There is no DOM here on purpose: `scripts/asciidoc-export-unit.mjs` imports
//! this module under Node, and the preview imports the same loader and include
//! processor. The preview's KaTeX decorations stay in `asciidoc-preview.ts`;
//! an export must give pandoc the source delimiters, not rendered KaTeX spans.

import { renderKatexCached } from "./katex-cache.ts";
import type { RenderedMath } from "./preview-render.ts";
import { diffBlocks, fnv1aHash, type BlockPatchOp, type DiffableBlock } from "./block-diff.ts";

type AsciidoctorModule = typeof import("@asciidoctor/core");

const MAX_ASCIIMATH_LRU = 2000;
const asciimathTexLru = new Map<string, string>();

export interface AsciiMathParser {
  parse(input: string): string;
}

type AsciiMathConstructor = new () => AsciiMathParser;

let asciidoctorPromise: Promise<AsciidoctorModule> | null = null;

/** Load Asciidoctor once per renderer, as the preview has always done. */
export function loadAsciidoctor(): Promise<AsciidoctorModule> {
  if (!asciidoctorPromise) {
    // The package exports only ".", and Vite's browser condition resolves that
    // to build/browser/index.js. A /build/browser subpath is not exported.
    asciidoctorPromise = import("@asciidoctor/core");
  }
  return asciidoctorPromise;
}

let asciimathPromise: Promise<AsciiMathConstructor> | null = null;

/** Load the AsciiMath -> TeX parser only when a stem actually needs it. */
export function loadAsciiMath(): Promise<AsciiMathConstructor> {
  if (!asciimathPromise) {
    asciimathPromise = import("asciimath2tex").then((module) => module.default);
  }
  return asciimathPromise;
}

// ---------------------------------------------------------------------------
// Paths and includes
// ---------------------------------------------------------------------------

function normalizePath(input: string): string {
  // The browser build of Asciidoctor reports `base_dir`-derived paths with a
  // leading slash before the drive (`/C:/…`), while the Rust payload uses
  // `C:\…`. Fold the two so the containment check compares like with like.
  const slashed = input.replace(/\\/g, "/").replace(/^\/([A-Za-z]:\/)/, "$1");
  const drive = /^([A-Za-z]:)(?:\/|$)/.exec(slashed);
  const prefix = drive ? `${drive[1]}/` : slashed.startsWith("/") ? "/" : "";
  const rest = prefix ? slashed.slice(prefix.length) : slashed;
  const parts: string[] = [];
  for (const part of rest.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return "";
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return prefix + parts.join("/");
}

function foldForCompare(path: string): string {
  // The Node suite runs on Node 20, which has no global `navigator`; the
  // drive-letter check alone is enough there, and the browser adds the
  // case-insensitive Windows rule for paths without a drive.
  const userAgent = typeof navigator === "undefined" ? "" : navigator.userAgent;
  return /^[A-Za-z]:/.test(path) || /Windows/i.test(userAgent) ? path.toLowerCase() : path;
}

function isInside(base: string, candidate: string): boolean {
  const parent = foldForCompare(base.replace(/\/+$/, ""));
  const child = foldForCompare(candidate);
  return child === parent || child.startsWith(`${parent}/`);
}

function isAbsoluteInclude(target: string): boolean {
  return (
    /^[A-Za-z]:[\\/]/.test(target) ||
    target.startsWith("/") ||
    target.startsWith("\\") ||
    target.startsWith("//") ||
    /^file:/i.test(target) ||
    /^[a-z][a-z0-9+.-]*:/i.test(target)
  );
}

function resolveInclude(
  target: string,
  currentDir: string | null,
  baseDir: string | null,
): string | null {
  if (!baseDir) return null;
  const raw = target
    .trim()
    .replace(/^"(.*)"$/, "$1")
    .replace(/^'(.*)'$/, "$1");
  if (!raw || isAbsoluteInclude(raw)) return null;

  const base = normalizePath(baseDir);
  if (!base) return null;
  const directory =
    currentDir && currentDir !== "." && currentDir !== "" ? normalizePath(currentDir) : base;
  if (!directory) return null;

  const candidate = normalizePath(`${directory}/${raw}`);
  if (!candidate || !isInside(base, candidate)) return null;
  return candidate;
}

/** Everything an Asciidoctor render needs from the application. */
export interface AsciidocRenderOptions {
  baseDir: string | null;
  /** Read one included file. The application passes `api.readDocument`. */
  readFile: (path: string) => Promise<string>;
}

/**
 * The include processor both the preview and the export use.
 *
 * The document directory is the jail: `http:`, `file:`, UNC, absolute and
 * escaping `..` targets are refused and become a visible unresolved directive.
 * The include stack is per render, so two documents cannot see each other's
 * cycles or paths.
 */
export function createIncludeProcessor(
  Asciidoctor: AsciidoctorModule,
  options: AsciidocRenderOptions,
) {
  const baseDir = options.baseDir;
  const includeStack: string[] = [];

  const pushIncludeError = (
    reader: { path?: string; pushInclude: (...args: unknown[]) => unknown },
    target: string,
    reason: string,
  ): void => {
    const where = reader.path ?? "this document";
    reader.pushInclude(
      `Unresolved directive in ${where} - include::${target}[] (${reason})`,
      target,
      target,
      1,
    );
  };

  return class IncludeExtension extends Asciidoctor.IncludeProcessor {
    handles(_doc: unknown, _target: string): boolean {
      return true;
    }

    async process(
      _doc: any,
      reader: any,
      target: string,
      _attributes: Record<string, string>,
    ): Promise<void> {
      const resolved = resolveInclude(target, reader._dir ?? null, baseDir);
      if (!resolved) {
        pushIncludeError(reader, target, "outside the document directory");
        return;
      }
      const key = foldForCompare(resolved);
      if (includeStack.includes(key)) {
        pushIncludeError(reader, target, "include cycle");
        return;
      }
      try {
        const content = await options.readFile(resolved);
        includeStack.push(key);
        try {
          reader.pushInclude(content, resolved, resolved, 1);
        } finally {
          includeStack.pop();
        }
      } catch (error) {
        pushIncludeError(reader, target, String(error));
      }
    }
  };
}

// ---------------------------------------------------------------------------
// Preview chunks
// ---------------------------------------------------------------------------

/** A file pre-read for the worker, or the failure the include processor saw. */
export type AsciidocIncludeMap = Record<string, { content: string } | { error: string }>;

/** What the worker receives for an AsciiDoc job. */
export interface AsciidocWorkerOptions {
  baseDir: string | null;
  math: boolean;
  includes: AsciidocIncludeMap;
}

export interface AsciidocChunkOptions {
  baseDir: string | null;
  math: boolean;
  /** Main-thread include reads; the preview and the fallback use this. */
  readFile?: (path: string) => Promise<string>;
  /** Files pre-read by `preloadAsciidocIncludes` for the worker. */
  includes?: AsciidocIncludeMap;
}

export interface AsciidocMark {
  marker: string;
  line: number;
  endLine?: number;
}

export type AsciidocBlockKind = "top" | "sect-open" | "sect-child" | "sect-close";

export interface AsciidocBlockChunk extends DiffableBlock {
  kind: AsciidocBlockKind;
  /** Section heading slug for `sect-open`, `sect-child`, and `sect-close` blocks. */
  sectionId: string | null;
  html: string;
  marks: AsciidocMark[];
  maths: RenderedMath[];
}

export interface AsciidocIncrementalInfo {
  mode: "diff" | "full";
  reason?: string;
  dirtyRatio: number;
  dirtyBlocks: number;
  ops: BlockPatchOp<AsciidocBlockChunk>[];
  totalLines: number;
}

export interface AsciidocChunks {
  /** Top-level and sub-section HTML segments in document order, without chunk comments. */
  chunks: string[];
  /** The role marker each block carries and its source line. */
  marks: AsciidocMark[];
  hasHeader: boolean;
  notitle: boolean;
  /** Pre-rendered KaTeX formulas referenced via `<span data-mdraft-math="i">`. */
  maths?: RenderedMath[];
  /** True when the converter/worker already pre-rendered delimited TeX in text nodes. */
  mathRendered?: boolean;
  /** Keyed sub-section block payloads with block-local `mdraft-line-*` and math indices. */
  blocks?: AsciidocBlockChunk[];
  /** Total source line count used when resolving final block end lines. */
  totalLines?: number;
  /** Patch metadata populated when produced via `renderAsciidocChunksIncremental`. */
  incremental?: AsciidocIncrementalInfo;
}

export interface AsciidocIncludeEntry {
  content?: string;
  error?: string;
}

export interface AsciidocIncludeCacheStats {
  entries: number;
  hits: number;
  misses: number;
  ipcCalls: number;
}

/**
 * Bounded per-path cache for included AsciiDoc fragments (`include::path[]`).
 *
 * Eliminates repeated `readDocument` IPC calls on every parent-document keystroke
 * while supporting explicit invalidation on save, dirty-buffer edit, reload, or
 * directory clear.
 */
export class AsciidocIncludeCache {
  entries = new Map<string, AsciidocIncludeEntry>();
  hits = 0;
  misses = 0;
  ipcCalls = 0;
  maxEntries: number;

  constructor(maxEntries = 256) {
    this.maxEntries = maxEntries;
  }

  get(path: string): AsciidocIncludeEntry | undefined {
    const key = foldForCompare(normalizePath(path));
    const hit = this.entries.get(key);
    if (hit !== undefined) {
      this.hits += 1;
      // Refresh LRU insertion order.
      this.entries.delete(key);
      this.entries.set(key, hit);
      return hit;
    }
    this.misses += 1;
    return undefined;
  }

  set(path: string, entry: AsciidocIncludeEntry): void {
    const key = foldForCompare(normalizePath(path));
    if (this.entries.has(key)) this.entries.delete(key);
    else if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, entry);
  }

  async readThrough(
    path: string,
    readFile: (target: string) => Promise<string>,
    bypass = false,
  ): Promise<string> {
    if (!bypass) {
      const hit = this.get(path);
      if (hit !== undefined) {
        if (hit.error !== undefined) throw hit.error;
        return hit.content ?? "";
      }
    }
    this.ipcCalls += 1;
    try {
      const content = await readFile(path);
      this.set(path, { content });
      return content;
    } catch (error) {
      this.set(path, { error: String(error) });
      throw error;
    }
  }

  invalidate(path?: string): void {
    if (!path) {
      this.entries.clear();
      return;
    }
    const key = foldForCompare(normalizePath(path));
    this.entries.delete(key);
  }

  invalidateDirectory(dir: string): void {
    const base = foldForCompare(normalizePath(dir).replace(/\/+$/, ""));
    if (!base) return;
    for (const key of Array.from(this.entries.keys())) {
      if (key === base || key.startsWith(`${base}/`)) this.entries.delete(key);
    }
  }

  stats(): AsciidocIncludeCacheStats {
    return {
      entries: this.entries.size,
      hits: this.hits,
      misses: this.misses,
      ipcCalls: this.ipcCalls,
    };
  }

  resetStats(): void {
    this.hits = 0;
    this.misses = 0;
    this.ipcCalls = 0;
  }
}

const CHUNK_OPEN = "<!--mdraft-chunk-->";
const CHUNK_CLOSE = "<!--/mdraft-chunk-->";
const SUBCHUNK_OPEN = "<!--mdraft-subchunk-->";
const SUBCHUNK_CLOSE = "<!--/mdraft-subchunk-->";
const INCLUDE_DIRECTIVE = /^\s*include::([^[]+)\[[^\]]*\]\s*$/gm;
const MATH_IN_HTML_TEXT = /\\\(([\s\S]*?)\\\)|\\\[([\s\S]*?)\\\]/g;
const IGNORED_MATH_TAGS = new Set(["pre", "code", "script", "style", "textarea"]);

function decodeHtmlEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos|#39);/gi, (full, entity) => {
    const lower = String(entity).toLowerCase();
    if (lower === "lt") return "<";
    if (lower === "gt") return ">";
    if (lower === "amp") return "&";
    if (lower === "quot") return '"';
    if (lower === "apos" || lower === "#39") return "'";
    if (lower.startsWith("#x")) {
      const code = Number.parseInt(lower.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : full;
    }
    if (lower.startsWith("#")) {
      const code = Number.parseInt(lower.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : full;
    }
    return full;
  });
}

function parseAsciiMathCached(parser: AsciiMathParser, raw: string): string {
  const cached = asciimathTexLru.get(raw);
  if (cached !== undefined) {
    asciimathTexLru.delete(raw);
    asciimathTexLru.set(raw, cached);
    return cached;
  }
  const tex = parser.parse(raw);
  if (asciimathTexLru.size >= MAX_ASCIIMATH_LRU) {
    const oldest = asciimathTexLru.keys().next().value;
    if (oldest !== undefined) asciimathTexLru.delete(oldest);
  }
  asciimathTexLru.set(raw, tex);
  return tex;
}

/**
 * Pre-render `\(…\)` and `\[…\]` text segments directly inside converted AsciiDoc HTML
 * outside `<pre>` / `<code>` / `<script>` / `<style>` / `<textarea>`, replacing them with
 * `<span data-mdraft-math="idx"></span>` backed by `maths`.
 */
function preRenderRawDelimitedMath(
  raw: string,
  pushMath: (body: string, display: boolean) => string,
): string {
  if (!/\\[([]/.test(raw)) return raw;

  let out = "";
  let cursor = 0;
  let ignoredDepth = 0;
  let changed = false;

  const rewriteText = (text: string): string => {
    if (!/\\[([]/.test(text)) return text;
    MATH_IN_HTML_TEXT.lastIndex = 0;
    let match: RegExpExecArray | null;
    let last = 0;
    let buf = "";
    let localChanged = false;
    while ((match = MATH_IN_HTML_TEXT.exec(text)) !== null) {
      localChanged = true;
      if (match.index > last) buf += text.slice(last, match.index);
      const display = match[2] !== undefined;
      const body = decodeHtmlEntities((display ? match[2] : match[1]) ?? "");
      buf += pushMath(body, display);
      last = MATH_IN_HTML_TEXT.lastIndex;
    }
    if (!localChanged) return text;
    changed = true;
    if (last < text.length) buf += text.slice(last);
    return buf;
  };

  while (cursor < raw.length) {
    const tagStart = raw.indexOf("<", cursor);
    if (tagStart < 0) {
      const tail = raw.slice(cursor);
      out += ignoredDepth === 0 ? rewriteText(tail) : tail;
      break;
    }
    if (tagStart > cursor) {
      const text = raw.slice(cursor, tagStart);
      out += ignoredDepth === 0 ? rewriteText(text) : text;
    }
    // Preserve HTML comments verbatim without scanning `<`/`>` inside them as tags.
    if (raw.startsWith("<!--", tagStart)) {
      const commentEnd = raw.indexOf("-->", tagStart + 4);
      const end = commentEnd < 0 ? raw.length : commentEnd + 3;
      out += raw.slice(tagStart, end);
      cursor = end;
      continue;
    }
    const tagEnd = raw.indexOf(">", tagStart + 1);
    if (tagEnd < 0) {
      out += raw.slice(tagStart);
      break;
    }
    const tag = raw.slice(tagStart, tagEnd + 1);
    out += tag;
    const tagMatch = /^<\s*(\/?)\s*([A-Za-z0-9]+)/.exec(tag);
    if (tagMatch) {
      const name = tagMatch[2].toLowerCase();
      if (IGNORED_MATH_TAGS.has(name)) {
        if (tagMatch[1]) {
          if (ignoredDepth > 0) ignoredDepth -= 1;
        } else if (!tag.endsWith("/>")) {
          ignoredDepth += 1;
        }
      }
    }
    cursor = tagEnd + 1;
  }

  return changed ? out : raw;
}

/** A converter that wraps each top-level block in a split marker and pre-renders
 * stems with KaTeX in the worker when `markStems` is enabled. */
function createPreviewConverterFactory(
  Asciidoctor: AsciidoctorModule,
  markStems: boolean,
  pushMath?: (body: string, display: boolean) => string,
  getAsciimathParser?: () => Promise<AsciiMathParser | null>,
): unknown {
  class PreviewHtml5Converter extends Asciidoctor.Html5Converter {
    async convert(node: any, transform?: string): Promise<string> {
      const html = String(await super.convert(node, transform));
      if (!node || !node.context || node.context === "document") return html;
      if (node.parent?.context === "document") {
        return `${CHUNK_OPEN}${html}${CHUNK_CLOSE}`;
      }
      if (
        node.parent?.context === "section" &&
        node.parent?.level === 1 &&
        node.parent?.parent?.context === "document"
      ) {
        return `${SUBCHUNK_OPEN}${html}${SUBCHUNK_CLOSE}`;
      }
      return html;
    }

    async convert_inline_quoted(node: any): Promise<string> {
      if (markStems && node.type === "asciimath") {
        const text = String(node.text ?? "");
        if (pushMath && getAsciimathParser) {
          const parser = await getAsciimathParser();
          if (parser) {
            try {
              const tex = parseAsciiMathCached(parser, decodeHtmlEntities(text));
              return pushMath(tex, false);
            } catch {
              // Fall back to main-thread marking so malformed stems match legacy behavior.
            }
          }
        }
        return `<span data-stem="asciimath">${node.text ?? ""}</span>`;
      }
      return super.convert_inline_quoted(node);
    }

    async convert_stem(node: any): Promise<string> {
      const html = String(await super.convert_stem(node));
      if (!markStems || node.style !== "asciimath") return html;
      if (pushMath && getAsciimathParser) {
        const parser = await getAsciimathParser();
        if (parser) {
          const rawLines: string[] = Array.isArray(node.lines)
            ? node.lines.map((line: unknown) => String(line))
            : String(node.source ?? "").split("\n");
          const spans: string[] = [];
          let failed = false;
          for (const rawLine of rawLines) {
            const clean = decodeHtmlEntities(rawLine.replace(/\\\$/g, "")).trim();
            if (!clean) continue;
            try {
              spans.push(pushMath(parseAsciiMathCached(parser, clean), true));
            } catch {
              failed = true;
              break;
            }
          }
          if (!failed && spans.length > 0) {
            const contentOpen = html.indexOf('<div class="content">');
            const innerClose = contentOpen >= 0 ? html.indexOf("</div>", contentOpen) : -1;
            if (contentOpen >= 0 && innerClose >= contentOpen) {
              return `${html.slice(0, contentOpen)}<div class="content">\n${spans.join("<br>")}\n${html.slice(innerClose)}`;
            }
          }
        }
      }
      return html.replace(/^<div/, '<div data-stem="asciimath"');
    }
  }

  const factory = new Asciidoctor.ConverterCustomFactory();
  factory.register(PreviewHtml5Converter, "html5");
  return factory;
}

/** Mark every block with its source line, as the preview always has. */
function createPreviewMarkerProcessor(Asciidoctor: AsciidoctorModule, marks: AsciidocMark[]) {
  return class PreviewMarkerProcessor extends Asciidoctor.TreeProcessor {
    private readonly seen = new Set<unknown>();

    process(doc: unknown): void {
      const visit = (node: unknown): void => {
        if (!node || typeof node !== "object" || this.seen.has(node)) return;
        this.seen.add(node);
        if (Array.isArray(node)) {
          for (const child of node) visit(child);
          return;
        }
        const record = node as {
          sourceLocation?: { file?: string | null; lineno?: number } | null;
          addRole?: (role: string) => unknown;
          blocks?: unknown;
          items?: unknown;
          rows?: unknown;
          cells?: unknown;
        };
        const location = record.sourceLocation;
        if (
          location &&
          typeof location.lineno === "number" &&
          !location.file &&
          typeof record.addRole === "function"
        ) {
          const marker = `mdraft-line-${marks.length + 1}`;
          marks.push({ marker, line: location.lineno });
          record.addRole(marker);
        }
        visit(record.blocks);
        visit(record.items);
        visit(record.rows);
        visit(record.cells);
      };
      visit(doc);
    }
  };
}

interface RawAsciidocSegment {
  kind: AsciidocBlockKind;
  sectionId: string | null;
  html: string;
}

function extractSectionId(sectOpenHtml: string): string {
  const match = /<h[1-6]\b[^>]*\bid="([^"]+)"/i.exec(sectOpenHtml);
  if (match) return match[1];
  const normalized = sectOpenHtml.replace(/\bmdraft-line-\d+\b/g, "");
  return `sect_${fnv1aHash(normalized)}`;
}

function inferAsciidocElementTag(html: string): string {
  const trimmed = html.trimStart();
  const idMatch = /^<\s*[A-Za-z0-9]+\b[^>]*\bid="([^"]+)"/.exec(trimmed);
  if (
    idMatch &&
    (idMatch[1] === "preamble" || idMatch[1] === "toc" || idMatch[1] === "footnotes")
  ) {
    return idMatch[1];
  }
  const classMatch = /^<\s*[A-Za-z0-9]+\b[^>]*\bclass="([^"]+)"/.exec(trimmed);
  if (classMatch) {
    const cls = classMatch[1].split(/\s+/).find((c) => c && !c.startsWith("mdraft-line-"));
    if (cls) return cls;
  }
  const tagMatch = /^<\s*([A-Za-z0-9]+)/.exec(trimmed);
  return tagMatch ? tagMatch[1].toLowerCase() : "fragment";
}

function splitRawAsciidocSegments(raw: string): RawAsciidocSegment[] {
  const segments: RawAsciidocSegment[] = [];
  const pushTop = (html: string): void => {
    if (html.trim().length === 0) return;
    // Document headers with `:toc:` emit `<h1>...</h1>` and `<div id="toc">...</div>`
    // together before the first section; splitting them preserves 1:1 section-group
    // mapping against `#preview` children during incremental DOM reconciliation.
    const tocIdx = html.indexOf('<div id="toc"');
    if (tocIdx > 0 && /^<\s*h1\b/i.test(html.trimStart())) {
      const head = html.slice(0, tocIdx);
      const tail = html.slice(tocIdx);
      if (head.trim().length > 0) segments.push({ kind: "top", sectionId: null, html: head });
      if (tail.trim().length > 0) segments.push({ kind: "top", sectionId: null, html: tail });
      return;
    }
    segments.push({ kind: "top", sectionId: null, html });
  };

  let cursor = 0;
  for (;;) {
    const open = raw.indexOf(CHUNK_OPEN, cursor);
    if (open < 0) {
      if (cursor < raw.length) pushTop(raw.slice(cursor));
      break;
    }
    if (open > cursor) pushTop(raw.slice(cursor, open));
    const start = open + CHUNK_OPEN.length;
    const close = raw.indexOf(CHUNK_CLOSE, start);
    const inner = close < 0 ? raw.slice(start) : raw.slice(start, close);
    cursor = close < 0 ? raw.length : close + CHUNK_CLOSE.length;

    const firstSub = inner.indexOf(SUBCHUNK_OPEN);
    if (firstSub < 0) {
      pushTop(inner);
      if (close < 0) break;
      continue;
    }

    const sectOpenHtml = inner.slice(0, firstSub);
    const sectionId = extractSectionId(sectOpenHtml);
    segments.push({ kind: "sect-open", sectionId, html: sectOpenHtml });

    let subCursor = firstSub;
    while (subCursor < inner.length) {
      const subOpen = inner.indexOf(SUBCHUNK_OPEN, subCursor);
      if (subOpen < 0) {
        const tail = inner.slice(subCursor);
        segments.push({ kind: "sect-close", sectionId, html: tail });
        break;
      }
      const subStart = subOpen + SUBCHUNK_OPEN.length;
      const subClose = inner.indexOf(SUBCHUNK_CLOSE, subStart);
      if (subClose < 0) {
        const rest = inner.slice(subStart).replace(/<!--\/?mdraft-(?:sub)?chunk-->/g, "");
        if (rest.trim().length > 0) {
          segments.push({ kind: "sect-child", sectionId, html: rest });
        }
        segments.push({ kind: "sect-close", sectionId, html: "</div>\n</div>" });
        break;
      }
      const subBody = inner.slice(subStart, subClose);
      if (subBody.trim().length > 0) {
        segments.push({ kind: "sect-child", sectionId, html: subBody });
      }
      subCursor = subClose + SUBCHUNK_CLOSE.length;
    }

    if (close < 0) break;
  }

  return segments;
}

const ASCIIDOC_LINE_MARKER_RE = /\bmdraft-line-(\d+)\b/g;
const ASCIIDOC_MATH_SLOT_RE = /<span data-mdraft-math="(\d+)"><\/span>/g;

function buildLocalizedAsciidocBlocks(
  raw: string,
  rawMarks: readonly AsciidocMark[],
  rawMaths: readonly RenderedMath[],
  totalLines: number,
): { chunks: string[]; blocks: AsciidocBlockChunk[] } {
  const sorted = rawMarks.slice().sort((a, b) => a.line - b.line);
  const markRangeByName = new Map<string, { line: number; endLine: number }>();
  for (let i = 0; i < sorted.length; i += 1) {
    const cur = sorted[i];
    const next = sorted[i + 1];
    markRangeByName.set(cur.marker, {
      line: cur.line,
      endLine: next ? Math.max(cur.line, next.line - 1) : Math.max(cur.line, totalLines),
    });
  }

  const rawByIndex = new Map<string, AsciidocMark>();
  for (const m of rawMarks) rawByIndex.set(m.marker, m);

  const segments = splitRawAsciidocSegments(raw);
  const chunks: string[] = new Array(segments.length);
  const blocks: AsciidocBlockChunk[] = new Array(segments.length);
  let runningLine = 1;

  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i];
    const seenMarks = new Map<string, number>();
    const localMarks: AsciidocMark[] = [];

    let localized = seg.html.replace(ASCIIDOC_LINE_MARKER_RE, (full) => {
      let localIdx = seenMarks.get(full);
      if (localIdx === undefined) {
        const range = markRangeByName.get(full);
        const origMark = rawByIndex.get(full);
        localIdx = localMarks.length;
        const localMarker = `mdraft-line-${localIdx}`;
        if (range) {
          localMarks.push({ marker: localMarker, line: range.line, endLine: range.endLine });
        } else if (origMark) {
          localMarks.push({ marker: localMarker, line: origMark.line, endLine: origMark.line });
        }
        seenMarks.set(full, localIdx);
      }
      return `mdraft-line-${localIdx}`;
    });

    const seenMaths = new Map<number, number>();
    const localMaths: RenderedMath[] = [];
    localized = localized.replace(ASCIIDOC_MATH_SLOT_RE, (_, gIdxRaw: string) => {
      const gIdx = Number(gIdxRaw);
      let localIdx = seenMaths.get(gIdx);
      if (localIdx === undefined) {
        localIdx = localMaths.length;
        seenMaths.set(gIdx, localIdx);
        localMaths.push(
          rawMaths[gIdx] ?? { body: "", display: false, html: null, error: "missing math slot" },
        );
      }
      return `<span data-mdraft-math="${localIdx}"></span>`;
    });

    const lineStart = localMarks.length > 0 ? localMarks[0].line : runningLine;
    runningLine = lineStart;
    let key: string;
    if (seg.kind === "sect-open") key = `sect-open:${seg.sectionId}`;
    else if (seg.kind === "sect-close") key = `sect-close:${seg.sectionId}`;
    else if (seg.kind === "sect-child") {
      key = `sect-child:${seg.sectionId}:${inferAsciidocElementTag(localized)}`;
    } else {
      key = `top:${inferAsciidocElementTag(localized)}`;
    }

    chunks[i] = localized;
    blocks[i] = {
      kind: seg.kind,
      sectionId: seg.sectionId,
      key,
      digest: fnv1aHash(`${seg.kind}\0${localized}`),
      lineStart,
      lineEnd: localMarks.length > 0 ? localMarks[0].endLine : lineStart,
      html: localized,
      marks: localMarks,
      maths: localMaths,
    };
  }

  return { chunks, blocks };
}

/** The directory Asciidoctor would use for an included file's own includes. */
function includeDirectory(path: string): string {
  const at = path.lastIndexOf("/");
  return at > 0 ? path.slice(0, at) : path;
}

/**
 * Read every include a document can reach, before the worker starts.
 *
 * The worker cannot call `api.readDocument`. A literal `include::path[...]` is
 * resolved with the same jail as the include processor and its file is read on
 * the main thread; nested includes are scanned in the included content. A
 * target built from an attribute (`include::{dir}/x[]`) cannot be resolved
 * here, so the whole document falls back to the main-thread conversion rather
 * than risking a wrong path.
 */
export async function preloadAsciidocIncludes(
  source: string,
  options: {
    baseDir: string | null;
    readFile: (path: string) => Promise<string>;
    cache?: AsciidocIncludeCache;
    bypassCache?: boolean;
  },
): Promise<AsciidocIncludeMap | null> {
  if (!options.baseDir || !source.includes("include::")) return {};
  const map: AsciidocIncludeMap = {};
  const seen = new Set<string>();
  const readCached = async (path: string): Promise<string> => {
    if (options.cache) {
      return options.cache.readThrough(path, options.readFile, Boolean(options.bypassCache));
    }
    return options.readFile(path);
  };

  // Strip `//// ... ////` block comments cleanly before matching `include::` lines.
  const scanSource = (text: string): string => {
    if (!text.includes("////")) return text;
    let inComment = false;
    return text
      .split("\n")
      .map((line) => {
        if (/^\s*\/\/\/\/\s*$/.test(line.replace(/\r$/, ""))) {
          inComment = !inComment;
          return "";
        }
        return inComment ? "" : line;
      })
      .join("\n");
  };

  const scan = async (text: string, currentDir: string | null): Promise<boolean> => {
    const cleanText = scanSource(text);
    for (const match of cleanText.matchAll(INCLUDE_DIRECTIVE)) {
      const target = match[1].trim();
      if (target.includes("{")) return false;
      const resolved = resolveInclude(target, currentDir, options.baseDir);
      if (!resolved) continue;
      const key = foldForCompare(resolved);
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        const content = await readCached(resolved);
        map[resolved] = { content };
        if (!(await scan(content, includeDirectory(resolved)))) return false;
      } catch (error) {
        map[resolved] = { error: String(error) };
      }
    }
    return true;
  };

  return (await scan(source, options.baseDir)) ? map : null;
}

/**
 * Convert AsciiDoc to top-level HTML segments for the preview.
 *
 * The conversion is the expensive part and is DOM-free; the marker roles and
 * chunk comments are plain HTML, so this runs in the worker and the main thread
 * only sanitises and inserts. `marks` is what the main thread turns into
 * `data-line`/`data-line-end`; the title and TOC live in the leading segment,
 * footnotes in the trailing one.
 */
export async function renderAsciidocChunks(
  source: string,
  options: AsciidocChunkOptions,
): Promise<AsciidocChunks> {
  if (!source.trim()) return { chunks: [], marks: [], hasHeader: false, notitle: false };

  const Asciidoctor = await loadAsciidoctor();
  const marks: AsciidocMark[] = [];
  // A path the pre-reader missed is not an unresolved directive: the caller
  // must fall back to the main-thread conversion, which can read it. The
  // include processor catches read errors, so the miss is recorded here and
  // checked after conversion.
  let missingInclude: string | null = null;
  const readFile =
    options.readFile ??
    (async (path: string) => {
      const entry = options.includes?.[path];
      if (!entry) {
        missingInclude = path;
        throw `Include was not preloaded: ${path}`;
      }
      if ("error" in entry) throw entry.error;
      return entry.content;
    });

  const registry = Asciidoctor.Extensions.create("mdraft-chunks");
  registry.includeProcessor(
    createIncludeProcessor(Asciidoctor, { baseDir: options.baseDir, readFile }),
  );
  registry.treeProcessor(createPreviewMarkerProcessor(Asciidoctor, marks));

  const maths: RenderedMath[] = [];
  let parserPromise: Promise<AsciiMathParser | null> | null = null;
  const getAsciimathParser = (): Promise<AsciiMathParser | null> => {
    if (!parserPromise) parserPromise = asciimathParser();
    return parserPromise;
  };
  const pushMath = (body: string, display: boolean): string => {
    const rendered = renderKatexCached(body, display);
    const idx = maths.length;
    maths.push({
      body,
      display,
      html: rendered.html,
      error: rendered.error,
    });
    return `<span data-mdraft-math="${idx}"></span>`;
  };

  const loadOptions = {
    standalone: false,
    safe: "secure",
    sourcemap: true,
    base_dir: options.baseDir ?? undefined,
    extension_registry: registry,
    // Embedded output sets `notitle`; ask for the title explicitly, or the
    // document title silently disappears from the preview.
    attributes: { showtitle: "" },
  } as Record<string, unknown>;
  if (options.math) {
    loadOptions.converter_factory = createPreviewConverterFactory(
      Asciidoctor,
      true,
      pushMath,
      getAsciimathParser,
    );
  } else {
    // The chunk wrapper is still needed, but stems must keep Asciidoctor's
    // delimiters when mathematics is off.
    loadOptions.converter_factory = createPreviewConverterFactory(Asciidoctor, false);
  }

  const doc = await Asciidoctor.load(source, loadOptions);
  const converted = String(await doc.convert());
  if (missingInclude) throw new Error(`Include was not preloaded: ${missingInclude}`);
  const raw = options.math ? preRenderRawDelimitedMath(converted, pushMath) : converted;
  const totalLines = countTotalLines(source);
  const built = buildLocalizedAsciidocBlocks(raw, marks, maths, totalLines);
  return {
    chunks: built.chunks,
    marks,
    hasHeader: Boolean(doc.hasHeader()),
    notitle: Boolean(doc.isNotitle()),
    maths,
    mathRendered: options.math,
    blocks: built.blocks,
    totalLines,
  };
}

function countTotalLines(text: string): number {
  if (!text) return 0;
  let lines = 1;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) lines += 1;
  }
  return lines;
}

function extractTouchedLines(text: string, from: number, to: number): string {
  const start = text.lastIndexOf("\n", Math.max(0, from - 1)) + 1;
  const endIdx = text.indexOf("\n", Math.max(from, to));
  const end = endIdx < 0 ? text.length : endIdx;
  return text.slice(start, end);
}

function asciidocHeaderEndOffset(source: string): number {
  const firstLineEnd = source.indexOf("\n");
  const firstLine = (firstLineEnd < 0 ? source : source.slice(0, firstLineEnd)).trim();
  if (!firstLine.startsWith("= ") && !firstLine.startsWith(":")) return 0;
  const match = /\r?\n\s*\r?\n/.exec(source);
  return match ? match.index : source.length;
}

function checkAsciidocStructuralTrigger(
  prevSource: string,
  nextSource: string,
  prefix: number,
  suffix: number,
): string | null {
  const prevEnd = prevSource.length - suffix;
  const nextEnd = nextSource.length - suffix;
  const headerEnd = Math.max(
    asciidocHeaderEndOffset(prevSource),
    asciidocHeaderEndOffset(nextSource),
  );
  if (headerEnd > 0 && prefix <= headerEnd) {
    return "header-or-attrs";
  }
  const prevTouched = extractTouchedLines(prevSource, prefix, prevEnd);
  const nextTouched = extractTouchedLines(nextSource, prefix, nextEnd);
  const directiveRe = /^\s*(?::!?[A-Za-z0-9_-]+!?:|(?:ifdef|ifndef|endif|ifeval)::|include::)/m;
  if (directiveRe.test(prevTouched) || directiveRe.test(nextTouched)) {
    return "directive-or-include";
  }
  const hasTocOrSectnums =
    /^\s*:(?:toc|sectnums)!?:/m.test(prevSource) || /^\s*:(?:toc|sectnums)!?:/m.test(nextSource);
  if (hasTocOrSectnums && (/^={1,6}\s/m.test(prevTouched) || /^={1,6}\s/m.test(nextTouched))) {
    return "toc-or-sectnums-heading";
  }
  return null;
}

/**
 * Compute an incremental AsciiDoc render result with block diffing and fail-safe
 * full rebuilds on header/attribute/conditional/include or >35% block edits.
 */
export async function renderAsciidocChunksIncremental(
  prevSource: string,
  prevChunks: AsciidocChunks | null | undefined,
  nextSource: string,
  options: AsciidocChunkOptions,
): Promise<AsciidocChunks> {
  const totalLines = countTotalLines(nextSource);

  if (!nextSource.trim()) {
    return {
      chunks: [],
      marks: [],
      hasHeader: false,
      notitle: false,
      maths: [],
      mathRendered: options.math,
      blocks: [],
      totalLines,
      incremental: {
        mode: "full",
        reason: "empty",
        dirtyRatio: 1,
        dirtyBlocks: 0,
        ops: [],
        totalLines,
      },
    };
  }

  if (
    !prevChunks ||
    !prevChunks.blocks ||
    Boolean(prevChunks.mathRendered) !== Boolean(options.math)
  ) {
    const fresh = await renderAsciidocChunks(nextSource, options);
    return {
      ...fresh,
      incremental: {
        mode: "full",
        reason: "prev-ineligible",
        dirtyRatio: 1,
        dirtyBlocks: fresh.blocks?.length ?? fresh.chunks.length,
        ops: [],
        totalLines,
      },
    };
  }

  if (prevSource === nextSource) {
    const ops: BlockPatchOp<AsciidocBlockChunk>[] = prevChunks.blocks.map((block, index) => ({
      kind: "retain",
      prevIndex: index,
      nextIndex: index,
      lineDelta: 0,
      block,
    }));
    return {
      ...prevChunks,
      totalLines,
      incremental: {
        mode: "diff",
        dirtyRatio: 0,
        dirtyBlocks: 0,
        ops,
        totalLines,
      },
    };
  }

  const minLen = Math.min(prevSource.length, nextSource.length);
  let prefix = 0;
  while (prefix < minLen && prevSource.charCodeAt(prefix) === nextSource.charCodeAt(prefix)) {
    prefix += 1;
  }
  let suffix = 0;
  const maxSuffix = minLen - prefix;
  while (
    suffix < maxSuffix &&
    prevSource.charCodeAt(prevSource.length - 1 - suffix) ===
      nextSource.charCodeAt(nextSource.length - 1 - suffix)
  ) {
    suffix += 1;
  }

  const structuralReason = checkAsciidocStructuralTrigger(prevSource, nextSource, prefix, suffix);
  const next = await renderAsciidocChunks(nextSource, options);
  if (
    structuralReason ||
    next.hasHeader !== prevChunks.hasHeader ||
    next.notitle !== prevChunks.notitle ||
    !next.blocks
  ) {
    return {
      ...next,
      incremental: {
        mode: "full",
        reason: structuralReason ?? "header-changed",
        dirtyRatio: 1,
        dirtyBlocks: next.blocks?.length ?? next.chunks.length,
        ops: [],
        totalLines,
      },
    };
  }

  const diff = diffBlocks(prevChunks.blocks, next.blocks);
  if (!diff.incremental) {
    return {
      ...next,
      incremental: {
        mode: "full",
        reason: diff.reason,
        dirtyRatio: diff.dirtyRatio,
        dirtyBlocks: diff.dirtyBlocks,
        ops: [],
        totalLines,
      },
    };
  }

  return {
    ...next,
    incremental: {
      mode: "diff",
      dirtyRatio: diff.dirtyRatio,
      dirtyBlocks: diff.dirtyBlocks,
      ops: diff.ops,
      totalLines,
    },
  };
}

// ---------------------------------------------------------------------------
// The export renderer
// ---------------------------------------------------------------------------

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function asciimathParser(): Promise<AsciiMathParser | null> {
  try {
    const Parser = await loadAsciiMath();
    return new Parser();
  } catch {
    return null;
  }
}

/**
 * An HTML5 converter registered for Asciidoctor's `pdf` backend.
 *
 * Registering the converter under `"pdf"` is what lets `backend: "pdf"` select
 * `ifdef::backend-pdf[]` content while the output is still HTML. Without a
 * converter under that name Asciidoctor aborts with `missing converter for
 * backend 'pdf'`.
 *
 * AsciiMath is converted to TeX here rather than in a DOM pass: pandoc's HTML
 * reader understands `\(…\)` / `\[…\]`, and Typst can typeset it. A formula the
 * parser rejects becomes escaped literal text, so one bad stem cannot abort the
 * whole export.
 */
function createPdfConverterFactory(Asciidoctor: AsciidoctorModule): unknown {
  class PandocHtml5Converter extends Asciidoctor.Html5Converter {
    async convert_inline_quoted(node: any): Promise<string> {
      if (node.type === "asciimath") {
        const text = String(node.text ?? "");
        const parser = await asciimathParser();
        if (!parser) return `<span class="asciimath-raw">${escapeHtml(text)}</span>`;
        try {
          return `<span class="math">\\(${escapeHtml(parser.parse(text))}\\)</span>`;
        } catch {
          return `<span class="asciimath-raw">${escapeHtml(text)}</span>`;
        }
      }
      return super.convert_inline_quoted(node);
    }

    async convert_stem(node: any): Promise<string> {
      if (node.style === "asciimath") {
        const lines: string[] = Array.isArray(node.lines)
          ? node.lines.map((line: unknown) => String(line).trim())
          : [String(node.source ?? "").trim()];
        const parser = await asciimathParser();
        if (!parser) {
          return `<pre class="asciimath-raw">${escapeHtml(lines.join("\n"))}</pre>`;
        }
        try {
          // One display block per source line. TeX's `\\` line break is not
          // accepted by Typst's math parser, and a block stem is a sequence of
          // equations, not one long formula; the preview draws it the same way.
          return lines
            .filter((line: string) => line.length > 0)
            .map((line: string) => parser.parse(line))
            .map((tex) => `<div class="math">\\[${escapeHtml(tex)}\\]</div>`)
            .join("\n");
        } catch {
          return `<pre class="asciimath-raw">${escapeHtml(lines.join("\n"))}</pre>`;
        }
      }
      return super.convert_stem(node);
    }
  }

  const factory = new Asciidoctor.ConverterCustomFactory();
  factory.register(PandocHtml5Converter, "pdf");
  return factory;
}

/**
 * The AsciiDoc document as clean HTML for pandoc's HTML reader.
 *
 * `backend: "pdf"` selects the PDF conditionals, not a PDF writer: the
 * converter registered above is an HTML5 converter. `showtitle` keeps the
 * document title, which embedded output otherwise drops. The result is a body
 * fragment; pandoc reads it without a document shell.
 */
export async function renderAsciidocForPandoc(
  source: string,
  options: AsciidocRenderOptions,
): Promise<string> {
  if (!source.trim()) return "";

  const Asciidoctor = await loadAsciidoctor();
  const registry = Asciidoctor.Extensions.create("mdraft-export");
  registry.includeProcessor(createIncludeProcessor(Asciidoctor, options));

  const doc = await Asciidoctor.load(source, {
    standalone: false,
    safe: "secure",
    backend: "pdf",
    base_dir: options.baseDir ?? undefined,
    extension_registry: registry,
    converter_factory: createPdfConverterFactory(Asciidoctor),
    // Embedded output sets `notitle`; ask for the title explicitly, or the
    // document title silently disappears from the export.
    attributes: { showtitle: "" },
  });

  return String(await doc.convert());
}
