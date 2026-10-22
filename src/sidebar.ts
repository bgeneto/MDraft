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
// Favorites
// ---------------------------------------------------------------------------

interface FavoriteHandlers {
  onOpenFile: (path: string) => void;
  onRemove: (path: string) => void;
}

let favoritesMenu: HTMLDivElement | null = null;
let favoritesMenuTrigger: HTMLElement | null = null;
let favoritesMenuCleanup: (() => void) | null = null;

function closeFavoritesMenu(restoreFocus = false): void {
  const menu = favoritesMenu;
  if (!menu) return;
  favoritesMenuCleanup?.();
  favoritesMenuCleanup = null;
  favoritesMenu = null;
  menu.remove();
  if (restoreFocus) favoritesMenuTrigger?.focus({ preventScroll: true });
  favoritesMenuTrigger = null;
}

/**
 * The row menu for one favorite: Open, or remove exactly that entry.
 *
 * Favorites have no bulk action, so this menu never grows a Clear All. It is
 * separate from the tab menu because it acts on a path, not a session, and the
 * sidebar must keep working while every tab is closed.
 */
function openFavoritesMenu(
  file: string,
  x: number,
  y: number,
  trigger: HTMLElement,
  handlers: FavoriteHandlers,
): void {
  closeFavoritesMenu();

  const menu = document.createElement("div");
  menu.className = "favorite-menu";
  menu.role = "menu";
  menu.tabIndex = -1;

  const entries: Array<[string, string, () => void]> = [
    ["open", "Open", () => handlers.onOpenFile(file)],
    ["remove", "Remove from Favorites", () => handlers.onRemove(file)],
  ];
  for (const [id, label, action] of entries) {
    const button = element("button", "favorite-menu-item", label);
    button.type = "button";
    button.role = "menuitem";
    button.tabIndex = -1;
    button.dataset.action = id;
    button.addEventListener("click", () => {
      closeFavoritesMenu();
      action();
    });
    menu.appendChild(button);
  }

  document.body.appendChild(menu);
  const bounds = menu.getBoundingClientRect();
  const margin = 6;
  const left = Math.min(
    Math.max(margin, x),
    Math.max(margin, window.innerWidth - bounds.width - margin),
  );
  const top = Math.min(
    Math.max(margin, y),
    Math.max(margin, window.innerHeight - bounds.height - margin),
  );
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;

  favoritesMenu = menu;
  favoritesMenuTrigger = trigger;

  const onPointer = (event: MouseEvent): void => {
    if (event.target instanceof Node && menu.contains(event.target)) return;
    closeFavoritesMenu();
  };
  const onEscape = (event: KeyboardEvent): void => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    closeFavoritesMenu(true);
  };
  const onKey = (event: KeyboardEvent): void => {
    const items = Array.from(menu.querySelectorAll<HTMLButtonElement>(".favorite-menu-item"));
    if (items.length === 0) return;
    const current = document.activeElement;
    let index = current instanceof HTMLButtonElement ? items.indexOf(current) : -1;

    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        index = index < 0 ? 0 : (index + 1) % items.length;
        break;
      case "ArrowUp":
        event.preventDefault();
        index = index < 0 ? items.length - 1 : (index - 1 + items.length) % items.length;
        break;
      case "Home":
        event.preventDefault();
        index = 0;
        break;
      case "End":
        event.preventDefault();
        index = items.length - 1;
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        (items[index] ?? items[0]).click();
        return;
      case "Tab":
        // Returning to the row is less surprising than leaving focus on a menu
        // that has just disappeared.
        event.preventDefault();
        closeFavoritesMenu(true);
        return;
      default:
        return;
    }
    items[index]?.focus({ preventScroll: true });
  };
  const onDismiss = (): void => closeFavoritesMenu();

  document.addEventListener("mousedown", onPointer, true);
  document.addEventListener("keydown", onEscape, true);
  menu.addEventListener("keydown", onKey);
  // Scrolling the list would leave the menu pointing at a row that has moved.
  window.addEventListener("scroll", onDismiss, true);
  window.addEventListener("blur", onDismiss);
  window.addEventListener("resize", onDismiss);

  favoritesMenuCleanup = () => {
    document.removeEventListener("mousedown", onPointer, true);
    document.removeEventListener("keydown", onEscape, true);
    menu.removeEventListener("keydown", onKey);
    window.removeEventListener("scroll", onDismiss, true);
    window.removeEventListener("blur", onDismiss);
    window.removeEventListener("resize", onDismiss);
  };

  menu.querySelector<HTMLButtonElement>(".favorite-menu-item")?.focus({ preventScroll: true });
}

/**
 * The Favorites list: one row per saved path, in the order it was added.
 *
 * Rows are a wrapper with two real buttons rather than one button containing an
 * `×`, which would be invalid markup and would make only one half reachable from
 * the keyboard. Right-clicking the row opens the same two actions as a menu.
 */
export function renderFavorites(
  container: HTMLElement,
  files: string[],
  handlers: FavoriteHandlers,
): void {
  closeFavoritesMenu();
  if (files.length === 0) {
    emptyState(
      container,
      "No favorites yet. Right-click a document or its tab and choose Add to Favorites.",
    );
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const file of files) {
    const name = file.split(/[\\/]/).pop() ?? file;
    const directory = file.slice(0, Math.max(0, file.length - name.length - 1));

    const row = element("div", "entry favorite-item");
    row.title = file;

    const star = element("span", "favorite-star", "\u2605");
    star.setAttribute("aria-hidden", "true");

    const open = element("button", "favorite-open");
    open.type = "button";
    open.title = `Open ${file}`;
    open.append(element("span", "name", name), element("span", "dir", directory));

    const remove = element("button", "favorite-remove", "\u00d7");
    remove.type = "button";
    remove.title = `Remove ${name} from Favorites`;
    remove.setAttribute("aria-label", `Remove ${name} from Favorites`);

    open.addEventListener("click", () => handlers.onOpenFile(file));
    remove.addEventListener("click", () => handlers.onRemove(file));
    // The star and the row's padding are part of where a reader aims. The two
    // buttons keep their own handlers, so the keyboard path is unchanged.
    row.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest(".favorite-open") || target.closest(".favorite-remove")) return;
      handlers.onOpenFile(file);
    });
    row.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openFavoritesMenu(file, event.clientX, event.clientY, open, handlers);
    });
    // The row itself is not a tab stop; the open button is, so the keyboard
    // menu key has to be handled there.
    open.addEventListener("keydown", (event) => {
      if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
      event.preventDefault();
      const bounds = open.getBoundingClientRect();
      openFavoritesMenu(file, bounds.left + 8, bounds.bottom + 2, open, handlers);
    });

    row.append(star, open, remove);
    fragment.appendChild(row);
  }
  container.replaceChildren(fragment);
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
