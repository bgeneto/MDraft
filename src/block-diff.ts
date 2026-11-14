/**
 * Deterministic keyed block diffing for incremental Markdown and AsciiDoc previews.
 * Kept DOM-free so Node unit harnesses and preview workers can execute it directly.
 */

export interface DiffableBlock {
  key: string;
  digest: string;
  lineStart: number;
  lineEnd?: number;
}

export type BlockPatchOp<T extends DiffableBlock = DiffableBlock> =
  | { kind: "retain"; prevIndex: number; nextIndex: number; lineDelta: number; block: T }
  | { kind: "replace"; prevIndex: number; nextIndex: number; block: T }
  | { kind: "insert"; nextIndex: number; block: T }
  | { kind: "remove"; prevIndex: number };

export interface BlockDiffResult<T extends DiffableBlock = DiffableBlock> {
  incremental: boolean;
  reason?: "empty" | "high-dirty-ratio";
  dirtyRatio: number;
  dirtyBlocks: number;
  totalBlocks: number;
  ops: BlockPatchOp<T>[];
}

export const DEFAULT_MAX_DIRTY_RATIO = 0.35;

/**
 * Dual-lane 32-bit FNV-1a digest plus length suffix. Combining two seeds reduces
 * collision risk across thousands of prose blocks without cryptographic overhead.
 */
export function fnv1aHash(text: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b1;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= c + (i & 0xff);
    h2 = Math.imul(h2, 0x85ebca6b);
  }
  return `${(h1 >>> 0).toString(36)}-${(h2 >>> 0).toString(36)}-${text.length.toString(36)}`;
}

function blocksEqual(a: DiffableBlock, b: DiffableBlock): boolean {
  return a.key === b.key && a.digest === b.digest;
}

function emitMiddleOps<T extends DiffableBlock>(
  prev: readonly T[],
  next: readonly T[],
  prevStart: number,
  prevEnd: number,
  nextStart: number,
  nextEnd: number,
): { ops: BlockPatchOp<T>[]; dirtyBlocks: number } {
  const prevLen = prevEnd - prevStart;
  const nextLen = nextEnd - nextStart;

  if (prevLen === 0 && nextLen === 0) {
    return { ops: [], dirtyBlocks: 0 };
  }

  // Common single-edit fast paths before building anchor maps.
  if (prevLen === nextLen) {
    const ops: BlockPatchOp<T>[] = [];
    let dirtyBlocks = 0;
    for (let offset = 0; offset < prevLen; offset += 1) {
      const pi = prevStart + offset;
      const ni = nextStart + offset;
      if (blocksEqual(prev[pi], next[ni])) {
        ops.push({
          kind: "retain",
          prevIndex: pi,
          nextIndex: ni,
          lineDelta: next[ni].lineStart - prev[pi].lineStart,
          block: next[ni],
        });
      } else {
        dirtyBlocks += 1;
        ops.push({ kind: "replace", prevIndex: pi, nextIndex: ni, block: next[ni] });
      }
    }
    return { ops, dirtyBlocks };
  }

  // Pair unique matching (key, digest) anchors inside the middle slice monotonically
  // so pasted sections or deleted headings keep unchanged blocks in between.
  const prevPositions = new Map<string, number[]>();
  for (let pi = prevStart; pi < prevEnd; pi += 1) {
    const sig = `${prev[pi].key}\0${prev[pi].digest}`;
    const list = prevPositions.get(sig);
    if (list) list.push(pi);
    else prevPositions.set(sig, [pi]);
  }

  const anchors: Array<{ pi: number; ni: number }> = [];
  let minPrev = prevStart;
  for (let ni = nextStart; ni < nextEnd; ni += 1) {
    const sig = `${next[ni].key}\0${next[ni].digest}`;
    const candidates = prevPositions.get(sig);
    if (!candidates) continue;
    const match = candidates.find((pi) => pi >= minPrev);
    if (match === undefined) continue;
    anchors.push({ pi: match, ni });
    minPrev = match + 1;
  }

  const ops: BlockPatchOp<T>[] = [];
  let dirtyBlocks = 0;

  const pushGap = (pFrom: number, pTo: number, nFrom: number, nTo: number): void => {
    const pCount = pTo - pFrom;
    const nCount = nTo - nFrom;
    const paired = Math.min(pCount, nCount);
    for (let k = 0; k < paired; k += 1) {
      dirtyBlocks += 1;
      ops.push({
        kind: "replace",
        prevIndex: pFrom + k,
        nextIndex: nFrom + k,
        block: next[nFrom + k],
      });
    }
    for (let k = paired; k < pCount; k += 1) {
      dirtyBlocks += 1;
      ops.push({ kind: "remove", prevIndex: pFrom + k });
    }
    for (let k = paired; k < nCount; k += 1) {
      dirtyBlocks += 1;
      ops.push({ kind: "insert", nextIndex: nFrom + k, block: next[nFrom + k] });
    }
  };

  let curPrev = prevStart;
  let curNext = nextStart;
  for (const anchor of anchors) {
    pushGap(curPrev, anchor.pi, curNext, anchor.ni);
    ops.push({
      kind: "retain",
      prevIndex: anchor.pi,
      nextIndex: anchor.ni,
      lineDelta: next[anchor.ni].lineStart - prev[anchor.pi].lineStart,
      block: next[anchor.ni],
    });
    curPrev = anchor.pi + 1;
    curNext = anchor.ni + 1;
  }
  pushGap(curPrev, prevEnd, curNext, nextEnd);

  return { ops, dirtyBlocks };
}

