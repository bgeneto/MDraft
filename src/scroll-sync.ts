//! Scroll policy in CSS pixels. Renderers own text identity and geometry.

export interface SourceAnchor {
  readonly from: number;
  readonly to: number;
}

/** One immutable, source-sorted index per render, never a text search on scroll. */
export class ScrollIndex<T extends SourceAnchor> {
  readonly anchors: readonly T[];
  constructor(anchors: readonly T[], alreadySorted = false) {
    // The map builder hands over an owned array whose order it verified while
    // traversing; other callers retain the defensive copy and sort.
    this.anchors = alreadySorted
      ? anchors
      : [...anchors].sort((a, b) => a.from - b.from || a.to - b.to);
  }

  near(offset: number, radius = 32, distance = 1800): readonly T[] {
    let lo = 0,
      hi = this.anchors.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.anchors[mid].from < offset) lo = mid + 1;
      else hi = mid;
    }
    return this.anchors
      .slice(Math.max(0, lo - radius), lo + radius)
      .filter((a) => a.from <= offset + distance && a.to >= offset - distance);
  }
}

export interface ScrollPair {
  /** Source offset is an identity/tie breaker, not a pixel measurement. */
  from: number;
  origin: number;
  target: number;
  region: string;
}

export function interpolate(
  value: number,
  from0: number,
  from1: number,
  to0: number,
  to1: number,
): number {
  if (from1 <= from0) return to0;
  const t = Math.max(0, Math.min(1, (value - from0) / (from1 - from0)));
  return to0 + t * (to1 - to0);
}

export function clampScroll(top: number, maximum: number): number {
  return Number.isFinite(top) ? Math.max(0, Math.min(Math.max(0, maximum), top)) : 0;
}

/** Preserve only an unchanged side of an edit; a replaced span has no identity. */
export function mapScrollOffset(before: string, after: string, offset: number): number | null {
  if (before === after) return offset;
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  if (offset < start) return offset;
  let end = 0;
  while (
    end < before.length - start &&
    end < after.length - start &&
    before[before.length - end - 1] === after[after.length - end - 1]
  )
    end++;
  return offset >= before.length - end ? offset + after.length - before.length : null;
}

/**
 * Corresponding screen Y at the origin's reference. Collapse a wrapped row to
 * its middle accepted word: different line widths cannot have a unique inverse.
 * Never draw a continuous slope through a column reset or a reversed layout.
 *
 * `targetReference` is the height the corresponding content must reach in the
 * other pane. It equals `reference` while the panes are level and differs after
 * a gesture that the other pane could not follow all the way (SyncReference).
 */
export function scrollCorrection(
  pairs: readonly ScrollPair[],
  reference: number,
  targetReference: number = reference,
): number | null {
  const sorted = pairs
    .filter((p) => Number.isFinite(p.origin) && Number.isFinite(p.target))
    .sort((a, b) => a.origin - b.origin || a.from - b.from);
  if (!sorted.length) return null;
  const rows: ScrollPair[] = [];
  for (let i = 0; i < sorted.length;) {
    let end = i + 1;
    while (
      end < sorted.length &&
      sorted[end].origin - sorted[i].origin < 0.75 &&
      sorted[end].region === sorted[i].region
    )
      end++;
    rows.push(sorted[i + Math.floor((end - i - 1) / 2)]);
    i = end;
  }
  let at = 0;
  for (let i = 1; i < rows.length; i++)
    if (Math.abs(rows[i].origin - reference) < Math.abs(rows[at].origin - reference)) at = i;
  const nearest = rows[at];
  if (Math.abs(nearest.origin - reference) > 160) return null;
  const left = nearest.origin <= reference ? nearest : rows[at - 1];
  const right = nearest.origin > reference ? nearest : rows[at + 1];
  if (
    left &&
    right &&
    left.region === right.region &&
    right.target >= left.target &&
    right.origin - left.origin < 160 &&
    Math.abs(right.from - left.from) < 1800
  ) {
    return (
      interpolate(reference, left.origin, right.origin, left.target, right.target) - targetReference
    );
  }
  return nearest.target - nearest.origin + reference - targetReference;
}

