//! Clipboard HTML into the intermediate representation.
//!
//! `parse5` is loaded lazily: the paste core is small, and the browser preview
//! already pays for the same parser when an HTML document is opened. The tree is
//! inert — nothing here creates a DOM or executes markup.

import type { Align, Block, Inline, ListItem } from "./ir.ts";
import { trimBlocks } from "./ir.ts";
import { analyzeMath } from "../math-delimiters.ts";

type AnyNode = any;

const BLOCK_NAMES = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "center",
  "details",
  "dialog",
  "dir",
  "div",
  "dl",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hgroup",
  "hr",
  "li",
  "main",
  "menu",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "summary",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "ul",
]);

const DROP_NAMES = new Set([
  "script",
  "style",
  "meta",
  "link",
  "base",
  "title",
  "template",
  "noscript",
  "iframe",
  "object",
  "embed",
  "canvas",
  "svg",
]);

interface Context {
  base: string | null;
  mathNodes: WeakMap<object, Inline[]>;
}

function name(node: AnyNode): string {
  return typeof node?.nodeName === "string" ? node.nodeName.toLowerCase() : "";
}

function children(node: AnyNode): AnyNode[] {
  return Array.isArray(node?.childNodes) ? node.childNodes : [];
}

function attr(node: AnyNode, key: string): string | null {
  for (const entry of node?.attrs ?? []) {
    if (entry.name.toLowerCase() === key) return entry.value;
  }
  return null;
}

function hasAttr(node: AnyNode, key: string): boolean {
  return attr(node, key) !== null;
}

function descend(node: AnyNode, wanted: string): AnyNode | null {
  for (const child of children(node)) {
    if (name(child) === wanted) return child;
    const found = descend(child, wanted);
    if (found) return found;
  }
  return null;
}

function textContent(node: AnyNode): string {
  if (name(node) === "#text") return String(node.value ?? "");
  let out = "";
  for (const child of children(node)) out += textContent(child);
  return out;
}

function hidden(node: AnyNode): boolean {
  if (hasAttr(node, "hidden")) return true;
  const style = (attr(node, "style") ?? "").toLowerCase();
  return /display\s*:\s*none/.test(style) || /visibility\s*:\s*hidden/.test(style);
}

function cleanText(value: string): string {
  return value.replace(/[ \t\r\n\f]+/g, " ");
}

/** Preserve formatting while classifying currency across neighboring spans. */
function decodedMathNodes(nodes: AnyNode[]): WeakMap<object, Inline[]> {
  const map = new WeakMap<object, Inline[]>();
  let run: { node: AnyNode; value: string; from: number }[] = [];
  let length = 0;
  const flush = () => {
    if (!run.length) return;
    const formulas = analyzeMath(run.map((part) => part.value).join(""), false).math;
    let formula = 0;
    for (const part of run) {
      const out: Inline[] = [];
      let start = 0;
      while (formula < formulas.length && formulas[formula].to <= part.from) formula++;
      for (
        let index = formula;
        index < formulas.length && formulas[index].from < part.from + part.value.length;
        index++
      ) {
        const range = formulas[index];
        if (range.from < part.from || range.to > part.from + part.value.length) continue;
        const from = range.from - part.from,
          to = range.to - part.from;
        if (from > start) out.push({ kind: "text", value: part.value.slice(start, from) });
        out.push({ kind: "math", tex: range.body, display: range.display });
        start = to;
      }
      if (start < part.value.length) out.push({ kind: "text", value: part.value.slice(start) });
      map.set(part.node, out);
    }
    run = [];
    length = 0;
  };
  const visit = (node: AnyNode) => {
    const tag = name(node);
    if (tag === "#text") {
      const value = cleanText(String(node.value ?? ""));
      run.push({ node, value, from: length });
      length += value.length;
      return;
    }
    if (tag === "#comment") return;
    if (
      DROP_NAMES.has(tag) ||
      hidden(node) ||
      /^(?:code|kbd|samp|tt|math|mjx-container|br|img)$/.test(tag) ||
      /katex/.test(attr(node, "class") ?? "")
    ) {
      flush();
      return;
    }
    const block = BLOCK_NAMES.has(tag);
    if (block) flush();
    for (const child of children(node)) visit(child);
    if (block) flush();
  };
  nodes.forEach(visit);
  flush();
  return map;
}

