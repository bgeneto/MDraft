//! Markdown → HTML.
//!
//! Pipeline: protect inline code → extract math → marked → DOMPurify → restore
//! placeholders → highlight code → tag mermaid blocks → resolve local images and
//! links. Mermaid runs afterwards, against the live preview element.

import { Marked } from "marked";
import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/common";
import katex from "katex";
// The stylesheet carries the Computer Modern faces AND the layout rules. Without
// it KaTeX still emits its DOM, but fractions collapse and radicals, integrals
// and large delimiters vanish, because those are drawn with the KaTeX_Size
// fonts. Vite rewrites the font URLs and emits the files next to the bundle.
import "katex/dist/katex.min.css";
import { convertFileSrc } from "@tauri-apps/api/core";

/**
 * The KaTeX stylesheet, for exported documents that no longer live inside the
 * application.
 *
 * Vite's bundled copy carries the layout rules AND points at hashed font files
 * next to the bundle. A standalone file has no bundle to resolve those against,
 * so an exported document loads the published stylesheet instead, fonts
 * included.
 *
 * Omitting this is not a cosmetic loss: KaTeX still emits its DOM and reports no
 * error, but fractions collapse and radicals grow a bar across the whole page.
 * The editor itself still makes no network request — this is a link the reader's
 * browser follows, which the README documents.
 */
export const KATEX_STYLESHEET_URL =
  "https://cdn.jsdelivr.net/npm/katex@0.19.0/dist/katex.min.css";

export interface RenderOptions {
  /** Directory of the document being edited, used to resolve relative images. */
  baseDir: string | null;
  /** Render `$…$` with KaTeX. When false the delimiters stay literal. */
  math?: boolean;
  /** Render `mermaid` fences as diagrams. When false they stay code blocks. */
  mermaid?: boolean;
}

const marked = new Marked({
  gfm: true,
  breaks: false,
  pedantic: false,
});

const PLACEHOLDER = /@@(CODE|MATH)(\d+)@@/g;

export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ---------------------------------------------------------------------------
// Fenced code awareness
// ---------------------------------------------------------------------------

interface Segment {
  code: boolean;
  text: string;
}

