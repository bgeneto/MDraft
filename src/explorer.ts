//! The Explorer: the workspace folder as a lazy tree in the sidebar (Track W
//! of docs/architecture.md, GAP-006 slice 1).
//!
//! Read-only. Each folder is listed one level at a time through
//! `workspace_list`, only when it is expanded, so a large tree costs nothing
//! until it is opened. The tree follows the WAI-ARIA tree pattern: one tab
//! stop, arrows move and expand, Enter opens, Home/End jump, and typing moves
//! to the next name that starts with the typed letters.
//!
//! The filter box above the tree finds a file anywhere in the folder. Its first
//! use reads a bounded name index (`workspace_index`); while it holds a query
//! the tree shows the matches with their folders open, best match focused.

import * as api from "./api";
import { prepare, rank, type Prepared } from "./fuzzy";

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
  /** Whether a folder row is shown open. */
  open: boolean;
  /** Indices into `name` to highlight (filter mode). */
  marks?: number[];
}

/** Folders the reader expanded, per workspace root, for this session. */
const expandedByRoot = new Map<string, Set<string>>();
/** Listings already read, so redraws do not re-read the disk. */
const listingCache = new Map<string, api.WorkspaceListing>();

/** The filter text per workspace root, for this session only. */
const queryByRoot = new Map<string, string>();
/**
 * Folders the reader toggled while the current query is shown: a toggle flips
 * the filter's default (open when it holds a match, closed otherwise). Reset
 * whenever the query changes, so a new search starts from its own default.
 */
const filterToggled = new Set<string>();

interface PreparedIndex {
  index: api.WorkspaceIndex;
  prepared: Prepared[];
}
/** Name indexes, built on first use of the filter, dropped with the listings. */
const indexCache = new Map<string, Promise<PreparedIndex>>();

/** At most this many matches are drawn; the rest are counted. */
const FILTER_LIMIT = 300;
/** Delay between the last keystroke and the redraw, so typing stays fluid. */
const FILTER_DELAY_MS = 60;
/** Type-ahead letters typed within this window form one prefix. */
const TYPEAHEAD_MS = 600;

