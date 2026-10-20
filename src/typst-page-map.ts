//! Mapping a line of PDF text back to its occurrence in the Typst source.
//!
//! The PDF text layer tells us which words were clicked, but not where they
//! came from. Searching for the selected word alone is not enough: a repeated
//! word maps to its first occurrence, and a two-column page makes the mistake
//! obvious. The line around the click is a much stronger key. Its word sequence
//! is matched against the source, so the *same* occurrence is found even when
//! the word appears many times.
//!
//! This is still a text heuristic. Generated content (`#lorem`, a `#let` value)
//! has no source line and maps to nothing rather than to a plausible wrong one.

/** A word and its UTF-16 range in the string it was tokenized from. */
export interface WordToken {
  text: string;
  norm: string;
  from: number;
  to: number;
}

/** A word in the Typst source. */
export type SourceWord = WordToken;

/** Where a PDF line's words sit in the source. */
export interface LineMatch {
  lineWords: WordToken[];
  /** Index in `lineWords` at which the source match starts. */
  matchedAt: number;
  /** Index in the source words matching `lineWords[matchedAt]`. */
  sourceAt: number;
  /** Number of consecutive line words matched from `matchedAt`. */
  score: number;
}

// A soft hyphen is a break opportunity inside a word, not a word boundary.
// Without it `co\u00adoperate` tokenises as two words and can never match the
// one word the PDF drew.
const WORD = /[\p{L}\p{N}_\u00ad]+/gu;
const KEY_SEPARATOR = "\u0001";
const MIN_FRAGMENT = 3;

function normalize(text: string): string {
  return (
    text
      // PDF.js reports what the font drew. A soft hyphen is a break opportunity in
      // the source, and a ligature is one glyph for two letters; neither changes
      // the word the reader clicked, but both break a literal comparison.
      .replace(/\u00ad/g, "")
      .replace(/ﬃ/g, "ffi")
      .replace(/ﬄ/g, "ffl")
      .replace(/ﬀ/g, "ff")
      .replace(/ﬁ/g, "fi")
      .replace(/ﬂ/g, "fl")
      .normalize("NFC")
      .toLocaleLowerCase()
  );
}

/** Split text into words, keeping each word's original range. */
export function tokenizeWords(text: string): WordToken[] {
  const words: WordToken[] = [];
  for (const match of text.matchAll(WORD)) {
    const from = match.index ?? 0;
    const value = match[0];
    words.push({
      text: value,
      norm: normalize(value),
      from,
      to: from + value.length,
    });
  }
  return words;
}

/** The source word map, built once per rendered source string. */
export class TypstSourceMap {
  readonly source: string;
  readonly words: SourceWord[];
  /** 2-, 3- and 4-word source sequences, used to locate a PDF line. */
  private readonly sequences: Map<string, number[]>[];

  constructor(source: string) {
    this.source = source;
    this.words = tokenizeWords(source);
    this.sequences = [new Map(), new Map(), new Map()];
    for (let size = 2; size <= 4; size += 1) {
      const index = this.sequences[size - 2];
      for (let i = 0; i + size <= this.words.length; i += 1) {
        const key = this.key(this.words, i, size);
        const bucket = index.get(key);
        if (bucket) bucket.push(i);
        else index.set(key, [i]);
      }
    }
  }

  /**
   * Find the source occurrence of a PDF line.
   *
   * The longest matching word window wins; `hint` only breaks ties between
   * genuinely identical sequences, so a repeated word no longer decides the
   * answer. A line that starts or ends in a hyphenated fragment still matches a
   * window inside it.
   */
  mapLine(lineText: string, hint = 0): LineMatch | null {
    const lineWords = tokenizeWords(lineText);
    if (lineWords.length === 0) return null;

    const hintWord = this.nearestWord(hint);
    for (let size = 4; size >= 2; size -= 1) {
      if (lineWords.length < size) continue;
      let best: { matchedAt: number; sourceAt: number; score: number; distance: number } | null =
        null;
      const index = this.sequences[size - 2];
      for (let at = 0; at + size <= lineWords.length; at += 1) {
        const key = this.key(lineWords, at, size);
        const candidates = index.get(key);
        if (!candidates) continue;
        for (const sourceAt of candidates) {
          const score = this.score(lineWords, at, sourceAt);
          if (score < size) continue;
          const distance = Math.abs(sourceAt - hintWord);
          if (!best || score > best.score || (score === best.score && distance < best.distance)) {
            best = { matchedAt: at, sourceAt, score, distance };
          }
        }
      }
      if (best) {
        return {
          lineWords,
          matchedAt: best.matchedAt,
          sourceAt: best.sourceAt,
          score: best.score,
        };
      }
    }

    return null;
  }

