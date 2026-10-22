//! Markdown → HTML.
//!
//! Pipeline: protect inline code → extract math → marked → DOMPurify → restore
//! placeholders → highlight code → tag mermaid blocks → resolve local images and
//! links. Mermaid runs afterwards, against the live preview element.

import { Marked, Renderer, type RendererObject, type Token } from "marked";
import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/common";
import katex from "katex";
import { analyzeMath } from "./math-delimiters";
import { markdownCodeSpans } from "./markdown-context";
import { translateOffset, type Fragment, type Substitution } from "./source-map";
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
export const KATEX_STYLESHEET_URL = "https://cdn.jsdelivr.net/npm/katex@0.19.0/dist/katex.min.css";

export interface RenderOptions {
  /** Directory of the document being edited, used to resolve relative images. */
  baseDir: string | null;
  /** Render `$…$` with KaTeX. When false the delimiters stay literal. */
  math?: boolean;
  /** Render `mermaid` fences as diagrams. When false they stay code blocks. */
  mermaid?: boolean;
  /**
   * Emit the source fragments word-level sync needs. Off for exports: they have
   * no source pane to point at, and the wrapper spans are only weight.
   */
  map?: boolean;
}

const marked = new Marked({
  gfm: true,
  breaks: false,
  pedantic: false,
});

const PLACEHOLDER = /@@(CODE|MATH)(\d+)@@/g;
const PLACEHOLDER_PIECE = /@@(CODE|MATH)(\d+)@@/g;

/** A code span protected from the parser, with the source range it came from. */
interface CodeEntry {
  text: string;
  src0: number;
  src1: number;
}

/** A formula extracted before `marked`, with the source range it came from. */
interface MathEntry {
  body: string;
  display: boolean;
  src0: number;
  src1: number;
}

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

  const absolute = isAbsolutePath(path) || !baseDir ? path : joinPath(baseDir, path);

  try {
    return convertFileSrc(absolute);
  } catch {
    return src;
  }
}

// ---------------------------------------------------------------------------
// Word-level source fragments
// ---------------------------------------------------------------------------

/** A token carrying the offset `marked` does not provide. */
interface Positioned {
  srcStart?: number;
  raw?: string;
  text?: string;
  tokens?: unknown;
  items?: unknown;
  header?: unknown;
  rows?: unknown;
}

interface Piece {
  start: number;
  text: string;
  kind: "raw" | "code" | "math";
}

/** Split a text run at the placeholders code and math left behind. */
function splitPieces(raw: string): Piece[] {
  const pieces: Piece[] = [];
  let last = 0;
  for (const match of raw.matchAll(PLACEHOLDER_PIECE)) {
    if (match.index > last) {
      pieces.push({ start: last, text: raw.slice(last, match.index), kind: "raw" });
    }
    pieces.push({
      start: match.index,
      text: match[0],
      kind: match[1] === "CODE" ? "code" : "math",
    });
    last = match.index + match[0].length;
  }
  if (last < raw.length) pieces.push({ start: last, text: raw.slice(last), kind: "raw" });
  return pieces;
}

/** Insert an attribute into the first opening tag of a name. */
function injectAttribute(html: string, tag: string, attribute: string): string {
  const at = html.indexOf(`<${tag}`);
  if (at < 0) return html;
  const after = at + tag.length + 1;
  return `${html.slice(0, after)} ${attribute}${html.slice(after)}`;
}

/**
 * Record the prepared offset of every token in the tree.
 *
 * `raw` is a literal slice of the text `marked` lexed, so `indexOf` from a
 * forward cursor is exact and cannot run backwards. A token whose raw cannot be
 * found — a table cell that was trimmed, a construct the walk does not know —
 * gets no offset and renders without a fragment, which falls back to the block.
 */
function assignOffsets(tokens: Token[], source: string): void {
  let cursor = 0;
  for (const token of tokens) {
    const record = token as unknown as Positioned;
    const raw = record.raw ?? "";
    const at = raw ? source.indexOf(raw, cursor) : -1;
    if (at >= 0) cursor = at + raw.length;
    record.srcStart = at >= 0 ? at : cursor;
    assignChildren(record);
  }
}

