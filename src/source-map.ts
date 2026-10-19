//! Position mapping between the rendered preview and the source document.
//!
//! The preview is HTML; the source is text. This module answers the two
//! questions word-level sync needs, in both directions:
//!
//! - "this text node, at this offset — which source characters produced it?"
//! - "this source range — where does it live in the preview?"
//!
//! It owns no rendering. An **emitter** describes what it knows, and there are
//! two kinds of knowledge:
//!
//! - `fragments` are exact: a rendered run and the source range that produced
//!   it. Markdown emits them because `marked` hands back each token's raw slice.
//! - `blocks` are approximate but bounded: a source range per anchored element.
//!   AsciiDoc emits them because its AST carries lines, not columns, so the text
//!   inside a block is located by a forward search instead.
//!
//! Both are plain data. `bindWordMap` connects them to the live DOM after the
//! HTML is inserted, which keeps a render result free of node references and
//! lets the whole table be rebuilt on every render.

/** How the source text behind a fragment is to be read. */
export type FragmentKind = "text" | "code" | "math" | "image" | "pre";

/**
 * One replacement made while preparing the source for the parser.
 *
 * `p0..p1` is the placeholder in the prepared text, `o0..o1` the original
 * characters it replaced. Used only to translate an offset; the text itself
 * lives in the renderer.
 */
export interface Substitution {
  p0: number;
  p1: number;
  o0: number;
  o1: number;
}

/** A rendered run and the exact source range that produced it. */
export interface Fragment {
  src0: number;
  src1: number;
  /** The text as the parser saw it, before escaping. Empty for containers. */
  raw: string;
  kind: FragmentKind;
}

/** A source range for an anchored element, when exact fragments are unavailable. */
export interface BlockRange {
  src0: number;
  src1: number;
}

export interface MapSpec {
  source: string;
  fragments?: readonly Fragment[];
  blocks?: readonly BlockRange[];
}

/** Where a text node sits inside its fragment and its block. */
interface BoundText {
  fragment: number;
  fragStart: number;
  block: number;
  blockStart: number;
}

interface BlockEntry {
  src0: number;
  src1: number;
}

/**
 * A block's text located against its source, in document order.
 *
 * `plain`/`at` are the folded block source: whitespace runs collapsed to one
 * space, with the raw index of every folded character. Folding is what lets a
 * hard-wrapped paragraph compare as one line while every offset stays valid.
 */
interface BlockLayout {
  plain: string;
  at: number[];
  nodes: Map<Text, BlockEntry>;
  /** A node could not be found; the rest of the block is not trusted. */
  failed: boolean;
  src0: number;
}

export interface WordMap {
  readonly source: string;
  readonly fragments: readonly Fragment[];
  readonly blocks: readonly BlockRange[];
  readonly text: WeakMap<Text, BoundText>;
  readonly fragNodes: Text[][];
  readonly blockNodes: Text[][];
  readonly blockLayouts: (BlockLayout | null | undefined)[];
}

// ---------------------------------------------------------------------------
// Binding
// ---------------------------------------------------------------------------

function walkTextNodes(root: Element, visit: (node: Text, start: number) => void): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let start = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text;
    visit(text, start);
    start += text.data.length;
  }
}

/**
 * Attach a render result to the DOM it produced.
 *
 * `[data-f]` marks an exact fragment, `[data-b]` an anchored block. Both may
 * apply to the same text node, so the second pass updates the record instead of
 * replacing it.
 */
export function bindWordMap(container: HTMLElement, spec: MapSpec): WordMap {
  const fragments = spec.fragments ?? [];
  const blocks = spec.blocks ?? [];
  const map: WordMap = {
    source: spec.source,
    fragments,
    blocks,
    text: new WeakMap(),
    fragNodes: fragments.map(() => []),
    blockNodes: blocks.map(() => []),
    blockLayouts: new Array(blocks.length),
  };

  for (const element of Array.from(container.querySelectorAll<HTMLElement>("[data-f]"))) {
    const index = Number(element.dataset.f);
    if (!Number.isInteger(index) || index < 0 || index >= fragments.length) continue;
    walkTextNodes(element, (node, start) => {
      map.fragNodes[index].push(node);
      const record = map.text.get(node) ?? { fragment: -1, fragStart: 0, block: -1, blockStart: 0 };
      record.fragment = index;
      record.fragStart = start;
      map.text.set(node, record);
    });
  }

  for (const element of Array.from(container.querySelectorAll<HTMLElement>("[data-b]"))) {
    const index = Number(element.dataset.b);
    if (!Number.isInteger(index) || index < 0 || index >= blocks.length) continue;
    walkTextNodes(element, (node, start) => {
      map.blockNodes[index].push(node);
      const record = map.text.get(node) ?? { fragment: -1, fragStart: 0, block: -1, blockStart: 0 };
      record.block = index;
      record.blockStart = start;
      map.text.set(node, record);
    });
  }

  return map;
}

