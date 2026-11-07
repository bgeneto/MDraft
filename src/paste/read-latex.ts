//! LaTeX source into the intermediate representation.
//!
//! Hand-written rather than parser-driven, unlike the Typst reader: LaTeX in this
//! project is a stream tokenizer (`latex-language.ts`), not a Lezer grammar, so
//! there is no syntax tree to walk. The mapping is deliberately finite and
//! **lossless in the fallback direction**: a construct this reader does not
//! understand survives as literal text rather than being dropped, because a paste
//! that silently deletes half the reader's document is worse than one that leaves
//! it as source.
//!
//! It reads what `render-latex.ts` writes, so a round trip through LaTeX is
//! stable, plus the constructs a reader is likely to paste from a real paper:
//! `\section` families, the emphasis wrappers, the list and quote environments,
//! `verbatim`, `tabular`, display and inline math, `\href` and
//! `\includegraphics`.

import type { Align, Block, Inline, ListItem } from "./ir.ts";
import { trimBlocks } from "./ir.ts";

/** The sectioning commands, shallowest first, with the level each maps to. */
const SECTIONS: Array<[string, number]> = [
  ["part", 1],
  ["chapter", 1],
  ["section", 1],
  ["subsection", 2],
  ["subsubsection", 3],
  ["paragraph", 4],
  ["subparagraph", 5],
];

/** The literal environments, whose bodies are text rather than markup. */
const LITERAL_ENVIRONMENTS = ["verbatim", "verbatim*", "lstlisting", "minted", "alltt"];

/** Read a balanced `{…}` group starting at `at`; returns the body and the end. */
function group(text: string, at: number): { body: string; end: number } | null {
  if (text[at] !== "{") return null;
  let depth = 0;
  for (let index = at; index < text.length; index += 1) {
    if (text[index] === "\\") {
      index += 1;
      continue;
    }
    if (text[index] === "{") depth += 1;
    else if (text[index] === "}") {
      depth -= 1;
      if (depth === 0) return { body: text.slice(at + 1, index), end: index + 1 };
    }
  }
  return null;
}

/** Read an optional `[…]` group, returning its body and the end. */
function optional(text: string, at: number): { body: string; end: number } | null {
  if (text[at] !== "[") return null;
  for (let index = at + 1; index < text.length; index += 1) {
    if (text[index] === "]") return { body: text.slice(at + 1, index), end: index + 1 };
  }
  return null;
}

