//! Sidebar panels: outline, directory listing and recent files.

import * as api from "./api";
import { extractHeadings } from "./markdown";
import type { Heading } from "./markdown";

// Single implementation of heading scanning, shared with the `[TOC]` renderer.
export { extractHeadings };
export type { Heading };

/**
 * The headings in a Typst document.
 *
 * Typst marks a heading with `=`, one per level, exactly where Markdown uses `#` —
 * the two languages made the opposite choice. Without this, the outline of a Typst
 * document would insist the document had no headings at all.
 *
 * Only the marker form is scanned. `#heading[...]` is the same thing spelled out,
 * but it can span lines and carry nested brackets; reading it properly needs the
 * parser the editor already has, and the marker form is what people write.
 */
export function extractTypstHeadings(source: string): Heading[] {
  const headings: Heading[] = [];
  const lines = source.split("\n");
  let insideBlock = false;
  let marker = "";

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    // Raw blocks are fenced with ``` here too, and a `= ` inside one is a chord
    // symbol in someone's document, not a heading.
    const fence = /^\s{0,3}(`{3,})/.exec(line);
    if (!insideBlock && fence) {
      insideBlock = true;
      marker = fence[1];
      continue;
    }
    if (insideBlock) {
      if (line.trimStart().startsWith(marker)) insideBlock = false;
      continue;
    }

    const match = /^\s{0,3}(={1,6})\s+(\S.*?)\s*$/.exec(line);
    if (!match) continue;
    // Inline markup is stripped so the outline reads as text.
    const text = match[2].replace(/\\(.)/g, "$1").replace(/[*_`]/g, "").trim();
    if (text) headings.push({ level: match[1].length, text, line: i + 1 });
  }

  return headings;
}

/**
 * The headings in an AsciiDoc document.
 *
 * `=` is the document title, `==` the first section. Only the marker form is
 * scanned, and every delimited block is skipped so a `= ` in a listing, table
 * or example is not a heading. The inline markup is stripped for the outline.
 */
