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

interface BlockNodeEntry {
  node: Text;
  folded: FoldedText;
  spans: BlockNodeSpan[];
}

export interface FoldedText {
  plain: string;
  at: number[];
  rawLength: number;
}

export interface BlockNodeSpan {
  /** Raw start offset in the text node (inclusive). */
  dom0: number;
  /** Raw end offset in the text node (exclusive). */
  dom1: number;
  /** Folded start index in `nodeFolded.plain`. */
  nodeFolded0: number;
  /** Folded end index in `nodeFolded.plain` (exclusive). */
  nodeFolded1: number;
  /** Folded start index in `blockFolded.plain`. */
  blockFolded0: number;
  /** Folded end index in `blockFolded.plain` (exclusive). */
  blockFolded1: number;
  /** Raw start offset in `map.source` (inclusive). */
  src0: number;
  /** Raw end offset in `map.source` (exclusive). */
  src1: number;
}

export interface AlignedNode {
  text: string;
  folded: FoldedText;
  spans: BlockNodeSpan[];
}

export interface AlignedBlock {
  src0: number;
  rawLength: number;
  folded: FoldedText;
  nodes: AlignedNode[];
}

/**
 * A block's text located against its source, in document order.
 *
 * `folded` is the whitespace-collapsed and quote-normalized block source, with
 * the raw index of every folded character. Each DOM `Text` node maps to one or
 * more `BlockNodeSpan`s (one for a whole-node match, several when an internal
 * substitution or typographic replacement split the node into word runs).
 */
interface BlockLayout {
  folded: FoldedText;
  nodes: Map<Text, BlockNodeEntry>;
  ordered: BlockNodeEntry[];
  src0: number;
}

export interface WordMap {
  readonly source: string;
  readonly fragments: readonly Fragment[];
  readonly blocks: readonly BlockRange[];
  readonly text: WeakMap<Text, BoundText>;
  readonly fragNodes: Text[][];
  readonly blockNodes: Text[][];
  readonly blockAllNodes: Text[][];
  readonly blockLayouts: (BlockLayout | null | undefined)[];
}

// ---------------------------------------------------------------------------
// Binding
// ---------------------------------------------------------------------------

/**
 * Subtrees inside an anchored block whose DOM text is generated or non-prose
 * (rendered formulas, footnote markers, admonition icon cells). Their text
 * nodes still record their owning `block` index for the block fallback, but
 * they are excluded from `blockLayout` so they never desynchronize the prose
 * cursor.
 */
