//! Locale-aware word segmentation with positions in the original source.

import { sourceRange } from "./escaped-text.ts";
import type { WebPassage } from "./web-passages.ts";

export interface PassageWord {
  from: number;
  to: number;
  word: string;
  raw: string;
  passage: WebPassage;
}

interface Segment {
  segment: string;
  index: number;
  isWordLike?: boolean;
}

type SegmenterConstructor = new (
  locale?: string,
  options?: { granularity: "word" },
) => { segment(text: string): Iterable<Segment> };

function segments(text: string, locale: string | null): Segment[] {
  const constructor = (Intl as typeof Intl & { Segmenter?: SegmenterConstructor }).Segmenter;
  if (constructor) {
    try {
      return [
        ...new constructor(locale || undefined, { granularity: "word" }).segment(text),
      ].filter((segment) => segment.isWordLike);
    } catch {
      // A malformed or unsupported locale must not make the editor fail.
    }
  }
  return [...text.matchAll(/[\p{L}\p{M}]+(?:['\u2019\u2018\u02bc][\p{L}\p{M}]+)*/gu)].map(
    (match) => ({ segment: match[0], index: match.index }),
  );
}

function nonProseRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const patterns = [
    /\b(?:https?:\/\/|www\.)[^\s<>"']+/giu,
    /\b[\p{L}\p{N}.!#$%&'*+/=?^_\x60{|}~-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}\b/gu,
    /(?:^|[\s(])(?:\.{1,2}[\\/]|[a-z]:[\\/]|\/)[^\s<>"']+/giu,
    /\b(?:0x[0-9a-f]+|[a-f0-9]{16,})\b/giu,
  ];
  for (const pattern of patterns)
    for (const match of text.matchAll(pattern))
      ranges.push([match.index, match.index + match[0].length]);
  return ranges;
}

export function passageWords(
  passage: WebPassage,
  sliceSource: (from: number, to: number) => string,
  locale: string | null,
  sourceLength?: number,
): PassageWord[] {
  const words: PassageWord[] = [];
  const excluded = nonProseRanges(passage.text);
  const parts =
    passage.kind === "identifier"
      ? [
          ...passage.text.matchAll(
            /\p{Lu}+(?=\p{Lu}\p{Ll}|[_\p{N}]|$)|\p{Lu}?\p{Ll}[\p{Ll}\p{M}]*|\p{L}[\p{M}]*/gu,
          ),
        ].map((match) => ({ segment: match[0], index: match.index }))
      : segments(passage.text, locale);
  for (const segment of parts) {
    if (!/\p{L}/u.test(segment.segment) || /\p{N}/u.test(segment.segment)) continue;
    if (
      excluded.some(
        ([from, to]) => segment.index < to && segment.index + segment.segment.length > from,
      )
    )
      continue;
    const range = sourceRange(passage, segment.index, segment.index + segment.segment.length);
    if (!range) continue;
    const from = passage.from + range.from;
    const to = passage.from + range.to;
    if (from < passage.from || to > passage.to || from >= to) continue;
    const wordCharacter = /[\p{L}\p{M}\p{N}'\u2019\u2018\u02bc]/u;
    if (passage.encoding === "plain" && sourceLength !== undefined) {
      if (
        from === passage.from &&
        from > 0 &&
        wordCharacter.test(sliceSource(from - 1, from)) &&
        wordCharacter.test(sliceSource(from, from + 1))
      )
        continue;
      if (
        to === passage.to &&
        to < sourceLength &&
        wordCharacter.test(sliceSource(to - 1, to)) &&
        wordCharacter.test(sliceSource(to, to + 1))
      )
        continue;
    }
    words.push({
      from,
      to,
      word: segment.segment.normalize("NFC").replace(/[\u2019\u2018\u02bc]/g, "'"),
      raw: sliceSource(from, to),
      passage,
    });
  }
  return words;
}