export function extractAsciidocHeadings(source: string): Heading[] {
  const headings: Heading[] = [];
  const lines = source.split("\n");
  const delimiter = /^\s{0,3}(-{4,}|\.{4,}|\+{4,}|\/{4,}|={4,}|\*{4,}|_{4,}|\|={3,}|--)\s*$/;
  let block: string | null = null;

  const clean = (raw: string): string =>
    raw
      .replace(/\\(.)/g, "$1")
      .replace(/\[\.line-through\]#([^#]*)#/g, "$1")
      .replace(/(?:https?:\/\/|www\.)\S+\[([^\]]*)\]/g, "$1")
      .replace(/image::?[^[]*\[([^\]]*)\]/g, "$1")
      .replace(/latexmath:\[[^\]]*\]|stem:\[[^\]]*\]/g, "")
      .replace(/[*_`]/g, "")
      .replace(/\s+/g, " ")
      .trim();

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();
    if (block) {
      if (trimmed === block) block = null;
      continue;
    }
    const open = delimiter.exec(line);
    if (open) {
      block = open[1];
      continue;
    }
    if (/^\s{0,3}\/\//.test(line) || /^\s{0,3}:[A-Za-z0-9_-]+:/.test(line)) continue;
    const match = /^\s{0,3}(={1,6})\s+(\S.*?)\s*$/.exec(line);
    if (!match) continue;
    const text = clean(match[2]);
    if (text) headings.push({ level: match[1].length, text, line: i + 1 });
  }

  return headings;
}

/**
 * The headings in an HTML document.
 *
 * A source scan, not a DOM parse: the outline follows what the reader typed,
 * exactly like the Markdown and Typst outlines. Raw-text elements and comments
 * are blanked first so an `<h2>` inside a `<script>` string is not a heading,
 * and the blanking preserves newlines so line numbers stay exact.
 */
export function extractHtmlHeadings(source: string): Heading[] {
  const masked = source
    .replace(/<(script|style|textarea|title|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, (block) =>
      block.replace(/[^\n]/g, " "),
    )
    .replace(/<!--[\s\S]*?-->/g, (comment) => comment.replace(/[^\n]/g, " "));

  const headings: Heading[] = [];
  const pattern = /<(h[1-6])\b[^>]*>([\s\S]*?)<\/\1\s*>/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(masked)) !== null) {
    const text = decodeBasicEntities(match[2].replace(/<[^>]*>/g, " "))
      .replace(/\s+/g, " ")
      .trim();
    if (!text) continue;
    const line = masked.slice(0, match.index).split("\n").length;
    headings.push({ level: Number(match[1][1]), text, line });
  }
  return headings;
}

function decodeBasicEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, decimal: string) => String.fromCodePoint(Number(decimal)));
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function emptyState(container: HTMLElement, message: string): void {
  container.replaceChildren(element("div", "sidebar-empty", message));
}

// ---------------------------------------------------------------------------
// Outline
// ---------------------------------------------------------------------------

function activeHeadingIndex(headings: Heading[], activeLine: number): number {
  let activeIndex = -1;
  for (let i = 0; i < headings.length; i++) {
    if (headings[i].line <= activeLine) activeIndex = i;
  }
  return activeIndex;
}

export function renderOutline(
  container: HTMLElement,
  headings: Heading[],
  activeLine: number,
  onPick: (line: number) => void,
  language: api.DocumentLanguage = "markdown",
): void {
  if (headings.length === 0) {
    const message =
      language === "typst"
        ? "No headings yet. Start a line with = to build an outline."
        : language === "html"
          ? "No headings yet. Add an <h1>–<h6> element to build an outline."
          : language === "asciidoc"
            ? "No headings yet. Start a line with == to build an outline."
            : "No headings yet. Start a line with # to build an outline.";
    emptyState(container, message);
    return;
  }

  const activeIndex = activeHeadingIndex(headings, activeLine);

  const fragment = document.createDocumentFragment();
  headings.forEach((heading, index) => {
    const button = element("button", "outline-item", heading.text);
    button.type = "button";
    button.style.paddingLeft = `${10 + (heading.level - 1) * 12}px`;
    button.style.fontSize = `${Math.max(11.5, 13.5 - (heading.level - 1) * 0.5)}px`;
    if (index === activeIndex) button.classList.add("active");
    button.addEventListener("click", () => onPick(heading.line));
    fragment.appendChild(button);
  });
  container.replaceChildren(fragment);
}

/**
 * Move the active outline marker without rebuilding the list.
 *
 * Rebuilding hundreds of buttons on every arrow key is the expensive part of
 * the outline, not finding the headings. A stale list (different length) is left
 * alone: the debounced refresh is about to replace it, and guessing which item
 * moved would highlight the wrong heading.
 */
export function highlightOutline(
  container: HTMLElement,
  headings: Heading[],
  activeLine: number,
): void {
  const items = container.querySelectorAll<HTMLElement>(".outline-item");
  if (items.length !== headings.length) return;
  const activeIndex = activeHeadingIndex(headings, activeLine);
  items.forEach((item, index) => {
    item.classList.toggle("active", index === activeIndex);
  });
}

// ---------------------------------------------------------------------------
// Directory listing
// ---------------------------------------------------------------------------

const DIRECTORY_STACK: string[] = [];

export function currentDirectory(): string | null {
  return DIRECTORY_STACK.length > 0 ? DIRECTORY_STACK[DIRECTORY_STACK.length - 1] : null;
}

export async function showDirectory(
  container: HTMLElement,
  path: string,
  handlers: {
    onOpenFile: (path: string) => void;
    onError: (message: string) => void;
    showHidden?: () => boolean;
  },
): Promise<void> {
  if (DIRECTORY_STACK[DIRECTORY_STACK.length - 1] !== path) {
    DIRECTORY_STACK.push(path);
  }
  await paintDirectory(container, handlers);
}

async function paintDirectory(
  container: HTMLElement,
  handlers: {
    onOpenFile: (path: string) => void;
    onError: (message: string) => void;
    showHidden?: () => boolean;
  },
): Promise<void> {
  const path = currentDirectory();
  if (!path) {
    emptyState(container, "Open a file to browse its folder, or use File › Open.");
    return;
  }

  let entries: api.DirEntry[];
  try {
    entries = await api.listDirectory(path, handlers.showHidden?.() ?? false);
  } catch (error) {
    emptyState(container, String(error));
    return;
  }

  const fragment = document.createDocumentFragment();

  const header = element("div", "sidebar-path");
  if (DIRECTORY_STACK.length > 1) {
    const up = element("button", undefined, "↑");
    up.type = "button";
    up.title = "Parent folder";
    up.addEventListener("click", () => {
      DIRECTORY_STACK.pop();
      void paintDirectory(container, handlers);
    });
    header.appendChild(up);
  }
  header.appendChild(element("span", undefined, path));
  fragment.appendChild(header);

  // Documents this editor can open. A format missing from this list is a
  // document the Files panel cannot reach at all — `typ` was, until a test asked
  // for a Typst file and the listing did not offer one.
  const markdownish = (entry: api.DirEntry) =>
    [
      "md",
      "markdown",
      "mdown",
      "mkd",
      "txt",
      "text",
      "html",
      "htm",
      "typ",
      "adoc",
      "asciidoc",
      "json",
      "yml",
      "yaml",
      "toml",
      "",
    ].includes(entry.ext);

  for (const entry of entries) {
    if (!entry.isDir && !markdownish(entry)) continue;

    const row = element("button", `entry${entry.isDir ? " dir" : ""}`);
    row.type = "button";
    row.title = entry.path;

    const icon = element("span", "icon", entry.isDir ? "▸" : "·");
    const label = element("span", "label", entry.name);
    row.append(icon, label);

    row.addEventListener("click", () => {
      if (entry.isDir) {
        DIRECTORY_STACK.push(entry.path);
        void paintDirectory(container, handlers);
      } else {
        handlers.onOpenFile(entry.path);
      }
    });
    fragment.appendChild(row);
  }

  if (fragment.childElementCount <= 1) {
    fragment.appendChild(element("div", "sidebar-empty", "Nothing to show here."));
  }
  container.replaceChildren(fragment);
}

export function resetDirectory(path: string | null): void {
  DIRECTORY_STACK.length = 0;
  if (path) DIRECTORY_STACK.push(path);
}

// ---------------------------------------------------------------------------
// Recent files
// ---------------------------------------------------------------------------

export function renderRecent(
  container: HTMLElement,
  files: string[],
  handlers: {
    onOpenFile: (path: string) => void;
    onClear: () => void;
    onError: (message: string) => void;
  },
): void {
  if (files.length === 0) {
    emptyState(container, "No recent files yet.");
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const file of files) {
    const name = file.split(/[\\/]/).pop() ?? file;
    const directory = file.slice(0, Math.max(0, file.length - name.length - 1));

    const row = element("button", "entry recent-item");
    row.type = "button";
    row.title = file;
    row.append(element("span", "name", name), element("span", "dir", directory));
    row.addEventListener("click", () => handlers.onOpenFile(file));
    fragment.appendChild(row);
  }

  const footer = element("div", "sidebar-footer");
  const clear = element("button", undefined, "Clear recent files");
  clear.type = "button";
  clear.addEventListener("click", handlers.onClear);
  footer.appendChild(clear);
  fragment.appendChild(footer);

  container.replaceChildren(fragment);
}