const NON_PROSE_SELECTOR =
  'math, .math-inline, .math-display, .katex, [data-stem], sup[role="doc-noteref"], sup[role="doc-backlink"], .admonitionblock td.icon';

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
    blockAllNodes: blocks.map(() => []),
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
      // A descendant with its own `[data-b]` owns its subtree; keep each text
      // node attached only to its innermost block.
      if (node.parentElement?.closest("[data-b]") !== element) return;
      map.blockAllNodes[index].push(node);
      const record = map.text.get(node) ?? { fragment: -1, fragStart: 0, block: -1, blockStart: 0 };
      record.block = index;
      record.blockStart = start;
      map.text.set(node, record);
      const nonProse = node.parentElement?.closest(NON_PROSE_SELECTOR);
      if (nonProse && element.contains(nonProse)) return;
      map.blockNodes[index].push(node);
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
const WORD_RE = /[\p{L}\p{N}_]+(?:['\u00ad][\p{L}\p{N}_]+)*/gu;
const WORD_LOOKAHEAD = 24;

function normalizeFoldChar(ch: string): string {
  if (ch === "\u2018" || ch === "\u2019" || ch === "\u02bc") return "'";
  if (ch === "\u201c" || ch === "\u201d") return '"';
  return ch;
}

/**
 * Collapse whitespace runs and normalize 1-to-1 typographic quotes, keeping the
 * raw index where every folded character began.
 */
export function foldWhitespace(text: string): FoldedText {
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
    plain += normalizeFoldChar(text[i]);
    i += 1;
  }
  return { plain, at, rawLength: text.length };
}

function foldedCharRawEnd(folded: FoldedText, k: number): number {
  if (k < 0) return 0;
  if (k >= folded.plain.length) return folded.rawLength;
  if (folded.plain[k] === " ") {
    return k + 1 < folded.at.length ? folded.at[k + 1] : folded.rawLength;
  }
  return folded.at[k] + 1;
}

function largestAtOrBefore(
  at: readonly number[],
  low: number,
  high: number,
  target: number,
): number {
  let lo = low;
  let hi = high - 1;
  let best = low;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (at[mid] <= target) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

function mapFoldedIndex(
  index: number,
  from0: number,
  from1: number,
  to0: number,
  to1: number,
): number {
  const rel = Math.max(0, index - from0);
  const fromLen = Math.max(1, from1 - from0);
  const toLen = Math.max(1, to1 - to0);
  if (fromLen === toLen) {
    return Math.min(to1 - 1, to0 + rel);
  }
  const scaled = Math.floor((rel * toLen) / fromLen);
  return Math.min(to1 - 1, to0 + scaled);
}

function makeSpan(
  nodeFolded: FoldedText,
  blockFolded: FoldedText,
  blockSrc0: number,
  nodeFolded0: number,
  nodeFolded1: number,
  blockFolded0: number,
  blockFolded1: number,
): BlockNodeSpan {
  return {
    dom0: nodeFolded.at[nodeFolded0] ?? 0,
    dom1: foldedCharRawEnd(nodeFolded, nodeFolded1 - 1),
    nodeFolded0,
    nodeFolded1,
    blockFolded0,
    blockFolded1,
    src0: blockSrc0 + (blockFolded.at[blockFolded0] ?? 0),
    src1: blockSrc0 + foldedCharRawEnd(blockFolded, blockFolded1 - 1),
  };
}

/**
 * Translate a raw character offset in a DOM `Text` node to its raw source
 * offset, routing through both whitespace-folded offset tables.
 */
export function rawNodeOffsetToSource(
  nodeFolded: FoldedText,
  blockFolded: FoldedText,
  rawOffset: number,
  bias: "start" | "end" = "start",
  span?: BlockNodeSpan,
  blockSrc0 = 0,
): number {
  const activeSpan: BlockNodeSpan = span ?? {
    dom0: 0,
    dom1: nodeFolded.rawLength,
    nodeFolded0: 0,
    nodeFolded1: nodeFolded.plain.length,
    blockFolded0: 0,
    blockFolded1: blockFolded.plain.length,
    src0: blockSrc0,
    src1: blockSrc0 + blockFolded.rawLength,
  };
  if (
    activeSpan.nodeFolded1 <= activeSpan.nodeFolded0 ||
    activeSpan.blockFolded1 <= activeSpan.blockFolded0
  ) {
    return activeSpan.src0;
  }
  if (bias === "start") {
    if (rawOffset <= activeSpan.dom0) return activeSpan.src0;
    if (rawOffset >= activeSpan.dom1) return activeSpan.src1;
    let nIndex = largestAtOrBefore(
      nodeFolded.at,
      activeSpan.nodeFolded0,
      activeSpan.nodeFolded1,
      rawOffset,
    );
    if (
      nodeFolded.plain[nIndex] === " " &&
      nIndex + 1 < activeSpan.nodeFolded1
    ) {
      nIndex += 1;
    }
    const bIndex = mapFoldedIndex(
      nIndex,
      activeSpan.nodeFolded0,
      activeSpan.nodeFolded1,
      activeSpan.blockFolded0,
      activeSpan.blockFolded1,
    );
    return blockSrc0 + blockFolded.at[bIndex];
  }

  if (rawOffset <= activeSpan.dom0) return activeSpan.src0;
  if (rawOffset >= activeSpan.dom1) return activeSpan.src1;
  const lastChar = Math.max(activeSpan.dom0, rawOffset - 1);
  let nIndex = largestAtOrBefore(
    nodeFolded.at,
    activeSpan.nodeFolded0,
    activeSpan.nodeFolded1,
    lastChar,
  );
  if (
    nodeFolded.plain[nIndex] === " " &&
    nIndex > activeSpan.nodeFolded0
  ) {
    nIndex -= 1;
  }
  const bIndex = mapFoldedIndex(
    nIndex,
    activeSpan.nodeFolded0,
    activeSpan.nodeFolded1,
    activeSpan.blockFolded0,
    activeSpan.blockFolded1,
  );
  return blockSrc0 + foldedCharRawEnd(blockFolded, bIndex);
}

/**
 * Inverse of `rawNodeOffsetToSource`: translate a raw source offset back to a
 * raw character offset inside the DOM `Text` node.
 */
export function sourceOffsetToRawNode(
  nodeFolded: FoldedText,
  blockFolded: FoldedText,
  sourceOffset: number,
  bias: "start" | "end" = "start",
  span?: BlockNodeSpan,
  blockSrc0 = 0,
): number {
  const activeSpan: BlockNodeSpan = span ?? {
    dom0: 0,
    dom1: nodeFolded.rawLength,
    nodeFolded0: 0,
    nodeFolded1: nodeFolded.plain.length,
    blockFolded0: 0,
    blockFolded1: blockFolded.plain.length,
    src0: blockSrc0,
    src1: blockSrc0 + blockFolded.rawLength,
  };
  if (
    activeSpan.nodeFolded1 <= activeSpan.nodeFolded0 ||
    activeSpan.blockFolded1 <= activeSpan.blockFolded0
  ) {
    return activeSpan.dom0;
  }
  if (bias === "start") {
    if (sourceOffset <= activeSpan.src0) return activeSpan.dom0;
    if (sourceOffset >= activeSpan.src1) return activeSpan.dom1;
    const local = sourceOffset - blockSrc0;
    let bIndex = largestAtOrBefore(
      blockFolded.at,
      activeSpan.blockFolded0,
      activeSpan.blockFolded1,
      local,
    );
    if (
      blockFolded.plain[bIndex] === " " &&
      bIndex + 1 < activeSpan.blockFolded1
    ) {
      bIndex += 1;
    }
    const nIndex = mapFoldedIndex(
      bIndex,
      activeSpan.blockFolded0,
      activeSpan.blockFolded1,
      activeSpan.nodeFolded0,
      activeSpan.nodeFolded1,
    );
    return nodeFolded.at[nIndex];
  }

  if (sourceOffset <= activeSpan.src0) return activeSpan.dom0;
  if (sourceOffset >= activeSpan.src1) return activeSpan.dom1;
  const localLast = Math.max(
    activeSpan.src0 - blockSrc0,
    sourceOffset - 1 - blockSrc0,
  );
  let bIndex = largestAtOrBefore(
    blockFolded.at,
    activeSpan.blockFolded0,
    activeSpan.blockFolded1,
    localLast,
  );
  if (
    blockFolded.plain[bIndex] === " " &&
    bIndex > activeSpan.blockFolded0
  ) {
    bIndex -= 1;
  }
  const nIndex = mapFoldedIndex(
    bIndex,
    activeSpan.blockFolded0,
    activeSpan.blockFolded1,
    activeSpan.nodeFolded0,
    activeSpan.nodeFolded1,
  );
  return foldedCharRawEnd(nodeFolded, nIndex);
}

interface FoldedWordToken {
  f0: number;
  f1: number;
  norm: string;
}

function tokenizeFoldedWords(plain: string, startOffset = 0): FoldedWordToken[] {
  const tokens: FoldedWordToken[] = [];
  WORD_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = WORD_RE.exec(plain)) !== null) {
    const f0 = startOffset + match.index;
    const f1 = f0 + match[0].length;
    tokens.push({
      f0,
      f1,
      norm: match[0].replace(/\u00ad/g, ""),
    });
  }
  return tokens;
}

