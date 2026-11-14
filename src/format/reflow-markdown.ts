//! Markdown rules for paragraph reflow.
//!
//! The editor's own Lezer parser decides what a paragraph is, so a list item,
//! a lazy continuation or a blockquote line is read exactly as the editor reads
//! it. Only `Paragraph` and task-item text is rewritten; headings, fences, code,
//! tables, HTML, front matter and `$$` math stay byte-identical.

import { markdownLanguage } from "@codemirror/lang-markdown";
import { backtickSpans, delimitedSpans, escaped, linesOf, type Dialect, type LineInfo } from "./reflow.ts";

/** A line that would open a block if a break put it at a line start. */
const STRUCTURAL =
  /^[ \t]*(?:#{1,6}(?:[ \t]|$)|>|[-+*](?:[ \t]|$)|\d{1,9}[.)](?:[ \t]|$)|=+[ \t]*$|-+[ \t]*$|[-*_](?:[ \t]*[-*_]){2,}[ \t]*$|```|~~~|<|\||\$\$|\[!|\[\^)/;

/** GitHub alert marker, `[!NOTE]`, which must stay on its own line. */
const ALERT = /^\[![A-Za-z]+\][ \t]*$/;

function isStructural(line: string): boolean {
  return STRUCTURAL.test(line);
}

function endsWithBreak(line: string): boolean {
  if (/ {2,}$/.test(line)) return true;
  return line.endsWith("\\") && !escaped(line, line.length - 1);
}

/** Lines of a leading `---` front matter block, or 0. */
function frontMatterLines(lines: string[]): number {
  if (lines[0]?.trimEnd() !== "---") return 0;
  for (let index = 1; index < lines.length; index += 1) {
    if (/^(?:---|\.\.\.)[ \t]*$/.test(lines[index])) return index + 1;
  }
  return 0;
}

function classify(text: string): LineInfo[] {
  const lines = linesOf(text);
  const starts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    starts.push(offset);
    offset += line.length + 1;
  }
  const lineAt = (pos: number): number => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (starts[mid] <= pos) low = mid;
      else high = mid - 1;
    }
    return low;
  };
  const infos: LineInfo[] = lines.map((line) => ({ kind: line.trim() ? "protected" : "blank" }));
  const front = frontMatterLines(lines);

  const tree = markdownLanguage.parser.parse(text);
  tree.iterate({
    enter(node) {
      if (node.name !== "Paragraph" && node.name !== "Task") return;
      const first = lineAt(node.from);
      const last = lineAt(Math.max(node.from, node.to - 1));
      if (first < front) return false;
      let quoted = false;
      for (let parent = node.node.parent; parent; parent = parent.parent) {
        if (parent.name === "Blockquote") quoted = true;
      }
      // The text starts after a task's `[ ]` marker, not at the node start.
      let contentFrom = node.from;
      if (node.name === "Task") {
        const marker = node.node.getChild("TaskMarker");
        if (marker) contentFrom = marker.to + (text[marker.to] === " " ? 1 : 0);
      }
      const prefixPattern = quoted ? /^(?:[ \t]*>[ \t]?)*[ \t]*/ : /^[ \t]*/;
      const body = lines.slice(first, last + 1);
      // `$$` display math is not part of the CommonMark grammar, so the parser
      // sees it as paragraph text. Such a paragraph is left alone.
      if (body.some((line) => line.trimStart().replace(/^(?:>[ \t]?)*/, "").startsWith("$$"))) {
        for (let index = first; index <= last; index += 1) {
          infos[index] = { kind: "protected", note: "display math is not prose" };
        }
        return false;
      }
      for (let index = first; index <= last; index += 1) {
        const prefixLen =
          index === first ? contentFrom - starts[index] : (prefixPattern.exec(lines[index])?.[0].length ?? 0);
        const content = lines[index].slice(prefixLen);
        if (ALERT.test(content.trim())) {
          infos[index] = { kind: "protected" };
          continue;
        }
        const lead = lines[index].slice(0, prefixLen);
        infos[index] = {
          kind: "text",
          start: index === first || infos[index - 1]?.kind !== "text",
          prefixLen,
          // A list marker or task box becomes spaces; quote markers stay.
          contPrefix: lead.replace(/[^\s>]/g, " "),
          breakAfter: endsWithBreak(lines[index]) && index < last,
        };
      }
      return false;
    },
  });
  return infos;
}

function unbreakable(segment: string): Array<[number, number]> {
  const ranges = backtickSpans(segment);
  ranges.push(...delimitedSpans(segment, "$"));
  // Autolinks, inline HTML tags and link destinations.
  for (const match of segment.matchAll(/<[^<>\n]*>|\]\([^)\n]*\)|\]\[[^\]\n]*\]/g)) {
    ranges.push([match.index, match.index + match[0].length]);
  }
  return ranges;
}

export const markdownDialect: Dialect = { classify, isStructural, endsWithBreak, unbreakable };
