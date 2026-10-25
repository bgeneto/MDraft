//! The Typst side of the Paragraph and Format menus.
//!
//! Pure strings and line transforms. Keeping them here, instead of in the
//! shell's command switch, gives the unit suite one place to check every
//! construct without an editor and makes the Markdown/AsciiDoc/HTML branches
//! stay visibly separate.
//!
//! Typst markup is not Markdown with different punctuation: a heading is `=`,
//! strong is `*`, emphasis is `_`, an ordered list is `+`, a quote is
//! `#quote(...)`, a table is `#table(...)` and a TOC is `#outline()`. Inserting
//! the Markdown spelling does not degrade gracefully; it usually stops the
//! document compiling.

export interface TypstInsertion {
  text: string;
  /** Caret offset into `text` after the insertion. */
  caret: number;
}

export const TYPST_HEADING_MAX = 6;

export const TYPST_RULE = "#line(length: 100%)";
export const TYPST_OUTLINE = "#outline()";

/** Display math needs a space inside both delimiters; `$$` is not Typst. */
export const TYPST_DISPLAY_MATH: TypstInsertion = {
  text: "$ \n\n $",
  caret: 3,
};

export const TYPST_QUOTE: TypstInsertion = (() => {
  const open = "#quote(block: true)[";
  return { text: `${open}\n\n]`, caret: open.length + 1 };
})();

export const TYPST_TABLE: TypstInsertion = (() => {
  const text = ["#table(", "  columns: 2,", "  [Column], [Column],", "  [Cell], [Cell],", ")"].join(
    "\n",
  );
  return { text, caret: text.indexOf("[") + 1 };
})();

/** Rewrite one line as a Typst heading; level 0 removes the heading. */
export function typstHeadingLine(line: string, level: number): string {
  const indent = /^\s*/.exec(line)?.[0] ?? "";
  const body = line
    .slice(indent.length)
    .replace(/^={1,6}\s+/, "")
    .trimStart();
  if (level <= 0) return `${indent}${body}`;
  const markers = "=".repeat(Math.min(TYPST_HEADING_MAX, Math.max(1, level)));
  return `${indent}${markers}${body ? ` ${body}` : ""}`;
}

/** Move a line one Typst heading level up (-1) or down (+1). */
export function typstShiftHeadingLine(line: string, delta: number): string {
  const indent = /^\s*/.exec(line)?.[0] ?? "";
  const body = line.slice(indent.length);
  const match = /^(={1,6})(?:\s+(.*))?$/.exec(body);
  if (!match) {
    // A plain paragraph becomes the first heading when pushed up, matching the
    // Markdown command's behaviour.
    return delta < 0 ? `${indent}=${body ? ` ${body}` : ""}` : line;
  }
  const next = Math.min(TYPST_HEADING_MAX, Math.max(1, match[1].length + delta));
  const text = match[2] ?? "";
  return `${indent}${"=".repeat(next)}${text ? ` ${text}` : ""}`;
}

export type TypstInlineKind = "strong" | "emphasis" | "strike" | "code" | "link" | "math";

export interface TypstInline {
  before: string;
  after: string;
  placeholder: string;
}

export function typstInline(kind: TypstInlineKind): TypstInline {
  switch (kind) {
    case "strong":
      return { before: "*", after: "*", placeholder: "strong text" };
    case "emphasis":
      return { before: "_", after: "_", placeholder: "emphasis" };
    case "strike":
      return { before: "#strike[", after: "]", placeholder: "strikethrough" };
    case "code":
      return { before: "`", after: "`", placeholder: "code" };
    case "link":
      return {
        before: '#link("https://")[',
        after: "]",
        placeholder: "link text",
      };
    case "math":
      return { before: "$", after: "$", placeholder: "e^{i\\pi}+1=0" };
  }
}

export type TypstUnsupported = "task" | "alert" | "frontMatter";

/** Why a command has no Typst insertion, and what to use instead. */
export function typstUnsupported(kind: TypstUnsupported): string {
  switch (kind) {
    case "task":
      return "Typst has no task-list syntax. Use a bullet list, or keep the task list in Markdown.";
    case "alert":
      return "Typst has no GitHub alerts. Use a styled block, or keep the alert in Markdown.";
    case "frontMatter":
      return "Typst has no YAML front matter. Use #set document(title: ...) instead.";
  }
}
