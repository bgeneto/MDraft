//! In-page performance marks for the LaTeX compile benchmark.
//!
//! These stay in the shipping build on purpose: `performance.mark` and
//! `performance.measure` cost microseconds, and a flag that disabled them would
//! measure a different code path. Nothing here changes a decision, a DOM node or
//! an await; the CDP probe in `scripts/latex-performance-test.mjs` reads the
//! entries and clears them before the next edit.

const PREFIX = "mdraft:latex:";

/** Mark `name` at the current instant and return that instant. */
export function perfMark(name: string, detail?: Record<string, unknown>): number {
  const at = performance.now();
  try {
    if (detail === undefined) performance.mark(`${PREFIX}${name}`);
    else performance.mark(`${PREFIX}${name}`, { detail });
  } catch {
    // User timing is diagnostic. A host that refuses it must not fail a compile.
  }
  return at;
}

/** Measure from `start` (a `performance.now()` value) to now. */
export function perfMeasure(name: string, start: number, detail?: Record<string, unknown>): void {
  try {
    performance.measure(`${PREFIX}${name}`, {
      start,
      end: performance.now(),
      ...(detail === undefined ? {} : { detail }),
    });
  } catch {
    // See perfMark.
  }
}

/** Drop every entry this module produced, so a long session keeps a bounded buffer. */
export function clearLatexPerf(): void {
  for (const entry of performance.getEntriesByType("measure")) {
    if (entry.name.startsWith(PREFIX)) performance.clearMeasures(entry.name);
  }
  for (const entry of performance.getEntriesByType("mark")) {
    if (entry.name.startsWith(PREFIX)) performance.clearMarks(entry.name);
  }
}

let lastPhase = "";

/** Start a new compile's phase sequence. */
export function resetLatexPhase(): void {
  lastPhase = "";
}

/**
 * Record a status-chip phase change.
 *
 * The probe counts these to prove the chip is not a per-chunk firehose and to
 * see when the truthful phase (S1) replaces the old sticky label.
 */
export function perfPhase(message: string): void {
  if (message === lastPhase) return;
  lastPhase = message;
  perfMark("phase", { message });
}
