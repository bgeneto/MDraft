//! What the LaTeX popup should offer at a given position.
//!
//! Pure functions over the text before the cursor, so the whole decision table is
//! a unit test with no editor, no DOM and no parser. The rules are deliberately
//! conservative: a popup that opens where nothing can follow is worse than one
//! that stays closed, because it interrupts typing and teaches the reader to
//! ignore it.
//!
//! The cases that must offer **nothing** matter as much as the ones that offer
//! something: inside a `%` comment, inside a verbatim-like environment, and after
//! `\\` (a line break, not the start of a command).

/** Which catalog a position asks for. */
export type LatexContextKind =
  "command" | "environment" | "package" | "class" | "label" | "citation" | "image" | "none";

export interface LatexContext {
  kind: LatexContextKind;
  /** The partial word already typed, which the popup filters against. */
  prefix: string;
}

const NOTHING: LatexContext = { kind: "none", prefix: "" };

/** The line containing `offset`, from its start to `offset`. */
function lineBefore(text: string, offset: number): string {
  const at = Math.max(0, Math.min(offset, text.length));
  const start = text.lastIndexOf("\n", Math.max(0, at - 1)) + 1;
  return text.slice(start, at);
}

/**
 * Whether the position sits inside a `%` comment.
 *
 * A `%` starts a comment unless it is escaped as `\%`. Counting the backslashes
 * before it is what distinguishes the two; a single check for `\%` gets
 * `\\%` (a line break followed by a comment) wrong.
 */
function inComment(line: string): boolean {
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] !== "%") continue;
    let slashes = 0;
    for (let back = index - 1; back >= 0 && line[back] === "\\"; back -= 1) slashes += 1;
    if (slashes % 2 === 0) return true;
  }
  return false;
}

/** The verbatim-like environments whose bodies are literal text. */
const VERBATIM = /\\begin\{(verbatim\*?|Verbatim\*?|lstlisting|minted|alltt)\}/g;

/**
 * Whether the position sits inside a verbatim-like environment.
 *
 * Counted from the start of the document because the environment can begin on an
 * earlier line. The `\end` of the same name closes it; a nested different
 * environment is ignored, which is right for these bodies because they do not
 * nest.
 */
function inVerbatim(text: string, offset: number): boolean {
  const head = text.slice(0, offset);
  VERBATIM.lastIndex = 0;
  let open: string | null = null;
  let match: RegExpExecArray | null;
  while ((match = VERBATIM.exec(head)) !== null) {
    const name = match[1];
    if (open === null) {
      open = name;
    } else if (open === name) {
      open = null;
    }
  }
  if (open === null) return false;
  // The closing `\end{…}` for the open environment must not already be behind
  // the cursor.
  return !new RegExp(`\\\\end\\{${open.replace("*", "\\*")}\\}`).test(
    head.slice(head.lastIndexOf(`\\begin{${open}}`)),
  );
}

/**
 * The context at `offset`.
 *
 * Ordered from the most specific argument to the least: an argument's opening
 * brace is checked before the bare command, and the comment and verbatim checks
 * come first because nothing inside them is markup.
 */
export function latexContextAt(text: string, offset: number): LatexContext {
  const line = lineBefore(text, offset);
  if (inComment(line) || inVerbatim(text, offset)) return NOTHING;

  // `\usepackage[opts]{…}` and `\documentclass[opts]{…}` take their name in the
  // last brace group, so the whole line is searched rather than the tail.
  const argument = (command: string): string | null => {
    const pattern = new RegExp(
      `\\\\${command}\\s*(?:\\[[^\\]]*\\])?\\s*(?:\\{[^{}]*\\}\\s*,\\s*)*\\{([^{}]*)$`,
    );
    const match = pattern.exec(line);
    return match ? match[1] : null;
  };

  for (const [command, kind] of [
    ["usepackage", "package"],
    ["RequirePackage", "package"],
    ["documentclass", "class"],
    ["begin", "environment"],
    ["end", "environment"],
    ["ref", "label"],
    ["eqref", "label"],
    ["pageref", "label"],
    ["cite", "citation"],
    ["citep", "citation"],
    ["citet", "citation"],
    ["includegraphics", "image"],
  ] as const) {
    const prefix = argument(command);
    if (prefix !== null) return { kind, prefix };
  }

  // A command name being typed: a backslash followed by letters, with no closing
  // brace or space yet. `\\` is a line break, so it must not match — the two
  // backslashes are consumed as one token.
  const command = /(?:^|[^\\])\\([a-zA-Z@]*)$/.exec(line);
  if (command) return { kind: "command", prefix: command[1] };

  return NOTHING;
}

/**
 * The entries a context should offer, filtered by its prefix.
 *
 * Filtering is a case-insensitive prefix match rather than a fuzzy one: it is
 * predictable, cheap, and the popup already narrows as the reader types. A
 * reader who knows the command types its first letters; one who does not reads
 * the list.
 */
export function filterByPrefix<T extends { label: string }>(
  entries: readonly T[],
  prefix: string,
): T[] {
  if (!prefix) return [...entries];
  const needle = prefix.toLowerCase();
  return entries.filter((entry) => entry.label.toLowerCase().startsWith(needle));
}
