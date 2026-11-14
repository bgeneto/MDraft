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
import { parseFragment } from "parse5";
import { analyzeMath, hasMathDelimiters } from "./math-delimiters.ts";
import { markdownCodeSpans, markdownScanProtectedAndCode } from "./markdown-context.ts";
import { indexOffsets, type Fragment, type Substitution } from "./source-map.ts";
import { legacyImageCandidate } from "./legacy-image-paths.ts";
import { renderKatexCached } from "./katex-cache.ts";
import {
  DEFAULT_MAX_DIRTY_RATIO,
  diffBlocks,
  fnv1aHash,
  type BlockPatchOp,
  type DiffableBlock,
} from "./block-diff.ts";

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

/** Per-block keyed payload using block-local `@@CODE`/`@@MATH`/`data-f` indices. */
export interface MarkdownBlockChunk extends DiffableBlock {
  tokenType: string;
  silent: boolean;
  html: string;
  origStart: number;
  origEnd: number;
  newlineCount: number;
  codes: CodeEntry[];
  maths: RenderedMath[];
  fragments?: Fragment[];
}

export interface MarkdownIncrementalInfo {
  mode: "window" | "lex-diff" | "full";
  reason?: string;
  dirtyRatio: number;
  dirtyBlocks: number;
  ops: BlockPatchOp<MarkdownBlockChunk>[];
  headingsChanged: boolean;
  hasToc: boolean;
}

export interface PreviewChunks {
  /** One HTML fragment per top-level `marked` token, in order. */
  chunks: string[];
  /** Raw HTML can cross token boundaries and must be parsed as one document. */
  hasRawHtml: boolean;
  /** Code-span text, indexed by the `@@CODEn@@` placeholder. */
  codes: CodeEntry[];
  /** Formulas with pre-rendered KaTeX HTML, indexed by `@@MATHn@@`. */
  maths: RenderedMath[];
  /** Word-level fragments, present only when `map` was requested. */
  fragments?: Fragment[];
  /** One line per element that renders, or null when the counts disagree. */
  lines: number[] | null;
  /**
   * One line per rendered top-level element when raw HTML crosses token
   * boundaries. Used instead of `lines`, whose one-entry-per-token shape cannot
   * describe two elements merged by an opening tag in one token and a closing
   * tag in another.
   */
  elementLines?: number[] | null;
  legacyImages?: Record<string, { candidate: string; parsed: string }>;
  /** Keyed top-level block payloads with block-local placeholder/fragment indices. */
  blocks?: MarkdownBlockChunk[];
  /** Number of link reference definitions (`def` tokens). */
  defCount?: number;
  /** Signature of all Markdown link reference definitions (`def` tokens). */
  defSignature?: string;
  mathEnabled?: boolean;
  mapEnabled?: boolean;
  /** Patch metadata populated when produced via `renderChunksIncremental`. */
  incremental?: MarkdownIncrementalInfo;
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
// Raw HTML text
// ---------------------------------------------------------------------------

/** A visible text node of a raw HTML token, as an offset pair in the token. */
interface HtmlTextSlot {
  start: number;
  end: number;
}

/**
 * Text nodes inside these elements are not prose: scripts and styles are not
 * displayed, form options are sanitised away or rendered as controls, and
 * template content is inert. Wrapping their text would change neither the text
 * nor the map, but it can change how the browser parses the element.
 */
const HTML_TEXT_SKIP = new Set([
  "script",
  "style",
  "textarea",
  "title",
  "noscript",
  "template",
  "option",
  "optgroup",
  "select",
  "iframe",
  "object",
  "embed",
  "xmp",
  "plaintext",
  "noembed",
  "noframes",
]);

const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";

/**
 * Locate the visible text runs of a raw HTML token.
 *
 * `marked` hands raw HTML through untouched, so its text nodes have no source
 * positions and cannot join the word map. `parse5` has already parsed the same
 * markup for the HTML preview; here it supplies only the source offsets of text
 * nodes, which are exact slices of the token.
 *
 * Foreign content (SVG, MathML) is skipped because inserting an HTML `<span>`
 * into it would change the namespace and break the drawing.
 */
function htmlTextSlots(raw: string): HtmlTextSlot[] {
  if (!raw.includes("<")) return [];
  let tree: unknown;
  try {
    tree = parseFragment(raw, { sourceCodeLocationInfo: true });
  } catch {
    return [];
  }

  const slots: HtmlTextSlot[] = [];
  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const item = node as {
      nodeName?: string;
      tagName?: string;
      namespaceURI?: string;
      childNodes?: unknown[];
      content?: unknown;
      sourceCodeLocation?: { startOffset?: number; endOffset?: number } | null;
    };
    if (item.nodeName === "#text") {
      const location = item.sourceCodeLocation;
      const start = location?.startOffset;
      const end = location?.endOffset;
      if (
        typeof start !== "number" ||
        typeof end !== "number" ||
        !Number.isInteger(start) ||
        !Number.isInteger(end) ||
        end <= start
      )
        return;
      if (!raw.slice(start, end).trim()) return;
      slots.push({ start, end });
      return;
    }
    if (item.tagName && item.namespaceURI && item.namespaceURI !== HTML_NAMESPACE) return;
    if (item.tagName && HTML_TEXT_SKIP.has(item.tagName)) return;
    if (Array.isArray(item.childNodes)) for (const child of item.childNodes) walk(child);
    if (item.content) walk(item.content);
  };
  walk(tree);
  slots.sort((a, b) => a.start - b.start || a.end - b.end);
  return slots;
}

/**
 * Splice one fragment span into each raw text run that is not a code/math
 * placeholder. Placeholders stay untouched: `restorePlaceholders` replaces
 * them with code or KaTeX nodes, which are not text fragments.
 */
function renderRawHtmlText(
  raw: string,
  srcStart: number,
  sourceOf: (prepared: number) => number,
  push: (fragment: Fragment) => number,
): string {
  const slots = htmlTextSlots(raw);
  if (slots.length === 0) return raw;

  let out = "";
  let cursor = 0;
  for (const slot of slots) {
    if (slot.start < cursor) continue;
    out += raw.slice(cursor, slot.start);
    const text = raw.slice(slot.start, slot.end);
    for (const piece of splitPieces(text)) {
      const end = piece.start + piece.text.length;
      const html = text.slice(piece.start, end);
      if (piece.kind !== "raw" || html.length === 0) {
        out += html;
        continue;
      }
      const index = push({
        src0: sourceOf(srcStart + slot.start + piece.start),
        src1: sourceOf(srcStart + slot.start + end),
        raw: html,
        kind: "text",
      });
      out += `<span data-f="${index}">${html}</span>`;
    }
    cursor = slot.end;
  }
  out += raw.slice(cursor);
  return out;
}

// ---------------------------------------------------------------------------
// Word-level source fragments
// ---------------------------------------------------------------------------

