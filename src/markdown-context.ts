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
  if (!source.includes("`")) return [];
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
  return markdownScanProtectedAndCode(source, false).protectedRanges;
}

/** A ```math fence: display math written the way GitHub and GitLab accept it. */
export interface MathFence {
  from: number;
  to: number;
  body: string;
}

/** Cheap gate: could the source hold a ```math fence at all? */
export function hasMathFence(source: string): boolean {
  return /^[ \t>]*(?:`{3,}|~{3,})[ \t]*math[ \t]*$/im.test(source);
}

/**
 * Extract inline code spans, math-protected ranges and ```math fences in a
 * single Lezer parse so `renderChunks` never parses the source twice.
 */
export function markdownScanProtectedAndCode(
  source: string,
  collectCode = true,
): { codeSpans: SourceRange[]; protectedRanges: SourceRange[]; mathFences: MathFence[] } {
  const codeSpans: SourceRange[] = [];
  const ranges: SourceRange[] = [];
  const mathFences: MathFence[] = [];
  markdownLanguage.parser.parse(source).iterate({
    enter(node) {
      if (collectCode && node.name === "InlineCode") {
        codeSpans.push({ from: node.from, to: node.to });
      }
      if (node.name === "FencedCode") {
        const info = node.node.getChild("CodeInfo");
        if (info && source.slice(info.from, info.to).trim().toLowerCase() === "math") {
          // Inside a block quote every body line still carries its `>` prefix;
          // such a fence stays a code block rather than feed TeX a quote marker.
          let quoted = false;
          for (let up = node.node.parent; up; up = up.parent) {
            if (up.name === "Blockquote") quoted = true;
          }
          if (!quoted) {
            const text = node.node.getChild("CodeText");
            mathFences.push({
              from: node.from,
              to: node.to,
              body: text ? source.slice(text.from, text.to).trim() : "",
            });
          }
        }
      }
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
  if (source.includes("<")) {
    const tags =
      /<!--[\s\S]*?(?:-->|$)|<(?:pre|code|script|style|textarea)\b[^>]*>[\s\S]*?(?:<\/(?:pre|code|script|style|textarea)\s*>|$)|<\/?[A-Za-z][\w:-]*(?:\s(?:"[^"]*"|'[^']*'|[^<>"'])*)?\s*\/?>|<\?[^>]*\?>/gi;
    for (const match of source.matchAll(tags)) {
      ranges.push({ from: match.index, to: match.index + match[0].length, barrier: true });
    }
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
  return { codeSpans, protectedRanges: merged, mathFences };
}
