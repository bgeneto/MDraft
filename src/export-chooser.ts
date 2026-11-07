//! The "More Pandoc formats…" chooser.
//!
//! Pandoc advertises around 77 writers, and the number changes with the
//! installed binary. A row per writer in Preferences would crowd the menu,
//! change the reader's settings and miss whatever an update adds, so the rest of
//! the list is offered on demand instead.
//!
//! The control is a modal with a filter field and a listbox, not the shared
//! `combo.ts` field: a combobox commits a *value* the reader may also type, and
//! a writer id is not something to hand-type — it must be one the installed
//! binary advertised. `filterEntries` is reused so the search folds accents and
//! matches keywords exactly as the other pickers do.

import { filterEntries } from "./combo.ts";
import type { PandocWriter } from "./api";

export interface WriterChooserOptions {
  /** Every writer the installed pandoc reported. */
  writers: readonly PandocWriter[];
  /** The document's name, for the dialog's title. */
  documentName: string;
  /**
   * The compiled-PDF route, offered instead of pandoc's `pdf` writer.
   *
   * Converting LaTeX to Typst for PDF would change the layout and need a second
   * engine; the preview already holds the compiled bytes.
   */
  pdfLabel: string;
}

/** What the chooser resolved to. */
export type WriterChoice =
  { kind: "writer"; writer: PandocWriter } | { kind: "compiled-pdf" } | null;

interface Row {
  /** The id handed back: a writer id, or `pdf` for the compiled route. */
  id: string;
  label: string;
  detail: string;
  keywords: string[];
  bibliographyOnly: boolean;
  compiled: boolean;
}

/**
 * Show the chooser and resolve when it closes.
 *
 * `null` means the reader dismissed it. The dialog is rebuilt on every open and
 * removed when it closes, like the statistics and unsaved-changes dialogs.
 */
