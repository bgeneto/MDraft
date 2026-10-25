//! Find the link or image under a source offset.
//!
//! The editor has the raw text, not a rendered tree: a `marked` token or a
//! parse5 node does not carry the source offset of its destination, and a
//! half-written link is exactly what a reader is most likely to click. This
//! module therefore reads the line around the offset (plus the whole document
//! only for Markdown reference definitions) and answers one question: is there
//! a target here, and what kind is it?
//!
//! Pure and dependency-free, so the four languages can be tested without an
//! application.

import type { DocumentLanguage } from "./api.ts";

export type LinkKind = "external" | "anchor" | "file" | "image";

export interface LinkTarget {
  href: string;
  kind: LinkKind;
}

/** The line containing `offset`, with its document start. */
function lineWindow(text: string, offset: number): { start: number; line: string } {
  const at = Math.max(0, Math.min(offset, text.length));
  const start = text.lastIndexOf("\n", Math.max(0, at - 1)) + 1;
  const end = text.indexOf("\n", at);
  return { start, line: text.slice(start, end === -1 ? text.length : end) };
}

function classify(href: string, image = false): LinkKind {
  if (href.startsWith("#")) return "anchor";
  if (/^(?:https?|mailto|tel):/i.test(href)) return "external";
  return image ? "image" : "file";
}

function target(href: string, image = false): LinkTarget | null {
  const value = href.trim();
  if (!value) return null;
  return { href: value, kind: classify(value, image) };
}

/** True when the offset sits inside a fenced code block. */
function inFence(text: string, offset: number, language: DocumentLanguage): boolean {
  const marker = language === "asciidoc" ? /^\s*(?:```|~~~|----|\.\.\.\.)/ : /^\s*(?:```|~~~)/;
  let open = false;
  let index = 0;
  while (index <= offset && index <= text.length) {
    const end = text.indexOf("\n", index);
    const stop = end === -1 ? text.length : end;
    const line = text.slice(index, stop);
    if (marker.test(line)) open = !open;
    if (offset <= stop) return open;
    index = stop + 1;
  }
  return open;
}

/** True when the offset sits inside an inline code span on its line. */
function inInlineCode(line: string, column: number): boolean {
  let ticks = 0;
  for (let i = 0; i < column; i += 1) {
    if (line[i] === "`" && line[i - 1] !== "\\") ticks += 1;
  }
  return ticks % 2 === 1;
}

/** A run of backticks before the offset means the reader is in code. */
function inCode(text: string, offset: number, language: DocumentLanguage): boolean {
  if (inFence(text, offset, language)) return true;
  const { start, line } = lineWindow(text, offset);
  return inInlineCode(line, Math.max(0, offset - start));
}

function trimUrl(value: string): string {
  let out = value;
  while (/[.,;:!?]$/.test(out)) out = out.slice(0, -1);
  for (;;) {
    if (!out.endsWith(")")) break;
    const opens = (out.match(/\(/g) ?? []).length;
    const closes = (out.match(/\)/g) ?? []).length;
    if (opens >= closes) break;
    out = out.slice(0, -1);
  }
  return out;
}

function bareUrlAt(line: string, column: number): LinkTarget | null {
  const pattern = /https?:\/\/[^\s<>"'`[\]]+/gi;
  for (const match of line.matchAll(pattern)) {
    const raw = match[0];
    const href = trimUrl(raw);
    const start = match.index ?? 0;
    if (column >= start && column < start + href.length) return target(href);
  }
  return null;
}

/** Decode the entities that can appear in an HTML attribute value. */
function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)));
}

/**
 * Markdown: inline links and images with balanced parentheses, reference
 * links, definition lines, autolinks, bare URLs and embedded HTML.
 */
