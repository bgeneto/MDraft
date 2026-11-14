//! The Explorer: the workspace folder as a lazy tree in the sidebar (Track W
//! of docs/architecture.md, GAP-006 slice 1).
//!
//! Read-only. Each folder is listed one level at a time through
//! `workspace_list`, only when it is expanded, so a large tree costs nothing
//! until it is opened. The tree follows the WAI-ARIA tree pattern: one tab
//! stop, arrows move and expand, Enter opens, Home/End jump, and typing a
//! letter moves to the next name that starts with it.

import * as api from "./api";

export interface ExplorerHandlers {
  /** Open a document in a tab (or activate its tab). */
  openFile: (path: string) => void;
  /** Hand a non-document entry to the operating system. */
  openExternal: (path: string) => void;
  chooseFolder: () => void;
  closeFolder: () => void;
  setShowAll: (on: boolean) => void;
  /** Main-document rule 2: the folder's explicit main LaTeX document, or null to clear it. */
  setMainDocument: (path: string | null) => void;
  /** Show the entry in the system file manager. */
  reveal: (path: string) => void;
}

let rowMenu: HTMLDivElement | null = null;
let rowMenuCleanup: (() => void) | null = null;

function closeRowMenu(focus?: HTMLElement): void {
  rowMenuCleanup?.();
  rowMenuCleanup = null;
  rowMenu?.remove();
  rowMenu = null;
  focus?.focus({ preventScroll: true });
}

/**
 * The row menu: the same markup and keyboard model as the Favorites menu
 * (ContextMenu or Shift+F10 opens it; arrows move; Enter acts; Escape closes).
 */
