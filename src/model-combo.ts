//! Searchable model picker for the AI Assistant's Preferences row.
//!
//! A native `<datalist>` filters its suggestions by the input's current value.
//! A model id saved for the previous endpoint therefore hides every model the
//! new endpoint just returned: the arrow opens an empty popup although the
//! fetch succeeded. This control opens the complete list and uses the field's
//! text as a filter only once the reader types. The field stays editable
//! because an endpoint may serve no model list at all.

/** Case-insensitive substring search, in the endpoint's own order. */
export function filterModelIds(models: readonly string[], query: string): string[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...models];
  return models.filter((id) => id.toLowerCase().includes(needle));
}

export interface ModelComboOptions {
  /** The text field that carries the model id. */
  input: HTMLInputElement;
  /** A label for assistive technology; the row's visible label is not a `<label>`. */
  label: string;
  /** Read on every open: changing the Base URL clears the cached list. */
  models: () => readonly string[];
  /** Persist the chosen id. The field is already updated when this runs. */
  choose: (model: string) => void;
}

let activeClose: (() => void) | null = null;
let nextListId = 0;

/** Close the open picker, for a panel re-render or a closed Preferences. */
export function closeModelCombo(): void {
  activeClose?.();
}

/**
 * Build the caret and the popup for a model field.
 *
 * The return value is the caret button, which the caller appends beside the
 * input. The popup is appended to the document body: the Preferences content
 * scrolls, and an absolutely positioned list inside it would be clipped.
 */
export function attachModelCombo(options: ModelComboOptions): HTMLButtonElement {
  const { input } = options;
  const listId = `prefs-model-list-${++nextListId}`;

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "prefs-combo-toggle";
  toggle.setAttribute("aria-label", "Show all fetched models");
  toggle.setAttribute("aria-haspopup", "listbox");
  toggle.setAttribute("aria-expanded", "false");
  toggle.title = "Show all fetched models";
  toggle.append(caretIcon());

  input.setAttribute("role", "combobox");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-expanded", "false");
  input.setAttribute("aria-label", options.label);
  input.setAttribute("autocomplete", "off");
  input.setAttribute("spellcheck", "false");

  let popup: HTMLDivElement | null = null;
  let visible: string[] = [];
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
    const entries = [...popup.querySelectorAll<HTMLElement>(".prefs-combo-option")];
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
    empty.className = "prefs-combo-empty";
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
    popup.style.left = `${Math.round(rect.left)}px`;
    popup.style.width = `${Math.round(rect.width)}px`;
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
   * Typing passes the field's text and hides the non-matching ids without
   * making the current value disappear on its own.
   */
  function render(query: string): void {
    if (!popup) return;
    const models = options.models();
    const filtered = filterModelIds(models, query);
    visible = filtered;
    activeIndex = -1;
    input.removeAttribute("aria-activedescendant");
    popup.replaceChildren();

    if (models.length === 0) {
      popup.append(emptyRow("No models fetched yet. Use Fetch model list."));
      return;
    }
    if (filtered.length === 0) {
      popup.append(emptyRow(`No fetched model matches “${query.trim()}”.`));
      return;
    }

    const current = input.value.trim();
    filtered.forEach((id, index) => {
      const option = document.createElement("div");
      option.className = "prefs-combo-option";
      option.id = `${listId}-${index}`;
      option.setAttribute("role", "option");
      option.setAttribute("aria-selected", id === current ? "true" : "false");
      option.title = id;
      option.textContent = id;
      // Keep the field focused: a blur here would commit the old text while
      // the pointer is still on its way to the option.
      option.addEventListener("pointerdown", (event) => event.preventDefault());
      option.addEventListener("pointerenter", () => setActive(index, false));
      option.addEventListener("click", () => choose(id));
      popup?.append(option);
    });
  }

  function open(): void {
    if (popup) return;
    activeClose?.();
    const rect = input.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;

    const element = document.createElement("div");
    element.className = "prefs-combo-popup";
    element.id = listId;
    element.setAttribute("role", "listbox");
    element.setAttribute("aria-label", "Fetched models");
    document.body.append(element);
    popup = element;

    setExpanded(true);
    render("");
    position();
    const index = visible.indexOf(input.value.trim());
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
    // the panel would move the input under a fixed popup, so those close it.
    if (event.target instanceof Node && popup?.contains(event.target)) return;
    close();
  }

  function choose(id: string): void {
    input.value = id;
    close();
    input.focus();
    options.choose(id);
  }

  function closeWhenFocusLeaves(): void {
    // The pointer path keeps the field focused via preventDefault on the
    // option, so a focus change here is a real exit from the control.
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
      // A field with no fetched list is just text; do not open an empty card
      // for every keystroke of a hand-typed id.
      if (options.models().length === 0) return;
      open();
      if (!popup) return;
    }
    render(input.value);
  });

  input.addEventListener("keydown", (event) => {
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
      if (popup && activeIndex >= 0 && visible[activeIndex]) {
        event.preventDefault();
        choose(visible[activeIndex]);
        return;
      }
      if (popup) close();
      // Endpoints without a list are used by typing the id and pressing Enter;
      // a text input fires `change` only on blur, so commit it here.
      input.dispatchEvent(new Event("change", { bubbles: true }));
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
