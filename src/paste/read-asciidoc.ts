//! A bounded AsciiDoc reader for the paste pipeline.
//!
//! It maps the structures the IR can express and keeps what it cannot
//! (`include::`, `ifdef::`, unknown passthroughs) as literal blocks instead of
//! dropping it. It deliberately imports neither Tauri nor Asciidoctor, so the
//! Node conversion suite can load it directly.
//!
//! This is a clipboard reader, not a renderer: it does not evaluate attributes,
//! includes or conditionals, and it reads a single level of lists and tables.

import type { Block, Inline, ListItem } from "./ir.ts";

function parseInline(text: string, stemLatex: boolean): Inline[] {
  const patterns: Array<{
    re: RegExp;
    make: (match: RegExpExecArray) => Inline;
  }> = [
    { re: /^\\(.)/, make: (m) => ({ kind: "text", value: m[1] }) },
    { re: /^`([^`\n]+)`/, make: (m) => ({ kind: "code", value: m[1] }) },
    {
      re: /^\[\.line-through\]#([^#\n]+)#/,
      make: (m) => ({ kind: "strike", children: parseInline(m[1], stemLatex) }),
    },
    {
      re: /^\*([^*\n]+)\*/,
      make: (m) => ({ kind: "strong", children: parseInline(m[1], stemLatex) }),
    },
    {
      re: /^_([^_\n]+)_/,
      make: (m) => ({ kind: "em", children: parseInline(m[1], stemLatex) }),
    },
    {
      re: /^image:([^\s\[]+)\[([^\]]*)\]/,
      make: (m) => ({ kind: "image", src: m[1], alt: m[2] }),
    },
    {
      re: /^link:([^\s\[]+)\[([^\]]*)\]/,
      make: (m) => ({
        kind: "link",
        href: m[1],
        children: parseInline(m[2], stemLatex),
      }),
    },
    {
      re: /^xref:([^\s\[]+)\[([^\]]*)\]/,
      make: (m) => ({
        kind: "link",
        href: `#${m[1]}`,
        children: parseInline(m[2], stemLatex),
      }),
    },
    {
      re: /^<<([^>,]+)(?:,([^>]*))?>>/,
      make: (m) => ({
        kind: "link",
        href: `#${m[1]}`,
        children: parseInline(m[2] ?? m[1], stemLatex),
      }),
    },
    {
      re: /^latexmath:\[([^\]]*)\]/,
      make: (m) => ({ kind: "math", tex: m[1] }),
    },
    {
      re: /^stem:\[([^\]]*)\]/,
      make: (m) => (stemLatex ? { kind: "math", tex: m[1] } : { kind: "code", value: m[0] }),
    },
    {
      re: /^((?:https?:\/\/|www\.)[^\s\[]+)\[([^\]]*)\]/,
      make: (m) => ({
        kind: "link",
        href: m[1],
        children: parseInline(m[2], stemLatex),
      }),
    },
    {
      re: /^((?:https?:\/\/|www\.)[^\s]+)/,
      make: (m) => ({
        kind: "link",
        href: m[1],
        children: [{ kind: "text", value: m[1] }],
      }),
    },
  ];

  const out: Inline[] = [];
  let buffer = "";
  let index = 0;
  const flush = () => {
    if (buffer) {
      out.push({ kind: "text", value: buffer });
      buffer = "";
    }
  };

  while (index < text.length) {
    const rest = text.slice(index);
    let matched = false;
    for (const pattern of patterns) {
      const match = pattern.re.exec(rest);
      if (!match) continue;
      flush();
      out.push(pattern.make(match));
      index += match[0].length;
      matched = true;
      break;
    }
    if (!matched) {
      buffer += text[index];
      index += 1;
    }
  }
  flush();
  return out;
}

function paragraph(text: string, stemLatex: boolean): Block {
  return { kind: "paragraph", children: parseInline(text.trim(), stemLatex) };
}

function collect(
  lines: string[],
  start: number,
  delimiter: string,
): {
  body: string[];
  next: number;
} {
  let end = start + 1;
  while (end < lines.length && lines[end].trim() !== delimiter) end += 1;
  return {
    body: lines.slice(start + 1, end),
    next: end < lines.length ? end + 1 : end,
  };
}

function parseTable(body: string[], header: boolean, stemLatex: boolean): Block | null {
  const rows = body
    .map((line) => line.trim())
    .filter((line) => line.startsWith("|"))
    .map((line) =>
      line
        .split("|")
        .slice(1)
        .map((cell) => parseInline(cell.trim(), stemLatex)),
    )
    .filter((row) => row.length > 0);
  if (rows.length === 0) return null;
  const head = header ? (rows.shift() ?? null) : null;
  const width = head?.length ?? rows[0]?.length ?? 0;
  return {
    kind: "table",
    align: Array.from({ length: width }, () => null),
    header: head,
    rows,
  };
}