/** Split markdown into fenced-code and prose segments. */
function splitFences(markdown: string): Segment[] {
  const out: Segment[] = [];
  let buffer: string[] = [];
  let inside = false;
  let marker = "";

  const flush = (isCode: boolean) => {
    if (buffer.length > 0) {
      out.push({ code: isCode, text: buffer.join("\n") });
      buffer = [];
    }
  };

  for (const line of markdown.split("\n")) {
    const open = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (!inside && open) {
      flush(false);
      inside = true;
      marker = open[1][0];
      buffer.push(line);
      continue;
    }
    if (inside) {
      buffer.push(line);
      const close = /^\s{0,3}(`{3,}|~{3,})\s*$/.exec(line);
      if (close && close[1][0] === marker) {
        inside = false;
        flush(true);
      }
      continue;
    }
    buffer.push(line);
  }
  flush(inside);
  return out;
}

/** Replace `code spans` with placeholders so math never rewrites them. */
function protectInlineCode(text: string, codes: string[]): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    if (text[i] !== "`") {
      out += text[i++];
      continue;
    }
    let run = 0;
    while (text[i + run] === "`") run++;
    const fence = "`".repeat(run);
    const end = text.indexOf(fence, i + run);
    if (end === -1) {
      out += fence;
      i += run;
      continue;
    }
    codes.push(text.slice(i + run, end));
    out += `@@CODE${codes.length - 1}@@`;
    i = end + run;
  }
  return out;
}

/**
 * Characters that only appear in real TeX. Used to accept space-padded math
 * (`$ ^{1} $`, `$ E_{n} $`) without also accepting currency (`$5 and $10`).
 */
const MATH_INDICATOR = /[\\^_{}=+<>]/;

/**
 * Plain amounts. A padded span such as `$ 5 $` is far more likely to be money
 * than a lone number set as mathematics, so it stays literal.
 */
const AMOUNT_ONLY = /^[\d.,]+$/;

/** Replace `$…$`, `$$…$$`, `\(…\)` and `\[…\]` with placeholders. */
function extractMath(text: string, maths: { body: string; display: boolean }[]): string {
  const push = (body: string, display: boolean) => {
    maths.push({ body, display });
    return `@@MATH${maths.length - 1}@@`;
  };

  // Display forms first: they may span lines.
  let out = text
    .replace(/\$\$([\s\S]+?)\$\$/g, (_m, body: string) => push(body.trim(), true))
    .replace(/\\\[([\s\S]+?)\\\]/g, (_m, body: string) => push(body.trim(), true))
    .replace(/\\\(([\s\S]+?)\\\)/g, (_m, body: string) => push(body.trim(), false));

  // Inline `$…$` with a hand-written scan so escapes, spacing and pairing are
  // respected. A rejected candidate is consumed WHOLE: emitting only the
  // opening `$` would let its closing `$` open a bogus span and swallow the
  // prose between them as math.
  let scanned = "";
  let i = 0;
  while (i < out.length) {
    const ch = out[i];
    if (ch === "\\" && i + 1 < out.length) {
      scanned += out[i] + out[i + 1];
      i += 2;
      continue;
    }
    if (ch !== "$") {
      scanned += ch;
      i++;
      continue;
    }
    let end = -1;
    for (let j = i + 1; j < out.length; j++) {
      const c = out[j];
      if (c === "\\") {
        j++;
        continue;
      }
      if (c === "\n") break;
      if (c === "$") {
        end = j;
        break;
      }
    }
    if (end > i + 1) {
      const body = out.slice(i + 1, end);
      const trimmed = body.trim();
      // Tight delimiters are always math. Padded ones (`$ L $`) need either a
      // TeX character or to be a single unspaced token, and never a bare amount.
      const tight = !/^\s|\s$/.test(body);
      const paddedMath =
        !AMOUNT_ONLY.test(trimmed) &&
        (MATH_INDICATOR.test(trimmed) || !/\s/.test(trimmed));
      const looksLikeMath =
        trimmed.length > 0 && !body.includes("@@") && (tight || paddedMath);
      if (looksLikeMath) {
        scanned += push(body, false);
      } else {
        scanned += out.slice(i, end + 1);
      }
      i = end + 1;
      continue;
    }
    scanned += ch;
    i++;
  }
  return scanned;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function isAbsolutePath(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p) || /^\\\\/.test(p) || p.startsWith("/");
}

function joinPath(base: string, relative: string): string {
  const windows = /^[A-Za-z]:/.test(base) || base.includes("\\");
  const sep = windows ? "\\" : "/";
  const parts = base.replace(/[\\/]+$/, "").split(/[\\/]/);
  for (const piece of relative.split(/[\\/]/)) {
    if (!piece || piece === ".") continue;
    if (piece === "..") {
      if (parts.length > 1) parts.pop();
      continue;
    }
    parts.push(piece);
  }
  return parts.join(sep);
}

function assetUrl(raw: string, baseDir: string | null): string {
  const src = raw.trim();
  if (!src || /^(https?:|data:|blob:|asset:|mailto:|#)/i.test(src)) return src;

  let path = src;
  try {
    path = decodeURI(src);
  } catch {
    /* keep the raw value */
  }
  if (/^file:\/\//i.test(path)) {
    try {
      path = decodeURIComponent(new URL(path).pathname).replace(/^\//, "");
    } catch {
      /* keep as-is */
    }
  }

  const absolute =
    isAbsolutePath(path) || !baseDir ? path : joinPath(baseDir, path);

  try {
    return convertFileSrc(absolute);
  } catch {
    return src;
  }
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

export interface RenderResult {
  html: string;
  /**
   * True when every top-level block carries an exact `data-line` anchor. When
   * false the panes cannot be aligned positionally and callers should fall back
   * to proportional scrolling.
   */
  linesMapped: boolean;
  /** Number of anchored blocks. */
  anchors: number;
}

export function renderPreview(source: string, options: RenderOptions): RenderResult {
  const mathEnabled = options.math ?? true;
  const mermaidEnabled = options.mermaid ?? true;

  const codes: string[] = [];
  const maths: { body: string; display: boolean }[] = [];

  const prepared = splitFences(source)
    .map((segment) => {
      if (segment.code) return segment.text;
      const protectedCode = protectInlineCode(segment.text, codes);
      return mathEnabled ? extractMath(protectedCode, maths) : protectedCode;
    })
    .join("\n");

  const rawHtml = marked.parse(prepared, { async: false }) as string;

  const clean = DOMPurify.sanitize(rawHtml, {
    ADD_ATTR: ["align", "data-mermaid", "data-href", "id", "colspan", "rowspan", "type", "checked", "disabled"],
    // `input` has to survive sanitising so GFM task lists keep their checkbox;
    // normalizeInputs() then strips every input that is not a disabled checkbox.
    FORBID_TAGS: ["script", "iframe", "object", "embed", "form", "textarea", "select", "button", "base"],
    USE_PROFILES: { html: true },
  });

  const host = document.createElement("div");
  host.innerHTML = clean;

  normalizeInputs(host);
  restorePlaceholders(host, codes, maths);
  decorateCodeBlocks(host, mermaidEnabled);
  decorateLinks(host, options.baseDir);
  decorateAlerts(host);
  addHeadingIds(host);
  buildTableOfContents(host);

  // Last, once the element set is final: tie every block back to its source line.
  const mapping = annotatePreviewLines(host, source);

  return { html: host.innerHTML, linesMapped: mapping.complete, anchors: mapping.count };
}

/** Tokens that render no element, so they cannot be zipped with the DOM. */
const SILENT_TOKENS = new Set(["space", "def"]);

/**
 * DOMPurify removes HTML comments, so a `<!-- Page 1 -->` marker produces no
 * element even though marked emits a token for it. Such tokens must not take
 * part in the index zip or every block after them would be off by one.
 */
function rendersNothing(token: { type: string; raw?: string }): boolean {
  if (SILENT_TOKENS.has(token.type)) return true;
  return token.type === "html" && /^\s*<!--/.test(token.raw ?? "");
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return starts;
}

function lineOf(starts: number[], offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (starts[mid] <= offset) low = mid;
    else high = mid - 1;
  }
  return low + 1;
}

/**
 * Write `data-line` on every top-level preview block.
 *
 * The markdown is lexed a second time from the *original* source, so each
 * token's `raw` is a literal slice of what the user typed and its offset is
 * exact. That token list and the rendered element list are both in document
 * order and, because the render transformations neither add nor remove blocks,
 * they can be zipped index by index. If the counts ever disagree the whole
 * annotation is dropped rather than producing a wrong map.
 */
function annotatePreviewLines(
  host: HTMLElement,
  source: string,
): { complete: boolean; count: number } {
  const tokens = marked.lexer(source).filter((token) => !rendersNothing(token));
  const blocks = Array.from(host.children) as HTMLElement[];
  if (tokens.length === 0 || tokens.length !== blocks.length) {
    return { complete: false, count: 0 };
  }

  const starts = lineStarts(source);
  let cursor = 0;

  for (let i = 0; i < tokens.length; i++) {
    const raw = tokens[i].raw ?? "";
    const at = source.indexOf(raw, cursor);
    if (raw.length === 0 || at < 0) return { complete: false, count: 0 };
    cursor = at + raw.length;
    blocks[i].setAttribute("data-line", String(lineOf(starts, at)));
  }

  return { complete: true, count: tokens.length };
}

/** GitHub-style `> [!NOTE]` blockquotes get a class and a visible title. */
const ALERT_KINDS: Record<string, string> = {
  NOTE: "Note",
  TIP: "Tip",
  IMPORTANT: "Important",
  WARNING: "Warning",
  CAUTION: "Caution",
};

function decorateAlerts(host: HTMLElement): void {
  for (const quote of Array.from(host.querySelectorAll("blockquote"))) {
    const first = quote.querySelector("p");
    const text = first?.textContent ?? "";
    const match = /^\s*\[!(\w+)\]\s*/.exec(text);
    if (!match) continue;
    const kind = ALERT_KINDS[match[1].toUpperCase()];
    if (!kind) continue;

    quote.classList.add("md-alert", `md-alert-${kind.toLowerCase()}`);
    if (first) {
      const title = document.createElement("p");
      title.className = "md-alert-title";
      title.textContent = kind;
      // Drop the marker itself, keeping whatever followed it on that line.
      first.textContent = text.slice(match[0].length);
      if ((first.textContent ?? "").trim().length === 0) first.remove();
      quote.insertBefore(title, quote.firstChild);
    }
  }
}

/** Keep only disabled task-list checkboxes; drop every other form control. */
function normalizeInputs(host: HTMLElement): void {
  for (const input of Array.from(host.querySelectorAll("input"))) {
    const type = (input.getAttribute("type") ?? "").toLowerCase();
    if (type !== "checkbox") {
      input.remove();
      continue;
    }
    input.setAttribute("disabled", "");
    input.removeAttribute("tabindex");
  }
}

function restorePlaceholders(
  host: HTMLElement,
  codes: string[],
  maths: { body: string; display: boolean }[],
): void {
  const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
  const targets: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (PLACEHOLDER.test((node as Text).nodeValue ?? "")) {
      PLACEHOLDER.lastIndex = 0;
      targets.push(node as Text);
    }
    PLACEHOLDER.lastIndex = 0;
  }

  for (const node of targets) {
    const text = node.nodeValue ?? "";
    const fragment = document.createDocumentFragment();
    let last = 0;
    PLACEHOLDER.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = PLACEHOLDER.exec(text)) !== null) {
      if (match.index > last) {
        fragment.appendChild(document.createTextNode(text.slice(last, match.index)));
      }
      const [, kind, indexRaw] = match;
      const index = Number(indexRaw);
      if (kind === "CODE") {
        const code = document.createElement("code");
        code.textContent = codes[index] ?? "";
        fragment.appendChild(code);
      } else {
        fragment.appendChild(mathNode(maths[index]));
      }
      last = match.index + match[0].length;
    }
    if (last < text.length) {
      fragment.appendChild(document.createTextNode(text.slice(last)));
    }
    node.parentNode?.replaceChild(fragment, node);
  }
}

function mathNode(entry: { body: string; display: boolean } | undefined): Node {
  const span = document.createElement("span");
  span.className = entry?.display ? "math-display" : "math-inline";
  if (!entry) {
    span.textContent = "";
    return span;
  }
  try {
    span.innerHTML = katex.renderToString(entry.body, {
      displayMode: entry.display,
      throwOnError: false,
      strict: false,
      output: "html",
    });
  } catch (error) {
    span.className = "math-error";
    span.textContent = `$${entry.body}$`;
    span.title = String(error);
  }
  return span;
}

function decorateCodeBlocks(host: HTMLElement, mermaidEnabled = true): void {
  for (const pre of Array.from(host.querySelectorAll("pre"))) {
    const code = pre.querySelector("code");
    if (!code) continue;

    const language = Array.from(code.classList)
      .find((c) => c.startsWith("language-"))
      ?.slice("language-".length);

    if (language === "mermaid" && mermaidEnabled) {
      // Rendered asynchronously against the live element.
      const container = document.createElement("div");
      container.className = "mermaid";
      container.setAttribute("data-mermaid", code.textContent ?? "");
      pre.replaceWith(container);
      continue;
    }

    const source = code.textContent ?? "";
    try {
      if (language && hljs.getLanguage(language)) {
        code.innerHTML = hljs.highlight(source, { language, ignoreIllegals: true }).value;
      } else if (language) {
        code.innerHTML = hljs.highlightAuto(source).value;
      } else {
        code.innerHTML = escapeHtml(source);
      }
      code.classList.add("hljs");
    } catch {
      code.textContent = source;
    }
  }
}

function decorateLinks(host: HTMLElement, baseDir: string | null): void {
  for (const img of Array.from(host.querySelectorAll("img"))) {
    const src = img.getAttribute("src");
    if (src) img.setAttribute("src", assetUrl(src, baseDir));
    img.setAttribute("loading", "lazy");
  }

  for (const anchor of Array.from(host.querySelectorAll("a"))) {
    const href = anchor.getAttribute("href") ?? "";
    anchor.setAttribute("data-href", href);
    if (/^https?:/i.test(href)) {
      anchor.classList.add("external-link");
    } else if (!href.startsWith("#")) {
      anchor.classList.add("local-link");
    }
    anchor.removeAttribute("href");
  }
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .slice(0, 80);
}

function addHeadingIds(host: HTMLElement): void {
  const seen = new Map<string, number>();
  for (const heading of Array.from(host.querySelectorAll("h1,h2,h3,h4,h5,h6"))) {
    const base = slugify(heading.textContent ?? "") || "section";
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    heading.id = count === 0 ? base : `${base}-${count}`;
  }
}

export interface Heading {
  level: number;
  text: string;
  line: number;
}

/** Extract ATX headings, skipping fenced code blocks. */
export function extractHeadings(markdown: string): Heading[] {
  const headings: Heading[] = [];
  const lines = markdown.split("\n");
  let insideFence = false;
  let marker = "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const fence = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (!insideFence && fence) {
      insideFence = true;
      marker = fence[1][0];
      continue;
    }
    if (insideFence) {
      const close = /^\s{0,3}(`{3,}|~{3,})\s*$/.exec(line);
      if (close && close[1][0] === marker) insideFence = false;
      continue;
    }

    const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (match) {
      headings.push({ level: match[1].length, text: match[2].trim(), line: i + 1 });
    }
  }
  return headings;
}

/** Replace a literal `[TOC]` paragraph with links to the rendered headings. */
function buildTableOfContents(host: HTMLElement): void {
  const markers = Array.from(host.querySelectorAll("p")).filter(
    (p) => (p.textContent ?? "").trim() === "[TOC]",
  );
  if (markers.length === 0) return;

  const headings = Array.from(host.querySelectorAll("h1,h2,h3,h4,h5,h6"));
  const nav = document.createElement("nav");
  nav.className = "md-toc";

  if (headings.length === 0) {
    const empty = document.createElement("p");
    empty.className = "md-toc-empty";
    empty.textContent = "No headings yet.";
    nav.appendChild(empty);
  } else {
    const list = document.createElement("ul");
    const minLevel = Math.min(
      ...headings.map((h) => Number(h.tagName.slice(1))),
    );
    for (const heading of headings) {
      const item = document.createElement("li");
      item.style.paddingLeft = `${(Number(heading.tagName.slice(1)) - minLevel) * 14}px`;
      const link = document.createElement("a");
      link.className = "local-link";
      link.setAttribute("data-href", `#${heading.id}`);
      link.textContent = heading.textContent ?? "";
      item.appendChild(link);
      list.appendChild(item);
    }
    nav.appendChild(list);
  }

  for (const marker of markers) marker.replaceWith(nav.cloneNode(true));
}

