//! Intermediate representation → a semantic HTML fragment.
//!
//! This is the HTML a Markdown or Typst source becomes, not a copy of the page it
//! came from. Math is rendered to MathML by KaTeX, which needs no stylesheet.

import katex from "katex";
import type { Align, Block, Inline } from "./ir.ts";

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function mathHtml(tex: string, display: boolean): string {
  try {
    return katex.renderToString(tex, {
      output: "mathml",
      displayMode: display,
      throwOnError: false,
    });
  } catch {
    return escapeHtml(tex);
  }
}

function renderInline(nodes: readonly Inline[]): string {
  let out = "";
  for (const node of nodes) {
    switch (node.kind) {
      case "text":
        out += escapeHtml(node.value);
        break;
      case "strong":
        out += `<strong>${renderInline(node.children)}</strong>`;
        break;
      case "em":
        out += `<em>${renderInline(node.children)}</em>`;
        break;
      case "strike":
        out += `<s>${renderInline(node.children)}</s>`;
        break;
      case "code":
        out += `<code>${escapeHtml(node.value)}</code>`;
        break;
      case "link": {
        const title = node.title ? ` title="${escapeHtml(node.title)}"` : "";
        out += `<a href="${escapeHtml(node.href)}"${title}>${renderInline(node.children)}</a>`;
        break;
      }
      case "image": {
        const title = node.title ? ` title="${escapeHtml(node.title)}"` : "";
        out += `<img src="${escapeHtml(node.src)}" alt="${escapeHtml(node.alt)}"${title}>`;
        break;
      }
      case "math":
        out += mathHtml(node.tex, node.display === true);
        break;
      case "break":
        out += "<br>";
        break;
      case "sup":
        out += `<sup>${renderInline(node.children)}</sup>`;
        break;
      case "sub":
        out += `<sub>${renderInline(node.children)}</sub>`;
        break;
    }
  }
  return out;
}

function alignStyle(align: Align): string {
  return align ? ` style="text-align: ${align}"` : "";
}

function renderTable(block: Extract<Block, { kind: "table" }>): string {
  const columns = Math.max(block.header?.length ?? 0, ...block.rows.map((row) => row.length), 1);
  const cell = (tag: "td" | "th", nodes: readonly Inline[], index: number) =>
    `<${tag}${alignStyle(block.align[index] ?? null)}>${renderInline(nodes)}</${tag}>`;
  const head = block.header
    ? `<thead><tr>${Array.from({ length: columns }, (_unused, index) => cell("th", block.header?.[index] ?? [], index)).join("")}</tr></thead>`
    : "";
  const rows = block.rows
    .map(
      (row) =>
        `<tr>${Array.from({ length: columns }, (_unused, index) => cell("td", row[index] ?? [], index)).join("")}</tr>`,
    )
    .join("");
  return `<table>${head}<tbody>${rows}</tbody></table>`;
}

function renderBlocks(blocks: readonly Block[]): string {
  return blocks
    .map((block) => {
      switch (block.kind) {
        case "paragraph":
          return `<p>${renderInline(block.children)}</p>`;
        case "heading": {
          const level = Math.min(6, Math.max(1, block.level));
          return `<h${level}>${renderInline(block.children)}</h${level}>`;
        }
        case "list": {
          const tag = block.ordered ? "ol" : "ul";
          const start =
            block.ordered && block.start && block.start !== 1 ? ` start="${block.start}"` : "";
          const items = block.items
            .map((item) => {
              const checkbox =
                item.task === "done"
                  ? '<input type="checkbox" checked disabled> '
                  : item.task === "todo"
                    ? '<input type="checkbox" disabled> '
                    : "";
              return `<li>${checkbox}${renderBlocks(item.blocks)}</li>`;
            })
            .join("");
          return `<${tag}${start}>${items}</${tag}>`;
        }
        case "quote":
          return `<blockquote>${renderBlocks(block.blocks)}</blockquote>`;
        case "code": {
          const language = block.language ? ` class="language-${escapeHtml(block.language)}"` : "";
          return `<pre><code${language}>${escapeHtml(block.text)}</code></pre>`;
        }
        case "table":
          return renderTable(block);
        case "rule":
          return "<hr>";
        case "math":
          return `<div class="math-display">${mathHtml(block.tex, true)}</div>`;
      }
    })
    .filter((value) => value !== "")
    .join("\n");
}

export function renderHtmlFragment(blocks: readonly Block[]): string {
  return renderBlocks(blocks);
}
