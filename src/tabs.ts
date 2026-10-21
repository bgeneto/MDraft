//! The document tab strip.
//!
//! Rendering, overflow navigation, the context menu, drag reordering and the
//! keyboard model live here so `main.ts` keeps owning documents rather than
//! pixels. The shell passes in the session store and the actions a menu entry
//! may run; this module never touches the editor.

import type { Session, SessionStore } from "./sessions";

export interface TabsCallbacks {
  /** The tab currently on screen. */
  activeId: () => string;
  activate: (id: string) => void | Promise<void>;
  close: (id: string) => void | Promise<void>;
  closeMany: (ids: readonly string[]) => void | Promise<void>;
  save: (id: string) => void | Promise<void>;
  saveAs: (id: string) => void | Promise<void>;
  reveal: (id: string) => void | Promise<void>;
  newTab: () => void | Promise<void>;
  /** Format the clicked document, active or in the background. */
  format: (id: string) => void | Promise<void>;
  /** Why Format Document cannot run for this tab, or null when it can. */
  formatBlocked: (id: string) => string | null;
}

export interface TabsOptions {
  /** The scroll viewport (`#doc-tabs`), not its outer frame. */
  bar: HTMLElement;
  wrapper: HTMLElement;
  leftButton: HTMLButtonElement;
  rightButton: HTMLButtonElement;
  store: SessionStore;
  callbacks: TabsCallbacks;
}

export interface TabsUi {
  render(): void;
}

type MenuEntry =
  | { kind: "separator" }
  | {
      kind: "item";
      id: string;
      label: string;
      action: () => void | Promise<void>;
      disabled?: boolean;
      shortcut?: string;
      /** Shown as the button's tooltip, usually why it is disabled. */
      title?: string;
    };

const IS_MAC = /Mac|iPhone|iPad/.test(navigator.userAgent);

/** A menu hint in the platform's own spelling. */
function shortcutLabel(key: string, shift = false): string {
  return IS_MAC ? `${shift ? "\u21e7" : ""}\u2318${key}` : `Ctrl+${shift ? "Shift+" : ""}${key}`;
}

function isElement(target: EventTarget | null): target is Element {
  return target instanceof Element;
}

