//! The natural language of a document, shared by spelling and reading aloud.
//!
//! Two features need the same answer: the spelling plugin chooses a dictionary,
//! and Read Aloud chooses a voice. English and Portuguese are detected from
//! function words and Portuguese diacritics, which is what the application has
//! always promised for spelling. Every other language can be declared by the
//! document itself — `lang` in YAML front matter, `:lang:` in an AsciiDoc
//! header, `#set text(lang: "…")` in Typst, `<html lang="…">` in HTML — or
//! voted on with the dictionaries the operating system already has.
//!
//! Nothing here touches the DOM or imports another module, so Node runs the
//! same code in `scripts/read-aloud-unit.mjs`.

export type ProseLanguage = "en" | "pt-BR";
export type MarkupLanguage = "markdown" | "typst" | "html" | "asciidoc";

/** Minimum number of prose words before a vote is trusted. */
export const MIN_PROSE_WORDS = 40;

const EN_WORDS = new Set([
  "the",
  "and",
  "of",
  "to",
  "in",
  "is",
  "that",
  "for",
  "with",
  "this",
  "you",
  "are",
  "was",
  "be",
  "have",
  "from",
  "it",
  "on",
  "as",
  "at",
  "by",
  "or",
  "an",
  "not",
  "but",
  "we",
  "they",
  "his",
  "her",
  "their",
  "which",
  "would",
  "there",
]);

const PT_WORDS = new Set([
  "não",
  "que",
  "uma",
  "para",
  "com",
  "dos",
  "das",
  "por",
  "como",
  "mais",
  "mas",
  "foi",
  "são",
  "também",
  "já",
  "seu",
  "sua",
  "isso",
  "este",
  "esta",
  "ela",
  "ele",
  "os",
  "um",
  "na",
  "em",
  "se",
  "ao",
  "ou",
  "quando",
  "muito",
  "porque",
  "está",
  "pelo",
  "pela",
]);

const PT_MARK = /[ãõçáàâéêíóôú]/i;

/**
 * The words a language vote sees.
 *
 * Single letters carry no evidence and `acceptedForm` in the spelling backend
 * declines them too, so both consumers count the same words.
 */
export function proseWords(text: string): string[] {
  const words = text.match(/[\p{L}][\p{L}'’-]*/gu) ?? [];
  return words.filter((word) => [...word].length >= 2);
}

/**
 * The confident language of a list of prose words, or null.
 *
 * A Portuguese diacritic is worth two hits: it is the one signal a short
 * Portuguese sample carries that English does not. A tie, a thin sample or
 * fewer than four function words is deliberately inconclusive — underlining
 * every word, or reading with the wrong language, is worse than the default.
 */
export function voteProse(words: readonly string[]): ProseLanguage | null {
  if (words.length < MIN_PROSE_WORDS) return null;
  let en = 0;
  let pt = 0;
  for (const word of words) {
    const lower = word.toLowerCase();
    if (EN_WORDS.has(lower)) en += 1;
    if (PT_WORDS.has(lower)) pt += 1;
    if (PT_MARK.test(lower)) pt += 2;
  }
  if (en + pt < 4) return null;
  if (pt >= en * 1.5 && pt >= 3) return "pt-BR";
  if (en >= pt * 1.5 && en >= 3) return "en";
  return null;
}

/** A confident language from free text, or null. */
export function detectProseLanguage(text: string): ProseLanguage | null {
  return voteProse(proseWords(text));
}

const LANGUAGE_TAG = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/;

/**
 * A BCP 47-shaped tag in one spelling: `pt_br` and `PT-br` become `pt-BR`.
 *
 * The tag is only as good as the shape; a language *name* such as
 * `Portuguese` is not guessed at. A region subtag keeps canonical upper case so
 * a saved tag reads the way the platform spells it.
 */
export function normalizeLanguageTag(raw: string): string | null {
  const trimmed = raw
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/_/g, "-");
  if (!LANGUAGE_TAG.test(trimmed)) return null;
  const [base, ...rest] = trimmed.split("-");
  return [
    base.toLowerCase(),
    ...rest.map((part) => (part.length === 2 ? part.toUpperCase() : part)),
  ].join("-");
}

/** Strip a YAML/AsciiDoc comment and one pair of quotes from a value. */
function cleanValue(value: string): string | null {
  const uncommented = value.replace(/\s+(?:#|\/\/).*$/, "").trim();
  return normalizeLanguageTag(uncommented);
}

/**
 * A language the document declares about itself.
 *
 * The author's declaration outranks every guess: it is the one signal that
 * works for a short document and for a language with no detector. Only the
 * shape is validated — the tag is matched against the installed voices later.
 */
export function declaredLanguage(source: string, markup: MarkupLanguage): string | null {
  const text = source.replace(/^\uFEFF/, "");
  const head = text.slice(0, 8_000);
  switch (markup) {
    case "markdown": {
      if (!/^---[ \t]*\r?\n/.test(text)) return null;
      const lines = text.split(/\r?\n/);
      let found: string | null = null;
      for (let index = 1; index < lines.length; index++) {
        const line = lines[index];
        // Only the closed front matter block counts; a `lang:` in the body is
        // prose or a code sample, not a declaration.
        if (/^---[ \t]*$/.test(line)) return found;
        if (found) continue;
        const match = /^(?:lang|language)\s*:\s*(.+)$/i.exec(line);
        if (match) found = cleanValue(match[1]);
      }
      return null;
    }
    case "asciidoc": {
      const match = /^:(?:lang|language):[ \t]*(.+)$/im.exec(head);
      return match ? cleanValue(match[1]) : null;
    }
    case "typst": {
      const match = /#set\s+text\s*\([\s\S]*?\blang\s*:\s*"([^"]+)"/.exec(head);
      return match ? normalizeLanguageTag(match[1]) : null;
    }
    case "html": {
      const match = /<html\b[^>]*\blang\s*=\s*["']([^"']+)["']/i.exec(head);
      return match ? normalizeLanguageTag(match[1]) : null;
    }
  }
}

/** A checker with the shape of `api.spellcheckCheck`. */
export type DictionaryCheck = (
  language: string,
  words: readonly string[],
) => Promise<readonly number[]>;

/** Minimum prose words before the dictionary vote is trusted. */
export const MIN_VOTE_WORDS = 20;

/** The most words sent to one dictionary; enough for a stable ratio. */
const MAX_VOTE_WORDS = 600;

/** A dictionary that rejects more than this has not recognised the document. */
const MAX_REJECT_RATIO = 0.35;

/** The winner must be this much better than the runner-up. */
const MIN_MARGIN = 0.15;

/** A slow dictionary must not delay the first sentence. */
const VOTE_TIMEOUT_MS = 800;

function settleWithin<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    let done = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (value: T | null): void => {
      if (done) return;
      done = true;
      if (timer !== null) clearTimeout(timer);
      resolve(value);
    };
    timer = setTimeout(() => finish(null), ms);
    promise.then(
      (value) => finish(value),
      () => finish(null),
    );
  });
}

