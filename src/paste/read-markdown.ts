//! Markdown into the intermediate representation.
//!
//! `marked` already owns the GFM dialect the preview uses. Reusing its lexer here
//! means paste and preview agree about tables, task lists and nesting. Raw HTML
//! blocks are handed to the HTML reader so one fragment has one shape.

import { Marked } from "marked";
import type { Align, Block, Inline, ListItem } from "./ir.ts";
import { trimBlocks } from "./ir.ts";
import { analyzeMath } from "../math-delimiters.ts";
import { readHtml, htmlToText } from "./read-html.ts";

type AnyToken = any;

const markdown = new Marked({ gfm: true, breaks: false });

function safeUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  const url = value.trim();
  if (!url || /^(?:javascript|vbscript|data):/i.test(url)) return null;
  return url;
}

function textNode(value: string): Inline[] {
  return [{ kind: "text", value }];
}

function inlineFromTokens(tokens: AnyToken[] | undefined): Inline[] {
  if (!tokens || tokens.length === 0) return [];
  const out: Inline[] = [];
  for (const token of tokens) {
    switch (token.type) {
      case "text":
        out.push(
          ...(token.tokens ? inlineFromTokens(token.tokens) : textNode(String(token.text ?? ""))),
        );
        break;
      case "escape":
        out.push({ kind: "text", value: String(token.text ?? "") });
        break;
      case "strong":
        out.push({ kind: "strong", children: inlineFromTokens(token.tokens) });
        break;
      case "em":
        out.push({ kind: "em", children: inlineFromTokens(token.tokens) });
        break;
      case "del":
        out.push({ kind: "strike", children: inlineFromTokens(token.tokens) });
        break;
      case "codespan":
        out.push({ kind: "code", value: String(token.text ?? "") });
        break;
      case "br":
        out.push({ kind: "break" });
        break;
      case "link": {
        const href = safeUrl(token.href);
        const body = inlineFromTokens(token.tokens);
        if (href) out.push({ kind: "link", href, title: token.title ?? undefined, children: body });
        else out.push(...body);
        break;
      }
      case "image": {
        const src = safeUrl(token.href);
        if (src) {
          out.push({
            kind: "image",
            src,
            alt: String(token.text ?? ""),
            title: token.title ?? undefined,
          });
        } else {
          out.push({ kind: "text", value: String(token.text ?? "") });
        }
        break;
      }
      case "html":
        out.push({ kind: "text", value: htmlToText(String(token.text ?? "")) });
        break;
      case "checkbox":
        break;
      default:
        if (Array.isArray(token.tokens)) out.push(...inlineFromTokens(token.tokens));
        else if (typeof token.text === "string") out.push(...textNode(token.text));
    }
  }
  return out;
}

function listBlock(token: AnyToken): Block {
  const ordered = Boolean(token.ordered);
  const start = Number.parseInt(String(token.start ?? "1"), 10);
  const items: ListItem[] = [];
  for (const item of token.items ?? []) {
    const blocks: Block[] = [];
    for (const child of item.tokens ?? []) {
      if (child.type === "list") {
        blocks.push(...blockFromToken(child));
      } else if (child.type === "text" || child.type === "paragraph") {
        const inline = inlineFromTokens(child.tokens ?? [child]);
        if (inline.length > 0) blocks.push({ kind: "paragraph", children: inline });
      } else if (child.type !== "checkbox" && child.type !== "space") {
        blocks.push(...blockFromToken(child));
      }
    }
    const task = item.task ? (item.checked ? "done" : "todo") : undefined;
    items.push({ blocks, task });
  }
  return { kind: "list", ordered, start: Number.isFinite(start) ? start : undefined, items };
}

function tableBlock(token: AnyToken): Block {
  const header = (token.header ?? []).map((cell: AnyToken) => inlineFromTokens(cell.tokens));
  const rows = (token.rows ?? []).map((row: AnyToken[]) =>
    row.map((cell: AnyToken) => inlineFromTokens(cell.tokens)),
  );
  const align: Align[] = (token.header ?? []).map(
    (cell: AnyToken) => (cell.align ?? null) as Align,
  );
  return { kind: "table", align, header, rows };
}

