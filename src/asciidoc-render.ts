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
  return /^[A-Za-z]:/.test(path) || /Windows/i.test(navigator.userAgent)
    ? path.toLowerCase()
    : path;
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
  const raw = target.trim().replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
  if (!raw || isAbsoluteInclude(raw)) return null;

  const base = normalizePath(baseDir);
  if (!base) return null;
  const directory =
    currentDir && currentDir !== "." && currentDir !== ""
      ? normalizePath(currentDir)
      : base;
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
// The export renderer
// ---------------------------------------------------------------------------

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
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
        const lines = Array.isArray(node.lines)
          ? node.lines.map((line: unknown) => String(line).trim())
          : [String(node.source ?? "").trim()];
        const parser = await asciimathParser();
        if (!parser) {
          return `<pre class="asciimath-raw">${escapeHtml(lines.join("\n"))}</pre>`;
        }
        try {
          const tex = lines
            .filter((line: string) => line.length > 0)
            .map((line: string) => parser.parse(line))
            .join(" \\\\ ");
          return tex
            ? `<div class="math">\\[${escapeHtml(tex)}\\]</div>`
            : "";
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
