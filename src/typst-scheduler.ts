//! Adaptive Typst live-preview scheduling primitives over `latex-scheduler.ts`.
//!
//! Replaces fixed 450 ms debouncing + eager per-keystroke child cancellation
//! with Typst-calibrated bounds (`80..350 ms`, `staleBeyondCap = 1500 ms`) and a
//! single-slot `LatestWinsGate` so nonstop typing flushes bounded revisions and
//! warm/service renders finish without premature starvation.

import {
  KeyRhythm,
  LatestWinsGate,
  SupersededError,
  adaptiveDelay,
  staleBeyondCap,
  type DelayBounds,
} from "./latex-scheduler.ts";

export { KeyRhythm, LatestWinsGate, SupersededError, adaptiveDelay, staleBeyondCap };
export type { DelayBounds };

export const TYPST_INTERACTIVE_DELAY: DelayBounds = {
  factor: 1.5,
  min: 80,
  max: 350,
};

export const TYPST_STALE_CAP_MS = 1500;

/**
 * Coordinates Typst preview compile scheduling using adaptive typing rhythm,
 * bounded staleness flushing, and a single-runner `LatestWinsGate`.
 */
export class TypstCompileScheduler {
  private readonly gate = new LatestWinsGate();
  private readonly rhythm = new KeyRhythm();
  private readonly bounds: DelayBounds;
  private readonly staleCapMs: number;
  private readonly nowFn: () => number;
  private lastStartAt: number | null = null;
  private firstUnrenderedEditAt: number | null = null;
  private latestRevision = 0;
  private lastCompiledRevision = 0;

  constructor(
    bounds: DelayBounds = TYPST_INTERACTIVE_DELAY,
    staleCapMs: number = TYPST_STALE_CAP_MS,
    nowFn: () => number = () => performance.now(),
  ) {
    this.bounds = bounds;
    this.staleCapMs = staleCapMs;
    this.nowFn = nowFn;
  }

  get holder(): number | null {
    return this.gate.holder;
  }

  get queued(): number | null {
    return this.gate.queued;
  }

  get pendingRevision(): number | null {
    return this.latestRevision > this.lastCompiledRevision ? this.latestRevision : null;
  }

  /** Record a buffer edit timestamp and return its monotonically increasing revision. */
  recordEdit(at: number = this.nowFn()): number {
    this.latestRevision += 1;
    this.rhythm.record(at);
    if (this.firstUnrenderedEditAt === null) {
      this.firstUnrenderedEditAt = at;
    }
    return this.latestRevision;
  }

  /** Compute the quiet debounce delay before launching the next Typst compile. */
  delayFor(now: number = this.nowFn(), lastCompileMs: number | null = null): number {
    if (staleBeyondCap(this.lastStartAt, this.firstUnrenderedEditAt, now, this.staleCapMs)) {
      return 0;
    }
    const base = adaptiveDelay(this.rhythm.intervals(), this.bounds);
    if (lastCompileMs !== null && Number.isFinite(lastCompileMs) && lastCompileMs > base) {
      const damped = Math.round(base + (lastCompileMs - base) * 0.25);
      return Math.min(this.bounds.max, Math.max(this.bounds.min, damped));
    }
    return base;
  }

  /** Whether nonstop typing has exceeded the staleness cap and should start now. */
  shouldFlushNow(now: number = this.nowFn()): boolean {
    return staleBeyondCap(this.lastStartAt, this.firstUnrenderedEditAt, now, this.staleCapMs);
  }

  /**
   * Acquire the single active Typst preview slot for `revision`.
   * Intermediate waiting revisions reject with `SupersededError`.
   */
  acquire(revision: number): Promise<() => void> {
    return this.gate.acquire(revision).then((release) => {
      this.lastStartAt = this.nowFn();
      return release;
    });
  }

  /** Record completion of `revision`, clearing unrendered tracking once caught up. */
  markCompiled(revision: number, caughtUpAt: number | null = null): void {
    if (revision > this.lastCompiledRevision) {
      this.lastCompiledRevision = revision;
    }
    if (this.lastCompiledRevision >= this.latestRevision) {
      this.firstUnrenderedEditAt = null;
    } else if (caughtUpAt !== null) {
      this.firstUnrenderedEditAt = caughtUpAt;
    }
  }

  dropWaiting(reason: Error): void {
    this.gate.dropWaiting(reason);
  }

  reset(reason: Error = new Error("Typst scheduler reset.")): void {
    this.gate.dropWaiting(reason);
    this.lastStartAt = null;
    this.firstUnrenderedEditAt = null;
  }
}
