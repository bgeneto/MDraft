//! Which markup is on the clipboard, and which markup the active buffer is.
//!
//! Two classifiers share one signal table but answer different questions:
//!
//! - `chooseSource()` decides which representation of a paste to use for the
//!   destination that was already resolved;
//! - `detectDocumentLanguage()` decides the destination for an *unsaved* buffer.
//!
//! Both are synchronous and dependency-free. They deliberately require a
//! two-point lead, so a shared construct — a bullet list, inline code, `$…$` —
//! can never decide on its own.

import type { DocumentLanguage } from "../api.ts";
import { VOID_ELEMENTS } from "../tag-name.ts";

export type SourceFormat = "html" | "markdown" | "typst" | "asciidoc" | "plain";

export interface ClipboardPayload {
  html: string | null;
  markdown: string | null;
  text: string | null;
}

export interface ClipboardChoice {
  source: SourceFormat;
  /** True when CodeMirror's own paste is already right: the text, untouched. */
  native: boolean;
  /**
   * True when the source format was read from the text flavour, so the text is
   * the content to convert. False when an HTML or Markdown representation is
   * the content (a copy from a rendered surface, or a format-specific flavour).
   */
  fromText: boolean;
}

export interface Detection {
  language: DocumentLanguage;
  score: number;
  runnerUp: number;
}

/** Remove code and comments, which must not classify prose. */
export function stripNoise(input: string): string {
  return input
    .replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^ {0,3}\1\s*$/gm, " ")
    .replace(
      /^ {0,3}(-{4,}|\.{4,}|\+{4,}|\/{4,}|={4,}|\*{4,}|_{4,}|\|={3,})[^\n]*\n[\s\S]*?^ {0,3}\1\s*$/gm,
      " ",
    )
    .replace(/^ {0,3}\/\/.*$/gm, " ")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
}

function count(text: string, pattern: RegExp): number {
  let n = 0;
  pattern.lastIndex = 0;
  while (pattern.exec(text) !== null) {
    n += 1;
    if (n > 20) break;
  }
  return n;
}

