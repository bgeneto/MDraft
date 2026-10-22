//! Original-source Markdown regions whose characters are not prose.
//! Lezer supplies offsets without normalizing CRLF or reserializing markup.
import { markdownLanguage } from "@codemirror/lang-markdown";

export interface SourceRange {
  from: number;
  to: number;
  /** URLs block dollar openers, but markup-shaped TeX may enclose a URL node. */
  barrier?: boolean;
}

export function markdownCodeSpans(source: string): SourceRange[] {
  const ranges: SourceRange[] = [];
  markdownLanguage.parser.parse(source).iterate({
    enter(node) {
      if (node.name === "InlineCode") {
        ranges.push({ from: node.from, to: node.to });
        return false;
      }
    },
  });
  return ranges;
}

const PROTECTED = new Set([
  "FencedCode",
  "CodeBlock",
  "InlineCode",
  "URL",
  "LinkTitle",
  "LinkReference",
  "Autolink",
  "HTMLTag",
  "CommentBlock",
  "ProcessingInstructionBlock",
]);

export function markdownProtectedRanges(source: string): SourceRange[] {
  const ranges: SourceRange[] = [];
  markdownLanguage.parser.parse(source).iterate({
    enter(node) {
      if (PROTECTED.has(node.name)) {
        ranges.push({
          from: node.from,
          to: node.to,
          barrier: !["URL", "LinkTitle", "Autolink"].includes(node.name),
        });
        return false;
      }
    },
  });
  // HTMLBlock is deliberately not protected wholesale: its visible text can
  // contain money/math. Protect tag syntax, comments, and raw code contents.
  const tags =
    /<!--[\s\S]*?(?:-->|$)|<(?:pre|code|script|style|textarea)\b[^>]*>[\s\S]*?(?:<\/(?:pre|code|script|style|textarea)\s*>|$)|<\/?[A-Za-z][\w:-]*(?:\s(?:"[^"]*"|'[^']*'|[^<>"'])*)?\s*\/?>|<\?[^>]*\?>/gi;
  for (const match of source.matchAll(tags)) {
    ranges.push({ from: match.index, to: match.index + match[0].length, barrier: true });
  }
  ranges.sort((a, b) => a.from - b.from || b.to - a.to);
  const merged: SourceRange[] = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range.from <= last.to) {
      last.to = Math.max(last.to, range.to);
      last.barrier = last.barrier !== false || range.barrier !== false;
    } else merged.push({ ...range });
  }
  return merged;
}
