//! AsciiDoc rules for paragraph reflow.
//!
//! The editor highlights AsciiDoc with a stream grammar, so there is no tree to
//! ask; this is a line classifier. It reuses the highlighter's delimiter table
//! so the two cannot disagree about where a listing or table begins.
//!
//! Two AsciiDoc features make a newline significant and are protected whole:
//! the `hardbreaks` option (per paragraph or per document) and the `verse`,
//! `source`, `literal` and similar paragraph styles. An indented first line is
//! a literal paragraph and is protected too.

import { DELIMITERS, isContentBlock, type BlockKind } from "../asciidoc-language.ts";
import { backtickSpans, indentOf, linesOf, type Dialect, type LineInfo } from "./reflow.ts";

/** Paragraph styles whose text is still ordinary prose. */
const PROSE_STYLES = new Set([
  "", "normal", "quote", "abstract", "partintro", "sidebar", "example",
  "note", "tip", "important", "warning", "caution",
]);

const LIST_ITEM = /^([ \t]*)(\*+|-|\.+|\d+\.|[a-zA-Z]\.|<\d+>)[ \t]+(?=\S)/;
const DESCRIPTION = /^([ \t]*)(?!\/\/)(\S.*?)(:{2,4}|;;)(?:[ \t]+(?=\S)|[ \t]*$)/;
const ADMONITION = /^(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION):[ \t]/;

function delimiterOf(line: string): { kind: BlockKind; delimiter: string } | null {
  const trimmed = line.trim();
  for (const [pattern, kind] of DELIMITERS) {
    if (pattern.test(trimmed)) return { kind, delimiter: trimmed };
  }
  return null;
}

