//! Closing an HTML tag while typing `>` in Markdown and AsciiDoc.
//!
//! CodeMirror's `autoCloseTags` is bound to the HTML language's own data, and
//! Markdown parses inline HTML with a configured dialect whose data is
//! different, so its guard is false there and the extension never fires. This
//! handler covers the two document types that pass HTML through; HTML itself
//! keeps the language's version, which understands attributes, quoting and
//! self-closing syntax properly.
//!
//! The pure matching rules live in `tag-name.ts`; this file only turns them
//! into an input handler that has a view and a syntax tree.

import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { isCodeContext } from "./code-context";
import { tagToClose } from "./tag-name";

/**
 * The input handler. Only `>` reaches it; the rest is the pure matcher plus a
 * check that the caret is neither in code nor already in front of the matching
 * closing tag.
 */
export function autoCloseTag(): Extension {
  return EditorView.inputHandler.of((view, from, to, text) => {
    if (text !== ">" || from !== to || view.composing || view.state.readOnly) return false;
    if (isCodeContext(view.state, from)) return false;

    const line = view.state.doc.lineAt(from);
    const before = line.text.slice(0, from - line.from);
    const tag = tagToClose(before);
    if (!tag) return false;

    // The reader may have typed `>` just before an existing `</tag>`.
    const after = view.state.sliceDoc(from, Math.min(line.to, from + tag.length + 2));
    if (after.startsWith(`</${tag}`)) return false;

    view.dispatch({
      changes: { from, to, insert: `></${tag}>` },
      selection: { anchor: from + 1 },
      userEvent: "input.type",
    });
    return true;
  });
}
