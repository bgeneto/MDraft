//! The source editor's right-click menu.
//!
//! It owns the whole editor surface, not just formatting: replacing the
//! webview's native menu with one item would also remove Cut, Copy, Paste and
//! Select All. The spelling plugin still owns a right-click on a misspelled
//! word and stops the event before it reaches this listener.
//!
//! Formatting is the only action that needs the shell's document lifecycle, so
//! it arrives as a callback. Everything else is a CodeMirror command or a
//! small selection edit, which keeps this module independent of `main.ts`.

import {
  copyLineDown,
  moveLineDown,
  moveLineUp,
  redo,
  redoDepth,
  selectAll,
  toggleComment,
  undo,
  undoDepth,
} from "@codemirror/commands";
import type { EditorView } from "@codemirror/view";
import { readClipboardData, writeClipboardText } from "./clipboard";
import type { LinkTarget } from "./links";

export interface EditorMenuOptions {
  view: EditorView;
  /** The session's read-only flag, which is not part of the editor state. */
  readOnly: () => boolean;
  /** Run the shell's formatter for the document on screen. */
  format: () => void | Promise<void>;
  /** Why Format Document cannot run, or null when it can. */
  formatBlocked: () => string | null;
  /** Why the document cannot be favorited, or null when it can. */
  favoriteBlocked: () => string | null;
  /** Whether the document is already in Favorites. */
  isFavorite: () => boolean;
  /** Add the document to Favorites, or remove it when already there. */
  favorite: () => void | Promise<void>;
  /** The link or image under a source offset, when there is one. */
  linkAt: (pos: number) => LinkTarget | null;
  /** Follow the target chosen from the menu. */
  openLink: (target: LinkTarget) => void;
  /** What Read Aloud can do for this document right now. */
  reading: () => ReadingMenuState;
  /** Start reading the document aloud, from the caret's block or from the top. */
  readAloud: (fromStart: boolean) => void | Promise<void>;
  /** Stop the reading in progress. */
  stopReading: () => void;
  toast: (text: string, ms?: number) => { dismiss: () => void };
}

/**
 * Read Aloud availability.
 *
 * `blocked` is why no reading can start at all (an HTML document, a webview with
 * no voices, an empty preview); `fromHereBlocked` is the narrower case of a
 * preview with no `data-line` blocks, such as the Typst page view, where only
 * "from the beginning" means anything.
 */
export interface ReadingMenuState {
  blocked: string | null;
  fromHereBlocked: string | null;
  active: boolean;
}

type MenuEntry = { kind: "separator" } | MenuItem;

interface MenuItem {
  kind: "item";
  id: string;
  label: string;
  shortcut?: string;
  enabled: boolean;
  title?: string;
  /** Present on the Open Link item, for the suites and for debugging. */
  href?: string;
  run: () => void | Promise<void>;
}

type MenuHost = HTMLDivElement & { cleanup?: () => void };

const IS_MAC = /Mac|iPhone|iPad/.test(navigator.userAgent);
const SELECTION_REASON = "Select some text first.";
const READ_ONLY_REASON = "This document is read-only.";
const NO_COMMENTS_REASON = "This language has no comment syntax.";

function shortcut(key: string, shift = false): string {
  return IS_MAC ? `${shift ? "\u21e7" : ""}\u2318${key}` : `Ctrl+${shift ? "Shift+" : ""}${key}`;
}

function altShortcut(key: string, shift = false): string {
  return IS_MAC ? `${shift ? "\u21e7" : ""}\u2325${key}` : `${shift ? "Shift+" : ""}Alt+${key}`;
}

/** Upper-case the first letter of each word and lower-case the rest. */
export function titleCase(text: string): string {
  return text.replace(/\p{L}[\p{L}\p{M}'\u2019-]*/gu, (word) => {
    const letters = Array.from(word);
    return letters[0].toUpperCase() + letters.slice(1).join("").toLowerCase();
  });
}

