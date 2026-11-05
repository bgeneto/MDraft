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

type AsciidoctorModule = typeof import("@asciidoctor/core");

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
}

export interface AsciidocChunks {
  /** Top-level HTML segments in document order, without the chunk comments. */
  chunks: string[];
  /** The role marker each block carries and its source line. */
  marks: AsciidocMark[];
  hasHeader: boolean;
  notitle: boolean;
}

const CHUNK_OPEN = "<!--mdraft-chunk-->";
const CHUNK_CLOSE = "<!--/mdraft-chunk-->";
const INCLUDE_DIRECTIVE = /^\s*include::([^[]+)\[[^\]]*\]\s*$/gm;

/** A converter that wraps each top-level block in a split marker and keeps the
 * AsciiMath markers the preview's DOM pass consumes. */
function createPreviewConverterFactory(
  Asciidoctor: AsciidoctorModule,
  markStems: boolean,
): unknown {
  class PreviewHtml5Converter extends Asciidoctor.Html5Converter {
    async convert(node: any, transform?: string): Promise<string> {
      const html = String(await super.convert(node, transform));
      if (
        node &&
        node.context &&
        node.context !== "document" &&
        node.parent &&
        node.parent.context === "document"
      ) {
        return `${CHUNK_OPEN}${html}${CHUNK_CLOSE}`;
      }
      return html;
    }

    async convert_inline_quoted(node: any): Promise<string> {
      if (markStems && node.type === "asciimath") {
        return `<span data-stem="asciimath">${node.text ?? ""}</span>`;
      }
      return super.convert_inline_quoted(node);
    }

    async convert_stem(node: any): Promise<string> {
      const html = await super.convert_stem(node);
      return markStems && node.style === "asciimath"
        ? html.replace(/^<div/, '<div data-stem="asciimath"')
        : html;
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

/** Split the converter output at its top-level markers, preserving every other
 * byte; the marker comments are removed by this pass. */
function splitPreviewChunks(raw: string): string[] {
  const chunks: string[] = [];
  let cursor = 0;
  for (;;) {
    const open = raw.indexOf(CHUNK_OPEN, cursor);
    if (open < 0) {
      if (cursor < raw.length) chunks.push(raw.slice(cursor));
      break;
    }
    if (open > cursor) chunks.push(raw.slice(cursor, open));
    const start = open + CHUNK_OPEN.length;
    const close = raw.indexOf(CHUNK_CLOSE, start);
    if (close < 0) {
      chunks.push(raw.slice(start));
      break;
    }
    chunks.push(raw.slice(start, close));
    cursor = close + CHUNK_CLOSE.length;
  }
  return chunks.filter((chunk) => chunk.length > 0);
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
  options: { baseDir: string | null; readFile: (path: string) => Promise<string> },
): Promise<AsciidocIncludeMap | null> {
  if (!options.baseDir || !source.includes("include::")) return {};
  const map: AsciidocIncludeMap = {};
  const seen = new Set<string>();

  const scan = async (text: string, currentDir: string | null): Promise<boolean> => {
    for (const match of text.matchAll(INCLUDE_DIRECTIVE)) {
      const target = match[1].trim();
      if (target.includes("{")) return false;
      const resolved = resolveInclude(target, currentDir, options.baseDir);
      if (!resolved) continue;
      const key = foldForCompare(resolved);
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        const content = await options.readFile(resolved);
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
    loadOptions.converter_factory = createPreviewConverterFactory(Asciidoctor, true);
  } else {
    // The chunk wrapper is still needed, but stems must keep Asciidoctor's
    // delimiters when mathematics is off.
    loadOptions.converter_factory = createPreviewConverterFactory(Asciidoctor, false);
  }

  const doc = await Asciidoctor.load(source, loadOptions);
  const raw = String(await doc.convert());
  if (missingInclude) throw new Error(`Include was not preloaded: ${missingInclude}`);
  return {
    chunks: splitPreviewChunks(raw),
    marks,
    hasHeader: Boolean(doc.hasHeader()),
    notitle: Boolean(doc.isNotitle()),
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
