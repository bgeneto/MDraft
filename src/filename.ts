//! File names for a document that has never been saved.
//!
//! Every editor that creates untitled documents derives the first name from the
//! text, because `untitled.md` is a name the reader has to replace by hand. The
//! order here is the one Word, Pages, Google Docs, Obsidian and Typora converged
//! on: an explicit title, then the first heading, then the first line of prose.
//!
//! The module is pure and synchronous. The Save dialog waits for this value, so
//! it must never touch the network, the DOM or the filesystem; the optional AI
//! suggestion lives in `main.ts` and falls back to what this module returns.
//!
//! One sanitiser serves both paths. A model that ignores its prompt cannot
//! produce an illegal filename, because its answer is cleaned here exactly like
//! a heading is. The rules are the intersection of Windows, macOS and Linux:
//! Windows' reserved characters and device names, no trailing dot or space, a
//! cap by code point (for readability) and by UTF-8 byte (for ext4/APFS's
//! 255-byte component limit).

import type { DocumentLanguage } from "./api";

/** The name used when the document offers nothing better. */
export const UNTITLED_STEM = "untitled";
/** A readable filename; 120 keeps the 113-character Portuguese headline whole. */
export const MAX_STEM_CHARS = 120;
/** NTFS allows 255 units, ext4 and APFS 255 bytes; 180 leaves room for a suffix. */
export const MAX_STEM_BYTES = 180;
/** How far into the document a title or first line is looked for. */
export const TITLE_SCAN_LINES = 120;
/** How much opening text an AI naming request may see. */
export const AI_EXCERPT_CHARS = 4_000;

/** Where a stem came from. `line` is the one case the assistant may improve. */
export type TitleSource = "metadata" | "heading" | "line" | "fallback";

export interface FileStem {
  stem: string;
  source: TitleSource;
}

export interface FileStemInput {
  text: string;
  language: DocumentLanguage;
  maxChars?: number;
  maxBytes?: number;
}

// eslint-disable-next-line no-control-regex -- Control characters are exactly what a filename must not contain.
const INVALID_FILENAME = /[\u0000-\u001f\u007f\u200b-\u200d\ufeff<>:"/\\|?*]/g;
/** Windows refuses `CON`, `CON.md`, `LPT1` and friends whatever the extension. */
const RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const TEXT_CHARACTER = /[\p{L}\p{N}]/u;

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
};

/** Normalise line endings and drop a byte-order mark. */
function normalize(text: string): string {
  return text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
}

/** Strip one matching pair of quotes, straight or typographic. */
function unquote(value: string): string {
  const trimmed = value.trim();
  const pairs: [string, string][] = [
    ['"', '"'],
    ["'", "'"],
    ["“", "”"],
    ["‘", "’"],
    ["«", "»"],
  ];
  for (const [open, close] of pairs) {
    if (trimmed.length >= 2 && trimmed.startsWith(open) && trimmed.endsWith(close)) {
      return trimmed.slice(open.length, -close.length).trim();
    }
  }
  return trimmed;
}

/** Decode the entities a heading is likely to carry without a parser. */
function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]+);/gi, (match, body: string) => {
    if (body.startsWith("#")) {
      const code =
        body[1] === "x" || body[1] === "X"
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    return ENTITIES[body.toLowerCase()] ?? match;
  });
}

/**
 * Reduce inline markup to the words a reader sees.
 *
 * Deliberately conservative: a filename is reviewed in the dialog, so dropping
 * a stray character is better than leaving `**` or `[link](url)` in the name.
 */
