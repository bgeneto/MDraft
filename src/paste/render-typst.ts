//! Intermediate representation → Typst markup.

import type { Align, Block, Inline } from "./ir.ts";
import { texToTypstMath } from "./math.ts";
import { typstString } from "../image-syntax.ts";

function escapeText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/([#*_$@<>~`\[\]])/g, "\\$1")
    .replace(/^(\s*)([-+/=])/gm, "$1\\$2");
}

function rawSpan(value: string): string {
  let ticks = 1;
  for (const match of value.matchAll(/`+/g)) ticks = Math.max(ticks, match[0].length + 1);
  const fence = "`".repeat(ticks);
  return `${fence}${value}${fence}`;
}

function codeFence(value: string): string {
  let ticks = 3;
  for (const match of value.matchAll(/`+/g)) ticks = Math.max(ticks, match[0].length + 1);
  return "`".repeat(ticks);
}

function renderInline(nodes: readonly Inline[], inTable = false): string {
  let out = "";
  for (const node of nodes) {
    switch (node.kind) {
      case "text":
        out += escapeText(node.value);
        break;
      case "strong": {
        const body = renderInline(node.children, inTable);
        out += body ? `*${body}*` : "";
        break;
      }
      case "em": {
        const body = renderInline(node.children, inTable);
        out += body ? `_${body}_` : "";
        break;
      }
      case "strike": {
        const body = renderInline(node.children, inTable);
        out += body ? `#strike[${body}]` : "";
        break;
      }
      case "code":
        out += rawSpan(node.value);
        break;
      case "link": {
        const body = renderInline(node.children, inTable) || escapeText(node.href);
        out += `#link("${typstString(node.href)}")[${body}]`;
        break;
      }
      case "image": {
        const remote = /^(?:https?:|data:)/i.test(node.src);
        if (remote) {
          const label = escapeText(node.alt || node.src);
          out += `#link("${typstString(node.src)}")[${label}]`;
        } else {
          const alt = node.alt.trim() ? `, alt: "${typstString(node.alt)}"` : "";
          out += `#image("${typstString(node.src)}"${alt})`;
        }
        break;
      }
      case "math":
        out += `$${texToTypstMath(node.tex)}$`;
        break;
      case "break":
        out += " \\\n";
        break;
      case "sup": {
        const body = renderInline(node.children, inTable);
        out += body ? `#super[${body}]` : "";
        break;
      }
      case "sub": {
        const body = renderInline(node.children, inTable);
        out += body ? `#sub[${body}]` : "";
        break;
      }
    }
  }
  return out;
}

function renderList(block: Extract<Block, { kind: "list" }>): string {
  const lines: string[] = [];
  for (const [index, item] of block.items.entries()) {
    const marker = block.ordered ? "+ " : "- ";
    const task = item.task === "done" ? "☑ " : item.task === "todo" ? "☐ " : "";
    const rendered = renderBlocks(item.blocks).trim();
    const bodyLines = rendered.split("\n");
    lines.push(`${marker}${task}${bodyLines[0] ?? ""}`);
    for (const line of bodyLines.slice(1)) lines.push(`  ${line}`);
    void index;
  }
  return lines.join("\n");
}

function alignment(align: Align): string {
  return align ?? "left";
}

function renderTable(block: Extract<Block, { kind: "table" }>): string {
  const columns = Math.max(block.header?.length ?? 0, ...block.rows.map((row) => row.length), 1);
  const parts: string[] = [`columns: ${columns}`];
  if (block.align.some((value) => value !== null)) {
    parts.push(
      `align: (${Array.from({ length: columns }, (_unused, index) => alignment(block.align[index] ?? null)).join(", ")})`,
    );
  }
  const cell = (nodes: readonly Inline[]) => `[${renderInline(nodes, true)}]`;
  if (block.header) parts.push(`table.header(${block.header.map(cell).join(", ")})`);
  for (const row of block.rows) {
    const cells = Array.from({ length: columns }, (_unused, index) => cell(row[index] ?? []));
    parts.push(cells.join(", "));
  }
  return `#table(${parts.join(", ")})`;
}

function renderBlocks(blocks: readonly Block[]): string {
  return blocks
    .map((block) => {
      switch (block.kind) {
        case "paragraph":
          return renderInline(block.children);
        case "heading":
          return `${"=".repeat(Math.min(6, Math.max(1, block.level)))} ${renderInline(block.children)}`;
        case "list":
          return renderList(block);
        case "quote":
          return `#quote(block: true)[\n${renderBlocks(block.blocks)}\n]`;
        case "code": {
          const fence = codeFence(block.text);
          const language = (block.language ?? "").replace(/[^\w+-]/g, "");
          return `${fence}${language}\n${block.text}\n${fence}`;
        }
        case "table":
          return renderTable(block);
        case "rule":
          return "#line(length: 100%)";
        case "math":
          return `$ ${texToTypstMath(block.tex)} $`;
      }
    })
    .filter((value) => value.trim() !== "")
    .join("\n\n");
}

export function renderTypst(blocks: readonly Block[]): string {
  return renderBlocks(blocks).trim();
}