/**
 * Which installed dictionary recognises the document.
 *
 * This is the fallback for a language the word lists do not know and the
 * document does not declare: a machine with a Spanish voice and dictionary can
 * read Spanish without a second detector. The vote is deliberately shy — a
 * tie, a mostly-rejected sample or a slow answer returns null and the platform
 * default takes over, because a wrong voice is worse than the default one.
 */
export async function voteInstalledLanguage(
  words: readonly string[],
  candidates: readonly string[],
  check: DictionaryCheck,
  timeoutMs = VOTE_TIMEOUT_MS,
): Promise<string | null> {
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const raw of words) {
    const word = raw.toLowerCase();
    if (word.length < 2 || seen.has(word)) continue;
    seen.add(word);
    unique.push(word);
    if (unique.length >= MAX_VOTE_WORDS) break;
  }
  if (unique.length < MIN_VOTE_WORDS || candidates.length === 0) return null;

  const results = await settleWithin(
    Promise.all(
      candidates.map(async (language) => {
        try {
          const bad = await check(language, unique);
          return { language, rate: bad.length / unique.length };
        } catch {
          return { language, rate: 1 };
        }
      }),
    ),
    timeoutMs,
  );
  if (!results) return null;

  const ranked = results
    .filter((entry) => Number.isFinite(entry.rate))
    .sort((a, b) => a.rate - b.rate);
  if (ranked.length === 0) return null;
  const best = ranked[0];
  if (best.rate > MAX_REJECT_RATIO) return null;
  if (ranked.length > 1 && ranked[1].rate - best.rate < MIN_MARGIN) return null;
  return best.language;
}

export interface DocumentLanguageInput {
  /** The document's source, for a declaration; the first few thousand bytes suffice. */
  source: string;
  markup: MarkupLanguage;
  /** The prose that will be read; code, formulas and diagrams are already removed. */
  spokenText: string;
  /** `settings.spellcheckLanguage`: `"auto"`, `""` or a tag such as `pt-BR`. */
  pinned: string;
  /** Tags the operating system can spell, from `spellcheck_languages`. */
  candidates: readonly string[];
  check: DictionaryCheck;
}

/**
 * The language of the document, strongest evidence first.
 *
 * A declaration is the author's statement; the text itself is next; the
 * Dictionary setting is a spelling hint and therefore a fallback, not a veto —
 * a Portuguese document remains Portuguese when the dictionary is pinned to
 * English. Only when all of those are inconclusive do the installed
 * dictionaries vote, which lets a machine with a Spanish dictionary and voice
 * read Spanish without a second detector. An empty answer means "use the
 * platform default".
 */
export async function resolveDocumentLanguage(input: DocumentLanguageInput): Promise<string> {
  const declared = declaredLanguage(input.source, input.markup);
  if (declared) return declared;

  const detected = detectProseLanguage(input.spokenText);
  if (detected) return detected;

  const pinned = input.pinned === "auto" ? null : normalizeLanguageTag(input.pinned);
  if (pinned) return pinned;

  const voted = await voteInstalledLanguage(
    proseWords(input.spokenText),
    input.candidates,
    input.check,
  );
  return voted ?? "";
}
