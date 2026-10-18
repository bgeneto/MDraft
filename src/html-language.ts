//! The HTML grammar, loaded on demand.
//!
//! Like the Typst grammar, this is only fetched when a `.html` document is
//! opened. Markdown and Typst sessions never pay for it.

import type { LanguageSupport } from "@codemirror/language";

/**
 * One promise per tag-closing flag. `html()` includes `autoCloseTags` unless it
 * is told not to, so the preference picks which support is installed; caching
 * both keeps a toggle from re-fetching the module.
 */
const pending = new Map<boolean, Promise<LanguageSupport>>();

export function htmlLanguage(autoCloseTags: boolean): Promise<LanguageSupport> {
  let promise = pending.get(autoCloseTags);
  if (!promise) {
    promise = import("@codemirror/lang-html").then((module) => module.html({ autoCloseTags }));
    pending.set(autoCloseTags, promise);
  }
  return promise;
}