// ---------------------------------------------------------------------------
// Prepared text -> original text
// ---------------------------------------------------------------------------

/**
 * Translate an offset in the prepared text back to the original source.
 *
 * Substitutions are sorted and disjoint, and the renderer splits text at
 * placeholders, so `prepared` never falls inside one. Everything before it
 * shifted by the accumulated difference.
 */
export function translateOffset(substitutions: readonly Substitution[], prepared: number): number {
  let delta = 0;
  for (const sub of substitutions) {
    if (sub.p1 > prepared) break;
    delta += sub.o1 - sub.o0 - (sub.p1 - sub.p0);
  }
  return prepared + delta;
}

// ---------------------------------------------------------------------------
// Escapes and entities
// ---------------------------------------------------------------------------

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
};

function decodeEntity(entity: string): string | null {
  if (!entity.startsWith("&") || !entity.endsWith(";")) return null;
  const body = entity.slice(1, -1);
  if (body.startsWith("#")) {
    const hex = body[1] === "x" || body[1] === "X";
    const digits = hex ? body.slice(2) : body.slice(1);
    if (!digits) return null;
    const code = Number.parseInt(digits, hex ? 16 : 10);
    if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return null;
    try {
      return String.fromCodePoint(code);
    } catch {
      return null;
    }
  }
  return NAMED_ENTITIES[body] ?? null;
}

/**
 * Raw (source) index for a character index in the rendered text.
 *
 * The two differ by backslash escapes and by HTML entities the author typed,
 * both of which render as one character. A mismatch means this run is not
 * trustworthy; the caller drops it rather than guessing.
 */
function rawIndexForText(raw: string, text: string, textIndex: number): number | null {
  let i = 0;
  let j = 0;
  while (j < textIndex) {
    if (i >= raw.length) return null;
    if (raw[i] === "\\" && i + 1 < raw.length) {
      if (raw[i + 1] !== text[j]) return null;
      i += 2;
      j += 1;
      continue;
    }
    if (raw[i] === "&") {
      const semi = raw.indexOf(";", i + 1);
      if (semi > i + 1 && semi - i <= 12) {
        const decoded = decodeEntity(raw.slice(i, semi + 1));
        if (decoded !== null && text.startsWith(decoded, j)) {
          i = semi + 1;
          j += decoded.length;
          continue;
        }
      }
    }
    if (raw[i] !== text[j]) return null;
    i += 1;
    j += 1;
  }
  return i;
}

/** The inverse: character index in the rendered text for a raw index. */
function textIndexForRaw(raw: string, rawIndex: number): number | null {
  let i = 0;
  let j = 0;
  while (i < rawIndex) {
    if (i >= raw.length) return null;
    if (raw[i] === "\\" && i + 1 < raw.length) {
      i += 2;
      j += 1;
      continue;
    }
    if (raw[i] === "&") {
      const semi = raw.indexOf(";", i + 1);
      if (semi > i + 1 && semi - i <= 12) {
        const decoded = decodeEntity(raw.slice(i, semi + 1));
        if (decoded !== null) {
          i = semi + 1;
          j += decoded.length;
          continue;
        }
      }
    }
    i += 1;
    j += 1;
  }
  return j;
}

// ---------------------------------------------------------------------------
// Fragment lookups
// ---------------------------------------------------------------------------

/** The rendered text of a fragment, joined across its text nodes. */
function fragmentText(map: WordMap, index: number): string {
  const nodes = map.fragNodes[index];
  if (nodes.length === 1) return nodes[0].data;
  return nodes.map((node) => node.data).join("");
}

/** The DOM position for a character index inside a fragment's rendered text. */
function locateInFragment(
  map: WordMap,
  index: number,
  textIndex: number,
): { node: Text; offset: number } | null {
  const nodes = map.fragNodes[index];
  let remaining = Math.max(0, textIndex);
  for (const node of nodes) {
    if (remaining <= node.data.length) return { node, offset: remaining };
    remaining -= node.data.length;
  }
  const last = nodes[nodes.length - 1];
  return last ? { node: last, offset: last.data.length } : null;
}

