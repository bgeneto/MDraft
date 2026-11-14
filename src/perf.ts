//! In-page performance marks for the LaTeX, Typst, and prose compile/render benchmarks.
//!
//! These stay in the shipping build on purpose: `performance.mark` and
//! `performance.measure` cost microseconds, and a flag that disabled them would
//! measure a different code path. Nothing here changes a decision, a DOM node or
//! an await; the CDP probes in `scripts/*-performance-test.mjs` read the
//! entries and clear them before the next edit.

export type PerfDomain = "latex" | "typst" | "prose";

const PREFIX_BY_DOMAIN: Record<PerfDomain, string> = {
  latex: "mdraft:latex:",
  typst: "mdraft:typst:",
  prose: "mdraft:prose:",
};

const PREFIX = PREFIX_BY_DOMAIN.latex;

function markWithPrefix(prefix: string, name: string, detail?: Record<string, unknown>): number {
  const at = performance.now();
  try {
    if (detail === undefined) performance.mark(`${prefix}${name}`);
    else performance.mark(`${prefix}${name}`, { detail });
  } catch {
    // User timing is diagnostic. A host that refuses it must not fail a compile.
  }
  return at;
}

function measureWithPrefix(
  prefix: string,
  name: string,
  start: number,
  detail?: Record<string, unknown>,
): void {
  try {
    performance.measure(`${prefix}${name}`, {
      start,
      end: performance.now(),
      ...(detail === undefined ? {} : { detail }),
    });
  } catch {
    // See markWithPrefix.
  }
}

function clearWithPrefix(prefix: string): void {
  for (const entry of performance.getEntriesByType("measure")) {
    if (entry.name.startsWith(prefix)) performance.clearMeasures(entry.name);
  }
  for (const entry of performance.getEntriesByType("mark")) {
    if (entry.name.startsWith(prefix)) performance.clearMarks(entry.name);
  }
}

/** Mark `name` under `mdraft:latex:` at the current instant and return that instant. */
export function perfMark(name: string, detail?: Record<string, unknown>): number {
  return markWithPrefix(PREFIX, name, detail);
}

/** Measure from `start` under `mdraft:latex:` to now. */
export function perfMeasure(name: string, start: number, detail?: Record<string, unknown>): void {
  measureWithPrefix(PREFIX, name, start, detail);
}

/** Drop every `mdraft:latex:` entry so a long session keeps a bounded buffer. */
export function clearLatexPerf(): void {
  clearWithPrefix(PREFIX);
}

/** Mark `name` under `mdraft:typst:` at the current instant and return that instant. */
export function typstPerfMark(name: string, detail?: Record<string, unknown>): number {
  return markWithPrefix(PREFIX_BY_DOMAIN.typst, name, detail);
}

/** Measure from `start` under `mdraft:typst:` to now. */
export function typstPerfMeasure(
  name: string,
  start: number,
  detail?: Record<string, unknown>,
): void {
  measureWithPrefix(PREFIX_BY_DOMAIN.typst, name, start, detail);
}

/** Drop every `mdraft:typst:` entry so a long session keeps a bounded buffer. */
export function clearTypstPerf(): void {
  clearWithPrefix(PREFIX_BY_DOMAIN.typst);
}

/** Mark `name` under `mdraft:prose:` at the current instant and return that instant. */
export function prosePerfMark(name: string, detail?: Record<string, unknown>): number {
  return markWithPrefix(PREFIX_BY_DOMAIN.prose, name, detail);
}

/** Measure from `start` under `mdraft:prose:` to now. */
export function prosePerfMeasure(
  name: string,
  start: number,
  detail?: Record<string, unknown>,
): void {
  measureWithPrefix(PREFIX_BY_DOMAIN.prose, name, start, detail);
}

/** Drop every `mdraft:prose:` entry so a long session keeps a bounded buffer. */
export function clearProsePerf(): void {
  clearWithPrefix(PREFIX_BY_DOMAIN.prose);
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
