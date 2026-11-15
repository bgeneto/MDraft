//! Paragraph reflow: Unwrap Paragraph and Wrap Paragraph.
//!
//! In Markdown, LaTeX, Typst and AsciiDoc a single newline inside an ordinary
//! paragraph renders as a space. Swapping one for the other at a safe position
//! therefore changes the source's line structure without changing what the
//! document prints. Everything in this module exists to find the positions
//! that are *not* safe: a `%` comment, a hard break, a literal, a line that
//! would read as a heading or list item once a break puts it at a line start.
//!
//! Each language supplies a `Dialect`: a line classifier that marks what may be
//! rewritten, plus the three predicates the wrapper needs to avoid creating
//! structure. The engine only ever replaces whole paragraph lines; protected
//! lines are never part of a change, so they stay byte-identical.

export type ReflowMode = "unwrap" | "wrap";

export interface ReflowOptions {
  mode: ReflowMode;
  /** Wrap column, in display columns. Ignored by unwrap. */
  column: number;
  /** Tab stop width used to measure leading tabs. */
  tabSize?: number;
}

/** What a classifier says about one source line. */
export interface LineInfo {
  kind: "blank" | "protected" | "text";
  /** A text line that begins a new paragraph even after another text line. */
  start?: boolean;
  /** Characters at the line start that are structure (indent, marker, `>`). */
  prefixLen?: number;
  /** Prefix for generated continuation lines, decided on a paragraph's first line. */
  contPrefix?: string;
  /** The newline after this line is not a plain space and must stay. */
  breakAfter?: boolean;
  /** Why a protected line is protected, when the reader should be told. */
  note?: string;
}

export interface Dialect {
  classify(text: string): LineInfo[];
  /** Would a continuation line with this content read as structure? */
  isStructural(line: string): boolean;
  /** Does a line ending like this end in a hard break (or a comment)? */
  endsWithBreak(line: string): boolean;
  /** `[from, to)` ranges of a joined segment that a break must not split. */
  unbreakable(segment: string): Array<[number, number]>;
}

export interface ReflowChange {
  from: number;
  to: number;
  insert: string;
}

export interface ReflowResult {
  changes: ReflowChange[];
  /** Paragraphs found in the requested ranges. */
  paragraphs: number;
  /** Paragraphs whose text actually changed. */
  changed: number;
  /** Notes for protected lines inside the requested ranges, one per reason. */
  skipped: Array<{ line: number; reason: string }>;
}

interface Block {
  first: number;
  last: number;
}

/** Split into lines, remembering where each starts. `\r\n` is kept as content-free. */
function splitLines(text: string): { lines: string[]; starts: number[] } {
  const lines: string[] = [];
  const starts: number[] = [];
  let at = 0;
  for (;;) {
    starts.push(at);
    const nl = text.indexOf("\n", at);
    if (nl < 0) {
      lines.push(text.slice(at));
      break;
    }
    lines.push(text.slice(at, nl));
    at = nl + 1;
  }
  return { lines, starts };
}

// East Asian Wide and Fullwidth ranges, plus the emoji planes: a character from
// these occupies two columns in a monospaced editor.
const WIDE =
  /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦\u{1F300}-\u{1F64F}\u{1F900}-\u{1F9FF}\u{20000}-\u{3FFFD}]/u;

/** Display width of `text` starting at column `start`. */
export function displayWidth(text: string, start = 0, tabSize = 4): number {
  let column = start;
  for (const ch of text) {
    if (ch === "\t") column += tabSize - (column % tabSize);
    else if (WIDE.test(ch)) column += 2;
    else column += 1;
  }
  return column - start;
}

/** Whether `[from, to)` lies inside one of `ranges`. */
function inside(ranges: Array<[number, number]>, at: number): boolean {
  for (const [from, to] of ranges) if (at > from && at < to) return true;
  return false;
}

/**
 * Join a paragraph's lines into segments. A segment ends at a hard break; each
 * segment becomes one output line on unwrap, and is filled on wrap.
 */