/** Vertical extent of one visual row or block, in screen pixels. */
export interface RowBox {
  top: number;
  bottom: number;
}

/**
 * Rows are compared by their centres: a 16 px source line and a 28 px heading
 * with equal tops look several pixels apart, equal centres look level.
 */
export function rowCentre(row: RowBox): number {
  return (row.top + row.bottom) / 2;
}

/** A measured pair that also knows where its source text ends. */
export interface GesturePair extends ScrollPair {
  to: number;
}

export interface GestureSolution {
  /** "word": the anchor containing the offset. "rows": its verified neighbours. */
  tier: "word" | "rows";
  /** How far below level the counterpart is; scroll its pane by this much. */
  delta: number;
}

/**
 * Where is the counterpart of this offset, relative to the height of the
 * gesture? `origin` and `target` are row centres. A containing anchor answers
 * for itself: scrolling asks which row is at a height, and may take a row's
 * middle word, but a click asks where one word is, and a wrapped paragraph puts
 * that word on a different row than the representative. Without one, the
 * neighbouring rows answer under the guards of scrollCorrection(). Null means
 * no verified text is in reach and the caller falls back to the block.
 */
export function solveGesture(
  pairs: readonly GesturePair[],
  offset: number,
  height: number,
): GestureSolution | null {
  let word: GesturePair | null = null;
  for (const pair of pairs) {
    if (pair.from > offset || pair.to < offset) continue;
    if (!Number.isFinite(pair.origin) || !Number.isFinite(pair.target)) continue;
    // The narrowest anchor is the most specific statement about this offset;
    // between equals, the one measured on the row that was actually clicked.
    if (
      !word ||
      pair.to - pair.from < word.to - word.from ||
      (pair.to - pair.from === word.to - word.from &&
        Math.abs(pair.origin - height) < Math.abs(word.origin - height))
    )
      word = pair;
  }
  if (word) return { tier: "word", delta: word.target - word.origin };
  const delta = scrollCorrection(pairs, height);
  return delta === null ? null : { tier: "rows", delta };
}

/** One point where a block boundary was measured in both panes. */
export interface BlockTop {
  origin: number;
  target: number;
}

/**
 * The block fallback at any height: piecewise linear between measured block
 * boundaries, so a position inside a block lands at the same fraction of its
 * rendered box. Outside the measured boundaries the nearest one translates
 * rigidly; no slope is invented beyond the evidence.
 */
export function blockCorrection(
  tops: readonly BlockTop[],
  reference: number,
  targetReference: number = reference,
): number | null {
  const sorted = tops
    .filter((t) => Number.isFinite(t.origin) && Number.isFinite(t.target))
    .sort((a, b) => a.origin - b.origin);
  if (!sorted.length) return null;
  let right = 0;
  while (right < sorted.length && sorted[right].origin <= reference) right++;
  const before = sorted[right - 1];
  const after = sorted[right];
  if (!before) return after.target - after.origin + reference - targetReference;
  if (!after || after.target < before.target)
    return before.target - before.origin + reference - targetReference;
  return (
    interpolate(reference, before.origin, after.origin, before.target, after.target) -
    targetReference
  );
}

/**
 * How much of a skew between the two reference heights one follow correction
 * may remove: a fraction of the distance the reader just scrolled, so levelling
 * is a function of their own motion and needs no timer or animation.
 */
export const LEVEL_FRACTION = 0.25;

/**
 * Signed change to the follower's reference height. `gap` is the leader's
 * height minus the follower's; `travelled` is the leader's scroll delta and
 * `natural` the follower's scroll delta before levelling. Raising the height by
 * `d` scrolls the follower `d` less, so the step is capped where it would turn
 * the follower against the direction the reader is scrolling.
 */