/** Undo the escapes `escapeLatex` writes, and the plain ones a document uses. */
function unescapeLatex(value: string): string {
  return value
    .replace(/\\textbackslash\{\}/g, "\\")
    .replace(/\\textasciitilde\{\}/g, "~")
    .replace(/\\textasciicircum\{\}/g, "^")
    .replace(/\\([#$%&_{}])/g, "$1");
}

/**
 * Split `text` into inline nodes.
 *
 * Recursive descent over the wrappers this project writes. Anything else keeps
 * its source characters, which is why `\alpha` in prose survives as `\alpha`
 * instead of becoming an empty string.
 */
function parseInline(text: string): Inline[] {
  const nodes: Inline[] = [];
  let literal = "";

  const flush = () => {
    if (literal) {
      nodes.push({ kind: "text", value: unescapeLatex(literal) });
      literal = "";
    }
  };

  for (let at = 0; at < text.length; ) {
    // Inline math: `$…$`, kept verbatim because it is LaTeX already.
    if (text[at] === "$") {
      const close = text.indexOf("$", at + 1);
      if (close > at) {
        flush();
        nodes.push({ kind: "math", tex: text.slice(at + 1, close) });
        at = close + 1;
        continue;
      }
    }

    if (text[at] !== "\\") {
      literal += text[at];
      at += 1;
      continue;
    }

    // A line break: `\\` or `\\[2pt]`.
    if (text[at + 1] === "\\") {
      flush();
      nodes.push({ kind: "break" });
      at += 2;
      const size = optional(text, at);
      if (size) at = size.end;
      continue;
    }

    const command = /^\\([a-zA-Z]+)\*?/.exec(text.slice(at));
    if (!command) {
      literal += text[at];
      at += 1;
      continue;
    }
    const name = command[1];
    let cursor = at + command[0].length;

    // A wrapper whose single argument is inline content.
    const wrapper: Record<string, Inline["kind"]> = {
      textbf: "strong",
      textit: "em",
      emph: "em",
      sout: "strike",
    };
    if (wrapper[name]) {
      const body = group(text, cursor);
      if (body) {
        flush();
        nodes.push({ kind: wrapper[name], children: parseInline(body.body) } as Inline);
        at = body.end;
        continue;
      }
    }

    if (name === "texttt") {
      const body = group(text, cursor);
      if (body) {
        flush();
        nodes.push({ kind: "code", value: unescapeLatex(body.body) });
        at = body.end;
        continue;
      }
    }

    if (name === "textsuperscript" || name === "textsubscript") {
      const body = group(text, cursor);
      if (body) {
        flush();
        nodes.push({
          kind: name === "textsuperscript" ? "sup" : "sub",
          children: parseInline(body.body),
        } as Inline);
        at = body.end;
        continue;
      }
    }

    if (name === "href") {
      const target = group(text, cursor);
      const label = target ? group(text, target.end) : null;
      if (target && label) {
        flush();
        nodes.push({
          kind: "link",
          href: target.body,
          children: parseInline(label.body),
        });
        at = label.end;
        continue;
      }
    }

    if (name === "includegraphics") {
      const size = optional(text, cursor);
      if (size) cursor = size.end;
      const source = group(text, cursor);
      if (source) {
        flush();
        nodes.push({ kind: "image", src: source.body, alt: "" });
        at = source.end;
        continue;
      }
    }

    // Anything else is literal source: `\alpha`, `\cite{…}`, a macro.
    literal += command[0];
    at = cursor;
  }

  flush();
  return nodes;
}

/** The `tabular` column spec as alignments, for the table block. */
function alignments(spec: string): Align[] {
  const out: Align[] = [];
  for (const char of spec) {
    if (char === "l") out.push("left");
    else if (char === "c") out.push("center");
    else if (char === "r") out.push("right");
  }
  return out;
}

/** Split a `tabular` body into rows of cells, honouring `\\` and `&`. */
function tableRows(body: string): Inline[][][] {
  return body
    .split(/\\\\/)
    .map((row) => row.replace(/\\hline/g, "").trim())
    .filter((row) => row !== "")
    .map((row) =>
      row.split("&").map((cell) => parseInline(cell.trim())),
    );
}

/** Parse a block-level environment body, or return null when it is not literal. */
function environment(text: string, at: number): { block: Block; end: number } | null {
  const open = /^\\begin\{([^{}]+)\}/.exec(text.slice(at));
  if (!open) return null;
  const name = open[1];
  const bodyStart = at + open[0].length;
  const close = `\\end{${name}}`;
  const closeAt = text.indexOf(close, bodyStart);
  if (closeAt < 0) return null;
  const body = text.slice(bodyStart, closeAt);
  const end = closeAt + close.length;

  if (LITERAL_ENVIRONMENTS.includes(name)) {
    return { block: { kind: "code", language: null, text: body.replace(/^\n|\n$/g, "") }, end };
  }

  if (name === "itemize" || name === "enumerate") {
    const items: ListItem[] = [];
    // `\item` starts each entry; the text between two of them is its body.
    const parts = body.split(/\\item\b/).slice(1);
    for (const part of parts) {
      const marker = /^\s*\[([^\]]*)\]/.exec(part);
      const task = marker
        ? /checkmark|✓/.test(marker[1])
          ? "done"
          : /square|☐/.test(marker[1])
            ? "todo"
            : undefined
        : undefined;
      const content = marker ? part.slice(marker[0].length) : part;
      items.push({
        blocks: [{ kind: "paragraph", children: parseInline(content.trim()) }],
        ...(task ? { task } : {}),
      });
    }
    return { block: { kind: "list", ordered: name === "enumerate", items }, end };
  }

  if (name === "quote" || name === "quotation") {
    return { block: { kind: "quote", blocks: parseBlocks(body) }, end };
  }

  if (name === "tabular" || name === "tabularx" || name === "longtable") {
    // The column spec is the first brace group after `\begin{tabular}`.
    let cursor = 0;
    while (cursor < body.length && body[cursor] !== "{") cursor += 1;
    const spec = group(body, cursor);
    const specText = spec ? spec.body : "";
    const rows = tableRows(spec ? body.slice(spec.end) : body);
    const header = rows.length > 1 ? rows[0] : null;
    return {
      block: {
        kind: "table",
        align: alignments(specText),
        header,
        rows: header ? rows.slice(1) : rows,
      },
      end,
    };
  }

  if (name === "table" || name === "figure" || name === "center") {
    // A float or a centring wrapper: its contents are the block, and the
    // environment itself has no meaning once the content is extracted.
    const inner = parseBlocks(body);
    return inner.length
      ? { block: inner[0], end }
      : null;
  }

  return null;
}

/** Parse `text` into blocks. */
function parseBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  let paragraph = "";

  const flushParagraph = () => {
    const joined = paragraph.trim();
    paragraph = "";
    if (joined) blocks.push({ kind: "paragraph", children: parseInline(joined) });
  };

  let at = 0;
  while (at < text.length) {
    const rest = text.slice(at);

    // Display math: `\[ … \]` or `$$ … $$`.
    const display = /^\s*(\\\[|\$\$)/.exec(rest);
    if (display) {
      const opener = display[1];
      const closer = opener === "\\[" ? "\\]" : "$$";
      const start = at + display[0].length;
      const end = text.indexOf(closer, start);
      if (end > start) {
        flushParagraph();
        blocks.push({ kind: "math", tex: text.slice(start, end).trim() });
        at = end + closer.length;
        continue;
      }
    }

    // A heading: `\section{…}` and its siblings.
    const heading = /^\s*\\([a-zA-Z]+)\*?\s*/.exec(rest);
    if (heading) {
      const match = SECTIONS.find(([name]) => name === heading[1]);
      if (match) {
        const body = group(text, at + heading[0].length);
        if (body) {
          flushParagraph();
          blocks.push({ kind: "heading", level: match[1], children: parseInline(body.body) });
          at = body.end;
          continue;
        }
      }
    }

    // A block environment.
    const env = environment(text, at);
    if (env) {
      flushParagraph();
      blocks.push(env.block);
      at = env.end;
      continue;
    }

    // A horizontal rule.
    if (/^\s*\\hrule\b|^\s*\\noindent\\rule/.test(rest)) {
      flushParagraph();
      blocks.push({ kind: "rule" });
      const lineEnd = text.indexOf("\n", at);
      at = lineEnd < 0 ? text.length : lineEnd + 1;
      continue;
    }

    // A blank line ends a paragraph.
    const blank = /^\n\s*\n/.exec(rest);
    if (blank) {
      flushParagraph();
      at += blank[0].length;
      continue;
    }

    // Ordinary text: consume the run up to a blank line or a backslash. A single
    // newline is a space in LaTeX prose, not a line break, so it is normalised
    // here — leaving it would put a newline inside a paragraph and break the
    // inline parser's view of the text.
    const run = /^[^\\\n]+/.exec(rest);
    if (run) {
      paragraph += run[0];
      at += run[0].length;
      continue;
    }

    // A single newline inside a paragraph becomes a space.
    if (text[at] === "\n") {
      paragraph += " ";
      at += 1;
      continue;
    }

    // A backslash that starts no block construct: keep the whole command in the
    // paragraph so `parseInline` can see it.
    const inline = /^\\[a-zA-Z]+\*?/.exec(rest);
    if (inline) {
      paragraph += inline[0];
      at += inline[0].length;
      continue;
    }

    // A lone backslash with nothing this reader recognises: keep it as text.
    paragraph += text[at];
    at += 1;
  }

  flushParagraph();
  return blocks;
}

/**
 * Read LaTeX source into the intermediate representation.
 *
 * A fragment without any markup becomes one paragraph, which is the case that
 * matters most: pasting a sentence from a `.tex` file into Markdown.
 */
export function readLatex(text: string): Block[] {
  // A whole document: only the body is content, and the preamble is not.
  const begin = text.indexOf("\\begin{document}");
  const end = text.lastIndexOf("\\end{document}");
  const body =
    begin >= 0 && end > begin
      ? text.slice(begin + "\\begin{document}".length, end)
      : text;
  return trimBlocks(parseBlocks(body));
}
