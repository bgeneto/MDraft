//! Scroll policy in CSS pixels. Renderers own text identity and geometry.

export interface SourceAnchor {
  readonly from: number;
  readonly to: number;
}

/** One immutable, source-sorted index per render, never a text search on scroll. */
export class ScrollIndex<T extends SourceAnchor> {
  readonly anchors: readonly T[];
  constructor(anchors: readonly T[]) {
    this.anchors = [...anchors].sort((a, b) => a.from - b.from || a.to - b.to);
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
 */
export function scrollCorrection(pairs: readonly ScrollPair[], reference: number): number | null {
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
    return interpolate(reference, left.origin, right.origin, left.target, right.target) - reference;
  }
  return nearest.target - nearest.origin;
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