function blockFromToken(token: AnyToken): Block[] {
  switch (token.type) {
    case "space":
    case "def":
      return [];
    case "heading":
      return [
        {
          kind: "heading",
          level: Number(token.depth ?? 1),
          children: inlineFromTokens(token.tokens),
        },
      ];
    case "paragraph": {
      const children = inlineFromTokens(token.tokens);
      if (children.length === 1 && children[0].kind === "math" && children[0].display) {
        return [{ kind: "math", tex: children[0].tex }];
      }
      return [{ kind: "paragraph", children }];
    }
    case "text": {
      const children = inlineFromTokens(token.tokens ?? [token]);
      return children.length > 0 ? [{ kind: "paragraph", children }] : [];
    }
    case "list":
      return [listBlock(token)];
    case "blockquote": {
      const blocks: Block[] = [];
      for (const child of token.tokens ?? []) blocks.push(...blockFromToken(child));
      return blocks.length > 0 ? [{ kind: "quote", blocks }] : [];
    }
    case "code": {
      const language =
        String(token.lang ?? "")
          .trim()
          .split(/\s+/)[0] || null;
      return [{ kind: "code", language, text: String(token.text ?? "") }];
    }
    case "table":
      return [tableBlock(token)];
    case "hr":
      return [{ kind: "rule" }];
    case "html":
      // Handled by the async reader in readMarkdown; this branch is only used
      // for an inline-ish fragment that slipped into the block list.
      return [];
    default:
      return [];
  }
}

export async function readMarkdown(source: string): Promise<Block[]> {
  // Protect TeX before Markdown interprets its escapes and emphasis. The
  // namespace and restoration table belong to this read, including awaits.
  const occupiedNames = new Set(
    [...source.matchAll(/\ue000PASTEMATH(\d+):/g)].map((match) => match[1]),
  );
  let namespace = 0;
  while (occupiedNames.has(String(namespace))) namespace++;
  const marker = "\ue000PASTEMATH" + namespace + ":";
  const formulas = analyzeMath(source).math;
  let prepared = "",
    last = 0;
  for (let index = 0; index < formulas.length; index++) {
    const range = formulas[index];
    prepared += source.slice(last, range.from) + marker + index + "\ue001";
    last = range.to;
  }
  prepared += source.slice(last);
  const tokens = markdown.lexer(prepared) as AnyToken[];
  const blocks: Block[] = [];
  for (const token of tokens) {
    if (token.type === "html") {
      blocks.push(...(await readHtml(String(token.text ?? ""))));
      continue;
    }
    blocks.push(...blockFromToken(token));
  }
  const pattern = new RegExp(marker + "(\\d+)\\ue001", "g");
  const restoreInline = (nodes: Inline[]): Inline[] =>
    nodes.flatMap((node): Inline[] => {
      if ("children" in node) return [{ ...node, children: restoreInline(node.children) }];
      if (node.kind !== "text") return [node];
      const restored: Inline[] = [];
      let start = 0;
      for (const match of node.value.matchAll(pattern)) {
        if (match.index > start)
          restored.push({ kind: "text", value: node.value.slice(start, match.index) });
        const range = formulas[Number(match[1])];
        restored.push({ kind: "math", tex: range.body, display: range.display });
        start = match.index + match[0].length;
      }
      if (start < node.value.length)
        restored.push({ kind: "text", value: node.value.slice(start) });
      return restored;
    });
  const restoreBlocks = (items: Block[]): Block[] =>
    items.map((block): Block => {
      if (block.kind === "paragraph" || block.kind === "heading") {
        const children = restoreInline(block.children);
        if (
          block.kind === "paragraph" &&
          children.length === 1 &&
          children[0].kind === "math" &&
          children[0].display
        )
          return { kind: "math", tex: children[0].tex };
        return { ...block, children };
      }
      if (block.kind === "quote") return { ...block, blocks: restoreBlocks(block.blocks) };
      if (block.kind === "list")
        return {
          ...block,
          items: block.items.map((item) => ({ ...item, blocks: restoreBlocks(item.blocks) })),
        };
      if (block.kind === "table")
        return {
          ...block,
          header: block.header?.map(restoreInline) ?? null,
          rows: block.rows.map((row) => row.map(restoreInline)),
        };
      return block;
    });
  return trimBlocks(restoreBlocks(blocks));
}