  /**
   * Map a one-word visual line with its neighbours as context.
   *
   * A heading or a short line often has one word, and the nearest occurrence of
   * that word is not evidence: a repeated heading, or the same word in the other
   * column, wins by being closer to the caret. The neighbouring lines are
   * already indexed, so a window around the word either identifies one source
   * occurrence or there is no answer. Ambiguity paints nothing — the rule from
   * the Typst Pages ADR is that a missing mark is acceptable and a wrong one is
   * not.
   */
  mapLineWithNeighbors(
    lineText: string,
    before: string,
    after: string,
    hint = 0,
  ): LineMatch | null {
    const lineWords = tokenizeWords(lineText);
    if (lineWords.length !== 1) return this.mapLine(lineText, hint);

    const beforeWords = tokenizeWords(before).slice(-2);
    const afterWords = tokenizeWords(after).slice(0, 2);
    const target = beforeWords.length;
    const windowWords = [...beforeWords, ...lineWords, ...afterWords];
    if (windowWords.length < 2) return null;

    const candidates = new Set<number>();
    for (let size = Math.min(4, windowWords.length); size >= 2; size -= 1) {
      const index = this.sequences[size - 2];
      const firstStart = Math.max(0, target - size + 1);
      const lastStart = Math.min(target, windowWords.length - size);
      for (let start = firstStart; start <= lastStart; start += 1) {
        const bucket = index.get(this.key(windowWords, start, size));
        if (!bucket) continue;
        for (const sourceAt of bucket) {
          const sourceTarget = sourceAt + (target - start);
          const candidate = this.words[sourceTarget];
          if (!candidate || candidate.norm !== lineWords[0].norm) continue;
          let intact = true;
          for (let i = 0; i < size; i += 1) {
            const source = this.words[sourceAt + i];
            if (!source || source.norm !== windowWords[start + i].norm) {
              intact = false;
              break;
            }
          }
          if (intact) candidates.add(sourceTarget);
        }
      }
      if (candidates.size === 1) {
        return {
          lineWords,
          matchedAt: 0,
          sourceAt: [...candidates][0],
          score: size,
        };
      }
      if (candidates.size > 1) return null;
    }
    return null;
  }

  /**
   * Source word for one word of a matched line.
   *
   * A line can begin or end in the middle of a hyphenated source word. When the
   * token is a prefix/suffix of the mapped word, the whole source word is the
   * right answer; otherwise no mapping is returned.
   */
  wordForLineToken(match: LineMatch, lineWordIndex: number): SourceWord | null {
    const token = match.lineWords[lineWordIndex];
    if (!token) return null;
    const candidate = this.words[match.sourceAt + lineWordIndex - match.matchedAt];
    if (!candidate) return null;
    if (candidate.norm === token.norm) return candidate;
    if (
      token.norm.length >= MIN_FRAGMENT &&
      (candidate.norm.startsWith(token.norm) || candidate.norm.endsWith(token.norm))
    ) {
      return candidate;
    }
    return null;
  }

  private key(words: readonly WordToken[], start: number, size: number): string {
    let key = "";
    for (let i = 0; i < size; i += 1) {
      key += (i === 0 ? "" : KEY_SEPARATOR) + words[start + i].norm;
    }
    return key;
  }

  private score(lineWords: readonly WordToken[], at: number, sourceAt: number): number {
    let score = 0;
    for (let i = at; i < lineWords.length; i += 1) {
      const source = this.words[sourceAt + i - at];
      if (!source || source.norm !== lineWords[i].norm) break;
      score += 1;
    }
    return score;
  }

  private nearestWord(offset: number): number {
    const target = Math.max(0, offset);
    let low = 0;
    let high = this.words.length - 1;
    let found = 0;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (this.words[mid].from <= target) {
        found = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    return found;
  }
}

/**
 * The word under a line offset.
 *
 * `start` chooses the word containing the offset; `end` chooses the word before
 * a boundary so a browser selection that includes its trailing space still
 * resolves to the selected word.
 */
export function lineTokenAt(
  lineText: string,
  offset: number,
  bias: "start" | "end" = "start",
): { token: WordToken; index: number } | null {
  const words = tokenizeWords(lineText);
  if (words.length === 0) return null;
  const target = Math.max(0, Math.min(offset, lineText.length));

  if (bias === "start") {
    for (let i = 0; i < words.length; i += 1) {
      if (target < words[i].to) {
        if (target >= words[i].from) return { token: words[i], index: i };
        return { token: words[i], index: i };
      }
    }
    return { token: words[words.length - 1], index: words.length - 1 };
  }

  const inside = Math.max(0, target - 1);
  for (let i = words.length - 1; i >= 0; i -= 1) {
    if (inside >= words[i].from) return { token: words[i], index: i };
  }
  return { token: words[0], index: 0 };
}

/**
 * The source paragraph around a character offset.
 *
 * Blank lines delimit paragraphs. A heading or list marker is selected as one
 * line rather than swallowing the following paragraph.
 */
export function paragraphRangeAt(source: string, offset: number): { from: number; to: number } {
  const at = Math.max(0, Math.min(offset, source.length));
  const lineStart = source.lastIndexOf("\n", Math.max(0, at - 1)) + 1;
  const lineEndAt = source.indexOf("\n", at);
  const lineEnd = lineEndAt < 0 ? source.length : lineEndAt;
  const line = source.slice(lineStart, lineEnd);
  if (/^\s*(?:={1,6}\s|\+\s|-\s|\d+\.\s|#\w+\()/.test(line)) {
    return trimRange(source, lineStart, lineEnd);
  }

  let from = source.lastIndexOf("\n\n", at);
  from = from < 0 ? 0 : from + 2;
  let to = source.indexOf("\n\n", at);
  to = to < 0 ? source.length : to;
  return trimRange(source, from, to);
}

function trimRange(source: string, from: number, to: number): { from: number; to: number } {
  while (from < to && /\s/.test(source[from])) from += 1;
  while (to > from && /\s/.test(source[to - 1])) to -= 1;
  return { from, to };
}