/** A token carrying the offsets `marked` does not provide. */
interface Positioned {
  type?: string;
  block?: boolean;
  srcStart?: number;
  srcEnd?: number;
  srcRuns?: SourceRun[];
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

/** One source-contiguous piece of a token's `raw`. */
interface SourceRun {
  /** Offset of the piece's first character in `raw`. */
  start: number;
  /** Offset just past its last character in `raw`. */
  end: number;
  /** Prepared offset the first character came from. */
  src: number;
}

/** One line of a `Lexed` frame and where its content starts in the source. */
interface LexedSegment {
  /** Offset of the line's first character in `text`. */
  at: number;
  /** Length of the line's content, excluding its newline. */
  length: number;
  /** Prepared offset of `text[at]` in the document being prepared. */
  src: number;
}

/**
 * The text a token's descendants were lexed from, and where its lines came from.
 *
 * `marked` strips a list item's marker and continuation indentation, and a block
 * quote's `>` prefixes, before lexing what is inside. The string a child token's
 * `raw` is a slice of is therefore not the string the parent reports, and an
 * exact `indexOf` in the parent's `raw` fails for every continuation line.
 *
 * `segments` records one entry per line; `null` means `text` is one exact slice
 * starting at `base`, which is the common case and allocates nothing extra.
 */
interface Lexed {
  text: string;
  base: number;
  segments: LexedSegment[] | null;
}

function plainLexed(text: string, base: number): Lexed {
  return { text, base, segments: null };
}

/** Prepared offset of an index into a frame's text, or null when unknown. */
function lexedSource(frame: Lexed, index: number): number | null {
  if (!frame.segments) return frame.base + index;
  let low = 0;
  let high = frame.segments.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (frame.segments[middle].at <= index) {
      found = middle;
      low = middle + 1;
    } else high = middle - 1;
  }
  if (found < 0) return null;
  const segment = frame.segments[found];
  const within = index - segment.at;
  if (segment.src < 0 || within > segment.length + 1) return null;
  return segment.src + within;
}

/**
 * Frame for content `marked` dedented before lexing it.
 *
 * Both transformations leave every content line a suffix of its source line, so
 * the relationship is verified line by line before it is trusted. A line that is
 * not a suffix — a tab `marked` expanded to spaces — is marked unknown (`src`
 * negative): that line stays unmapped while the rest of the container keeps its
 * exact offsets, rather than the whole item losing every fragment or pointing at
 * the wrong characters.
 */
function suffixFrame(parent: Lexed, text: string): Lexed | null {
  const parentLines = parent.text.split("\n");
  const lines = text.split("\n");
  // The raw keeps the newline that closed its last line; the content `marked`
  // lexed from it does not carry one. Only trailing blank lines may differ.
  while (parentLines.length > lines.length && parentLines[parentLines.length - 1] === "") {
    parentLines.pop();
  }
  if (parentLines.length !== lines.length) return null;
  const segments: LexedSegment[] = [];
  let parentAt = 0;
  let lineAt = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const parentLine = parentLines[i];
    const line = lines[i];
    const src = parentLine.endsWith(line)
      ? lexedSource(parent, parentAt + parentLine.length - line.length)
      : null;
    segments.push({ at: lineAt, length: line.length, src: src ?? -1 });
    parentAt += parentLine.length + 1;
    lineAt += line.length + 1;
  }
  return { text, base: 0, segments };
}

/**
 * Frame for a raw the lexer prefixed with characters it had removed.
 *
 * A loose task item is one: `marked` moves the `[ ] ` checkbox into the
 * paragraph's raw, where the source has it immediately before the paragraph's
 * text. The characters are known, so the shift is exact.
 */
function shiftedLexed(frame: Lexed, at: number, text: string, shift: number): Lexed | null {
  const start = lexedSource(frame, at);
  if (start === null || start < shift) return null;
  const segments: LexedSegment[] = [];
  const lines = text.split("\n");
  let textAt = 0;
  let frameAt = at;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const src = i === 0 ? start - shift : lexedSource(frame, frameAt);
    if (src === null) return null;
    segments.push({ at: textAt, length: line.length, src });
    textAt += line.length + 1;
    frameAt += line.length + 1 - (i === 0 ? shift : 0);
  }
  return { text, base: segments[0].src, segments };
}

/**
 * Split `[start, end)` of a segmented frame into source-contiguous runs.
 *
 * A run ends with the newline that closed its line, because the newline is the
 * last character the source and the prepared text still share; the indentation
 * that follows it is the discontinuity.
 */
function sourceRuns(frame: Lexed, start: number, end: number, base = 0): SourceRun[] | null {
  const segments = frame.segments;
  if (!segments) return null;
  const runs: SourceRun[] = [];
  for (const segment of segments) {
    if (segment.src < 0) continue;
    const lineEnd = segment.at + segment.length + 1;
    const from = Math.max(start, segment.at);
    const to = Math.min(end, lineEnd);
    if (to <= from) continue;
    runs.push({ start: from - base, end: to - base, src: segment.src + (from - segment.at) });
  }
  return runs.length > 0 ? runs : null;
}

function runsToSegments(runs: readonly SourceRun[], text: string): LexedSegment[] {
  return runs.map((run) => ({
    at: run.start,
    length: run.end - run.start - (text[run.end - 1] === "\n" ? 1 : 0),
    src: run.src,
  }));
}

/** True when the runs map every character of `[0, length)`. */
function runsCover(runs: readonly SourceRun[], length: number): boolean {
  let cursor = 0;
  for (const run of runs) {
    if (run.start !== cursor) return false;
    cursor = run.end;
  }
  return cursor === length;
}

/**
 * Give a token the source range of its `raw`, and the frame it lexed its own
 * descendants from.
 *
 * A token whose raw crosses removed indentation is split into source-contiguous
 * runs — one `data-f` span cannot map a run that skips characters in between —
 * while a token that sits on one line keeps the cheap single-slice path.
 */
function place(token: Positioned, frame: Lexed, at: number, shift = 0): Lexed | null {
  const raw = token.raw ?? "";
  if (shift > 0) {
    const own = shiftedLexed(frame, at, raw, shift);
    return own ? placeIn(token, own) : clearPlacement(token);
  }
  const start = lexedSource(frame, at);
  if (start === null) return clearPlacement(token);
  if (!frame.segments) {
    token.srcStart = start;
    token.srcEnd = start + raw.length;
    return plainLexed(raw, start);
  }
  const end = lexedSource(frame, at + raw.length);
  if (end !== null && end - start === raw.length) {
    token.srcStart = start;
    token.srcEnd = end;
    return plainLexed(raw, start);
  }
  const runs = sourceRuns(frame, at, at + raw.length, at);
  if (!runs) return clearPlacement(token);
  token.srcStart = start;
  const last = runs[runs.length - 1];
  token.srcEnd = last.src + (last.end - last.start);
  if (runs.length > 1 || !runsCover(runs, raw.length)) token.srcRuns = runs;
  return { text: raw, base: start, segments: runsToSegments(runs, raw) };
}

