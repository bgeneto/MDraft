//! Typst source into the intermediate representation.
//!
//! The parser is `codemirror-lang-typst/lezer`: synchronous, WASM-free and
//! already a dependency of the Typst editor. It recovers from errors, so a
//! pasted fragment that is not a complete document still yields a tree.
//!
//! The mapping is deliberately finite. Markup it understands becomes structure;
//! a code expression it does not understand becomes a fenced (or inline) `typst`
//! code block, so the document keeps the text instead of losing it.

import type { Align, Block, Inline, ListItem } from "./ir.ts";
import { inlineText, trimBlocks } from "./ir.ts";

type AnyNode = any;

interface Cursor {
  node: AnyNode;
  source: string;
}

function child(node: AnyNode, wanted: string): AnyNode | null {
  for (let current = node?.firstChild; current; current = current.nextSibling) {
    if (current.name === wanted) return current;
  }
  return null;
}

function childrenOf(node: AnyNode, wanted?: string): AnyNode[] {
  const out: AnyNode[] = [];
  for (let current = node?.firstChild; current; current = current.nextSibling) {
    if (!wanted || current.name === wanted) out.push(current);
  }
  return out;
}

function slice(cursor: Cursor, node: AnyNode): string {
  return cursor.source.slice(node.from, node.to);
}

function walk(node: AnyNode, visit: (current: AnyNode) => boolean | void): void {
  if (visit(node) === false) return;
  for (let current = node?.firstChild; current; current = current.nextSibling) walk(current, visit);
}

function find(node: AnyNode, wanted: string): AnyNode | null {
  let found: AnyNode | null = null;
  walk(node, (current) => {
    if (found) return false;
    if (current.name === wanted) {
      found = current;
      return false;
    }
  });
  return found;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return trimmed;
}

function commandName(cursor: Cursor, node: AnyNode): string {
  const ident = child(node, "Ident");
  return ident ? slice(cursor, ident) : "";
}

function fnArgs(node: AnyNode): AnyNode | null {
  return child(node, "Args");
}

function positionalString(cursor: Cursor, node: AnyNode, name: string): string | null {
  const args = fnArgs(node);
  if (!args) return null;
  for (const entry of childrenOf(args)) {
    if (entry.name === "Str") return unquote(slice(cursor, entry));
    if (entry.name === "Named") {
      const ident = child(entry, "Ident");
      if (ident && slice(cursor, ident) === name) {
        const str = find(entry, "Str");
        if (str) return unquote(slice(cursor, str));
      }
    }
  }
  return null;
}

function namedString(cursor: Cursor, node: AnyNode, key: string): string | null {
  const args = fnArgs(node);
  if (!args) return null;
  for (const entry of childrenOf(args, "Named")) {
    const ident = child(entry, "Ident");
    if (!ident || slice(cursor, ident) !== key) continue;
    const str = find(entry, "Str");
    if (str) return unquote(slice(cursor, str));
  }
  return null;
}

function contentBlocks(node: AnyNode): AnyNode[] {
  const args = fnArgs(node) ?? node;
  return childrenOf(args, "ContentBlock");
}

function contentBlock(cursor: Cursor, block: AnyNode): Block[] {
  const markup = child(block, "Markup");
  return markup ? blocksFrom(cursor, markup) : [];
}

function inlineFromContent(cursor: Cursor, block: AnyNode): Inline[] {
  const markup = child(block, "Markup");
  return markup ? inlinesFrom(cursor, markup) : [];
}

function inlineFromFunc(cursor: Cursor, node: AnyNode): Inline[] {
  const command = commandName(cursor, node);
  if (command === "link") {
    const href = positionalString(cursor, node, "");
    const label = contentBlocks(node)[0];
    const body = label ? inlineFromContent(cursor, label) : [];
    if (href) return [{ kind: "link", href, children: body.length ? body : [{ kind: "text", value: href }] }];
    return body;
  }
  if (command === "image") {
    const src = positionalString(cursor, node, "");
    if (!src) return [];
    return [
      {
        kind: "image",
        src,
        alt: namedString(cursor, node, "alt") ?? "",
      },
    ];
  }
  const wrappers: Record<string, "strong" | "em" | "strike" | "sup" | "sub"> = {
    strong: "strong",
    emph: "em",
    strike: "strike",
    super: "sup",
    sub: "sub",
  };
  const wrapper = wrappers[command];
  if (wrapper) {
    const content = contentBlocks(node)[0];
    if (content) return [{ kind: wrapper, children: inlineFromContent(cursor, content) }];
  }
  if (command === "raw") {
    const content = contentBlocks(node)[0];
    if (content) return [{ kind: "code", value: inlineText(inlineFromContent(cursor, content)) }];
  }
  // Unknown code is kept, visibly, rather than dropped.
  return [{ kind: "code", value: slice(cursor, node) }];
}