function segmentsOf(lines: string[], infos: LineInfo[], block: Block): string[] {
  const segments: string[] = [];
  let current: string | null = null;
  for (let index = block.first; index <= block.last; index += 1) {
    const info = infos[index];
    let piece = lines[index].slice(info.prefixLen ?? 0);
    // Leading space is insignificant on a continuation line in all four
    // languages; on the first line the prefix already ends where content starts.
    if (index !== block.first) piece = piece.trimStart();
    // Trailing space is kept only where it is the hard break itself (Markdown's
    // two spaces); everywhere else it is noise the join would double.
    if (!info.breakAfter) piece = piece.trimEnd();
    current = current === null ? piece : `${current} ${piece}`;
    if (info.breakAfter && index < block.last) {
      segments.push(current);
      current = null;
    }
  }
  if (current !== null) segments.push(current);
  return segments;
}

/**
 * Fill one segment to `column`, first-fit. A break is placed only at a space
 * outside every unbreakable range, never where it would leave a hard-break
 * ending, and never where the next line would read as structure. When no safe
 * break exists the line runs past the column: correctness beats width.
 */
function fill(
  segment: string,
  firstPrefix: string,
  contPrefix: string,
  dialect: Dialect,
  column: number,
  tabSize: number,
): string[] {
  const guard = dialect.unbreakable(segment);
  // Candidate tokens: maximal runs between breakable spaces.
  const tokens: Array<{ text: string; gap: string }> = [];
  let from = 0;
  let at = 0;
  while (at < segment.length) {
    if (segment[at] === " " && !inside(guard, at) && at > 0) {
      let end = at;
      while (end < segment.length && segment[end] === " ") end += 1;
      if (end >= segment.length) break;
      if (!inside(guard, end - 1) && !inside(guard, end)) {
        tokens.push({ text: segment.slice(from, at), gap: segment.slice(at, end) });
        from = end;
        at = end;
        continue;
      }
      at = end;
      continue;
    }
    at += 1;
  }
  tokens.push({ text: segment.slice(from), gap: "" });

  const lines: string[] = [];
  let line = firstPrefix + tokens[0].text;
  for (let index = 1; index < tokens.length; index += 1) {
    const joined = line + tokens[index - 1].gap + tokens[index].text;
    if (displayWidth(joined, 0, tabSize) <= column) {
      line = joined;
      continue;
    }
    // Break before tokens[index], unless that would create structure.
    // The structure test reads the content after the continuation prefix: the
    // prefix itself (`> `, an item's hanging indent) is already structure the
    // classifier strips.
    const next = previewLine(tokens, index, contPrefix, column, tabSize).slice(contPrefix.length);
    if (dialect.endsWithBreak(line) || dialect.isStructural(next)) {
      line = joined;
      continue;
    }
    lines.push(line);
    line = contPrefix + tokens[index].text;
  }
  lines.push(line);
  return lines;
}

/** The greedy line that would start at token `index`, for the structure check. */
function previewLine(
  tokens: Array<{ text: string; gap: string }>,
  index: number,
  contPrefix: string,
  column: number,
  tabSize: number,
): string {
  let line = contPrefix + tokens[index].text;
  for (let next = index + 1; next < tokens.length; next += 1) {
    const joined = line + tokens[next - 1].gap + tokens[next].text;
    if (displayWidth(joined, 0, tabSize) > column) break;
    line = joined;
  }
  return line;
}

/** The continuation prefix for a paragraph. */
function continuationPrefix(lines: string[], infos: LineInfo[], block: Block): string {
  // A paragraph that already has continuation lines keeps their indentation:
  // the writer chose it, and keeping it makes Wrap idempotent.
  if (block.last > block.first) {
    const second = block.first + 1;
    return lines[second].slice(0, infos[second].prefixLen ?? 0);
  }
  return infos[block.first].contPrefix ?? "";
}

/** Group text lines into paragraphs. */
function blocksOf(infos: LineInfo[]): Block[] {
  const blocks: Block[] = [];
  let current: Block | null = null;
  infos.forEach((info, index) => {
    if (info.kind !== "text") {
      current = null;
      return;
    }
    if (current === null || info.start) {
      current = { first: index, last: index };
      blocks.push(current);
    } else {
      current.last = index;
    }
  });
  return blocks;
}

/**
 * Reflow every paragraph that intersects one of `ranges` (document offsets).
 * An empty range selects the paragraph at that position.
 */
