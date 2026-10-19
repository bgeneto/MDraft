//! Mapping a rendered Typst document back to its source lines.
//!
//! The Markdown preview can annotate itself because the parser hands back the raw
//! text of every token, so each rendered block knows exactly which bytes produced
//! it. Typst offers no such thing: the compiler runs in another process and its
//! HTML export carries no source positions at all.
//!
//! What is available is the text. So the blocks are matched back to the source by
//! their content, walking both in document order and never going backwards. Every
//! rendered block therefore lands on a line at or after the previous one, which is
//! the property the scroll synchroniser actually needs: it must never jump about.
//!
//! This is a heuristic and is documented as one. It gets headings and prose right,
//! which is what navigation is for; a block whose text cannot be found (a drawing,
//! the inside of a table call) keeps the previous block's line rather than
//! inventing one.

import type { BlockRange } from "./source-map";

/**
 * Fold text into something comparable between the two sides.
 *
 * The markers differ between the languages, as do the decorations the rendered
 * side adds: a heading `= Text` becomes `1 Text` once numbered, and `*bold*`
 * becomes `bold`. Both sides are reduced to plain lower-case words.
 */
function fold(text: string): string {
  return text
    // Typst's automatic heading numbering, and Markdown's, both prefix a number.
    .replace(/^\s*\d+(?:\.\d+)*\s+/, "")
    // Markers are removed rather than spaced out, so that `*strong*` and the
    // rendered `strong` fold to the same word instead of `strong` with gaps.
    .replace(/[*_`#$\\{}[\]]/g, "")
    // Removing a marker can leave a space before punctuation — `*strong*,` is
    // `strong ,` after the star goes — and the rendered side has no such space.
    .replace(/\s+([,.;:!?—–)])/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * The text of an element, with a separator between descendants.
 *
 * `textContent` runs sibling blocks together — a list renders as "Ordered
 * itemAnother oneNested bullet" — and no source line contains that, so nothing
 * matches. Joining the text of each descendant with a space keeps the words in
 * order while leaving them separable.
 */
function blockText(element: HTMLElement): string {
  const parts: string[] = [];
  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent ?? "";
      if (text.trim()) parts.push(text);
      return;
    }
    for (const child of Array.from(node.childNodes)) walk(child);
  };
  walk(element);
  return parts.join(" ");
}

/**
 * The whole source as one folded string, with a map from offset back to line.
 *
 * Lines are joined with a space rather than a newline so that a paragraph spanning
 * several source lines compares equal to the single rendered block it produces.
 */
function foldSource(source: string): { plain: string; starts: number[] } {
  const lines = source.split("\n");
  const starts: number[] = [];
  let plain = "";
  for (let i = 0; i < lines.length; i++) {
    starts.push(plain.length);
    // List and heading markers are removed from the start of the line only: the
    // rendered side has them as structure, not as text, and `+ one + two` would
    // otherwise never line up with `one two`.
    const stripped = lines[i]
      .replace(/^\s*(?:={1,6}|\+|-|\/\s*\/|\d+\.)\s+/, "")
      .replace(/^\s*(?:={1,6}|\+|-)\s*$/, "");
    plain += fold(stripped);
    plain += " ";
  }
  return { plain, starts };
}

/** The 1-based line holding a folded offset. */
function lineAt(starts: number[], offset: number): number {
  let line = 1;
  for (let i = 0; i < starts.length; i++) {
    if (starts[i] <= offset) line = i + 1;
    else break;
  }
  return line;
}

/**
 * Attach `data-line` to each top-level block of a rendered Typst document.
 *
 * Returns how many blocks were mapped, which is what decides whether positional
 * sync is offered at all: two anchors is enough to scroll against, and demanding
 * every block would switch sync off for any document containing a figure.
 *
 * The block ranges are the same approximation AsciiDoc uses: a block's source
 * text is searched forward inside its line range, so prose is found and generated
 * text is not. `data-b` is the index the word map binds after `innerHTML`.
 */
export function annotateTypstLines(
  host: HTMLElement,
  source: string,
): { mapped: number; blocks: BlockRange[] } {
  const elements = Array.from(host.children) as HTMLElement[];
  const { plain, starts } = foldSource(source);
  const found: Array<{ element: HTMLElement; line: number }> = [];
  let cursor = 0;

  for (const block of elements) {
    const text = fold(blockText(block));
    if (text.length < 2) continue;
    // A prefix long enough to be specific, short enough to survive the small
    // differences between source markup and rendered text.
    const needle = text.slice(0, 24);
    const at = plain.indexOf(needle, cursor);
    if (at < 0) continue;
    const line = lineAt(starts, at);
    block.setAttribute("data-line", String(line));
    found.push({ element: block, line });
    cursor = at + 1;
  }

  // Turn consecutive source lines into one block range. The next mapped block is
  // the end boundary, which keeps a search inside the paragraph rather than the
  // rest of the document; the last block reaches the end.
  const lineStarts: number[] = [0];
  for (let i = 0; i < source.length; i += 1) {
    if (source.charCodeAt(i) === 10) lineStarts.push(i + 1);
  }
  const blocks: BlockRange[] = [];
  for (let i = 0; i < found.length; i += 1) {
    const startLine = found[i].line;
    const nextLine = found[i + 1]?.line ?? Number.POSITIVE_INFINITY;
    const endLine = Number.isFinite(nextLine)
      ? Math.max(startLine, nextLine - 1)
      : lineStarts.length;
    const src0 = lineStarts[Math.max(0, startLine - 1)] ?? 0;
    const src1 = endLine < lineStarts.length ? lineStarts[endLine] : source.length;
    if (src1 <= src0) continue;
    found[i].element.dataset.b = String(blocks.length);
    blocks.push({ src0, src1 });
  }

  return { mapped: found.length, blocks };
}