/** Position a token whose own frame is already known. */
function placeIn(token: Positioned, own: Lexed): Lexed | null {
  const raw = token.raw ?? "";
  const start = own.segments ? own.segments[0].src : own.base;
  const end = lexedSource(own, raw.length);
  if (end !== null && end - start === raw.length) {
    token.srcStart = start;
    token.srcEnd = end;
    return own;
  }
  const runs = sourceRuns(own, 0, raw.length);
  if (!runs) return clearPlacement(token);
  token.srcStart = start;
  const last = runs[runs.length - 1];
  token.srcEnd = last.src + (last.end - last.start);
  if (runs.length > 1 || !runsCover(runs, raw.length)) token.srcRuns = runs;
  return own;
}

function clearPlacement(token: Positioned): null {
  token.srcStart = undefined;
  token.srcEnd = undefined;
  token.srcRuns = undefined;
  return null;
}

/**
 * The frame a token lexed its own children from.
 *
 * Only containers that rewrite every line qualify: a list item drops its marker
 * and continuation indentation, a block quote drops its `>` prefixes. A
 * paragraph's `text` is its raw minus the trailing newline and a heading's is a
 * one-line suffix, so both stay on the plain slice.
 */
function contentFrame(token: Positioned, own: Lexed): Lexed | null {
  const text = token.text;
  if (typeof text !== "string" || text === own.text) return own;
  if (token.type !== "list_item" && token.type !== "blockquote") return own;
  return suffixFrame(own, text);
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

/** A text piece with the prepared offset its first character came from. */
interface EmittedPiece {
  /** Offset of the piece's first character in the token's `raw`. */
  start: number;
  /** Offset just past the piece's last character in the token's `raw`. */
  end: number;
  text: string;
  kind: Piece["kind"];
  /** Null when the piece came from a construct the container could not locate. */
  src: number | null;
}

/**
 * Split a text run at code/math placeholders and, when its container removed
 * indentation, at the line boundaries where the source jumps.
 *
 * One `data-f` span is one contiguous DOM run mapped to one contiguous source
 * range. A run that crosses removed indentation has to become one span per line,
 * or every character after the first continuation line would point at the wrong
 * source offset. A piece with no source offset is emitted as plain text: it
 * stays in the document and simply takes part in no word mapping.
 */
function textPieces(token: Positioned): EmittedPiece[] {
  const raw = token.raw ?? "";
  const start = token.srcStart ?? 0;
  const runs = token.srcRuns;
  const pieces: EmittedPiece[] = [];
  for (const piece of splitPieces(raw)) {
    if (!runs) {
      pieces.push({
        start: piece.start,
        end: piece.start + piece.text.length,
        text: piece.text,
        kind: piece.kind,
        src: start + piece.start,
      });
      continue;
    }
    const end = piece.start + piece.text.length;
    if (piece.kind !== "raw") {
      // A placeholder replaced a code span or formula, so it is atomic and never
      // crosses the line boundary a run ends at.
      const run = runAt(runs, piece.start);
      pieces.push({
        start: piece.start,
        end,
        text: piece.text,
        kind: piece.kind,
        src: run ? run.src + (piece.start - run.start) : null,
      });
      continue;
    }
    let cursor = piece.start;
    while (cursor < end) {
      const run = runAt(runs, cursor);
      if (!run) break;
      const stop = Math.min(end, run.end);
      pieces.push({
        start: cursor,
        end: stop,
        text: raw.slice(cursor, stop),
        kind: "raw",
        src: run.src + (cursor - run.start),
      });
      cursor = stop;
    }
    if (cursor < end) {
      pieces.push({ start: cursor, end, text: raw.slice(cursor, end), kind: "raw", src: null });
    }
  }
  return pieces;
}

/** The run whose `[start, end)` contains an offset, or null between runs. */
function runAt(runs: readonly SourceRun[], offset: number): SourceRun | null {
  let low = 0;
  let high = runs.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const run = runs[middle];
    if (offset < run.start) high = middle - 1;
    else if (offset >= run.end) low = middle + 1;
    else return run;
  }
  return null;
}

/** Insert an attribute into the first opening tag of a name. */
function injectAttribute(html: string, tag: string, attribute: string): string {
  const at = html.indexOf(`<${tag}`);
  if (at < 0) return html;
  const after = at + tag.length + 1;
  return `${html.slice(0, after)} ${attribute}${html.slice(after)}`;
}

/** Stamps bind sanitized image elements to candidates without trusting raw HTML. */
function legacyImagesForRender() {
  const definitions = new Map<string, string | null>();
  const images: NonNullable<PreviewChunks["legacyImages"]> = {};
  let nonce: string | null = null;
  let next = 0;
  return {
    images,
    definitions(tokens: readonly Token[]) {
      for (const token of tokens) {
        if (token.type !== "def") continue;
        const candidate = legacyImageCandidate(token.raw, token.href);
        if (definitions.has(token.href)) {
          if (definitions.get(token.href) !== candidate) definitions.set(token.href, null);
        } else definitions.set(token.href, candidate);
      }
    },
    stamp(html: string, token: { raw: string; href: string }) {
      let candidate = legacyImageCandidate(token.raw, token.href);
      if (!candidate && /^!\[(?:[^\]\\\r\n]|\\.)*\](?:\[[^\]\r\n]*\])?$/.test(token.raw)) {
        candidate = definitions.get(token.href) ?? null;
      }
      if (!candidate || !globalThis.crypto?.getRandomValues) return html;
      if (!nonce) {
        nonce = Array.from(globalThis.crypto.getRandomValues(new Uint32Array(4)), (n) =>
          n.toString(16).padStart(8, "0"),
        ).join("");
      }
      const id = `${nonce}-${next++}`;
      images[id] = { candidate, parsed: token.href };
      return injectAttribute(html, "img", `data-mdraft-legacy="${id}"`);
    },
  };
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
    const start = at >= 0 ? at : cursor;
    record.srcStart = start;
    record.srcEnd = start + raw.length;
    const own = plainLexed(raw, start);
    assignChildren(record, own, contentFrame(record, own));
  }
}

function assignChildren(token: Positioned, own: Lexed, content: Lexed | null): void {
  if (token.srcStart === undefined) return;

  if (Array.isArray(token.items)) {
    let cursor = 0;
    for (const item of token.items as Positioned[]) {
      const itemRaw = item.raw ?? "";
      const at = itemRaw ? own.text.indexOf(itemRaw, cursor) : -1;
      if (at < 0) {
        item.srcStart = undefined;
        continue;
      }
      cursor = at + itemRaw.length;
      const placed = place(item, own, at);
      if (placed) assignChildren(item, placed, contentFrame(item, placed));
    }
  }

  if (Array.isArray(token.header) || Array.isArray(token.rows)) {
    const cells: Positioned[] = [
      ...(Array.isArray(token.header) ? (token.header as Positioned[]) : []),
      ...(Array.isArray(token.rows) ? (token.rows as Positioned[][]).flat() : []),
    ];
    let cursor = 0;
    for (const cell of cells) {
      // A table cell carries only its trimmed text, no raw slice.
      const text = cell.text ?? "";
      if (!text) continue;
      const at = own.text.indexOf(text, cursor);
      if (at < 0) continue;
      cursor = at + text.length;
      const src = lexedSource(own, at);
      if (src === null) continue;
      cell.srcStart = src;
      const inside = plainLexed(text, src);
      assignChildren(cell, inside, inside);
    }
  }

  if (content) assignChildList(token.tokens, content);
}

