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
  decorateCodeBlocks,
  decorateLinks,
  escapeHtml,
  renderMathIn,
  renderMermaidIn,
} from "./markdown";

type AsciidoctorModule = typeof import("@asciidoctor/core");

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
}

interface Mark {
  marker: string;
  line: number;
}

let asciidoctorPromise: Promise<AsciidoctorModule> | null = null;

function loadAsciidoctor(): Promise<AsciidoctorModule> {
  if (!asciidoctorPromise) {
    // The package exports only ".", and Vite's browser condition resolves that
    // to build/browser/index.js. A /build/browser subpath is not exported.
    asciidoctorPromise = import("@asciidoctor/core");
  }
  return asciidoctorPromise;
}

// ---------------------------------------------------------------------------
// Include paths
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

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

export async function renderAsciidocPreview(
  source: string,
  options: AsciidocRenderOptions,
): Promise<AsciidocRenderResult> {
  try {
    const Asciidoctor = await loadAsciidoctor();
    if (!source.trim()) return { html: "", linesMapped: false };

    const marks: Mark[] = [];
    let markerCount = 0;
    const includeStack: string[] = [];
    const baseDir = options.baseDir;

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

    class IncludeExtension extends Asciidoctor.IncludeProcessor {
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
          const payload = await api.readDocument(resolved);
          includeStack.push(key);
          try {
            reader.pushInclude(payload.content, resolved, resolved, 1);
          } finally {
            includeStack.pop();
          }
        } catch (error) {
          pushIncludeError(reader, target, String(error));
        }
      }
    }

    class MarkerProcessor extends Asciidoctor.TreeProcessor {
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
            const marker = `mdraft-line-${++markerCount}`;
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
    }

    const registry = Asciidoctor.Extensions.create("mdraft");
    registry.includeProcessor(IncludeExtension);
    registry.treeProcessor(new MarkerProcessor());

    const doc = await Asciidoctor.load(source, {
      standalone: false,
      safe: "secure",
      sourcemap: true,
      base_dir: baseDir ?? undefined,
      extension_registry: registry,
      // Embedded output sets `notitle`; ask for the title explicitly, or the
      // document title silently disappears from the preview.
      attributes: { showtitle: "" },
    });

    const raw = await doc.convert();

    const clean = DOMPurify.sanitize(raw, {
      ADD_ATTR: [
        "align",
        "checked",
        "colspan",
        "data-lang",
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

    const holder = document.createElement("div");
    holder.innerHTML = clean;

    const lines = source.split("\n").length;
    const sorted = marks.slice().sort((a, b) => a.line - b.line);
    const ranges = new Map<string, { line: number; end: number }>();
    sorted.forEach((mark, index) => {
      const next = sorted[index + 1];
      ranges.set(mark.marker, {
        line: mark.line,
        end: next ? Math.max(mark.line, next.line - 1) : Math.max(mark.line, lines),
      });
    });

    for (const element of Array.from(holder.querySelectorAll("[class]"))) {
      const marker = Array.from(element.classList).find((name) =>
        name.startsWith("mdraft-line-"),
      );
      if (!marker) continue;
      const range = ranges.get(marker);
      element.classList.remove(marker);
      if (element.classList.length === 0) element.removeAttribute("class");
      if (range) {
        element.setAttribute("data-line", String(range.line));
        element.setAttribute("data-line-end", String(range.end));
      }
    }

    if (doc.hasHeader() && !doc.isNotitle()) {
      const title = holder.querySelector("h1");
      if (title) {
        title.setAttribute("data-line", "1");
        title.setAttribute("data-line-end", "1");
      }
    }

    if (options.math) renderMathIn(holder);
    decorateCodeBlocks(holder, options.mermaid);
    decorateLinks(holder, baseDir);
    await renderMermaidIn(holder, options.isDark);

    return {
      html: holder.innerHTML,
      linesMapped: holder.querySelectorAll("[data-line]").length >= 2,
    };
  } catch (error) {
    return {
      html: `<pre class="asciidoc-error">${escapeHtml(String(error))}</pre>`,
      linesMapped: false,
    };
  }
}
