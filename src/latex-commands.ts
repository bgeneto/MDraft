//! The LaTeX side of the Insert and Format menus.
//!
//! Pure strings and line transforms, for the same reason `typst-commands.ts`
//! exists: the unit suite can check every construct without an editor, and the
//! Markdown/HTML/AsciiDoc branches stay visibly separate from LaTeX's.
//!
//! LaTeX is not Markdown with different punctuation either. Emphasis is
//! `\emph{}`, not `*…*`; a quote is the `quote` environment; a rule is
//! `\hrule`/`\rule`; a table needs a `tabular` with a column specification; and
//! the four math modes are `$…$`, `\[…\]`, `equation` and `align`. Inserting the
//! Markdown spelling does not degrade gracefully — `*bold*` typesets two literal
//! asterisks, and `---` becomes an em dash.

export interface LatexInsertion {
  text: string;
  /** Caret offset into `text` after the insertion. */
  caret: number;
}

/**
 * The sectioning commands, shallowest first.
 *
 * `\chapter` is only defined by the book and report classes, so `\section` is
 * the reliable top level and the one level 1 maps to. The menu's six heading
 * rows therefore cover part, section, subsection, subsubsection, paragraph and
 * subparagraph, which is every level an article class has.
 */
export const LATEX_HEADINGS = [
  "part",
  "section",
  "subsection",
  "subsubsection",
  "paragraph",
  "subparagraph",
] as const;

export const LATEX_HEADING_MAX = LATEX_HEADINGS.length;

/** The command for a menu heading level (1-based), or null for a paragraph. */
export function latexHeadingCommand(level: number): string | null {
  if (level <= 0) return null;
  const index = Math.min(LATEX_HEADING_MAX, Math.max(1, level)) - 1;
  return LATEX_HEADINGS[index];
}

/** The heading level a command name represents, or 0 when it is not one. */
export function latexHeadingLevel(command: string): number {
  const index = LATEX_HEADINGS.indexOf(command as (typeof LATEX_HEADINGS)[number]);
  return index < 0 ? 0 : index + 1;
}

/**
 * Rewrite one line as a LaTeX sectioning command; level 0 removes it.
 *
 * The existing command on the line is replaced rather than nested, so pressing
 * Heading 2 on a `\section{…}` line renames the command instead of producing
 * `\subsection{\section{…}}`. A line that is not already a heading becomes
 * `\section{<line>}`, which is what the reader meant by "make this a heading".
 */
export function latexHeadingLine(line: string, level: number): string {
  const indent = /^\s*/.exec(line)?.[0] ?? "";
  const body = line.slice(indent.length);
  const existing = /^\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)(\*?)\s*\{([\s\S]*)\}\s*$/.exec(
    body,
  );
  const command = latexHeadingCommand(level);
  if (command === null) return `${indent}${existing ? existing[3] : body}`;
  const text = existing ? existing[3] : body;
  return `${indent}\\${command}{${text}}`;
}

/** Move a line one heading level up (-1) or down (+1). */
export function latexShiftHeadingLine(line: string, delta: number): string {
  const indent = /^\s*/.exec(line)?.[0] ?? "";
  const body = line.slice(indent.length);
  const existing = /^\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)(\*?)\s*\{([\s\S]*)\}\s*$/.exec(
    body,
  );
  if (!existing) {
    // A plain paragraph becomes the first heading when pushed up, matching the
    // Markdown and Typst commands.
    return delta < 0 ? `${indent}\\section{${body}}` : line;
  }
  const current = latexHeadingLevel(existing[1]);
  const next = Math.min(LATEX_HEADING_MAX, Math.max(1, current + delta));
  const command = LATEX_HEADINGS[next - 1];
  return `${indent}\\${command}${existing[2]}{${existing[3]}}`;
}

export const LATEX_RULE = "\\noindent\\rule{\\linewidth}{0.4pt}";
export const LATEX_TOC = "\\tableofcontents";
export const LATEX_DISPLAY_MATH = "\\[\n\n\\]";

export const LATEX_QUOTE: LatexInsertion = (() => {
  const text = "\\begin{quote}\n\n\\end{quote}";
  return { text, caret: text.indexOf("\n") + 1 };
})();

export const LATEX_CODE: LatexInsertion = (() => {
  const text = "\\begin{verbatim}\n\n\\end{verbatim}";
  return { text, caret: text.indexOf("\n") + 1 };
})();

export const LATEX_TABLE: LatexInsertion = (() => {
  // Two columns, a header rule and a body rule: the smallest tabular that
  // compiles on its own and shows where the rows go.
  const text = [
    "\\begin{table}[htbp]",
    "  \\centering",
    "  \\begin{tabular}{ll}",
    "    \\hline",
    "    Column & Column \\\\",
    "    \\hline",
    "    Cell & Cell \\\\",
    "    \\hline",
    "  \\end{tabular}",
    "\\end{table}",
  ].join("\n");
  return { text, caret: text.indexOf("Column") };
})();

export const LATEX_ALIGN: LatexInsertion = (() => {
  const text = "\\begin{align}\n\n\\end{align}";
  return { text, caret: text.indexOf("\n") + 1 };
})();

export type LatexInlineKind = "bold" | "italic" | "strike" | "code" | "link" | "math";

export interface LatexInline {
  before: string;
  after: string;
  placeholder: string;
}

/**
 * The inline wrappers.
 *
 * `\sout` needs `ulem` and `\href` needs `hyperref`; both are in every TeX Live
 * scheme MDraft installs, and a document that loads neither still compiles the
 * command as an error only if it is used — which is the reader's choice to make,
 * not a reason to offer nothing.
 */
export function latexInline(kind: LatexInlineKind): LatexInline {
  switch (kind) {
    case "bold":
      return { before: "\\textbf{", after: "}", placeholder: "strong text" };
    case "italic":
      return { before: "\\emph{", after: "}", placeholder: "emphasis" };
    case "strike":
      return { before: "\\sout{", after: "}", placeholder: "strikethrough" };
    case "code":
      return { before: "\\texttt{", after: "}", placeholder: "code" };
    case "link":
      return { before: "\\href{https://}{", after: "}", placeholder: "link text" };
    case "math":
      return { before: "$", after: "$", placeholder: "e^{i\\pi}+1=0" };
  }
}

export type LatexUnsupported = "task" | "alert" | "frontMatter";

/** Why a command has no LaTeX insertion, and what to use instead. */
export function latexUnsupported(kind: LatexUnsupported): string {
  switch (kind) {
    case "task":
      return "LaTeX has no task-list syntax. Use the itemize environment with \\item[\\checkmark].";
    case "alert":
      return "LaTeX has no GitHub alerts. Use a tcolorbox or the quote environment.";
    case "frontMatter":
      return "LaTeX has no YAML front matter. Use \\title{}, \\author{} and \\date{} in the preamble.";
  }
}