/** Lines that are structure wherever they appear. */
function isStructural(line: string): boolean {
  const trimmed = line.trim();
  if (delimiterOf(line)) return true;
  return (
    /^(?:=+|#+)(?:[ \t]|$)/.test(trimmed) || // section title
    /^\.[^\s.]/.test(trimmed) || // block title
    /^\[.*\]$/.test(trimmed) || // block attributes or anchor
    /^:!?[\w][\w-]*!?:(?:[ \t]|$)/.test(trimmed) || // attribute entry
    /^\/\//.test(trimmed) || // comment
    /^(?:include|ifdef|ifndef|ifeval|endif)::/.test(trimmed) ||
    /^[a-z][\w-]*::\S*\[.*\]$/.test(trimmed) || // block macro
    trimmed === "+" ||
    /^(?:'{3,}|<{3,}|-{3}|\*{3})$/.test(trimmed) ||
    LIST_ITEM.test(line) ||
    /^\S.*?(?::{2,4}|;;)(?:[ \t]|$)/.test(trimmed) ||
    ADMONITION.test(trimmed) ||
    /^\|/.test(trimmed)
  );
}

function endsWithBreak(line: string): boolean {
  return /[ \t]\+$/.test(line.trimEnd()) || line.trim() === "+";
}

/** The style a block attribute line gives the next block, lower-cased. */
function styleOf(attributes: string): { style: string; hardbreaks: boolean } {
  const inner = attributes.trim().slice(1, -1);
  const hardbreaks = /(?:^|[,%])hardbreaks\b|options\s*=\s*"?[^"]*hardbreaks/.test(inner);
  // `[[anchor]]` and `[#id.role]` carry no style.
  if (inner.startsWith("[") || /^[#.%]/.test(inner)) return { style: "", hardbreaks };
  const first = inner.split(",")[0].trim().split(/[#.%]/)[0].toLowerCase();
  return { style: first, hardbreaks };
}

function classify(text: string): LineInfo[] {
  const lines = linesOf(text);
  const infos: LineInfo[] = [];
  const documentHardbreaks = lines.some((line) => /^:hardbreaks(?:-option)?:/.test(line.trim()));
  const stack: Array<{ kind: BlockKind; delimiter: string }> = [];
  // What the paragraph now being read is, decided on its first line.
  let paragraph: "none" | "prose" | "protected" = "none";
  let paragraphNote: string | undefined;
  let pending: { style: string; hardbreaks: boolean } | null = null;

  lines.forEach((line) => {
    const trimmed = line.trim();
    const protect = (note?: string) => infos.push({ kind: "protected", note });
    const top = stack[stack.length - 1];

    // Inside a listing, literal, passthrough, comment or table block only the
    // matching closing delimiter means anything.
    if (top && isContentBlock(top.kind)) {
      if (trimmed === top.delimiter) stack.pop();
      paragraph = "none";
      return protect(`a ${top.kind} block is not prose`);
    }
    const delimiter = delimiterOf(line);
    if (delimiter) {
      if (top && top.delimiter === delimiter.delimiter) stack.pop();
      else stack.push(delimiter);
      paragraph = "none";
      pending = null;
      return protect();
    }
    if (!trimmed) {
      paragraph = "none";
      pending = null;
      return void infos.push({ kind: "blank" });
    }
    if (documentHardbreaks) return protect("the document sets the hardbreaks option");

    if (paragraph === "protected") return protect(paragraphNote);
    if (paragraph === "prose") {
      // Inside a paragraph, a list item or other structure ends the run here;
      // anything else continues it.
      const item = LIST_ITEM.exec(line);
      if (item) return pushItem(item);
      if (isStructural(line)) return protect();
      return void infos.push({ kind: "text", prefixLen: indentOf(line).length, breakAfter: endsWithBreak(line) });
    }

    // A block attribute line styles whatever follows it.
    if (/^\[.*\]$/.test(trimmed) && !/^\[\[.*\]\]$/.test(trimmed)) {
      pending = styleOf(trimmed);
      return protect();
    }
    const item = LIST_ITEM.exec(line);
    if (item) return pushItem(item);
    const description = DESCRIPTION.exec(line);
    if (description && !/^[a-z][\w-]*::\S*\[/.test(trimmed)) {
      // A term with its text on the same line; a bare term is structure.
      if (description[0].length >= line.length) return protect();
      return pushStart(description[0].length, `${description[1]}`);
    }
    if (isStructural(line) && !ADMONITION.test(trimmed)) return protect();

    if (pending && (pending.hardbreaks || !PROSE_STYLES.has(pending.style))) {
      paragraph = "protected";
      paragraphNote = pending.hardbreaks
        ? "this paragraph keeps its line breaks (hardbreaks)"
        : `a [${pending.style}] paragraph is not prose`;
      pending = null;
      return protect(paragraphNote);
    }
    pending = null;
    if (/^[ \t]/.test(line)) {
      paragraph = "protected";
      paragraphNote = "an indented first line makes a literal paragraph";
      return protect(paragraphNote);
    }
    return pushStart(0, "");

    function pushItem(match: RegExpExecArray) {
      pending = null;
      return pushStart(match[0].length, `${match[1]}`);
    }
    function pushStart(prefixLen: number, contPrefix: string) {
      paragraph = "prose";
      infos.push({ kind: "text", start: true, prefixLen, contPrefix, breakAfter: endsWithBreak(line) });
    }
  });
  return infos;
}

function unbreakable(segment: string): Array<[number, number]> {
  const ranges = backtickSpans(segment);
  // Passthroughs, inline macros with their target and attribute list, and
  // cross references.
  for (const match of segment.matchAll(
    /\+\+\+[\s\S]*?\+\+\+|\+[^+\s][^+]*?\+|pass:[a-z,]*\[[^\]]*\]|[a-z][\w-]*:\S*?\[[^\]]*\]|<<[^>]*>>/g,
  )) {
    ranges.push([match.index, match.index + match[0].length]);
  }
  return ranges;
}

export const asciidocDialect: Dialect = { classify, isStructural, endsWithBreak, unbreakable };