/** Index of the fragment whose source range contains `offset`, or the next one. */
function fragmentForOffset(map: WordMap, offset: number): number {
  let low = 0;
  let high = map.fragments.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const fragment = map.fragments[mid];
    if (fragment.src1 <= offset) {
      low = mid + 1;
    } else {
      found = mid;
      high = mid - 1;
    }
  }
  return found;
}

/** Source range for one text node, when it is an exact fragment. */
function fragmentRangeFor(
  map: WordMap,
  record: BoundText,
  start: number,
  end: number,
): { from: number; to: number } | null {
  const fragment = map.fragments[record.fragment];
  if (!fragment) return null;
  if (fragment.kind !== "text") return { from: fragment.src0, to: fragment.src1 };
  if (map.fragNodes[record.fragment].length !== 1) return null;
  const text = fragmentText(map, record.fragment);
  const rawStart = rawIndexForText(fragment.raw, text, record.fragStart + start);
  const rawEnd = rawIndexForText(fragment.raw, text, record.fragStart + end);
  if (rawStart === null || rawEnd === null) return null;
  return { from: fragment.src0 + rawStart, to: fragment.src0 + rawEnd };
}

// ---------------------------------------------------------------------------
// Block lookups
// ---------------------------------------------------------------------------

const WHITESPACE = /\s/;

/** Collapse whitespace runs, keeping the raw index of every folded character. */
function foldWhitespace(text: string): { plain: string; at: number[] } {
  let plain = "";
  const at: number[] = [];
  let i = 0;
  while (i < text.length) {
    if (WHITESPACE.test(text[i])) {
      at.push(i);
      plain += " ";
      while (i < text.length && WHITESPACE.test(text[i])) i += 1;
      continue;
    }
    at.push(i);
    plain += text[i];
    i += 1;
  }
  return { plain, at };
}

/** Locate a block's text nodes against its source, once. */
function blockLayout(map: WordMap, index: number): BlockLayout | null {
  const cached = map.blockLayouts[index];
  if (cached !== undefined) return cached;

  const block = map.blocks[index];
  const nodes = map.blockNodes[index];
  if (!block || nodes.length === 0) {
    map.blockLayouts[index] = null;
    return null;
  }

  const raw = map.source.slice(block.src0, block.src1);
  const { plain, at } = foldWhitespace(raw);
  const layout: BlockLayout = { plain, at, nodes: new Map(), failed: false, src0: block.src0 };
  let cursor = 0;

  for (const node of nodes) {
    const folded = foldWhitespace(node.data);
    if (folded.plain.trim().length === 0) continue;
    const found = plain.indexOf(folded.plain, cursor);
    if (found < 0) {
      // The text came from somewhere a search cannot follow: an attribute
      // substitution, a typographic replacement, an include. Abandon the rest of
      // the block rather than sliding the cursor and painting the wrong word.
      layout.failed = true;
      break;
    }
    layout.nodes.set(node, {
      src0: block.src0 + at[found],
      src1: block.src0 + at[found + folded.plain.length - 1] + 1,
    });
    cursor = found + folded.plain.length;
  }

  map.blockLayouts[index] = layout;
  return layout;
}

/**
 * Index of the **deepest** block containing `offset`.
 *
 * Anchored blocks nest — a section and its paragraph both carry a range — and
 * the paragraph is the one whose search is bounded and trustworthy. Blocks are in
 * source order, so the last one starting at or before the offset is the deepest
 * candidate; walking back finds the enclosing block when the offset sits in a gap.
 */
function blockForOffset(map: WordMap, offset: number): number {
  let low = 0;
  let high = map.blocks.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (map.blocks[mid].src0 <= offset) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  for (let i = found; i >= 0; i -= 1) {
    if (map.blocks[i].src1 > offset) return i;
  }
  return -1;
}

/** Source range for a text node located by search inside its block. */
function blockRangeFor(
  map: WordMap,
  node: Text,
  start: number,
  end: number,
): { from: number; to: number } | null {
  const record = map.text.get(node);
  if (!record || record.block < 0) return null;
  const layout = blockLayout(map, record.block);
  if (!layout) return null;
  const entry = layout.nodes.get(node);
  // A node past a failed search has no entry: the block was abandoned.
  if (!entry) return null;
  const base = entry.src0 + start;
  return { from: base, to: entry.src0 + end };
}

// ---------------------------------------------------------------------------
// Public lookups
// ---------------------------------------------------------------------------

/** The kind of the exact fragment a text node belongs to, if any. */
export function fragmentKindFor(map: WordMap, node: Text): FragmentKind | null {
  const record = map.text.get(node);
  if (!record || record.fragment < 0) return null;
  return map.fragments[record.fragment]?.kind ?? null;
}

