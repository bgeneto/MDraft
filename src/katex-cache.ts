//! Shared bounded LRU KaTeX memoization for DOM-free workers and fallback renderers.

import katex from "katex";

export const MAX_KATEX_LRU = 2000;
const KATEX_CACHE_PROFILE = "toe0:strict0:output=html:trust0:macros0";

export interface CachedKatexResult {
  html: string | null;
  error: string | null;
}

const katexLru = new Map<string, CachedKatexResult>();

function cacheKey(body: string, display: boolean): string {
  return `${display ? "D" : "I"}:${KATEX_CACHE_PROFILE}\u0000${body}`;
}

/**
 * Render a TeX formula to HTML with bounded LRU memoization keyed by
 * `(displayMode, options profile, tex)`.
 */
export function renderKatexCached(body: string, display: boolean): CachedKatexResult {
  const key = cacheKey(body, display);
  const hit = katexLru.get(key);
  if (hit !== undefined) {
    // Refresh recency cleanly in JS Map insertion order.
    katexLru.delete(key);
    katexLru.set(key, hit);
    return hit;
  }

  let result: CachedKatexResult;
  try {
    result = {
      html: katex.renderToString(body, {
        displayMode: display,
        throwOnError: false,
        strict: false,
        output: "html",
      }),
      error: null,
    };
  } catch (error) {
    result = { html: null, error: String(error) };
  }

  if (katexLru.size >= MAX_KATEX_LRU) {
    const oldest = katexLru.keys().next().value;
    if (oldest !== undefined) katexLru.delete(oldest);
  }
  katexLru.set(key, result);
  return result;
}

/** Clear all memoized KaTeX entries (intended for tests or theme/config resets). */
export function clearKatexCache(): void {
  katexLru.clear();
}

/** Current count of memoized KaTeX formulas. */
export function katexCacheSize(): number {
  return katexLru.size;
}
