//! Unwrap Paragraph and Wrap Paragraph, applied to an editor view.
//!
//! The command acts on the paragraph at each cursor, or on every paragraph a
//! selection touches, in one transaction: one Undo restores the original text.
//! It never runs on its own — resizing the window changes how lines are drawn,
//! not what the file contains.

import type { EditorView } from "@codemirror/view";
import type { DocumentLanguage } from "../api.ts";
import { reflow, type ReflowMode } from "./reflow.ts";
import { reflowDialect } from "./reflow-dialects.ts";

/** Whether the commands apply to documents in `language`. */
export function canReflow(language: DocumentLanguage): boolean {
  return reflowDialect(language) !== null;
}

const plural = (count: number) => (count === 1 ? "paragraph" : "paragraphs");

/**
 * Reflow the selection in `view`. Returns the one-line message the status
 * toast shows: what changed, or why nothing did.
 */
export function reflowView(
  view: EditorView,
  language: DocumentLanguage,
  mode: ReflowMode,
  column: number,
): string {
  const verb = mode === "unwrap" ? "Unwrap" : "Wrap";
  const dialect = reflowDialect(language);
  if (!dialect) return `${verb} Paragraph works in Markdown, LaTeX, Typst and AsciiDoc documents.`;

  const state = view.state;
  const result = reflow(
    state.doc.toString(),
    state.selection.ranges.map((range) => ({ from: range.from, to: range.to })),
    dialect,
    { mode, column, tabSize: state.tabSize },
  );
  const skipped = result.skipped[0];
  const skipNote = skipped ? `Line ${skipped.line} left unchanged: ${skipped.reason}.` : "";

  if (result.paragraphs === 0) return skipNote || "There is no paragraph of prose at the cursor.";
  if (result.changes.length) {
    view.dispatch({ changes: result.changes, userEvent: "format.reflow", scrollIntoView: true });
  }
  const done =
    result.changed === 0
      ? mode === "unwrap"
        ? `Already one line per ${plural(result.paragraphs).replace(/s$/, "")}`
        : `Already wrapped at column ${column}`
      : `${mode === "unwrap" ? "Unwrapped" : `Wrapped at column ${column}:`} ${result.changed} ${plural(result.changed)}`;
  return skipNote ? `${done}. ${skipNote}` : done;
}
