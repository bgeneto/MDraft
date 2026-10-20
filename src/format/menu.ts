//! The right-click menu that offers **Format Document** in the source editor.
//!
//! It is installed on `document` rather than on the editor on purpose. The
//! spelling plugin already owns `contextmenu` on `view.dom` and calls
//! `preventDefault()` plus `stopPropagation()` when a misspelled word is under
//! the pointer, so a spelling menu wins without either module knowing about the
//! other. Every other editor right-click reaches this listener and opens the
//! format menu; a right-click in the preview, the tab strip or the sidebar does
//! not.

import type { EditorView } from "@codemirror/view";
import type { DocumentLanguage } from "../api";
import { formatEditor, formatErrorMessage } from "./formatters";

export interface FormatMenuOptions {
  view: EditorView;
  /** The language of the document currently on screen. */
  language: () => DocumentLanguage;
  /** A read-only file is not formattable, but the menu still opens to explain. */
  readOnly?: () => boolean;
  toast: (text: string, ms?: number) => { dismiss: () => void };
}

/** The three languages this application can format. AsciiDoc is excluded. */
const SUPPORTED: ReadonlySet<DocumentLanguage> = new Set<DocumentLanguage>([
  "markdown",
  "html",
  "typst",
]);

type MenuHost = HTMLDivElement & { cleanup?: () => void };

export function installFormatMenu(options: FormatMenuOptions): () => void {
  let menu: MenuHost | null = null;
  // One formatter at a time. A second click while a large document is being
  // formatted would race two full-document transactions.
  let busy = false;

  const closeMenu = (): void => {
    const host = menu;
    if (!host) return;
    menu = null;
    host.cleanup?.();
    host.remove();
  };

  const place = (host: HTMLElement, x: number, y: number): void => {
    const rect = host.getBoundingClientRect();
    const left =
      x + rect.width > window.innerWidth ? Math.max(8, window.innerWidth - rect.width - 8) : x;
    const top = y + rect.height > window.innerHeight ? Math.max(8, y - rect.height) : y;
    host.style.left = `${left}px`;
    host.style.top = `${top}px`;
  };

  const run = async (language: DocumentLanguage): Promise<void> => {
    if (busy) return;
    // A keyboard tab switch can leave this menu open over another document.
    // Never apply the formatter of the language that was under the pointer to a
    // different one; `formatEditor` guards everything that changes after this.
    if (options.language() !== language) return;
    busy = true;
    // Painted before the formatter chunk is fetched, so the first use of a large
    // document reports the wait instead of looking like a dead command.
    const pending = options.toast("Formatting…", 0);
    try {
      const outcome = await formatEditor(options.view, language);
      pending.dismiss();
      if (outcome === "changed") options.toast("Formatted");
      else if (outcome === "unchanged") options.toast("Already formatted");
      else {
        options.toast(
          "The document changed while it was being formatted — nothing was applied.",
          4200,
        );
      }
    } catch (error) {
      pending.dismiss();
      options.toast(`Could not format: ${formatErrorMessage(error)}`, 6200);
    } finally {
      busy = false;
    }
  };

  const openMenu = (x: number, y: number, language: DocumentLanguage): void => {
    closeMenu();
    const host = document.createElement("div") as MenuHost;
    host.className = "format-menu";
    host.setAttribute("role", "menu");
    host.style.left = `${x}px`;
    host.style.top = `${y}px`;

    const item = document.createElement("button");
    item.type = "button";
    item.setAttribute("role", "menuitem");
    item.textContent = "Format Document";
    const disabled = options.readOnly?.() === true || options.view.state.readOnly;
    item.disabled = disabled;
    if (disabled) item.title = "This document is read-only.";
    item.addEventListener("click", () => {
      if (disabled) return;
      closeMenu();
      void run(language);
    });
    host.appendChild(item);
    document.body.appendChild(host);
    place(host, x, y);
    menu = host;

    const onPointer = (event: MouseEvent): void => {
      if (host.contains(event.target as Node)) return;
      closeMenu();
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closeMenu();
    };
    const onScroll = (): void => closeMenu();
    document.addEventListener("mousedown", onPointer, true);
    document.addEventListener("keydown", onKey, true);
    options.view.scrollDOM.addEventListener("scroll", onScroll, { passive: true });
    host.cleanup = () => {
      document.removeEventListener("mousedown", onPointer, true);
      document.removeEventListener("keydown", onKey, true);
      options.view.scrollDOM.removeEventListener("scroll", onScroll);
    };
  };

  const onContextMenu = (event: MouseEvent): void => {
    if (event.defaultPrevented) return;
    const target = event.target;
    if (!(target instanceof Node)) return;
    // The search panel and autocomplete tooltips are inside `view.dom` too; they
    // are form fields, and the webview's own menu belongs there.
    if (!isEditorSurface(options.view, target)) return;
    if (menu?.contains(target)) return;
    const language = options.language();
    if (!SUPPORTED.has(language) || busy) return;
    event.preventDefault();
    openMenu(event.clientX, event.clientY, language);
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
