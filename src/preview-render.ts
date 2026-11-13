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
function renderMappedChunks(
  prepared: string,
  substitutions: readonly Substitution[],
  lineSubstitutions: readonly Substitution[] = [],
): {
  chunks: string[];
  tokens: Token[];
  fragments: Fragment[];
  hasRawHtml: boolean;
  legacyImages: NonNullable<PreviewChunks["legacyImages"]>;
} {
  const fragments: Fragment[] = [];
  const legacy = legacyImagesForRender();
  const sourceOffset = indexOffsets(substitutions);
  const lineOffset = indexOffsets(lineSubstitutions);
  const sourceOf = (preparedOffset: number) => sourceOffset(lineOffset(preparedOffset));
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

  const instance = new Marked({ gfm: true, breaks: false, pedantic: false });
  instance.use({ renderer });
  const tokens = instance.lexer(prepared);
  if (prepared.includes("\\")) legacy.definitions(tokens);
  assignOffsets(tokens, prepared);
  const hasRawHtml = prepared.includes("<") && containsRawHtml(instance, tokens);
  const chunks = tokens.map((token) => instance.parser([token]) as string);
  return { chunks, tokens, fragments, hasRawHtml, legacyImages: legacy.images };
}

/** Render the prepared markdown without a fragment table. */
function renderPlainChunks(prepared: string): {
  chunks: string[];
  tokens: Token[];
  hasRawHtml: boolean;
  legacyImages: NonNullable<PreviewChunks["legacyImages"]>;
} {
  const legacy = legacyImagesForRender();
  const instance = new Marked({ gfm: true, breaks: false, pedantic: false });
  instance.use({
    renderer: {
      image(token) {
        return legacy.stamp(Renderer.prototype.image.call(this, token), token);
      },
    },
  });
  const tokens = instance.lexer(prepared);
  if (prepared.includes("\\")) legacy.definitions(tokens);
  const hasRawHtml = prepared.includes("<") && containsRawHtml(instance, tokens);
  return {
    chunks: tokens.map((token) => instance.parser([token]) as string),
    tokens,
    hasRawHtml,
    legacyImages: legacy.images,
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
    options.map || codes.length > 0 || maths.length > 0
      ? collectSubstitutions(preparedSegments, isCode, codes, maths)
      : [];

  let chunks: string[];
  let tokens: Token[];
  let fragments: Fragment[] | undefined;
  let hasRawHtml: boolean;
  let legacyImages: PreviewChunks["legacyImages"];
  if (options.map) {
    const mapped = renderMappedChunks(normalized, substitutions, lineSubstitutions);
    chunks = mapped.chunks;
    tokens = mapped.tokens;
    fragments = mapped.fragments;
    hasRawHtml = mapped.hasRawHtml;
    legacyImages = mapped.legacyImages;
  } else {
    const plain = renderPlainChunks(normalized);
    chunks = plain.chunks;
    tokens = plain.tokens;
    hasRawHtml = plain.hasRawHtml;
    legacyImages = plain.legacyImages;
  }

  let toOriginalOffset: ((normOffset: number) => number) | undefined;
  if (substitutions.length > 0 || lineSubstitutions.length > 0) {
    const mapPrepToOrig = indexOffsets(substitutions);
    const mapNormToPrep = indexOffsets(lineSubstitutions);
    toOriginalOffset = (normOffset: number) => mapPrepToOrig(mapNormToPrep(normOffset));
  }

  const lineInfo = blockLines(source, hasRawHtml, tokens, normalized, toOriginalOffset);
  const elementLines =
    hasRawHtml && lineInfo ? elementLinesFor(chunks, lineInfo.chunkLines) : undefined;

  return {
    chunks,
    hasRawHtml,
    codes,
    maths: renderMath(maths),
    fragments,
    lines: lineInfo?.lines ?? null,
    elementLines,
    legacyImages,
  };
}