function inlineOne(cursor: Cursor, entry: AnyNode): Inline[] {
  const out: Inline[] = [];
  const name = entry.name;
  if (name === "Markup") {
    out.push(...inlinesFrom(cursor, entry));
  } else if (name === "Text") {
    out.push({ kind: "text", value: slice(cursor, entry) });
  } else if (name === "Space") {
    out.push({ kind: "text", value: " " });
  } else if (name === "Strong" || name === "Emph") {
    const markup = child(entry, "Markup");
    const body = markup ? inlinesFrom(cursor, markup) : [];
    out.push({ kind: name === "Strong" ? "strong" : "em", children: body });
  } else if (name === "Raw") {
    const raw = slice(cursor, entry);
    const match = /^(`+)([\s\S]*?)\1$/.exec(raw);
    out.push({ kind: "code", value: match ? match[2].trim() : raw });
  } else if (name === "Equation") {
    const tex = slice(cursor, entry).replace(/^\$+|\$+$/g, "").trim();
    out.push({ kind: "math", tex, display: false });
  } else if (name === "Linebreak") {
    out.push({ kind: "break" });
  } else if (name === "Escape") {
    out.push({ kind: "text", value: slice(cursor, entry).replace(/^\\/, "") });
  } else if (name === "Shorthand" || name === "SmartQuote") {
    out.push({ kind: "text", value: slice(cursor, entry) });
  } else if (name === "Ref") {
    out.push({ kind: "text", value: slice(cursor, entry) });
  } else if (name === "FuncCall") {
    out.push(...inlineFromFunc(cursor, entry));
  } else if (name === "Hash" || name === "Label" || name === "RefMarker") {
    // Structural punctuation or a target, not content.
  } else if (name === "LineComment") {
    // A comment is not document content.
  } else {
    const text = slice(cursor, entry);
    if (text.trim()) out.push({ kind: "text", value: text });
  }
  return out;
}

function inlinesFrom(cursor: Cursor, node: AnyNode): Inline[] {
  const out: Inline[] = [];
  for (const entry of childrenOf(node)) out.push(...inlineOne(cursor, entry));
  return trimInline(out);
}

function trimInline(nodes: Inline[]): Inline[] {
  const out: Inline[] = [];
  for (const node of nodes) {
    if (node.kind === "text") {
      const previous = out[out.length - 1];
      if (previous?.kind === "text") previous.value += node.value;
      else out.push({ ...node });
    } else out.push(node);
  }
  if (out[0]?.kind === "text") out[0].value = out[0].value.replace(/^\s+/, "");
  const last = out[out.length - 1];
  if (last?.kind === "text") last.value = last.value.replace(/\s+$/, "");
  return out.filter((node) => node.kind !== "text" || node.value.length > 0);
}

function tableBlock(cursor: Cursor, node: AnyNode): Block[] {
  const args = fnArgs(node);
  if (!args) return [];
  const cells: Inline[][] = [];
  let columns = 0;
  const found: { header: Inline[][] | null } = { header: null };

  const visit = (entry: AnyNode) => {
    if (entry.name === "Named") {
      const ident = child(entry, "Ident");
      if (ident && slice(cursor, ident) === "columns") {
        const int = find(entry, "Int");
        if (int) columns = Number(slice(cursor, int));
      }
      return;
    }
    if (entry.name === "ContentBlock") {
      cells.push(inlineFromContent(cursor, entry));
      return;
    }
    if (entry.name === "FuncCall" && slice(cursor, entry).startsWith("table.header")) {
      found.header = contentBlocks(entry).map((block) => inlineFromContent(cursor, block));
      return;
    }
    for (const childNode of childrenOf(entry)) visit(childNode);
  };
  visit(args);

  if (columns <= 0) columns = found.header?.length ?? 0;
  if (columns <= 0) columns = 1;
  if (cells.length === 0 && !found.header) return [];
  const rows: Inline[][][] = [];
  for (let index = 0; index < cells.length; index += columns) {
    rows.push(cells.slice(index, index + columns));
  }
  const aligns: Align[] = Array.from({ length: columns }, () => null);
  return [{ kind: "table", align: aligns, header: found.header, rows }];
}

function figureBlock(cursor: Cursor, node: AnyNode): Block[] {
  const args = fnArgs(node);
  if (!args) return [];
  const out: Block[] = [];
  walk(args, (entry) => {
    if (entry.name === "FuncCall" && commandName(cursor, entry) === "image") {
      const image = inlineFromFunc(cursor, entry);
      if (image.length) out.push({ kind: "paragraph", children: image });
      return false;
    }
    const ident = entry.name === "Named" ? child(entry, "Ident") : null;
    if (ident && slice(cursor, ident) === "caption") {
      const content = find(entry, "ContentBlock");
      if (content) out.push(...contentBlock(cursor, content));
      return false;
    }
    return undefined;
  });
  return out;
}

function quoteBlock(cursor: Cursor, node: AnyNode): Block[] {
  const content = contentBlocks(node)[0];
  if (!content) return [];
  const blocks = contentBlock(cursor, content);
  return blocks.length ? [{ kind: "quote", blocks }] : [];
}

function blockFunc(cursor: Cursor, node: AnyNode): Block[] | null {
  const command = commandName(cursor, node);
  if (command === "table") return tableBlock(cursor, node);
  if (command === "figure") return figureBlock(cursor, node);
  if (command === "quote") return quoteBlock(cursor, node);
  if (command === "image" || command === "link") {
    return [{ kind: "paragraph", children: inlineFromFunc(cursor, node) }];
  }
  return null;
}

function listItem(cursor: Cursor, node: AnyNode): ListItem {
  const markup = child(node, "Markup");
  const blocks: Block[] = markup ? blocksFrom(cursor, markup) : [];
  return { blocks };
}

function isBlockCode(node: AnyNode): boolean {
  return [
    "SetRule",
    "ShowRule",
    "LetBinding",
    "ModuleImport",
    "ModuleInclude",
    "CodeBlock",
    "Contextual",
    "Conditional",
    "ForLoop",
    "WhileLoop",
    "LoopBreak",
    "LoopContinue",
    "FuncReturn",
    "Destructuring",
    "DestructAssignment",
  ].includes(node.name);
}

function rawBlock(cursor: Cursor, node: AnyNode): Block | null {
  const raw = slice(cursor, node);
  const match = /^(`{3,}|~{3,})\s*([\w+-]*)\n?([\s\S]*?)\n?\1\s*$/.exec(raw);
  if (!match) return null;
  return { kind: "code", language: match[2] || null, text: match[3].replace(/\n$/, "") };
}

function equationBlock(cursor: Cursor, node: AnyNode): Block | null {
  const raw = slice(cursor, node);
  const display = /^\$\s/.test(raw) || raw.includes("\n");
  const tex = raw.replace(/^\$+|\$+$/g, "").trim();
  if (!tex) return null;
  return display ? { kind: "math", tex } : null;
}

function blocksFrom(cursor: Cursor, container: AnyNode): Block[] {
  const blocks: Block[] = [];
  let inline: Inline[] = [];
  let list: { ordered: boolean; items: ListItem[] } | null = null;

  const flushInline = () => {
    const body = trimInline(inline);
    inline = [];
    if (body.length > 0) blocks.push({ kind: "paragraph", children: body });
  };
  const flushList = () => {
    if (list && list.items.length > 0) {
      blocks.push({ kind: "list", ordered: list.ordered, items: list.items });
    }
    list = null;
  };
  const flushAll = () => {
    flushInline();
    flushList();
  };

  for (const entry of childrenOf(container)) {
    const name = entry.name;
    if (name === "Markup") {
      flushAll();
      blocks.push(...blocksFrom(cursor, entry));
      continue;
    }
    if (name === "Parbreak") {
      flushInline();
      continue;
    }
    if (name === "ListItem" || name === "EnumItem") {
      flushInline();
      const ordered = name === "EnumItem";
      if (!list || list.ordered !== ordered) {
        flushList();
        list = { ordered, items: [] };
      }
      list.items.push(listItem(cursor, entry));
      continue;
    }
    // Whitespace between list items is structural; it must not close the list.
    if ((name === "Space" || name === "Text") && slice(cursor, entry).trim() === "" && list && inline.length === 0) {
      continue;
    }
    flushList();

    if (name === "Heading") {
      flushInline();
      const marker = child(entry, "HeadingMarker");
      const level = marker ? Math.min(6, Math.max(1, slice(cursor, marker).length)) : 1;
      const markup = child(entry, "Markup");
      const body = markup ? inlinesFrom(cursor, markup) : [];
      if (body.length) blocks.push({ kind: "heading", level, children: body });
      continue;
    }
    if (name === "Raw") {
      const block = rawBlock(cursor, entry);
      if (block) {
        flushInline();
        blocks.push(block);
      } else {
        inline.push(...inlineOne(cursor, entry));
      }
      continue;
    }
    if (name === "Equation") {
      const block = equationBlock(cursor, entry);
      if (block) {
        flushInline();
        blocks.push(block);
      } else {
        inline.push(...inlineOne(cursor, entry));
      }
      continue;
    }
    if (name === "FuncCall") {
      const block = blockFunc(cursor, entry);
      if (block) {
        flushInline();
        blocks.push(...block);
      } else {
        inline.push(...inlineFromFunc(cursor, entry));
      }
      continue;
    }
    if (name === "Hash") continue;
    if (isBlockCode(entry)) {
      flushInline();
      blocks.push({ kind: "code", language: "typst", text: slice(cursor, entry) });
      continue;
    }
    if (name === "LineComment") continue;
    if (
      name === "Text" ||
      name === "Space" ||
      name === "Strong" ||
      name === "Emph" ||
      name === "Linebreak" ||
      name === "Escape" ||
      name === "Ref" ||
      name === "Label" ||
      name === "Shorthand" ||
      name === "SmartQuote"
    ) {
      inline.push(...inlineOne(cursor, entry));
      continue;
    }
    // Unknown block-ish node: keep its source visible.
    const text = slice(cursor, entry);
    if (text.trim()) inline.push({ kind: "text", value: text });
  }
  flushAll();
  return trimBlocks(blocks);
}

export async function readTypst(source: string): Promise<Block[]> {
  const { typstParser } = await import("codemirror-lang-typst/lezer");
  const tree = typstParser.parse(source);
  const cursor: Cursor = { node: tree.topNode, source };
  return blocksFrom(cursor, tree.topNode);
}
