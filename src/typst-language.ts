//! The Typst grammar, loaded on demand.
//!
//! `codemirror-lang-typst` is not small: it carries a 359 KB WebAssembly module
//! that parses Typst with the compiler's own syntax layer. Charging every start-up
//! with that, for a feature most sessions never touch, is the wrong trade — so the
//! package is imported dynamically and only when a `.typ` document is opened.
//!
//! The alternative, `@vedivad/codemirror-typst`, was rejected on size: it depends
//! on a WebAssembly *compiler* of roughly 28 MB, against 359 KB here, for syntax
//! colouring and diagnostics that this editor does not need in the browser — it
//! runs the real compiler on the desktop instead.

import type { LanguageSupport } from "@codemirror/language";

let pending: Promise<LanguageSupport> | null = null;

/**
 * The Typst language support, loaded once.
 *
 * The promise is cached rather than the result, so two quick document switches do
 * not each start a fetch of the same module.
 */
export function typstLanguage(): Promise<LanguageSupport> {
  if (!pending) {
    pending = import("codemirror-lang-typst").then((module) => module.typst());
  }
  return pending;
}