/**
 * Merge adjacent text nodes and collapse the whitespace runs a merge can
 * create. Whitespace at the edges is kept: between inline elements it is
 * significant (`como <strong>x</strong> a` must not become `como**x**a`).
 */
function joinText(nodes: Inline[]): Inline[] {
  const out: Inline[] = [];
  for (const node of nodes) {
    if (node.kind !== "text") {
      out.push(node);
      continue;
    }
    if (!node.value) continue;
    const previous = out[out.length - 1];
    if (previous?.kind === "text") {
      previous.value = `${previous.value}${node.value}`.replace(/[ \t\r\n\f]+/g, " ");
    } else {
      out.push({ ...node });
    }
  }
  return out;
}

/**
 * Drop the whitespace at the start of an inline flow, descending into wrappers:
 * `<p> <strong> Hello</strong>` loses the space before `Hello`, which is the
 * <p>'s edge and not the <strong>'s.
 */
function trimStart(nodes: Inline[]): Inline[] {
  const out: Inline[] = [];
  let trimming = true;
  for (const node of nodes) {
    if (!trimming) {
      out.push(node);
      continue;
    }
    if (node.kind === "text") {
      const value = node.value.replace(/^\s+/, "");
      if (value === "") continue;
      out.push({ ...node, value });
      trimming = false;
      continue;
    }
    if ("children" in node) {
      const children = trimStart(node.children);
      if (children.length === 0) continue;
      out.push({ ...node, children });
      trimming = false;
      continue;
    }
    // A break at the flow's edge breaks nothing; its renderer's `\` would be a
    // stray line of its own in the pasted Markdown.
    if (node.kind === "break") continue;
    // code, image and math are visible atoms.
    out.push(node);
    trimming = false;
  }
  return out;
}

/** The mirror of `trimStart`: the whitespace at the end of a flow. */
function trimEnd(nodes: Inline[]): Inline[] {
  const out: Inline[] = [];
  let trimming = true;
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const node = nodes[index];
    if (!trimming) {
      out.push(node);
      continue;
    }
    if (node.kind === "text") {
      const value = node.value.replace(/\s+$/, "");
      if (value === "") continue;
      out.push({ ...node, value });
      trimming = false;
      continue;
    }
    if ("children" in node) {
      const children = trimEnd(node.children);
      if (children.length === 0) continue;
      out.push({ ...node, children });
      trimming = false;
      continue;
    }
    if (node.kind === "break") continue;
    out.push(node);
    trimming = false;
  }
  return out.reverse();
}

/**
 * The inline flow of a block: adjacent text merged, the block's outer edges
 * trimmed through wrappers. Only the block's edges, never an element's own —
 * trimming inside every wrapper is what swallowed the spaces around bold text
 * and links copied from a rendered page.
 */
function trimFlow(nodes: Inline[]): Inline[] {
  return trimEnd(trimStart(joinText(nodes)));
}

/**
 * Split a flow at runs of two or more hard breaks. A CMS writes its visual
 * paragraph breaks as `<br><br>` inside one `<p>` — the UnB news article does
 * exactly that. Keeping both breaks would render as a `\` at the end of every
 * paragraph plus another alone on the blank line, so the run is the boundary
 * between two blocks instead. A single `<br>` stays a hard break.
 */
function splitParagraphs(nodes: Inline[]): Inline[][] {
  const paragraphs: Inline[][] = [];
  let flow: Inline[] = [];
  let breaks = 0;
  const flushBreaks = () => {
    if (breaks >= 2) {
      paragraphs.push(flow);
      flow = [];
    } else if (breaks === 1) {
      flow.push({ kind: "break" });
    }
    breaks = 0;
  };
  for (const node of nodes) {
    if (node.kind === "break") {
      breaks += 1;
      continue;
    }
    // Whitespace between two `<br>` tags must not stop them being one run; at
    // the start of a line HTML collapses it away anyway.
    if (breaks > 0 && node.kind === "text" && node.value.trim() === "") continue;
    flushBreaks();
    flow.push(node);
  }
  flushBreaks();
  paragraphs.push(flow);
  return paragraphs;
}

