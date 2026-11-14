//! Map a LaTeX diagnostic to a CodeMirror range, and decide when it is stale.
//!
//! The reference scan reports 1-based lines and UTF-16 columns, not byte
//! offsets. That is deliberate: `documents.rs` normalises CRLF to LF for an open
//! buffer, while a closed project file is read from disk with its original
//! endings, so offsets would drift by one per line between the two. A line and
//! a column mean the same thing in both.
//!
//! The mapper never trusts the position blindly. A diagnostic describes the
//! text *at compile time*; the reader may have edited the line since. When the
//! stored command text is not where the column says, it searches the line, and
//! when it is not found at all it marks the whole line as stale rather than a
//! wrong range or nothing.
//!
//! Pure: no DOM, no CodeMirror import, so Node 24 can run `latex-diagnostics-unit`.

import type { LatexDiagnostic } from "./latex-references.ts";

export interface LatexDiagnosticRange {
  /** CodeMirror offset of the first character. */
  from: number;
  /** CodeMirror offset just past the last character. */
  to: number;
  /** Offset of the start of the line, for a whole-line wash. */
  lineFrom: number;
  /** The stored command text is not at the reported position any more. */
  stale: boolean;
}

/** One string that changes when the problem list changes, not when it re-renders. */
export function diagnosticSignature(diagnostic: LatexDiagnostic): string {
  return `${diagnostic.file}\u0000${diagnostic.line}\u0000${diagnostic.code}\u0000${diagnostic.message}`;
}

/** The place to show before the message: `file:line`, or just the file. */
export function diagnosticPlace(diagnostic: LatexDiagnostic): string {
  if (diagnostic.file && diagnostic.line > 0) return `${diagnostic.file}:${diagnostic.line}`;
  if (diagnostic.file) return diagnostic.file;
  return diagnostic.line > 0 ? `line ${diagnostic.line}` : "";
}

/**
 * Whether `candidate` is a file the failed compile actually read.
 *
 * A failed compile has no result to ask, so the preview keeps the main file it
 * used while the reader is still inside that project. The question is
 * membership, not location: two unrelated documents share a folder, and a
 * directory test therefore pinned every `.tex` tab beside a broken project to
 * that project. Switching to a valid document then recompiled the broken one and
 * showed its problems forever.
 *
 * `key` is the platform's path identity (`pathKey` in `sessions.ts`), passed in
 * so this stays pure and Node can run it.
 */
export function latexProjectMember(
  candidate: string | null,
  rootPath: string | null,
  files: readonly string[],
  key: (path: string) => string,
): boolean {
  if (!candidate) return false;
  const wanted = key(candidate);
  if (rootPath && wanted === key(rootPath)) return true;
  return files.some((file) => key(file) === wanted);
}

/**
 * The range a diagnostic points at in `text`, or null when the line is gone.
 *
 * `text` is the CodeMirror document, whose lines are separated by `\n`.
 */
export function diagnosticRange(
  text: string,
  diagnostic: LatexDiagnostic,
): LatexDiagnosticRange | null {
  if (diagnostic.line < 1) return null;
  let lineFrom = 0;
  for (let line = 1; line < diagnostic.line; line += 1) {
    const newline = text.indexOf("\n", lineFrom);
    if (newline < 0) return null;
    lineFrom = newline + 1;
  }
  const newline = text.indexOf("\n", lineFrom);
  const lineTo = newline < 0 ? text.length : newline;
  const lineText = text.slice(lineFrom, lineTo);

  const column = diagnostic.column;
  const endColumn = diagnostic.endColumn;
  if (column > 0 && endColumn > column) {
    const from = Math.min(lineFrom + column - 1, lineTo);
    const to = Math.min(lineFrom + endColumn - 1, lineTo);
    if (to > from) {
      const slice = text.slice(from, to);
      if (!diagnostic.text || slice === diagnostic.text) {
        return { from, to, lineFrom, stale: false };
      }
    }
  }

  if (diagnostic.text) {
    // The reader may have added or removed text before the command. Prefer an
    // occurrence at or after the recorded column, then anywhere on the line.
    let at = lineText.indexOf(diagnostic.text, Math.max(0, column - 1));
    if (at < 0) at = lineText.indexOf(diagnostic.text);
    if (at >= 0) {
      return {
        from: lineFrom + at,
        to: lineFrom + at + diagnostic.text.length,
        lineFrom,
        stale: false,
      };
    }
  }

  // A compiler diagnostic carries only a line, so the whole line is the range
  // and it is not stale. A reference diagnostic that lost its command is stale,
  // but the line it named is still worth pointing at.
  if (column < 1 && !diagnostic.text) {
    return { from: lineFrom, to: lineTo, lineFrom, stale: false };
  }
  return { from: lineFrom, to: lineTo, lineFrom, stale: true };
}