export function showWriterChooser(
  options: WriterChooserOptions,
  fallbackFocus?: () => void,
): Promise<WriterChoice> {
  return new Promise((resolve) => {
    const previous = document.activeElement;
    const rows: Row[] = [];
    for (const writer of options.writers) {
      if (writer.id === "pdf") {
        // The compiled route replaces pandoc's PDF writer, which needs a TeX
        // distribution this build deliberately does not require.
        rows.push({
          id: "pdf",
          label: options.pdfLabel,
          detail: "writes the PDF the preview compiled",
          keywords: ["pdf", "compiled", "preview"],
          bibliographyOnly: false,
          compiled: true,
        });
        continue;
      }
      rows.push({
        id: writer.id,
        label: writer.label,
        detail: writer.id,
        keywords: [writer.id, writer.extension],
        bibliographyOnly: writer.bibliographyOnly,
        compiled: false,
      });
    }

    const dialog = document.createElement("dialog");
    dialog.className = "export-dialog";
    dialog.setAttribute("aria-labelledby", "export-dialog-title");

    const title = document.createElement("h2");
    title.id = "export-dialog-title";
    title.textContent = "Export with Pandoc";

    const caption = document.createElement("p");
    caption.className = "export-dialog-caption";
    caption.textContent =
      `Choose a format for ${options.documentName}. ` +
      "The list is what the installed Pandoc reports, so a Pandoc update adds rows here.";

    const field = document.createElement("input");
    field.type = "search";
    field.className = "export-dialog-search";
    field.placeholder = "Search formats";
    field.setAttribute("aria-label", "Search export formats");
    field.setAttribute("autocomplete", "off");
    field.setAttribute("spellcheck", "false");

    const list = document.createElement("div");
    list.className = "export-dialog-list";
    list.id = "export-dialog-list";
    list.setAttribute("role", "listbox");
    list.setAttribute("aria-label", "Pandoc formats");
    field.setAttribute("aria-controls", list.id);

    const status = document.createElement("p");
    status.className = "export-dialog-status";
    status.setAttribute("role", "status");

    const actions = document.createElement("div");
    actions.className = "export-dialog-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Cancel";
    actions.append(cancel);

    dialog.append(title, caption, field, list, status, actions);

    let visible: Row[] = [];
    let activeIndex = -1;
    let settled = false;

    const finish = (choice: WriterChoice) => {
      if (settled) return;
      settled = true;
      dialog.close();
      dialog.remove();
      // A menu command can follow a panel that has just closed: its button is
      // still connected but no longer painted, so focusing it would leave the
      // keyboard nowhere. Fall back to the editor in that case.
      const restorable =
        previous instanceof HTMLElement &&
        previous !== document.body &&
        previous !== document.documentElement &&
        previous.isConnected &&
        previous.getClientRects().length > 0;
      if (restorable) previous.focus({ preventScroll: true });
      else fallbackFocus?.();
      resolve(choice);
    };

    const setActive = (index: number) => {
      const buttons = [...list.querySelectorAll<HTMLElement>(".export-dialog-row")];
      if (buttons.length === 0) {
        activeIndex = -1;
        field.removeAttribute("aria-activedescendant");
        return;
      }
      const clamped = Math.max(0, Math.min(index, buttons.length - 1));
      buttons.forEach((button, position) =>
        button.classList.toggle("is-active", position === clamped),
      );
      const active = buttons[clamped];
      if (!active) return;
      activeIndex = clamped;
      field.setAttribute("aria-activedescendant", active.id);
      active.scrollIntoView({ block: "nearest" });
    };

    const choose = (row: Row) => {
      if (row.compiled) {
        finish({ kind: "compiled-pdf" });
        return;
      }
      const writer = options.writers.find((entry) => entry.id === row.id);
      if (!writer) return;
      finish({ kind: "writer", writer });
    };

    const render = (query: string) => {
      const matches = filterEntries(
        rows.map((row) => ({ ...row, value: row.id })),
        query,
      );
      visible = matches;
      activeIndex = -1;
      field.removeAttribute("aria-activedescendant");
      list.replaceChildren();
      // `pdf` is the compiled route and always worth a row; the count is about
      // the conversions, so it is reported separately.
      const conversions = rows.filter((row) => !row.compiled).length;
      status.textContent =
        query.trim() === ""
          ? `${conversions} conversion${conversions === 1 ? "" : "s"} available`
          : `${matches.length} of ${rows.length} formats match`;

      if (matches.length === 0) {
        const empty = document.createElement("div");
        empty.className = "export-dialog-empty";
        empty.textContent = `No format matches “${query.trim()}”.`;
        list.append(empty);
        return;
      }

      matches.forEach((row, index) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "export-dialog-row";
        button.id = `export-dialog-row-${index}`;
        button.setAttribute("role", "option");
        button.setAttribute("aria-selected", "false");
        const name = document.createElement("span");
        name.className = "export-dialog-name";
        name.textContent = row.label;
        const detail = document.createElement("span");
        detail.className = "export-dialog-detail";
        detail.textContent = row.detail;
        button.append(name, detail);
        if (row.bibliographyOnly) {
          const note = document.createElement("span");
          note.className = "export-dialog-note";
          // Pandoc's LaTeX reader does not carry the entries a `.bib` file
          // holds, so this writer produces an empty result for a `.tex` source.
          // Saying so beats handing the reader a zero-byte "success".
          note.textContent = "citation data only — empty for LaTeX";
          button.append(note);
        }
        button.addEventListener("pointerenter", () => setActive(index));
        button.addEventListener("click", () => choose(row));
        list.append(button);
      });
    };

    field.addEventListener("input", () => render(field.value));
    field.addEventListener("keydown", (event) => {
      if (event.isComposing) return;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        if (visible.length === 0) return;
        const delta = event.key === "ArrowDown" ? 1 : -1;
        const next =
          activeIndex < 0
            ? delta > 0
              ? 0
              : visible.length - 1
            : (activeIndex + delta + visible.length) % visible.length;
        setActive(next);
        return;
      }
      if (event.key === "Enter") {
        const active = activeIndex >= 0 ? visible[activeIndex] : undefined;
        if (active) {
          event.preventDefault();
          choose(active);
          return;
        }
        // Enter with nothing highlighted takes the first match, which is what a
        // reader who typed a full name expects.
        if (visible.length === 1) {
          event.preventDefault();
          choose(visible[0]);
        }
        return;
      }
    });

    cancel.addEventListener("click", () => finish(null));
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      finish(null);
    });
    dialog.addEventListener("close", () => finish(null));
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) finish(null);
    });
    // The window accelerator handler runs in the capture phase, so this keeps
    // keystrokes out of the editor once the event has reached the dialog. The
    // shell's modal guard covers the capture phase.
    dialog.addEventListener("keydown", (event) => event.stopPropagation());

    document.body.append(dialog);
    try {
      dialog.showModal();
    } catch {
      finish(null);
      return;
    }
    render("");
    field.focus();
  });
}
