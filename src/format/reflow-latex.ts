//! LaTeX rules for paragraph reflow.
//!
//! Protected by default: the preamble, every environment that is not known to
//! hold running prose, display math, comment lines, and any line that starts
//! with a command not on the inline list. A line with a `%` comment keeps its
//! newline, because the newline after a comment is not a space: joining it to
//! the next line would comment that text out.

import { commentStart, maskLiteralRegions } from "../latex-references.ts";
import { delimitedSpans, escaped, indentOf, linesOf, type Dialect, type LineInfo } from "./reflow.ts";

/** Environments whose body is running prose. Everything else is protected. */
const PROSE_ENVIRONMENTS = new Set([
  "document",
  "quote",
  "quotation",
  "abstract",
  "itemize",
  "enumerate",
  "description",
  "center",
  "flushleft",
  "flushright",
  "minipage",
  "proof",
  "theorem",
  "lemma",
  "corollary",
  "proposition",
  "definition",
  "remark",
  "example",
]);

/**
 * Commands that may start a line of running text. A line starting with any
 * other command is structure (`\section`, `\label`, `\centering`, a macro the
 * engine does not know) and is left alone.
 */
const INLINE_COMMANDS = new Set([
  "textbf", "textit", "texttt", "textsc", "textsf", "textrm", "textsl", "textup", "textmd",
  "emph", "underline", "uline", "sout", "textsubscript", "textsuperscript", "textcolor",
  "ref", "eqref", "pageref", "autoref", "cref", "Cref", "nameref",
  "cite", "citep", "citet", "citeauthor", "citeyear", "parencite", "textcite",
  "href", "url", "footnote", "verb", "lstinline", "mbox", "noindent",
  "LaTeX", "TeX", "ldots", "dots", "enquote", "og", "fg", "S", "P", "(", ",", "@",
]);

/** Text-formatting commands whose argument `maskLiteralRegions` blanks. */
const MASKED_TEXT_COMMAND =
  /^\s*\\(?:texttt|textbf|textit|textrm|textsf|textsc|textsl|textup|textmd|emph|mbox|hbox|text)\s*\{/;

/** The command name at the start of a trimmed line, or null. */
function leadingCommand(trimmed: string): string | null {
  if (!trimmed.startsWith("\\")) return null;
  const word = /^\\([A-Za-z@]+\*?|.)/.exec(trimmed);
  return word ? word[1] : "";
}

function isStructural(line: string): boolean {
  const trimmed = line.trimStart();
  if (trimmed.startsWith("%")) return true;
  const command = leadingCommand(trimmed);
  if (command === null) return false;
  return !INLINE_COMMANDS.has(command.replace(/\*$/, ""));
}

/** The code part of a masked line (before its comment). */
function codeOf(masked: string): string {
  const at = commentStart(masked);
  return at < 0 ? masked : masked.slice(0, at);
}

/** A line ends in `\\`, `\\*` or `\\[len]` — a forced line break. */
function endsWithForcedBreak(code: string): boolean {
  const trimmed = code.trimEnd().replace(/\[[^\]]*\]$/, "").replace(/\*$/, "");
  if (!trimmed.endsWith("\\\\")) return false;
  // `\\\\` is two breaks; `\\\` is a break then a control symbol. Only an even
  // run of backslashes ends in a break.
  const run = /\\+$/.exec(trimmed)?.[0].length ?? 0;
  return run % 2 === 0;
}

function endsWithBreak(line: string): boolean {
  if (commentStart(line) >= 0) return true;
  return endsWithForcedBreak(line);
}

/** Offsets of unescaped `\[`, `\]` (not `\\[`) in a line. */
function displayMathMarks(code: string): { opens: number; closes: number } {
  let opens = 0;
  let closes = 0;
  for (let at = 1; at < code.length; at += 1) {
    if (code[at - 1] !== "\\" || escaped(code, at - 1)) continue;
    if (code[at] === "[") opens += 1;
    else if (code[at] === "]") closes += 1;
  }
  return { opens, closes };
}