/**
 * Align a single node's words in order against the remaining block source words
 * when whole-node `indexOf` failed (e.g. because of `{attribute}` substitution,
 * `--` -> `—`, `...` -> `…`, numbered headings, or stripped `#func(...)` calls).
 */
function alignNodeWords(
  nodeFolded: FoldedText,
  blockFolded: FoldedText,
  blockSrc0: number,
  cursor: number,
): { spans: BlockNodeSpan[]; nextCursor: number } {
  const nodeWords = tokenizeFoldedWords(nodeFolded.plain, 0);
  const sourceWords = tokenizeFoldedWords(
    blockFolded.plain.slice(cursor),
    cursor,
  );
  if (nodeWords.length === 0 || sourceWords.length === 0) {
    return { spans: [], nextCursor: cursor };
  }

  const runLength = (wIdx: number, sIdx: number): number => {
    let k = 0;
    while (
      wIdx + k < nodeWords.length &&
      sIdx + k < sourceWords.length &&
      nodeWords[wIdx + k].norm === sourceWords[sIdx + k].norm
    ) {
      k += 1;
    }
    return k;
  };

  const spans: BlockNodeSpan[] = [];
  let sCursor = 0;
  let nextCursor = cursor;

  for (let w = 0; w < nodeWords.length; w += 1) {
    const word = nodeWords[w];
    const windowEnd = Math.min(sourceWords.length, sCursor + WORD_LOOKAHEAD);
    let bestCand = -1;
    let bestRun = 0;
    let matchesInWindow = 0;

    for (let s = sCursor; s < windowEnd; s += 1) {
      if (sourceWords[s].norm !== word.norm) continue;
      matchesInWindow += 1;
      const run = runLength(w, s);
      if (run > bestRun) {
        bestRun = run;
        bestCand = s;
      }
    }
    if (bestCand < 0) continue;

    if (bestCand > sCursor) {
      // Guard 1: never jump past a closer source word that matches the next DOM
      // word with an equal or longer consecutive run (prevents a substituted
      // word from jumping to a later repeated occurrence over the real text).
      if (w + 1 < nodeWords.length) {
        const nextWord = nodeWords[w + 1];
        let bypassedCloserNext = false;
        for (let alt = sCursor; alt < bestCand; alt += 1) {
          if (
            sourceWords[alt].norm === nextWord.norm &&
            runLength(w + 1, alt) >= bestRun
          ) {
            bypassedCloserNext = true;
            break;
          }
        }
        if (bypassedCloserNext) continue;
      }
      // Guard 2: a single-word jump over skipped source tokens requires a word
      // of at least 3 characters that is unique in the lookahead window.
      if (bestRun === 1 && (word.norm.length < 3 || matchesInWindow > 1)) {
        continue;
      }
    }

    const srcWord = sourceWords[bestCand];
    const prev = spans[spans.length - 1];
    if (
      prev &&
      prev.nodeFolded1 <= word.f0 &&
      prev.blockFolded1 <= srcWord.f0 &&
      word.f1 - word.f0 === srcWord.f1 - srcWord.f0 &&
      nodeFolded.plain.slice(prev.nodeFolded1, word.f0) ===
        blockFolded.plain.slice(prev.blockFolded1, srcWord.f0)
    ) {
      prev.nodeFolded1 = word.f1;
      prev.blockFolded1 = srcWord.f1;
      prev.dom1 = foldedCharRawEnd(nodeFolded, word.f1 - 1);
      prev.src1 = blockSrc0 + foldedCharRawEnd(blockFolded, srcWord.f1 - 1);
    } else {
      spans.push(
        makeSpan(
          nodeFolded,
          blockFolded,
          blockSrc0,
          word.f0,
          word.f1,
          srcWord.f0,
          srcWord.f1,
        ),
      );
    }

    sCursor = bestCand + 1;
    nextCursor = srcWord.f1;
  }

  return { spans, nextCursor };
}

