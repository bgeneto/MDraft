//! The Markdown completion source.
//!
//! The second consumer of the layer, and the proof that it is language-neutral:
//! this file is the whole Markdown integration — a catalog and a trigger rule.
//! Nothing in `layer.ts` or `editor.ts` changed to add it.
//!
//! Markdown's trigger is different from LaTeX's. There is no `\` to key on, so the
//! popup opens on the characters that *begin* a construct — a backtick, a bracket,
//! a pipe, a colon in a task box — and stays closed everywhere else. That is what
//! keeps it from interrupting ordinary prose, which is the same rule the LaTeX
//! context table enforces.

import {
  snippetCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
  type CompletionSource,
} from "@codemirror/autocomplete";
import { markdownCatalog } from "./markdown-catalog.ts";
import type { CatalogEntry } from "./latex-catalog.ts";

/** Turn a catalog row into the shape CodeMirror renders. */
function toCompletion(entry: CatalogEntry): Completion {
  if (entry.snippet) {
    return snippetCompletion(entry.label, {
      label: entry.label.split("\n")[0],
      detail: entry.detail,
      section: entry.section,
    });
  }
  return { label: entry.label, detail: entry.detail, section: entry.section };
}

/**
 * The characters that start a construct worth completing.
 *
 * Deliberately short. A popup that opens on a letter would fire on every word of
 * every sentence; these are the characters a reader types when they have already
 * decided to write markup.
 */
const TRIGGERS = /[`[!|$~*#>-]$/;

/**
 * The Markdown completion source.
 *
 * Returns `null` unless the character before the cursor starts a construct, so
 * prose never opens a popup. The rows are the catalog filtered by whatever the
 * reader has typed after the trigger, which for most of these is nothing.
 */
export const markdownCompletionSource: CompletionSource = (context: CompletionContext) => {
  const line = context.state.doc.lineAt(context.pos);
  const before = line.text.slice(0, context.pos - line.from);

  // Inside a fenced block nothing is markup, so nothing is offered.
  if (inFence(context.state.doc.toString(), context.pos)) return null;

  if (!TRIGGERS.test(before)) return null;

  const options = markdownCatalog().map(toCompletion);
  if (options.length === 0) return null;

  return {
    from: context.pos,
    options,
    // The catalog is small and already the right set for this trigger; letting
    // CodeMirror filter it would hide rows that do not begin with the trigger
    // character, which is most of them.
    filter: false,
  } satisfies CompletionResult;
};

/**
 * Whether the position sits inside a fenced code block.
 *
 * Counted from the start of the document because a fence can open on an earlier
 * line. The fence character and length must match to close, which is what the
 * CommonMark rule requires and what stops a ```` ```` ```` inside a ``` ``` ```
 * block from closing it.
 */
function inFence(text: string, offset: number): boolean {
  const head = text.slice(0, offset);
  let open: { char: string; length: number } | null = null;
  for (const line of head.split(/\r?\n/)) {
    const match = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (!match) continue;
    const marker = match[1];
    if (open === null) {
      open = { char: marker[0], length: marker.length };
    } else if (marker[0] === open.char && marker.length >= open.length) {
      open = null;
    }
  }
  return open !== null;
}