export function installEditorContextMenu(options: EditorMenuOptions): () => void {
  const { view } = options;
  let menu: MenuHost | null = null;

  const closeMenu = (restoreFocus = false): void => {
    const host = menu;
    if (!host) return;
    menu = null;
    host.cleanup?.();
    host.remove();
    if (restoreFocus) view.focus();
  };

  const place = (host: HTMLElement, x: number, y: number): void => {
    const rect = host.getBoundingClientRect();
    const left =
      x + rect.width > window.innerWidth ? Math.max(8, window.innerWidth - rect.width - 8) : x;
    const top = y + rect.height > window.innerHeight ? Math.max(8, y - rect.height) : y;
    host.style.left = `${left}px`;
    host.style.top = `${top}px`;
  };

  const transformSelection = (transform: (text: string) => string): void => {
    const selection = view.state.selection.main;
    if (selection.empty) return;
    const before = view.state.sliceDoc(selection.from, selection.to);
    const after = transform(before);
    if (after === before) {
      view.focus();
      return;
    }
    view.dispatch({
      changes: { from: selection.from, to: selection.to, insert: after },
      selection: { anchor: selection.from, head: selection.from + after.length },
      scrollIntoView: false,
      userEvent: "input.transform",
    });
    view.focus();
  };

  const copySelection = async (cut: boolean): Promise<void> => {
    const selection = view.state.selection.main;
    if (selection.empty) return;
    const before = view.state.doc;
    const text = view.state.sliceDoc(selection.from, selection.to);
    const from = selection.from;
    const to = selection.to;
    const copied = await writeClipboardText(text);
    if (!copied) {
      options.toast("Could not copy to the clipboard.", 4200);
      return;
    }
    if (!cut || view.state.doc !== before) return;
    view.dispatch({
      changes: { from, to, insert: "" },
      selection: { anchor: from },
      scrollIntoView: false,
      userEvent: "delete.cut",
    });
    view.focus();
  };

  const paste = async (): Promise<void> => {
    const data = await readClipboardData();
    if (!data) {
      options.toast("Could not read the clipboard.", 4200);
      return;
    }
    view.focus();
    // The existing paste handler owns rich conversion and image import. A
    // synthetic event with the same `clipboardData` runs that path without a
    // second implementation here.
    view.contentDOM.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData: data,
        bubbles: true,
        cancelable: true,
      }),
    );
  };

  const deleteSelection = (): void => {
    const selection = view.state.selection.main;
    if (selection.empty) return;
    view.dispatch({
      changes: { from: selection.from, to: selection.to, insert: "" },
      selection: { anchor: selection.from },
      scrollIntoView: false,
      userEvent: "delete",
    });
    view.focus();
  };

  const entries = (pos: number | null): MenuEntry[] => {
    const state = view.state;
    const editable = !options.readOnly() && !state.readOnly;
    const selection = state.selection.main;
    const hasSelection = !selection.empty;
    const hasComments = state.languageDataAt("commentTokens", selection.from, 1).length > 0;
    const formatBlocked = options.formatBlocked();
    const favoriteBlocked = options.favoriteBlocked();
    const favorite = options.isFavorite();
    const reading = options.reading();

    const selectionTitle = !editable ? READ_ONLY_REASON : SELECTION_REASON;
    const editTitle = editable ? undefined : READ_ONLY_REASON;

    const link = pos === null ? null : options.linkAt(pos);
    const linkEntry: MenuEntry[] = link
      ? [
          {
            kind: "item",
            id: "openLink",
            label:
              link.kind === "image"
                ? "Open Image"
                : link.kind === "anchor"
                  ? "Go to Heading"
                  : link.kind === "external"
                    ? "Open Link"
                    : "Open File",
            shortcut: IS_MAC ? "\u2318click" : "Ctrl+click",
            enabled: true,
            href: link.href,
            run: () => options.openLink(link),
          },
          { kind: "separator" },
        ]
      : [];

    return [
      ...linkEntry,
      {
        kind: "item",
        id: "undo",
        label: "Undo",
        shortcut: shortcut("Z"),
        enabled: editable && undoDepth(state) > 0,
        title: !editable ? READ_ONLY_REASON : undoDepth(state) > 0 ? undefined : "Nothing to undo.",
        run: () => {
          undo(view);
        },
      },
      {
        kind: "item",
        id: "redo",
        label: "Redo",
        shortcut: IS_MAC ? "\u21e7\u2318Z" : "Ctrl+Y",
        enabled: editable && redoDepth(state) > 0,
        title: !editable ? READ_ONLY_REASON : redoDepth(state) > 0 ? undefined : "Nothing to redo.",
        run: () => {
          redo(view);
        },
      },
      { kind: "separator" },
      {
        kind: "item",
        id: "cut",
        label: "Cut",
        shortcut: shortcut("X"),
        enabled: editable && hasSelection,
        title: selectionTitle,
        run: () => copySelection(true),
      },
      {
        kind: "item",
        id: "copy",
        label: "Copy",
        shortcut: shortcut("C"),
        enabled: hasSelection,
        title: hasSelection ? undefined : SELECTION_REASON,
        run: () => copySelection(false),
      },
      {
        kind: "item",
        id: "paste",
        label: "Paste",
        shortcut: shortcut("V"),
        enabled: editable,
        title: editTitle,
        run: paste,
      },
      {
        kind: "item",
        id: "delete",
        label: "Delete",
        shortcut: "Del",
        enabled: editable && hasSelection,
        title: selectionTitle,
        run: deleteSelection,
      },
      {
        kind: "item",
        id: "selectAll",
        label: "Select All",
        shortcut: shortcut("A"),
        enabled: true,
        run: () => {
          selectAll(view);
          view.focus();
        },
      },
      { kind: "separator" },
      {
        kind: "item",
        id: "uppercase",
        label: "UPPERCASE",
        enabled: editable && hasSelection,
        title: selectionTitle,
        run: () => transformSelection((text) => text.toUpperCase()),
      },
      {
        kind: "item",
        id: "lowercase",
        label: "lowercase",
        enabled: editable && hasSelection,
        title: selectionTitle,
        run: () => transformSelection((text) => text.toLowerCase()),
      },
      {
        kind: "item",
        id: "titleCase",
        label: "Title Case",
        enabled: editable && hasSelection,
        title: selectionTitle,
        run: () => transformSelection(titleCase),
      },
      { kind: "separator" },
      {
        kind: "item",
        id: "comment",
        label: "Toggle Single Line Comment",
        enabled: editable && hasComments,
        title: !editable ? READ_ONLY_REASON : hasComments ? undefined : NO_COMMENTS_REASON,
        run: () => {
          toggleComment(view);
          view.focus();
        },
      },
      {
        kind: "item",
        id: "duplicateLine",
        label: "Duplicate Line",
        shortcut: altShortcut("\u2193", true),
        enabled: editable,
        title: editTitle,
        run: () => {
          copyLineDown(view);
          view.focus();
        },
      },
      {
        kind: "item",
        id: "moveLineUp",
        label: "Move Line Up",
        shortcut: altShortcut("\u2191"),
        enabled: editable,
        title: editTitle,
        run: () => {
          moveLineUp(view);
          view.focus();
        },
      },
      {
        kind: "item",
        id: "moveLineDown",
        label: "Move Line Down",
        shortcut: altShortcut("\u2193"),
        enabled: editable,
        title: editTitle,
        run: () => {
          moveLineDown(view);
          view.focus();
        },
      },
      { kind: "separator" },
      {
        kind: "item",
        id: "format",
        label: "Format Document",
        enabled: formatBlocked === null,
        title: formatBlocked ?? undefined,
        run: options.format,
      },
      { kind: "separator" },
      {
        kind: "item",
        id: "readAloudFromHere",
        label: "Read Aloud from Here",
        enabled: reading.blocked === null && reading.fromHereBlocked === null,
        title: reading.fromHereBlocked ?? reading.blocked ?? undefined,
        run: () => options.readAloud(false),
      },
      {
        kind: "item",
        id: "readAloudFromStart",
        label: "Read Aloud from the Beginning",
        enabled: reading.blocked === null,
        title: reading.blocked ?? undefined,
        run: () => options.readAloud(true),
      },
      // Only while something is being read: an always-present item that is
      // disabled the rest of the time is one more row to scan past.
      ...(reading.active
        ? [
            {
              kind: "item" as const,
              id: "stopReading",
              label: "Stop Reading",
              enabled: true,
              run: options.stopReading,
            },
          ]
        : []),
      { kind: "separator" },
      {
        kind: "item",
        id: "favorite",
        label: favorite ? "Remove from Favorites" : "Add to Favorites",
        enabled: favoriteBlocked === null,
        title: favoriteBlocked ?? undefined,
        run: options.favorite,
      },
    ];
  };

  const run = (item: MenuItem): void => {
    closeMenu();
    view.focus();
    try {
      const result = item.run();
      if (result instanceof Promise) {
        void result.catch((error) =>
          options.toast(`Could not run the command: ${String(error)}`, 5200),
        );
      }
    } catch (error) {
      options.toast(`Could not run the command: ${String(error)}`, 5200);
    }
  };

  const itemElement = (item: MenuItem): HTMLButtonElement => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "editor-menu-item";
    button.setAttribute("role", "menuitem");
    button.dataset.action = item.id;
    if (item.href !== undefined) button.dataset.href = item.href;
    button.disabled = !item.enabled;
    if (item.title) button.title = item.title;

    const label = document.createElement("span");
    label.className = "editor-menu-label";
    label.textContent = item.label;
    button.appendChild(label);
    if (item.shortcut) {
      const hint = document.createElement("span");
      hint.className = "editor-menu-shortcut";
      hint.textContent = item.shortcut;
      button.appendChild(hint);
    }

    button.addEventListener("click", () => {
      if (button.disabled) return;
      run(item);
    });
    return button;
  };

  const openMenu = (x: number, y: number, pos: number | null): void => {
    closeMenu();
    const host = document.createElement("div") as MenuHost;
    host.className = "editor-menu";
    host.setAttribute("role", "menu");
    host.tabIndex = -1;
    host.style.left = `${x}px`;
    host.style.top = `${y}px`;

    for (const entry of entries(pos)) {
      if (entry.kind === "separator") {
        const separator = document.createElement("div");
        separator.className = "editor-menu-sep";
        separator.setAttribute("role", "separator");
        host.appendChild(separator);
      } else {
        host.appendChild(itemElement(entry));
      }
    }

    document.body.appendChild(host);
    place(host, x, y);
    menu = host;
    host.querySelector<HTMLButtonElement>(".editor-menu-item:not(:disabled)")?.focus({
      preventScroll: true,
    });

    const onPointer = (event: MouseEvent): void => {
      if (host.contains(event.target as Node)) return;
      closeMenu();
    };
    const onEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closeMenu(true);
    };
    const onKey = (event: KeyboardEvent): void => {
      const items = Array.from(
        host.querySelectorAll<HTMLButtonElement>(".editor-menu-item:not(:disabled)"),
      );
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
          event.preventDefault();
          closeMenu(true);
          return;
        default:
          return;
      }
      items[index]?.focus({ preventScroll: true });
    };
    const onScroll = (): void => closeMenu();
    const onBlur = (): void => closeMenu();
    const onResize = (): void => closeMenu();

    document.addEventListener("mousedown", onPointer, true);
    document.addEventListener("keydown", onEscape, true);
    host.addEventListener("keydown", onKey);
    view.scrollDOM.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("blur", onBlur);
    window.addEventListener("resize", onResize);

    host.cleanup = () => {
      document.removeEventListener("mousedown", onPointer, true);
      document.removeEventListener("keydown", onEscape, true);
      host.removeEventListener("keydown", onKey);
      view.scrollDOM.removeEventListener("scroll", onScroll);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("resize", onResize);
    };
  };

  const onContextMenu = (event: MouseEvent): void => {
    const target = event.target;
    if (target instanceof Node && menu?.contains(target)) return;
    closeMenu();
    if (event.defaultPrevented) return;
    if (!(target instanceof Node)) return;
    // The search panel and autocomplete tooltips are inside `view.dom` too; they
    // are form fields, and the webview's own menu belongs there.
    if (!isEditorSurface(view, target)) return;

    // A right-click outside the selection moves the caret to the click, so
    // Paste inserts where the reader aimed. A right-click inside a selection
    // keeps it.
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (pos !== null) {
      const selection = view.state.selection.main;
      if (selection.empty || pos < selection.from || pos > selection.to) {
        view.dispatch({ selection: { anchor: pos }, scrollIntoView: false });
      }
    }
    event.preventDefault();
    openMenu(event.clientX, event.clientY, pos);
  };

  document.addEventListener("contextmenu", onContextMenu);
  return () => {
    document.removeEventListener("contextmenu", onContextMenu);
    closeMenu();
  };
}

function isEditorSurface(view: EditorView, target: Node): boolean {
  if (view.contentDOM.contains(target)) return true;
  const gutters = view.dom.querySelector(".cm-gutters");
  return gutters?.contains(target) ?? false;
}
