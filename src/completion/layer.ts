//! The completion layer, introduced once for every language.
//!
//! `@codemirror/autocomplete` was already a dependency but only `closeBrackets`
//! was imported from it, so the editor had no completion of any kind. This module
//! owns the one `autocompletion()` extension and its keymap, and nothing else:
//! the catalogs live beside it and the language decides which one answers.
//!
//! **Sources come from language data, not from here.** `autocompletion()` reads
//! `autocomplete` from the active language's data, so a language that registers a
//! source gets completion for free and a language that does not simply offers
//! nothing. That is why HTML needs no code in this project: `@codemirror/lang-html`
//! already registers `htmlCompletionSourceWith` inside `html()`. It is also why
//! the LaTeX and Markdown catalogs are added by giving their language support a
//! `languageData` entry rather than by growing this file.
//!
//! **The Tab key is the risk.** `indentWithTab` owns Tab in the base keymap. The
//! completion keymap binds Tab to `acceptCompletion`, which returns `false` when
//! no completion is active — so installing the completion keymap at a *higher*
//! precedence makes Tab accept when a popup is open and indent when it is not,
//! without either binding being aware of the other. Getting the precedence
//! backwards makes Tab indent while a popup is open, which is silent and looks
//! like a broken editor.

import {
  autocompletion,
  completionKeymap,
  type CompletionSource,
} from "@codemirror/autocomplete";
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
 * The completion extension and its keymap.
 *
 * Returned together because they must be installed and removed as a pair: a
 * keymap without the extension binds Tab to a command that can never accept, and
 * an extension without the keymap opens a popup the keyboard cannot drive.
 *
 * `Prec.high` on the keymap is what keeps `indentWithTab` working:
 * `acceptCompletion` declines when no completion is active, so the event falls
 * through to the base keymap. Below the base keymap the indent command would win
 * instead and Tab could never accept.
 */
export function completionSupport(): Extension {
  return [autocompletion(CONFIG), Prec.high(keymap.of(completionKeymap))];
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
