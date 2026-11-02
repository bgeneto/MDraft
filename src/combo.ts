//! One searchable listbox for the whole application.
//!
//! The Model field and the AI Assistant's Translate target need the same
//! control: a text field whose value is either chosen from a list or typed by
//! hand, whose list opens whole, and which filters only while the reader types.
//!
//! A native `<datalist>` cannot do that. Chromium filters its options by the
//! field's current value, so a value that is not in the list hides every option
//! — the defect recorded for the Model field in October 2026 — and its popup is
//! browser chrome no stylesheet can reach: not the type scale, row height, hover
//! tint, mark on the current value or scrollbar. This module is the one
//! implementation of the alternative. `src/font-picker.ts` keeps its own control
//! because it is a button with grouped specimens, not an editable field.

export interface ComboEntry {
  /** The text committed to the field and handed back to the caller. */
  value: string;
  /** What the row shows. Defaults to `value`. */
  label?: string;
  /** Extra search terms, never displayed: tags, or spellings without accents. */
  keywords?: readonly string[];
}

/** Lowercase and strip diacritics, so "espanol" finds "español". */
export function foldComboText(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/**
 * Case- and accent-insensitive substring search, in the caller's order.
 *
 * The order is the ranking: a caller puts its likely rows first, and sorting
 * them again would be a second opinion nobody asked for. An empty query returns
 * everything, because opening the list is a selection, not a search.
 */
export function filterEntries<T extends ComboEntry>(entries: readonly T[], query: string): T[] {
  const needle = foldComboText(query.trim());
  if (!needle) return [...entries];
  return entries.filter((entry) => {
    if (foldComboText(entry.value).includes(needle)) return true;
    if (entry.label && foldComboText(entry.label).includes(needle)) return true;
    return (entry.keywords ?? []).some((keyword) => foldComboText(keyword).includes(needle));
  });
}

export interface ComboOptions {
  /** The text field that carries the value. */
  input: HTMLInputElement;
  /** A label for assistive technology; the visible caption belongs to the caller. */
  label: string;
  /** The listbox's own label: "Fetched models", "Suggested languages". */
  listLabel: string;
  /** The caret's label and tooltip. */
  toggleLabel: string;
  /** Read on every open, so a stale list cannot outlive the source that named it. */
  entries: () => readonly ComboEntry[];
  /** Shown when the caller's list has no entries at all. */
  emptyLabel: string;
  /** Shown when a query matches nothing; the copy teaches what to do next. */
  noMatchLabel: (query: string) => string;
  /** A row was chosen. The field already holds its value. */
  choose: (value: string) => void;
  /**
   * Enter with no highlighted row: commit or submit what was typed.
   *
   * Without it the field dispatches `change` instead, which is how a row's
   * setter runs when the value is only committed on blur.
   */
  accept?: () => void;
  /**
   * Let the popup grow past the field to fit its longest row.
   *
   * A model id is long and ellipsised with a tooltip, so its popup matches the
   * field. A language label must not be cut — "Spanish (Latin America)" is only
   * useful whole — so this mode measures the rows and clamps to the viewport.
   */
  growToFit?: boolean;
}

let activeClose: (() => void) | null = null;
let nextListId = 0;

/** Close the open list, for a panel re-render or a surface that closed. */
export function closeCombo(): void {
  activeClose?.();
}

/**
 * Build the caret and the popup for a text field.
 *
 * The return value is the caret button, which the caller appends beside the
 * input. The popup is appended to the document body: both callers live inside a
 * scrolling panel, and an absolutely positioned list inside one would be
 * clipped at its edge.
 */
export function attachCombo(options: ComboOptions): HTMLButtonElement {
  const { input } = options;
  const listId = `combo-list-${++nextListId}`;

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "combo-toggle";
  toggle.setAttribute("aria-label", options.toggleLabel);
  toggle.setAttribute("aria-haspopup", "listbox");
  toggle.setAttribute("aria-expanded", "false");
  toggle.title = options.toggleLabel;
  toggle.append(caretIcon());

  input.setAttribute("role", "combobox");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-expanded", "false");
  input.setAttribute("aria-label", options.label);
  input.setAttribute("autocomplete", "off");
  input.setAttribute("spellcheck", "false");

  let popup: HTMLDivElement | null = null;
  let visible: ComboEntry[] = [];
  let activeIndex = -1;

  function setExpanded(expanded: boolean): void {
    input.setAttribute("aria-expanded", String(expanded));
    toggle.setAttribute("aria-expanded", String(expanded));
    if (expanded) {
      input.setAttribute("aria-controls", listId);
    } else {
      input.removeAttribute("aria-controls");
      input.removeAttribute("aria-activedescendant");
    }
  }

  function setActive(index: number, scroll = true): void {
    if (!popup) return;
    const entries = [...popup.querySelectorAll<HTMLElement>(".combo-option")];
    if (entries.length === 0) {
      activeIndex = -1;
      input.removeAttribute("aria-activedescendant");
      return;
    }
    const clamped = Math.max(0, Math.min(index, entries.length - 1));
    entries.forEach((entry, position) => {
      entry.classList.toggle("is-active", position === clamped);
    });
    const active = entries[clamped];
    if (!active) return;
    activeIndex = clamped;
    input.setAttribute("aria-activedescendant", active.id);
    if (scroll) active.scrollIntoView({ block: "nearest" });
  }

  function emptyRow(text: string): HTMLDivElement {
    const empty = document.createElement("div");
    empty.className = "combo-empty";
    empty.setAttribute("role", "option");
    empty.setAttribute("aria-disabled", "true");
    empty.textContent = text;
    empty.addEventListener("pointerdown", (event) => event.preventDefault());
    return empty;
  }

  function position(): void {
    if (!popup) return;
    const rect = input.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;
    const gap = 4;
    const margin = 8;
    const below = window.innerHeight - rect.bottom - gap - margin;
    const above = rect.top - gap - margin;

    if (options.growToFit) {
      popup.style.width = "max-content";
      popup.style.minWidth = `${Math.round(rect.width)}px`;
      popup.style.maxWidth = `${Math.max(120, window.innerWidth - margin * 2)}px`;
    } else {
      popup.style.width = `${Math.round(rect.width)}px`;
      popup.style.minWidth = "";
      popup.style.maxWidth = "";
    }
    const width = popup.getBoundingClientRect().width;
    popup.style.left = `${Math.round(
      Math.max(margin, Math.min(rect.left, window.innerWidth - width - margin)),
    )}px`;

    if (below >= 140 || below >= above) {
      popup.style.top = `${Math.round(rect.bottom + gap)}px`;
      popup.style.bottom = "auto";
      popup.style.maxHeight = `${Math.max(60, Math.min(280, below))}px`;
    } else {
      popup.style.top = "auto";
      popup.style.bottom = `${Math.round(window.innerHeight - rect.top + gap)}px`;
      popup.style.maxHeight = `${Math.max(60, Math.min(280, above))}px`;
    }
  }

  /**
   * Fill the list for a query.
   *
   * Opening shows everything: the field's value is a selection, not a filter.
   * Typing passes the field's text and hides the non-matching rows without
   * making the current value disappear on its own.
   */
  function render(query: string): void {
    if (!popup) return;
    const all = options.entries();
    const filtered = filterEntries(all, query);
    visible = filtered;
    activeIndex = -1;
    input.removeAttribute("aria-activedescendant");
    popup.replaceChildren();

    if (all.length === 0) {
      popup.append(emptyRow(options.emptyLabel));
      return;
    }
    if (filtered.length === 0) {
      popup.append(emptyRow(options.noMatchLabel(query)));
      return;
    }

    const current = input.value.trim();
    filtered.forEach((entry, index) => {
      const label = entry.label ?? entry.value;
      const option = document.createElement("div");
      option.className = "combo-option";
      option.id = `${listId}-${index}`;
      option.setAttribute("role", "option");
      option.setAttribute("aria-selected", entry.value === current ? "true" : "false");
      option.title = label;
      option.textContent = label;
      // Keep the field focused: a blur here would commit the old text while
      // the pointer is still on its way to the row.
      option.addEventListener("pointerdown", (event) => event.preventDefault());
      option.addEventListener("pointerenter", () => setActive(index, false));
      option.addEventListener("click", () => choose(entry.value));
      popup?.append(option);
    });
  }

  function open(): void {
    if (popup) return;
    activeClose?.();
    const rect = input.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;

    const element = document.createElement("div");
    element.className = "combo-popup";
    element.id = listId;
    element.setAttribute("role", "listbox");
    element.setAttribute("aria-label", options.listLabel);
    document.body.append(element);
    popup = element;

    setExpanded(true);
    render("");
    position();
    const index = visible.findIndex((entry) => entry.value === input.value.trim());
    if (index >= 0) setActive(index, false);

    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", close);
    activeClose = close;
  }

  function close(): void {
    if (!popup) return;
    popup.remove();
    popup = null;
    visible = [];
    activeIndex = -1;
    setExpanded(false);
    document.removeEventListener("pointerdown", onPointerDown, true);
    document.removeEventListener("scroll", onScroll, true);
    window.removeEventListener("resize", close);
    if (activeClose === close) activeClose = null;
  }

  function onPointerDown(event: PointerEvent): void {
    const target = event.target;
    if (!(target instanceof Node)) return;
    if (target === input || toggle.contains(target) || popup?.contains(target)) return;
    close();
  }

  function onScroll(event: Event): void {
    // Scrolling the list itself is not a reason to dismiss it. Any scroll of
    // the panel would move the field under a fixed popup, so those close it.
    if (event.target instanceof Node && popup?.contains(event.target)) return;
    close();
  }

  function choose(value: string): void {
    input.value = value;
    close();
    input.focus();
    options.choose(value);
  }

  function closeWhenFocusLeaves(): void {
    // The pointer path keeps the field focused via preventDefault on the row,
    // so a focus change here is a real exit from the control.
    requestAnimationFrame(() => {
      if (!popup) return;
      if (document.activeElement === input || toggle.contains(document.activeElement)) return;
      close();
    });
  }

  toggle.addEventListener("pointerdown", (event) => {
    // The caret acts on the field's current text; do not let its focus change
    // commit that text before the popup opens.
    event.preventDefault();
  });

  toggle.addEventListener("click", () => {
    if (popup) {
      close();
      input.focus();
      return;
    }
    open();
    input.focus();
  });

  toggle.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (!popup) open();
      input.focus();
      if (visible.length > 0 && activeIndex < 0) setActive(0);
      return;
    }
    if (event.key === "Escape" && popup) {
      event.preventDefault();
      event.stopPropagation();
      close();
      input.focus();
    }
  });

  toggle.addEventListener("blur", closeWhenFocusLeaves);
  input.addEventListener("blur", closeWhenFocusLeaves);

  input.addEventListener("input", () => {
    if (!popup) {
      // A field with no list is just text; do not open an empty card for every
      // keystroke of a hand-typed value.
      if (options.entries().length === 0) return;
      open();
      if (!popup) return;
    }
    render(input.value);
  });

  input.addEventListener("keydown", (event) => {
    // An IME commits with Enter; that Enter belongs to the composition, not to
    // a choice or a submit.
    if (event.isComposing) return;

    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const opening = !popup;
      if (opening) {
        open();
        if (!popup) return;
      }
      if (visible.length === 0) return;
      if (opening) {
        if (activeIndex < 0) setActive(event.key === "ArrowDown" ? 0 : visible.length - 1);
        return;
      }
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
      const active = popup && activeIndex >= 0 ? visible[activeIndex] : undefined;
      if (active) {
        event.preventDefault();
        choose(active.value);
        return;
      }
      if (popup) close();
      // A text input fires `change` only on blur, so commit a hand-typed value
      // here. A caller with its own submit gesture takes Enter instead.
      if (options.accept) {
        event.preventDefault();
        options.accept();
      } else {
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }
      return;
    }

    if (event.key === "Escape" && popup) {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }

    if (event.key === "Tab" && popup) close();
  });

  return toggle;
}

function caretIcon(): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 10 6");
  svg.setAttribute("width", "10");
  svg.setAttribute("height", "6");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M1 1l4 4 4-4");
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "1.5");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  svg.append(path);
  return svg;
}
