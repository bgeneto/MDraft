//! Prose-format word extraction, kept separate from editor decorations.

import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import { latexSkipRanges } from "./latex.ts";
import { passageWords } from "./words.ts";
import type { WebPassage } from "./web-passages.ts";

export const ALLOWED = new Set([
  "mdraft",
  "tauri",
  "codemirror",
  "pandoc",
  "typst",
  "katex",
  "mermaid",
  "webview2",
  "github",
  "asciidoc",
  "asciidoctor",
  "asciimath",
  "latexmath",
]);

/** Nodes whose text is not prose. Link labels and image alt text stay. */
const SKIP_NODES = new Set([
  "FencedCode",
  "CodeBlock",
  "InlineCode",
  "URL",
  "Autolink",
  "HTMLBlock",
  "HTMLTag",
  "Comment",
  // Typst's structural parser names code and definitions separately.
  "Raw",
  "Code",
  "CodeText",
  "LineComment",
  "BlockComment",
  "Equation",
  "LetBinding",
  "SetRule",
  "ShowRule",
  "Import",
  "Include",
  // AsciiDoc stream token names.
  "monospace",
  "listing",
  "literal",
  "passthrough",
  "comment",
  "meta",
]);

function acceptedForm(word: string): string | null {
  const trimmed = word.replace(/^['\u2019\u2018-]+|['\u2019\u2018-]+$/gu, "");
  if (!trimmed) return null;
  let letters = 0;
  let uppers = 0;
  let seenLetter = false;
  let internalCapital = false;
  let normalized = "";
  for (const ch of trimmed) {
    if (/\p{N}/u.test(ch)) return null;
    const folded = ch === "\u2019" || ch === "\u2018" || ch === "\u02BC" ? "'" : ch;
    if (/\p{L}/u.test(folded)) {
      letters += 1;
      if (folded === folded.toUpperCase() && folded !== folded.toLowerCase()) uppers += 1;
      if (seenLetter && folded >= "A" && folded <= "Z") internalCapital = true;
      seenLetter = true;
    }
    normalized += folded;
  }
  if (letters === 0 || internalCapital || (uppers === letters && letters >= 2)) return null;
  if (ALLOWED.has(normalized.toLowerCase())) return null;
  return normalized;
}

function frontMatterEnd(state: EditorState): number {
  const text = state.doc.sliceString(0, Math.min(state.doc.length, 8_000));
  if (!text.startsWith("---\n") && !text.startsWith("---\r\n")) return 0;
  const lines = text.split(/\r?\n/);
  let offset = lines[0].length + (text.startsWith("---\r\n") ? 2 : 1);
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---") return offset + lines[i].length + 1;
    offset += lines[i].length + 1;
  }
  return 0;
}

/**
 * The ranges a LaTeX document must not be spell-checked in.
 *
 * The shared list already covers `$…$`, `\[…\]`, URLs and angle brackets, which
 * LaTeX uses too. What it cannot know is that LaTeX spells its structure as
 * commands: `\documentclass{article}` would underline `documentclass` and
 * `article`, and `\begin{figure}` would underline both. This pass covers the
 * command names, their brace arguments, the verbatim-like environments, the
 * preamble, and `%` comments — leaving the prose inside `\section{…}`,
 * `\textbf{…}` and the body for the checker, which is the point.
 */
function latexSkips(text: string, base: number): Array<[number, number]> {
  return latexSkipRanges(text, base);
}

function extraSkips(text: string, base: number, documentLanguage: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const patterns = [
    /\$\$[\s\S]*?\$\$/g,
    /\\\([\s\S]*?\\\)/g,
    /\\\[[\s\S]*?\\\]/g,
    /\$[^\s$][^$\n]*[^\s$]\$/g,
    /\$[^\s$\n]\$/g,
    /https?:\/\/\S+/g,
    /www\.\S+/g,
    /<[^>\n]{1,200}>/g,
    // AsciiDoc markup that is not prose.
    /image::?[^[\n]*\[[^\]]*\]/g,
    /(?:include|xref|link|footnote|kbd|btn|menu|latexmath|stem):[^\s[]*\[[^\]]*\]/g,
    /^:[A-Za-z0-9_-]+:.*$/gm,
    /<<[^>\n]+>>/g,
    /\[\[[^\]\n]+\]\]/g,
    /^\s{0,3}(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION):/gm,
  ];
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let match = pattern.exec(text);
    while (match) {
      ranges.push([base + match.index, base + match.index + match[0].length]);
      match = pattern.exec(text);
    }
  }
  if (documentLanguage === "latex") ranges.push(...latexSkips(text, base));
  return ranges;
}

export interface WordHit {
  from: number;
  to: number;
  form: string;
}

export function collectWords(
  state: EditorState,
  from: number,
  to: number,
  ignored: Set<string>,
  documentLanguage: string,
  parsedTree?: ReturnType<typeof syntaxTree>,
): WordHit[] {
  const tree = parsedTree ?? syntaxTree(state);
  const skipped: Array<[number, number]> = [];
  const matter = frontMatterEnd(state);
  if (matter > from) skipped.push([from, Math.min(matter, to)]);
  tree.iterate({
    from,
    to,
    enter(node) {
      if (SKIP_NODES.has(node.name)) {
        skipped.push([Math.max(node.from, from), Math.min(node.to, to)]);
        return false;
      }
    },
  });
  const slice = state.doc.sliceString(from, to);
  skipped.push(...extraSkips(slice, from, documentLanguage));

  const passage: WebPassage = {
    from,
    to,
    kind: "text",
    language: null,
    text: slice,
    offsets: Array.from({ length: slice.length + 1 }, (_, index) => index),
    encoding: "plain",
    quote: "",
  };
  return passageWords(
    passage,
    (start, end) => state.sliceDoc(start, end),
    null,
    state.doc.length,
  ).flatMap((word) => {
    if (skipped.some(([start, end]) => word.from < end && word.to > start)) return [];
    const form = acceptedForm(word.word);
    return form && !ignored.has(form.toLowerCase()) ? [{ from: word.from, to: word.to, form }] : [];
  });
}
