//! A searchable picker for the four typography roles.
//!
//! The old control was a native `<select>` over a hard-coded list: usable at
//! twenty entries, unusable once the list is every family the operating system
//! exposes. This picker opens the complete list, draws each name in its own
//! face, and filters only while the reader types. A saved family that is no
//! longer installed is kept as a visible warning rather than silently showing
//! the fallback.
//!
//! The popup is appended to the document body, like the AI model picker: the
//! Preferences content scrolls and an absolutely positioned list inside it
//! would be clipped at the panel's edge. The search field lives inside the
//! popup rather than in the trigger, so the field never becomes a second way to
//! store a family name.

export type FontGroup = "default" | "bundled" | "system" | "suggested" | "custom";

export interface FontChoice {
  /** Key this choice is selected by: the family name, a raw stack, or "". */
  value: string;
  /** Text shown in the trigger and the option. */
  label: string;
  group: FontGroup;
  /** Full CSS stack this choice stores. */
  stack: string;
  /** A saved family the current scan did not find. */
  missing?: boolean;
}

export interface FontPickerOptions {
  /** The role's visible label, for assistive technology. */
  label: string;
  /** Read on every open and filter; the system scan may arrive later. */
  choices: () => readonly FontChoice[];
  /** The current choice's `value`. */
  selected: () => string;
  /** The role fallback, for the default choice's specimen. */
  fallback: string;
  /** Persist the choice. The caller rerenders the panel afterwards. */
  choose: (choice: FontChoice) => void;
}

let activeClose: (() => void) | null = null;
let nextListId = 0;

/** Close the open font picker, for a panel redraw or a closed Preferences. */
export function closeFontPicker(): void {
  activeClose?.();
}

const GROUP_LABELS: Record<FontGroup, string> = {
  default: "Default",
  bundled: "Bundled",
  system: "Installed",
  suggested: "Suggested",
  custom: "This document",
};

/** Case-insensitive comparison for family names; stacks are not compared. */
function sameValue(a: string, b: string): boolean {
  return a === b || (a !== "" && b !== "" && a.toLowerCase() === b.toLowerCase());
}

/** Lowercase and strip diacritics so "uber" finds "Über". */
function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/**
 * Attach the trigger and its popup to a Preferences row.
 *
 * The returned element is the trigger wrapper; the popup is created on every
 * open and removed on close, so a panel rerender cannot leave a list pointing
 * at a detached field.
 */