/** Read AsciiDoc into the IR. */
export function readAsciidoc(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let stemLatex = false;
  let pendingLanguage: string | null = null;
  let pendingHeader = false;
  let pendingLatex = false;
  let pendingAdmonition: string | null = null;
  let index = 0;

  const resetPending = () => {
    pendingLanguage = null;
    pendingHeader = false;
    pendingLatex = false;
    pendingAdmonition = null;
  };

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }
    const trimmed = line.trim();

    if (/^\/\//.test(trimmed)) {
      index += 1;
      continue;
    }
    if (/^:[A-Za-z0-9_-]+:/.test(trimmed)) {
      const stem = /^:stem:\s*(\w+)/.exec(trimmed);
      if (stem) stemLatex = stem[1] === "latexmath";
      index += 1;
      continue;
    }
    if (trimmed === "////") {
      index = collect(lines, index, "////").next;
      continue;
    }
    if (/^\[.*\]$/.test(trimmed)) {
      const source = /^\[source(?:,([^\]]+))?\]$/.exec(trimmed);
      const stem = /^\[stem(?:,([^\]]+))?\]$/.exec(trimmed);
      if (source) pendingLanguage = source[1]?.split(",")[0].trim() || null;
      else if (trimmed === "[latexmath]") pendingLatex = true;
      else if (stem) pendingLatex = stem[1]?.trim() === "latexmath";
      else if (/options\s*=\s*"?header"?/.test(trimmed)) pendingHeader = true;
      else if (/^\[(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]$/.test(trimmed)) {
        pendingAdmonition = trimmed.slice(1, -1);
      }
      index += 1;
      continue;
    }

    if (trimmed === "----" || trimmed === "...." || trimmed === "++++") {
      const collected = collect(lines, index, trimmed);
      const body = collected.body.join("\n");
      if (trimmed === "++++" && pendingLatex) {
        blocks.push({ kind: "math", tex: body.trim() });
      } else {
        blocks.push({
          kind: "code",
          language: trimmed === "++++" ? "html" : pendingLanguage,
          text: body,
        });
      }
      resetPending();
      index = collected.next;
      continue;
    }
    if (trimmed === "____" || trimmed === "====" || trimmed === "****" || trimmed === "--") {
      const collected = collect(lines, index, trimmed);
      const inner = readAsciidoc(collected.body.join("\n"));
      if (trimmed === "____") blocks.push({ kind: "quote", blocks: inner });
      else blocks.push(...inner);
      resetPending();
      index = collected.next;
      continue;
    }
    if (trimmed === "|===") {
      const collected = collect(lines, index, "|===");
      const table = parseTable(collected.body, pendingHeader, stemLatex);
      if (table) blocks.push(table);
      resetPending();
      index = collected.next;
      continue;
    }

    const heading = /^(={1,6})\s+(.+)$/.exec(trimmed);
    if (heading) {
      blocks.push({
        kind: "heading",
        level: heading[1].length,
        children: parseInline(heading[2].trim(), stemLatex),
      });
      resetPending();
      index += 1;
      continue;
    }

    const image = /^image::([^\s\[]+)\[([^\]]*)\]$/.exec(trimmed);
    if (image) {
      blocks.push({
        kind: "paragraph",
        children: [{ kind: "image", src: image[1], alt: image[2] }],
      });
      resetPending();
      index += 1;
      continue;
    }

    const admonition = /^(NOTE|TIP|IMPORTANT|WARNING|CAUTION):\s*(.*)$/.exec(trimmed);
    if (admonition) {
      const text: string[] = [admonition[2]];
      index += 1;
      while (index < lines.length && lines[index].trim()) {
        text.push(lines[index].trim());
        index += 1;
      }
      blocks.push({
        kind: "quote",
        blocks: [
          {
            kind: "paragraph",
            children: [
              { kind: "strong", children: [{ kind: "text", value: admonition[1] }] },
              { kind: "text", value: ": " },
              ...parseInline(text.join(" "), stemLatex),
            ],
          },
        ],
      });
      resetPending();
      continue;
    }

    if (/^(?:include|ifdef|ifndef|ifeval|endif)::/.test(trimmed)) {
      blocks.push({ kind: "code", language: null, text: trimmed });
      resetPending();
      index += 1;
      continue;
    }
    if (trimmed === "'''") {
      blocks.push({ kind: "rule" });
      resetPending();
      index += 1;
      continue;
    }

    const listMatch = /^\s*(?:(\*+)|(\.+)|(\d+\.))\s+(.*)$/.exec(line);
    if (listMatch) {
      const items: ListItem[] = [];
      const ordered = Boolean(listMatch[2] || listMatch[3]);
      while (index < lines.length) {
        const item = /^\s*(?:(\*+)|(\.+)|(\d+\.))\s+(.*)$/.exec(lines[index]);
        if (!item) break;
        let text = item[4];
        let task: ListItem["task"];
        const check = /^\[([ xX])\]\s*(.*)$/.exec(text);
        if (check) {
          task = check[1].toLowerCase() === "x" ? "done" : "todo";
          text = check[2];
        }
        items.push({ blocks: [paragraph(text, stemLatex)], task });
        index += 1;
      }
      blocks.push({ kind: "list", ordered, start: ordered ? 1 : undefined, items });
      resetPending();
      continue;
    }

    // A paragraph runs until a blank line or the start of another block.
    const text: string[] = [];
    while (index < lines.length) {
      const current = lines[index];
      const value = current.trim();
      if (!value) break;
      if (
        /^={1,6}\s/.test(value) ||
        /^\[.*\]$/.test(value) ||
        value === "----" ||
        value === "...." ||
        value === "++++" ||
        value === "____" ||
        value === "====" ||
        value === "****" ||
        value === "--" ||
        value === "|===" ||
        value === "////" ||
        /^image::/.test(value) ||
        /^(?:include|ifdef|ifndef|ifeval|endif)::/.test(value) ||
        value === "'''" ||
        /^(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION):/.test(value)
      ) {
        break;
      }
      text.push(value);
      index += 1;
    }
    if (text.length === 0) {
      index += 1;
      continue;
    }
    const body = text.join(" ");
    if (pendingAdmonition) {
      blocks.push({
        kind: "quote",
        blocks: [
          {
            kind: "paragraph",
            children: [
              {
                kind: "strong",
                children: [{ kind: "text", value: pendingAdmonition }],
              },
              { kind: "text", value: ": " },
              ...parseInline(body, stemLatex),
            ],
          },
        ],
      });
    } else {
      blocks.push(paragraph(body, stemLatex));
    }
    resetPending();
  }

  return blocks;
}