function markdownAt(text: string, offset: number): LinkTarget | null {
  const { start, line } = lineWindow(text, offset);
  const column = offset - start;

  // A definition line points at its own destination.
  const definition = /^[ ]{0,3}\[([^\]]+)\]:\s*(\S+)/.exec(line);
  if (definition && column >= definition[1].length + 2) {
    return target(definition[2]);
  }

  type Candidate = { from: number; to: number; href: string; image: boolean };
  const candidates: Candidate[] = [];

  // Scan every bracket rather than matching non-overlapping runs: in
  // `[![alt](img.png)](page.md)` the inner image starts before the outer link
  // ends, and a global regex would consume it as part of the outer text.
  for (let bracket = 0; bracket < line.length; bracket += 1) {
    if (line[bracket] !== "[") continue;
    const image = bracket > 0 && line[bracket - 1] === "!";
    const from = image ? bracket - 1 : bracket;
    if (line[from - 1] === "\\") continue;
    const close = matchingBracket(line, bracket);
    if (close < 0) continue;
    const after = line[close + 1];

    if (after === "(") {
      const parsed = inlineDestination(line, close + 1);
      if (!parsed) continue;
      candidates.push({ from, to: parsed.end, href: parsed.href, image });
      continue;
    }

    if (after === "[") {
      const idClose = line.indexOf("]", close + 2);
      if (idClose < 0) continue;
      const written = line.slice(close + 2, idClose).trim();
      const label = line.slice(bracket + 1, close).trim();
      const id = (written || label).toLowerCase();
      const href = id ? referenceTarget(text, id) : null;
      if (!href) continue;
      candidates.push({ from, to: idClose + 1, href, image });
      continue;
    }

    const label = line
      .slice(bracket + 1, close)
      .trim()
      .toLowerCase();
    const href = label ? referenceTarget(text, label) : null;
    if (!href) continue;
    candidates.push({ from, to: close + 1, href, image });
  }

  for (const match of line.matchAll(/<(https?:\/\/[^>\s]+)>/gi)) {
    const from = match.index ?? 0;
    candidates.push({
      from,
      to: from + match[0].length,
      href: match[1],
      image: false,
    });
  }

  // The innermost construct wins: in `[![alt](img.png)](page.md)` a click on
  // the image must open the image.
  let best: Candidate | null = null;
  for (const candidate of candidates) {
    if (column < candidate.from || column >= candidate.to) continue;
    if (!best || candidate.from >= best.from) best = candidate;
  }
  if (best) return target(best.href, best.image);

  const html = htmlAt(line, column);
  if (html) return html;
  return bareUrlAt(line, column);
}

/** The `]` matching the `[` at `open`, counting nested brackets. */
function matchingBracket(line: string, open: number): number {
  let depth = 0;
  for (let i = open; i < line.length; i += 1) {
    if (line[i] === "\\") {
      i += 1;
      continue;
    }
    if (line[i] === "[") depth += 1;
    else if (line[i] === "]") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Parse `(destination "title")` starting at the opening parenthesis. */
function inlineDestination(line: string, open: number): { href: string; end: number } | null {
  if (line[open] !== "(") return null;
  let i = open + 1;
  while (i < line.length && /\s/.test(line[i])) i += 1;
  if (i >= line.length) return null;

  let href: string;
  if (line[i] === "<") {
    const close = line.indexOf(">", i + 1);
    if (close < 0) return null;
    href = line.slice(i + 1, close);
    i = close + 1;
  } else {
    const from = i;
    let depth = 0;
    while (i < line.length) {
      const ch = line[i];
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === "(") depth += 1;
      else if (ch === ")") {
        if (depth === 0) break;
        depth -= 1;
      } else if (/\s/.test(ch) && depth === 0) break;
      i += 1;
    }
    href = line.slice(from, i);
  }

  while (i < line.length && /\s/.test(line[i])) i += 1;
  if (line[i] === '"' || line[i] === "'" || line[i] === "(") {
    const quote = line[i] === "(" ? ")" : line[i];
    const close = line.indexOf(quote, i + 1);
    if (close >= 0) i = close + 1;
  }
  while (i < line.length && /\s/.test(line[i])) i += 1;
  if (line[i] !== ")") return null;
  return { href, end: i + 1 };
}

function referenceTarget(text: string, id: string): string | null {
  const pattern = /^[ ]{0,3}\[([^\]]+)\]:\s*(\S+)/gm;
  for (const match of text.matchAll(pattern)) {
    if (match[1].trim().toLowerCase() === id) return match[2];
  }
  return null;
}

