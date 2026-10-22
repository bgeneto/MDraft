//! HTML text identities and decoded/raw UTF-16 boundaries. Both selection
//! directions use the table built with the guest, never a source search.
import { parseFragment } from "parse5";

export interface HtmlTextFragment {
  n: number;
  index: number;
  src0: number;
  src1: number;
  raw: string;
  text: string;
  /** null inside an entity expansion; never invent an interior source offset. */
  offsets?: (number | null)[] | null;
}

export interface HtmlTextSelection {
  n: number;
  index: number;
  start: number;
  end: number;
  sample: string;
}

export interface HtmlSelection extends HtmlTextSelection {
  reveal: boolean;
  segments?: HtmlTextSelection[];
}

const entityCache = new Map<string, { text: string; length: number }>();

function entityAt(raw: string, at: number): { text: string; length: number } | null {
  const candidate = /^&(?:#[xX][\da-fA-F]+;?|#\d+;?|[a-zA-Z][\da-zA-Z]{0,32};?)/.exec(
    raw.slice(at),
  )?.[0];
  if (!candidate) return null;
  const cached = entityCache.get(candidate);
  if (cached) return cached;
  const tree = parseFragment(candidate);
  const text = tree.childNodes
    .map((node) => (node.nodeName === "#text" && "value" in node ? node.value : ""))
    .join("");
  if (text === candidate) return null;
  // Legacy references may omit a semicolon: the unchanged suffix in &copycat
  // remains ordinary text, with independently addressable source characters.
  let suffix = 0;
  while (
    suffix < text.length - 1 &&
    suffix < candidate.length &&
    text[text.length - suffix - 1] === candidate[candidate.length - suffix - 1]
  )
    suffix += 1;
  const result = { text: text.slice(0, text.length - suffix), length: candidate.length - suffix };
  if (entityCache.size >= 256) entityCache.clear();
  entityCache.set(candidate, result);
  return result;
}

/** Decode with HTML5 rules, retaining only valid source boundaries. */
export function htmlDecodedOffsets(raw: string, expected?: string): (number | null)[] | null {
  const offsets: (number | null)[] = [0];
  let decoded = "";
  for (let at = 0; at < raw.length;) {
    let text = raw[at];
    let length = 1;
    if (text === "\r") {
      text = "\n";
      length = raw[at + 1] === "\n" ? 2 : 1;
    } else if (text === "&") {
      const entity = entityAt(raw, at);
      if (entity) ({ text, length } = entity);
    }
    decoded += text;
    for (let i = 1; i < text.length; i += 1) offsets.push(null);
    at += length;
    offsets.push(at);
  }
  return expected === undefined || expected === decoded ? offsets : null;
}

export function rawOffsetForDecoded(raw: string, offset: number): number | null {
  if (!Number.isInteger(offset) || offset < 0) return null;
  return htmlDecodedOffsets(raw)?.[offset] ?? null;
}

function boundaries(fragment: HtmlTextFragment): (number | null)[] | null {
  if (fragment.offsets === undefined)
    fragment.offsets = htmlDecodedOffsets(fragment.raw, fragment.text);
  return fragment.offsets;
}

/** Validate every node/sample, including multi-node selections, before painting. */
export function htmlSourceRange(
  fragments: readonly HtmlTextFragment[],
  selection: HtmlSelection,
): { from: number; to: number } | null {
  const segments = selection.segments ?? [selection];
  if (!Array.isArray(segments) || segments.length === 0 || segments.length > 128) return null;
  let first = -1,
    last = -1,
    previous = -1,
    length = 0;
  for (const segment of segments) {
    if (
      !segment ||
      ![segment.n, segment.index, segment.start, segment.end].every(Number.isInteger) ||
      segment.start < 0 ||
      segment.end <= segment.start ||
      typeof segment.sample !== "string"
    )
      return null;
    const index = fragments.findIndex(
      (entry) => entry.n === segment.n && entry.index === segment.index,
    );
    const fragment = fragments[index];
    if (
      !fragment ||
      index <= previous ||
      segment.end > fragment.text.length ||
      fragment.text.slice(segment.start, segment.end) !== segment.sample
    )
      return null;
    length += segment.sample.length;
    if (length > 2000) return null;
    const table = boundaries(fragment);
    const from = table?.[segment.start],
      to = table?.[segment.end];
    if (from === null || from === undefined || to === null || to === undefined) return null;
    if (first < 0) first = fragment.src0 + from;
    if (fragment.src0 + from < last) return null;
    last = fragment.src0 + to;
    previous = index;
  }
  return first >= 0 && last > first ? { from: first, to: last } : null;
}

/** The inverse table; the guest receives identities and decoded offsets only. */
export function htmlRangesForSource(
  fragments: readonly HtmlTextFragment[],
  from: number,
  to: number,
): HtmlTextSelection[] {
  const ranges: HtmlTextSelection[] = [];
  const lo = Math.min(from, to),
    hi = Math.max(from, to);
  for (const fragment of fragments) {
    if (fragment.src1 <= lo || fragment.src0 >= hi) continue;
    const table = boundaries(fragment);
    if (!table) continue;
    const rawStart = Math.max(0, lo - fragment.src0),
      rawEnd = Math.min(fragment.raw.length, hi - fragment.src0);
    let start = 0,
      end = fragment.text.length;
    for (let i = 0; i < table.length; i += 1) {
      const at = table[i];
      if (at === null) continue;
      if (at <= rawStart) start = i;
      if (at >= rawEnd) {
        end = i;
        break;
      }
    }
    if (end > start && fragment.text.slice(start, end).trim()) {
      ranges.push({
        n: fragment.n,
        index: fragment.index,
        start,
        end,
        sample: fragment.text.slice(start, end),
      });
    }
    if (ranges.length > 128) return [];
  }
  return ranges;
}