export function attachFontPicker(options: FontPickerOptions): HTMLElement {
  const listId = `prefs-font-list-${++nextListId}`;

  const wrap = document.createElement("div");
  wrap.className = "prefs-font-picker";

  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "prefs-font-trigger";
  trigger.setAttribute("role", "combobox");
  trigger.setAttribute("aria-haspopup", "listbox");
  trigger.setAttribute("aria-expanded", "false");
  trigger.setAttribute("aria-label", options.label);

  const preview = document.createElement("span");
  preview.className = "prefs-font-preview";
  preview.setAttribute("aria-hidden", "true");

  const current = document.createElement("span");
  current.className = "prefs-font-current";

  const caret = caretIcon();
  trigger.append(preview, current, caret);

  function findSelected(choices = options.choices()): FontChoice | null {
    const value = options.selected();
    return (
      choices.find((choice) => sameValue(choice.value, value)) ??
      choices.find((choice) => choice.value === value) ??
      null
    );
  }

  function triggerLabel(choice: FontChoice | null): string {
    if (!choice) return options.selected() || "Default (built-in stack)";
    return choice.missing ? `${choice.label} (not installed)` : choice.label;
  }

  function updateTrigger(): void {
    const choice = findSelected();
    current.textContent = triggerLabel(choice);
    trigger.title = current.textContent;
    const stack = choice?.stack || options.fallback;
    preview.style.fontFamily = stack;
    preview.style.display = stack ? "" : "none";
  }

  let popup: HTMLDivElement | null = null;
  let list: HTMLDivElement | null = null;
  let search: HTMLInputElement | null = null;
  let visible: FontChoice[] = [];
  let activeIndex = -1;

  function setExpanded(expanded: boolean): void {
    trigger.setAttribute("aria-expanded", String(expanded));
    if (expanded) {
      trigger.setAttribute("aria-controls", `${listId}-options`);
    } else {
      trigger.removeAttribute("aria-controls");
      trigger.removeAttribute("aria-activedescendant");
    }
  }

  function optionsList(): HTMLElement[] {
    return list ? [...list.querySelectorAll<HTMLElement>(".prefs-font-option")] : [];
  }

  function setActive(index: number, scroll = true): void {
    const entries = optionsList();
    if (entries.length === 0) {
      activeIndex = -1;
      search?.removeAttribute("aria-activedescendant");
      return;
    }
    const clamped = Math.max(0, Math.min(index, entries.length - 1));
    entries.forEach((entry, position) => {
      entry.classList.toggle("is-active", position === clamped);
    });
    const active = entries[clamped];
    if (!active) return;
    activeIndex = clamped;
    search?.setAttribute("aria-activedescendant", active.id);
    if (scroll) active.scrollIntoView({ block: "nearest" });
  }

  function option(choice: FontChoice, index: number): HTMLDivElement {
    const element = document.createElement("div");
    element.className = "prefs-font-option";
    element.id = `${listId}-option-${index}`;
    element.setAttribute("role", "option");
    element.setAttribute(
      "aria-selected",
      sameValue(choice.value, options.selected()) ? "true" : "false",
    );
    element.dataset.value = choice.value;

    const specimen = document.createElement("span");
    specimen.className = "prefs-font-option-name";
    specimen.style.fontFamily = choice.stack || options.fallback;
    // The specimen is the family name itself; the tag beside it says why a
    // saved family is not in the current scan, without putting that suffix
    // inside the face being previewed.
    specimen.textContent = choice.group === "default" ? "System default" : choice.label;

    const tag = document.createElement("span");
    tag.className = "prefs-font-tag";
    tag.textContent = choice.missing ? "Not installed" : (GROUP_LABELS[choice.group] ?? "");

    element.append(specimen);
    if (tag.textContent) element.append(tag);

    element.addEventListener("pointerdown", (event) => event.preventDefault());
    element.addEventListener("pointerenter", () => setActive(index, false));
    element.addEventListener("click", () => choose(choice));
    return element;
  }

  function emptyRow(text: string): HTMLDivElement {
    const empty = document.createElement("div");
    empty.className = "prefs-font-empty";
    empty.setAttribute("role", "presentation");
    empty.textContent = text;
    empty.addEventListener("pointerdown", (event) => event.preventDefault());
    return empty;
  }

  function render(query: string): void {
    if (!list) return;
    const needle = fold(query.trim());
    const all = options.choices();
    visible = needle
      ? all.filter(
          (choice) =>
            fold(choice.label).includes(needle) ||
            fold(choice.value).includes(needle) ||
            fold(GROUP_LABELS[choice.group] ?? "").includes(needle),
        )
      : [...all];

    activeIndex = -1;
    search?.removeAttribute("aria-activedescendant");
    list.replaceChildren();

    if (visible.length === 0) {
      list.append(
        emptyRow(
          all.length === 0
            ? "No font families are available yet."
            : `No font matches “${query.trim()}”.`,
        ),
      );
      return;
    }

    let group: FontGroup | null = null;
    visible.forEach((choice, index) => {
      if (choice.group !== group) {
        group = choice.group;
        const heading = document.createElement("div");
        heading.className = "prefs-font-group";
        heading.setAttribute("role", "presentation");
        heading.textContent = GROUP_LABELS[choice.group] ?? "";
        list?.append(heading);
      }
      list?.append(option(choice, index));
    });

    const selected = findSelected(visible);
    const selectedIndex = selected ? visible.indexOf(selected) : -1;
    if (selectedIndex >= 0) setActive(selectedIndex, true);
    else setActive(0, false);
  }

  function position(): void {
    if (!popup) return;
    const rect = trigger.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;
    const gap = 4;
    const margin = 8;
    const below = window.innerHeight - rect.bottom - gap - margin;
    const above = rect.top - gap - margin;
    popup.style.left = `${Math.round(rect.left)}px`;
    popup.style.width = `${Math.round(Math.max(rect.width, 320))}px`;
    if (below >= 220 || below >= above) {
      popup.style.top = `${Math.round(rect.bottom + gap)}px`;
      popup.style.bottom = "auto";
      popup.style.maxHeight = `${Math.max(180, Math.min(420, below))}px`;
    } else {
      popup.style.top = "auto";
      popup.style.bottom = `${Math.round(window.innerHeight - rect.top + gap)}px`;
      popup.style.maxHeight = `${Math.max(180, Math.min(420, above))}px`;
    }
  }

  function open(): void {
    if (popup) return;
    activeClose?.();
    const rect = trigger.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;

    const element = document.createElement("div");
    element.className = "prefs-font-popup";
    element.id = listId;
    element.setAttribute("role", "presentation");
    document.body.append(element);
    popup = element;

    const field = document.createElement("input");
    field.type = "search";
    field.className = "prefs-font-search";
    field.placeholder = "Search fonts…";
    field.setAttribute("aria-label", "Search fonts");
    field.setAttribute("aria-controls", `${listId}-options`);
    field.setAttribute("autocomplete", "off");
    field.setAttribute("spellcheck", "false");
    element.append(field);
    search = field;

    const entries = document.createElement("div");
    entries.className = "prefs-font-list";
    entries.id = `${listId}-options`;
    entries.setAttribute("role", "listbox");
    entries.setAttribute("aria-label", "Font families");
    element.append(entries);
    list = entries;

    setExpanded(true);
    render("");
    position();
    field.focus();

    field.addEventListener("input", () => render(field.value));
    field.addEventListener("keydown", onSearchKeyDown);

    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", close);
    activeClose = close;
  }

  function close(): void {
    if (!popup) return;
    popup.remove();
    popup = null;
    list = null;
    search = null;
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
    if (target === trigger || trigger.contains(target) || popup?.contains(target)) return;
    close();
  }

  function onScroll(event: Event): void {
    // Scrolling the list itself is not a reason to dismiss it. Any scroll of
    // the panel would move the trigger under a fixed popup, so those close it.
    if (event.target instanceof Node && popup?.contains(event.target)) return;
    close();
  }

  function choose(choice: FontChoice): void {
    close();
    options.choose(choice);
    // The caller rerenders the panel and replaces this trigger. If it does not,
    // returning focus here keeps the control usable from the keyboard.
    if (trigger.isConnected) trigger.focus();
  }

  function onSearchKeyDown(event: KeyboardEvent): void {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      if (visible.length === 0) return;
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
      event.preventDefault();
      if (activeIndex >= 0 && visible[activeIndex]) choose(visible[activeIndex]);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
      trigger.focus();
      return;
    }
    if (event.key === "Tab") close();
  }

  trigger.addEventListener("click", () => {
    if (popup) {
      close();
      trigger.focus();
      return;
    }
    open();
  });

  trigger.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!popup) open();
      return;
    }
    if (event.key === "Escape" && popup) {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  });

  updateTrigger();
  wrap.append(trigger);
  return wrap;
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