export function createTabsUi(options: TabsOptions): TabsUi {
  const { bar, wrapper, leftButton, rightButton, store, callbacks } = options;

  let scrollStateFrame = 0;
  let suppressClickUntil = 0;

  // Drag state. The marker is the thin accent line between two tabs.
  let dragId: string | null = null;
  let dropMarker: HTMLElement | null = null;
  let autoScrollTimer = 0;
  let autoScrollDirection = 0;

  // Context menu state. One menu is reused for every tab and for the empty
  // strip, so only one can ever be open.
  const menu = document.createElement("div");
  menu.className = "tab-menu";
  menu.hidden = true;
  menu.role = "menu";
  menu.tabIndex = -1;
  document.body.append(menu);

  let menuTargetId: string | null = null;
  let menuTrigger: HTMLElement | null = null;

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  function findTab(id: string): HTMLElement | null {
    return (
      Array.from(bar.querySelectorAll<HTMLElement>(".doc-tab")).find(
        (tab) => tab.dataset.id === id,
      ) ?? null
    );
  }

  function focusTab(id: string): void {
    findTab(id)?.focus({ preventScroll: true });
  }

  function createTab(session: Session, active: boolean): HTMLElement {
    const tab = document.createElement("div");
    tab.className = "doc-tab" + (session.dirty ? " is-dirty" : "");
    tab.dataset.id = session.id;
    tab.role = "tab";
    tab.tabIndex = active ? 0 : -1;
    tab.draggable = true;
    tab.setAttribute("aria-selected", String(active));
    tab.setAttribute(
      "aria-label",
      session.dirty ? `${session.name}, unsaved changes` : session.name,
    );
    tab.title = session.path ?? session.name;

    const name = document.createElement("span");
    name.className = "doc-tab-name";
    name.textContent = session.name;

    const mark = document.createElement("span");
    mark.className = "doc-tab-dirty";
    mark.title = "Unsaved changes";
    mark.setAttribute("aria-hidden", "true");

    const close = document.createElement("button");
    close.type = "button";
    close.className = "doc-tab-close";
    close.tabIndex = -1;
    close.draggable = false;
    close.title = `Close ${session.name}`;
    close.setAttribute("aria-label", `Close ${session.name}`);
    close.textContent = "\u00d7";

    tab.append(name, mark, close);
    return tab;
  }

  /** Keep the active tab inside the scroll viewport, with a little breathing room. */
  function revealActive(): void {
    const selected = findTab(callbacks.activeId());
    if (!selected) return;
    const viewport = bar.getBoundingClientRect();
    const tab = selected.getBoundingClientRect();
    const margin = 6;
    if (tab.left < viewport.left + margin) {
      bar.scrollLeft -= viewport.left + margin - tab.left;
    } else if (tab.right > viewport.right - margin) {
      bar.scrollLeft += tab.right - (viewport.right - margin);
    }
  }

  function updateScrollState(): void {
    const max = bar.scrollWidth - bar.clientWidth;
    const overflowing = max > 1;
    const canScrollLeft = overflowing && bar.scrollLeft > 1;
    const canScrollRight = overflowing && bar.scrollLeft < max - 1;

    wrapper.classList.toggle("is-overflowing", overflowing);
    wrapper.classList.toggle("can-scroll-left", canScrollLeft);
    wrapper.classList.toggle("can-scroll-right", canScrollRight);
    bar.classList.toggle("has-left-shadow", canScrollLeft);
    bar.classList.toggle("has-right-shadow", canScrollRight);

    leftButton.disabled = !canScrollLeft;
    rightButton.disabled = !canScrollRight;
  }

  function scheduleScrollState(): void {
    if (scrollStateFrame) return;
    scrollStateFrame = window.requestAnimationFrame(() => {
      scrollStateFrame = 0;
      updateScrollState();
    });
  }

  function render(): void {
    // A tab can disappear through Ctrl+W while its menu is open; a menu that
    // targets a session no longer in the list would act on nothing.
    if (!menu.hidden && menuTargetId && !store.byId(menuTargetId)) closeMenu(false);

    const focused = document.activeElement;
    const focusedTab = isElement(focused) ? focused.closest<HTMLElement>(".doc-tab") : null;
    const focusedClose = isElement(focused) && focused.closest(".doc-tab-close") !== null;
    const focusedId = focusedTab?.dataset.id ?? null;

    const activeId = callbacks.activeId();
    const tabs = store.list().map((session) => createTab(session, session.id === activeId));
    bar.replaceChildren(...tabs);

    updateScrollState();
    revealActive();
    // The toolbar appearing narrows the viewport, so reveal once more on the
    // next frame, after that layout change has happened.
    window.requestAnimationFrame(() => {
      updateScrollState();
      revealActive();
    });

    if (focusedId) {
      const again = findTab(focusedId);
      if (again) {
        const target = focusedClose
          ? again.querySelector<HTMLButtonElement>(".doc-tab-close")
          : again;
        target?.focus({ preventScroll: true });
      } else if (focusedTab) {
        // The focused tab was closed by the action that triggered this render.
        focusTab(activeId);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Context menu
  // -------------------------------------------------------------------------

  function entriesForTab(id: string): MenuEntry[] | null {
    const list = store.list();
    const index = list.findIndex((session) => session.id === id);
    if (index < 0) return null;
    const session = list[index];
    const left = list.slice(0, index).map((entry) => entry.id);
    const right = list.slice(index + 1).map((entry) => entry.id);
    const unchanged = list
      .filter((entry) => entry.id !== id && !entry.dirty)
      .map((entry) => entry.id);
    const formatBlocked = callbacks.formatBlocked(id);

    const runMany = (ids: readonly string[]) => callbacks.closeMany(ids);

    return [
      {
        kind: "item",
        id: "close",
        label: "Close",
        shortcut: shortcutLabel("W"),
        action: () => callbacks.close(id),
      },
      {
        kind: "item",
        id: "closeOthers",
        label: "Close Others",
        disabled: list.length === 1,
        action: () => runMany(list.filter((entry) => entry.id !== id).map((entry) => entry.id)),
      },
      {
        kind: "item",
        id: "closeLeft",
        label: "Close All to the Left",
        disabled: left.length === 0,
        action: () => runMany(left),
      },
      {
        kind: "item",
        id: "closeRight",
        label: "Close All to the Right",
        disabled: right.length === 0,
        action: () => runMany(right),
      },
      {
        kind: "item",
        id: "closeUnchanged",
        label: "Close Unchanged",
        disabled: unchanged.length === 0,
        action: () => runMany(unchanged),
      },
      { kind: "separator" },
      {
        kind: "item",
        id: "save",
        label: "Save",
        shortcut: shortcutLabel("S"),
        disabled: !session.dirty,
        action: () => callbacks.save(id),
      },
      {
        kind: "item",
        id: "saveAs",
        label: "Save As\u2026",
        shortcut: shortcutLabel("S", true),
        action: () => callbacks.saveAs(id),
      },
      { kind: "separator" },
      {
        kind: "item",
        id: "format",
        label: "Format Document",
        disabled: formatBlocked !== null,
        title: formatBlocked ?? undefined,
        action: () => callbacks.format(id),
      },
      { kind: "separator" },
      {
        kind: "item",
        id: "reveal",
        label: "Reveal in File Manager",
        disabled: !session.path,
        action: () => callbacks.reveal(id),
      },
    ];
  }

  function entriesForBar(): MenuEntry[] {
    const list = store.list();
    const activeId = callbacks.activeId();
    // Keep the active tab. "Close Unchanged" is a way to shed clean tabs, not
    // a way to end up with no buffer at all.
    const unchanged = list
      .filter((session) => session.id !== activeId && !session.dirty)
      .map((session) => session.id);

    return [
      {
        kind: "item",
        id: "new",
        label: "New Tab",
        shortcut: shortcutLabel("N"),
        action: () => callbacks.newTab(),
      },
      { kind: "separator" },
      {
        kind: "item",
        id: "closeAll",
        label: "Close All Tabs",
        action: () => callbacks.closeMany(list.map((session) => session.id)),
      },
      {
        kind: "item",
        id: "closeUnchanged",
        label: "Close Unchanged",
        disabled: unchanged.length === 0,
        action: () => callbacks.closeMany(unchanged),
      },
    ];
  }

  function choose(entry: Extract<MenuEntry, { kind: "item" }>): void {
    if (entry.disabled) return;
    const target = menuTargetId;
    closeMenu(false);

    const task = (() => {
      try {
        return Promise.resolve(entry.action());
      } catch (error) {
        return Promise.reject(error);
      }
    })();

    void task
      .catch((error) => console.error("[tabs] menu action failed", error))
      .finally(() => {
        const focusId =
          target && store.byId(target)
            ? target
            : store.list().length > 0
              ? callbacks.activeId()
              : null;
        if (focusId) focusTab(focusId);
      });
  }

  function menuEntry(entry: MenuEntry): HTMLElement {
    if (entry.kind === "separator") {
      const separator = document.createElement("div");
      separator.className = "tab-menu-sep";
      separator.role = "separator";
      return separator;
    }

    const button = document.createElement("button");
    button.type = "button";
    button.className = "tab-menu-item";
    button.role = "menuitem";
    button.tabIndex = -1;
    button.dataset.action = entry.id;
    button.disabled = entry.disabled === true;
    if (entry.title) button.title = entry.title;

    const label = document.createElement("span");
    label.className = "tab-menu-label";
    label.textContent = entry.label;
    button.append(label);

    if (entry.shortcut) {
      const hint = document.createElement("span");
      hint.className = "tab-menu-shortcut";
      hint.textContent = entry.shortcut;
      button.append(hint);
    }

    button.addEventListener("click", () => choose(entry));
    return button;
  }

  function openMenu(
    targetId: string | null,
    clientX: number,
    clientY: number,
    trigger: HTMLElement,
  ): void {
    const entries = targetId ? entriesForTab(targetId) : entriesForBar();
    if (!entries) return;
    menuTargetId = targetId;
    menuTrigger = trigger;
    menu.replaceChildren(...entries.map(menuEntry));
    menu.hidden = false;
    menu.style.left = "0px";
    menu.style.top = "0px";

    const bounds = menu.getBoundingClientRect();
    const margin = 6;
    const width = Math.min(bounds.width, window.innerWidth - margin * 2);
    const height = Math.min(bounds.height, window.innerHeight - margin * 2);
    const left = Math.min(
      Math.max(margin, clientX),
      Math.max(margin, window.innerWidth - width - margin),
    );
    const top = Math.min(
      Math.max(margin, clientY),
      Math.max(margin, window.innerHeight - height - margin),
    );
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;

    menu.querySelector<HTMLButtonElement>(".tab-menu-item:not(:disabled)")?.focus({
      preventScroll: true,
    });
  }

  function closeMenu(restoreFocus: boolean): void {
    if (menu.hidden) return;
    menu.hidden = true;
    menu.replaceChildren();
    const trigger = menuTrigger;
    menuTrigger = null;
    menuTargetId = null;
    if (restoreFocus && trigger?.isConnected) trigger.focus({ preventScroll: true });
  }

  menu.addEventListener("contextmenu", (event) => event.preventDefault());
  menu.addEventListener("keydown", (event) => {
    const items = Array.from(
      menu.querySelectorAll<HTMLButtonElement>(".tab-menu-item:not(:disabled)"),
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
        // Returning to the trigger is less surprising than leaving focus on a
        // menu that has just disappeared.
        event.preventDefault();
        closeMenu(true);
        return;
      default:
        return;
    }
    items[index]?.focus({ preventScroll: true });
  });

  // Any click outside the menu dismisses it before the click reaches the tab.
  document.addEventListener(
    "pointerdown",
    (event) => {
      if (menu.hidden) return;
      if (event.target instanceof Node && menu.contains(event.target)) return;
      closeMenu(false);
    },
    true,
  );

  document.addEventListener(
    "contextmenu",
    (event) => {
      if (menu.hidden) return;
      if (event.target instanceof Node && menu.contains(event.target)) return;
      closeMenu(false);
    },
    true,
  );

  document.addEventListener(
    "keydown",
    (event) => {
      if (menu.hidden || event.key !== "Escape") return;
      event.preventDefault();
      closeMenu(true);
    },
    true,
  );

  window.addEventListener("resize", () => {
    closeMenu(false);
    scheduleScrollState();
  });

  // -------------------------------------------------------------------------
  // Scrolling
  // -------------------------------------------------------------------------

  function scrollByPage(direction: number): void {
    const amount = Math.max(140, Math.round(bar.clientWidth * 0.6));
    bar.scrollBy({ left: direction * amount, behavior: "smooth" });
  }

  leftButton.addEventListener("click", () => scrollByPage(-1));
  rightButton.addEventListener("click", () => scrollByPage(1));

  bar.addEventListener(
    "scroll",
    () => {
      closeMenu(false);
      scheduleScrollState();
    },
    { passive: true },
  );

  // A vertical wheel over a one-line strip means "move along the strip". This
  // is what makes a plain mouse work without aiming at the arrows.
  bar.addEventListener(
    "wheel",
    (event) => {
      if (event.ctrlKey || event.metaKey) return;
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      if (bar.scrollWidth <= bar.clientWidth + 1) return;
      const amount =
        event.deltaMode === 1
          ? event.deltaY * 16
          : event.deltaMode === 2
            ? event.deltaY * bar.clientWidth
            : event.deltaY;
      event.preventDefault();
      bar.scrollLeft += amount;
    },
    { passive: false },
  );

  if (typeof ResizeObserver !== "undefined") {
    new ResizeObserver(() => {
      updateScrollState();
      // A narrower window (or the toolbar appearing) must not hide the tab the
      // reader is working in.
      revealActive();
    }).observe(bar);
  }
  void document.fonts.ready.then(() => {
    updateScrollState();
    revealActive();
  });

  // -------------------------------------------------------------------------
  // Clicks and keyboard
  // -------------------------------------------------------------------------

  function run(action: () => void | Promise<void>, what: string): void {
    try {
      void Promise.resolve(action()).catch((error) =>
        console.error(`[tabs] ${what} failed`, error),
      );
    } catch (error) {
      console.error(`[tabs] ${what} failed`, error);
    }
  }

  bar.addEventListener("click", (event) => {
    if (performance.now() < suppressClickUntil) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    const tab = target.closest<HTMLElement>(".doc-tab");
    const id = tab?.dataset.id;
    if (!id) return;
    if (target.closest(".doc-tab-close")) {
      run(() => callbacks.close(id), "close");
      return;
    }
    run(() => callbacks.activate(id), "activate");
  });

  // Middle-click closes, the same gesture as a browser tab.
  bar.addEventListener("auxclick", (event) => {
    if (event.button !== 1) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    const id = target.closest<HTMLElement>(".doc-tab")?.dataset.id;
    if (!id) return;
    event.preventDefault();
    run(() => callbacks.close(id), "close");
  });

  // Double-clicking the empty part of the strip starts a document, the way a
  // browser's empty tab strip does.
  bar.addEventListener("dblclick", (event) => {
    if (isElement(event.target) && event.target.closest(".doc-tab")) return;
    run(() => callbacks.newTab(), "new tab");
  });

  wrapper.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    const target = event.target;
    if (!isElement(target)) return;
    const tab = target.closest<HTMLElement>(".doc-tab");
    if (tab?.dataset.id) {
      openMenu(tab.dataset.id, event.clientX, event.clientY, tab);
      return;
    }
    openMenu(null, event.clientX, event.clientY, wrapper);
  });

  function neighbour(id: string, delta: number): string | null {
    const list = store.list();
    const index = list.findIndex((session) => session.id === id);
    if (index < 0) return null;
    return list[(index + delta + list.length) % list.length]?.id ?? null;
  }

  function activateAndFocus(id: string): void {
    run(
      () =>
        Promise.resolve(callbacks.activate(id)).finally(() => {
          // displayDoc() puts focus in the editor; a tab chosen with the
          // keyboard belongs under the keyboard's finger.
          focusTab(id);
        }),
      "activate",
    );
  }

  function reorder(tab: HTMLElement, delta: number): void {
    const id = tab.dataset.id;
    if (!id) return;
    const list = store.list();
    const index = list.findIndex((session) => session.id === id);
    if (index < 0) return;
    const target = Math.max(0, Math.min(list.length - 1, index + delta));
    if (target === index) return;
    store.move(id, target);
    render();
    focusTab(id);
  }

  bar.addEventListener("keydown", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest(".doc-tab-close")) return;
    const tab = target.closest<HTMLElement>(".doc-tab");
    const id = tab?.dataset.id;
    if (!tab || !id) return;

    if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
      event.preventDefault();
      const bounds = tab.getBoundingClientRect();
      openMenu(id, bounds.left + 8, bounds.bottom + 2, tab);
      return;
    }

    if (
      event.altKey &&
      event.shiftKey &&
      (event.key === "ArrowLeft" || event.key === "ArrowRight")
    ) {
      event.preventDefault();
      reorder(tab, event.key === "ArrowLeft" ? -1 : 1);
      return;
    }

    if (event.ctrlKey || event.metaKey || event.altKey) return;

    switch (event.key) {
      case "ArrowLeft": {
        event.preventDefault();
        const previous = neighbour(id, -1);
        if (previous) activateAndFocus(previous);
        break;
      }
      case "ArrowRight": {
        event.preventDefault();
        const next = neighbour(id, 1);
        if (next) activateAndFocus(next);
        break;
      }
      case "Home": {
        event.preventDefault();
        const first = store.list()[0];
        if (first && first.id !== id) activateAndFocus(first.id);
        break;
      }
      case "End": {
        event.preventDefault();
        const list = store.list();
        const last = list[list.length - 1];
        if (last && last.id !== id) activateAndFocus(last.id);
        break;
      }
      case "Enter":
      case " ":
        event.preventDefault();
        activateAndFocus(id);
        break;
      default:
        break;
    }
  });

  // -------------------------------------------------------------------------
  // Drag reordering
  // -------------------------------------------------------------------------

  function tabsWithoutDrag(): HTMLElement[] {
    return Array.from(bar.querySelectorAll<HTMLElement>(".doc-tab")).filter(
      (tab) => tab.dataset.id !== dragId,
    );
  }

  /** The final index a drop at `clientX` would produce. */
  function dropIndex(clientX: number): number {
    const tabs = tabsWithoutDrag();
    for (let index = 0; index < tabs.length; index += 1) {
      const bounds = tabs[index].getBoundingClientRect();
      if (clientX < bounds.left + bounds.width / 2) return index;
    }
    return tabs.length;
  }

  function showDropMarker(index: number): void {
    if (!dragId) return;
    if (!dropMarker) {
      dropMarker = document.createElement("div");
      dropMarker.className = "doc-tab-drop";
      dropMarker.setAttribute("aria-hidden", "true");
    }
    const tabs = tabsWithoutDrag();
    bar.insertBefore(dropMarker, tabs[index] ?? null);
  }

  function setAutoScroll(direction: number): void {
    if (direction === autoScrollDirection) return;
    autoScrollDirection = direction;
    window.clearInterval(autoScrollTimer);
    autoScrollTimer = 0;
    if (direction === 0) return;
    autoScrollTimer = window.setInterval(() => {
      bar.scrollLeft += direction * 14;
    }, 32);
  }

  function cleanupDrag(): void {
    dropMarker?.remove();
    dropMarker = null;
    bar.querySelector(".doc-tab.is-dragging")?.classList.remove("is-dragging");
    bar.classList.remove("is-reordering");
    setAutoScroll(0);
    dragId = null;
  }

  bar.addEventListener("dragstart", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const tab = target.closest<HTMLElement>(".doc-tab");
    if (!tab || target.closest(".doc-tab-close")) {
      event.preventDefault();
      return;
    }
    const id = tab.dataset.id;
    if (!id) return;

    closeMenu(false);
    dragId = id;
    tab.classList.add("is-dragging");
    bar.classList.add("is-reordering");
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "move";
      try {
        event.dataTransfer.setData("text/plain", id);
      } catch {
        /* synthetic drag events may not carry a real DataTransfer */
      }
    }
  });

  bar.addEventListener("dragenter", (event) => {
    if (!dragId) return;
    event.preventDefault();
  });

  bar.addEventListener("dragover", (event) => {
    if (!dragId) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    showDropMarker(dropIndex(event.clientX));

    const bounds = bar.getBoundingClientRect();
    const edge = 28;
    if (event.clientX < bounds.left + edge) setAutoScroll(-1);
    else if (event.clientX > bounds.right - edge) setAutoScroll(1);
    else setAutoScroll(0);
  });

  bar.addEventListener("dragleave", (event) => {
    if (!dragId) return;
    const next = event.relatedTarget;
    if (next instanceof Node && bar.contains(next)) return;
    dropMarker?.remove();
    dropMarker = null;
    setAutoScroll(0);
  });

  bar.addEventListener("drop", (event) => {
    if (!dragId) return;
    event.preventDefault();
    const id = dragId;
    const index = dropIndex(event.clientX);
    cleanupDrag();
    suppressClickUntil = performance.now() + 200;
    store.move(id, index);
    render();
    focusTab(id);
  });

  bar.addEventListener("dragend", () => {
    cleanupDrag();
    suppressClickUntil = performance.now() + 200;
  });

  // -------------------------------------------------------------------------
  // Initial state
  // -------------------------------------------------------------------------

  scheduleScrollState();

  return { render };
}
