//! Inline syntax beyond GFM: `==highlight==`, `H~2~O` and `x^2^`.
//!
//! The rules follow Pandoc and Typora: subscript and superscript hold no
//! unescaped whitespace, so `~a b~` and `2^10` stay literal, and `~~x~~` keeps
//! its GFM strikethrough. Each syntax is a preference; with subscript off, a
//! single `~x~` is GFM strikethrough again.
import type { MarkedExtension, Tokens, TokenizerAndRendererExtension } from "marked";

export interface InlineSyntaxOptions {
  highlight?: boolean;
  subscript?: boolean;
  superscript?: boolean;
}

// No whitespace or `=` right inside the delimiters, so `a === b` and `== x ==`
// stay text.
const MARK = /^==(?![\s=])((?:\\[\s\S]|[^\\])*?[^\s\\=])==(?!=)/;
const SUB = /^~(?!~)((?:\\[\s\S]|[^\s~\\])+)~(?!~)/;
// Brackets are excluded so an undefined footnote pair `[^a][^b]` stays text.
const SUP = /^\^((?:\\[\s\S]|[^\s^\\[\]])+)\^/;

function delimited(
  name: string,
  tag: string,
  opener: string,
  pattern: RegExp,
): TokenizerAndRendererExtension {
  return {
    name,
    level: "inline",
    start(src) {
      const at = src.indexOf(opener);
      return at < 0 ? undefined : at;
    },
    tokenizer(src) {
      const match = pattern.exec(src);
      if (!match) return undefined;
      return {
        type: name,
        raw: match[0],
        text: match[1],
        tokens: this.lexer.inlineTokens(match[1]),
      };
    },
    renderer(token) {
      return `<${tag}>${this.parser.parseInline((token as Tokens.Generic).tokens ?? [])}</${tag}>`;
    },
  };
}

/** The marked extension for the enabled inline syntaxes, or null for none. */
export function inlineSyntaxExtension(options: InlineSyntaxOptions): MarkedExtension | null {
  const extensions: TokenizerAndRendererExtension[] = [];
  if (options.highlight) extensions.push(delimited("mark", "mark", "==", MARK));
  if (options.subscript) extensions.push(delimited("sub", "sub", "~", SUB));
  if (options.superscript) extensions.push(delimited("sup", "sup", "^", SUP));
  if (extensions.length === 0) return null;
  const extension: MarkedExtension = { extensions };
  if (options.subscript) {
    // GFM reads `~x~` as strikethrough. Where subscript did not take a single
    // tilde (it holds a space), it stays text rather than strike, as in Pandoc.
    extension.tokenizer = {
      del(src) {
        return src.startsWith("~~") ? false : undefined;
      },
    };
  }
  return extension;
}

// ---------------------------------------------------------------------------
// Footnotes
// ---------------------------------------------------------------------------

/** `[^label]` and `[^label]: text`. A label holds no whitespace and no `]`. */
const NOTE_DEF = /^ {0,3}\[\^([^\]\s]+)\]:[ \t]?/;
const NOTE_DEF_LINE = /^ {0,3}\[\^[^\]\s]+\]:/m;
const NOTE_REF = /^\[\^([^\]\s]+)\]/;
// A line that starts another block ends a definition's lazy continuation.
const BLOCK_START =
  /^ {0,3}(?:\[\^[^\]\s]+\]:|#{1,6}(?:\s|$)|>|[-*+][ \t]|\d{1,9}[.)][ \t]|`{3,}|~{3,}|<)/;

export interface FootnoteDefToken extends Tokens.Generic {
  type: "footnoteDef";
  raw: string;
  text: string;
  label: string;
  tokens: Tokens.Generic[];
}

interface FootnoteRefToken extends Tokens.Generic {
  type: "footnoteRef";
  label: string;
}

/**
 * Footnotes of one lex. Definitions are collected while the blocks are lexed,
 * before any inline text is, so a reference may come before its definition.
 * Numbers follow the first citation of each label, in document order.
 */
export interface FootnoteState {
  defs: Map<string, FootnoteDefToken>;
  /** Cited labels in order of their first citation. */
  order: string[];
  /** Every citation's label in document order, for the reuse signature. */
  sequence: string[];
  numbers: Map<string, number>;
  ids: Map<string, string>;
  citations: Map<string, number>;
}

export function newFootnoteState(): FootnoteState {
  return {
    defs: new Map(),
    order: [],
    sequence: [],
    numbers: new Map(),
    ids: new Map(),
    citations: new Map(),
  };
}

const normalizeLabel = (label: string) => label.toLowerCase();

const isBlank = (line: string) => line.trim() === "";
const isIndented = (line: string) => /^(?: {4}|\t)/.test(line);

/** The end of a definition: its first line, indented lines and lazy lines. */
function definitionEnd(src: string): number {
  let at = src.indexOf("\n");
  if (at < 0) return src.length;
  at += 1;
  let end = at;
  let previousBlank = false;
  while (at < src.length) {
    const next = src.indexOf("\n", at);
    const lineEnd = next < 0 ? src.length : next;
    const line = src.slice(at, lineEnd);
    const after = next < 0 ? src.length : next + 1;
    if (isBlank(line)) {
      previousBlank = true;
    } else if (isIndented(line) || (!previousBlank && !BLOCK_START.test(line))) {
      previousBlank = false;
      end = after;
    } else {
      break;
    }
    at = after;
  }
  return end;
}