const TASK_PREFIX = /^\[[ xX]\] /;

function assignChildList(children: unknown, frame: Lexed): void {
  if (!Array.isArray(children)) return;
  let cursor = 0;
  for (const child of children as Positioned[]) {
    const raw = child.raw ?? "";
    let at = raw ? frame.text.indexOf(raw, cursor) : -1;
    let shift = 0;
    if (at < 0) {
      // `marked` puts a loose task item's checkbox back in front of the
      // paragraph's raw. The four characters sit immediately before the text it
      // found, so the shift is exact.
      const task = TASK_PREFIX.exec(raw);
      if (task) {
        at = frame.text.indexOf(raw.slice(task[0].length), cursor);
        shift = task[0].length;
      }
    }
    if (at < 0) {
      child.srcStart = undefined;
      continue;
    }
    cursor = at + raw.length - shift;
    const placed = place(child, frame, at, shift);
    if (placed) assignChildren(child, placed, contentFrame(child, placed));
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
interface MarkedSetupResult {
  instance: Marked;
  tokens: Token[];
  hasRawHtml: boolean;
  legacy: ReturnType<typeof legacyImagesForRender>;
  allFragments: Fragment[];
  setFragmentSink: (sink: Fragment[] | null) => void;
}

function setupMarkedTokens(
  normalized: string,
  mapEnabled: boolean,
  substitutions: readonly Substitution[],
  lineSubstitutions: readonly Substitution[],
): MarkedSetupResult {
  const allFragments: Fragment[] = [];
  let activeSink: Fragment[] | null = null;
  const legacy = legacyImagesForRender();
  const instance = new Marked({ gfm: true, breaks: false, pedantic: false });

  if (mapEnabled) {
    const sourceOffset = indexOffsets(substitutions);
    const lineOffset = indexOffsets(lineSubstitutions);
    const sourceOf = (preparedOffset: number) => sourceOffset(lineOffset(preparedOffset));
    const push = (fragment: Fragment): number => {
      allFragments.push(fragment);
      if (activeSink) {
        return activeSink.push(fragment) - 1;
      }
      return allFragments.length - 1;
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

        const pieces = textPieces(positioned);
        if (
          pieces.length === 1 &&
          pieces[0].start === 0 &&
          pieces[0].end === raw.length &&
          pieces[0].src !== null
        ) {
          // One contiguous run: keep the renderer's own body, so backslash escapes,
          // entities and raw HTML blocks render exactly as they do without a map.
          const index = push({
            src0: sourceOf(pieces[0].src),
            src1: sourceOf(pieces[0].src + raw.length),
            raw,
            kind: "text",
          });
          return `<span data-f="${index}">${body}</span>`;
        }

        let out = "";
        for (const piece of pieces) {
          const html =
            piece.kind === "raw" ? (escaped ? piece.text : escape(piece.text)) : piece.text;
          if (piece.src === null) {
            out += html;
            continue;
          }
          const index = push({
            src0: sourceOf(piece.src),
            src1: sourceOf(piece.src + piece.text.length),
            raw: piece.text,
            kind: piece.kind === "raw" ? "text" : piece.kind,
          });
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
          src1: sourceOf(positioned.srcEnd ?? positioned.srcStart + (token.raw?.length ?? 0)),
          raw: "",
          kind: "pre",
        });
        return injectAttribute(html, "pre", `data-f="${index}"`);
      },

      image(token) {
        const html = legacy.stamp(Renderer.prototype.image.call(this, token), token);
        const positioned = token as unknown as Positioned;
        if (positioned.srcStart === undefined) return html;
        const index = push({
          src0: sourceOf(positioned.srcStart),
          src1: sourceOf(positioned.srcEnd ?? positioned.srcStart + (token.raw?.length ?? 0)),
          raw: "",
          kind: "image",
        });
        return injectAttribute(html, "img", `data-f="${index}"`);
      },

      html(token) {
        const positioned = token as unknown as Positioned;
        const raw = token.raw ?? token.text ?? "";
        // An inline HTML token is a tag without text; its surrounding text tokens
        // already carry fragments. Only a block token can own a text run.
        if (positioned.block !== true || positioned.srcStart === undefined || raw.length === 0)
          return raw;
        return renderRawHtmlText(raw, positioned.srcStart, sourceOf, push);
      },
    };
    instance.use({ renderer });
  } else {
    instance.use({
      renderer: {
        image(token) {
          return legacy.stamp(Renderer.prototype.image.call(this, token), token);
        },
      },
    });
  }

  const tokens = instance.lexer(normalized);
  if (normalized.includes("\\")) legacy.definitions(tokens);
  if (mapEnabled) assignOffsets(tokens, normalized);
  const hasRawHtml = normalized.includes("<") && containsRawHtml(instance, tokens);
  return {
    instance,
    tokens,
    hasRawHtml,
    legacy,
    allFragments,
    setFragmentSink: (sink) => {
      activeSink = sink;
    },
  };
}

/**
 * HTML tokens can open in one Markdown block and close in another. The DOM
 * sanitizer must parse those blocks together; fenced/inline code is not HTML.
 */
