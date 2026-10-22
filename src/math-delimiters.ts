//! Shared, original-source dollar policy. No DOM or destination renderer.
import { markdownProtectedRanges, type SourceRange } from "./markdown-context.ts";

export interface MathRange extends SourceRange {
  body: string;
  display: boolean;
}

export interface MathAnalysis {
  math: MathRange[];
  currency: number[];
  protected: SourceRange[];
  unfinished: SourceRange[];
}

const PREFIXES = new Set([
  "R",
  "US",
  "C",
  "CA",
  "A",
  "AU",
  "NZ",
  "HK",
  "S",
  "SG",
  "NT",
  "RD",
  "Mex",
  "MX",
  "Ch",
  "CLP",
  "COL",
  "COP",
  "ARS",
  "AR",
  "Cr",
  "Cz",
]);
const AMOUNT = /[ \t\u00a0\u202f]*[+−-]?(?:\d+(?:[.,'’ \u00a0\u202f]\d+)*|[.,]\d+)/y;
const INDICATOR = /[\\^_{}=+<>]/;
const ARITHMETIC = /^[+-]?[\p{L}\d.,]+(?:\s*[-+*/]\s*[+-]?[\p{L}\d.,]+)+$/u;

export function isEscaped(source: string, at: number): boolean {
  let start = at;
  while (start > 0 && source[start - 1] === "\\") start--;
  return (at - start) % 2 === 1;
}

function amountEnd(source: string, at: number): number {
  AMOUNT.lastIndex = at;
  return AMOUNT.exec(source)?.index === at ? AMOUNT.lastIndex : -1;
}

function prefixAt(source: string, at: number): string {
  // One Markdown escape is syntax, not a visible separator in R\$5.
  const end = at > 0 && source[at - 1] === "\\" && source[at - 2] !== "\\" ? at - 1 : at;
  let start = end;
  while (start > 0 && end - start <= 4 && /[A-Za-z]/.test(source[start - 1])) start--;
  if (start > 0 && /[\p{L}\d_]/u.test(source[start - 1])) return "";
  return source.slice(start, end);
}

function prefixedAmountEnd(source: string, at: number): number {
  const prefix = prefixAt(source, at);
  const argentine = prefix === "U" && source[at + 1] === "S";
  if (!argentine && !PREFIXES.has(prefix)) return -1;
  const end = amountEnd(source, at + (argentine ? 2 : 1));
  if (end < 0 || /[\p{L}\d_^]/u.test(source[end] ?? "")) return -1;
  if (source[end] === "\\" && /[A-Za-z]/.test(source[end + 1] ?? "")) return -1;
  return end;
}

function validBody(body: string, paddedNumeric: boolean): boolean {
  const trimmed = body.trim();
  if (!trimmed) return false;
  // An unfinished numeric operator is currency followed by a formula opener,
  // not a formula whose last operand disappeared: $5 + $x$.
  if (/^[+−-]?(?:\d[\d.,'’ \u00a0\u202f]*|[.,]\d+)\s*[-+*/=<>→–—]\s*$/.test(body)) return false;
  if (!/^\s|\s$/.test(body)) return true;
  if (/^[\d.,]+$/.test(trimmed)) return paddedNumeric;
  return INDICATOR.test(trimmed) || !/\s/.test(trimmed) || ARITHMETIC.test(trimmed);
}

/** HTML text is already decoded; Markdown alone owns code/URL syntax. */
export function analyzeMath(source: string, markdown = true, paddedNumeric = false): MathAnalysis {
  const protectedRanges = markdown ? markdownProtectedRanges(source) : [];
  const blocked = new Uint8Array(source.length);
  for (const range of protectedRanges)
    blocked.fill(range.barrier === false ? 1 : 3, range.from, range.to);
  const prefixBlocked = new Uint32Array(source.length + 1);
  for (let i = 0; i < source.length; i++)
    prefixBlocked[i + 1] = prefixBlocked[i] + (blocked[i] & 2);
  const math: MathRange[] = [];
  const unfinished: SourceRange[] = [];
  // Preserve explicit-form precedence. Each form consumes nonoverlapping
  // candidates; masks make overlap/boundary checks constant-time.
  const occupied = new Uint8Array(source.length);
  const forms = [
    { open: "$$", close: "$$", display: true },
    { open: "\\[", close: "\\]", display: true },
    { open: "\\(", close: "\\)", display: false },
  ];
  for (const { open, close, display } of forms) {
    const previous = new Uint32Array(source.length + 1);
    for (let i = 0; i < source.length; i++) previous[i + 1] = previous[i] + occupied[i];
    let cursor = 0;
    while (cursor < source.length) {
      const from = source.indexOf(open, cursor);
      if (from < 0) break;
      cursor = from + 2;
      if (blocked[from] || occupied[from] || isEscaped(source, from)) continue;
      let end = source.indexOf(close, cursor);
      while (end >= 0 && isEscaped(source, end)) end = source.indexOf(close, end + 2);
      if (end < 0) {
        unfinished.push({ from, to: source.length });
        occupied.fill(1, from);
        break;
      }
      const to = end + 2;
      cursor = to;
      if (
        end === from + 2 ||
        prefixBlocked[to] !== prefixBlocked[from] ||
        previous[to] !== previous[from]
      )
        continue;
      math.push({ from, to, body: source.slice(from + 2, end).trim(), display });
      occupied.fill(1, from, to);
    }
  }
  const dollars: number[] = [];
  const known = new Map<number, number>();
  const literalClose = new Set<number>();
  for (let i = 0; i < source.length; i++) {
    if (source[i] !== "$" || blocked[i] || occupied[i]) continue;
    const end = prefixedAmountEnd(source, i);
    if (end >= 0) {
      known.set(i, end);
      if (source[end] === "$") literalClose.add(end);
    }
    if (!isEscaped(source, i)) dollars.push(i);
  }
  // Math must precede markup tokenization: a URL-shaped substring in a
  // formula's body is not a boundary, whereas code/tag/explicit math is.
  const boundaries = new Uint32Array(source.length + 1);
  for (let i = 0; i < source.length; i++)
    boundaries[i + 1] = boundaries[i] + (blocked[i] & 2 || occupied[i] ? 1 : 0);
  const currency: number[] = [];
  for (let n = 0; n < dollars.length; n++) {
    const from = dollars[n];
    if (literalClose.has(from)) continue;
    const numeric = amountEnd(source, from + 1) >= 0;
    if (known.has(from)) {
      currency.push(from);
      continue;
    }
    const end = dollars[n + 1];
    const body = end === undefined ? "" : source.slice(from + 1, end);
    const pair =
      end !== undefined &&
      !/[\r\n]/.test(body) &&
      boundaries[end] === boundaries[from] &&
      !literalClose.has(end) &&
      !known.has(end) &&
      !/^(?:\d|[.,+−-]\d)/.test(source.slice(end + 1, end + 3));
    if (pair && validBody(body, paddedNumeric)) {
      math.push({ from, to: end + 1, body: body.trim(), display: false });
      n++;
    } else if (numeric) {
      currency.push(from);
    } else if (pair) {
      n++;
    } else if (end === undefined || /[\r\n]/.test(body)) {
      const newline = source.indexOf("\n", from);
      unfinished.push({ from, to: newline < 0 ? source.length : newline });
    }
  }
  math.sort((a, b) => a.from - b.from);
  return { math, currency, protected: protectedRanges, unfinished };
}

/** The weak Typst detector can retain native padded numeric math evidence. */
export function hasInlineMath(source: string, paddedNumeric = false): boolean {
  if (source.length > 1_000_000) return false;
  return analyzeMath(source, false, paddedNumeric).math.some((range) => !range.display);
}

/** Only insert escapes; never normalize, trim, decode or serialize source. */
export function escapeMarkdownCurrency(source: string): string {
  if (source.length > 1_000_000 || !source.includes("$")) return source;
  const positions = analyzeMath(source).currency;
  let from = 0;
  const out: string[] = [];
  for (const position of positions) {
    out.push(source.slice(from, position), "\\");
    from = position;
  }
  out.push(source.slice(from));
  return out.join("");
}

/** Shared insertion guard for complete selections as well as carets. */
export function markdownProseSelection(source: string, ranges: readonly SourceRange[]): boolean {
  const analysis = analyzeMath(source);
  const protectedRanges = [...analysis.protected, ...analysis.unfinished];
  return ranges.every(
    (selection) =>
      !protectedRanges.some((range) =>
        selection.from === selection.to
          ? (range.barrier === false
              ? selection.from >= range.from
              : selection.from > range.from) && selection.from <= range.to
          : selection.from < range.to && selection.to > range.from,
      ) &&
      !analysis.math.some((range) =>
        selection.from === selection.to
          ? selection.from > range.from && selection.from < range.to
          : selection.from < range.to && selection.to > range.from,
      ),
  );
}
