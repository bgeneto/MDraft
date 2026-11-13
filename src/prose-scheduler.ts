//! Adaptive debounce scheduling for Markdown and AsciiDoc previews.
//!
//! No DOM or worker dependencies: Node unit suites import this module directly.

export type ProseLanguage = "markdown" | "asciidoc";

export interface ProseDelayBounds {
  readonly minMs: number;
  readonly maxMs: number;
  readonly overheadMs: number;
  readonly alpha: number;
}

export const PROSE_DELAY_BOUNDS: Record<ProseLanguage, ProseDelayBounds> = {
  markdown: { minMs: 60, maxMs: 200, overheadMs: 45, alpha: 0.35 },
  asciidoc: { minMs: 60, maxMs: 250, overheadMs: 55, alpha: 0.35 },
};

/**
 * Compute an adaptive quiet-period debounce (in ms) from the last render
 * duration, clamped to `[60, 200]` ms for Markdown and `[60, 250]` ms for AsciiDoc.
 */
export function adaptiveProseDelay(
  language: ProseLanguage,
  lastRenderMs: number | null | undefined,
  bounds: ProseDelayBounds = PROSE_DELAY_BOUNDS[language],
): number {
  if (lastRenderMs == null || !Number.isFinite(lastRenderMs) || lastRenderMs < 0) {
    return bounds.maxMs;
  }
  const estimated = bounds.overheadMs + lastRenderMs * 1.25;
  return Math.round(Math.min(bounds.maxMs, Math.max(bounds.minMs, estimated)));
}

/**
 * Tracks smoothed per-language render duration via exponential moving average
 * (EMA) so interactive quiet periods respond swiftly on fast buffers without
 * thrashing on heavy documents.
 */
export class ProseDelayTracker {
  private readonly boundsMap: Record<ProseLanguage, ProseDelayBounds>;
  private readonly emaByLanguage: Record<ProseLanguage, number | null>;

  constructor(bounds: Record<ProseLanguage, ProseDelayBounds> = PROSE_DELAY_BOUNDS) {
    this.boundsMap = bounds;
    this.emaByLanguage = { markdown: null, asciidoc: null };
  }

  record(language: ProseLanguage, durationMs: number): number {
    if (!Number.isFinite(durationMs) || durationMs < 0) {
      return this.delay(language);
    }
    const alpha = this.boundsMap[language].alpha;
    const previous = this.emaByLanguage[language];
    const next = previous === null ? durationMs : alpha * durationMs + (1 - alpha) * previous;
    this.emaByLanguage[language] = next;
    return this.delay(language);
  }

  ema(language: ProseLanguage): number | null {
    return this.emaByLanguage[language];
  }

  delay(language: ProseLanguage): number {
    return adaptiveProseDelay(language, this.emaByLanguage[language], this.boundsMap[language]);
  }

  reset(language?: ProseLanguage): void {
    if (language) {
      this.emaByLanguage[language] = null;
      return;
    }
    this.emaByLanguage.markdown = null;
    this.emaByLanguage.asciidoc = null;
  }
}