/** Source offset for a point inside a text node, or null when it is unmapped. */
export function sourceOffsetFor(map: WordMap, node: Text, offsetInNode: number): number | null {
  const record = map.text.get(node);
  if (!record) return null;
  if (record.fragment >= 0) {
    const fragment = map.fragments[record.fragment];
    if (!fragment) return null;
    // Code, formulas, images and fences are atomic: the whole span is the answer.
    if (fragment.kind !== "text") return fragment.src0;
    if (map.fragNodes[record.fragment].length !== 1) return null;
    const text = fragmentText(map, record.fragment);
    const raw = rawIndexForText(fragment.raw, text, record.fragStart + offsetInNode);
    return raw === null ? null : fragment.src0 + raw;
  }
  return blockRangeFor(map, node, offsetInNode, offsetInNode)?.from ?? null;
}

/** Source range for a selection inside one text node, or null when unmapped. */
export function sourceRangeFor(
  map: WordMap,
  node: Text,
  start: number,
  end: number,
): { from: number; to: number } | null {
  const record = map.text.get(node);
  if (!record) return null;
  if (record.fragment >= 0) return fragmentRangeFor(map, record, start, end);
  return blockRangeFor(map, node, start, end);
}

/** The DOM point where a source range ends, widening past unmapped text. */
function endPointForSource(
  map: WordMap,
  offset: number,
): { node: Text; offset: number } | null {
  const direct = pointForSource(map, offset, "end");
  if (direct) return direct;
  if (map.fragments.length > 0) {
    let index = -1;
    for (let i = 0; i < map.fragments.length; i += 1) {
      if (map.fragments[i].src0 < offset) index = i;
      else break;
    }
    if (index >= 0) {
      const nodes = map.fragNodes[index];
      const last = nodes[nodes.length - 1];
      if (last) return { node: last, offset: last.data.length };
    }
  }
  if (map.blocks.length > 0 && offset > 0) {
    const block = blockForOffset(map, offset - 1);
    if (block >= 0) {
      const layout = blockLayout(map, block);
      if (layout) {
        let last: { node: Text; offset: number } | null = null;
        for (const [node, entry] of layout.nodes) {
          if (entry.src0 >= offset) break;
          last = { node, offset: Math.min(node.data.length, offset - entry.src0) };
        }
        if (last) return last;
      }
    }
  }
  return null;
}

/** DOM point for a source offset, or null when the offset is unmapped. */
export function pointForSource(
  map: WordMap,
  offset: number,
  bias: "start" | "end" = "start",
): { node: Text; offset: number } | null {
  if (map.fragments.length > 0) {
    const index = fragmentForOffset(map, offset);
    if (index < 0) return null;
    const fragment = map.fragments[index];
    if (fragment.kind !== "text") {
      // An atomic span is one unit: a point inside it means the whole element.
      const nodes = map.fragNodes[index];
      const node = bias === "start" ? nodes[0] : nodes[nodes.length - 1];
      if (!node) return null;
      return { node, offset: bias === "start" ? 0 : node.data.length };
    }
    if (map.fragNodes[index].length !== 1) return null;
    const raw = Math.max(0, Math.min(fragment.raw.length, offset - fragment.src0));
    const indexInText = textIndexForRaw(fragment.raw, raw);
    if (indexInText === null) return null;
    return locateInFragment(map, index, indexInText);
  }

  const block = blockForOffset(map, offset);
  if (block < 0) return null;
  const layout = blockLayout(map, block);
  if (!layout) return null;
  for (const [node, entry] of layout.nodes) {
    if (offset >= entry.src0 && offset <= entry.src1) {
      return { node, offset: Math.min(node.data.length, offset - entry.src0) };
    }
  }
  return null;
}