// ---------------------------------------------------------------------------
// Mermaid (async, cached)
// ---------------------------------------------------------------------------

const mermaidCache = new Map<string, string>();
let mermaidSequence = 0;

type MermaidApi = {
  initialize: (config: Record<string, unknown>) => void;
  render: (id: string, code: string) => Promise<{ svg: string }>;
};

let mermaidApi: MermaidApi | null = null;

async function loadMermaid(isDark: boolean): Promise<MermaidApi> {
  if (!mermaidApi) {
    const mod = await import("mermaid");
    mermaidApi = (mod.default ?? mod) as unknown as MermaidApi;
  }
  mermaidApi.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: isDark ? "dark" : "default",
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
    flowchart: { useMaxWidth: true, htmlLabels: false },
    sequence: { useMaxWidth: true },
  });
  return mermaidApi;
}

export function renderMermaidError(container: HTMLElement, error: unknown): void {
  const box = document.createElement("div");
  box.className = "mermaid-error";
  const message = error instanceof Error ? error.message : String(error);
  box.textContent = `Diagram error: ${message.split("\n")[0]}`;
  container.replaceChildren(box);
}

/** Fill every `.mermaid[data-mermaid]` element inside `root`. */
export async function renderMermaidIn(root: HTMLElement, isDark: boolean): Promise<void> {
  const blocks = Array.from(root.querySelectorAll<HTMLElement>(".mermaid[data-mermaid]"));
  if (blocks.length === 0) return;

  let mermaid: MermaidApi;
  try {
    mermaid = await loadMermaid(isDark);
  } catch (error) {
    for (const block of blocks) renderMermaidError(block, error);
    return;
  }

  for (const block of blocks) {
    const code = block.getAttribute("data-mermaid") ?? "";
    const key = `${isDark ? "dark" : "light"}\u0000${code}`;

    const cached = mermaidCache.get(key);
    if (cached) {
      block.innerHTML = cached;
      continue;
    }

    try {
      const { svg } = await mermaid.render(`mmd-${++mermaidSequence}`, code);
      mermaidCache.set(key, svg);
      block.innerHTML = svg;
    } catch (error) {
      renderMermaidError(block, error);
    }
  }
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/**
 * A print-ready standalone document.
 *
 * Built for the browser's own "print to PDF", which is the only PDF path that
 * needs nothing installed. The page is deliberately always light: token colours
 * chosen for a dark editor print as pale text on white paper whenever background
 * graphics are off, which is the default in most browsers.
 *
 * The document prints itself as soon as it loads, so the user's next action is
 * the one the browser is already asking for — choosing "Save as PDF" as the
 * destination — rather than having to find Ctrl+P first.
 */
export function wrapPrintHtml(title: string, bodyHtml: string, tokenCss: string): string {
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    `<title>${escapeHtml(title)}</title>`,
    // Without this the mathematics collapses, exactly as it would in the
    // preview: KaTeX needs its layout rules, not just its DOM.
    `<link rel="stylesheet" href="${KATEX_STYLESHEET_URL}">`,
    "<style>",
    ":root{color-scheme:light}",
    "html,body{background:#fff}",
    "@page{size:A4;margin:18mm 16mm}",
    "body{max-width:none;margin:0;padding:0;color:#1a1a1a;",
    'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;',
    "line-height:1.65;font-size:11.5pt}",
    // A heading stranded at the foot of a page, or a table split across two, is
    // the commonest way an otherwise fine printout looks broken.
    "h1,h2,h3,h4,h5,h6{break-after:avoid;page-break-after:avoid;break-inside:avoid}",
    "table,pre,blockquote,figure{break-inside:avoid;page-break-inside:avoid}",
    "img,svg{max-width:100%;break-inside:avoid}",
    "table{border-collapse:collapse;width:100%}",
    "th,td{border:1px solid #c8c8c8;padding:5px 9px;text-align:left}",
    "th{background:#f2f2f2}",
    "pre{background:#f6f8fa;padding:10px 12px;border-radius:4px;overflow:visible;white-space:pre-wrap}",
    "code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.9em}",
    "blockquote{margin:0;padding-left:12px;border-left:3px solid #d0d0d0;color:#444}",
    "a{color:#0b57d0;text-decoration:none}",
    // Long URLs and code lines must wrap rather than be clipped at the margin.
    "a[href^='http']{overflow-wrap:anywhere}",
    ".math-display{text-align:center;margin:1em 0}",
    "</style>",
    `<style>${tokenCss}</style>`,
    "</head>",
    "<body>",
    bodyHtml,
    "<script>window.addEventListener('load',function(){window.print()})</script>",
    "</body>",
    "</html>",
  ].join("\n");
}

/** Wrap rendered body HTML into a standalone document for "Export as HTML". */
export function wrapStandaloneHtml(
  title: string,
  bodyHtml: string,
  isDark: boolean,
  headExtra = "",
): string {
  const background = isDark ? "#1e1e1e" : "#ffffff";
  const color = isDark ? "#d4d4d4" : "#333333";
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)}</title>`,
    "<style>",
    `:root{color-scheme:${isDark ? "dark" : "light"}}`,
    `body{max-width:820px;margin:40px auto;padding:0 24px;background:${background};color:${color};`,
    'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;',
    "line-height:1.7;font-size:16px}",
    "pre{background:rgba(127,127,127,.12);padding:12px 14px;border-radius:6px;overflow:auto}",
    "code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.9em}",
    "table{border-collapse:collapse}th,td{border:1px solid rgba(127,127,127,.35);padding:6px 10px}",
    "blockquote{margin:0;padding-left:14px;border-left:3px solid rgba(127,127,127,.4);opacity:.9}",
    "img{max-width:100%}",
    "</style>",
    headExtra,
    "</head>",
    "<body>",
    bodyHtml,
    "</body>",
    "</html>",
  ].join("\n");
}