function containsRawHtml(instance: Marked, tokens: Token[]): boolean {
  let found = false;
  instance.walkTokens(tokens, (token) => {
    if (token.type === "html") found = true;
  });
  return found;
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
export function blockLines(
  source: string,
  chunkLinesNeeded: boolean,
  primaryTokens?: readonly Token[],
  normalizedSource?: string,
  toOriginalOffset?: (normOffset: number) => number,
): { lines: number[]; chunkLines: number[] } | null {
  const tokens =
    primaryTokens ?? new Marked({ gfm: true, breaks: false, pedantic: false }).lexer(source);
  const matchSource = normalizedSource ?? source;
  const starts = lineStarts(source);
  let cursor = 0;
  const lines: number[] = [];
  const chunkLines: number[] = [];
  for (const token of tokens) {
    const raw = token.raw ?? "";
    if (raw.length === 0) {
      const origCursor = toOriginalOffset ? toOriginalOffset(cursor) : cursor;
      if (chunkLinesNeeded) chunkLines.push(lineOf(starts, origCursor));
      continue;
    }
    const at = matchSource.indexOf(raw, cursor);
    if (at < 0) return null;
    cursor = at + raw.length;
    const origAt = toOriginalOffset ? toOriginalOffset(at) : at;
    const line = lineOf(starts, origAt);
    if (chunkLinesNeeded) chunkLines.push(line);
    if (!rendersNothing(token)) lines.push(line);
  }
  return { lines, chunkLines };
}

/**
 * One source line per rendered top-level element for documents with raw HTML.
 *
 * A raw `<div>` can arrive as three Markdown tokens — open tag, paragraph,
 * close tag — but parses as one top-level element, so `blockLines` cannot be
 * zipped against the DOM. `parse5` is already the parser of record for raw
 * HTML; its source locations identify the opening tag of every top-level
 * element, and the chunk start offsets identify the token that opened it. The
 * result is one line per element, in DOM order.
 *
 * Returns null when any element has no source location or the chunk/token
 * counts disagree. The caller then keeps the existing no-anchor fallback.
 */
export function elementLinesFor(
  chunks: readonly string[],
  chunkLines: readonly number[],
): number[] | null {
  if (chunks.length !== chunkLines.length) return null;
  const joined = chunks.join("");
  if (!joined) return [];
  let tree: unknown;
  try {
    tree = parseFragment(joined, { sourceCodeLocationInfo: true });
  } catch {
    return null;
  }
  const root = tree as { childNodes?: unknown[] };
  if (!Array.isArray(root.childNodes)) return null;

  const starts: number[] = [];
  const indices: number[] = [];
  let at = 0;
  for (let i = 0; i < chunks.length; i += 1) {
    if (chunks[i].length > 0) {
      starts.push(at);
      indices.push(i);
    }
    at += chunks[i].length;
  }

  const lines: number[] = [];
  for (const node of root.childNodes) {
    if (!node || typeof node !== "object") continue;
    const element = node as {
      tagName?: string;
      sourceCodeLocation?: {
        startOffset?: number;
        startTag?: { startOffset?: number } | null;
      } | null;
    };
    // Text and comment nodes render nothing in `host.children`.
    if (!element.tagName) continue;
    const location = element.sourceCodeLocation;
    const offset = location?.startTag?.startOffset ?? location?.startOffset;
    if (typeof offset !== "number" || !Number.isFinite(offset)) return null;

    let low = 0;
    let high = starts.length - 1;
    let found = -1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (starts[mid] <= offset) {
        found = mid;
        low = mid + 1;
      } else high = mid - 1;
    }
    if (found < 0) return null;
    const line = chunkLines[indices[found]];
    if (typeof line !== "number" || !Number.isFinite(line)) return null;
    lines.push(line);
  }
  return lines;
}

// ---------------------------------------------------------------------------
// The pipeline
// ---------------------------------------------------------------------------

function renderMath(maths: readonly MathEntry[]): RenderedMath[] {
  return maths.map((entry) => {
    const cached = renderKatexCached(entry.body, entry.display);
    return {
      body: entry.body,
      display: entry.display,
      html: cached.html,
      error: cached.error,
    };
  });
}

function countNewlines(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) count += 1;
  }
  return count;
}

function localizePlaceholders(
  html: string,
  codeFrom: number,
  codeTo: number,
  mathFrom: number,
  mathTo: number,
): string {
  if (codeFrom === codeTo && mathFrom === mathTo) return html;
  return html.replace(PLACEHOLDER_PIECE, (full, kind: string, num: string) => {
    const idx = Number(num);
    if (kind === "CODE") {
      return idx >= codeFrom && idx < codeTo ? `@@CODE${idx - codeFrom}@@` : full;
    }
    return idx >= mathFrom && idx < mathTo ? `@@MATH${idx - mathFrom}@@` : full;
  });
}

function shiftCodeEntries(entries: readonly CodeEntry[], delta: number): CodeEntry[] {
  if (delta === 0 || entries.length === 0) return entries.slice();
  return entries.map((c) => ({ text: c.text, src0: c.src0 + delta, src1: c.src1 + delta }));
}

function shiftFragments(entries: readonly Fragment[], delta: number): Fragment[] {
  if (delta === 0 || entries.length === 0) return entries.slice();
  return entries.map((f) => ({
    src0: f.src0 + delta,
    src1: f.src1 + delta,
    raw: f.raw,
    kind: f.kind,
  }));
}

function shiftBlock(
  block: MarkdownBlockChunk,
  charDelta: number,
  lineDelta: number,
): MarkdownBlockChunk {
  if (charDelta === 0 && lineDelta === 0) return block;
  return {
    ...block,
    origStart: block.origStart + charDelta,
    origEnd: block.origEnd + charDelta,
    lineStart: block.lineStart + lineDelta,
    codes: shiftCodeEntries(block.codes, charDelta),
    fragments: block.fragments ? shiftFragments(block.fragments, charDelta) : undefined,
  };
}

function isTocParagraphText(rawSlice: string): boolean {
  return /^\s*\[TOC\]\s*$/i.test(rawSlice);
}

interface CompiledMarkdownResult extends PreviewChunks {
  defCount: number;
  defSignature: string;
}

