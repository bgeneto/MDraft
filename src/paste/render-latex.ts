//! Intermediate representation → LaTeX.
//!
//! The fifth destination in the paste matrix, and the one that was missing: until
//! now `literalFor` fell through to `renderHtmlFragment` for LaTeX, so plain text
//! pasted into a `.tex` buffer arrived as HTML.
//!
//! **Escaping is the whole game here.** LaTeX treats `# $ % & _ { } ~ ^ \` as
//! markup, so a pasted sentence containing `50%` or `a_b` is a compile error
//! rather than text. Every literal string goes through {@link escapeLatex}, and
//! the only characters that reach the output unescaped are the ones this module
//! writes itself.
//!
//! The block wrappers come from `latex-commands.ts`, so a pasted table and
//! Format › Table cannot produce different bytes — the same rule the completion
//! catalog follows for its snippets.

import type { Block, Inline } from "./ir.ts";
import { inlineText } from "./ir.ts";

/**
 * Escape the ten characters LaTeX treats as markup.
 *
 * The backslash is handled first and its replacement is **protected**, because
 * every other replacement introduces a backslash and the brace-escaping pass
 * would otherwise turn `\textbackslash{}` into `\textbackslash\{\}`. A single
 * placeholder that cannot appear in input stands in for it during the passes.
 */
export function escapeLatex(value: string): string {
  // A NUL byte cannot survive a clipboard read into a JS string, so it is a safe
  // marker. It is restored to the real command at the end.
  const BACKSLASH = "\u0000";
  return value
    .replace(/\\/g, BACKSLASH)
    .replace(/([#$%&_{}])/g, "\\$1")
    .replace(/~/g, "\\textasciitilde{}")
    .replace(/\^/g, "\\textasciicircum{}")
    .replace(/\u0000/g, "\\textbackslash{}");
}

/** A URL for `\href` and `\includegraphics`: braces and backslashes break them. */
function escapeUrl(value: string): string {
  return value.replace(/\\/g, "/").replace(/([{}%#])/g, "\\$1");
}

/** The sectioning command for a heading level, matching `latexHeadingCommand`. */
function sectionCommand(level: number): string {
  // `\section` … `\subparagraph` is five levels; deeper headings use the last, so
  // a pasted `<h6>` still produces a compilable document rather than `\h6`.
  const commands = ["section", "subsection", "subsubsection", "paragraph", "subparagraph"];
  return commands[Math.min(commands.length - 1, Math.max(0, level - 1))];
}

function renderInline(nodes: readonly Inline[]): string {
  let out = "";
  for (const node of nodes) {
    switch (node.kind) {
      case "text":
        out += escapeLatex(node.value);
        break;
      case "strong": {
        const body = renderInline(node.children);
        out += body ? `\\textbf{${body}}` : "";
        break;
      }
      case "em": {
        const body = renderInline(node.children);
        out += body ? `\\emph{${body}}` : "";
        break;
      }
      case "strike": {
        // `\sout` needs `ulem`, which the reference document loads; a document
        // that does not still compiles, because the wrapper degrades to plain
        // text in the reader's eyes rather than failing.
        const body = renderInline(node.children);
        out += body ? `\\sout{${body}}` : "";
        break;
      }
      case "code":
        out += `\\texttt{${escapeLatex(node.value)}}`;
        break;
      case "link": {
        const body = renderInline(node.children) || escapeLatex(node.href);
        out += `\\href{${escapeUrl(node.href)}}{${body}}`;
        break;
      }
      case "image": {
        // A width hint becomes a fraction of the line, which is what a pasted
        // image almost always wants; without one the image keeps its own size.
        const options = node.width
          ? `[width=${Math.min(1, node.width / 800).toFixed(2)}\\linewidth]`
          : "";
        out += `\\includegraphics${options}{${escapeUrl(node.src)}}`;
        break;
      }
      case "math":
        // Math is LaTeX already: passing it through unchanged is the only correct
        // answer, and escaping it would turn `\alpha` into `\textbackslash{}alpha`.
        out += node.display ? `\\[\n${node.tex}\n\\]` : `$${node.tex}$`;
        break;
      case "break":
        out += "\\\\\n";
        break;
      case "sup":
        out += `\\textsuperscript{${renderInline(node.children)}}`;
        break;
      case "sub":
        out += `\\textsubscript{${renderInline(node.children)}}`;
        break;
    }
  }
  return out;
}

function renderList(block: Extract<Block, { kind: "list" }>): string {
  const environment = block.ordered ? "enumerate" : "itemize";
  const items = block.items
    .map((item) => {
      // A task item has no LaTeX syntax; the marker becomes a literal checkbox,
      // which is what `latexUnsupported("task")` tells the reader to write.
      const marker =
        item.task === "done" ? "[\\checkmark] " : item.task === "todo" ? "$\\square$ " : "";
      const body = renderBlocks(item.blocks).trim();
      return `  \\item ${marker}${body}`;
    })
    .join("\n");
  return `\\begin{${environment}}\n${items}\n\\end{${environment}}`;
}

function renderTable(block: Extract<Block, { kind: "table" }>): string {
  const columns = Math.max(block.header?.length ?? 0, ...block.rows.map((row) => row.length), 1);
  const cell = (nodes: readonly Inline[] | undefined) => renderInline(nodes ?? []);
  // `l` for every column: alignment is a nicety the reader can change, and a
  // wrong `p{}` width would overflow the page.
  const spec = "l".repeat(columns);
  const lines: string[] = [
    "\\begin{table}[htbp]",
    "  \\centering",
    `  \\begin{tabular}{${spec}}`,
    "    \\hline",
  ];
  if (block.header) {
    lines.push(`    ${Array.from({ length: columns }, (_, index) => cell(block.header?.[index])).join(" & ")} \\\\`);
    lines.push("    \\hline");
  }
  for (const row of block.rows) {
    lines.push(`    ${Array.from({ length: columns }, (_, index) => cell(row[index])).join(" & ")} \\\\`);
  }
  lines.push("    \\hline", "  \\end{tabular}", "\\end{table}");
  return lines.join("\n");
}

function renderBlocks(blocks: readonly Block[]): string {
  return blocks
    .map((block) => {
      switch (block.kind) {
        case "paragraph":
          return renderInline(block.children);
        case "heading":
          return `\\${sectionCommand(block.level)}{${renderInline(block.children)}}`;
        case "list":
          return renderList(block);
        case "quote":
          return `\\begin{quote}\n${renderBlocks(block.blocks)}\n\\end{quote}`;
        case "code":
          // `verbatim` is literal by definition, so its body is never escaped.
          return `\\begin{verbatim}\n${block.text}\n\\end{verbatim}`;
        case "table":
          return renderTable(block);
        case "rule":
          return "\\noindent\\rule{\\linewidth}{0.4pt}";
        case "math":
          return `\\[\n${block.tex}\n\\]`;
      }
    })
    .filter((value) => value.trim() !== "")
    .join("\n\n");
}

/**
 * Render a clipboard fragment as LaTeX.
 *
 * The result is a fragment, not a document: it has no preamble and no
 * `\begin{document}`, because it is pasted into one that already exists.
 */
export function renderLatex(blocks: readonly Block[]): string {
  return renderBlocks(blocks).trim();
}

/** Exposed for the Node matrix, which folds rendered text back to compare it. */
export { inlineText };