/** The paragraph blocks of a converted inline flow, blank lines included. */
function paragraphBlocks(nodes: Inline[]): Block[] {
  const out: Block[] = [];
  for (const flow of splitParagraphs(nodes)) {
    const body = trimFlow(flow);
    if (hasVisible(body)) out.push({ kind: "paragraph", children: body });
  }
  return out;
}

function hasVisible(nodes: Inline[]): boolean {
  return nodes.some((node) => node.kind !== "text" || node.value.trim() !== "");
}

function wrap(kind: "strong" | "em" | "strike" | "sup" | "sub", nodes: Inline[]): Inline[] {
  const body = joinText(nodes);
  // Whitespace-only emphasis has no emphasis, but its space still separates the
  // words around it.
  return hasVisible(body) ? [{ kind, children: body }] : body;
}

function styleFlags(node: AnyNode): {
  strong: boolean;
  em: boolean;
  strike: boolean;
  sup: boolean;
  sub: boolean;
} {
  const style = (attr(node, "style") ?? "").toLowerCase();
  return {
    strong: /font-weight\s*:\s*(?:bold|bolder|[6-9]\d{2})/.test(style),
    em: /font-style\s*:\s*(?:italic|oblique)/.test(style),
    strike: /text-decoration[^;]*line-through/.test(style),
    sup: /vertical-align\s*:\s*super/.test(style),
    sub: /vertical-align\s*:\s*sub/.test(style),
  };
}

