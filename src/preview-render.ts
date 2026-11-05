//! The pure half of the Markdown preview.
//!
//! Everything here is string work: math/code masking, `marked`, KaTeX's
//! `renderToString`, the word-level fragment table and the block line list. It
//! must never import a DOM module, a Tauri API or a stylesheet, because the
//! module worker runs it off the webview's main thread.
//!
//! `src/markdown.ts` uses the same function for the synchronous export path and
//! as the fallback when a worker cannot start. Keeping one implementation is
//! what stops the two paths from drifting.

import { Marked, Renderer, type RendererObject, type Token } from "marked";
import katex from "katex";
import { analyzeMath } from "./math-delimiters.ts";
import { markdownCodeSpans } from "./markdown-context.ts";
import { translateOffset, type Fragment, type Substitution } from "./source-map.ts";

export interface ChunkOptions {
  /** Render `$…$` with KaTeX. */
  math?: boolean;
  /** Emit the source fragments word-level sync needs. */
  map?: boolean;
}

/** A code span protected from the parser, with the source range it came from. */
export interface CodeEntry {
  text: string;
  src0: number;
  src1: number;
}

/** A formula extracted before `marked`, with the source range it came from. */
export interface MathEntry {
  body: string;
  display: boolean;
  src0: number;
  src1: number;
}

/** A formula with the KaTeX HTML the main thread may insert after sanitising. */
export interface RenderedMath {
  body: string;
  display: boolean;
  html: string | null;
  error: string | null;
}

export interface PreviewChunks {
  /** One HTML fragment per top-level `marked` token, in order. */
  chunks: string[];
  /** Code-span text, indexed by the `@@CODEn@@` placeholder. */
  codes: CodeEntry[];
  /** Formulas with pre-rendered KaTeX HTML, indexed by `@@MATHn@@`. */
  maths: RenderedMath[];
  /** Word-level fragments, present only when `map` was requested. */
  fragments?: Fragment[];
  /** One line per element that renders, or null when the counts disagree. */
  lines: number[] | null;
}

const PLACEHOLDER_PIECE = /@@(CODE|MATH)(\d+)@@/g;

export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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
 *
 * The token list is parsed one top-level token at a time so the main thread can
 * sanitise and insert a batch without ever holding the whole document's DOM
 * work in one task. `marked` keeps no state between top-level tokens.
 */
function renderMappedChunks(
  prepared: string,
  substitutions: readonly Substitution[],
  lineSubstitutions: readonly Substitution[] = [],
): { chunks: string[]; fragments: Fragment[] } {
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
  const chunks = tokens.map((token) => instance.parser([token]) as string);
  return { chunks, fragments };
}

/** Render the prepared markdown without a fragment table. */
function renderPlainChunks(prepared: string): string[] {
  const instance = new Marked({ gfm: true, breaks: false, pedantic: false });
  const tokens = instance.lexer(prepared);
  return tokens.map((token) => instance.parser([token]) as string);
}

// ---------------------------------------------------------------------------
// Line anchors
// ---------------------------------------------------------------------------

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
 * One source line per element that renders, or null when the zip is not exact.
 *
 * The markdown is lexed from the *original* source, so each token's `raw` is a
 * literal slice of what the user typed and its offset is exact. The rendered
 * element list and this token list are both in document order, so they can be
 * zipped index by index. A disagreement drops the whole annotation rather than
 * pointing at the wrong line.
 */
function blockLines(source: string): number[] | null {
  const instance = new Marked({ gfm: true, breaks: false, pedantic: false });
  const tokens = instance.lexer(source).filter((token) => !rendersNothing(token));
  const starts = lineStarts(source);
  let cursor = 0;
  const lines: number[] = [];
  for (const token of tokens) {
    const raw = token.raw ?? "";
    const at = raw.length > 0 ? source.indexOf(raw, cursor) : -1;
    if (at < 0) return null;
    cursor = at + raw.length;
    lines.push(lineOf(starts, at));
  }
  return lines;
}

// ---------------------------------------------------------------------------
// The pipeline
// ---------------------------------------------------------------------------

function renderMath(maths: readonly MathEntry[]): RenderedMath[] {
  return maths.map((entry) => {
    try {
      return {
        body: entry.body,
        display: entry.display,
        html: katex.renderToString(entry.body, {
          displayMode: entry.display,
          throwOnError: false,
          strict: false,
          output: "html",
        }),
        error: null,
      };
    } catch (error) {
      return { body: entry.body, display: entry.display, html: null, error: String(error) };
    }
  });
}

/**
 * Prepare a Markdown document for the preview.
 *
 * The result is everything the main thread needs to paint: top-level HTML
 * chunks, the code/math tables the placeholders refer to, the fragment table for
 * word sync, and the block line list. No DOM is touched, so this can run in a
 * worker and the synchronous export path can share it.
 */
export function renderChunks(source: string, options: ChunkOptions = {}): PreviewChunks {
  const mathEnabled = options.math ?? true;

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

  let chunks: string[];
  let fragments: Fragment[] | undefined;
  if (options.map) {
    const mapped = renderMappedChunks(
      normalized,
      collectSubstitutions(preparedSegments, isCode, codes, maths),
      lineSubstitutions,
    );
    chunks = mapped.chunks;
    fragments = mapped.fragments;
  } else {
    chunks = renderPlainChunks(normalized);
  }

  return {
    chunks,
    codes,
    maths: renderMath(maths),
    fragments,
    lines: blockLines(source),
  };
}