/**
 * Align a block's text nodes against its raw source slice using the two-tier
 * strategy: whole-node folded match first, per-node word-run alignment second,
 * without aborting the remaining nodes in the block.
 */
export function alignBlockNodes(
  blockRaw: string,
  blockSrc0: number,
  nodeTexts: readonly string[],
): AlignedBlock {
  const blockFolded = foldWhitespace(blockRaw);
  const alignedNodes: AlignedNode[] = [];
  let cursor = 0;

  for (const text of nodeTexts) {
    const nodeFolded = foldWhitespace(text);
    let nf0 = 0;
    while (nf0 < nodeFolded.plain.length && nodeFolded.plain[nf0] === " ") {
      nf0 += 1;
    }
    let nf1 = nodeFolded.plain.length;
    while (nf1 > nf0 && nodeFolded.plain[nf1 - 1] === " ") {
      nf1 -= 1;
    }
    if (nf0 >= nf1) {
      alignedNodes.push({ text, folded: nodeFolded, spans: [] });
      continue;
    }

    const needle = nodeFolded.plain.slice(nf0, nf1);
    const found = blockFolded.plain.indexOf(needle, cursor);
    if (found >= 0 && (needle.length >= 4 || found - cursor <= 48)) {
      const bf0 = found;
      const bf1 = found + needle.length;
      const span = makeSpan(
        nodeFolded,
        blockFolded,
        blockSrc0,
        nf0,
        nf1,
        bf0,
        bf1,
      );
      alignedNodes.push({ text, folded: nodeFolded, spans: [span] });
      cursor = bf1;
      continue;
    }

    const { spans, nextCursor } = alignNodeWords(
      nodeFolded,
      blockFolded,
      blockSrc0,
      cursor,
    );
    alignedNodes.push({ text, folded: nodeFolded, spans });
    cursor = nextCursor;
  }

  return {
    src0: blockSrc0,
    rawLength: blockRaw.length,
    folded: blockFolded,
    nodes: alignedNodes,
  };
}

/**
 * Map a selection `[start, end)` inside one aligned node to its source range,
 * or null when the selection overlaps no mapped span in that node.
 */