function compileMarkdownSource(
  source: string,
  baseOrigOffset: number,
  baseLineStart: number,
  options: ChunkOptions,
  reuseMap?: Map<string, MarkdownBlockChunk[]>,
  prevDefSignature?: string,
): CompiledMarkdownResult {
  const mathEnabled = options.math ?? true;
  const mapEnabled = options.map ?? false;
  const mayHaveMath = mathEnabled && hasMathDelimiters(source);

  const codes: CodeEntry[] = [];
  const maths: MathEntry[] = [];
  let codeSpans: ReturnType<typeof markdownCodeSpans>;
  let mathRanges: ReturnType<typeof analyzeMath>["math"];
  if (mayHaveMath) {
    const scan = markdownScanProtectedAndCode(source, source.includes("`"));
    codeSpans = scan.codeSpans;
    mathRanges = analyzeMath(source, true, false, scan.protectedRanges).math;
  } else {
    codeSpans = markdownCodeSpans(source);
    mathRanges = [];
  }

  const ranges = [
    ...codeSpans.map((range) => ({
      ...range,
      code: true,
      body: "",
      display: false,
    })),
    ...mathRanges.map((range) => ({ ...range, code: false })),
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

  const substitutions =
    mapEnabled || codes.length > 0 || maths.length > 0
      ? collectSubstitutions(preparedSegments, isCode, codes, maths)
      : [];

  const setup = setupMarkedTokens(normalized, mapEnabled, substitutions, lineSubstitutions);
  const tokens = setup.tokens;
  const hasRawHtml = setup.hasRawHtml;

  let toLocalOrig: ((normOffset: number) => number) | undefined;
  if (substitutions.length > 0 || lineSubstitutions.length > 0) {
    const mapPrepToOrig = indexOffsets(substitutions);
    const mapNormToPrep = indexOffsets(lineSubstitutions);
    toLocalOrig = (normOffset: number) => mapPrepToOrig(mapNormToPrep(normOffset));
  }

  // Raw HTML may open/close across blocks and stays on the global single-parse path.
  if (hasRawHtml) {
    setup.setFragmentSink(null);
    const chunks = tokens.map((token) => setup.instance.parser([token]) as string);
    const lineInfo = blockLines(source, true, tokens, normalized, toLocalOrig);
    const elementLines = lineInfo ? elementLinesFor(chunks, lineInfo.chunkLines) : undefined;
    const shiftedCodes = baseOrigOffset !== 0 ? shiftCodeEntries(codes, baseOrigOffset) : codes;
    const shiftedFrags = mapEnabled
      ? baseOrigOffset !== 0
        ? shiftFragments(setup.allFragments, baseOrigOffset)
        : setup.allFragments
      : undefined;
    const defRaw = tokens
      .filter((t) => t.type === "def")
      .map((t) => t.raw ?? "")
      .join("\n");
    return {
      chunks,
      hasRawHtml: true,
      codes: shiftedCodes,
      maths: renderMath(maths),
      fragments: shiftedFrags,
      lines: lineInfo?.lines ?? null,
      elementLines,
      legacyImages: setup.legacy.images,
      defCount: tokens.filter((t) => t.type === "def").length,
      defSignature: defRaw ? fnv1aHash(defRaw) : "",
      mathEnabled,
      mapEnabled,
    };
  }

  const defRawParts: string[] = [];
  for (const token of tokens) {
    if (token.type === "def") defRawParts.push(token.raw ?? "");
  }
  const defSignature = defRawParts.length > 0 ? fnv1aHash(defRawParts.join("\n")) : "";
  const canReuse = Boolean(
    reuseMap && prevDefSignature !== undefined && defSignature === prevDefSignature,
  );

  const starts = lineStarts(source);
  const chunks: string[] = new Array(tokens.length);
  const blocks: MarkdownBlockChunk[] = new Array(tokens.length);
  const lines: number[] = [];
  const flatCodes: CodeEntry[] = [];
  const flatMaths: RenderedMath[] = [];
  const flatFragments: Fragment[] = [];

  let cursor = 0;
  let linesFailed = false;
  let codeCursor = 0;
  let mathCursor = 0;
  const optPrefix = `${mathEnabled ? "1" : "0"}\0${mapEnabled ? "1" : "0"}\0`;

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    const raw = token.raw ?? "";
    let normStart: number;
    let normEnd: number;
    if (raw.length === 0) {
      normStart = cursor;
      normEnd = cursor;
    } else {
      const at = normalized.indexOf(raw, cursor);
      if (at < 0) {
        linesFailed = true;
        normStart = cursor;
        normEnd = cursor;
      } else {
        normStart = at;
        normEnd = at + raw.length;
        cursor = normEnd;
      }
    }

    const localOrigStart = toLocalOrig ? toLocalOrig(normStart) : normStart;
    const localOrigEnd = toLocalOrig ? toLocalOrig(normEnd) : normEnd;
    const origStart = baseOrigOffset + localOrigStart;
    const origEnd = baseOrigOffset + localOrigEnd;
    const lineStart = baseLineStart - 1 + lineOf(starts, localOrigStart);
    const silent = rendersNothing(token);

    if (!linesFailed && !silent) {
      lines.push(lineStart);
    }

    const codeFrom = codeCursor;
    while (codeCursor < codes.length && codes[codeCursor].src0 < localOrigEnd) {
      codeCursor += 1;
    }
    const codeTo = codeCursor;

    const mathFrom = mathCursor;
    while (mathCursor < maths.length && maths[mathCursor].src0 < localOrigEnd) {
      mathCursor += 1;
    }
    const mathTo = mathCursor;

    const origSlice = source.slice(localOrigStart, localOrigEnd);
    const key =
      token.type === "heading" ? `h${(token as { depth?: number }).depth ?? 1}` : token.type;
    const digest = fnv1aHash(`${token.type}\0${optPrefix}${origSlice}`);
    const cacheKey = `${key}\0${digest}`;
    const reuseQueue = canReuse ? reuseMap!.get(cacheKey) : undefined;
    const reused = reuseQueue && reuseQueue.length > 0 ? reuseQueue.shift() : undefined;

    if (reused) {
      const charDelta = origStart - reused.origStart;
      const lineDeltaBlock = lineStart - reused.lineStart;
      const shifted = shiftBlock(reused, charDelta, lineDeltaBlock);
      chunks[i] = shifted.html;
      blocks[i] = shifted;
      for (const c of shifted.codes) flatCodes.push(c);
      for (const m of shifted.maths) flatMaths.push(m);
      if (mapEnabled && shifted.fragments) {
        for (const f of shifted.fragments) flatFragments.push(f);
      }
      continue;
    }

    const perBlockFragments: Fragment[] = [];
    setup.setFragmentSink(mapEnabled ? perBlockFragments : null);
    const tokenLinks =
      (
        tokens as Token[] & {
          links?: Record<string, { href: string | null; title: string | null }>;
        }
      ).links ?? {};
    const rawHtml = setup.instance.parser(Object.assign([token], { links: tokenLinks })) as string;
    const blockHtml = localizePlaceholders(rawHtml, codeFrom, codeTo, mathFrom, mathTo);
    const localCodes =
      baseOrigOffset !== 0
        ? shiftCodeEntries(codes.slice(codeFrom, codeTo), baseOrigOffset)
        : codes.slice(codeFrom, codeTo);
    const localMaths = renderMath(maths.slice(mathFrom, mathTo));
    const mappedBlockFragments = perBlockFragments.map((f) => ({
      src0: f.src0 + baseOrigOffset,
      src1: f.src1 + baseOrigOffset,
      raw:
        f.kind === "code" || f.kind === "math"
          ? localizePlaceholders(f.raw, codeFrom, codeTo, mathFrom, mathTo)
          : f.raw,
      kind: f.kind,
    }));
    const localFragments = mapEnabled ? mappedBlockFragments : undefined;

    for (const c of localCodes) flatCodes.push(c);
    for (const m of localMaths) flatMaths.push(m);
    if (localFragments) {
      for (const f of localFragments) flatFragments.push(f);
    }

    const block: MarkdownBlockChunk = {
      key,
      digest,
      tokenType: token.type,
      silent,
      html: blockHtml,
      origStart,
      origEnd,
      lineStart,
      newlineCount: countNewlines(origSlice),
      codes: localCodes,
      maths: localMaths,
      fragments: localFragments,
    };
    chunks[i] = blockHtml;
    blocks[i] = block;
  }

  return {
    chunks,
    hasRawHtml: false,
    codes: flatCodes,
    maths: flatMaths,
    fragments: mapEnabled ? flatFragments : undefined,
    lines: linesFailed ? null : lines,
    elementLines: undefined,
    legacyImages: setup.legacy.images,
    blocks,
    defCount: defRawParts.length,
    defSignature,
    mathEnabled,
    mapEnabled,
  };
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
  return compileMarkdownSource(source, 0, 1, options);
}

function isCompoundTokenType(tokenType: string): boolean {
  return (
    tokenType === "list" ||
    tokenType === "blockquote" ||
    tokenType === "code" ||
    tokenType === "table" ||
    tokenType === "def"
  );
}

function countDisplayMathDelims(text: string): number {
  let count = 0;
  let pos = 0;
  while ((pos = text.indexOf("$$", pos)) >= 0) {
    let bs = 0;
    for (let k = pos - 1; k >= 0 && text.charCodeAt(k) === 92; k -= 1) bs += 1;
    if ((bs & 1) === 0) count += 1;
    pos += 2;
  }
  return count;
}

