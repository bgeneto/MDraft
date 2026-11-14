//! Pure text transforms behind Edit › Lines and Edit › Blank Operations.
//!
//! The editor supplies the selected line block as an array of lines without
//! their line breaks. Keeping the transforms here makes the reordering and
//! whitespace rules testable without a DOM, a view or a running application,
//! which is where the subtle cases — trailing tabs, a remainder after a tab
//! stop, blank lines in a join — are easiest to pin.

/** The two-space width the editor's `indentUnit` uses. */
export const BLANK_TAB_WIDTH = 2;

export type SortDirection = "asc" | "desc";

/** The editor's whitespace-separated word rule, shared by the status bar. */
export function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed === "" ? 0 : trimmed.split(/\s+/u).length;
}

function compareCodepoints(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Stable codepoint order.
 *
 * Locale collation would make the same command produce a different file on
 * Windows and Linux. Codepoint order is stable, reproducible and easy to
 * explain; it is also what a plain `.sort()` gives for ASCII markup.
 */
export function sortLines(lines: readonly string[], direction: SortDirection): string[] {
  const compare =
    direction === "asc" ? compareCodepoints : (a: string, b: string) => -compareCodepoints(a, b);
  return [...lines].sort(compare);
}

/** Keep the first occurrence of each line, preserving the original order. */
export function dedupeLines(lines: readonly string[]): string[] {
  const seen = new Set<string>();
  return lines.filter((line) => {
    if (seen.has(line)) return false;
    seen.add(line);
    return true;
  });
}

function trimTrailing(line: string): string {
  return line.replace(/[ \t]+$/u, "");
}

function trimLeading(line: string): string {
  return line.replace(/^[ \t]+/u, "");
}

function trimBoth(line: string): string {
  return trimLeading(trimTrailing(line));
}

export function trimTrailingSpace(lines: readonly string[]): string[] {
  return lines.map(trimTrailing);
}

export function trimLeadingSpace(lines: readonly string[]): string[] {
  return lines.map(trimLeading);
}

export function trimBothSpace(lines: readonly string[]): string[] {
  return lines.map(trimBoth);
}

/**
 * Replace every line break with one space.
 *
 * A blank line therefore contributes its own space; the operation says "EOL to
 * Space", not "collapse whitespace". The stricter cleanup is
 * [`trimBothAndEolToSpace`].
 */
export function eolToSpace(lines: readonly string[]): string[] {
  return [lines.join(" ")];
}

/**
 * Trim each line, drop lines that become empty, and join with one space.
 *
 * This is the form a reader wants after copying wrapped prose or a PDF: the
 * paragraph becomes one line without a double space where the blank line was.
 */
export function trimBothAndEolToSpace(lines: readonly string[]): string[] {
  return [
    lines
      .map(trimBoth)
      .filter((line) => line.length > 0)
      .join(" "),
  ];
}

/**
 * Replace each tab with the editor's two-space indent.
 *
 * This is a character replacement, not a tab-stop expansion; a tab in the
 * middle of a word becomes two spaces as well. The menu names the operation
 * "TAB to Space", and the guide says the width is two.
 */
export function tabsToSpaces(lines: readonly string[]): string[] {
  const spaces = " ".repeat(BLANK_TAB_WIDTH);
  return lines.map((line) => line.replace(/\t/gu, spaces));
}

function spacesToTabs(run: string): string {
  const tabs = Math.floor(run.length / BLANK_TAB_WIDTH);
  const remainder = run.length % BLANK_TAB_WIDTH;
  return `${"\t".repeat(tabs)}${" ".repeat(remainder)}`;
}

/** Convert every run of two spaces anywhere on the line. */
export function spacesToTabsAll(lines: readonly string[]): string[] {
  return lines.map((line) => line.replace(/ +/gu, spacesToTabs));
}

/** Convert only the leading run of spaces; internal spacing is left alone. */
export function spacesToTabsLeading(lines: readonly string[]): string[] {
  return lines.map((line) => line.replace(/^ +/u, spacesToTabs));
}
