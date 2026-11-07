//! The LaTeX completion source: catalog plus context, as one CodeMirror source.
//!
//! `autocompletion()` reads `autocomplete` from the active language's data, so
//! this module produces a `CompletionSource` and `latex-language.ts` registers it
//! on the language support. The layer itself never learns that LaTeX exists.

import {
  snippetCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
  type CompletionSource,
} from "@codemirror/autocomplete";
import { latexCatalog, LATEX_CLASS_NAMES, LATEX_ENVIRONMENT_NAMES, LATEX_PACKAGE_NAMES } from "./latex-catalog.ts";
import { filterByPrefix, latexContextAt } from "./latex-context.ts";

/** Turn a catalog row into the shape CodeMirror renders. */
function toCompletion(entry: ReturnType<typeof latexCatalog>[number]): Completion {
  if (entry.snippet) {
    return snippetCompletion(entry.label, {
      label: entry.label.split("\n")[0],
      detail: entry.detail,
      section: entry.section,
    });
  }
  return {
    label: entry.label,
    detail: entry.detail,
    section: entry.section,
  };
}

/** The rows for one context, already filtered. */
function entriesFor(kind: string, prefix: string): Completion[] {
  const catalog = latexCatalog();
  if (kind === "environment") {
    return filterByPrefix(
      LATEX_ENVIRONMENT_NAMES.map((name) => ({ label: name, detail: "environment", section: "Environments" })),
      prefix,
    ).map((entry) => entry as Completion);
  }
  if (kind === "package") {
    return filterByPrefix(
      LATEX_PACKAGE_NAMES.map((name) => ({ label: name, detail: "package", section: "Packages" })),
      prefix,
    ).map((entry) => entry as Completion);
  }
  if (kind === "class") {
    return filterByPrefix(
      LATEX_CLASS_NAMES.map((name) => ({ label: name, detail: "class", section: "Document classes" })),
      prefix,
    ).map((entry) => entry as Completion);
  }
  // Commands and snippets share the catalog; the prefix is the typed command
  // name without its backslash, so the leading `\` is stripped before matching.
  const wanted = catalog.filter((entry) => {
    if (kind === "command") return entry.section !== "Environments" && entry.section !== "Packages" && entry.section !== "Document classes";
    return true;
  });
  const stripped = wanted.map((entry) => ({
    ...entry,
    label: entry.label.startsWith("\\") ? entry.label.slice(1) : entry.label,
  }));
  return filterByPrefix(stripped, prefix).map(toCompletion);
}

/**
 * The LaTeX completion source.
 *
 * Returns `null` when the position asks for nothing, which is what keeps the
 * popup closed in prose, inside comments and inside verbatim bodies.
 *
 * `from` is where the typed prefix starts, so accepting a row replaces it rather
 * than appending. Two cases differ:
 *
 * - A **command** keeps its backslash: the reader typed `\sec`, the catalog
 *   offers `section`, and the replacement must cover only `sec` so the result is
 *   `\section` rather than `\\section`.
 * - An **argument** (`\begin{ite`) replaces the partial name inside the brace.
 */
export const latexCompletionSource: CompletionSource = (context: CompletionContext) => {
  const text = context.state.doc.toString();
  const found = latexContextAt(text, context.pos);
  if (found.kind === "none") return null;

  const options = entriesFor(found.kind, found.prefix);
  if (options.length === 0) return null;

  return {
    from: context.pos - found.prefix.length,
    options,
    // The catalog is already filtered by `entriesFor`, so CodeMirror must not
    // filter again — it would compare against the label including the backslash
    // for snippets and drop rows that do match.
    filter: false,
  } satisfies CompletionResult;
};