export function scoreMarkdown(raw: string): number {
  const text = stripNoise(raw);
  let score = 0;
  const headings = count(text, /^ {0,3}#{1,6}\s+\S/gm);
  if (headings > 0) score += 4 + Math.min(headings - 1, 1);
  if (/\*\*[^*\n]+\*\*/.test(text)) score += 4;
  if (/!\[[^\]\n]*\]\([^)\n]+\)/.test(text)) score += 4;
  if (/\[[^\]\n]+\]\([^)\s]+(?:\s+"[^"]*")?\)/.test(text)) score += 4;
  if (/^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/m.test(text)) score += 4;
  if (/^\s*[-*+]\s+\[[ xX]\]\s+/m.test(text)) score += 4;
  if (/^---\r?\n(?:[A-Za-z][\w-]*:\s*.*\r?\n)+---\s*$/m.test(text)) score += 5;
  if (/^ {0,3}>\s+\S/m.test(text)) score += 2;
  if (count(text, /^ {0,3}(?:[-*+]|\d+[.)])\s+\S/gm) >= 2) score += 1;
  if (count(text, /^ {0,3}(`{3,}|~{3,})/gm) > 0) score += 1;
  return score;
}

const TYPST_COMMANDS =
  /^ {0,3}#(?:let|set|show|import|include|figure|table|link|image|text|strong|emph|raw|heading|quote|align|grid|stack|box|place|line|rect|circle|ellipse|polygon|path|outline|bibliography|citation|footnote|ref|label)\b/gm;

export function scoreTypst(raw: string): number {
  const text = stripNoise(raw);
  let score = 0;
  if (/^ {0,3}={1,6}\s+\S/m.test(text)) score += 4;
  if (count(text, TYPST_COMMANDS) > 0) score += 5;
  if (/#(?:table|figure)\s*\(/.test(text)) score += 5;
  if (count(text, /^\s*\+\s+\S/gm) >= 2) score += 3;
  if (/@[A-Za-z][\w:-]*/.test(text)) score += 1;
  if (/<[a-z][\w:-]*>/.test(text)) score += 1;
  if (/^\s*\/\/.*$/m.test(text)) score += 1;
  if (/\$[^$\n]+\$/.test(text)) score += 1;
  if (count(text, /^ {0,3}[-*+]\s+\S/gm) >= 2) score += 1;
  return score;
}

/**
 * The AsciiDoc score.
 *
 * `= ` is deliberately worth the same 4 here as in `scoreTypst`: both mark a
 * title, so the shared signal cancels in the lead instead of deciding. The
 * signals below are the ones Typst does not have.
 */
export function scoreAsciidoc(raw: string): number {
  const text = stripNoise(raw);
  let score = 0;
  if (/^ {0,3}={1,6}\s+\S/m.test(text)) score += 4;
  if (/^ {0,3}image::?[^\s\[]*\[/m.test(text)) score += 4;
  if (/^ {0,3}:[A-Za-z0-9_-]+:\s*\S/m.test(text)) score += 4;
  if (/^ {0,3}(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION):\s+/m.test(text)) score += 4;
  if (/^\s*\|===\s*$/m.test(text)) score += 5;
  if (/\b(?:latexmath|stem):\[/.test(text)) score += 4;
  if (/^ {0,3}include::/m.test(text)) score += 4;
  if (/\bxref:/.test(text)) score += 2;
  if (/^ {0,3}\/\/.*$/m.test(text)) score += 1;
  return score;
}

const BLOCK_TAG =
  /^<(?:\!doctype\s+html|html|body|main|article|section|header|footer|div|p|h[1-6]|ul|ol|li|table|blockquote|pre|figure|details)\b/i;

/** HTML is conservative for a clipboard fragment and looser for a whole buffer. */
export function scoreHtml(raw: string, mode: "clipboard" | "document"): number {
  const text = raw.trimStart();
  if (/^<!doctype\s+html\b/i.test(text) || /^<html\b/i.test(text) || /^<body\b/i.test(text)) {
    return 6;
  }
  if (!BLOCK_TAG.test(text)) return 0;
  const first = /^<([a-z][\w-]*)\b/i.exec(text)?.[1]?.toLowerCase();
  if (mode === "clipboard") {
    // A plain-text clipboard is only trusted as HTML when it is a whole document:
    // a code snippet starting with <div> must not be eaten by the parser.
    return 0;
  }
  if (first && new RegExp(`</${first}\\s*>`, "i").test(text)) return 4;
  if (count(text, /<[a-z][\w-]*\b[^>]*>/gi) >= 2) return 4;
  return 0;
}

/**
 * Every tag-shaped token in a text: a comment, a declaration, or an element.
 * Quoted attribute values may contain `>`; the name and the attribute run are
 * the same shapes `src/tag-name.ts` recognises, so `<3`, `a < b` and `\<p\>`
 * are not tags.
 */
const TAG_TOKEN =
  /<!--[\s\S]*?-->|<![^<>]*>|<\?[^<>]*\?>|<\/?[A-Za-z][A-Za-z0-9:-]*(?:\s(?:"[^"]*"|'[^']*'|[^<>"'])*)?\/?>/g;

/**
 * The clipboard's plain text is HTML *source*, not prose that mentions a tag.
 *
 * `Use the <div> tag` is a sentence; `<link …>`, `<p>Hello</p>` and
 * `<div>\n<p>Hi</p>\n</div>` are markup. Prose may only appear inside an
 * element, so everything at the top level must be a tag or whitespace, and a
 * fragment that ends with an opening tag (`<div>`) is markup too — that is a
 * thing you paste into a document, while `<div> is how you group` is a
 * sentence. `scoreHtml` cannot make this call: it refuses to trust an HTML
 * fragment on a clipboard, precisely so that a code snippet is not eaten by
 * the parser.
 */
export function isHtmlSource(text: string): boolean {
  let depth = 0;
  let elements = 0;
  let endsWithOpenTag = false;
  let index = 0;
  TAG_TOKEN.lastIndex = 0;
  for (let match = TAG_TOKEN.exec(text); match !== null; match = TAG_TOKEN.exec(text)) {
    const gap = text.slice(index, match.index);
    if (gap.trim() !== "") {
      if (depth === 0) return false;
      endsWithOpenTag = false;
    }
    index = match.index + match[0].length;
    const token = match[0];
    // `<!-- … -->`, `<!doctype …>` and `<? … ?>` are declarations, not elements.
    if (token.startsWith("<!--") || /^<[!?]/.test(token)) {
      endsWithOpenTag = false;
      continue;
    }
    elements += 1;
    if (token.startsWith("</")) {
      if (depth > 0) depth -= 1;
      endsWithOpenTag = false;
      continue;
    }
    const name = /^<([A-Za-z][A-Za-z0-9:-]*)/.exec(token)?.[1]?.toLowerCase() ?? "";
    const empty = VOID_ELEMENTS.has(name) || /\/>$/.test(token);
    if (!empty) depth += 1;
    endsWithOpenTag = !empty;
  }
  const tail = text.slice(index);
  if (tail.trim() !== "") {
    if (depth === 0) return false;
    endsWithOpenTag = false;
  }
  return elements > 0 && (depth === 0 || endsWithOpenTag);
}

/** The confident syntax of a text, or null when the evidence is too thin. */
export function detectTextSyntax(
  raw: string,
  mode: "clipboard" | "document" = "clipboard",
): Detection | null {
  if (raw.trim() === "") return null;
  const html = scoreHtml(raw, mode);
  const markdown = scoreMarkdown(raw);
  const typst = scoreTypst(raw);
  const asciidoc = scoreAsciidoc(raw);
  const scores: Array<[DocumentLanguage, number]> = [
    ["html", html],
    ["markdown", markdown],
    ["typst", typst],
    ["asciidoc", asciidoc],
  ];
  scores.sort((a, b) => b[1] - a[1]);
  const [language, score] = scores[0];
  const runnerUp = scores[1][1];
  // Typst and AsciiDoc both use `= ` for a title. When that shared signal is
  // the only evidence, keep the pre-AsciiDoc answer: Typst. AsciiDoc has to
  // lead from a signal Typst does not share.
  const tied = score === runnerUp;
  if (
    tied &&
    ((language === "typst" && scores[1][0] === "asciidoc") ||
      (language === "asciidoc" && scores[1][0] === "typst"))
  ) {
    return { language: "typst", score, runnerUp };
  }
  if (score < 4 || score - runnerUp < 2) return null;
  return { language, score, runnerUp };
}

/**
 * The text carries Markdown's own syntax. Looser than `detectTextSyntax` on
 * purpose (see `chooseSource`); a fence is included because `stripNoise`
 * removes the one signal that cannot also be prose.
 */
function carriesMarkdown(text: string): boolean {
  return scoreMarkdown(text) > 0 || /^ {0,3}(?:`{3,}|~{3,})/m.test(text);
}

/**
 * Which clipboard representation to use for `destination`.
 *
 * The **text** flavour is the content. When it is markup we recognise — HTML
 * source, a confident Typst or AsciiDoc document, or text carrying Markdown's
 * own syntax — that is the *source format*. If it is the destination's format
 * the text is pasted byte-for-byte; otherwise it is converted into the
 * destination. The HTML representation is not used in that case: for a copy
 * made from source it is only the same characters decorated (an editor's
 * syntax highlighting, a page's `<code>` block), and converting it loses the
 * spaces between token spans.
 *
 * Only when the text is not markup is the **HTML representation** the content:
 * that is a copy from a rendered page, a word processor or a preview, and it is
 * converted (or sanitised, when the destination is HTML). Then the Markdown
 * representation, and finally plain text natively.
 *
 * The destination decides the intent, and it has to: the same clipboard — an
 * `<p>…</p>` snippet — means "keep this markup" in an HTML document and
 * "convert this into my format" in a Markdown one. Keying the rule on the
 * clipboard alone is what made an earlier version paste literal HTML into
 * Markdown.
 */
export function chooseSource(
  payload: ClipboardPayload,
  destination: DocumentLanguage,
): ClipboardChoice {
  const text = payload.text ?? "";
  const typed = detectTextSyntax(text, "clipboard");
  const detected: DocumentLanguage | null = isHtmlSource(text)
    ? "html"
    : (typed?.language ?? (carriesMarkdown(text) ? "markdown" : null));

  if (detected) {
    return { source: detected, native: detected === destination, fromText: true };
  }

  if (payload.html && payload.html.trim() !== "") {
    return { source: "html", native: false, fromText: false };
  }
  if (payload.markdown && payload.markdown.trim() !== "") {
    return {
      source: "markdown",
      native: destination === "markdown" && payload.text !== null,
      fromText: false,
    };
  }
  return { source: "plain", native: true, fromText: false };
}
