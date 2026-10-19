//! Open documents.
//!
//! One session is one tab. The editor view is not in here: a session holds the
//! metadata and, once the tab has been left, the CodeMirror state that puts the
//! caret, the undo history and the text back. The shell keeps a single view and
//! swaps that state in.

import type { EditorState } from "@codemirror/state";
import type { DocumentLanguage } from "./api";

export interface Session {
  id: string;
  /** Null until the document has been saved. */
  path: string | null;
  name: string;
  directory: string | null;
  language: DocumentLanguage;
  savedContent: string;
  dirty: boolean;
  /** "\n" or "\r\n". Untitled documents use "\n" until the first save. */
  lineEnding: string;
  hadBom: boolean;
  lossy: boolean;
  size: number;
  modifiedMs: number;
  readOnly: boolean;
  /**
   * The view state from the last time this tab was hidden. Null while the tab
   * is on screen: the live EditorView is the authority then.
   */
  editorState: EditorState | null;
  previewScroll: number;
  editorScroll: number;
}

export interface SessionStore {
  list(): readonly Session[];
  active(): Session;
  byId(id: string): Session | undefined;
  findByPath(path: string): Session | undefined;
  /** A session that is not in the list yet. */
  create(): Session;
  /** Name for a new untitled tab that does not collide with one already open. */
  untitledName(): string;
  /** Insert after the active session and make it active. */
  add(session: Session): void;
  setActive(id: string): Session;
  /**
   * Move a session to `index` in the final order, where 0 is the left edge.
   * The active session stays active; an unknown id is a no-op.
   */
  move(id: string, index: number): void;
  /**
   * Remove a session. When the removed one was active, the neighbour that
   * should be shown is returned and is already the active session.
   */
  remove(id: string): Session | null;
  /**
   * Remove several sessions in one pass. When the active session was among
   * them, the survivor that should be shown is returned and is already active;
   * otherwise null. Removing every session leaves the list empty.
   */
  removeMany(ids: readonly string[]): Session | null;
  next(): Session;
  previous(): Session;
}

let nextId = 1;

function blank(): Session {
  return {
    id: `doc-${nextId++}`,
    path: null,
    name: "Untitled",
    directory: null,
    language: "markdown",
    savedContent: "",
    dirty: false,
    lineEnding: "\n",
    hadBom: false,
    lossy: false,
    size: 0,
    modifiedMs: 0,
    readOnly: false,
    editorState: null,
    previewScroll: 0,
    editorScroll: 0,
  };
}

/**
 * Compare paths the way the platform does.
 *
 * Windows treats `C:\A` and `c:/a` as one file. A case-sensitive compare would
 * open that file twice. Other platforms keep case, so a Linux tree can hold
 * both `Notes.md` and `notes.md`.
 *
 * Exported because the remembered-tab list has to answer "is this the same
 * document" with exactly the store's rule; a second implementation would drift.
 */
export function pathKey(path: string): string {
  const slashed = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const windows = typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent);
  return windows ? slashed.toLowerCase() : slashed;
}

export function createSessionStore(): SessionStore {
  const items: Session[] = [blank()];
  let activeId = items[0].id;

  function active(): Session {
    const found = items.find((item) => item.id === activeId);
    if (!found) throw new Error("No active document");
    return found;
  }

  return {
    list() {
      return items.slice();
    },

    active,

    byId(id) {
      return items.find((item) => item.id === id);
    },

    findByPath(path) {
      const key = pathKey(path);
      return items.find((item) => item.path !== null && pathKey(item.path) === key);
    },

    create() {
      return blank();
    },

    untitledName() {
      const used = new Set(items.filter((item) => item.path === null).map((item) => item.name));
      if (!used.has("Untitled")) return "Untitled";
      let n = 2;
      while (used.has(`Untitled ${n}`)) n += 1;
      return `Untitled ${n}`;
    },

    add(session) {
      const index = items.findIndex((item) => item.id === activeId);
      items.splice(index + 1, 0, session);
      activeId = session.id;
    },

    move(id, index) {
      const from = items.findIndex((item) => item.id === id);
      if (from < 0) return;
      // `index` is the position in the list *after* the move, which is how a
      // drop position is measured: the dragged tab is not one of the targets.
      const to = Math.max(0, Math.min(Math.trunc(index), items.length - 1));
      if (from === to) return;
      const [session] = items.splice(from, 1);
      items.splice(to, 0, session);
    },

    setActive(id) {
      const found = items.findIndex((item) => item.id === id);
      if (found < 0) throw new Error(`No open document ${id}`);
      activeId = id;
      return items[found];
    },

    remove(id) {
      const index = items.findIndex((item) => item.id === id);
      if (index < 0) return null;
      const removingActive = items[index].id === activeId;
      items.splice(index, 1);
      if (!removingActive || items.length === 0) return null;
      const next = items[Math.min(index, items.length - 1)];
      activeId = next.id;
      return next;
    },

    removeMany(ids) {
      const removing = new Set(ids);
      if (!items.some((item) => removing.has(item.id))) return null;
      const activeIndex = items.findIndex((item) => item.id === activeId);
      const activeRemoved = removing.has(activeId);
      // Keeping the original index lets the survivor to the right of the active
      // tab take over, just as remove() does for one tab.
      const survivors = items
        .map((session, index) => ({ session, index }))
        .filter((entry) => !removing.has(entry.session.id));
      items.splice(0, items.length, ...survivors.map((entry) => entry.session));
      if (!activeRemoved || survivors.length === 0) return null;
      const right = survivors.find((entry) => entry.index > activeIndex);
      const next = (right ?? survivors[survivors.length - 1]).session;
      activeId = next.id;
      return next;
    },

    next() {
      const index = items.findIndex((item) => item.id === activeId);
      return items[(index + 1) % items.length];
    },

    previous() {
      const index = items.findIndex((item) => item.id === activeId);
      return items[(index - 1 + items.length) % items.length];
    },
  };
}
