//! AsciiDoc source highlighting.
//!
//! A CodeMirror `StreamLanguage`, because there is no maintained Lezer grammar
//! for AsciiDoc. It covers the constructs the Paragraph and Format menus insert,
//! and names listing/literal/passthrough content `monospace` so
//! `inCodeContext()` and the spelling pass treat it as code.
//!
//! The delimited blocks are tracked across lines in the stream state. That is
//! what keeps a `= ` inside a listing from colouring as a heading and a `*` in a
//! table cell from opening emphasis.

import { StreamLanguage } from "@codemirror/language";

type BlockKind =
  | "listing"
  | "literal"
  | "passthrough"
  | "comment"
  | "example"
  | "sidebar"
  | "quote"
  | "table"
  | "open";

interface AsciiDocState {
  block: BlockKind | null;
  delimiter: string;
}

const DELIMITERS: Array<[RegExp, BlockKind]> = [
  [/^-{4,}$/, "listing"],
  [/^\.{4,}$/, "literal"],
  [/^\+{4,}$/, "passthrough"],
  [/^\/{4,}$/, "comment"],
  [/^={4,}$/, "example"],
  [/^\*{4,}$/, "sidebar"],
  [/^_{4,}$/, "quote"],
  [/^\|={3,}$/, "table"],
  [/^--$/, "open"],
];

function openerFor(line: string): { kind: BlockKind; delimiter: string } | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  for (const [pattern, kind] of DELIMITERS) {
    if (pattern.test(trimmed)) return { kind, delimiter: trimmed };
  }
  return null;
}

function isContentBlock(kind: BlockKind): boolean {
  return (
    kind === "listing" ||
    kind === "literal" ||
    kind === "passthrough" ||
    kind === "comment" ||
    kind === "table"
  );
}

/** The single AsciiDoc grammar. Stateless per use; installed by the editor. */
export function asciidocLanguage() {
  return StreamLanguage.define<AsciiDocState>({
    name: "asciidoc",
    startState: () => ({ block: null, delimiter: "" }),
    copyState: (state) => ({ ...state }),
    blankLine: () => {
      // A blank line inside a delimited block does not close it; the closing
      // delimiter is what does.
    },
    languageData: {
      commentTokens: { line: "//", block: { open: "////", close: "////" } },
    },
    token(stream, state) {
      if (stream.sol()) {
        const line = stream.string;

        if (state.block) {
          const close = openerFor(line);
          if (close && close.kind === state.block) {
            state.block = null;
            state.delimiter = "";
            stream.skipToEnd();
            return "punctuation";
          }
          if (isContentBlock(state.block)) {
            stream.skipToEnd();
            // `monospace` is what `inCodeContext()` and `SKIP_NODES` already
            // understand; the table is prose, so it keeps its own name.
            return state.block === "table" ? "table" : "monospace";
          }
          // Example, sidebar, quote and open blocks contain ordinary prose.
          // Their delimiter is still tracked, so a heading-shaped line inside
          // them is not treated as a section title.
        } else {
          const open = openerFor(line);
          if (open) {
            state.block = open.kind;
            state.delimiter = open.delimiter;
            stream.skipToEnd();
            return "punctuation";
          }
        }

        if (!state.block) {
          if (/^\s{0,3}={1,6}\s+\S/.test(line)) {
            stream.skipToEnd();
            return "heading";
          }
          if (/^\s{0,3}:[A-Za-z0-9_-]+:/.test(line)) {
            stream.skipToEnd();
            return "meta";
          }
          if (/^\s{0,3}\/\/\s/.test(line) || /^\s{0,3}\/\/$/.test(line)) {
            stream.skipToEnd();
            return "comment";
          }
          if (/^\s{0,3}\[[^\]]*\]\s*$/.test(line)) {
            stream.skipToEnd();
            return "meta";
          }
          if (/^\s{0,3}\.[^\s.]/.test(line)) {
            stream.skipToEnd();
            return "strong";
          }
          if (/^\s{0,3}'{3}\s*$/.test(line)) {
            stream.skipToEnd();
            return "punctuation";
          }
          if (/^\s{0,3}(?:image|include|xref):/.test(line)) {
            stream.skipToEnd();
            return "monospace";
          }
        }

        // These are valid inside example/quote/sidebar blocks too.
        if (/^\s{0,3}(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION):\s/.test(line)) {
          stream.match(/^\s{0,3}(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION):\s+/);
          return "strong";
        }
        if (stream.match(/^\s{0,3}(?:[*]+|\.+|\d+\.)\s+/)) return "punctuation";
      }

      // Inline constructs. The order matters: a block title `.Title` was
      // handled above, and the strike role has to win over a plain `[`.
      if (stream.match(/^`[^`\n]+`/)) return "monospace";
      if (stream.match(/^\*{1,2}[^*\n]+?\*{1,2}/)) return "strong";
      if (stream.match(/^_{1,2}[^_\n]+?_{1,2}/)) return "emphasis";
      if (stream.match(/^\[\.line-through\]#[^#\n]+#/)) return "strikethrough";
      if (stream.match(/^(?:https?:\/\/|www\.)[^\s\[]+\[[^\]]*\]/)) return "link";
      if (stream.match(/^(?:image|include|xref|link|footnote|kbd|btn|menu|latexmath|stem):[^\s\[]*\[[^\]]*\]/)) {
        return "monospace";
      }
      if (stream.match(/^(?:https?:\/\/|www\.)\S+/)) return "link";
      if (stream.match(/^<<[^>\n]+>>/)) return "link";
      if (stream.match(/^\[\[[^\]\n]+\]\]/)) return "link";
      if (stream.match(/^\{[A-Za-z0-9_-]+\}/)) return "meta";

      stream.next();
      return null;
    },
  });
}