export function reflow(
  text: string,
  ranges: ReadonlyArray<{ from: number; to: number }>,
  dialect: Dialect,
  options: ReflowOptions,
): ReflowResult {
  const tabSize = options.tabSize ?? 4;
  const { lines, starts } = splitLines(text);
  const infos = dialect.classify(text);
  const lineOf = (offset: number): number => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (starts[mid] <= offset) low = mid;
      else high = mid - 1;
    }
    return low;
  };
  const wanted = ranges.map((range) => {
    const first = lineOf(Math.min(range.from, range.to));
    let last = lineOf(Math.max(range.from, range.to));
    // A selection that ends at the start of a line does not select that line.
    if (last > first && starts[last] === Math.max(range.from, range.to)) last -= 1;
    return [first, last] as const;
  });
  const selected = (first: number, last: number) =>
    wanted.some(([from, to]) => first <= to && last >= from);

  const result: ReflowResult = { changes: [], paragraphs: 0, changed: 0, skipped: [] };
  const reasons = new Set<string>();
  infos.forEach((info, index) => {
    if (
      info.kind === "protected" &&
      info.note &&
      selected(index, index) &&
      !reasons.has(info.note)
    ) {
      reasons.add(info.note);
      result.skipped.push({ line: index + 1, reason: info.note });
    }
  });

  for (const block of blocksOf(infos)) {
    if (!selected(block.first, block.last)) continue;
    result.paragraphs += 1;
    const firstPrefix = lines[block.first].slice(0, infos[block.first].prefixLen ?? 0);
    const contPrefix = continuationPrefix(lines, infos, block);
    const segments = segmentsOf(lines, infos, block);
    const out: string[] = [];
    segments.forEach((segment, index) => {
      const lead = index === 0 ? firstPrefix : contPrefix;
      if (options.mode === "unwrap") out.push(lead + segment);
      else out.push(...fill(segment, lead, contPrefix, dialect, options.column, tabSize));
    });
    const from = starts[block.first];
    const to = starts[block.last] + lines[block.last].length;
    const insert = out.join("\n");
    if (insert !== text.slice(from, to)) {
      result.changes.push({ from, to, insert });
      result.changed += 1;
    }
  }
  return result;
}

/** Apply `changes` (sorted, non-overlapping) to `text`. For tests and inactive tabs. */
export function applyChanges(text: string, changes: readonly ReflowChange[]): string {
  let out = "";
  let at = 0;
  for (const change of changes) {
    out += text.slice(at, change.from) + change.insert;
    at = change.to;
  }
  return out + text.slice(at);
}

/** Split helper shared by the classifiers. */
export function linesOf(text: string): string[] {
  return splitLines(text).lines;
}

/** The leading whitespace of a line. */
export function indentOf(line: string): string {
  return /^[ \t]*/.exec(line)?.[0] ?? "";
}

/** Whether the character at `at` is preceded by an odd number of backslashes. */
export function escaped(text: string, at: number): boolean {
  let count = 0;
  for (let before = at - 1; before >= 0 && text[before] === "\\"; before -= 1) count += 1;
  return count % 2 === 1;
}

/**
 * Ranges of `open … close` spans in `text`, single-character delimiters, with
 * backslash escapes respected. Used for inline math and code spans.
 */
export function delimitedSpans(text: string, open: string, close = open): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  let at = 0;
  while (at < text.length) {
    const start = text.indexOf(open, at);
    if (start < 0) break;
    if (escaped(text, start)) {
      at = start + open.length;
      continue;
    }
    let end = text.indexOf(close, start + open.length);
    while (end >= 0 && escaped(text, end)) end = text.indexOf(close, end + close.length);
    if (end < 0) break;
    spans.push([start, end + close.length]);
    at = end + close.length;
  }
  return spans;
}

/** Ranges of backtick code spans (any run length), CommonMark-style. */
export function backtickSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  const run = /`+/g;
  let match: RegExpExecArray | null;
  while ((match = run.exec(text)) !== null) {
    const fence = match[0];
    const start = match.index;
    const closing = new RegExp(`(?<!\`)${fence}(?!\`)`, "g");
    closing.lastIndex = start + fence.length;
    const end = closing.exec(text);
    if (!end) continue;
    spans.push([start, end.index + fence.length]);
    run.lastIndex = end.index + fence.length;
  }
  return spans;
}