function extractLineWindow(text: string, from: number, to: number): string {
  const startNl = text.lastIndexOf("\n", Math.max(0, from - 1));
  const lineStart = startNl < 0 ? 0 : startNl + 1;
  const endNl = text.indexOf("\n", to);
  const lineEnd = endNl < 0 ? text.length : endNl;
  return text.slice(lineStart, lineEnd);
}

function assembleFromBlocks(
  blocks: MarkdownBlockChunk[],
  mapEnabled: boolean,
  mathEnabled: boolean,
  defSignature: string,
  defCount: number,
  incremental: MarkdownIncrementalInfo,
): PreviewChunks {
  const chunks: string[] = new Array(blocks.length);
  const codes: CodeEntry[] = [];
  const maths: RenderedMath[] = [];
  const fragments: Fragment[] | undefined = mapEnabled ? [] : undefined;
  const lines: number[] = [];

  for (let i = 0; i < blocks.length; i += 1) {
    const b = blocks[i];
    chunks[i] = b.html;
    if (!b.silent) lines.push(b.lineStart);
    for (const c of b.codes) codes.push(c);
    for (const m of b.maths) maths.push(m);
    if (fragments && b.fragments) {
      for (const f of b.fragments) fragments.push(f);
    }
  }

  return {
    chunks,
    hasRawHtml: false,
    codes,
    maths,
    fragments,
    lines,
    elementLines: undefined,
    legacyImages: {},
    blocks,
    defCount,
    defSignature,
    mathEnabled,
    mapEnabled,
    incremental,
  };
}

function detectHeadingsAndToc(
  blocks: readonly MarkdownBlockChunk[],
  ops: readonly BlockPatchOp<MarkdownBlockChunk>[],
  source: string,
  forceHeadingsChanged = false,
): { headingsChanged: boolean; hasToc: boolean } {
  let hasToc = false;
  for (const b of blocks) {
    if (b.tokenType === "paragraph" && isTocParagraphText(source.slice(b.origStart, b.origEnd))) {
      hasToc = true;
      break;
    }
  }
  if (forceHeadingsChanged) {
    return { headingsChanged: true, hasToc };
  }
  for (const op of ops) {
    if (op.kind === "retain") continue;
    if (op.kind !== "remove" && op.block.tokenType === "heading") {
      return { headingsChanged: true, hasToc };
    }
    if (op.kind === "replace" && op.block.tokenType === "paragraph") {
      if (isTocParagraphText(source.slice(op.block.origStart, op.block.origEnd))) {
        return { headingsChanged: true, hasToc: true };
      }
    }
  }
  // If any block was removed we cannot inspect prevBlock type from `op`, so mark changed safely.
  if (ops.some((op) => op.kind === "remove")) {
    return { headingsChanged: true, hasToc };
  }
  return { headingsChanged: false, hasToc };
}

function tryWindowedIncremental(
  prevSource: string,
  prevChunks: CompiledMarkdownResult,
  nextSource: string,
  options: ChunkOptions,
  prefix: number,
  suffix: number,
): PreviewChunks | null {
  const prevBlocks = prevChunks.blocks;
  if (!prevBlocks || prevBlocks.length === 0) return null;

  const prevEditStart = prefix;
  const prevEditEnd = prevSource.length - suffix;
  const nextEditStart = prefix;
  const nextEditEnd = nextSource.length - suffix;

  const prevExpanded = prevSource.slice(
    Math.max(0, prevEditStart - 4),
    Math.min(prevSource.length, prevEditEnd + 4),
  );
  const nextExpanded = nextSource.slice(
    Math.max(0, nextEditStart - 4),
    Math.min(nextSource.length, nextEditEnd + 4),
  );
  if (
    prevExpanded.includes("<") ||
    prevExpanded.includes(">") ||
    nextExpanded.includes("<") ||
    nextExpanded.includes(">") ||
    /\r(?!\n)/.test(prevExpanded) ||
    /\r(?!\n)/.test(nextExpanded)
  ) {
    return null;
  }

  const prevLinesSlice = extractLineWindow(prevSource, prevEditStart, prevEditEnd);
  const nextLinesSlice = extractLineWindow(nextSource, nextEditStart, nextEditEnd);
  if (
    /(?:`{3,}|~{3,})/.test(prevLinesSlice) ||
    /(?:`{3,}|~{3,})/.test(nextLinesSlice) ||
    /^\s{0,3}\[[^\]]+\]:/m.test(prevLinesSlice) ||
    /^\s{0,3}\[[^\]]+\]:/m.test(nextLinesSlice)
  ) {
    return null;
  }

  // Locate block range overlapping [prevEditStart, prevEditEnd] cleanly at paragraph boundaries.
  let startBlock = prevBlocks.length - 1;
  let low = 0;
  let high = prevBlocks.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (prevBlocks[mid].origStart <= prevEditStart) {
      startBlock = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  startBlock = Math.max(0, startBlock - 1);
  while (
    startBlock > 0 &&
    (prevBlocks[startBlock].silent ||
      isCompoundTokenType(prevBlocks[startBlock - 1].tokenType) ||
      isCompoundTokenType(prevBlocks[startBlock].tokenType) ||
      (prevBlocks[startBlock].origStart > 0 &&
        prevSource.slice(
          Math.max(0, prevBlocks[startBlock].origStart - 2),
          prevBlocks[startBlock].origStart,
        ) !== "\n\n"))
  ) {
    startBlock -= 1;
  }

  let endBlock = startBlock + 1;
  while (endBlock < prevBlocks.length && prevBlocks[endBlock].origStart <= prevEditEnd) {
    endBlock += 1;
  }
  if (endBlock < prevBlocks.length) endBlock += 1;
  while (
    endBlock < prevBlocks.length &&
    (prevBlocks[endBlock].silent ||
      isCompoundTokenType(prevBlocks[endBlock - 1].tokenType) ||
      isCompoundTokenType(prevBlocks[endBlock].tokenType))
  ) {
    endBlock += 1;
  }

  const maxWin = Math.max(8, Math.floor(prevBlocks.length * DEFAULT_MAX_DIRTY_RATIO));
  if (endBlock - startBlock > maxWin) return null;

  const charDelta = nextSource.length - prevSource.length;
  const winPrevStart = prevBlocks[startBlock].origStart;
  const winPrevEnd =
    endBlock < prevBlocks.length ? prevBlocks[endBlock].origStart : prevSource.length;
  const winNextEnd = winPrevEnd + charDelta;
  if (winNextEnd < winPrevStart) return null;

  const slicePrev = prevSource.slice(winPrevStart, winPrevEnd);
  const sliceNext = nextSource.slice(winPrevStart, winNextEnd);
  if (
    sliceNext.includes("<") ||
    sliceNext.includes(">") ||
    ((slicePrev.includes("$$") || sliceNext.includes("$$")) &&
      ((countDisplayMathDelims(slicePrev) & 1) !== 0 ||
        (countDisplayMathDelims(sliceNext) & 1) !== 0))
  ) {
    return null;
  }
  if ((prevChunks.defCount ?? 0) > 0 && (slicePrev.includes("[") || sliceNext.includes("["))) {
    return null;
  }

  const winCompiled = compileMarkdownSource(
    sliceNext,
    winPrevStart,
    prevBlocks[startBlock].lineStart,
    options,
  );
  if (
    winCompiled.hasRawHtml ||
    winCompiled.lines === null ||
    !winCompiled.blocks ||
    winCompiled.defCount > 0 ||
    (winCompiled.legacyImages && Object.keys(winCompiled.legacyImages).length > 0)
  ) {
    return null;
  }

  const winLineDelta = countNewlines(sliceNext) - countNewlines(slicePrev);
  const nextBlocks: MarkdownBlockChunk[] = new Array(
    startBlock + winCompiled.blocks.length + (prevBlocks.length - endBlock),
  );
  let writeIdx = 0;
  for (let i = 0; i < startBlock; i += 1) {
    nextBlocks[writeIdx++] = prevBlocks[i];
  }
  for (let i = 0; i < winCompiled.blocks.length; i += 1) {
    nextBlocks[writeIdx++] = winCompiled.blocks[i];
  }
  for (let i = endBlock; i < prevBlocks.length; i += 1) {
    nextBlocks[writeIdx++] = shiftBlock(prevBlocks[i], charDelta, winLineDelta);
  }

  const diff = diffBlocks(prevBlocks, nextBlocks);
  if (!diff.incremental) return null;

  const mathEnabled = options.math ?? true;
  const mapEnabled = options.map ?? false;
  const headingInfo = detectHeadingsAndToc(nextBlocks, diff.ops, nextSource);
  return assembleFromBlocks(
    nextBlocks,
    mapEnabled,
    mathEnabled,
    prevChunks.defSignature ?? "",
    prevChunks.defCount ?? 0,
    {
      mode: "window",
      dirtyRatio: diff.dirtyRatio,
      dirtyBlocks: diff.dirtyBlocks,
      ops: diff.ops,
      headingsChanged: headingInfo.headingsChanged,
      hasToc: headingInfo.hasToc,
    },
  );
}

