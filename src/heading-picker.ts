//! The keyboard-first "Go to Heading" surface.
//!
//! The outline already knows how to find headings in every document language.
//! This module only turns that list into a filterable modal: the caller owns
//! extraction and the jump, so the picker has no editor or shell dependency and
//! can be tested through its pure row builder.

import { filterEntries } from "./combo.ts";
import type { Heading } from "./markdown.ts";

/** Most rows shown. A generated document can hold thousands of headings. */
export const HEADING_PICKER_LIMIT = 1000;

interface HeadingRow {
  /** The text `filterEntries` searches. */
  value: string;
  /** The visible row label. */
  label: string;
  /** Level and line number, so "line 40" or "h2" also finds a row. */
  keywords: string[];
  heading: Heading;
}

/** The visible label, before the line number on the right. */
export function headingLabel(heading: Heading): string {
  return `H${heading.level} · ${heading.text}`;
}

/**
 * Build the searchable rows.
 *
 * The cap is applied before filtering so a pathological document cannot build
 * a thousand DOM nodes for every keystroke. Duplicate titles are fine: every row
 * carries its line number, which is the part that tells them apart.
 */
export function headingRows(headings: readonly Heading[]): HeadingRow[] {
  return headings.slice(0, HEADING_PICKER_LIMIT).map((heading) => ({
    value: heading.text,
    label: headingLabel(heading),
    keywords: [`h${heading.level}`, `line ${heading.line}`],
    heading,
  }));
}

export interface HeadingPickerOptions {
  /** Called after the dialog closes. The caller moves the caret and focuses. */
  onPick: (heading: Heading) => void;
  /** Focus target for Escape, an empty list or a cancelled pick. */
  fallbackFocus?: () => void;
}

/**
 * Show the modal and resolve when a heading is picked or the dialog closes.
 *
 * The input keeps focus for the whole gesture; Arrow keys, Page keys, Home/End
 * and Enter drive the listbox through `aria-activedescendant`, so assistive
 * technology follows the same row the eye sees.
 */
export function showHeadingPicker(
  headings: readonly Heading[],
  options: HeadingPickerOptions,
): void {
  const rows = headingRows(headings);
  const previous = document.activeElement;
  const dialog = document.createElement("dialog");
  dialog.className = "heading-picker-dialog";
  dialog.setAttribute("aria-label", "Go to Heading");

  const input = document.createElement("input");
  input.className = "heading-picker-filter";
  input.type = "search";
  input.placeholder = "Filter headings…";
  input.setAttribute("aria-label", "Filter headings");
  input.setAttribute("autocomplete", "off");
  input.setAttribute("spellcheck", "false");
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-expanded", "true");
  input.setAttribute("aria-controls", "heading-picker-list");

  const list = document.createElement("div");
  list.className = "heading-picker-list";
  list.id = "heading-picker-list";
  list.setAttribute("role", "listbox");
  list.setAttribute("aria-label", "Headings");

  const empty = document.createElement("p");
  empty.className = "heading-picker-empty";
  empty.hidden = true;

  const note = document.createElement("p");
  note.className = "heading-picker-note";
  note.hidden = true;
  if (headings.length > HEADING_PICKER_LIMIT) {
    note.textContent = `Showing the first ${HEADING_PICKER_LIMIT} headings.`;
    note.hidden = false;
  }

  const close = document.createElement("button");
  close.type = "button";
  close.className = "heading-picker-close";
  close.textContent = "Close";

  const footer = document.createElement("div");
  footer.className = "heading-picker-footer";
  footer.append(close);

  dialog.append(input, note, list, empty, footer);
  document.body.append(dialog);

  let visible = rows;
  let activeIndex = -1;
  let settled = false;

  const idFor = (index: number) => `heading-picker-row-${index}`;

  function restoreFocus(): void {
    const target =
      previous instanceof HTMLElement &&
      previous !== document.body &&
      previous !== document.documentElement &&
      previous.isConnected &&
      previous.getClientRects().length > 0
        ? previous
        : null;
    if (target) target.focus({ preventScroll: true });
    else options.fallbackFocus?.();
  }

  function finish(picked: Heading | null): void {
    if (settled) return;
    settled = true;
    if (dialog.open) dialog.close();
    dialog.remove();
    if (picked) options.onPick(picked);
    else restoreFocus();
  }

  function setActive(index: number, scroll = true): void {
    if (visible.length === 0) {
      activeIndex = -1;
      input.removeAttribute("aria-activedescendant");
      return;
    }
    const clamped = Math.max(0, Math.min(index, visible.length - 1));
    activeIndex = clamped;
    const buttons = list.querySelectorAll<HTMLButtonElement>(".heading-picker-row");
    buttons.forEach((button, position) => {
      const active = position === clamped;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-selected", String(active));
    });
    const active = buttons[clamped];
    if (!active) return;
    input.setAttribute("aria-activedescendant", active.id);
    if (scroll) active.scrollIntoView({ block: "nearest" });
  }

  function rowElement(row: HeadingRow, index: number): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "heading-picker-row";
    button.id = idFor(index);
    button.setAttribute("role", "option");
    button.setAttribute("aria-selected", "false");
    button.title = `Line ${row.heading.line}`;

    const level = document.createElement("span");
    level.className = "heading-picker-level";
    level.textContent = `H${row.heading.level}`;

    const text = document.createElement("span");
    text.className = "heading-picker-text";
    text.textContent = row.heading.text;

    const line = document.createElement("span");
    line.className = "heading-picker-line";
    line.textContent = `Ln ${row.heading.line}`;

    button.append(level, text, line);
    button.addEventListener("click", () => finish(row.heading));
    return button;
  }

  function render(query: string): void {
    visible = filterEntries(rows, query);
    list.replaceChildren();
    empty.hidden = true;
    input.removeAttribute("aria-activedescendant");
    activeIndex = -1;

    if (visible.length === 0) {
      empty.textContent =
        rows.length === 0 ? "No headings in this document." : "No heading matches.";
      empty.hidden = false;
      empty.setAttribute("role", "status");
      return;
    }

    const fragment = document.createDocumentFragment();
    visible.forEach((row, index) => fragment.append(rowElement(row, index)));
    list.append(fragment);
    setActive(0, false);
  }

  input.addEventListener("input", () => render(input.value));
  input.addEventListener("keydown", (event) => {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        setActive(activeIndex + 1);
        break;
      case "ArrowUp":
        event.preventDefault();
        setActive(activeIndex - 1);
        break;
      case "PageDown":
        event.preventDefault();
        setActive(activeIndex + 10);
        break;
      case "PageUp":
        event.preventDefault();
        setActive(activeIndex - 10);
        break;
      case "Home":
        event.preventDefault();
        setActive(0);
        break;
      case "End":
        event.preventDefault();
        setActive(visible.length - 1);
        break;
      case "Enter": {
        event.preventDefault();
        const row = visible[activeIndex] ?? visible[0];
        if (row) finish(row.heading);
        break;
      }
      case "Escape":
        event.preventDefault();
        finish(null);
        break;
      default:
        break;
    }
  });

  close.addEventListener("click", () => finish(null));
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    finish(null);
  });
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) finish(null);
  });
  // The window accelerator handler runs in the capture phase; this keeps menu
  // shortcuts out of the dialog once the event has reached it.
  dialog.addEventListener("keydown", (event) => event.stopPropagation());

  render("");
  try {
    dialog.showModal();
  } catch {
    finish(null);
    return;
  }

  if (rows.length === 0) {
    close.focus();
    return;
  }
  input.focus();
  input.select();
}
