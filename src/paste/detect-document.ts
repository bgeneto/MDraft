//! Which markup an unsaved buffer is, for a paste and for Save As.
//!
//! `doc.language` is only a suggestion while a document has no path: Save As can
//! choose any extension, and the user may type another markup before saving.
//! This module resolves the paste destination without touching the editor's
//! parser, and recommends the extension Save As should offer; the caller shows a
//! notice when detection disagrees with the editor's language.

import type { DocumentLanguage } from "../api.ts";
import {
  detectTextSyntax,
  stripNoise,
  scoreAsciidoc,
  scoreLatex,
  scoreMarkdown,
  scoreTypst,
} from "./detect.ts";

export interface DestinationInput {
  saved: boolean;
  /** The language the editor is currently parsed as. */
  language: DocumentLanguage;
  buffer: string;
}

export interface PasteDestination {
  language: DocumentLanguage;
  /** True when the buffer's content overrode `input.language`. */
  detected: boolean;
  /** True when detection found nothing and the editor language was used. */
  fallback: boolean;
  score: number;
  runnerUp: number;
}

/** A buffer larger than this is classified from its beginning only. */
export const DETECTION_SAMPLE = 256 * 1024;

/**
 * The document classifier, with the saved/unsaved/fallback rule.
 *
 * A saved file is never scanned: its extension is authoritative. An unsaved
 * buffer is scanned, and a null result falls back to the editor's language,
 * which is what the editor is already parsing and what Save As keeps when
 * detection has nothing to add.
 */
export function resolvePasteDestination(input: DestinationInput): PasteDestination {
  if (input.saved) {
    return {
      language: input.language,
      detected: false,
      fallback: false,
      score: 0,
      runnerUp: 0,
    };
  }
  const sample = input.buffer.slice(0, DETECTION_SAMPLE);
  const found = detectTextSyntax(sample, "document");
  if (found) {
    return {
      language: found.language,
      detected: found.language !== input.language,
      fallback: false,
      score: found.score,
      runnerUp: found.runnerUp,
    };
  }
  return {
    language: input.language,
    detected: false,
    fallback: true,
    score: Math.max(
      scoreMarkdown(stripNoise(sample)),
      scoreTypst(stripNoise(sample)),
      scoreAsciidoc(stripNoise(sample)),
      scoreLatex(sample),
    ),
    runnerUp: 0,
  };
}

/**
 * The extension each markup is saved as when the reader has no preference for
 * it. `main.ts` builds the dialog filters from the same table, so the file name
 * and the filter that supplies an extension cannot drift apart.
 */
export const CANONICAL_EXTENSION: Record<DocumentLanguage, string> = {
  markdown: "md",
  typst: "typ",
  html: "html",
  asciidoc: "adoc",
  latex: "tex",
};

/**
 * Every extension this application opens as each markup.
 *
 * One table, because two answers to "what is a `.tex` file" is how the editor
 * ends up parsing a document as Markdown while the menus offer LaTeX commands.
 * The canonical extension comes first; the aliases follow it. `main.ts` builds
 * the file dialog filters from the same entries, so a name the dialog offers and
 * a name the classifier recognises cannot drift apart.
 */
export const LANGUAGE_EXTENSIONS: Record<DocumentLanguage, readonly string[]> = {
  markdown: [CANONICAL_EXTENSION.markdown, "markdown", "mdown", "mkd", "txt"],
  typst: [CANONICAL_EXTENSION.typst],
  html: [CANONICAL_EXTENSION.html, "htm"],
  asciidoc: [CANONICAL_EXTENSION.asciidoc, "asciidoc"],
  latex: [CANONICAL_EXTENSION.latex],
};

/** A file extension without its dot, lowercased; null when there is none. */
function extensionOf(name: string): string | null {
  const match = /\.([A-Za-z0-9]+)$/.exec(name.trim());
  return match ? match[1].toLowerCase() : null;
}

/**
 * The markup a file name or a bare extension names.
 *
 * A saved file's suffix is authoritative — re-reading the contents on every open
 * would flip the parser under edits that have not been saved yet — so this is the
 * one classifier `main.ts` uses for both an opened path and the Default File
 * Extension preference. An unknown or absent extension is Markdown, which is what
 * the editor has always fallen back to.
 */
export function languageForExtension(nameOrExtension: string | null): DocumentLanguage {
  if (nameOrExtension === null) return "markdown";
  const extension = extensionOf(nameOrExtension) ?? nameOrExtension.trim().toLowerCase();
  for (const [language, extensions] of Object.entries(LANGUAGE_EXTENSIONS)) {
    if (extensions.includes(extension)) return language as DocumentLanguage;
  }
  return "markdown";
}

export interface SaveSuggestionInput {
  /** The path the document already has, or null while it is untitled. */
  path: string | null;
  /** The language the editor is currently parsed as. */
  language: DocumentLanguage;
  buffer: string;
  /** The reader's Default File Extension preference. */
  defaultExtension: string;
  /** The language that preference starts a new document in. */
  defaultLanguage: DocumentLanguage;
}

export interface SaveSuggestion {
  /** The markup whose filter Save As puts first. */
  language: DocumentLanguage;
  /** The extension for an untitled file name; null while a path decides. */
  extension: string | null;
}

/**
 * The markup Save As should offer.
 *
 * A saved file is never scanned: its extension is authoritative, and the dialog
 * already starts from its path. An untitled buffer is the useful case — the
 * reader may have typed Typst, HTML or AsciiDoc while the editor still parses
 * the default language — and detection only *recommends*: any extension can
 * still be chosen, and the reader's own spelling survives when the content
 * agrees with the preference (`untitled.markdown` stays `untitled.markdown`
 * instead of becoming `untitled.md`).
 *
 * A tie is not a recommendation. `detectTextSyntax` resolves a Typst/AsciiDoc
 * tie towards Typst for paste conversion, but `= Title` alone is equally likely
 * to be an AsciiDoc document; a wrong suggestion here re-parses the text on the
 * first save, so only a real lead may override the editor's language.
 */
export function suggestSave(input: SaveSuggestionInput): SaveSuggestion {
  if (input.path) return { language: input.language, extension: null };
  const found = resolvePasteDestination({
    saved: false,
    language: input.language,
    buffer: input.buffer,
  });
  const language = found.detected && found.score > found.runnerUp ? found.language : input.language;
  return {
    language,
    // A restored Typst buffer in an untitled tab keeps Typst even when the
    // preference says Markdown: the language the text is already parsed as wins
    // over a preference meant for new documents.
    extension:
      language === input.defaultLanguage ? input.defaultExtension : CANONICAL_EXTENSION[language],
  };
}
