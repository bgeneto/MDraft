//! Selection and click correspondence for the TeXpresso frame, on the rules
//! the PDF pages preview follows (docs/architecture.md,
//! "Correspondence on MDraft's conventions").

import { paragraphRangeAt } from "../typst-page-map.ts";

export interface SourceRange {
  from: number;
  to: number;
}

/**
 * The source range a gesture in the preview marks. The frame answers a click
 * with a caret (`detail` 1) and a double-click with the word the engine's
 * source map found; a click marks the paragraph around the caret, as a click
 * on a PDF page does.
 */
export function rangeForPreviewGesture(
  source: string,
  from: number,
  to: number,
  detail: number,
): SourceRange | null {
  const length = source.length;
  // A position the document does not have is a stale source map, not the last
  // paragraph: marking something wrong is worse than marking nothing.
  if (from < 0 || from > length) return null;
  const start = from;
  const end = Math.max(start, Math.min(to, length));
  const range =
    detail >= 2 && end > start ? { from: start, to: end } : paragraphRangeAt(source, start);
  return range.to > range.from ? range : null;
}

/** The project-relative path of `path` under `directory`, or null outside it. */
export function projectRelativePath(
  directory: string,
  path: string | null,
  key: (path: string) => string,
): string | null {
  if (!path) return null;
  const prefix = key(directory) + "/";
  if (!key(path).startsWith(prefix)) return null;
  return path.slice(directory.length + 1).replace(/\\/g, "/");
}
