//! The LaTeX grammar, loaded on demand.
//!
//! Colouring comes from `@codemirror/legacy-modes`' `stex` stream parser: the
//! CodeMirror 5 mode that understands `\command`, `{…}`/`[…]` arguments, `%`
//! comments and the four math delimiters. A stream parser produces tokens and no
//! syntax tree, which is why folding is not offered for LaTeX — see
//! `canFold` in `src/main.ts`.
//!
//! The alternative, `codemirror-lang-latex`, is a real Lezer grammar and its
//! AGPL licence is acceptable to this project; it was not taken because it costs
//! about 60 KB gzip for the parser and its tables, against 3 KB here for the
//! colouring this editor needs. See `docs/plans/2026-11-06-command-completion.md`
//! for the measurement. A Lezer grammar remains the right answer if folding or
//! structural context detection is ever wanted, and the cost is the number to
//! beat.
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
