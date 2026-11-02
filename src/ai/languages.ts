//! The target languages the Translate action suggests, and the search over them.
//!
//! The list is a suggestion list, not a vocabulary: `parameterIsValid` in
//! `actions.ts` accepts any 1–60 character target, so "Catalan" and
//! "Brazilian Portuguese" can be typed without appearing here.
//!
//! Three decisions are worth knowing before editing the table:
//!
//! 1. **The value is the readable name**, not a BCP-47 tag. It is interpolated
//!    into the prompt and becomes the History title ("Translate · Portuguese
//!    (Brazil)"), so a name a person can read beats a code. Tags live in
//!    `keywords`, which is what the search matches.
//! 2. **Variants are split only where the choice changes the translation** —
//!    Portuguese, Spanish, Chinese and English. French has one entry because
//!    there is nothing useful to decide.
//! 3. **The order is the ranking.** The AI popup opens showing every row, so the
//!    first screenful is what the reader sees: a curated head of likely targets,
//!    then everything else alphabetically. `filterLanguages` never re-sorts.

import { filterEntries, type ComboEntry } from "../combo.ts";

export interface LanguageSuggestion extends ComboEntry {
  /** The readable target, sent verbatim into the prompt. */
  value: string;
}

export const LANGUAGES: readonly LanguageSuggestion[] = [
  // The curated head.
  { value: "English (US)", keywords: ["en", "en-US", "american", "us english"] },
  { value: "English (UK)", keywords: ["en-GB", "british", "uk english"] },
  { value: "Portuguese (Brazil)", keywords: ["pt-BR", "pt", "brasil", "brasileiro"] },
  { value: "Portuguese (Portugal)", keywords: ["pt-PT", "europeu", "european"] },
  {
    value: "Spanish (Spain)",
    keywords: ["es-ES", "castilian", "castellano", "español"],
  },
  {
    value: "Spanish (Latin America)",
    keywords: ["es-419", "latinoamerica", "latinoamérica", "latin american"],
  },
  { value: "French", keywords: ["fr", "français"] },
  { value: "German", keywords: ["de", "deutsch"] },
  { value: "Italian", keywords: ["it", "italiano"] },
  {
    value: "Chinese (Simplified)",
    keywords: ["zh", "zh-CN", "zh-Hans", "mandarin", "simplified", "简体"],
  },
  {
    value: "Chinese (Traditional)",
    keywords: ["zh-TW", "zh-Hant", "traditional", "繁體"],
  },
  { value: "Japanese", keywords: ["ja", "nihongo", "日本語"] },

  // Everything else, alphabetically.
  { value: "Arabic", keywords: ["ar", "العربية"] },
  { value: "Bengali", keywords: ["bn", "বাংলা"] },
  { value: "Catalan", keywords: ["ca", "català"] },
  { value: "Czech", keywords: ["cs", "čeština"] },
  { value: "Danish", keywords: ["da", "dansk"] },
  { value: "Dutch", keywords: ["nl", "nederlands"] },
  { value: "Finnish", keywords: ["fi", "suomi"] },
  { value: "Greek", keywords: ["el", "ελληνικά"] },
  { value: "Hebrew", keywords: ["he", "עברית"] },
  { value: "Hindi", keywords: ["hi", "हिन्दी"] },
  { value: "Indonesian", keywords: ["id", "bahasa indonesia"] },
  { value: "Korean", keywords: ["ko", "한국어"] },
  { value: "Norwegian", keywords: ["no", "norsk"] },
  { value: "Persian", keywords: ["fa", "farsi", "فارسی"] },
  { value: "Polish", keywords: ["pl", "polski"] },
  { value: "Romanian", keywords: ["ro", "română"] },
  { value: "Russian", keywords: ["ru", "русский"] },
  { value: "Swedish", keywords: ["sv", "svenska"] },
  { value: "Thai", keywords: ["th", "ไทย"] },
  { value: "Turkish", keywords: ["tr", "türkçe"] },
  { value: "Ukrainian", keywords: ["uk", "українська"] },
  { value: "Vietnamese", keywords: ["vi", "tiếng việt"] },
];

/**
 * The suggestions a query matches, in table order.
 *
 * Accents fold both ways: "espanol" finds "español" whether the accent is on the
 * value, on a keyword or missing from the query. A short tag such as "zh" or "pt"
 * therefore matches both variants of that language, which is deliberate — the
 * label on screen is what disambiguates.
 */
export function filterLanguages(query: string): LanguageSuggestion[] {
  return filterEntries(LANGUAGES, query);
}
