//! Selection and click correspondence for the TeXpresso frame
//! (docs/architecture.md, "Correspondence on MDraft's conventions").

import { snapToWords } from "../source-map.ts";
import { paragraphRangeAt } from "../typst-page-map.ts";
import type { ClickPrecision } from "./protocol.ts";

export interface SourceRange {
  from: number;
  to: number;
}

export interface PreviewMark {
  range: SourceRange;
  /** Where the source caret goes, or null when the gesture leaves it alone. */
  caret: number | null;
  unit: "range" | "line" | "paragraph";
}

/** The source line around `offset`, without its indentation and trailing blanks. */
export function lineRangeAt(source: string, offset: number): SourceRange {
  const at = Math.max(0, Math.min(offset, source.length));
  let from = source.lastIndexOf("\n", at - 1) + 1;
  const end = source.indexOf("\n", at);
  let to = end < 0 ? source.length : end;
  while (from < to && /\s/.test(source[from])) from += 1;
  while (to > from && /\s/.test(source[to - 1])) to -= 1;
  return { from, to };
}

/**
 * What a gesture in the preview marks in the source, and where the caret goes.
 *
 * The frame answers with the engine's own source position and says how far it
 * verified a single click against the clicked pixel. The finest unit that was
 * verified wins:
 *
 * - a range (a drag, or the word of a double-click) is marked as whole words
 *   and the caret stays; a double-click without a range marks nothing;
 * - an "exact" click puts the caret on the answered character and marks its
 *   source line;
 * - a "line" click marks the line and puts the caret at its first character;
 * - anything else marks the paragraph and leaves the caret, as a click on a
 *   PDF page does.
 */
export function markForPreviewGesture(
  source: string,
  from: number,
  to: number,
  detail: number,
  precision: ClickPrecision = "none",
): PreviewMark | null {
  const length = source.length;
  // A position the document does not have is a stale source map, not the last
  // paragraph: marking something wrong is worse than marking nothing.
  if (from < 0 || from > length) return null;
  const end = Math.max(from, Math.min(to, length));
  if (end > from) {
    // The word a double-click names is the engine's; a drag is widened to words.
    const range =
      detail >= 2 ? { from, to: end } : (snapToWords(source, from, end) ?? { from, to: end });
    return { range, caret: null, unit: "range" };
  }
  // A double-click names a word. Without one there is nothing to mark, and
  // falling through would replace a word already marked with its paragraph.
  if (detail >= 2) return null;
  if (precision !== "none") {
    const line = lineRangeAt(source, from);
    if (line.to > line.from) {
      // An exact answer can sit in the indentation or past the last character.
      const caret =
        precision === "exact" ? Math.max(line.from, Math.min(from, line.to)) : line.from;
      return { range: line, caret, unit: "line" };
    }
  }
  const paragraph = paragraphRangeAt(source, from);
  return paragraph.to > paragraph.from
    ? { range: paragraph, caret: null, unit: "paragraph" }
    : null;
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
