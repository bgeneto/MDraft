//! Render the paste IR as AsciiDoc.
//!
//! No Asciidoctor and no Tauri import: the Node conversion suite loads this
//! directly. A block image uses `image::`; an image inside a sentence uses
//! `image:`. Attribute values escape the two characters that would end or split
//! the attribute list.

import type { Block, Inline } from "./ir.ts";
import { imageSyntaxFor } from "../image-syntax.ts";

function escapeText(value: string): string {
  return value.replace(/([\\*_`[\]])/g, "\\$1");
}

function escapeAttribute(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\]/g, "\\]").replace(/,/g, "\\,");
}

function inlineImage(src: string, alt: string): string {
  return `image:${src}[${escapeAttribute(alt)}]`;
}

function inline(nodes: readonly Inline[]): string {
  let out = "";
  for (const node of nodes) {
    switch (node.kind) {
      case "text":
        out += escapeText(node.value);
        break;
      case "strong":
        out += `*${inline(node.children)}*`;
        break;
      case "em":
        out += `_${inline(node.children)}_`;
        break;
      case "strike":
        out += `[.line-through]#${inline(node.children)}#`;
        break;
      case "code":
        out += `\`${node.value.replace(/`/g, "\\`")}\``;
        break;
      case "link": {
        const text = inline(node.children);
        if (node.href.startsWith("#")) out += `<<${node.href.slice(1)},${text}>>`;
        else if (/^(?:https?:\/\/|mailto:)/i.test(node.href)) out += `${node.href}[${text}]`;
        else out += `link:${node.href}[${text}]`;
        break;
      }
      case "image":
        out += inlineImage(node.src, node.alt);
        break;
      case "math":
        out += `latexmath:[${node.tex}]`;
        break;
      case "break":
        out += " +\n";
        break;
      case "sup":
        out += `^${inline(node.children)}^`;
        break;
      case "sub":
        out += `~${inline(node.children)}~`;
        break;
      default:
        break;
    }
  }
  return out;
}

function block(node: Block): string {
  switch (node.kind) {
    case "paragraph": {
      if (node.children.length === 1 && node.children[0].kind === "image") {
        const image = node.children[0];
        return imageSyntaxFor("asciidoc", image.alt, image.src);
      }
      return inline(node.children);
    }
    case "heading":
      return `${"=".repeat(Math.min(6, Math.max(1, node.level + 1)))} ${inline(node.children)}`;
    case "list":
      return node.items
        .map((item) => {
          const marker = node.ordered ? "." : "*";
          const task = item.task === "done" ? "[x] " : item.task === "todo" ? "[ ] " : "";
          return `${marker} ${task}${item.blocks.map(block).join("\n")}`;
        })
        .join("\n");
    case "quote":
      return `____\n${node.blocks.map(block).join("\n\n")}\n____`;
    case "code": {
      const fence = "----";
      const language = node.language ? `[source,${node.language}]\n` : "";
      return `${language}${fence}\n${node.text}\n${fence}`;
    }
    case "table": {
      const rows = [...(node.header ? [node.header] : []), ...node.rows].map(
        (row) => `| ${row.map((cell) => inline(cell)).join(" | ")}`,
      );
      const header = node.header ? '[options="header"]\n' : "";
      return `${header}|===\n${rows.join("\n")}\n|===`;
    }
    case "rule":
      return "'''";
    case "math":
      return `[latexmath]\n++++\n${node.tex}\n++++`;
    default:
      return "";
  }
}

/** Render an IR fragment as AsciiDoc source. */
export function renderAsciidoc(blocks: readonly Block[]): string {
  return blocks
    .map(block)
    .filter((part) => part.trim() !== "")
    .join("\n\n")
    .trim();
}