export function openRowMenu(
  entries: Array<[string, () => void]>,
  x: number,
  y: number,
  trigger: HTMLElement,
): void {
  closeRowMenu();
  const menu = document.createElement("div");
  menu.className = "favorite-menu explorer-menu";
  menu.role = "menu";
  menu.tabIndex = -1;
  for (const [label, action] of entries) {
    const button = document.createElement("button");
    button.className = "favorite-menu-item";
    button.type = "button";
    button.role = "menuitem";
    button.tabIndex = -1;
    button.textContent = label;
    button.addEventListener("click", () => {
      closeRowMenu(trigger);
      action();
    });
    menu.append(button);
  }
  document.body.append(menu);
  const bounds = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(Math.max(6, x), window.innerWidth - bounds.width - 6)}px`;
  menu.style.top = `${Math.min(Math.max(6, y), window.innerHeight - bounds.height - 6)}px`;
  rowMenu = menu;
  const items = [...menu.querySelectorAll<HTMLButtonElement>("button")];
  items[0]?.focus();
  const onKey = (event: KeyboardEvent): void => {
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "Escape") closeRowMenu(trigger);
    else if (event.key === "ArrowDown") items[(index + 1) % items.length]?.focus();
    else if (event.key === "ArrowUp") items[(index - 1 + items.length) % items.length]?.focus();
    else return;
    event.preventDefault();
  };
  const onPointer = (event: MouseEvent): void => {
    if (!(event.target instanceof Node) || !menu.contains(event.target)) closeRowMenu();
  };
  document.addEventListener("keydown", onKey, true);
  document.addEventListener("mousedown", onPointer, true);
  rowMenuCleanup = () => {
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("mousedown", onPointer, true);
  };
}

interface Row {
  relative: string;
  name: string;
  kind: api.WorkspaceEntry["kind"];
  symlink: boolean;
  depth: number;
}

/** Folders the reader expanded, per workspace root, for this session. */
const expandedByRoot = new Map<string, Set<string>>();
/** Listings already read, so redraws do not re-read the disk. */
const listingCache = new Map<string, api.WorkspaceListing>();

function joinRelative(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

function absolute(root: string, relative: string): string {
  const separator = root.includes("\\") ? "\\" : "/";
  return relative ? `${root}${separator}${relative.split("/").join(separator)}` : root;
}

function keyOf(root: string, relative: string, showAll: boolean): string {
  return `${root}\u0000${relative}\u0000${showAll}`;
}

/** Forget cached listings, so the next draw reads the disk (focus, save, Refresh). */
export function invalidateExplorer(): void {
  listingCache.clear();
}

async function listing(
  root: string,
  relative: string,
  showAll: boolean,
): Promise<api.WorkspaceListing> {
  const key = keyOf(root, relative, showAll);
  const cached = listingCache.get(key);
  if (cached) return cached;
  const fresh = await api.workspaceList(root, relative, showAll);
  listingCache.set(key, fresh);
  return fresh;
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

let drawGeneration = 0;

/**
 * Draw the Explorer into `container`.
 *
 * `root` is the workspace folder or null; `activePath` is the document on
 * screen, highlighted (and its folders expanded) when it lies inside the root.
 */
export async function renderExplorer(
  container: HTMLElement,
  root: string | null,
  options: {
    showAll: boolean;
    activePath: string | null;
    pathKey: (path: string) => string;
    /** The folder's explicit main LaTeX document, if the reader set one. */
    mainDocument: string | null;
  },
  handlers: ExplorerHandlers,
): Promise<void> {
  const generation = ++drawGeneration;
  if (!root) {
    const empty = element("div", "sidebar-empty explorer-empty");
    empty.append(
      "No folder is open. ",
      Object.assign(element("button", "explorer-link", "Open Folder…"), {
        type: "button",
        onclick: handlers.chooseFolder,
      }),
      " shows a project's documents here (Ctrl+Shift+O).",
    );
    container.replaceChildren(empty);
    return;
  }
  const expanded = expandedByRoot.get(root) ?? new Set<string>();
  expandedByRoot.set(root, expanded);
  // Reveal the active document: expand the folders above it.
  const rootKey = options.pathKey(root) + "/";
  const activeKey = options.activePath ? options.pathKey(options.activePath) : null;
  if (activeKey?.startsWith(rootKey)) {
    const parts = activeKey.slice(rootKey.length).split("/");
    let walk = "";
    for (const part of parts.slice(0, -1)) {
      walk = joinRelative(walk, part);
      // The key is lower-cased on Windows; the listing's own names are used
      // when the rows are matched below, so only the expansion set needs it.
      expanded.add(walk);
    }
  }

  const rows: Row[] = [];
  let failure: string | null = null;
  const truncatedAt = new Map<string, number>();
  const walk = async (relative: string, depth: number): Promise<void> => {
    const result = await listing(root, relative, options.showAll);
    if (result.truncated) truncatedAt.set(relative, result.truncated);
    for (const entry of result.entries) {
      const path = joinRelative(relative, entry.name);
      rows.push({
        relative: path,
        name: entry.name,
        kind: entry.kind,
        symlink: entry.symlink,
        depth,
      });
      const open = [...expanded].some((value) => value.toLowerCase() === path.toLowerCase());
      if (entry.kind === "dir" && open) await walk(path, depth + 1);
    }
  };
  try {
    await walk("", 0);
  } catch (error) {
    failure = String(error);
  }
  if (generation !== drawGeneration) return;

  const header = element("div", "explorer-header");
  const title = element("span", "explorer-title", root.split(/[\\/]/).pop() ?? root);
  title.title = root;
  const showAll = element(
    "button",
    "explorer-action",
    options.showAll ? "Hide build files" : "Show all",
  );
  showAll.type = "button";
  showAll.title = options.showAll
    ? "Hide hidden entries, build folders and TeX auxiliary files"
    : "Show hidden entries, build folders and TeX auxiliary files";
  showAll.addEventListener("click", () => handlers.setShowAll(!options.showAll));
  const refresh = element("button", "explorer-action", "Refresh");
  refresh.type = "button";
  refresh.addEventListener("click", () => {
    invalidateExplorer();
    void renderExplorer(container, root, options, handlers);
  });
  const close = element("button", "explorer-action", "Close");
  close.type = "button";
  close.title = "Close Folder";
  close.addEventListener("click", handlers.closeFolder);
  header.append(title, showAll, refresh, close);
  const headerBlock = element("div", "explorer-head");
  headerBlock.append(header);
  if (options.mainDocument) {
    const main = element("div", "explorer-main");
    main.append(`Main document: ${options.mainDocument.split(/[\\/]/).pop()} `);
    const clear = Object.assign(element("button", "explorer-link", "Clear"), {
      type: "button",
      title: "Forget the main document chosen for this folder",
      onclick: () => handlers.setMainDocument(null),
    });
    main.append(clear);
    main.title = options.mainDocument;
    headerBlock.append(main);
  }

  if (failure) {
    const message = element(
      "div",
      "sidebar-empty explorer-empty",
      `The folder ${root} cannot be listed (${failure.replace(/^Error: /, "")}). It may have been moved or deleted.`,
    );
    const again = Object.assign(element("button", "explorer-link", "Choose another folder…"), {
      type: "button",
      onclick: handlers.chooseFolder,
    });
    message.append(" ", again);
    container.replaceChildren(headerBlock, message);
    return;
  }

  const tree = element("div", "explorer-tree");
  tree.setAttribute("role", "tree");
  tree.setAttribute("aria-label", `Files in ${title.textContent}`);
  const items: HTMLElement[] = [];
  for (const row of rows) {
    const item = element("div", `explorer-item explorer-${row.kind}`);
    item.setAttribute("role", "treeitem");
    item.setAttribute("aria-level", String(row.depth + 1));
    item.dataset.relative = row.relative;
    item.tabIndex = -1;
    item.style.paddingLeft = `${10 + row.depth * 14}px`;
    const isDir = row.kind === "dir";
    const open = isDir && [...expanded].some((v) => v.toLowerCase() === row.relative.toLowerCase());
    if (isDir) item.setAttribute("aria-expanded", String(open));
    const icon = element(
      "span",
      "icon",
      isDir ? (open ? "▾" : "▸") : row.symlink ? "↪" : row.kind === "document" ? "•" : "·",
    );
    icon.setAttribute("aria-hidden", "true");
    const name = element("span", "name", row.name);
    item.append(icon, name);
    const full = absolute(root, row.relative);
    item.title = row.symlink ? `${full} (symbolic link, not followed)` : full;
    if (activeKey && options.pathKey(full) === activeKey) {
      item.classList.add("active");
      item.setAttribute("aria-selected", "true");
    }
    const activate = (): void => {
      if (row.symlink) return;
      if (isDir) {
        const existing = [...expanded].find((v) => v.toLowerCase() === row.relative.toLowerCase());
        if (existing) expanded.delete(existing);
        else expanded.add(row.relative);
        void renderExplorer(container, root, options, handlers).then(() => {
          (
            container.querySelector(
              `[data-relative="${CSS.escape(row.relative)}"]`,
            ) as HTMLElement | null
          )?.focus();
        });
        return;
      }
      if (row.kind === "document") handlers.openFile(full);
      else handlers.openExternal(full);
    };
    item.addEventListener("click", activate);
    const menuFor = (): Array<[string, () => void]> => {
      const entries: Array<[string, () => void]> = [];
      if (row.symlink) return [["Show in Folder", () => handlers.reveal(full)]];
      if (!isDir) entries.push(["Open", activate]);
      if (/\.tex$/i.test(row.name))
        entries.push(["Set as Main Document", () => handlers.setMainDocument(full)]);
      entries.push(["Show in Folder", () => handlers.reveal(full)]);
      return entries;
    };
    item.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      openRowMenu(menuFor(), event.clientX, event.clientY, item);
    });
    item.addEventListener("keydown", (event) => {
      const index = items.indexOf(item);
      const move = (to: number): void => {
        const target = items[Math.max(0, Math.min(items.length - 1, to))];
        target?.focus();
      };
      if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
        const box = item.getBoundingClientRect();
        openRowMenu(menuFor(), box.left + 24, box.bottom, item);
      } else if (event.key === "Enter" || event.key === " ") activate();
      else if (event.key === "ArrowDown") move(index + 1);
      else if (event.key === "ArrowUp") move(index - 1);
      else if (event.key === "Home") move(0);
      else if (event.key === "End") move(items.length - 1);
      else if (event.key === "ArrowRight" && isDir && !open) activate();
      else if (event.key === "ArrowLeft" && isDir && open) activate();
      else if (event.key === "ArrowLeft" && row.depth > 0) {
        const parent = row.relative.slice(0, row.relative.lastIndexOf("/"));
        (
          container.querySelector(`[data-relative="${CSS.escape(parent)}"]`) as HTMLElement | null
        )?.focus();
      } else if (event.key.length === 1 && /\S/.test(event.key)) {
        // Type-ahead: the next name starting with the typed character.
        const letter = event.key.toLowerCase();
        const after = items.slice(index + 1).concat(items.slice(0, index + 1));
        after
          .find((candidate) =>
            (candidate.textContent ?? "").trim().toLowerCase().startsWith(letter),
          )
          ?.focus();
      } else return;
      event.preventDefault();
    });
    items.push(item);
    tree.append(item);
    const more = truncatedAt.get(row.relative);
    if (isDir && open && more) {
      tree.append(element("div", "explorer-more", `${more} more entries not listed`));
    }
  }
  const rootMore = truncatedAt.get("");
  if (rootMore) tree.append(element("div", "explorer-more", `${rootMore} more entries not listed`));
  // One tab stop: the active row, or the first.
  const stop = items.find((item) => item.classList.contains("active")) ?? items[0];
  if (stop) stop.tabIndex = 0;
  if (rows.length === 0) {
    container.replaceChildren(
      header,
      element(
        "div",
        "sidebar-empty",
        options.showAll ? "This folder is empty." : "No documents here. Show all lists every file.",
      ),
    );
    return;
  }
  container.replaceChildren(headerBlock, tree);
  container.querySelector(".explorer-item.active")?.scrollIntoView({ block: "nearest" });
}