/** A DOM Range covering a source range, or null when nothing maps. */
export function rangeForSource(map: WordMap, from: number, to: number): Range | null {
  const start = pointForSource(map, Math.min(from, to));
  if (!start) return null;
  const endPoint = to > from ? endPointForSource(map, to) : null;
  const range = document.createRange();
  range.setStart(start.node, start.offset);
  if (endPoint) {
    range.setEnd(endPoint.node, endPoint.offset);
  } else {
    range.setEnd(start.node, start.offset);
  }
  return range;
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

interface WordSegment {
  index: number;
  segment: string;
  isWordLike: boolean;
}

type SegmenterLike = { segment(input: string): Iterable<WordSegment> };

let segmenter: SegmenterLike | null = null;

/** `Intl.Segmenter` when the webview has it; word boundaries fall back to spans. */
function wordSegmenter(): SegmenterLike | null {
  const IntlAny = Intl as unknown as { Segmenter?: new (locale?: string, options?: { granularity: string }) => SegmenterLike };
  if (!IntlAny.Segmenter) return null;
  segmenter ??= new IntlAny.Segmenter(undefined, { granularity: "word" });
  return segmenter;
}

function lineBounds(source: string, offset: number): { start: number; end: number } {
  let start = 0;
  for (let i = Math.min(offset, source.length) - 1; i >= 0; i -= 1) {
    if (source.charCodeAt(i) === 10) {
      start = i + 1;
      break;
    }
  }
  let end = source.length;
  for (let i = Math.max(offset, 0); i < source.length; i += 1) {
    if (source.charCodeAt(i) === 10) {
      end = i;
      break;
    }
  }
  return { start, end };
}

/** The word containing a source offset, or null when the offset is not in one. */
export function wordAt(source: string, offset: number): { from: number; to: number } | null {
  if (offset < 0 || offset > source.length) return null;
  const line = lineBounds(source, offset);
  const slice = source.slice(line.start, line.end);
  const local = offset - line.start;

  const splitter = wordSegmenter();
  if (splitter) {
    for (const part of splitter.segment(slice)) {
      const end = part.index + part.segment.length;
      if (part.index <= local && local < end) {
        return part.isWordLike ? { from: line.start + part.index, to: line.start + end } : null;
      }
      if (part.index > local) break;
    }
    return null;
  }

  // Fallback: the run of letters around the offset. Accented letters are word
  // characters in Unicode, ASCII `\w` is not enough.
  let from = local;
  let to = local;
  const isWord = (ch: string) => /[\p{L}\p{N}_]/u.test(ch);
  while (from > 0 && isWord(slice[from - 1])) from -= 1;
  while (to < slice.length && isWord(slice[to])) to += 1;
  return to > from ? { from: line.start + from, to: line.start + to } : null;
}

/**
 * Find the source range of selected preview text.
 *
 * Pages has no per-fragment map; its PDF text layer only says which text the
 * reader selected. This looks for that text as whole words, preferring the
 * occurrence nearest the caret. It returns null rather than guessing when the
 * text is absent, so generated content (`#lorem`, a `#let` value) paints
 * nothing instead of marking the wrong occurrence.
 */
export function findWordInSource(
  source: string,
  text: string,
  hint: number,
): { from: number; to: number } | null {
  const needle = text.replace(/\s+/g, " ").trim();
  if (!needle || needle.length > 120 || /[\r\n]/.test(needle)) return null;

  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let expression: RegExp;
  try {
    // A captured boundary rather than a lookbehind: WebKitGTK builds older than
    // Safari 16.4 do not implement lookbehind, and this search must not fail on
    // a platform the application otherwise supports.
    expression = new RegExp(
      `(^|[^\\p{L}\\p{N}_])(${escaped})(?![\\p{L}\\p{N}_])`,
      "giu",
    );
  } catch {
    return null;
  }

  let best: { from: number; to: number; distance: number } | null = null;
  for (const match of source.matchAll(expression)) {
    const prefix = match[1] ?? "";
    const from = (match.index ?? 0) + prefix.length;
    const to = from + (match[2]?.length ?? 0);
    if (to <= from) continue;
    const distance = Math.abs(from - Math.max(0, Math.min(hint, source.length)));
    if (!best || distance < best.distance) best = { from, to, distance };
  }
  return best ? { from: best.from, to: best.to } : null;
}

/**
 * Widen a source range to whole words.
 *
 * A preview selection can start mid-word — a double-click never does, a drag
 * can — and a browser word selection often swallows the trailing space. Both
 * ends are walked inwards until they land on a word, so `efetivos ` becomes
 * `efetivos` and `iona a l` becomes `sanciona a lei`.
 */
export function snapToWords(
  source: string,
  from: number,
  to: number,
): { from: number; to: number } | null {
  if (from === to) return wordAt(source, from);

  let start = Math.max(0, from);
  let first = wordAt(source, start);
  while (!first && start < to - 1) {
    start += 1;
    first = wordAt(source, start);
  }

  let end = Math.max(start, to - 1);
  let last = wordAt(source, end);
  while (!last && end > start) {
    end -= 1;
    last = wordAt(source, end);
  }

  if (!first || !last) return null;
  return { from: first.from, to: last.to };
}