function safeHref(value: string | null): string | null {
  if (!value) return null;
  const href = value.trim();
  if (!href) return null;
  if (/^(?:javascript|vbscript|data):/i.test(href)) return null;
  if (/^(?:https?:|mailto:|tel:|#|\/|\.\/|\.\.\/|[a-z0-9_-]+\/)/i.test(href)) return href;
  return href;
}

function annotateMath(node: AnyNode): { tex: string | null; display: boolean } {
  const annotation = descend(node, "annotation");
  const encoding = annotation ? (attr(annotation, "encoding") ?? "") : "";
  const tex = annotation && /x-tex|tex/i.test(encoding) ? textContent(annotation).trim() : null;
  const display =
    /katex-display/.test(attr(node, "class") ?? "") ||
    (name(node.parentNode) === "span" &&
      /katex-display/.test(attr(node.parentNode, "class") ?? "")) ||
    /display/.test(attr(node, "mode") ?? "");
  return { tex, display };
}

function mathInline(node: AnyNode): Inline[] {
  const { tex, display } = annotateMath(node);
  if (tex) return [{ kind: "math", tex, display }];
  if (name(node) === "script") {
    const body = textContent(node).trim();
    return body
      ? [{ kind: "math", tex: body, display: /display/.test(attr(node, "mode") ?? "") }]
      : [];
  }
  const text = textContent(node).trim();
  return text ? [{ kind: "text", value: text }] : [];
}

function largestSrcset(value: string | null): string | null {
  if (!value) return null;
  let best: { url: string; width: number } | null = null;
  for (const part of value.split(",")) {
    const [url, descriptor] = part.trim().split(/\s+/);
    if (!url) continue;
    const width = descriptor?.endsWith("w") ? Number.parseFloat(descriptor) : 0;
    if (!best || width > best.width) best = { url, width };
  }
  return best?.url ?? null;
}

function imageNode(node: AnyNode, ctx: Context): Inline[] {
  const raw =
    attr(node, "src") ??
    attr(node, "data-src") ??
    attr(node, "data-original") ??
    largestSrcset(attr(node, "srcset"));
  if (!raw || /^cid:/i.test(raw)) return [];
  if (/^data:/i.test(raw) && raw.length > 4_000_000) return [];
  const width = Number.parseFloat(attr(node, "width") ?? "");
  const height = Number.parseFloat(attr(node, "height") ?? "");
  if (
    (Number.isFinite(width) && width > 0 && width <= 2) ||
    (Number.isFinite(height) && height > 0 && height <= 2)
  ) {
    return [];
  }
  let src = raw.trim();
  if (ctx.base && !/^[a-z][a-z0-9+.-]*:/i.test(src) && !src.startsWith("//")) {
    try {
      src = new URL(src, ctx.base).href;
    } catch {
      /* keep the original reference */
    }
  }
  return [
    {
      kind: "image",
      src,
      alt: attr(node, "alt") ?? "",
      title: attr(node, "title") ?? undefined,
      width: Number.isFinite(width) && width > 0 ? width : undefined,
      height: Number.isFinite(height) && height > 0 ? height : undefined,
    },
  ];
}

function convertInline(node: AnyNode, ctx: Context): Inline[] {
  const tag = name(node);
  if (tag === "#text") {
    const value = cleanText(String(node.value ?? ""));
    return ctx.mathNodes.get(node) ?? (value ? [{ kind: "text", value }] : []);
  }
  if (tag === "#comment") return [];
  if (DROP_NAMES.has(tag) || hidden(node)) return [];
  if (tag === "br") return [{ kind: "break" }];
  if (tag === "img") return imageNode(node, ctx);
  if (
    tag === "math" ||
    tag === "mjx-container" ||
    (tag === "span" && /katex/.test(attr(node, "class") ?? ""))
  ) {
    return mathInline(node);
  }
  if (tag === "script") {
    const type = (attr(node, "type") ?? "").toLowerCase();
    if (/math\/tex/.test(type)) return mathInline(node);
    return [];
  }
  if (tag === "code" || tag === "kbd" || tag === "samp" || tag === "tt") {
    const value = textContent(node).replace(/\u00a0/g, " ");
    return value ? [{ kind: "code", value }] : [];
  }
  if (tag === "img") return imageNode(node, ctx);

  const kids = joinText(children(node).flatMap((child) => convertInline(child, ctx)));
  const flags = styleFlags(node);
  if (tag === "a") {
    const href = safeHref(attr(node, "href"));
    if (href && hasVisible(kids)) {
      return [{ kind: "link", href, title: attr(node, "title") ?? undefined, children: kids }];
    }
    return kids;
  }
  // Google Docs wraps the whole fragment in a bold element whose own style is
  // normal; treating it as bold would embolden the entire paste.
  const docsWrapper =
    /^(b|strong)$/.test(tag) && /^docs-internal-guid/.test(attr(node, "id") ?? "");
  if (docsWrapper) return kids;
  if (tag === "strong" || tag === "b" || flags.strong) return wrap("strong", kids);
  if (tag === "em" || tag === "i" || flags.em) return wrap("em", kids);
  if (tag === "s" || tag === "strike" || tag === "del" || flags.strike) return wrap("strike", kids);
  if (tag === "sup" || flags.sup) return wrap("sup", kids);
  if (tag === "sub" || flags.sub) return wrap("sub", kids);
  return kids;
}

function inlineFrom(node: AnyNode, ctx: Context): Inline[] {
  const tag = name(node);
  if (BLOCK_NAMES.has(tag)) return [];
  // No edge trim here: this node is one piece of the block's inline flow, and
  // the space between it and its sibling text belongs to that flow.
  return joinText(convertInline(node, ctx));
}

function codeLanguage(pre: AnyNode): string | null {
  const candidates = [pre, descend(pre, "code")].filter(Boolean);
  for (const node of candidates) {
    const cls = attr(node as AnyNode, "class") ?? "";
    const match = /(?:language|lang)-([\w+#.-]+)/i.exec(cls);
    if (match) return match[1];
  }
  return null;
}

function alignOf(node: AnyNode): Align {
  const direct = (attr(node, "align") ?? "").toLowerCase();
  if (direct === "left" || direct === "center" || direct === "right") return direct;
  const match = /text-align\s*:\s*(left|center|right)/i.exec(attr(node, "style") ?? "");
  if (match) return match[1].toLowerCase() as Align;
  return null;
}

function tableBlock(node: AnyNode, ctx: Context): Block[] {
  const rows: AnyNode[] = [];
  const collect = (current: AnyNode) => {
    if (name(current) === "tr") rows.push(current);
    else for (const child of children(current)) collect(child);
  };
  collect(node);
  if (rows.length === 0) return [];

  const headerCells = children(rows[0]).filter((cell) => name(cell) === "th");
  const hasHeader = headerCells.length > 0;
  const aligns: Align[] = [];
  const converted: Inline[][][] = [];
  const pendingRowspan: Array<{ column: number; remaining: number }> = [];

  rows.forEach((row, rowIndex) => {
    const cells = children(row).filter((cell) => name(cell) === "td" || name(cell) === "th");
    const line: Inline[][] = [];
    for (const span of pendingRowspan) {
      if (span.remaining > 0 && span.column === line.length) {
        line.push([]);
        span.remaining -= 1;
      }
    }
    for (const cell of cells) {
      const body = trimFlow(children(cell).flatMap((child) => convertInline(child, ctx)));
      const align = alignOf(cell);
      const column = line.length;
      if (aligns[column] === undefined) aligns[column] = align;
      const colspan = Math.max(
        1,
        Math.min(20, Number.parseInt(attr(cell, "colspan") ?? "1", 10) || 1),
      );
      line.push(body);
      for (let extra = 1; extra < colspan; extra += 1) line.push([]);
      const rowspan = Math.max(
        1,
        Math.min(20, Number.parseInt(attr(cell, "rowspan") ?? "1", 10) || 1),
      );
      if (rowspan > 1) pendingRowspan.push({ column, remaining: rowspan - 1 });
    }
    if (rowIndex > 0 || hasHeader) converted.push(line);
    else converted.push(line);
  });

  if (converted.length === 0) return [];
  const header = hasHeader ? converted[0] : null;
  const body = hasHeader ? converted.slice(1) : converted;
  if (header)
    header.forEach((_cell, index) => {
      if (aligns[index] === undefined) aligns[index] = null;
    });
  return [{ kind: "table", align: aligns, header, rows: body }];
}

function listBlock(node: AnyNode, ctx: Context): Block[] {
  const ordered = name(node) === "ol";
  const start = ordered ? Number.parseInt(attr(node, "start") ?? "1", 10) : undefined;
  const items: ListItem[] = [];
  for (const li of children(node).filter((child) => name(child) === "li")) {
    const blocks = convertBlocks(children(li), ctx);
    let task: "done" | "todo" | undefined;
    for (const input of walk(li)) {
      if (name(input) === "input" && (attr(input, "type") ?? "").toLowerCase() === "checkbox") {
        task = hasAttr(input, "checked") ? "done" : "todo";
      }
    }
    if (blocks.length === 0) {
      const inline = children(li).flatMap((child) => convertInline(child, ctx));
      blocks.push(...paragraphBlocks(inline));
    }
    items.push({ blocks, task });
  }
  return [{ kind: "list", ordered, start: Number.isFinite(start) ? start : undefined, items }];
}

function* walk(node: AnyNode): Generator<AnyNode> {
  yield node;
  for (const child of children(node)) yield* walk(child);
}

function blockNode(node: AnyNode, ctx: Context): Block[] {
  const tag = name(node);
  if (tag === "#text" || tag === "#comment") return [];
  if (DROP_NAMES.has(tag) || hidden(node)) return [];
  if (/^h[1-6]$/.test(tag)) {
    const body = trimFlow(children(node).flatMap((child) => convertInline(child, ctx)));
    return body.length > 0 ? [{ kind: "heading", level: Number(tag[1]), children: body }] : [];
  }
  if (tag === "p") {
    const body = children(node).flatMap((child) => convertInline(child, ctx));
    return paragraphBlocks(body);
  }
  if (tag === "ul" || tag === "ol") return listBlock(node, ctx);
  if (tag === "blockquote") {
    const blocks = convertBlocks(children(node), ctx);
    return blocks.length > 0 ? [{ kind: "quote", blocks }] : [];
  }
  if (tag === "pre") {
    const text = textContent(node)
      .replace(/\u00a0/g, " ")
      .replace(/^\n+|\n+$/g, "");
    return text ? [{ kind: "code", language: codeLanguage(node), text }] : [];
  }
  if (tag === "table") return tableBlock(node, ctx);
  if (tag === "hr") return [{ kind: "rule" }];
  if (tag === "figure") {
    const out = convertBlocks(children(node), ctx);
    return out;
  }
  if (tag === "dl") {
    const out: Block[] = [];
    for (const child of children(node)) {
      if (name(child) === "dt") {
        const body = trimFlow(children(child).flatMap((entry) => convertInline(entry, ctx)));
        if (body.length)
          out.push({ kind: "paragraph", children: [{ kind: "strong", children: body }] });
      } else if (name(child) === "dd") {
        out.push(...convertBlocks(children(child), ctx));
      }
    }
    return out;
  }
  if ((tag === "span" || tag === "div") && /katex-display/.test(attr(node, "class") ?? "")) {
    const { tex } = annotateMath(node);
    return tex ? [{ kind: "math", tex }] : [];
  }
  if (tag === "math" && /display/.test(attr(node, "display") ?? "")) {
    const { tex } = annotateMath(node);
    return tex ? [{ kind: "math", tex }] : [];
  }
  // A generic block wrapper: recurse so its paragraphs and lists survive.
  return convertBlocks(children(node), ctx);
}

function convertBlocks(nodes: AnyNode[], ctx: Context): Block[] {
  const out: Block[] = [];
  let inline: Inline[] = [];
  const flush = () => {
    const body = inline;
    inline = [];
    out.push(...paragraphBlocks(body));
  };
  for (const node of nodes) {
    const tag = name(node);
    if (tag === "#text" || tag === "#comment" || !BLOCK_NAMES.has(tag)) {
      inline.push(...inlineFrom(node, ctx));
      continue;
    }
    flush();
    out.push(...blockNode(node, ctx));
  }
  flush();
  return out;
}

function findBase(nodes: AnyNode[]): string | null {
  for (const node of nodes) {
    if (name(node) === "base") {
      const href = attr(node, "href");
      if (href) return href;
    }
    const found = findBase(children(node));
    if (found) return found;
  }
  return null;
}

function normalizeClipboardHtml(raw: string): string {
  const start = raw.indexOf("<!--StartFragment-->");
  const end = raw.indexOf("<!--EndFragment-->");
  if (start >= 0) {
    return raw.slice(start + "<!--StartFragment-->".length, end >= 0 ? end : undefined);
  }
  // Windows CF_HTML from some applications keeps its byte-offset header.
  if (/^Version:\d/m.test(raw) && /StartHTML:/m.test(raw)) {
    const bodyStart = raw.indexOf("<");
    if (bodyStart > 0) return raw.slice(bodyStart);
  }
  return raw;
}

export async function readHtml(raw: string): Promise<Block[]> {
  const { parse, parseFragment } = await import("parse5");
  const html = normalizeClipboardHtml(raw);
  let nodes: AnyNode[];
  let base: string | null;
  if (/^\s*(?:<!doctype\b|<html\b|<head\b|<body\b)/i.test(html)) {
    const doc = parse(html) as AnyNode;
    const htmlElement = children(doc).find((node) => name(node) === "html");
    const body = htmlElement ? children(htmlElement).find((node) => name(node) === "body") : null;
    nodes = children(body ?? htmlElement ?? doc);
    base = findBase(children(htmlElement ?? doc));
  } else {
    const fragment = parseFragment(html) as AnyNode;
    nodes = children(fragment);
    base = findBase(nodes);
  }
  if (!base) {
    try {
      // A browser normally writes absolute URLs; a relative one without a base
      // cannot be resolved and is kept as-is.
      base = null;
    } catch {
      base = null;
    }
  }
  return trimBlocks(convertBlocks(nodes, { base, mathNodes: decodedMathNodes(nodes) }));
}

/** Inline HTML from a Markdown token, parsed with the same rules. */
export async function readHtmlInline(raw: string): Promise<Inline[]> {
  const { parseFragment } = await import("parse5");
  const fragment = parseFragment(raw) as AnyNode;
  const base = findBase(children(fragment));
  const nodes = children(fragment);
  const ctx = { base, mathNodes: decodedMathNodes(nodes) };
  return joinText(nodes.flatMap((child) => convertInline(child, ctx)));
}

/** Plain text extraction for the last-resort fallback. */
export function htmlToText(raw: string): string {
  return normalizeClipboardHtml(raw)
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|li|h[1-6]|tr|blockquote)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
