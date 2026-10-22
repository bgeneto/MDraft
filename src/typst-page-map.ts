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

// A soft hyphen is a break opportunity inside a word, not a word boundary.
// Without it `co\u00adoperate` tokenises as two words and can never match the
// one word the PDF drew.
const WORD = /[\p{L}\p{M}\p{N}_\u00ad]+/gu;
const KEY_SEPARATOR = "\u0001";

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

/** Geometry stays in the PDF adapter; this index knows only reading regions. */
export interface PageMapLine {
  text: string;
  region: string;
}

interface PageWordPart {
  line: number;
  from: number;
  to: number;
}
interface PageWord {
  norm: string;
  parts: PageWordPart[];
  region: string;
}

/** Parse literal markup only. Definitions, comments and math are not prose. */
export async function createTypstPageMap(
  source: string,
  lines: readonly PageMapLine[],
): Promise<TypstPageMap> {
  const { typstParser } = await import("codemirror-lang-typst/lezer");
  const words: SourceWord[] = [];
  typstParser.parse(source).iterate({
    enter(node) {
      if (
        [
          "LetBinding",
          "SetRule",
          "ShowRule",
          "LineComment",
          "BlockComment",
          "Equation",
          "Raw",
          "Import",
          "Include",
        ].includes(node.name)
      )
        return false;
      if (node.name === "Text") {
        for (const word of tokenizeWords(source.slice(node.from, node.to))) {
          words.push({ ...word, from: node.from + word.from, to: node.from + word.to });
        }
        return false;
      }
    },
  });
  return new TypstPageMap(source, lines, words);
}

/** One immutable, bidirectional correspondence index per rendered PDF. */
export class TypstPageMap {
  readonly source: string;
  private readonly words: readonly SourceWord[];
  private readonly pdf: PageWord[] = [];
  private readonly links: (number | null)[];
  private readonly byLine = new Map<number, number[]>();

