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
    .replace(/[\u2018\u2019\u02bc]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    // Typst's automatic heading and figure numbering prefixes a number or label.
    .replace(/^\s*\d+(?:\.\d+)*\.?\s+/, "")
    .replace(/^\s*(?:table|figure|listing)\s+\d+\s*[:.]\s*/i, "")
    // Formatting markers are removed rather than spaced out so `*strong*` and
    // rendered `strong` fold to the same word.
    .replace(/[*_`#$\\{}[\]]/g, "")
    // Punctuation and dashes become spaces on both sides so `[*Feature*], [*Status*]`
    // and `<th>Feature</th><th>Status</th>`, or `*Abstract*—This` and
    // `<strong>Abstract</strong>—This`, fold to identical word sequences.
    .replace(/[\u2014\u2013]|--+|[,.;:!?()"'/]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Strip inline Typst function headers (`#link("...")[text]` -> `[text]`,
 * `#text(fill: rgb("#b03030"))[Coloured]` -> `[Coloured]`), inline footnotes,
 * and inline `$...$` math from a source line before folding.
 */
function stripSourceLineMarkup(line: string): string {
  let out = line
    .replace(/#footnote\[[^\]]*\]/g, " ")
    .replace(
      /#[a-zA-Z_][\w.-]*\([^()\n]*(?:\([^()\n]*\)[^()\n]*)*\)/g,
      " ",
    );
  // Strip inline `$...$` math only when the line also has prose outside it.
  const withoutMath = out.replace(/\$[^$\n]+\$/g, " ");
  if (/[a-zA-Z\u00C0-\u024F]/.test(withoutMath)) {
    out = withoutMath;
  }
  return out;
}

/**
 * The text of an element, with a separator between descendants.
 *
 * `textContent` runs sibling blocks together — a list renders as "Ordered
 * itemAnother oneNested bullet" — and no source line contains that, so nothing
 * matches. Joining the text of each descendant with a space keeps the words in
 * order while leaving them separable.
 *
 * `<math>` and footnote superscripts are skipped because Typst's HTML export
 * emits Unicode Mathematical Italic glyphs (`𝑎`, `𝑏`) inside `<math>` that do
 * not exist in the ASCII source; `<pre>` and `<code>` read `textContent`
 * directly so syntax-highlighting `<span>`s do not insert spaces inside tokens.
 */
function blockText(element: HTMLElement): string {
  const parts: string[] = [];
  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent ?? "";
      if (text.trim()) parts.push(text);
      return;
    }
    if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as HTMLElement;
      const tag = el.tagName.toUpperCase();
      if (tag === "MATH" && el !== element) return;
      if (
        tag === "SUP" &&
        (el.getAttribute("role") === "doc-noteref" ||
          el.getAttribute("role") === "doc-backlink")
      ) {
        return;
      }
      if (tag === "PRE" || tag === "CODE") {
        const text = el.textContent ?? "";
        if (text.trim()) parts.push(text);
        return;
      }
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
 * Comments, code fences, and pure non-rendered directives (`#set`, `#pagebreak`,
 * `#lorem`) are omitted so their keywords cannot masquerade as prose headings.
 */
function foldSource(source: string): {
  plain: string;
  starts: number[];
  lines: string[];
  headings: Array<{ line: number; text: string; offset: number }>;
  mathLines: number[];
} {
  const lines = source.split("\n");
  const starts: number[] = [];
  const headings: Array<{ line: number; text: string; offset: number }> = [];
  const mathLines: number[] = [];
  let plain = "";
  for (let i = 0; i < lines.length; i++) {
    starts.push(plain.length);
    const rawLine = lines[i];
    const trimmed = rawLine.trim();
    // Skip comments, code-fence delimiters, and standalone non-prose directives.
    if (
      !trimmed ||
      trimmed.startsWith("//") ||
      /^(?:`{3,}|~{3,})/.test(trimmed) ||
      /^#(?:set|show|import|include|let|v|h|pagebreak|colbreak|lorem)\b/.test(
        trimmed,
      )
    ) {
      continue;
    }
    if (/^\$.*\$$/.test(trimmed)) {
      mathLines.push(i + 1);
    }
    const headingMatch = rawLine.match(/^\s*={1,6}\s+(.*)$/);
    if (headingMatch) {
      const foldedHeading = fold(stripSourceLineMarkup(headingMatch[1]));
      if (foldedHeading) {
        headings.push({
          line: i + 1,
          text: foldedHeading,
          offset: plain.length,
        });
      }
    }
    // List and heading markers are removed from the start of the line only: the
    // rendered side has them as structure, not as text, and `+ one + two` would
    // otherwise never line up with `one two`.
    const stripped = stripSourceLineMarkup(
      rawLine
        .replace(/^\s*(?:={1,6}|\+|-|\d+\.)\s+/, "")
        .replace(/^\s*(?:={1,6}|\+|-)\s*$/, ""),
    );
    const folded = fold(stripped);
    if (!folded) continue;
    plain += folded;
    plain += " ";
  }
  return { plain, starts, lines, headings, mathLines };
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

function indexOfWordBounded(
  plain: string,
  needle: string,
  fromIndex: number,
): number {
  let searchFrom = fromIndex;
  while (searchFrom <= plain.length - needle.length) {
    const at = plain.indexOf(needle, searchFrom);
    if (at < 0) return -1;
    if (needle.length >= 12) return at;
    const beforeOk = at === 0 || plain[at - 1] === " ";
    const afterIndex = at + needle.length;
    const afterOk = afterIndex >= plain.length || plain[afterIndex] === " ";
    if (beforeOk && afterOk) return at;
    searchFrom = at + 1;
  }
  return -1;
}

/**
 * Walk back from a matched line to include immediately preceding wrapper lines
 * (such as ```` ```rust ```` before a code block, or `#figure(` / `table(` before
 * the first table header cell).
 */
function adjustBlockStartLine(
  lines: readonly string[],
  matchedLine: number,
  minLine: number,
  tagName: string,
): number {
  let line = matchedLine;
  if (tagName === "PRE" && line > minLine) {
    const prev = lines[line - 2]?.trim() ?? "";
    if (/^(?:`{3,}|~{3,})/.test(prev)) {
      return line - 1;
    }
  }
  if (tagName === "FIGURE" || tagName === "TABLE") {
    while (line > minLine) {
      const prev = lines[line - 2]?.trim() ?? "";
      if (
        prev.startsWith("#figure") ||
        prev.startsWith("table(") ||
        prev.startsWith("table.header") ||
        prev.startsWith("table.hline") ||
        /^(?:columns|align|stroke|inset|fill)\s*:/.test(prev)
      ) {
        line -= 1;
      } else {
        break;
      }
    }
  }
  return line;
}

/**
 * Trim trailing blank lines and standalone non-prose directives (`#lorem`,
 * `#pagebreak`, `#colbreak`) from the end of a block's line range so unanchored
 * generated blocks between two anchored blocks never fall inside the preceding
 * block's source range.
 */
function trimBlockEndLine(
  lines: readonly string[],
  startLine: number,
  rawEndLine: number,
): number {
  let end = Math.min(rawEndLine, lines.length);
  for (let line = startLine + 1; line <= end; line += 1) {
    const trimmed = lines[line - 1]?.trim() ?? "";
    if (/^#(?:lorem|pagebreak|colbreak)\b/.test(trimmed)) {
      end = line - 1;
      break;
    }
  }
  while (end > startLine && (lines[end - 1]?.trim() ?? "") === "") {
    end -= 1;
  }
  return Math.max(startLine, end);
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
  const { plain, starts, lines, headings, mathLines } = foldSource(source);
  const found: Array<{ element: HTMLElement; line: number }> = [];
  let cursor = 0;
  let lastLine = 1;

  for (const block of elements) {
    const tag = block.tagName.toUpperCase();
    if (tag === "SECTION" && block.getAttribute("role") === "doc-endnotes") {
      continue;
    }
    if (tag === "MATH") {
      const mathLine = mathLines.find((line) => line >= lastLine);
      if (mathLine !== undefined) {
        block.setAttribute("data-line", String(mathLine));
        found.push({ element: block, line: mathLine });
        lastLine = mathLine + 1;
        cursor = Math.max(cursor, starts[mathLine - 1] ?? cursor);
      }
      continue;
    }

    const text = fold(blockText(block));
    if (text.length < 2) continue;

    if (/^H[1-6]$/.test(tag)) {
      const heading = headings.find(
        (h) =>
          h.line >= lastLine &&
          (h.text === text ||
            h.text.startsWith(text) ||
            text.startsWith(h.text)),
      );
      if (heading) {
        block.setAttribute("data-line", String(heading.line));
        found.push({ element: block, line: heading.line });
        lastLine = heading.line;
        cursor = heading.offset + heading.text.length;
        continue;
      }
    }

    // A prefix long enough to be specific, short enough to survive the small
    // differences between source markup and rendered text.
    const needle = text.slice(0, 24);
    const at = indexOfWordBounded(plain, needle, cursor);
    if (at < 0) continue;
    const rawLine = lineAt(starts, at);
    const line = adjustBlockStartLine(lines, rawLine, lastLine, tag);
    block.setAttribute("data-line", String(line));
    found.push({ element: block, line });
    lastLine = rawLine;
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
    const rawEndLine = Number.isFinite(nextLine)
      ? Math.max(startLine, nextLine - 1)
      : lineStarts.length;
    const endLine = trimBlockEndLine(lines, startLine, rawEndLine);
    const src0 = lineStarts[Math.max(0, startLine - 1)] ?? 0;
    const src1 = endLine < lineStarts.length ? lineStarts[endLine] : source.length;
    if (src1 <= src0) continue;
    found[i].element.dataset.b = String(blocks.length);
    blocks.push({ src0, src1 });
  }

  return { mapped: found.length, blocks };
}