export function alignedNodeSourceRange(
  block: AlignedBlock,
  nodeIndex: number,
  start: number,
  end: number,
): { from: number; to: number } | null {
  const entry = block.nodes[nodeIndex];
  if (!entry || entry.spans.length === 0) return null;
  return spansSourceRange(entry.folded, entry.spans, block.folded, block.src0, start, end);
}

function spansSourceRange(
  nodeFolded: FoldedText,
  spans: readonly BlockNodeSpan[],
  blockFolded: FoldedText,
  blockSrc0: number,
  start: number,
  end: number,
): { from: number; to: number } | null {
  if (spans.length === 0) return null;
  const lo = Math.min(start, end);
  const hi = Math.max(start, end);
  if (lo === hi) {
    const hit = spans.find((span) => span.dom0 <= lo && lo <= span.dom1);
    if (!hit) return null;
    const at = rawNodeOffsetToSource(
      nodeFolded,
      blockFolded,
      lo,
      "start",
      hit,
      blockSrc0,
    );
    return { from: at, to: at };
  }

  let first: BlockNodeSpan | null = null;
  let last: BlockNodeSpan | null = null;
  for (const span of spans) {
    if (span.dom1 <= lo || span.dom0 >= hi) continue;
    if (!first) first = span;
    last = span;
  }
  if (!first || !last) return null;

  const from = rawNodeOffsetToSource(
    nodeFolded,
    blockFolded,
    Math.max(lo, first.dom0),
    "start",
    first,
    blockSrc0,
  );
  const to = rawNodeOffsetToSource(
    nodeFolded,
    blockFolded,
    Math.min(hi, last.dom1),
    "end",
    last,
    blockSrc0,
  );
  return { from, to: Math.max(from, to) };
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
  const aligned = alignBlockNodes(
    raw,
    block.src0,
    nodes.map((node) => node.data),
  );
  const byNode = new Map<Text, BlockNodeEntry>();
  const ordered: BlockNodeEntry[] = [];
  for (let i = 0; i < nodes.length; i += 1) {
    const item = aligned.nodes[i];
    const entry: BlockNodeEntry = {
      node: nodes[i],
      folded: item.folded,
      spans: item.spans,
    };
    byNode.set(nodes[i], entry);
    ordered.push(entry);
  }

  const layout: BlockLayout = {
    folded: aligned.folded,
    nodes: byNode,
    ordered,
    src0: block.src0,
  };
  map.blockLayouts[index] = layout;
  return layout;
}

/**
 * Candidate blocks covering `[from, to]`, ordered from narrowest/deepest to
 * outermost.
 */
function blocksForRange(map: WordMap, from: number, to: number): number[] {
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  const matches: number[] = [];
  for (let i = 0; i < map.blocks.length; i += 1) {
    const b = map.blocks[i];
    if (lo === hi ? b.src0 <= lo && lo <= b.src1 : b.src1 > lo && b.src0 < hi) {
      matches.push(i);
    }
  }
  matches.sort((a, b) => {
    const lenA = map.blocks[a].src1 - map.blocks[a].src0;
    const lenB = map.blocks[b].src1 - map.blocks[b].src0;
    if (lenA !== lenB) return lenA - lenB;
    return b - a;
  });
  return matches;
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
  if (!entry || entry.spans.length === 0) return null;
  return spansSourceRange(
    entry.folded,
    entry.spans,
    layout.folded,
    layout.src0,
    start,
    end,
  );
}

/**
 * Containing block's source range for a DOM node, or null when the node is not
 * inside an anchored `[data-b]` block.
 */