export function levelStep(
  gap: number,
  travelled: number,
  natural: number,
  fraction = LEVEL_FRACTION,
): number {
  if (!Number.isFinite(gap) || !Number.isFinite(travelled) || !gap || !travelled) return 0;
  let step = Math.sign(gap) * Math.min(Math.abs(gap), fraction * Math.abs(travelled));
  if (travelled > 0 && step > 0) step = Math.min(step, Math.max(0, natural));
  if (travelled < 0 && step < 0) step = Math.max(step, Math.min(0, natural));
  return step;
}

export interface ScrollRegion {
  key: string;
  top: number;
  bottom: number;
  left: number;
  right: number;
  column: number;
}

/** A vertical coordinate alone cannot distinguish two PDF columns. */
export function chooseScrollRegion(
  regions: readonly ScrollRegion[],
  top: number,
  bottom: number,
  previous: string | null,
  pointer?: { x: number; y: number } | null,
): string | null {
  const visible = regions.filter((r) => r.bottom >= top - 8 && r.top <= bottom);
  if (!visible.length) return null;
  if (pointer) {
    const pointed = visible.filter((r) => pointer.x >= r.left - 4 && pointer.x <= r.right + 4);
    if (pointed.length)
      return pointed.reduce((a, b) =>
        Math.abs(Math.max(a.top, Math.min(a.bottom, pointer.y)) - pointer.y) <=
        Math.abs(Math.max(b.top, Math.min(b.bottom, pointer.y)) - pointer.y)
          ? a
          : b,
      ).key;
  }
  const retained = visible.find((r) => r.key === previous);
  if (retained) return retained.key;
  const column = regions.find((r) => r.key === previous)?.column;
  const sameBranch = column === undefined ? [] : visible.filter((r) => r.column === column);
  const choices = sameBranch.length ? sameBranch : visible;
  return choices.reduce((a, b) => (Math.abs(a.top - top) <= Math.abs(b.top - top) ? a : b)).key;
}

export type SyncPane = "source" | "preview";

/**
 * The sync line as a pair of heights below the panes' common top: content at
 * `source` in the editor corresponds to content at `preview` in the preview. A
 * gesture calibrates the pair to where its two rows actually ended up, so the
 * invariant is true the moment the gesture finishes even when the other pane
 * hit the end of its scroll range, and the next wheel tick has nothing to undo.
 */
export class SyncReference {
  source: number;
  preview: number;
  readonly margin: number;
  constructor(margin: number) {
    this.margin = margin;
    this.source = margin;
    this.preview = margin;
  }
  /** Back to the default line: tab switch, view mode, Sync toggle, resize. */
  reset(): void {
    this.source = this.margin;
    this.preview = this.margin;
  }
  get skewed(): boolean {
    return Math.abs(this.source - this.preview) >= 0.5;
  }
  /**
   * Record where a gesture left its two rows. A height outside the pane cannot
   * be a reading reference: `extent` is the common visible height, and a row
   * that is not inside it keeps the pair at the default line.
   */
  calibrate(source: number, preview: number, extent: number): void {
    const inside = (y: number) => Number.isFinite(y) && y >= 0 && y <= extent;
    if (!inside(source) || !inside(preview)) return this.reset();
    this.source = source;
    this.preview = preview;
  }
  /** One follow correction's share of levelling; returns the follower's shift. */
  level(leader: SyncPane, travelled: number, natural: number): number {
    const follower: SyncPane = leader === "source" ? "preview" : "source";
    const step = levelStep(this[leader] - this[follower], travelled, natural);
    this[follower] += step;
    return step;
  }
}

/** Reflected events are suppressed; a real gesture can take ownership at once. */
export class ScrollOwnership {
  epoch = 0;
  private expected: { pane: SyncPane; top: number; until: number } | null = null;
  input(): void {
    this.epoch++;
    this.expected = null;
  }
  wrote(pane: SyncPane, top: number, now: number): void {
    this.expected = { pane, top, until: now + 150 };
  }
  reflected(pane: SyncPane, top: number, now: number): boolean {
    const e = this.expected;
    return !!e && e.pane === pane && now < e.until && Math.abs(e.top - top) <= 2;
  }
}
