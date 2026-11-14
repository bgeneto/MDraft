//! Pure scheduling primitives for the LaTeX live preview.
//!
//! docs/architecture.md: a running compile is never
//! aborted because the reader typed, since aborting means disposing the warm
//! engine. The newest revision runs next and every revision in between is
//! skipped. These pieces have no DOM and no engine, so
//! `scripts/latex-scheduler-unit.mjs` tests them without the application.

/** A waiting compile was replaced by a newer revision before the engine freed up. */
export class SupersededError extends Error {
  constructor(token: number, by: number) {
    super(`Compile ${token} was superseded by ${by} while waiting for the engine.`);
    this.name = "SupersededError";
  }
}

/**
 * One running job; at most one waiting job, and the newest one wins.
 *
 * `acquire` resolves with a release function once the gate is free. A caller
 * that arrives while another is already waiting replaces it: the replaced
 * caller's promise rejects with `SupersededError`. The running job is never
 * touched. Release is idempotent so a `finally` can always call it.
 */
export class LatestWinsGate {
  private running: number | null = null;
  private waiting: {
    token: number;
    resolve: (release: () => void) => void;
    reject: (error: Error) => void;
  } | null = null;

  /** The token of the job holding the gate, or null when idle. */
  get holder(): number | null {
    return this.running;
  }

  /** The token waiting for the gate, or null. */
  get queued(): number | null {
    return this.waiting?.token ?? null;
  }

  acquire(token: number): Promise<() => void> {
    if (this.running === null) {
      this.running = token;
      return Promise.resolve(this.releaser(token));
    }
    // An older revision never displaces a newer waiter: a render that runs its
    // interactive preview and then its canonical compile acquires twice, and a
    // newer render may have queued in between.
    if (this.waiting && this.waiting.token > token) {
      return Promise.reject(new SupersededError(token, this.waiting.token));
    }
    this.waiting?.reject(new SupersededError(this.waiting.token, token));
    return new Promise((resolve, reject) => {
      this.waiting = { token, resolve, reject };
    });
  }

  /** Reject the waiting caller (document closed, engine disabled); the running job continues. */
  dropWaiting(reason: Error): void {
    const waiting = this.waiting;
    this.waiting = null;
    waiting?.reject(reason);
  }

  private releaser(token: number): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (this.running !== token) return;
      const next = this.waiting;
      this.waiting = null;
      if (next) {
        this.running = next.token;
        next.resolve(this.releaser(next.token));
      } else {
        this.running = null;
      }
    };
  }
}

/** Bounds for the interactive delay, in milliseconds. */
export interface DelayBounds {
  factor: number;
  min: number;
  max: number;
}

export const INTERACTIVE_DELAY: DelayBounds = { factor: 1.5, min: 60, max: 200 };

/**
 * The quiet period after the last key before a compile starts.
 *
 * A pause is "longer than this reader's rhythm": 1.5 x the median of the
 * recent inter-key intervals, kept between `min` and `max`. With no history
 * the maximum is used, the conservative choice.
 */
export function adaptiveDelay(intervals: readonly number[], bounds = INTERACTIVE_DELAY): number {
  const usable = intervals.filter((value) => Number.isFinite(value) && value > 0);
  if (usable.length === 0) return bounds.max;
  const sorted = [...usable].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  const median = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  return Math.round(Math.min(bounds.max, Math.max(bounds.min, median * bounds.factor)));
}

/** Recent inter-key intervals; intervals longer than `ignoreAbove` are pauses, not rhythm. */
export class KeyRhythm {
  private last: number | null = null;
  private readonly values: number[] = [];
  // Plain fields, not parameter properties: Node's type stripping (used by the
  // app-free unit suites) refuses TypeScript-only syntax.
  private readonly size: number;
  private readonly ignoreAbove: number;

  constructor(size = 8, ignoreAbove = 1000) {
    this.size = size;
    this.ignoreAbove = ignoreAbove;
  }

  record(at: number): void {
    if (this.last !== null) {
      const interval = at - this.last;
      if (interval > 0 && interval <= this.ignoreAbove) {
        this.values.push(interval);
        if (this.values.length > this.size) this.values.shift();
      }
    }
    this.last = at;
  }

  intervals(): readonly number[] {
    return this.values;
  }
}

/**
 * Whether continuous typing has gone on long enough that one compile should
 * start without waiting for a pause, so a long burst still updates as it goes.
 */
export function staleBeyondCap(
  lastStartAt: number | null,
  firstUnrenderedEditAt: number | null,
  now: number,
  cap = 1500,
): boolean {
  if (firstUnrenderedEditAt === null) return false;
  const since = Math.max(firstUnrenderedEditAt, lastStartAt ?? -Infinity);
  return now - since >= cap;
}