export function blockRangeForNode(map: WordMap, node: Node): BlockRange | null {
  if (node.nodeType === Node.TEXT_NODE) {
    const record = map.text.get(node as Text);
    if (record && record.block >= 0) {
      return map.blocks[record.block] ?? null;
    }
  }
  const element =
    node.nodeType === Node.ELEMENT_NODE
      ? (node as HTMLElement)
      : node.parentElement;
  const host = element?.closest<HTMLElement>("[data-b]");
  if (!host) return null;
  const index = Number(host.dataset.b);
  if (!Number.isInteger(index) || index < 0 || index >= map.blocks.length) {
    return null;
  }
  return map.blocks[index] ?? null;
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
    return pointForSource(map, offset - 1, "end");
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

  const candidates = blocksForRange(map, offset, offset);
  // First pass: exact span containing `offset`.
  for (const blockIndex of candidates) {
    const layout = blockLayout(map, blockIndex);
    if (!layout) continue;
    for (const entry of layout.ordered) {
      for (const span of entry.spans) {
        if (offset >= span.src0 && offset <= span.src1) {
          return {
            node: entry.node,
            offset: sourceOffsetToRawNode(
              entry.folded,
              layout.folded,
              offset,
              bias,
              span,
              layout.src0,
            ),
          };
        }
      }
    }
  }

  // Second pass: gap fallback inside an anchored block when `offset` sits on
  // inline markup or an unmapped token.
  for (const blockIndex of candidates) {
    const layout = blockLayout(map, blockIndex);
    if (layout) {
      if (bias === "start") {
        for (const entry of layout.ordered) {
          for (const span of entry.spans) {
            if (span.src0 >= offset) {
              return { node: entry.node, offset: span.dom0 };
            }
          }
        }
      } else {
        let lastMatch: { node: Text; offset: number } | null = null;
        for (const entry of layout.ordered) {
          for (const span of entry.spans) {
            if (span.src1 <= offset) {
              lastMatch = { node: entry.node, offset: span.dom1 };
            }
          }
        }
        if (lastMatch) return lastMatch;
      }
    }
    const fallbackNodes =
      map.blockNodes[blockIndex]?.length > 0
        ? map.blockNodes[blockIndex]
        : map.blockAllNodes[blockIndex];
    if (fallbackNodes && fallbackNodes.length > 0) {
      if (bias === "start") {
        return { node: fallbackNodes[0], offset: 0 };
      }
      const lastNode = fallbackNodes[fallbackNodes.length - 1];
      return { node: lastNode, offset: lastNode.data.length };
    }
  }

  return null;
}

/** A DOM Range covering a source range, or null when nothing maps. */
export function rangeForSource(map: WordMap, from: number, to: number): Range | null {
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);

  if (map.fragments.length === 0 && map.blocks.length > 0 && hi > lo) {
    const candidates = blocksForRange(map, lo, hi);
    for (const blockIndex of candidates) {
      const layout = blockLayout(map, blockIndex);
      if (!layout) continue;
      let firstHit: { entry: BlockNodeEntry; span: BlockNodeSpan } | null = null;
      let lastHit: { entry: BlockNodeEntry; span: BlockNodeSpan } | null = null;
      for (const entry of layout.ordered) {
        for (const span of entry.spans) {
          if (span.src1 <= lo || span.src0 >= hi) continue;
          if (!firstHit) firstHit = { entry, span };
          lastHit = { entry, span };
        }
      }
      if (firstHit && lastHit) {
        const startOffset = sourceOffsetToRawNode(
          firstHit.entry.folded,
          layout.folded,
          Math.max(lo, firstHit.span.src0),
          "start",
          firstHit.span,
          layout.src0,
        );
        const endOffset = sourceOffsetToRawNode(
          lastHit.entry.folded,
          layout.folded,
          Math.min(hi, lastHit.span.src1),
          "end",
          lastHit.span,
          layout.src0,
        );
        const range = document.createRange();
        range.setStart(firstHit.entry.node, startOffset);
        range.setEnd(lastHit.entry.node, endOffset);
        return range;
      }
    }

    // Block fallback when the source selection is entirely inside an unmapped
    // construct (such as an attribute placeholder or inline formula) inside an
    // anchored block.
    for (const blockIndex of candidates) {
      const fallbackNodes =
        map.blockNodes[blockIndex]?.length > 0
          ? map.blockNodes[blockIndex]
          : map.blockAllNodes[blockIndex];
      if (fallbackNodes && fallbackNodes.length > 0) {
        const firstNode = fallbackNodes[0];
        const lastNode = fallbackNodes[fallbackNodes.length - 1];
        const range = document.createRange();
        range.setStart(firstNode, 0);
        range.setEnd(lastNode, lastNode.data.length);
        return range;
      }
    }
  }

  const start = pointForSource(map, lo, "start");
  if (!start) return null;
  const endPoint = hi > lo ? endPointForSource(map, hi) : null;
  const range = document.createRange();
  range.setStart(start.node, start.offset);
  if (endPoint) {
    try {
      range.setEnd(endPoint.node, endPoint.offset);
      if (range.collapsed && hi > lo) {
        range.setStart(endPoint.node, 0);
        range.setEnd(start.node, start.node.data.length);
      }
    } catch {
      range.setEnd(start.node, start.offset);
    }
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
