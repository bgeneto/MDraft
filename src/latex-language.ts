//! The LaTeX grammar, loaded on demand.
//!
//! There is no Lezer grammar for LaTeX in this project's dependency set and the
//! candidates were rejected on licence (see the plan's rejected alternatives), so
//! colouring comes from `@codemirror/legacy-modes`' `stex` stream parser: the
//! CodeMirror 5 mode that understands `\command`, `{…}`/`[…]` arguments, `%`
//! comments and the four math delimiters. A stream parser produces tokens and no
//! syntax tree, which is why folding is not offered for LaTeX — see
//! `canFold` in `src/main.ts`.
//!
//! The module is imported dynamically for the same reason Typst's is: the chunk
//! is small (3 KB, already emitted because `@codemirror/language-data` maps both
//! "sTeX" and "LaTeX" to it), but a session that never opens a `.tex` file should
//! not pay for it at start-up.

import { LanguageSupport, StreamLanguage } from "@codemirror/language";
import { stex } from "@codemirror/legacy-modes/mode/stex";

let pending: Promise<LanguageSupport> | null = null;

/**
 * The LaTeX language support, loaded once.
 *
 * The promise is cached rather than the result, so two quick document switches do
 * not each start a fetch of the same module.
 */
export function latexLanguage(): Promise<LanguageSupport> {
  if (!pending) {
    pending = Promise.resolve().then(() => {
      const language = StreamLanguage.define(stex);
      // `stex` already carries `languageData.commentTokens: { line: "%" }`, which
      // is what makes Edit › Comment and the editor's comment command work. It is
      // restated here so the contract survives a dependency upgrade that drops
      // it: without it the menu disables a command LaTeX supports.
      return new LanguageSupport(language, [
        language.data.of({ commentTokens: { line: "%" } }),
      ]);
    });
  }
  return pending;
}
