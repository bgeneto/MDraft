//! Intermediate representation → GitHub-flavoured Markdown.

import type { Align, Block, Inline } from "./ir.ts";
import { inlineText } from "./ir.ts";

function escapeText(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/([`*_[\]<>$])/g, "\\$1");
}

function escapeLineStarts(value: string): string {
  return value
    .split("\n")
    .map((line) => {
      if (/^\s{0,3}(?:#{1,6}\s|[-+>]\s|\d+[.)]\s)/.test(line)) {
        return line.replace(/^(\s{0,3})([#\-+>]|\d+[.)])/, "$1\\$2");
      }
      return line;
    })
    .join("\n");
}

function codeFence(value: string): string {
  let ticks = 3;
  for (const match of value.matchAll(/`+/g)) ticks = Math.max(ticks, match[0].length + 1);
  return "`".repeat(ticks);
}

function codeSpan(value: string): string {
  let ticks = 1;
  for (const match of value.matchAll(/`+/g)) ticks = Math.max(ticks, match[0].length + 1);
  const fence = "`".repeat(ticks);
  const pad = value.startsWith("`") || value.endsWith("`") || /^\s|\s$/.test(value) ? " " : "";
  return `${fence}${pad}${value}${pad}${fence}`;
}

function linkDestination(href: string): string {
  if (/[\s()]/.test(href)) return `<${href.replace(/[<>]/g, encodeURIComponent)}>`;
  return href;
}

function renderInline(nodes: readonly Inline[]): string {
  let out = "";
  for (const node of nodes) {
    switch (node.kind) {
      case "text":
        out += escapeText(node.value);
        break;
      case "strong": {
        const body = renderInline(node.children);
        out += body ? `**${body}**` : "";
        break;
      }
      case "em": {
        const body = renderInline(node.children);
        out += body ? `*${body}*` : "";
        break;
      }
      case "strike": {
        const body = renderInline(node.children);
        out += body ? `~~${body}~~` : "";
        break;
      }
      case "code":
        out += codeSpan(node.value);
        break;
      case "link": {
        const body = renderInline(node.children) || escapeText(node.href);
        const title = node.title ? ` "${node.title.replace(/"/g, '\\"')}"` : "";
        out += `[${body}](${linkDestination(node.href)}${title})`;
        break;
      }
      case "image": {
        const title = node.title ? ` "${node.title.replace(/"/g, '\\"')}"` : "";
        out += `![${node.alt.replace(/\]/g, "\\]")}](${linkDestination(node.src)}${title})`;
        break;
      }
      case "math":
        out += node.display ? `\n\n$$\n${node.tex}\n$$\n\n` : `$${node.tex}$`;
        break;
      case "break":
        out += "\\\n";
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

function markerWidth(index: number, ordered: boolean): number {
  return ordered ? String(index + 1).length + 2 : 2;
}

function renderList(block: Extract<Block, { kind: "list" }>): string {
  const lines: string[] = [];
  block.items.forEach((item, index) => {
    const marker = block.ordered ? `${(block.start ?? 1) + index}. ` : "- ";
    const task = item.task === "done" ? "[x] " : item.task === "todo" ? "[ ] " : "";
    const rendered = renderBlocks(item.blocks).trim();
    const body = rendered || "";
    const bodyLines = body.split("\n");
    const indent = " ".repeat(markerWidth(index, block.ordered));
    lines.push(`${marker}${task}${bodyLines[0] ?? ""}`);
    for (const line of bodyLines.slice(1)) lines.push(`${indent}${line}`);
  });
  return lines.join("\n");
}

function renderTableCell(nodes: readonly Inline[]): string {
  return renderInline(nodes).replace(/\|/g, "\\|").replace(/\n/g, "<br>");
}

function alignment(align: Align): string {
  if (align === "left") return ":---";
  if (align === "center") return ":---:";
  if (align === "right") return "---:";
  return "---";
}

function renderTable(block: Extract<Block, { kind: "table" }>): string {
  const columns = Math.max(block.header?.length ?? 0, ...block.rows.map((row) => row.length), 1);
  const header = block.header ?? Array.from({ length: columns }, () => [] as Inline[]);
  const headerLine = `| ${header.map(renderTableCell).join(" | ")} |`;
  const delimiter = `| ${Array.from({ length: columns }, (_unused, index) => alignment(block.align[index] ?? null)).join(" | ")} |`;
  const rows = block.rows.map(
    (row) =>
      `| ${Array.from({ length: columns }, (_unused, index) => renderTableCell(row[index] ?? [])).join(" | ")} |`,
  );
  return [headerLine, delimiter, ...rows].join("\n");
}

function indent(value: string, prefix: string): string {
  return value
    .split("\n")
    .map((line) => (line ? `${prefix}${line}` : prefix.trimEnd()))
    .join("\n");
}

export function renderBlocks(blocks: readonly Block[]): string {
  return blocks
    .map((block) => {
      switch (block.kind) {
        case "paragraph":
          return escapeLineStarts(renderInline(block.children));
        case "heading":
          return `${"#".repeat(Math.min(6, Math.max(1, block.level)))} ${renderInline(block.children)}`;
        case "list":
          return renderList(block);
        case "quote":
          return indent(renderBlocks(block.blocks), "> ");
        case "code": {
          const fence = codeFence(block.text);
          const language = (block.language ?? "").replace(/[^\w+#.-]/g, "");
          return `${fence}${language}\n${block.text}\n${fence}`;
        }
        case "table":
          return renderTable(block);
        case "rule":
          return "---";
        case "math":
          return `$$\n${block.tex}\n$$`;
      }
    })
    .filter((value) => value.trim() !== "")
    .join("\n\n");
}

export function renderMarkdown(blocks: readonly Block[]): string {
  return renderBlocks(blocks).trim();
}

/** Exposed for the Node matrix, which folds rendered text back to compare it. */
export { inlineText };