/** The `href`/`src` of the tag that contains the column, or null. */
function htmlAt(line: string, column: number): LinkTarget | null {
  const open = line.lastIndexOf("<", Math.max(0, column));
  const close = line.indexOf(">", column);
  if (open < 0 || close < 0 || close < column) return null;
  const tag = line.slice(open + 1, close);
  const name = /^([a-zA-Z][\w-]*)/.exec(tag)?.[1].toLowerCase();
  if (!name || name === "script" || name === "style") return null;

  const attribute = /(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  for (const match of tag.matchAll(attribute)) {
    const value = match[1] ?? match[2] ?? match[3] ?? "";
    const start = match.index ?? 0;
    let valueAt = tag.indexOf("=", start) + 1;
    while (valueAt > 0 && valueAt < tag.length && /\s/.test(tag[valueAt])) valueAt += 1;
    if (tag[valueAt] === '"' || tag[valueAt] === "'") valueAt += 1;
    const absolute = open + 1 + valueAt;
    if (column >= absolute && column < absolute + value.length) {
      return target(decodeEntities(value), /^src\s*=/i.test(match[0]));
    }
  }
  return null;
}

/** True when the offset sits inside an HTML `<script>` or `<style>` body. */
function inHtmlRawText(text: string, offset: number): boolean {
  const lower = text.toLowerCase();
  for (const tag of ["script", "style"]) {
    const open = lower.lastIndexOf(`<${tag}`, offset);
    if (open < 0) continue;
    const close = lower.indexOf(`</${tag}`, open);
    if (close < 0 || offset < close) return true;
  }
  return false;
}

/** AsciiDoc: image, link, xref, `<<id>>` and bare URLs. */
function asciidocAt(text: string, offset: number): LinkTarget | null {
  const { start, line } = lineWindow(text, offset);
  const column = offset - start;

  const macros: Array<{ pattern: RegExp; image: boolean; anchor?: boolean }> = [
    { pattern: /\bimage:{1,2}([^\s[\]]+)\[/g, image: true },
    { pattern: /\blink:([^\s[]+)\[/g, image: false },
    { pattern: /\bxref:([^\s[]+)\[/g, image: false },
  ];
  for (const macro of macros) {
    for (const match of line.matchAll(macro.pattern)) {
      const from = match.index ?? 0;
      const to = from + match[0].length;
      if (column < from || column >= to) continue;
      const href = macro.anchor ? `#${match[1]}` : match[1];
      return target(href, macro.image);
    }
  }

  for (const match of line.matchAll(/<<([^>\s,]+)(?:,[^>]*)?>>/g)) {
    const from = match.index ?? 0;
    const to = from + match[0].length;
    if (column >= from && column < to) return target(`#${match[1]}`);
  }

  return bareUrlAt(line, column);
}

/** Typst: `#link("…")`, `#image("…")` and bare URLs. */
function typstAt(text: string, offset: number): LinkTarget | null {
  const { start, line } = lineWindow(text, offset);
  const column = offset - start;

  for (const match of line.matchAll(/#(link|image)\(\s*"((?:[^"\\]|\\.)*)"/g)) {
    const from = match.index ?? 0;
    const to = from + match[0].length;
    if (column < from || column >= to) continue;
    const href = match[2].replace(/\\(["\\])/g, "$1");
    return target(href, match[1] === "image");
  }

  return bareUrlAt(line, column);
}

/**
 * The link or image target under `offset`, or null.
 *
 * A target inside a code span, a fenced block or a script/style tag is not a
 * link: opening it would be a surprise.
 */
export function linkAt(
  text: string,
  offset: number,
  language: DocumentLanguage,
): LinkTarget | null {
  if (offset < 0 || offset > text.length) return null;
  if (inCode(text, offset, language)) return null;
  if (language === "html") {
    if (inHtmlRawText(text, offset)) return null;
    const { start, line } = lineWindow(text, offset);
    return htmlAt(line, offset - start) ?? bareUrlAt(line, offset - start);
  }
  if (language === "asciidoc") return asciidocAt(text, offset);
  if (language === "typst") return typstAt(text, offset);
  return markdownAt(text, offset);
}
