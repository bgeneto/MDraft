//! The HTML grammar, loaded on demand.
//!
//! Like the Typst grammar, this is only fetched when a `.html` document is
//! opened. Markdown and Typst sessions never pay for it.

import type { LanguageSupport } from "@codemirror/language";

let pending: Promise<LanguageSupport> | null = null;

export function htmlLanguage(): Promise<LanguageSupport> {
  if (!pending) {
    pending = import("@codemirror/lang-html").then((module) => module.html());
  }
  return pending;
}
