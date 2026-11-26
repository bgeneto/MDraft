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