function joinRelative(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

function parentOf(relative: string): string {
  const slash = relative.lastIndexOf("/");
  return slash < 0 ? "" : relative.slice(0, slash);
}

function absolute(root: string, relative: string): string {
  const separator = root.includes("\\") ? "\\" : "/";
  return relative ? `${root}${separator}${relative.split("/").join(separator)}` : root;
}

function keyOf(root: string, relative: string, showAll: boolean): string {
  return `${root}\u0000${relative}\u0000${showAll}`;
}

/** Forget cached listings and name indexes, so the next draw reads the disk. */
export function invalidateExplorer(): void {
  listingCache.clear();
  indexCache.clear();
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

function nameIndex(root: string, showAll: boolean): Promise<PreparedIndex> {
  const key = keyOf(root, "", showAll);
  let pending = indexCache.get(key);
  if (!pending) {
    pending = api.workspaceIndex(root, showAll).then((index) => ({
      index,
      prepared: index.entries.map((entry) => prepare(entry.path)),
    }));
    // A failed walk is not cached: the next keystroke tries again.
    pending.catch(() => indexCache.delete(key));
    indexCache.set(key, pending);
  }
  return pending;
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

/**
 * Monochrome concentric-dot mark for the folder's main LaTeX document.
 * Replaces the regular `•` bullet so the compilation root stands out without
 * colliding with the Favorites star or implying top-of-list pinning.
 */
function mainDocumentIcon(): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.classList.add("explorer-main-icon");
  const ring = document.createElementNS(ns, "circle");
  ring.setAttribute("cx", "8");
  ring.setAttribute("cy", "8");
  ring.setAttribute("r", "5.25");
  ring.setAttribute("fill", "none");
  ring.setAttribute("stroke", "currentColor");
  ring.setAttribute("stroke-width", "1.6");
  const core = document.createElementNS(ns, "circle");
  core.setAttribute("cx", "8");
  core.setAttribute("cy", "8");
  core.setAttribute("r", "2.2");
  core.setAttribute("fill", "currentColor");
  svg.append(ring, core);
  return svg;
}

/** `name` as text nodes with the characters at `marks` wrapped in `<mark>`. */
function highlighted(name: string, marks: number[] | undefined): Node[] {
  if (!marks?.length) return [document.createTextNode(name)];
  const nodes: Node[] = [];
  const set = new Set(marks);
  let run = "";
  let marked = false;
  const flush = (): void => {
    if (!run) return;
    nodes.push(marked ? element("mark", undefined, run) : document.createTextNode(run));
    run = "";
  };
  for (let i = 0; i < name.length; i += 1) {
    const on = set.has(i);
    if (on !== marked) {
      flush();
      marked = on;
    }
    run += name[i];
  }
  flush();
  return nodes;
}

interface FilterResult {
  rows: Row[];
  /** The best-ranked match, focused and opened by Enter. */
  best: string | null;
  matches: number;
  truncatedIndex: boolean;
}

/**
 * The filtered tree: the best matches (up to `FILTER_LIMIT`), their folders,
 * and the contents of any folder the reader opened, in tree order.
 */
function filterRows(prepared: PreparedIndex, query: string): FilterResult {
  const { entries } = prepared.index;
  const ranked = rank(
    entries.map((_, order) => order),
    (order) => prepared.prepared[order],
    query,
  );
  const kept = ranked.slice(0, FILTER_LIMIT);
  // Highlights per path, including the parts of a match that fall in a folder.
  const marks = new Map<string, number[]>();
  const holdsMatch = new Set<string>();
  const visible = new Set<string>();
  for (const hit of kept) {
    const path = entries[hit.item].path;
    visible.add(path);
    let start = 0;
    for (const segment of path.split("/")) {
      const end = start + segment.length;
      const own = hit.positions.filter((p) => p >= start && p < end).map((p) => p - start);
      const at = path.slice(0, end);
      if (own.length) marks.set(at, [...new Set([...(marks.get(at) ?? []), ...own])]);
      start = end + 1;
    }
    for (let parent = parentOf(path); parent; parent = parentOf(parent)) {
      visible.add(parent);
      holdsMatch.add(parent);
    }
  }
  const isOpen = (path: string): boolean => holdsMatch.has(path) !== filterToggled.has(path);
  const children = new Map<string, api.WorkspaceIndexEntry[]>();
  for (const entry of entries) {
    const parent = parentOf(entry.path);
    const list = children.get(parent) ?? [];
    list.push(entry);
    children.set(parent, list);
  }
  const rows: Row[] = [];
  const walk = (parent: string, depth: number, showEvery: boolean): void => {
    for (const entry of children.get(parent) ?? []) {
      if (!showEvery && !visible.has(entry.path)) continue;
      const open = entry.kind === "dir" && !entry.symlink && isOpen(entry.path);
      rows.push({
        relative: entry.path,
        name: entry.path.slice(entry.path.lastIndexOf("/") + 1),
        kind: entry.kind,
        symlink: entry.symlink,
        depth,
        open,
        marks: marks.get(entry.path),
      });
      // A folder opened because it holds matches shows only the matches; one
      // the reader opened by hand shows everything in it.
      if (open) walk(entry.path, depth + 1, showEvery || !holdsMatch.has(entry.path));
    }
  };
  walk("", 0, false);
  return {
    rows,
    best: kept.length ? entries[kept[0].item].path : null,
    matches: ranked.length,
    truncatedIndex: prepared.index.truncated,
  };
}

let drawGeneration = 0;
let filterTimer: ReturnType<typeof setTimeout> | undefined;
let typeahead = { text: "", at: 0 };

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
  const redraw = (): Promise<void> => renderExplorer(container, root, options, handlers);
  const expanded = expandedByRoot.get(root) ?? new Set<string>();
  expandedByRoot.set(root, expanded);
  const isExpanded = (path: string): boolean =>
    [...expanded].some((value) => value.toLowerCase() === path.toLowerCase());
  // Reveal the active document: expand the folders above it.
  const rootKey = options.pathKey(root) + "/";
  const activeKey = options.activePath ? options.pathKey(options.activePath) : null;
  const mainKey = options.mainDocument ? options.pathKey(options.mainDocument) : null;
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

  const query = queryByRoot.get(root) ?? "";
  const filtering = query.trim() !== "";
  let rows: Row[] = [];
  let failure: string | null = null;
  let filter: FilterResult | null = null;
  const truncatedAt = new Map<string, number>();
  const walk = async (relative: string, depth: number): Promise<void> => {
    const result = await listing(root, relative, options.showAll);
    if (result.truncated) truncatedAt.set(relative, result.truncated);
    for (const entry of result.entries) {
      const path = joinRelative(relative, entry.name);
      const open = entry.kind === "dir" && isExpanded(path);
      rows.push({
        relative: path,
        name: entry.name,
        kind: entry.kind,
        symlink: entry.symlink,
        depth,
        open,
      });
      if (open) await walk(path, depth + 1);
    }
  };
  try {
    if (filtering) {
      filter = filterRows(await nameIndex(root, options.showAll), query);
      rows = filter.rows;
    } else await walk("", 0);
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
    void redraw();
  });
  const close = element("button", "explorer-action", "Close");
  close.type = "button";
  close.title = "Close Folder";
  close.addEventListener("click", handlers.closeFolder);
  header.append(title, showAll, refresh, close);
  const headerBlock = element("div", "explorer-head");
  headerBlock.append(header);
  if (options.mainDocument) {
    const mainPath = options.mainDocument;
    const mainName = mainPath.split(/[\\/]/).pop() ?? mainPath;
    const main = element("div", "explorer-main");
    const label = element("span", "explorer-main-label", "Main document: ");
    const openMain = Object.assign(element("button", "explorer-main-file", mainName), {
      type: "button",
      title: `Open ${mainPath}`,
      onclick: () => handlers.openFile(mainPath),
    });
    const clear = Object.assign(element("button", "explorer-link", "Clear"), {
      type: "button",
      title: "Forget the main document chosen for this folder",
      onclick: () => handlers.setMainDocument(null),
    });
    main.append(mainDocumentIcon(), label, openMain, " ", clear);
    main.title = mainPath;
    headerBlock.append(main);
  }

  if (failure && !filtering) {
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

  // The filter box. Every draw replaces it, so focus and caret are carried over.
  const previousField = container.querySelector<HTMLInputElement>(".explorer-filter");
  const hadFocus = previousField !== null && document.activeElement === previousField;
  const caret = hadFocus ? [previousField.selectionStart, previousField.selectionEnd] : null;
  const field = element("input", "explorer-filter");
  field.type = "search";
  field.value = query;
  field.placeholder = "Filter files (/)";
  field.spellcheck = false;
  field.autocomplete = "off";
  field.setAttribute("role", "searchbox");
  field.setAttribute("aria-label", "Filter files by name");
  field.setAttribute("aria-controls", "explorer-tree");
  // The same live region is moved into each draw: a screen reader announces a
  // change to a region it already knows, not a freshly inserted one.
  const status =
    container.querySelector<HTMLDivElement>(".explorer-status") ??
    element("div", "explorer-status");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  headerBlock.append(field, status);

  const setQuery = (value: string): void => {
    if (value === "") queryByRoot.delete(root);
    else queryByRoot.set(root, value);
    filterToggled.clear();
  };

  const tree = element("div", "explorer-tree");
  tree.id = "explorer-tree";
  tree.setAttribute("role", "tree");
  tree.setAttribute("aria-label", `Files in ${title.textContent}`);
  const items: HTMLElement[] = [];
  const focusRow = (relative: string): void => {
    (
      container.querySelector(`[data-relative="${CSS.escape(relative)}"]`) as HTMLElement | null
    )?.focus();
  };
  for (const row of rows) {
    const item = element("div", `explorer-item explorer-${row.kind}`);
    item.setAttribute("role", "treeitem");
    item.setAttribute("aria-level", String(row.depth + 1));
    item.dataset.relative = row.relative;
    item.tabIndex = -1;
    item.style.paddingLeft = `${10 + row.depth * 14}px`;
    const isDir = row.kind === "dir";
    const open = row.open;
    if (isDir) item.setAttribute("aria-expanded", String(open));
    const full = absolute(root, row.relative);
    const isMain = !isDir && !row.symlink && mainKey !== null && options.pathKey(full) === mainKey;
    const icon = element(
      "span",
      "icon",
      isMain
        ? undefined
        : isDir
          ? open
            ? "▾"
            : "▸"
          : row.symlink
            ? "↪"
            : row.kind === "document"
              ? "•"
              : "·",
    );
    if (isMain) icon.append(mainDocumentIcon());
    icon.setAttribute("aria-hidden", "true");
    const name = element("span", "name");
    name.append(...highlighted(row.name, row.marks));
    item.append(icon, name);
    item.title = row.symlink
      ? `${full} (symbolic link, not followed)`
      : isMain
        ? `${full} (Main document)`
        : full;
    if (isMain) {
      item.classList.add("main-document");
      item.setAttribute("aria-label", `${row.name} (Main document)`);
    }
    if (activeKey && options.pathKey(full) === activeKey) {
      item.classList.add("active");
      item.setAttribute("aria-selected", "true");
    }
    if (filter?.best === row.relative) item.classList.add("best");
    const activate = (): void => {
      if (row.symlink) return;
      if (isDir) {
        if (filtering) {
          if (filterToggled.has(row.relative)) filterToggled.delete(row.relative);
          else filterToggled.add(row.relative);
        } else {
          const existing = [...expanded].find(
            (v) => v.toLowerCase() === row.relative.toLowerCase(),
          );
          if (existing) expanded.delete(existing);
          else expanded.add(row.relative);
        }
        void redraw().then(() => focusRow(row.relative));
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
      if (isMain) {
        entries.push(["Clear Main Document", () => handlers.setMainDocument(null)]);
      } else if (/\.tex$/i.test(row.name)) {
        entries.push(["Set as Main Document", () => handlers.setMainDocument(full)]);
      }
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
      const now = Date.now();
      const typing = typeahead.text !== "" && now - typeahead.at <= TYPEAHEAD_MS;
      const plain = !event.ctrlKey && !event.metaKey && !event.altKey;
      if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
        const box = item.getBoundingClientRect();
        openRowMenu(menuFor(), box.left + 24, box.bottom, item);
      } else if (event.key === "Enter" || (event.key === " " && !typing)) activate();
      else if (event.key === "ArrowDown") move(index + 1);
      else if (event.key === "ArrowUp" && index === 0) field.focus();
      else if (event.key === "ArrowUp") move(index - 1);
      else if (event.key === "Home") move(0);
      else if (event.key === "End") move(items.length - 1);
      else if (event.key === "ArrowRight" && isDir && !open) activate();
      else if (event.key === "ArrowLeft" && isDir && open) activate();
      else if (event.key === "ArrowLeft" && row.depth > 0) focusRow(parentOf(row.relative));
      else if (
        (event.key === "/" && plain && !typing) ||
        (event.key.toLowerCase() === "f" && (event.ctrlKey || event.metaKey) && !event.altKey)
      ) {
        field.focus();
        field.select();
      } else if (event.key === "Escape" && filtering) {
        setQuery("");
        void redraw().then(() => focusRow(row.relative));
      } else if (event.key.length === 1 && plain && (/\S/.test(event.key) || typing)) {
        // Type-ahead (WAI-ARIA): letters typed in quick succession form one
        // prefix; one letter pressed again moves on to the next name with it.
        typeahead = { text: (typing ? typeahead.text : "") + event.key.toLowerCase(), at: now };
        const repeated = [...typeahead.text].every((c) => c === typeahead.text[0]);
        const prefix = repeated ? typeahead.text[0] : typeahead.text;
        // A growing prefix may still fit the focused row; a repeat moves on.
        const from = repeated ? index + 1 : index;
        items
          .slice(from)
          .concat(items.slice(0, from))
          .find((candidate) =>
            (candidate.querySelector(".name")?.textContent ?? "").toLowerCase().startsWith(prefix),
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
  // One tab stop: the best match while filtering, else the active row, else the first.
  const stop =
    items.find((item) => item.classList.contains("best")) ??
    items.find((item) => item.classList.contains("active")) ??
    items[0];
  if (stop) stop.tabIndex = 0;

  field.addEventListener("input", (event) => {
    // An IME composition ends with its own input event; draw only then.
    if ((event as InputEvent).isComposing) return;
    setQuery(field.value);
    clearTimeout(filterTimer);
    filterTimer = setTimeout(() => void redraw(), FILTER_DELAY_MS);
  });
  field.addEventListener("keydown", (event) => {
    if (event.isComposing) return;
    if (event.key === "ArrowDown") {
      stop?.focus();
    } else if (event.key === "Enter") {
      // Draw a keystroke still waiting for its redraw, so Enter acts on what
      // was typed rather than on the previous query's results.
      clearTimeout(filterTimer);
      const pending = (queryByRoot.get(root) ?? "") !== query;
      void (pending ? redraw() : Promise.resolve()).then(() => {
        const best = container.querySelector<HTMLElement>(".explorer-item.best");
        if (best && !best.hasAttribute("aria-expanded")) best.click();
        else best?.focus();
      });
    } else if (event.key === "Escape") {
      if (field.value === "") {
        stop?.focus();
      } else {
        field.value = "";
        setQuery("");
        clearTimeout(filterTimer);
        void redraw();
      }
    } else return;
    event.preventDefault();
    event.stopPropagation();
  });

  if (filtering && filter) {
    const shown = Math.min(filter.matches, FILTER_LIMIT);
    status.textContent =
      filter.matches === 0
        ? ""
        : filter.matches === 1
          ? "1 match"
          : filter.matches > shown
            ? `Best ${shown} of ${filter.matches} matches`
            : `${filter.matches} matches`;
    if (filter.truncatedIndex) {
      status.textContent += " · this folder is too large to search completely";
    }
  } else if (filtering && failure) {
    status.textContent = `Cannot search this folder (${failure.replace(/^Error: /, "")}).`;
  } else status.textContent = "";
  status.hidden = status.textContent === "";

  const restoreField = (): void => {
    if (!hadFocus) return;
    field.focus({ preventScroll: true });
    if (caret) field.setSelectionRange(caret[0], caret[1]);
  };
  if (rows.length === 0) {
    const hint = filtering
      ? failure
        ? ""
        : `No file name matches “${query.trim()}”.${options.showAll ? "" : " Show all also searches hidden and build files."}`
      : options.showAll
        ? "This folder is empty."
        : "No documents here. Show all lists every file.";
    container.replaceChildren(headerBlock, element("div", "sidebar-empty", hint));
    restoreField();
    return;
  }
  container.replaceChildren(headerBlock, tree);
  restoreField();
  container
    .querySelector(filtering ? ".explorer-item.best" : ".explorer-item.active")
    ?.scrollIntoView({ block: "nearest" });
}