function assignChildren(token: Positioned): void {
  const base = token.srcStart;
  if (base === undefined) return;
  const raw = token.raw ?? "";

  if (Array.isArray(token.items)) {
    let cursor = 0;
    for (const item of token.items as Positioned[]) {
      const itemRaw = item.raw ?? "";
      const at = itemRaw ? raw.indexOf(itemRaw, cursor) : -1;
      if (at < 0) {
        item.srcStart = undefined;
        continue;
      }
      item.srcStart = base + at;
      cursor = at + itemRaw.length;
      assignChildren(item);
    }
  }

  if (Array.isArray(token.header) || Array.isArray(token.rows)) {
    const cells: Positioned[] = [
      ...(Array.isArray(token.header) ? (token.header as Positioned[]) : []),
      ...(Array.isArray(token.rows) ? (token.rows as Positioned[][]).flat() : []),
    ];
    let cursor = 0;
    for (const cell of cells) {
      const text = cell.text ?? "";
      if (!text) continue;
      const at = raw.indexOf(text, cursor);
      if (at < 0) continue;
      cursor = at + text.length;
      cell.srcStart = base + at;
      assignChildList(cell.tokens, base + at, text);
    }
  }

  assignChildList(token.tokens, base, raw);
}

function assignChildList(children: unknown, base: number, parentRaw: string): void {
  if (!Array.isArray(children)) return;
  let cursor = 0;
  for (const child of children as Positioned[]) {
    const raw = child.raw ?? "";
    const at = raw ? parentRaw.indexOf(raw, cursor) : -1;
    if (at < 0) {
      child.srcStart = undefined;
      continue;
    }
    child.srcStart = base + at;
    cursor = at + raw.length;
    assignChildren(child);
  }
}

/** Pair every placeholder in the prepared text with the range it replaced. */
function collectSubstitutions(
  preparedSegments: readonly string[],
  isCode: readonly boolean[],
  codes: readonly CodeEntry[],
  maths: readonly MathEntry[],
): Substitution[] {
  const substitutions: Substitution[] = [];
  const placeholder = /@@(CODE|MATH)(\d+)@@/g;
  let base = 0;

  for (let i = 0; i < preparedSegments.length; i += 1) {
    const segment = preparedSegments[i];
    if (!isCode[i]) {
      for (const match of segment.matchAll(placeholder)) {
        const entry = match[1] === "CODE" ? codes[Number(match[2])] : maths[Number(match[2])];
        if (!entry) continue;
        substitutions.push({
          p0: base + match.index,
          p1: base + match.index + match[0].length,
          o0: entry.src0,
          o1: entry.src1,
        });
      }
    }
    base += segment.length + 1;
  }

  return substitutions;
}

/**
 * Render the prepared markdown with the fragment table.
 *
 * One wrapper per text run, never per word: a word is a range inside a run, and
 * the run is what the DOM needs to map back. Code, formulas, images and fences
 * are atomic spans, because their rendered text is not their source text.
 */
function renderMarked(
  prepared: string,
  substitutions: readonly Substitution[],
  lineSubstitutions: readonly Substitution[] = [],
): { html: string; fragments: Fragment[] } {
  const fragments: Fragment[] = [];
  const sourceOf = (preparedOffset: number) =>
    translateOffset(substitutions, translateOffset(lineSubstitutions, preparedOffset));
  const push = (fragment: Fragment): number => {
    fragments.push(fragment);
    return fragments.length - 1;
  };
  const escape = escapeHtml;

  const renderer: RendererObject = {
    text(token) {
      const positioned = token as unknown as Positioned;
      const raw = token.raw ?? "";
      const escaped = "escaped" in token && token.escaped === true;
      const children = "tokens" in token ? token.tokens : undefined;
      const body =
        children && children.length > 0
          ? this.parser.parseInline(children)
          : escaped
            ? token.text
            : escape(token.text);

      if (positioned.srcStart === undefined || raw.length === 0) return body;
      // Children carry their own offsets; wrapping the parent would overlap them.
      if (children && children.length > 0) return body;

      const pieces = splitPieces(raw);
      if (pieces.length === 1) {
        const index = push({
          src0: sourceOf(positioned.srcStart),
          src1: sourceOf(positioned.srcStart + raw.length),
          raw,
          kind: "text",
        });
        return `<span data-f="${index}">${body}</span>`;
      }

      let out = "";
      for (const piece of pieces) {
        const src0 = sourceOf(positioned.srcStart + piece.start);
        const src1 = sourceOf(positioned.srcStart + piece.start + piece.text.length);
        const index = push({
          src0,
          src1,
          raw: piece.text,
          kind: piece.kind === "raw" ? "text" : piece.kind,
        });
        const html =
          piece.kind === "raw" ? (escaped ? piece.text : escape(piece.text)) : piece.text;
        out += `<span data-f="${index}">${html}</span>`;
      }
      return out;
    },

    code(token) {
      // Through the prototype, not a detached `new Renderer()`: the built-in
      // `image` below needs `this.parser` to render alt text, and a detached
      // renderer never receives one.
      const html = Renderer.prototype.code.call(this, token);
      const positioned = token as unknown as Positioned;
      if (positioned.srcStart === undefined) return html;
      const index = push({
        src0: sourceOf(positioned.srcStart),
        src1: sourceOf(positioned.srcStart + (token.raw?.length ?? 0)),
        raw: "",
        kind: "pre",
      });
      return injectAttribute(html, "pre", `data-f="${index}"`);
    },

    image(token) {
      const html = Renderer.prototype.image.call(this, token);
      const positioned = token as unknown as Positioned;
      if (positioned.srcStart === undefined) return html;
      const index = push({
        src0: sourceOf(positioned.srcStart),
        src1: sourceOf(positioned.srcStart + (token.raw?.length ?? 0)),
        raw: "",
        kind: "image",
      });
      return injectAttribute(html, "img", `data-f="${index}"`);
    },
  };

  const instance = new Marked({ gfm: true, breaks: false, pedantic: false });
  instance.use({ renderer });
  const tokens = instance.lexer(prepared);
  assignOffsets(tokens, prepared);
  return { html: instance.parser(tokens) as string, fragments };
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
  /** Word-level source fragments, present only when `map` was requested. */
  fragments?: Fragment[];
}