function noteId(state: FootnoteState, label: string, number: number): string {
  let slug = label.replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!slug || [...state.ids.values()].includes(slug)) slug = `${slug ? `${slug}-` : ""}${number}`;
  return slug;
}

/** The marked extension for footnotes, reading and filling `state`. */
export function footnoteExtension(state: FootnoteState): MarkedExtension {
  const definition: TokenizerAndRendererExtension = {
    name: "footnoteDef",
    level: "block",
    // marked asks before every paragraph, with the rest of the document. A
    // paragraph ends at a blank line anyway, so look no further than that.
    start(src) {
      const blank = src.search(/\n[ \t]*\n/);
      return NOTE_DEF_LINE.exec(blank < 0 ? src : src.slice(0, blank + 1))?.index;
    },
    tokenizer(src) {
      const match = NOTE_DEF.exec(src);
      if (!match) return undefined;
      const raw = src.slice(0, definitionEnd(src));
      // One content line per raw line, each a suffix of its raw line, so the
      // word map can place the content the way it places a list item's.
      const lines = raw.replace(/\n$/, "").split("\n");
      const text = lines
        .map((line, i) =>
          i === 0 ? line.slice(match[0].length) : line.replace(/^(?: {1,4}|\t)/, ""),
        )
        .join("\n");
      const token: FootnoteDefToken = {
        type: "footnoteDef",
        raw,
        text,
        label: normalizeLabel(match[1]),
        tokens: this.lexer.blockTokens(text, []),
      };
      if (!state.defs.has(token.label)) state.defs.set(token.label, token);
      return token;
    },
    // Drawn in the footnotes section, never where it is defined.
    renderer() {
      return "";
    },
  };
  const reference: TokenizerAndRendererExtension = {
    name: "footnoteRef",
    level: "inline",
    start(src) {
      const at = src.indexOf("[^");
      return at < 0 ? undefined : at;
    },
    tokenizer(src) {
      const match = NOTE_REF.exec(src);
      if (!match) return undefined;
      const label = normalizeLabel(match[1]);
      if (!state.defs.has(label)) return undefined;
      if (!state.numbers.has(label)) {
        const number = state.order.length + 1;
        state.order.push(label);
        state.numbers.set(label, number);
        state.ids.set(label, noteId(state, label, number));
      }
      state.sequence.push(label);
      const citation = (state.citations.get(label) ?? 0) + 1;
      state.citations.set(label, citation);
      return { type: "footnoteRef", raw: match[0], label, citation };
    },
    renderer(token) {
      const { label, citation } = token as FootnoteRefToken & { citation: number };
      const id = state.ids.get(label) ?? "";
      const suffix = citation > 1 ? `-${citation}` : "";
      return (
        `<sup class="footnote-ref" role="doc-noteref">` +
        `<a href="#fn-${id}" id="fnref-${id}${suffix}">${state.numbers.get(label)}</a></sup>`
      );
    },
  };
  return { extensions: [definition, reference] };
}

/** Folds the footnotes into the block-reuse signature: numbers depend on them. */
export function footnoteSignature(state: FootnoteState): string {
  if (state.defs.size === 0) return "";
  return JSON.stringify([[...state.defs.keys()].sort(), state.sequence]);
}

/**
 * The footnotes section, or "" when nothing is cited. `parse` renders a
 * definition's block tokens with the document's renderer, so its text keeps
 * its word-map fragments. Each cited definition appears once, in citation
 * order, with one back-reference per citation.
 */
export function renderFootnoteSection(
  state: FootnoteState,
  parse: (tokens: Tokens.Generic[]) => string,
): string {
  if (state.order.length === 0) return "";
  let html = '<section class="footnotes" data-footnotes role="doc-endnotes">\n<ol>\n';
  for (const label of state.order) {
    const def = state.defs.get(label);
    if (!def) continue;
    const id = state.ids.get(label) ?? "";
    const number = state.numbers.get(label) ?? 0;
    let backrefs = "";
    for (let k = 1; k <= (state.citations.get(label) ?? 1); k += 1) {
      const suffix = k > 1 ? `-${k}` : "";
      backrefs +=
        ` <a href="#fnref-${id}${suffix}" class="footnote-backref" role="doc-backlink"` +
        ` aria-label="Back to reference ${number}${suffix}">↩︎${k > 1 ? `<sup>${k}</sup>` : ""}</a>`;
    }
    const body = parse(def.tokens).trimEnd();
    // GitHub puts the back-references at the end of the note's last paragraph.
    const content = body.endsWith("</p>")
      ? `${body.slice(0, -4)}${backrefs}</p>`
      : `${body}\n<p>${backrefs.trim()}</p>`;
    html += `<li id="fn-${id}">\n${content}\n</li>\n`;
  }
  return `${html}</ol>\n</section>\n`;
}
