//! Sidebar panels: outline, directory listing and recent files.

import * as api from "./api";
import { extractHeadings } from "./markdown";
import type { Heading } from "./markdown";

// Single implementation of heading scanning, shared with the `[TOC]` renderer.
export { extractHeadings };
export type { Heading };

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

export function renderOutline(
  container: HTMLElement,
  headings: Heading[],
  activeLine: number,
  onPick: (line: number) => void,
): void {
  if (headings.length === 0) {
    emptyState(container, "No headings yet. Start a line with # to build an outline.");
    return;
  }

  let activeIndex = -1;
  for (let i = 0; i < headings.length; i++) {
    if (headings[i].line <= activeLine) activeIndex = i;
  }

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

// ---------------------------------------------------------------------------
// Directory listing
// ---------------------------------------------------------------------------

const DIRECTORY_STACK: string[] = [];

export function currentDirectory(): string | null {
  return DIRECTORY_STACK.length > 0
    ? DIRECTORY_STACK[DIRECTORY_STACK.length - 1]
    : null;
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

  const markdownish = (entry: api.DirEntry) =>
    ["md", "markdown", "mdown", "mkd", "txt", "text", "json", "yml", "yaml", "toml", ""].includes(
      entry.ext,
    );

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
    row.append(
      element("span", "name", name),
      element("span", "dir", directory),
    );
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