/**
 * Incrementally update Markdown chunks from a prior render snapshot.
 * Uses bounded source-window re-lexing first, falls back to full lex + cached block
 * reuse on fences/definitions, and falls back to full rebuild on structural triggers.
 */
export function renderChunksIncremental(
  prevSource: string,
  prevChunks: PreviewChunks | null | undefined,
  nextSource: string,
  options: ChunkOptions = {},
): PreviewChunks {
  const mathEnabled = options.math ?? true;
  const mapEnabled = options.map ?? false;
  const fullWithReason = (reason: string): PreviewChunks => {
    const full = compileMarkdownSource(nextSource, 0, 1, options);
    const hasToc = full.blocks
      ? full.blocks.some(
          (b) =>
            b.tokenType === "paragraph" &&
            isTocParagraphText(nextSource.slice(b.origStart, b.origEnd)),
        )
      : /\[TOC\]/i.test(nextSource);
    return {
      ...full,
      incremental: {
        mode: "full",
        reason,
        dirtyRatio: 1,
        dirtyBlocks: full.blocks?.length ?? full.chunks.length,
        ops: [],
        headingsChanged: true,
        hasToc,
      },
    };
  };

  if (
    !prevChunks ||
    !prevChunks.blocks ||
    prevChunks.hasRawHtml ||
    prevChunks.lines === null ||
    (prevChunks.mathEnabled ?? true) !== mathEnabled ||
    (prevChunks.mapEnabled ?? false) !== mapEnabled ||
    (prevChunks.legacyImages && Object.keys(prevChunks.legacyImages).length > 0)
  ) {
    return fullWithReason("prev-ineligible");
  }

  const prevCompiled = prevChunks as CompiledMarkdownResult;
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

  if (prefix === prevSource.length && prevSource.length === nextSource.length) {
    const ops: BlockPatchOp<MarkdownBlockChunk>[] = prevChunks.blocks.map((block, index) => ({
      kind: "retain",
      prevIndex: index,
      nextIndex: index,
      lineDelta: 0,
      block,
    }));
    const hasToc = prevChunks.blocks.some(
      (b) =>
        b.tokenType === "paragraph" && isTocParagraphText(nextSource.slice(b.origStart, b.origEnd)),
    );
    return {
      ...prevChunks,
      incremental: {
        mode: "window",
        dirtyRatio: 0,
        dirtyBlocks: 0,
        ops,
        headingsChanged: false,
        hasToc,
      },
    };
  }

  const windowed = tryWindowedIncremental(
    prevSource,
    prevCompiled,
    nextSource,
    options,
    prefix,
    suffix,
  );
  if (windowed) return windowed;

  // Tier 2: Full lex + cached block reuse (fences, ref link uses, cross-block edits).
  const reuseMap = new Map<string, MarkdownBlockChunk[]>();
  for (const b of prevChunks.blocks) {
    const key = `${b.key}\0${b.digest}`;
    const queue = reuseMap.get(key);
    if (queue) queue.push(b);
    else reuseMap.set(key, [b]);
  }

  const compiled = compileMarkdownSource(
    nextSource,
    0,
    1,
    options,
    reuseMap,
    prevCompiled.defSignature ?? "",
  );
  if (
    compiled.hasRawHtml ||
    compiled.lines === null ||
    !compiled.blocks ||
    (compiled.defSignature ?? "") !== (prevCompiled.defSignature ?? "") ||
    (compiled.legacyImages && Object.keys(compiled.legacyImages).length > 0)
  ) {
    const reason = compiled.hasRawHtml
      ? "raw-html"
      : (compiled.defSignature ?? "") !== (prevCompiled.defSignature ?? "")
        ? "def-changed"
        : "lex-ineligible";
    return {
      ...compiled,
      incremental: {
        mode: "full",
        reason,
        dirtyRatio: 1,
        dirtyBlocks: compiled.blocks?.length ?? compiled.chunks.length,
        ops: [],
        headingsChanged: true,
        hasToc: /\[TOC\]/i.test(nextSource),
      },
    };
  }

  const diff = diffBlocks(prevChunks.blocks, compiled.blocks);
  if (!diff.incremental) {
    const hasToc = compiled.blocks.some(
      (b) =>
        b.tokenType === "paragraph" && isTocParagraphText(nextSource.slice(b.origStart, b.origEnd)),
    );
    return {
      ...compiled,
      incremental: {
        mode: "full",
        reason: diff.reason,
        dirtyRatio: diff.dirtyRatio,
        dirtyBlocks: diff.dirtyBlocks,
        ops: [],
        headingsChanged: true,
        hasToc,
      },
    };
  }

  const headingInfo = detectHeadingsAndToc(compiled.blocks, diff.ops, nextSource);
  return {
    ...compiled,
    incremental: {
      mode: "lex-diff",
      dirtyRatio: diff.dirtyRatio,
      dirtyBlocks: diff.dirtyBlocks,
      ops: diff.ops,
      headingsChanged: headingInfo.headingsChanged,
      hasToc: headingInfo.hasToc,
    },
  };
}