/**
 * Computes an ordered patch script from `prev` to `next`.
 * Falls back to full rebuild (`incremental: false`) when the document is empty
 * or more than `maxDirtyRatio` of target blocks changed.
 */
export function diffBlocks<T extends DiffableBlock>(
  prev: readonly T[],
  next: readonly T[],
  maxDirtyRatio = DEFAULT_MAX_DIRTY_RATIO,
): BlockDiffResult<T> {
  if (prev.length === 0 || next.length === 0) {
    return {
      incremental: false,
      reason: "empty",
      dirtyRatio: 1,
      dirtyBlocks: Math.max(prev.length, next.length),
      totalBlocks: next.length,
      ops: [],
    };
  }

  let prefix = 0;
  const minLen = Math.min(prev.length, next.length);
  while (prefix < minLen && blocksEqual(prev[prefix], next[prefix])) {
    prefix += 1;
  }

  let prevEnd = prev.length;
  let nextEnd = next.length;
  while (
    prevEnd > prefix &&
    nextEnd > prefix &&
    blocksEqual(prev[prevEnd - 1], next[nextEnd - 1])
  ) {
    prevEnd -= 1;
    nextEnd -= 1;
  }

  const middle = emitMiddleOps(prev, next, prefix, prevEnd, prefix, nextEnd);
  const totalBlocks = Math.max(1, next.length);
  const dirtyRatio = middle.dirtyBlocks / totalBlocks;
  if (dirtyRatio > maxDirtyRatio) {
    return {
      incremental: false,
      reason: "high-dirty-ratio",
      dirtyRatio,
      dirtyBlocks: middle.dirtyBlocks,
      totalBlocks: next.length,
      ops: [],
    };
  }

  const ops: BlockPatchOp<T>[] = [];
  for (let i = 0; i < prefix; i += 1) {
    ops.push({
      kind: "retain",
      prevIndex: i,
      nextIndex: i,
      lineDelta: next[i].lineStart - prev[i].lineStart,
      block: next[i],
    });
  }
  for (const op of middle.ops) {
    ops.push(op);
  }
  const suffixCount = next.length - nextEnd;
  for (let offset = 0; offset < suffixCount; offset += 1) {
    const pi = prevEnd + offset;
    const ni = nextEnd + offset;
    ops.push({
      kind: "retain",
      prevIndex: pi,
      nextIndex: ni,
      lineDelta: next[ni].lineStart - prev[pi].lineStart,
      block: next[ni],
    });
  }

  return {
    incremental: true,
    dirtyRatio,
    dirtyBlocks: middle.dirtyBlocks,
    totalBlocks: next.length,
    ops,
  };
}
