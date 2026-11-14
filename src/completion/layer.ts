//! The completion layer, introduced once for every language.
//!
//! `@codemirror/autocomplete` was already a dependency but only `closeBrackets`
//! was imported from it, so the editor had no completion of any kind. This module
//! owns the one `autocompletion()` extension and the Tab binding, and nothing
//! else: the catalogs live beside it and the language decides which one answers.
//!
//! **Sources come from language data, not from here.** `autocompletion()` reads
//! `autocomplete` from the active language's data, so a language that registers a
//! source gets completion for free and a language that does not simply offers
//! nothing. That is why HTML needs no code in this project: `@codemirror/lang-html`
//! already registers `htmlCompletionSourceWith` inside `html()`. It is also why
//! the LaTeX and Markdown catalogs are added by giving their language support a
//! `languageData` entry rather than by growing this file.
//!
//! **Tab, and a correction worth recording.** CodeMirror's own `completionKeymap`
//! binds `Ctrl-Space` to start, `Escape` to close, the arrows and Page keys to
//! move, and **`Enter` to accept** — it does *not* bind Tab. `autocompletion()`
//! installs that keymap itself at `Prec.highest`. An earlier version of this file
//! installed a second copy at `Prec.high` on the belief that Tab accepted, which
//! was both redundant and wrong. Tab is bound here explicitly, because accepting
//! with Tab is what this editor's plan promised and what a reader coming from
//! VS Code expects; Enter keeps working through CodeMirror's own keymap.

import { acceptCompletion, autocompletion, type CompletionSource } from "@codemirror/autocomplete";
import { Prec, type Extension } from "@codemirror/state";
import { keymap } from "@codemirror/view";

/**
 * How the popup behaves.
 *
 * `maxRenderedOptions` is deliberately small: a large catalog filtered to a
 * thousand rows is slower to draw and worse to read than a narrow list, and the
 * reader can always type another character.
 */
const CONFIG = {
  activateOnTyping: true,
  closeOnBlur: true,
  maxRenderedOptions: 50,
  // The catalog has no icon set, and a generic glyph beside every row is noise.
  icons: false,
} as const;

/**
 * Tab accepts a completion, and indents when there is none.
 *
 * `acceptCompletion` returns `false` when no popup is open, so binding it at
 * `Prec.high` — above the base keymap that holds `indentWithTab` — lets the event
 * fall through to indentation. Installing it *below* the base keymap would make
 * Tab indent while a popup is open and it could never accept.
 */
const tabAccepts: Extension = Prec.high(keymap.of([{ key: "Tab", run: acceptCompletion }]));

/**
 * The completion extension and the Tab binding.
 *
 * Returned together because they must be installed and removed as a pair: a
 * keymap without the extension binds Tab to a command that can never accept, and
 * an extension without the keymap opens a popup that Tab cannot drive.
 */
export function completionSupport(): Extension {
  return [autocompletion(CONFIG), tabAccepts];
}

/**
 * A source that offers nothing.
 *
 * The explicit answer for a language with no catalog yet, so the popup cannot
 * fall back to completing arbitrary words from the buffer. That fallback is what
 * makes completion feel noisy, and this project's rule is that a control which
 * cannot help must not appear.
 */
export const noCompletions: CompletionSource = () => null;
