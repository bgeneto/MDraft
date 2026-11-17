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
import { hasInlineMath } from "../math-delimiters.ts";

export type SourceFormat = "html" | "markdown" | "typst" | "asciidoc" | "latex" | "plain";

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
  language: Exclude<DocumentLanguage, "javascript" | "css" | "json">;
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
  if (text.includes("$") && hasInlineMath(text, true)) score += 1;
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
  if (/^ {0,3}image::?[^\s[]*\[/m.test(text)) score += 4;
  if (/^ {0,3}:[A-Za-z0-9_-]+:\s*\S/m.test(text)) score += 4;
  if (/^ {0,3}(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION):\s+/m.test(text)) score += 4;
  if (/^\s*\|===\s*$/m.test(text)) score += 5;
  if (/\b(?:latexmath|stem):\[/.test(text)) score += 4;
  if (/^ {0,3}include::/m.test(text)) score += 4;
  if (/\bxref:/.test(text)) score += 2;
  if (/^ {0,3}\/\/.*$/m.test(text)) score += 1;
  return score;
}

/**
 * The LaTeX score.
 *
 * Every signal is anchored to the start of a line, because that is what
 * separates a LaTeX *document* from prose that mentions LaTeX. A Markdown
 * article saying "we used \LaTeX{} for this" has no line beginning with
 * `\documentclass` or `\begin{document}`, so it scores 0 here and its Markdown
 * score keeps it.
 *
 * `\begin{document}` is worth the most: it is the one command a LaTeX document
 * cannot be written without, and it does not appear in a bare fragment. The
 * preamble commands are next — a clipboard holding only a preamble is still
 * LaTeX source. A `%` comment line is worth 1, the same as Typst's and
 * AsciiDoc's comment signal, so it can never decide alone.
 */
export function scoreLatex(raw: string): number {
  const text = raw;
  let score = 0;
  if (/^ {0,3}\\begin\s*\{document\}/m.test(text)) score += 6;
  if (/^ {0,3}\\documentclass\b/m.test(text)) score += 5;
  if (/^ {0,3}\\end\s*\{document\}/m.test(text)) score += 2;
  if (count(text, /^ {0,3}\\(?:usepackage|RequirePackage)\s*(?:\[[^\]]*\])?\s*\{/gm) > 0)
    score += 4;
  if (
    count(
      text,
      /^ {0,3}\\(?:part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?\s*(?:\[[^\]]*\])?\s*\{/gm,
    ) > 0
  ) {
    score += 4;
  }
  if (
    count(text, /^ {0,3}\\(?:newcommand|renewcommand|providecommand|def|DeclareMathOperator)\b/gm) >
    0
  ) {
    score += 4;
  }
  if (count(text, /^ {0,3}\\begin\s*\{(?!document\})[A-Za-z*]+\}/gm) > 0) score += 3;
  if (/^ {0,3}\\(?:title|author|date)\s*\{/m.test(text)) score += 2;
  if (/\\includegraphics\b/.test(text)) score += 2;
  if (count(text, /^ {0,3}%.*$/gm) > 0) score += 1;
  return score;
}

const BLOCK_TAG =
  /^<(?:!doctype\s+html|html|body|main|article|section|header|footer|div|p|h[1-6]|ul|ol|li|table|blockquote|pre|figure|details)\b/i;

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
  let endsWithOpenTag: boolean | undefined;
  let index = 0;
  TAG_TOKEN.lastIndex = 0;
  for (let match = TAG_TOKEN.exec(text); match !== null; match = TAG_TOKEN.exec(text)) {
    const gap = text.slice(index, match.index);
    if (gap.trim() !== "") {
      if (depth === 0) return false;
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
  return elements > 0 && (depth === 0 || endsWithOpenTag === true);
}

type RankedSyntax = Array<[Detection["language"], number]>;

/** Every markup score, highest first; ties keep the order below. */
function rankTextSyntax(raw: string, mode: "clipboard" | "document"): RankedSyntax {
  const scores: RankedSyntax = [
    ["html", scoreHtml(raw, mode)],
    ["markdown", scoreMarkdown(raw)],
    ["typst", scoreTypst(raw)],
    ["asciidoc", scoreAsciidoc(raw)],
    ["latex", scoreLatex(raw)],
  ];
  return scores.sort((a, b) => b[1] - a[1]);
}

/** The confident syntax of a text, or null when the evidence is too thin. */
export function detectTextSyntax(
  raw: string,
  mode: "clipboard" | "document" = "clipboard",
): Detection | null {
  if (raw.trim() === "") return null;
  return pickTextSyntax(rankTextSyntax(raw, mode));
}

function pickTextSyntax(scores: RankedSyntax): Detection | null {
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

/** A document classification, including the web-source languages. */
export interface DocumentDetection {
  language: DocumentLanguage;
  score: number;
  runnerUp: number;
}

const JSON_OBJECT_START = /^(?:\[\s*)?\{\s*"(?:[^"\\\n]|\\.)*"\s*:/;

/**
 * The buffer is a JSON document.
 *
 * A complete document is decided by the parser, which no heuristic can beat.
 * Only an object or an array counts: `42` and `"text"` are valid JSON and also
 * ordinary prose. While the reader is still typing — or past the detection
 * sample, where the text is cut mid-value — the parse fails, so an object that
 * opens with a quoted key (`{ "name":`) is enough. A Markdown reference
 * (`[1]: https://…`) or task list (`[ ] item`) has neither.
 */
export function isJsonDocument(raw: string): boolean {
  // `trim` removes a byte-order mark too: U+FEFF is JavaScript whitespace.
  const text = raw.trim();
  if (!/^[[{]/.test(text)) return false;
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value === "object" && value !== null) return true;
  } catch {
    // Incomplete, cut by the sample, or JSON with comments: the prefix decides.
  }
  return JSON_OBJECT_START.test(text);
}

/**
 * Remove `/* … *\/` comments in one pass.
 *
 * A lazy regular expression rescans to the end of the text for every opener
 * without a closer, and prose such as `src/*.md` has many of those.
 */
function stripBlockComments(text: string): string {
  let out = "";
  let index = 0;
  for (;;) {
    const open = text.indexOf("/*", index);
    if (open === -1) break;
    const close = text.indexOf("*/", open + 2);
    if (close === -1) break;
    out += `${text.slice(index, open)} `;
    index = close + 2;
  }
  return out + text.slice(index);
}

/**
 * The text a stylesheet or script scorer may read, or null for markup.
 *
 * `stripNoise` removes Markdown fences and AsciiDoc listings, so an article
 * *about* CSS keeps its prose and loses its code samples. Block comments go
 * too: JSDoc and licence headers are prose. A text that starts with a tag is
 * HTML, and its inline `<style>` and `<script>` must not outvote it.
 */
function webSourceText(raw: string): string | null {
  const text = stripBlockComments(stripNoise(raw));
  return /^\s*</.test(text) ? null : text;
}

/** A selector and a `{…}` body without nested braces; minified rules follow `}` or `;`. */
const CSS_RULE = /(?:^|(?<=[{};]))([^{}\n;]+)\{([^{}]*)\}/gm;
const CSS_DECLARATION = /^(?:--[\w-]+|-?[a-z][a-z-]*)\s*:\s*[^\s:]/;
const CSS_AT_RULE =
  /^[ \t]*@(?:media|import|font-face|keyframes|-webkit-keyframes|supports|layer|charset|namespace|page|container|property|counter-style|font-feature-values|tailwind)\b/m;
const SCRIPT_KEYWORD =
  /^(?:if|for|while|switch|else|do|try|catch|finally|function|class|return|const|let|var|export|import|async|await|new|typeof|case|default)\b/;

/**
 * The selector of a CSS rule, as opposed to a block that only looks like one.
 *
 * Pseudo-class arguments (`:not(.a)`, `:nth-child(2n)`) and attribute
 * selectors (`[type="text"]`) are the only places a selector holds parentheses,
 * quotes or `=`. Whatever is left after removing them is a call, an assignment,
 * an arrow or a TeX command — `if (x) {`, `#let f(x) = {`, `\section{`.
 */
function isCssSelector(selector: string): boolean {
  const text = selector.trim();
  if (text === "" || SCRIPT_KEYWORD.test(text) || /^#\s/.test(text)) return false;
  const bare = text.replace(/::?[\w-]+\([^()]*\)/g, "").replace(/\[[^\]]*\]/g, "");
  return !/[()=$?!"'`\\%@]/.test(bare);
}

function cssDeclarations(body: string): number {
  let found = 0;
  for (const part of body.split(";")) if (CSS_DECLARATION.test(part.trim())) found += 1;
  return found;
}

function cssScoreOf(text: string): number {
  let rules = 0;
  let declarations = 0;
  CSS_RULE.lastIndex = 0;
  for (let match = CSS_RULE.exec(text); match !== null; match = CSS_RULE.exec(text)) {
    if (!isCssSelector(match[1])) continue;
    const found = cssDeclarations(match[2]);
    if (found === 0) continue;
    rules += 1;
    declarations += found;
    if (rules >= 20) break;
  }
  // A stylesheet is made of rules. An at-rule or a `key: value;` line alone is
  // as likely to be a YAML list or a sentence.
  if (rules === 0) return 0;
  let score = 4;
  if (rules >= 3) score += 2;
  if (declarations >= 2) score += 2;
  if (CSS_AT_RULE.test(text)) score += 3;
  if (/^[ \t]*:root\b/m.test(text) || /(?:^|[\s{;])--[\w-]+\s*:/.test(text)) score += 2;
  return score;
}

/**
 * The CSS score: rules whose body holds `property: value` declarations, plus
 * the at-rules and custom properties no other format writes.
 */
export function scoreCss(raw: string): number {
  const text = webSourceText(raw);
  return text === null ? 0 : cssScoreOf(text);
}

const JS_MODULE =
  /^[ \t]*(?:import\s+(?:[\w$*{][^;\n]*?\s+from\s+)?["'][^"'\n]+["']|export\s+(?:default\b|const\b|let\b|var\b|function\b|class\b|async\b|\{|\*))/m;
const JS_COMMONJS =
  /\brequire\s*\(\s*["'][^"'\n]+["']\s*\)|\bmodule\.exports\b|^[ \t]*exports\.[\w$]+\s*=/m;
const JS_FUNCTION =
  /^[ \t]*(?:export\s+(?:default\s+)?)?(?:async\s+)?function\b\s*\*?\s*[\w$]*\s*\(/m;
const JS_BINDING =
  /^[ \t]*(?:export\s+)?(?:const|let|var)\s+(?:[\w$]+|\{[^}\n]*\}|\[[^\]\n]*\])\s*=(?!=)/gm;
const JS_CLASS =
  /^[ \t]*(?:export\s+(?:default\s+)?)?class\s+[\w$]+(?:\s+extends\s+[\w$.]+)?\s*\{/m;
const JS_ARROW = /(?:\)|\b[\w$]+)\s*=>\s*[{(\w$"'`[!-]/;
const JS_GLOBALS =
  /\b(?:console\.(?:log|error|warn|info|debug)|document\.(?:getElementById|querySelector(?:All)?|createElement)|JSON\.(?:parse|stringify)|[\w$]\.addEventListener)\s*\(/;

/**
 * The JavaScript score.
 *
 * Statements are anchored to the start of a line, which is what separates a
 * script from prose that mentions one: `const` and `let` are English words,
 * and Typst's `#let` starts with `#`. A Typst arrow (`it => {`) is worth 2 here
 * and cannot decide alone.
 */
function javascriptScoreOf(text: string, raw: string): number {
  let score = 0;
  if (JS_MODULE.test(text)) score += 5;
  if (JS_COMMONJS.test(text)) score += 3;
  if (JS_FUNCTION.test(text)) score += 4;
  const bindings = count(text, JS_BINDING);
  if (bindings > 0) score += 3;
  if (bindings >= 2) score += 1;
  if (bindings >= 4) score += 1;
  if (JS_CLASS.test(text)) score += 3;
  if (JS_ARROW.test(text)) score += 2;
  if (/^\s*(["'])use strict\1;?\s*$/m.test(text) || /^#!.*\bnode\b/.test(raw)) score += 4;
  if (JS_GLOBALS.test(text)) score += 2;
  if (count(text, /;[ \t]*$/gm) >= 3) score += 1;
  return score;
}

export function scoreJavascript(raw: string): number {
  const text = webSourceText(raw);
  return text === null ? 0 : javascriptScoreOf(text, raw);
}

/** A decided JSON document scores this: it is a parse, not a vote. */
const JSON_SCORE = 10;

/** The least a stylesheet or a script must score to name a buffer. */
const MIN_WEB_SCORE = 6;

/**
 * The confident language of a whole buffer, web sources included.
 *
 * This is the classifier behind Save As and the status-bar type of an untitled
 * buffer. JSON is decided first, by the parser. A stylesheet or a script then
 * has to clear `MIN_WEB_SCORE` and lead every other score, markup included, by
 * the same two points the markup classifier demands; otherwise the answer is
 * exactly `detectTextSyntax(raw, "document")`, so a markup document is never
 * reclassified by the new scorers. The clipboard and paste paths keep calling
 * `detectTextSyntax`: a paste into a buffer that merely looks like JSON must
 * not change how the clipboard is converted.
 */
export function detectDocumentSyntax(raw: string): DocumentDetection | null {
  if (raw.trim() === "") return null;
  if (isJsonDocument(raw)) return { language: "json", score: JSON_SCORE, runnerUp: 0 };
  const markup = rankTextSyntax(raw, "document");
  const text = webSourceText(raw);
  if (text !== null) {
    const web: Array<["css" | "javascript", number]> = [
      ["css", cssScoreOf(text)],
      ["javascript", javascriptScoreOf(text, raw)],
    ];
    web.sort((a, b) => b[1] - a[1]);
    const [language, score] = web[0];
    const runnerUp = Math.max(web[1][1], markup[0][1]);
    if (score >= MIN_WEB_SCORE && score - runnerUp >= 2) return { language, score, runnerUp };
  }
  return pickTextSyntax(markup);
}

/**
 * The text carries Markdown's own syntax. Looser than `detectTextSyntax` on
 * purpose (see `chooseSource`); a fence is included because `stripNoise`
 * removes the one signal that cannot also be prose.
 */
function carriesMarkdown(text: string): boolean {
  return scoreMarkdown(text) > 0 || /^ {0,3}(?:`{3,}|~{3,})/m.test(text);
}

/** Source editors may add an HTML flavour without changing the copied text. */
function isLatexClipboardSource(text: string, html: string | null): boolean {
  if (/\\(?:[A-Za-z@]+|[^\r\n])/.test(text)) return true;
  if (/\${1,2}[^$\r\n]+\${1,2}/.test(text)) return true;
  if (!html) return false;
  // A token-only selection from a syntax highlighter may lack a `pre` wrapper
  // and any command name. Keep its TeX punctuation when the HTML has no actual
  // rich structure to convert.
  if (/<(?:a|b|strong|em|i|u|s|del|h[1-6]|ul|ol|li|blockquote|table|tr|td|th)\b/i.test(html))
    return false;
  if (/[#$%&_^{}~]/.test(text)) return true;
  return (
    /^\s*(?:<meta\b[^>]*>\s*)*<(?:pre|code)\b/i.test(html) ||
    /\bwhite-space\s*:\s*pre(?:-wrap)?\b/i.test(html)
  );
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
 * In LaTeX, text-only pastes and recognizable source with an HTML highlighting
 * flavour stay native, even when a fragment resembles another markup language.
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
  // In a LaTeX editor a text-only clipboard is source: even a fragment without
  // commands can be math or a partial edit. HTML from a source editor is just
  // highlighting, so recognizable LaTeX and preformatted source stay native too.
  if (
    destination === "latex" &&
    payload.text !== null &&
    ((!payload.html?.trim() && !payload.markdown?.trim()) ||
      isLatexClipboardSource(text, payload.html))
  ) {
    return { source: "latex", native: true, fromText: true };
  }
  const typed = detectTextSyntax(text, "clipboard");
  // The conservative document scorer is not a reliable LaTeX fragment reader.
  // Other destinations retain their existing source-detection behavior.
  const detected: Exclude<Detection["language"], "latex"> | null = isHtmlSource(text)
    ? "html"
    : ((typed?.language === "latex" ? null : typed?.language) ??
      (carriesMarkdown(text) ? "markdown" : null));

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