function classify(text: string): LineInfo[] {
  const lines = linesOf(text);
  const masked = linesOf(maskLiteralRegions(text));
  const infos: LineInfo[] = [];

  const hasClass = /^\s*\\documentclass\b/m.test(maskLiteralRegions(text));
  const bodyStart = masked.findIndex((line) => /\\begin\s*\{document\}/.test(codeOf(line)));
  // A file without `\begin{document}` is an `\input` chapter: all body. A file
  // with a class but no document environment is all preamble.
  let inBody = bodyStart < 0 ? !hasClass : false;
  let ended = false;
  const stack: string[] = [];
  let displayMath = 0;
  let dollars = false;

  lines.forEach((line, index) => {
    const code = codeOf(masked[index]);
    const trimmed = line.trim();
    const protect = (note?: string) => infos.push({ kind: "protected", note });

    if (!inBody || ended) {
      if (index === bodyStart) inBody = true;
      protect(trimmed && !ended && !inBody ? "the preamble is not prose" : undefined);
      return;
    }
    if (/\\end\s*\{document\}/.test(code)) ended = true;

    // Environment and display-math state, read from the masked code so a
    // `\begin` inside `\verb` or a comment does not count.
    const envs = [...code.matchAll(/\\(begin|end)\s*\{([^}]*)\}/g)];
    const marks = displayMathMarks(code);
    const dollarCount = (code.match(/(?<!\\)\$\$/g) ?? []).length;
    const wasMath = displayMath > 0 || dollars;
    for (const [, kind, name] of envs) {
      if (kind === "begin") stack.push(name.trim());
      else {
        const at = stack.lastIndexOf(name.trim());
        if (at >= 0) stack.length = at;
      }
    }
    displayMath = Math.max(0, displayMath + marks.opens - marks.closes);
    if (dollarCount % 2 === 1) dollars = !dollars;

    if (!trimmed) return void infos.push({ kind: "blank" });
    if (envs.length || marks.opens || marks.closes || dollarCount || wasMath) return protect();
    const env = stack[stack.length - 1];
    if (env !== undefined && !PROSE_ENVIRONMENTS.has(env.replace(/\*$/, ""))) {
      return protect(`the ${env} environment is not prose`);
    }
    if (trimmed.startsWith("%")) return protect();
    // A line the literal mask blanked entirely is `\verb`, a listing or
    // `\iffalse` text — unless it is a formatting command with prose inside.
    if (!masked[index].trim() && !MASKED_TEXT_COMMAND.test(line)) return protect();
    if (/\\par\b/.test(code)) return protect();

    const command = leadingCommand(trimmed);
    const breakAfter = commentStart(masked[index]) >= 0 || endsWithForcedBreak(code);
    if (command === "item") {
      const marker = /^[ \t]*\\item\b\s*(?:\[[^\]]*\]\s*)?/.exec(line)?.[0] ?? "";
      const indent = indentOf(line);
      return void infos.push({
        kind: "text",
        start: true,
        prefixLen: marker.length,
        contPrefix: `${indent}  `,
        breakAfter,
      });
    }
    if (command !== null && !INLINE_COMMANDS.has(command.replace(/\*$/, ""))) return protect();

    const previous = infos[index - 1];
    infos.push({
      kind: "text",
      prefixLen: indentOf(line).length,
      contPrefix: previous?.kind === "text" ? undefined : indentOf(line),
      breakAfter,
    });
  });
  return infos;
}

function unbreakable(segment: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const match of segment.matchAll(/\\verb\*?([^a-zA-Z\s*])[^\n]*?\1/g)) {
    ranges.push([match.index, match.index + match[0].length]);
  }
  for (const match of segment.matchAll(/\\lstinline\s*(?:\[[^\]]*\])?\s*([^a-zA-Z\s{])[^\n]*?\1/g)) {
    ranges.push([match.index, match.index + match[0].length]);
  }
  ranges.push(...delimitedSpans(segment, "$"));
  for (const match of segment.matchAll(/\\\([\s\S]*?\\\)/g)) {
    ranges.push([match.index, match.index + match[0].length]);
  }
  const comment = commentStart(maskLiteralRegions(segment));
  if (comment >= 0) ranges.push([comment - 1, segment.length + 1]);
  // A control space (`\ `) is one token: the space belongs to the backslash.
  for (let at = 1; at < segment.length; at += 1) {
    if (segment[at] === " " && segment[at - 1] === "\\" && !escaped(segment, at - 1)) {
      ranges.push([at - 2, at + 1]);
    }
  }
  return ranges;
}

export const latexDialect: Dialect = { classify, isStructural, endsWithBreak, unbreakable };