function stripInline(input: string, language: DocumentLanguage): string {
  let text = input;

  if (language === "html") {
    text = text.replace(/<br\s*\/?>/gi, " ").replace(/<[^>]*>/g, " ");
    return decodeEntities(text).replace(/\s+/g, " ").trim();
  }

  // Raw HTML can appear inside Markdown and the other markups; code spans are
  // common to all four.
  text = text.replace(/<[^>]+>/g, " ").replace(/`+([^`]*)`+/g, "$1");

  if (language === "markdown") {
    text = text
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]*)\]\[[^\]]*\]/g, "$1")
      .replace(/\[\^[^\]]*\]/g, "")
      .replace(/~~([^~]+)~~/g, "$1")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/\*([^*]+)\*/g, "$1")
      .replace(/__([^_]+)__/g, "$1")
      .replace(/(^|\s)_([^_]+)_(?=\s|$)/g, "$1$2")
      .replace(/\\([\\`*_{}[\]()#+\-.!>])/g, "$1");
  } else if (language === "asciidoc") {
    text = text
      .replace(/link:([^[]+)\[([^\]]*)\]/g, (_match, url: string, label: string) => label || url)
      .replace(
        /xref:([^[]+)\[([^\]]*)\]/g,
        (_match, target: string, label: string) => label || target,
      )
      .replace(/image:([^[]+)\[([^\]]*)\]/g, (_match, _src: string, alt: string) => alt)
      .replace(/<<[^,>]+,([^>]+)>>/g, "$1")
      .replace(/<<([^>]+)>>/g, "$1")
      .replace(/footnote:\[[^\]]*\]/g, "")
      .replace(/\{([a-z0-9_-]+)\}/gi, "")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/\*([^*]+)\*/g, "$1")
      .replace(/#([^#\s][^#]*)#/g, "$1")
      .replace(/(^|\s)_([^_]+)_(?=\s|$)/g, "$1$2");
  } else if (language === "typst") {
    text = text
      // `#text(size: 20pt)[Title]` contributes its bracket text, which is how a
      // Typst title block is usually written.
      .replace(/#[a-z][\w-]*\([^)]*\)\[([^\]]*)\]/gi, "$1")
      .replace(/#[a-z][\w-]*\[([^\]]*)\]/gi, "$1")
      .replace(/#[a-z][\w-]*\([^)]*\)/gi, " ")
      .replace(/\*([^*]+)\*/g, "$1")
      .replace(/(^|\s)_([^_]+)_(?=\s|$)/g, "$1$2")
      .replace(/\$[^$]*\$/g, " ")
      .replace(/(^|\s)\/\/.*$/g, "");
  } else if (language === "latex") {
    text = text
      // A command's argument is the text a reader sees: `\textbf{Bold}` keeps
      // "Bold". The command name itself is markup and goes.
      .replace(/\\[a-zA-Z@]+\*?(?:\[[^\]]*\])?\{([^{}]*)\}/g, "$1")
      .replace(/\\[a-zA-Z@]+\*?/g, " ")
      .replace(/\\\\/g, " ")
      // Escaped specials are literal characters in the text.
      .replace(/\\([$&%#_{}])/g, "$1")
      .replace(/\$[^$]*\$/g, " ")
      .replace(/[{}~]/g, " ")
      .replace(/(?<!\\)%.*$/g, "");
  }

  return decodeEntities(text).replace(/\s+/g, " ").trim();
}

/** Remove the block marker that precedes the words on a line. */
function stripBlockPrefix(line: string, language: DocumentLanguage): string {
  let text = line;
  if (language === "markdown") {
    text = text
      .replace(/^\s{0,3}>\s?/, "")
      .replace(/^\s{0,3}(?:[-+*]|\d+[.)])\s+/, "")
      .replace(/^\s{0,3}\[[ xX]\]\s+/, "")
      .replace(/^\s{0,3}#{1,6}\s+/, "");
  } else if (language === "asciidoc") {
    text = text.replace(/^\s*(?:\.{1,2}|-|\*+|\d+\.)\s+/, "").replace(/^=+\s+/, "");
  } else if (language === "typst") {
    text = text.replace(/^\s*(?:[-+]|\d+\.)\s+/, "").replace(/^=+\s+/, "");
  } else if (language === "latex") {
    text = text.replace(/^\s*\\item\s*(\[[^\]]*\])?\s*/, "").replace(/^\s*\\[a-zA-Z@]+\*?\s*/, "");
  }
  return text;
}

/** A line that is a delimiter, directive, comment or definition, not prose. */
function isStructuralLine(line: string, language: DocumentLanguage): boolean {
  const trimmed = line.trim();
  if (!trimmed) return true;
  if (language === "markdown") {
    if (/^([-*_])(?:\s*\1){2,}$/.test(trimmed)) return true;
    if (/^<!--/.test(trimmed)) return true;
    if (/^\|/.test(trimmed)) return true;
    if (/^\[[^\]]+\]:\s+\S/.test(trimmed)) return true;
    if (/^\[\^[^\]]+\]:/.test(trimmed)) return true;
    if (/^\[TOC\]$/i.test(trimmed)) return true;
    if (/^\s*!\[[^\]]*\]\([^)]*\)\s*$/.test(trimmed)) return true;
  } else if (language === "asciidoc") {
    if (/^\/\//.test(trimmed)) return true;
    if (/^:[\w-]+:/.test(trimmed)) return true;
    if (/^\[.*\]$/.test(trimmed)) return true;
    if (/^(?:-{4,}|\.{4,}|={4,}|\*{4,}|_{4,}|\+{4,})$/.test(trimmed)) return true;
    if (/^(?:image|include|ifdef|ifndef|toc|footnote)::/.test(trimmed)) return true;
  } else if (language === "typst") {
    if (/^\/\//.test(trimmed)) return true;
    // A set/show/import/let statement is configuration, not prose. Its
    // arguments are not bracketed text, so the inline cleaner would otherwise
    // leave `#set page(paper: "a4")` looking like a sentence.
    if (/^#(?:set|show|import|include|let)\b/.test(trimmed)) return true;
  } else if (language === "latex") {
    // A comment, a preamble command, or a sectioning command that is not a
    // title: none of these is the document's prose.
    if (/^%/.test(trimmed)) return true;
    if (
      /^\\(?:documentclass|usepackage|input|include|includeonly|bibliography|bibliographystyle|addbibresource|newcommand|renewcommand|providecommand|def|let|graphicspath|hypersetup|pagestyle|thispagestyle|setlength|setcounter|label|ref|eqref|cite|nocite|begin|end|maketitle|tableofcontents|appendix|clearpage|newpage|vspace|hspace|noindent|centering|includegraphics|footnote|index)\b/.test(
        trimmed,
      )
    ) {
      return true;
    }
    if (
      /^\\(?:part|chapter|section|subsection|subsubsection|paragraph|subparagraph|title)\b/.test(
        trimmed,
      )
    ) {
      return true;
    }
  }
  return false;
}

interface Heading {
  raw: string;
  level: number;
}

/** YAML front matter: its title, and the line after its closing delimiter. */
function frontMatter(lines: readonly string[]): { title: string | null; end: number } {
  if (lines[0]?.trim() !== "---") return { title: null, end: -1 };
  let end = -1;
  for (let i = 1; i < Math.min(lines.length, 200); i += 1) {
    if (/^(?:---|\.\.\.)\s*$/.test(lines[i])) {
      end = i;
      break;
    }
  }
  if (end < 0) return { title: null, end: -1 };
  for (let i = 1; i < end; i += 1) {
    const match = /^title\s*:\s*(.*)$/i.exec(lines[i]);
    if (!match) continue;
    let value = match[1].trim();
    if (/^[|>][+-]?$/.test(value)) {
      const chunks: string[] = [];
      for (let j = i + 1; j < end; j += 1) {
        if (!lines[j].trim()) {
          if (chunks.length > 0) break;
          continue;
        }
        if (!/^\s+/.test(lines[j])) break;
        chunks.push(lines[j].trim());
      }
      value = chunks.join(" ");
    }
    return { title: unquote(value), end };
  }
  return { title: null, end };
}

/** The document's own title, when the markup has a metadata field for it. */
function metadataTitle(text: string, language: DocumentLanguage): string | null {
  const normalized = normalize(text);
  if (language === "markdown") {
    const found = frontMatter(normalized.split("\n"));
    return found.title && found.title.trim() ? found.title : null;
  }
  if (language === "asciidoc") {
    const lines = normalized.split("\n").slice(0, 40);
    for (const line of lines) {
      const match = /^:title:\s*(.+)$/i.exec(line.trim());
      if (match) return unquote(match[1]);
    }
    return null;
  }
  if (language === "typst") {
    const match = /#set\s+document\s*\([^)]*\btitle\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(normalized);
    return match ? match[1].replace(/\\(["\\])/g, "$1") : null;
  }
  if (language === "latex") {
    // `\title{…}` may carry an optional short form (`\title[Short]{Long}`) and
    // may span lines, so the balanced argument is read rather than regexed.
    const at = /\\title\s*(?:\[[^\]]*\])?\s*\{/.exec(normalized);
    if (!at) return null;
    const raw = balancedArgument(normalized, at.index + at[0].length);
    const cleaned = raw === null ? null : stripInline(raw, "latex");
    return cleaned && cleaned.trim() ? cleaned : null;
  }
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(normalized);
  return match ? stripInline(match[1], "html") : null;
}

/** The text of a brace-balanced argument that starts just after its `{`. */
function balancedArgument(text: string, from: number): string | null {
  let depth = 1;
  for (let index = from; index < text.length; index += 1) {
    const ch = text[index];
    if (ch === "\\") {
      index += 1;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(from, index);
    }
  }
  return null;
}

/** Headings inside the scanned window, in document order. */
function headings(text: string, language: DocumentLanguage): Heading[] {
  if (language === "html") {
    const found: Heading[] = [];
    const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(text);
    if (h1) found.push({ raw: h1[1], level: 1 });
    const h2 = /<h2[^>]*>([\s\S]*?)<\/h2>/i.exec(text);
    if (h2) found.push({ raw: h2[1], level: 2 });
    return found;
  }

  if (language === "latex") return latexHeadings(text);

  const lines = normalize(text).split("\n");
  const front = language === "markdown" ? frontMatter(lines) : { title: null, end: -1 };
  let index = front.end >= 0 ? front.end + 1 : 0;
  let scanned = 0;
  let inFence = false;
  const found: Heading[] = [];

  while (index < lines.length && scanned < TITLE_SCAN_LINES) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }
    scanned += 1;

    if (language === "markdown") {
      if (/^\s{0,3}(?:```|~~~)/.test(line)) {
        inFence = !inFence;
        index += 1;
        continue;
      }
      if (inFence) {
        index += 1;
        continue;
      }
      const atx = /^\s{0,3}(#{1,6})[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/.exec(line);
      if (atx) {
        found.push({ raw: atx[2], level: atx[1].length });
        index += 1;
        continue;
      }
      const next = lines[index + 1];
      const underline = next ? /^\s{0,3}(=+|-+)\s*$/.exec(next) : null;
      if (
        underline &&
        !/^\s{0,3}(?:[>*+-]|\d+[.)])\s/.test(line) &&
        !isStructuralLine(line, language)
      ) {
        found.push({ raw: line.trim(), level: underline[1][0] === "=" ? 1 : 2 });
        index += 2;
        scanned += 1;
        continue;
      }
      index += 1;
      continue;
    }

    const heading = /^(=+)\s+(.+)$/.exec(line);
    if (heading) found.push({ raw: heading[2], level: heading[1].length });
    index += 1;
  }

  return found;
}

/** The first heading, preferring the shallowest level that appears. */
function firstHeading(text: string, language: DocumentLanguage): string | null {
  const found = headings(text, language);
  if (found.length === 0) return null;
  const best = Math.min(...found.map((heading) => heading.level));
  return found.find((heading) => heading.level === best)?.raw ?? null;
}

/**
 * Sectioning commands inside the scanned window, in document order.
 *
 * The same nesting the outline uses, so the name a Save dialog offers and the
 * title the sidebar shows cannot disagree.
 */
function latexHeadings(text: string): Heading[] {
  const levels: Record<string, number> = {
    part: 0,
    chapter: 1,
    section: 1,
    subsection: 2,
    subsubsection: 3,
    paragraph: 4,
    subparagraph: 5,
  };
  const normalized = normalize(text);
  const pattern =
    /\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?\s*(?:\[([^\]]*)\])?\s*\{/g;
  const found: Heading[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(normalized)) !== null) {
    const short = match[2]?.trim();
    const raw = short || balancedArgument(normalized, match.index + match[0].length);
    if (raw === null || !raw.trim()) continue;
    found.push({ raw, level: levels[match[1]] });
    if (found.length >= 6) break;
  }
  return found;
}

/** The first readable sentence, skipping markup that is not prose. */
function firstProseLine(text: string, language: DocumentLanguage): string | null {
  if (language === "html") return firstHtmlLine(text);

  const lines = normalize(text).split("\n");
  const front = language === "markdown" ? frontMatter(lines) : { title: null, end: -1 };
  let index = front.end >= 0 ? front.end + 1 : 0;
  let scanned = 0;
  let inFence = false;

  while (index < lines.length && scanned < TITLE_SCAN_LINES) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed) {
      index += 1;
      continue;
    }
    scanned += 1;

    if (language === "markdown" && /^\s{0,3}(?:```|~~~)/.test(line)) {
      inFence = !inFence;
      index += 1;
      continue;
    }
    if (inFence || isStructuralLine(line, language)) {
      index += 1;
      continue;
    }
    // A heading was already offered as the title; do not reuse it here.
    if (language === "markdown" && /^\s{0,3}#{1,6}\s+/.test(line)) {
      index += 1;
      continue;
    }
    if ((language === "asciidoc" || language === "typst") && /^=+\s+/.test(line)) {
      index += 1;
      continue;
    }
    if (
      language === "latex" &&
      /^\s*\\(?:part|chapter|section|subsection|subsubsection|paragraph|subparagraph|title)\b/.test(
        line,
      )
    ) {
      index += 1;
      continue;
    }

    const cleaned = stripInline(stripBlockPrefix(line, language), language);
    if (!TEXT_CHARACTER.test(cleaned)) {
      index += 1;
      continue;
    }
    if (/^(?:https?:\/\/|www\.)\S+$/i.test(cleaned)) {
      index += 1;
      continue;
    }
    return cleaned;
  }

  return null;
}

/** Visible text of an HTML document's first prose block. */
function firstHtmlLine(text: string): string | null {
  const body = text
    .replace(/<head[\s\S]*?<\/head>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  const plain = body
    .replace(
      /<(?:br|\/p|\/div|\/h[1-6]|\/li|\/tr|\/section|\/article|\/header|\/footer)\b[^>]*>/gi,
      "\n",
    )
    .replace(/<[^>]*>/g, " ");
  for (const line of decodeEntities(plain).split("\n")) {
    const cleaned = line.replace(/\s+/g, " ").trim();
    if (!cleaned || !TEXT_CHARACTER.test(cleaned)) continue;
    if (/^(?:https?:\/\/|www\.)\S+$/i.test(cleaned)) continue;
    return cleaned;
  }
  return null;
}

/** UTF-8 length of one code point, without allocating a Buffer. */
function utf8Size(point: string): number {
  const code = point.codePointAt(0) ?? 0;
  if (code < 0x80) return 1;
  if (code < 0x800) return 2;
  if (code < 0x10000) return 3;
  return 4;
}

/** Cut a stem at a word boundary, respecting both limits. */
function truncateStem(text: string, maxChars: number, maxBytes: number): string {
  if (maxChars < 1 || maxBytes < 1) return UNTITLED_STEM;
  const points = Array.from(text);
  let out = "";
  let bytes = 0;
  let used = 0;
  for (const point of points) {
    const size = utf8Size(point);
    if (used + 1 > maxChars || bytes + size > maxBytes) break;
    out += point;
    used += 1;
    bytes += size;
  }
  if (used < points.length) {
    const space = out.lastIndexOf(" ");
    if (space >= Math.min(24, Math.floor(out.length / 2))) out = out.slice(0, space);
  }
  out = out.replace(/[\s.,;:!?…-]+$/u, "").trim();
  if (!TEXT_CHARACTER.test(out)) return UNTITLED_STEM;
  if (RESERVED_NAME.test(out)) return UNTITLED_STEM;
  return out;
}

/**
 * Make any text safe as a filename stem.
 *
 * Used for the deterministic name and for the assistant's answer, so a bad
 * prompt or a model that adds a sentence cannot produce a name the platform
 * refuses. The extension is added by [`withExtension`], never here.
 */
export function sanitizeFileStem(
  input: string,
  maxChars: number = MAX_STEM_CHARS,
  maxBytes: number = MAX_STEM_BYTES,
): string {
  let text = input.replace(INVALID_FILENAME, " ").replace(/\s+/g, " ").trim();
  text = unquote(text);
  text = text.replace(/[\s.\u2026]+$/u, "");
  text = text.replace(/[.,;:!?…]+$/u, "").trim();
  if (!TEXT_CHARACTER.test(text)) return UNTITLED_STEM;
  if (RESERVED_NAME.test(text)) return UNTITLED_STEM;
  return truncateStem(text, maxChars, maxBytes);
}

/** Add the extension, without a second dot when one was typed in the field. */
export function withExtension(stem: string, extension: string): string {
  const clean = extension.trim().replace(/^\./, "");
  return clean ? `${stem}.${clean}` : stem;
}

const KNOWN_EXTENSIONS = [
  "markdown",
  "asciidoc",
  "mdown",
  "mkd",
  "adoc",
  "html",
  "htm",
  "typ",
  "txt",
  "md",
];

/**
 * Clean what the model returned into a stem, or null when nothing usable is
 * left. A null answer means the deterministic name should be used instead.
 */
export function cleanAiSuggestion(raw: string, extension: string): string | null {
  const text = normalize(raw)
    .replace(/^\s*```[\w-]*\s*$/gm, "")
    .replace(/```/g, "")
    .trim();
  if (!text) return null;

  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return null;
  // A model that ignored the one-line instruction often starts with a label
  // line ("File name:") and puts the answer below it.
  let line = lines[0];
  if (lines.length > 1 && /[:：]$/.test(line)) line = lines[1];

  line = line
    .replace(/^<[^>]{1,40}>/, "")
    .replace(/<\/[^>]{1,40}>$/, "")
    .replace(
      /^(?:file\s*name|filename|file|title|título|titre|name|nome|nombre|dateiname)\s*[:\-–—]\s*/i,
      "",
    )
    .trim();
  line = unquote(line)
    .replace(/^[*_~`]+/, "")
    .replace(/[*_~`]+$/, "")
    .trim();

  const wanted = new Set(
    [extension.trim().replace(/^\./, "").toLowerCase(), ...KNOWN_EXTENSIONS].filter(Boolean),
  );
  for (const candidate of wanted) {
    const suffix = `.${candidate}`;
    if (line.toLowerCase().endsWith(suffix)) {
      line = line.slice(0, -suffix.length);
      break;
    }
  }

  const stem = sanitizeFileStem(line);
  return stem === UNTITLED_STEM ? null : stem;
}

/** The opening sent to an AI naming request, cut at a natural boundary. */
export function plainExcerpt(text: string, maxChars: number = AI_EXCERPT_CHARS): string {
  const normalized = normalize(text).trim();
  if (!normalized) return "";
  const points = Array.from(normalized);
  if (points.length <= maxChars) return normalized;
  const slice = points.slice(0, maxChars).join("");
  const paragraph = slice.lastIndexOf("\n\n");
  const newline = slice.lastIndexOf("\n");
  const space = slice.lastIndexOf(" ");
  const cut = Math.max(paragraph, newline, space);
  return (cut >= maxChars * 0.6 ? slice.slice(0, cut) : slice).trimEnd();
}

/**
 * The best name the text itself offers.
 *
 * A candidate that sanitises to `untitled` (a rule, a line of punctuation, a
 * reserved device name) falls through to the next source instead of ending the
 * search.
 */
export function suggestFileStem(input: FileStemInput): FileStem {
  const text = normalize(input.text);
  const limits = {
    maxChars: input.maxChars ?? MAX_STEM_CHARS,
    maxBytes: input.maxBytes ?? MAX_STEM_BYTES,
  };
  if (!text.trim()) return { stem: UNTITLED_STEM, source: "fallback" };

  const sources: [TitleSource, string | null][] = [
    ["metadata", metadataTitle(text, input.language)],
    ["heading", firstHeading(text, input.language)],
    ["line", firstProseLine(text, input.language)],
  ];
  for (const [source, raw] of sources) {
    if (!raw) continue;
    const stem = sanitizeFileStem(
      stripInline(raw, input.language),
      limits.maxChars,
      limits.maxBytes,
    );
    if (stem !== UNTITLED_STEM) return { stem, source };
  }
  return { stem: UNTITLED_STEM, source: "fallback" };
}