export function renderPreview(source: string, options: RenderOptions): RenderResult {
  const mathEnabled = options.math ?? true;
  const mermaidEnabled = options.mermaid ?? true;

  const codes: CodeEntry[] = [];
  const maths: MathEntry[] = [];
  const ranges = [
    ...markdownCodeSpans(source).map((range) => ({
      ...range,
      code: true,
      body: "",
      display: false,
    })),
    ...(mathEnabled ? analyzeMath(source).math.map((range) => ({ ...range, code: false })) : []),
  ].sort((a, b) => a.from - b.from);
  let prepared = "";
  let last = 0;
  for (const range of ranges) {
    prepared += source.slice(last, range.from);
    if (range.code) {
      const raw = source.slice(range.from, range.to);
      const ticks = /^`+/.exec(raw)?.[0].length ?? 0;
      let text = raw.slice(ticks, -ticks).replace(/\r?\n/g, " ");
      if (text.startsWith(" ") && text.endsWith(" ") && /[^ ]/.test(text)) text = text.slice(1, -1);
      prepared += "@@CODE" + codes.length + "@@";
      codes.push({ text, src0: range.from, src1: range.to });
    } else {
      prepared += "@@MATH" + maths.length + "@@";
      maths.push({ body: range.body, display: range.display, src0: range.from, src1: range.to });
    }
    last = range.to;
  }
  prepared += source.slice(last);
  const preparedSegments = [prepared];
  const isCode = [false];
  const lineSubstitutions: Substitution[] = [];
  let lineDelta = 0;
  const normalized = prepared.replace(/\r\n?/g, (match, offset: number) => {
    lineSubstitutions.push({
      p0: offset - lineDelta,
      p1: offset - lineDelta + 1,
      o0: offset,
      o1: offset + match.length,
    });
    lineDelta += match.length - 1;
    return "\n";
  });
  const mapped = options.map
    ? renderMarked(
        normalized,
        collectSubstitutions(preparedSegments, isCode, codes, maths),
        lineSubstitutions,
      )
    : null;
  const rawHtml = mapped ? mapped.html : (marked.parse(prepared, { async: false }) as string);

  const clean = DOMPurify.sanitize(rawHtml, {
    ADD_ATTR: [
      "align",
      "data-f",
      "data-mermaid",
      "data-href",
      "id",
      "colspan",
      "rowspan",
      "type",
      "checked",
      "disabled",
    ],
    // `input` has to survive sanitising so GFM task lists keep their checkbox;
    // normalizeInputs() then strips every input that is not a disabled checkbox.
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

  return {
    html: host.innerHTML,
    linesMapped: mapping.complete,
    anchors: mapping.count,
    fragments: mapped?.fragments,
  };
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
  codes: readonly CodeEntry[],
  maths: readonly MathEntry[],
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
        code.textContent = codes[index]?.text ?? "";
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

export function mathNode(entry: { body: string; display: boolean } | undefined): Node {
  const span = document.createElement("span");
  span.className = entry?.display ? "math-display" : "math-inline";
  if (!entry) {
    span.textContent = "";
    return span;
  }
  span.dataset.tex = entry.body;
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

const MATH_IN_TEXT = /\\\(([\s\S]*?)\\\)|\\\[([\s\S]*?)\\\]/g;

/**
 * Draw the `\(…\)` and `\[…\]` delimiters Asciidoctor leaves in its HTML.
 *
 * The Markdown pipeline extracts mathematics from the *source* before `marked`,
 * so it has no DOM pass to reuse. AsciiDoc's converter emits inline LaTeX as
 * plain text and display LaTeX inside `.stemblock`; this walks the text nodes
 * and replaces only those delimiters. `$…$` is deliberately absent: AsciiDoc
 * puts AsciiMath there, and it is not TeX.
 */
export function renderMathIn(host: HTMLElement): number {
  const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = (node as Text).parentElement;
      if (!parent || parent.closest("pre, code, script, style, textarea")) {
        return NodeFilter.FILTER_REJECT;
      }
      const text = node.nodeValue ?? "";
      return /\\[([]/.test(text) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);

  let count = 0;
  for (const node of nodes) {
    const text = node.nodeValue ?? "";
    MATH_IN_TEXT.lastIndex = 0;
    let match: RegExpExecArray | null;
    let last = 0;
    let replaced = false;
    const fragment = document.createDocumentFragment();
    while ((match = MATH_IN_TEXT.exec(text)) !== null) {
      replaced = true;
      if (match.index > last) {
        fragment.appendChild(document.createTextNode(text.slice(last, match.index)));
      }
      const display = match[2] !== undefined;
      fragment.appendChild(mathNode({ body: (display ? match[2] : match[1]) ?? "", display }));
      last = MATH_IN_TEXT.lastIndex;
      count += 1;
    }
    if (!replaced) continue;
    if (last < text.length) fragment.appendChild(document.createTextNode(text.slice(last)));
    node.parentNode?.replaceChild(fragment, node);
  }
  return count;
}

/**
 * The AsciiDoc structure the preview stylesheet already applies.
 *
 * The HTML and print exports never load `styles.css`; they concatenate their
 * own rules. This is the copy those wrappers use. The preview keeps its copy in
 * `src/styles.css`, beside the rest of the preview rules.
 */
export const ASCIIDOC_CSS = `
.admonitionblock > table{display:table;width:100%;border-collapse:collapse;margin:0;background:none}
.admonitionblock > table tr,.admonitionblock > table td{border:0;background:none}
.admonitionblock > table td{padding:0;vertical-align:top}
.admonitionblock > table td.icon{width:4.5em;text-align:center;padding-right:.75em}
.admonitionblock > table td.icon .title{font-weight:600;text-transform:uppercase;font-size:.78em;letter-spacing:.04em}
.admonitionblock > table td.content{padding:.15em 0 .15em 1em;border-left:3px solid #d0d0d0;color:#555}
.admonitionblock.note > table td.content{border-left-color:#0969da}
.admonitionblock.tip > table td.content{border-left-color:#1a7f37}
.admonitionblock.important > table td.content{border-left-color:#8250df}
.admonitionblock.warning > table td.content{border-left-color:#9a6700}
.admonitionblock.caution > table td.content{border-left-color:#cf222e}
.admonitionblock.note > table td.icon .title{color:#0969da}
.admonitionblock.tip > table td.icon .title{color:#1a7f37}
.admonitionblock.important > table td.icon .title{color:#8250df}
.admonitionblock.warning > table td.icon .title{color:#9a6700}
.admonitionblock.caution > table td.icon .title{color:#cf222e}
.checklist{list-style:none;padding-left:1.4em}
.checklist > li > p:first-child{margin-left:-1.2em}
.title,div.title{font-weight:600;font-style:italic;margin:0 0 .35em}
#toc{border:1px solid #e0e0e0;background:#f7f7f8;padding:.75em 1em;margin:0 0 1.5em;border-radius:6px}
#toc #toctitle{font-weight:700;text-transform:uppercase;font-size:.78em;letter-spacing:.06em;margin-bottom:.4em}
#toc ul{list-style:none;padding-left:0;margin:0}
#toc ul ul{padding-left:1em}
#toc li{margin:.15em 0}
.quoteblock .attribution{text-align:right;font-style:italic;color:#666;margin-top:.25em}
.line-through{text-decoration:line-through}
.stemblock .content{text-align:center}
.asciidoc-error{background:#fff2f0;border:1px solid #ffccc7;border-radius:6px;padding:12px 14px;white-space:pre-wrap}
`;

export function decorateCodeBlocks(host: HTMLElement, mermaidEnabled = true): void {
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

export function decorateLinks(host: HTMLElement, baseDir: string | null): void {
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
    const minLevel = Math.min(...headings.map((h) => Number(h.tagName.slice(1))));
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
 *
 * `typographyCss` carries the reader's typeface choices as custom properties and
 * `fontCss` carries the bundled faces themselves as data URLs. Both are needed:
 * a family named in a stack means nothing to a browser reading a temporary file,
 * which cannot reach the application's assets and would quietly substitute a
 * system font — so the PDF would stop matching the preview exactly when the
 * reader had gone to the trouble of choosing a face.
 */
export function wrapPrintHtml(
  title: string,
  bodyHtml: string,
  tokenCss: string,
  typographyCss = "",
  fontCss = "",
): string {
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    `<title>${escapeHtml(title)}</title>`,
    // Without this the mathematics collapses, exactly as it would in the
    // preview: KaTeX needs its layout rules, not just its DOM.
    `<link rel="stylesheet" href="${KATEX_STYLESHEET_URL}">`,
    fontCss ? `<style>${fontCss}</style>` : "",
    "<style>",
    ":root{color-scheme:light}",
    typographyCss,
    "html,body{background:#fff}",
    "@page{size:A4;margin:18mm 16mm}",
    "body{max-width:none;margin:0;padding:0;color:#1a1a1a;",
    "font-family:var(--font-body,Georgia,serif);",
    "line-height:1.65;",
    // Points rather than pixels: the page is a piece of paper, and the reader's
    // pixel size was chosen for a screen. 16px at 96dpi is 12pt.
    "font-size:calc(var(--body-size,16px) * 0.75)}",
    "font-kerning:normal;font-variant-numeric:var(--prose-figures,normal);",
    "font-variant-ligatures:common-ligatures contextual;font-optical-sizing:auto}",
    // A heading stranded at the foot of a page, or a table split across two, is
    // the commonest way an otherwise fine printout looks broken.
    "h1,h2,h3,h4,h5,h6{break-after:avoid;page-break-after:avoid;break-inside:avoid;",
    "font-family:var(--font-heading,inherit);font-variant-numeric:normal;",
    "font-weight:var(--weight-strong,600)}",
    "strong,b{font-weight:var(--weight-strong,600)}",
    // The divider independent of the one under h1/h2, which uses the table and
    // panel border colour and must stay lighter than this.
    "hr{border:none;border-top:1px solid #cfcfcf;margin:1.6em 0}",
    "table,pre,blockquote,figure{break-inside:avoid;page-break-inside:avoid}",
    "img,svg{max-width:100%;break-inside:avoid}",
    "table{border-collapse:collapse;width:100%;font-variant-numeric:var(--table-figures,normal)}",
    "th,td{border:1px solid #c8c8c8;padding:5px 9px;text-align:left}",
    "th{background:#f2f2f2}",
    "pre{background:#f6f8fa;padding:10px 12px;border-radius:4px;overflow:visible;white-space:pre-wrap;",
    // The family and size belong on `pre`: a literal block is a bare `<pre>`
    // with no `<code>` in it, so `code`-only styling would print it in the
    // default monospace at full prose size.
    "font-family:var(--font-code,monospace);font-size:.86em;line-height:1.6;",
    "font-variant-ligatures:var(--code-ligatures,normal);",
    "font-variant-numeric:var(--code-figures,normal)}",
    "code{font-family:var(--font-code,monospace);font-size:.9em;",
    "font-variant-ligatures:var(--code-ligatures,normal);",
    "font-variant-numeric:var(--code-figures,normal)}",
    "pre code{font-size:inherit;line-height:inherit}",
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
  ]
    .filter((line) => line !== "")
    .join("\n");
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
    "pre{background:rgba(127,127,127,.12);padding:12px 14px;border-radius:6px;overflow:auto;",
    // A literal block has no `<code>` child, so the face and size must be on
    // `pre` or the exported file shows it in the browser default at 100%.
    "font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.9em}",
    "code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.9em}",
    "pre code{font-size:inherit}",
    "table{border-collapse:collapse}th,td{border:1px solid rgba(127,127,127,.35);padding:6px 10px}",
    "blockquote{margin:0;padding-left:14px;border-left:3px solid rgba(127,127,127,.4);opacity:.9}",
    // The same divider the preview draws: stronger than the panel border, so a
    // rule in the exported document does not disappear against white or black.
    `hr{border:none;border-top:1px solid ${isDark ? "#4a4a4a" : "#cfcfcf"};margin:1.6em 0}`,
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