  constructor(source: string, lines: readonly PageMapLine[], words: readonly SourceWord[]) {
    this.source = source;
    this.words = words;
    const vocabulary = new Set(words.map((word) => word.norm));
    for (let line = 0; line < lines.length; line += 1) {
      const current = lines[line];
      for (const token of tokenizeWords(current.text)) {
        const first = this.pdf.length;
        this.pdf.push({
          norm: token.norm,
          region: current.region,
          parts: [{ line, from: token.from, to: token.to }],
        });
        const bucket = this.byLine.get(line) ?? [];
        bucket.push(first);
        this.byLine.set(line, bucket);
      }
      // Join only when the combined word really exists in literal source text.
      const row = this.byLine.get(line);
      const prior = this.byLine.get(line - 1);
      if (row?.length && prior?.length && lines[line - 1].region === current.region) {
        const a = this.pdf[prior[prior.length - 1]],
          b = this.pdf[row[0]];
        const explicitBreak = /[-\u00ad]\s*$/.test(lines[line - 1].text);
        // Typst's PDF ActualText can omit the visible line-end hyphen. In
        // that case join only two otherwise unknown letter fragments, and
        // still require the combined literal word and normal anchor evidence.
        const implicitBreak =
          a.norm.length >= 2 &&
          b.norm.length >= 2 &&
          /^[\p{L}\p{M}]+$/u.test(a.norm + b.norm) &&
          !vocabulary.has(a.norm) &&
          !vocabulary.has(b.norm);
        if ((explicitBreak || implicitBreak) && vocabulary.has(a.norm + b.norm)) {
          a.norm += b.norm;
          a.parts.push(...b.parts);
          b.norm = "";
          row[0] = prior[prior.length - 1];
        }
      }
    }
    const compact = this.pdf.filter((word) => word.norm.length > 0);
    this.pdf.splice(0, this.pdf.length, ...compact);
    this.byLine.clear();
    this.pdf.forEach((word, at) => {
      for (const part of word.parts) {
        const bucket = this.byLine.get(part.line) ?? [];
        if (!bucket.includes(at)) bucket.push(at);
        this.byLine.set(part.line, bucket);
      }
    });
    this.links = this.pdf.map(() => null);
    const sequence = (items: readonly { norm: string }[], at: number, size: number) =>
      items
        .slice(at, at + size)
        .map((word) => word.norm)
        .join(KEY_SEPARATOR);
    // Unique windows are evidence of occurrence; the editor caret is irrelevant.
    for (let size = 6; size >= 2; size -= 1) {
      const sourceIndex = new Map<string, number>();
      for (let at = 0; at + size <= words.length; at += 1) {
        const key = sequence(words, at, size);
        sourceIndex.set(key, sourceIndex.has(key) ? -1 : at);
      }
      const pageIndex = new Map<string, number>();
      for (let at = 0; at + size <= this.pdf.length; at += 1) {
        const run = this.pdf.slice(at, at + size);
        if (
          run.some((word) => !word.norm || word.region !== run[0].region) ||
          !run.some((word) => /[\p{L}]/u.test(word.norm) && word.norm.length >= 3)
        )
          continue;
        const key = sequence(this.pdf, at, size);
        pageIndex.set(key, pageIndex.has(key) ? -1 : at);
      }
      for (const [key, at] of pageIndex) {
        const start = sourceIndex.get(key);
        if (at < 0 || start === undefined || start < 0) continue;
        for (let i = 0; i < size; i += 1) {
          if (this.links[at + i] === null || this.links[at + i] === start + i)
            this.links[at + i] = start + i;
          else this.links[at + i] = -1;
        }
      }
    }
    // Fill small gaps only between two established anchors. Unknown math and
    // generated text are skipped, never used to shift all following positions.
    for (let at = 0; at < this.pdf.length; at += 1) {
      if (this.links[at] !== null || !this.pdf[at].norm) continue;
      let left = at - 1,
        right = at + 1;
      while (left >= 0 && at - left <= 40 && this.links[left] === null) left -= 1;
      while (right < this.pdf.length && right - at <= 40 && this.links[right] === null) right += 1;
      if (
        left < 0 ||
        right >= this.pdf.length ||
        at - left > 40 ||
        right - at > 40 ||
        this.pdf[left].region !== this.pdf[at].region ||
        this.pdf[right].region !== this.pdf[at].region
      )
        continue;
      const lo = this.links[left],
        hi = this.links[right];
      if (lo === null || hi === null || lo < 0 || hi <= lo || hi - lo > 40) continue;
      const candidates: number[] = [];
      for (let i = lo + 1; i < hi; i += 1)
        if (words[i].norm === this.pdf[at].norm) candidates.push(i);
      if (candidates.length === 1) this.links[at] = candidates[0];
    }
    // One literal source word cannot identify two distinct rendered occurrences.
    const inverse = new Map<number, number[]>();
    for (let at = 0; at < this.links.length; at += 1) {
      const link = this.links[at];
      if (link === null || link < 0) continue;
      const bucket = inverse.get(link) ?? [];
      bucket.push(at);
      inverse.set(link, bucket);
    }
    for (const bucket of inverse.values())
      if (bucket.length > 1) for (const at of bucket) this.links[at] = null;
  }

  private tokenAt(line: number, offset: number, bias: "start" | "end"): number | null {
    for (const at of this.byLine.get(line) ?? []) {
      for (const part of this.pdf[at].parts) {
        if (part.line !== line) continue;
        if (
          bias === "start"
            ? offset >= part.from && offset < part.to
            : offset > part.from && offset <= part.to
        )
          return at;
      }
    }
    return null;
  }

  sourceRange(
    startLine: number,
    start: number,
    endLine: number,
    end: number,
  ): { from: number; to: number } | null {
    const a = this.tokenAt(startLine, start, "start"),
      b = this.tokenAt(endLine, end, "end");
    if (a === null || b === null || this.pdf[a].region !== this.pdf[b].region) return null;
    const first = this.links[a],
      last = this.links[b];
    if (first === null || last === null || first < 0 || last < first) return null;
    return { from: this.words[first].from, to: this.words[last].to };
  }

  wordAt(line: number, offset: number): SourceWord | null {
    const at = this.tokenAt(line, offset, "start");
    const link = at === null ? null : this.links[at];
    return link === null || link < 0 ? null : this.words[link];
  }

  partsForSource(from: number, to: number): PageWordPart[] {
    const parts: PageWordPart[] = [];
    for (let at = 0; at < this.pdf.length; at += 1) {
      const link = this.links[at];
      if (link === null || link < 0) continue;
      const word = this.words[link];
      if (word.from >= to || word.to <= from) continue;
      parts.push(...this.pdf[at].parts);
    }
    return parts;
  }
}
