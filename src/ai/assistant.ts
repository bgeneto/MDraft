//! The AI Assistant's floating control, action palette and result panel.
//!
//! The control is icon-only and draggable inside the source pane. Its position
//! is deliberately session-only: every launch starts at the same bottom-right
//! anchor, and the palette can reset it. The panel is non-modal and never edits
//! the document itself; it asks the host to apply one plan, so undo stays a
//! single step.

import DOMPurify from "dompurify";
import { marked } from "marked";

import * as api from "../api";
import { writeClipboardText } from "../clipboard";
import {
  LANGUAGES,
  TONES,
  actionById,
  convertTargets,
  defaultParameter,
  groupedActions,
  parameterIsValid,
  searchActions,
  type AiActionSpec,
} from "./actions";
import {
  anchorFromPosition,
  blockInsertion,
  buildRequest,
  clampButtonPosition,
  defaultButtonPosition,
  joinContinuation,
  movedEnough,
  positionFromAnchor,
  targetIsCurrent,
  trimHistory,
  trimPreceding,
  type ApplyPlan,
  type Capture,
  type PaneAnchor,
  type Point,
} from "./context";
import { diffSummary, wordDiff } from "./diff";
import {
  MAX_AI_HISTORY,
  formatHistoryAge,
  historyTitle,
  previewText,
  rememberRequest,
  type AiHistoryEntry,
} from "./history";

const BUTTON_SIZE = 40;
const PALETTE_WIDTH = 340;
const PANEL_WIDTH = 440;
const MIN_PANEL_WIDTH = 320;
const MIN_PANEL_HEIGHT = 240;
const PANE_MARGIN = 8;
const ANCHOR_SIDE_MARGIN = 20;

/** A resized assistant popover, in pane coordinates, for this session only. */
interface PopoverRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface AssistantConfig {
  enabled: boolean;
  provider: api.AiProvider;
  baseUrl: string;
  model: string;
}

export interface AssistantHost {
  config(): AssistantConfig;
  language(): api.DocumentLanguage;
  capture(): Capture;
  sessionId(): string;
  revision(): number;
  canWrite(): boolean;
  apply(plan: ApplyPlan): boolean;
  focusEditor(): void;
  toast(text: string): void;
  openSettings(): void;
  /** Turn the assistant on or off from its own menu. */
  setEnabled(enabled: boolean): void;
  /** The name shown in a history row: the tab's document name. */
  documentName(): string;
}

export interface AssistantHandle {
  /** Re-read the configuration and show or hide the button. */
  sync(): void;
  close(): void;
  /** Stop an in-flight request; the panel stays open on its partial answer. */
  cancel(): void;
  /** Return the floating button to its bottom-right anchor. */
  resetPosition(): void;
  onViewMode(mode: api.ViewMode): void;
  isOpen(): boolean;
}

type PanelState = "idle" | "parameter" | "running" | "done" | "error";

const numberFormat = new Intl.NumberFormat();

function formatCount(value: number): string {
  return numberFormat.format(value);
}

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl.trim()).host;
  } catch {
    return "";
  }
}

function iconSvg(inner: string): string {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
}

function markdownHtml(text: string): string {
  const rendered = marked.parse(text, { async: false });
  const html = DOMPurify.sanitize(typeof rendered === "string" ? rendered : text, {
    USE_PROFILES: { html: true },
  });
  const template = document.createElement("template");
  template.innerHTML = html;
  // A link in an answer must not navigate the application window. Keep the
  // address as a tooltip and leave the text selectable.
  for (const anchor of template.content.querySelectorAll("a")) {
    anchor.title = anchor.getAttribute("href") ?? "";
    anchor.removeAttribute("href");
  }
  const container = document.createElement("div");
  container.appendChild(template.content);
  // A model answer can contain a table wider than the 440 px panel. A table is
  // not a scroll container of its own, so wrap it: the wrapper scrolls while
  // the rows keep their table layout.
  for (const table of container.querySelectorAll("table")) {
    const scroller = document.createElement("div");
    scroller.className = "ai-table-scroll";
    table.replaceWith(scroller);
    scroller.appendChild(table);
  }
  return container.innerHTML;
}

export function createAssistant(pane: HTMLElement, host: AssistantHost): AssistantHandle {
  const root = document.createElement("div");
  root.className = "ai-assistant";
  root.hidden = true;
  root.innerHTML = `
    <button class="ai-fab" type="button" aria-label="AI Assistant" aria-haspopup="menu" aria-expanded="false" title="AI Assistant">
      <svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64" aria-hidden="true" focusable="false">
        <defs>
          <linearGradient id="ai-fab-blue" x1="10" y1="7" x2="52" y2="57" gradientUnits="userSpaceOnUse">
            <stop stop-color="#4895FF" />
            <stop offset="1" stop-color="#1763DC" />
          </linearGradient>
          <filter id="ai-fab-shadow" x="-30%" y="-30%" width="160%" height="170%">
            <feDropShadow dx="0" dy="3" stdDeviation="3" flood-color="#17488F" flood-opacity=".23" />
          </filter>
        </defs>
        <circle cx="32" cy="31" r="27" fill="url(#ai-fab-blue)" filter="url(#ai-fab-shadow)" />
        <path d="M0 0H34L72 39L110 0H144V106H111V48L72 87L33 48V106H0Z" transform="translate(19.1 21.5) scale(.17916667)" fill="#FFFFFF" />
        <path d="M21.35 43.35 32 49.25 42.65 43.35V45.9L32 51.8 21.35 45.9Z" fill="#00C2FF" />
        <path d="M41.2 8.0 42.27 10.73 45.0 11.8 42.27 12.87 41.2 15.6 40.13 12.87 37.4 11.8 40.13 10.73Z" fill="#FFFFFF" />
        <path d="M48.200 12.650 50.045 17.555 54.950 19.400 50.045 21.245 48.200 26.150 46.355 21.245 41.450 19.400 46.355 17.555Z" fill="#FFFFFF" />
      </svg>
    </button>
    <div class="ai-popover ai-palette" role="dialog" aria-label="AI Assistant actions" hidden>
      <div class="ai-search-row">
        ${iconSvg('<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5L21 21"/>')}
        <input class="ai-search" type="search" placeholder="Search actions…" aria-label="Search AI actions" autocomplete="off" />
      </div>
      <div class="ai-actions" role="listbox" aria-label="AI actions"></div>
      <div class="ai-palette-footer">
        <button class="ai-link" type="button" data-command="history">History</button>
        <button class="ai-link" type="button" data-command="settings">AI Assistant Settings…</button>
      </div>
    </div>
    <div class="ai-popover ai-history" role="dialog" aria-labelledby="ai-history-title" hidden>
      <header class="ai-panel-header ai-history-header">
        <button class="ai-resize" type="button" aria-label="Resize the history panel" title="Drag the corner to resize; double-click to reset; the arrow keys also adjust."></button>
        <button class="ai-history-back" type="button" title="Back to history" aria-label="Back to history" hidden>
          ${iconSvg('<path d="M15 18l-6-6 6-6"/>')}
        </button>
        <div class="ai-panel-heading ai-history-heading">
          <h2 id="ai-history-title" class="ai-panel-title ai-history-title">History</h2>
          <span class="ai-chip ai-history-count" hidden></span>
        </div>
        <button class="ai-history-close" type="button" title="Close" aria-label="Close history">✕</button>
      </header>
      <div class="ai-history-list" aria-label="AI Assistant history"></div>
      <div class="ai-history-detail" hidden></div>
      <footer class="ai-history-footer">
        <button class="ai-link ai-history-clear" type="button">Clear history</button>
        <span class="ai-history-footer-note">This session only</span>
      </footer>
    </div>
    <section class="ai-popover ai-panel" role="dialog" aria-modal="false" aria-labelledby="ai-panel-title" hidden>
      <header class="ai-panel-header">
        <button class="ai-resize" type="button" aria-label="Resize the assistant panel" title="Drag the corner to resize; double-click to reset; the arrow keys also adjust."></button>
        <div class="ai-panel-heading">
          <h2 id="ai-panel-title" class="ai-panel-title">AI Assistant</h2>
          <span class="ai-chip" hidden></span>
        </div>
        <button class="ai-close icon-btn" type="button" title="Close" aria-label="Close AI Assistant">✕</button>
      </header>
      <div class="ai-panel-body">
        <div class="ai-params" hidden></div>
        <details class="ai-context">
          <summary class="ai-context-summary"></summary>
          <pre class="ai-context-text"></pre>
        </details>
        <div class="ai-result" hidden>
          <div class="ai-result-head">
            <span class="ai-result-label">Answer</span>
            <span class="ai-changes-summary"></span>
            <div class="ai-toggle" role="group" aria-label="Answer view">
              <button class="ai-toggle-btn active" type="button" data-view="result">Result</button>
              <button class="ai-toggle-btn" type="button" data-view="changes">Changes</button>
            </div>
          </div>
          <div class="ai-answer ai-markdown"></div>
          <details class="ai-chat-source ai-answer-source" hidden>
            <summary>Source</summary>
            <pre class="ai-answer-source-text"></pre>
          </details>
          <div class="ai-diff" hidden></div>
          <details class="ai-notes" hidden>
            <summary>What changed</summary>
            <div class="ai-notes-text"></div>
          </details>
        </div>
        <div class="ai-chat" hidden></div>
        <div class="ai-ask-row" hidden>
          <textarea class="ai-ask-input" rows="2" placeholder="Ask about the selection, or ask anything…" aria-label="Ask the AI Assistant"></textarea>
          <button class="ai-generate" type="button">Generate</button>
        </div>
      </div>
      <footer class="ai-panel-footer">
        <span class="ai-status" role="status" aria-live="polite"></span>
        <div class="ai-footer-actions"></div>
      </footer>
    </section>`;
  pane.appendChild(root);

  const button = root.querySelector<HTMLButtonElement>(".ai-fab")!;
  const palette = root.querySelector<HTMLDivElement>(".ai-palette")!;
  const search = root.querySelector<HTMLInputElement>(".ai-search")!;
  const actionsEl = root.querySelector<HTMLDivElement>(".ai-actions")!;
  const historyEl = root.querySelector<HTMLDivElement>(".ai-history")!;
  const historyTitleEl = root.querySelector<HTMLElement>(".ai-history-title")!;
  const historyCount = root.querySelector<HTMLElement>(".ai-history-count")!;
  const historyBack = root.querySelector<HTMLButtonElement>(".ai-history-back")!;
  const historyClose = root.querySelector<HTMLButtonElement>(".ai-history-close")!;
  const historyList = root.querySelector<HTMLDivElement>(".ai-history-list")!;
  const historyDetail = root.querySelector<HTMLDivElement>(".ai-history-detail")!;
  const historyFooter = root.querySelector<HTMLElement>(".ai-history-footer")!;
  const historyClear = root.querySelector<HTMLButtonElement>(".ai-history-clear")!;
  const panel = root.querySelector<HTMLElement>(".ai-panel")!;
  const panelTitle = root.querySelector<HTMLElement>(".ai-panel-title")!;
  const chip = root.querySelector<HTMLElement>(".ai-chip")!;
  const closeButton = root.querySelector<HTMLButtonElement>(".ai-close")!;
  const paramsEl = root.querySelector<HTMLDivElement>(".ai-params")!;
  const contextSummary = root.querySelector<HTMLElement>(".ai-context-summary")!;
  const contextText = root.querySelector<HTMLElement>(".ai-context-text")!;
  const resultEl = root.querySelector<HTMLDivElement>(".ai-result")!;
  const resultLabel = root.querySelector<HTMLElement>(".ai-result-label")!;
  const changesSummary = root.querySelector<HTMLElement>(".ai-changes-summary")!;
  const toggleButtons = Array.from(root.querySelectorAll<HTMLButtonElement>(".ai-toggle-btn"));
  const answerEl = root.querySelector<HTMLElement>(".ai-answer")!;
  const answerSource = root.querySelector<HTMLDetailsElement>(".ai-answer-source")!;
  const answerSourceText = root.querySelector<HTMLElement>(".ai-answer-source-text")!;
  const diffEl = root.querySelector<HTMLDivElement>(".ai-diff")!;
  const notesEl = root.querySelector<HTMLDetailsElement>(".ai-notes")!;
  const notesText = root.querySelector<HTMLElement>(".ai-notes-text")!;
  const chatEl = root.querySelector<HTMLDivElement>(".ai-chat")!;
  const askRow = root.querySelector<HTMLDivElement>(".ai-ask-row")!;
  const askInput = root.querySelector<HTMLTextAreaElement>(".ai-ask-input")!;
  const askGenerate = root.querySelector<HTMLButtonElement>(".ai-ask-row .ai-generate")!;
  const statusEl = root.querySelector<HTMLElement>(".ai-status")!;
  const footerActions = root.querySelector<HTMLDivElement>(".ai-footer-actions")!;

  let config: AssistantConfig = {
    enabled: false,
    provider: "openai",
    baseUrl: "",
    model: "",
  };
  let position: Point | null = null;
  /**
   * The reader's dragged position, kept as a fraction of the pane's free space
   * so a resize resolves it against the new size. Null means "never dragged":
   * the button then follows the bottom-right anchor on every layout.
   */
  let anchor: PaneAnchor | null = null;
  /** Set by the resize handle; cleared by Reset position or a double-click. */
  let customPopoverRect: PopoverRect | null = null;
  let action: AiActionSpec | null = null;
  let capture: Capture | null = null;
  let target: {
    sessionId: string;
    revision: number;
    from: number;
    to: number;
    text: string;
  } | null = null;
  let state: PanelState = "idle";
  let requestId: string | null = null;
  let channel: ReturnType<typeof api.aiComplete>["channel"] | null = null;
  let requestSeq = 0;
  let answerText = "";
  let notes = "";
  let answerTruncated = false;
  let answerStopped = false;
  let errorMessage = "";
  let startedInfo: Extract<api.AiEvent, { kind: "started" }> | null = null;
  let showChanges = false;
  let askHistory: api.AiTurn[] = [];
  let pendingQuestion = "";
  let parameterValue = "";
  let historyOpen = false;
  let historyDetailId: string | null = null;
  let historyEntries: AiHistoryEntry[] = [];
  /** Stable across Regenerate/Retry; a new panel or Ask exchange gets a new one. */
  let entryId: string | null = null;
  let requestContext: { summary: string; text: string } | null = null;
  let historySeq = 0;
  let paletteOpen = false;
  let panelOpen = false;
  let activeIndex = 0;
  let rows: { action: AiActionSpec; element: HTMLButtonElement; reason: string | null }[] = [];
  let suppressClick = false;
  let answerFrame = 0;
  let dragMoved = false;
  /** The assistant's own right-click menu, appended to body so no pane clips it. */
  let buttonMenu: HTMLDivElement | null = null;
  let buttonMenuCleanup: (() => void) | null = null;

  function ready(): boolean {
    if (!config.enabled || !config.model.trim()) return false;
    try {
      const url = new URL(config.baseUrl.trim());
      return url.protocol === "http:" || url.protocol === "https:";
    } catch {
      return false;
    }
  }

  function closeButtonMenu(restoreFocus = false): void {
    const element = buttonMenu;
    if (!element) return;
    buttonMenu = null;
    buttonMenuCleanup?.();
    buttonMenuCleanup = null;
    button.setAttribute("aria-expanded", "false");
    element.remove();
    if (restoreFocus && !root.hidden && button.isConnected) {
      button.focus({ preventScroll: true });
    }
  }

  /**
   * The button's own menu. A right-click here belongs to the assistant, not to
   * the webview: the native menu offers Back and Refresh, neither of which has
   * anything to do with the control. Every command already existed elsewhere —
   * Preferences and the palette — and this is the short route to them at the
   * exact place the reader aimed.
   */
  function openButtonMenu(x: number, y: number): void {
    closeButtonMenu();
    closePalette();
    closeHistory();

    const menu = document.createElement("div");
    menu.className = "ai-menu";
    menu.setAttribute("role", "menu");
    menu.tabIndex = -1;

    const run = (action: () => void): void => {
      closeButtonMenu();
      action();
    };

    const items: { id: string; label: string; run: () => void }[] = [
      {
        id: "reset",
        label: "Reset position",
        run: () => {
          resetPosition();
          host.toast("Assistant layout reset.");
          if (!root.hidden) button.focus({ preventScroll: true });
        },
      },
      {
        id: "settings",
        label: "AI Assistant Settings…",
        run: () => host.openSettings(),
      },
      {
        id: "toggle",
        label: config.enabled ? "Disable AI Assistant" : "Enable AI Assistant",
        run: () => {
          const enabled = !config.enabled;
          host.setEnabled(enabled);
          host.toast(
            enabled
              ? "AI Assistant enabled."
              : "AI Assistant disabled. Re-enable it in AI Assistant Settings.",
          );
          if (!enabled) host.focusEditor();
        },
      },
    ];

    items.forEach((item, index) => {
      if (index === 2) {
        const separator = document.createElement("div");
        separator.className = "ai-menu-sep";
        separator.setAttribute("role", "separator");
        menu.appendChild(separator);
      }
      const entry = document.createElement("button");
      entry.type = "button";
      entry.className = "ai-menu-item";
      entry.setAttribute("role", "menuitem");
      entry.dataset.action = item.id;
      entry.textContent = item.label;
      entry.addEventListener("click", () => run(item.run));
      menu.appendChild(entry);
    });

    document.body.appendChild(menu);
    const rect = menu.getBoundingClientRect();
    const margin = 8;
    const left = Math.min(
      Math.max(margin, x),
      Math.max(margin, window.innerWidth - rect.width - margin),
    );
    const desiredTop = y + rect.height > window.innerHeight ? y - rect.height : y;
    const top = Math.min(
      Math.max(margin, desiredTop),
      Math.max(margin, window.innerHeight - rect.height - margin),
    );
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    buttonMenu = menu;
    button.setAttribute("aria-expanded", "true");

    menu.querySelector<HTMLButtonElement>(".ai-menu-item")?.focus({ preventScroll: true });

    const onPointer = (event: MouseEvent): void => {
      if (event.target instanceof Node && menu.contains(event.target)) return;
      closeButtonMenu();
    };
    const onEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      closeButtonMenu(true);
    };
    const onKey = (event: KeyboardEvent): void => {
      const entries = Array.from(menu.querySelectorAll<HTMLButtonElement>(".ai-menu-item"));
      if (entries.length === 0) return;
      const current = document.activeElement;
      let index = current instanceof HTMLButtonElement ? entries.indexOf(current) : -1;

      switch (event.key) {
        case "ArrowDown":
          event.preventDefault();
          index = index < 0 ? 0 : (index + 1) % entries.length;
          break;
        case "ArrowUp":
          event.preventDefault();
          index = index < 0 ? entries.length - 1 : (index - 1 + entries.length) % entries.length;
          break;
        case "Home":
          event.preventDefault();
          index = 0;
          break;
        case "End":
          event.preventDefault();
          index = entries.length - 1;
          break;
        case "Enter":
        case " ":
          event.preventDefault();
          (entries[index] ?? entries[0]).click();
          return;
        case "Tab":
          event.preventDefault();
          closeButtonMenu(true);
          return;
        default:
          return;
      }
      entries[index]?.focus({ preventScroll: true });
    };
    const onBlur = (): void => closeButtonMenu();
    const onResize = (): void => closeButtonMenu();
    const onScroll = (): void => closeButtonMenu();
    const onContextMenu = (event: MouseEvent): void => event.preventDefault();

    menu.addEventListener("contextmenu", onContextMenu);
    menu.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onPointer, true);
    document.addEventListener("keydown", onEscape, true);
    window.addEventListener("blur", onBlur);
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", onScroll, true);

    buttonMenuCleanup = () => {
      menu.removeEventListener("contextmenu", onContextMenu);
      menu.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onPointer, true);
      document.removeEventListener("keydown", onEscape, true);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onScroll, true);
    };
  }

  function placeButton(): void {
    if (root.hidden) return;
    const rect = pane.getBoundingClientRect();
    if (rect.width < BUTTON_SIZE + PANE_MARGIN * 2 || rect.height < BUTTON_SIZE + PANE_MARGIN * 2) {
      return;
    }
    if (anchor) {
      // Resolving the stored fraction is what keeps a dragged button in place
      // when the window grows, shrinks or maximizes. A fixed pixel offset was
      // what left it at the old height, in the middle of the editor.
      position = positionFromAnchor(anchor, rect.width, rect.height, BUTTON_SIZE, PANE_MARGIN);
    } else {
      // Until the reader drags it, the button follows the bottom-right anchor.
      // The first layout can still be settling (fonts, tabs, status bar), so a
      // position captured once would leave the button 100+ px from the corner.
      position = defaultButtonPosition(
        rect.width,
        rect.height,
        BUTTON_SIZE,
        ANCHOR_SIDE_MARGIN,
        PANE_MARGIN,
      );
    }
    button.style.left = `${Math.round(position.x)}px`;
    button.style.top = `${Math.round(position.y)}px`;
  }

  function clampPopoverRect(rect: PopoverRect): PopoverRect {
    const paneRect = pane.getBoundingClientRect();
    if (paneRect.width < 40 || paneRect.height < 40) return rect;
    const maxWidth = Math.max(40, paneRect.width - PANE_MARGIN * 2);
    const maxHeight = Math.max(40, paneRect.height - PANE_MARGIN * 2);
    const width = Math.min(Math.max(rect.width, Math.min(MIN_PANEL_WIDTH, maxWidth)), maxWidth);
    const height = Math.min(
      Math.max(rect.height, Math.min(MIN_PANEL_HEIGHT, maxHeight)),
      maxHeight,
    );
    return {
      left: Math.min(Math.max(rect.left, PANE_MARGIN), paneRect.width - width - PANE_MARGIN),
      top: Math.min(Math.max(rect.top, PANE_MARGIN), paneRect.height - height - PANE_MARGIN),
      width,
      height,
    };
  }

  function applyCustomRect(element: HTMLElement): boolean {
    if (!customPopoverRect || element.hidden) return false;
    const rect = clampPopoverRect(customPopoverRect);
    element.classList.add("is-resized");
    element.style.width = `${rect.width}px`;
    element.style.height = `${rect.height}px`;
    element.style.maxHeight = "none";
    element.style.left = `${Math.round(rect.left)}px`;
    element.style.top = `${Math.round(rect.top)}px`;
    return true;
  }

  /**
   * A panel or History that the reader has resized keeps its own rectangle for
   * the session. Until then it follows the floating button and its content.
   */
  function placeDocumentPopover(element: HTMLElement): void {
    if (applyCustomRect(element)) return;
    element.classList.remove("is-resized");
    placePopover(element, PANEL_WIDTH);
  }

  function placeOpenPopovers(): void {
    if (paletteOpen) placePopover(palette, PALETTE_WIDTH, 520);
    if (panelOpen) placeDocumentPopover(panel);
    if (historyOpen) placeDocumentPopover(historyEl);
  }

  function popoverRectOf(element: HTMLElement): PopoverRect {
    const paneRect = pane.getBoundingClientRect();
    const rect = element.getBoundingClientRect();
    return {
      left: rect.left - paneRect.left,
      top: rect.top - paneRect.top,
      width: rect.width,
      height: rect.height,
    };
  }

  /** Drag the top-left grip: the bottom-right corner stays where it is. */
  function startResize(event: PointerEvent, element: HTMLElement, handle: HTMLElement): void {
    const paneRect = pane.getBoundingClientRect();
    const start = element.getBoundingClientRect();
    const right = start.right - paneRect.left;
    const bottom = start.bottom - paneRect.top;
    const startX = event.clientX;
    const startY = event.clientY;
    const startWidth = start.width;
    const startHeight = start.height;
    const move = (moveEvent: PointerEvent) => {
      const maxWidth = Math.max(40, right - PANE_MARGIN);
      const maxHeight = Math.max(40, bottom - PANE_MARGIN);
      const width = Math.min(
        Math.max(startWidth - (moveEvent.clientX - startX), Math.min(MIN_PANEL_WIDTH, maxWidth)),
        maxWidth,
      );
      const height = Math.min(
        Math.max(startHeight - (moveEvent.clientY - startY), Math.min(MIN_PANEL_HEIGHT, maxHeight)),
        maxHeight,
      );
      customPopoverRect = { left: right - width, top: bottom - height, width, height };
      applyCustomRect(element);
    };
    const end = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
    try {
      handle.setPointerCapture(event.pointerId);
    } catch {
      // The pointer can be gone already, for example after a synthetic event.
    }
  }

  /** Arrow keys resize from the same top-left edge; Shift takes a bigger step. */
  function nudgeResize(event: KeyboardEvent, element: HTMLElement): void {
    const step = event.shiftKey ? 48 : 16;
    const current = customPopoverRect ?? popoverRectOf(element);
    const next = { ...current };
    if (event.key === "ArrowLeft") next.width += step;
    else if (event.key === "ArrowRight") next.width -= step;
    else if (event.key === "ArrowUp") next.height += step;
    else if (event.key === "ArrowDown") next.height -= step;
    else return;
    event.preventDefault();
    next.left = current.left + current.width - next.width;
    next.top = current.top + current.height - next.height;
    customPopoverRect = clampPopoverRect(next);
    applyCustomRect(element);
  }

  function placePopover(
    element: HTMLElement,
    preferredWidth: number,
    cap = Number.POSITIVE_INFINITY,
  ): void {
    if (element.hidden) return;
    const paneRect = pane.getBoundingClientRect();
    const buttonRect = button.getBoundingClientRect();
    if (paneRect.width < 40) return;
    const width = Math.max(220, Math.min(preferredWidth, paneRect.width - 16));
    element.style.width = `${width}px`;
    // A previously resized panel carries an inline height. Reset must return it
    // to the content's own height, not keep the last dragged value.
    element.style.height = "";
    // The palette is capped at 520 px so it reads as a palette, not a column;
    // the panel may use the pane. Both leave room for the button and margins.
    const maxHeight = Math.max(160, Math.min(cap, paneRect.height - PANE_MARGIN * 2 - 80));
    element.style.maxHeight = `${maxHeight}px`;
    const height = element.offsetHeight;
    const leftBase = buttonRect.left - paneRect.left;
    const topBase = buttonRect.top - paneRect.top;
    const gap = 10;
    const spaceBelow = paneRect.height - (topBase + BUTTON_SIZE) - gap - PANE_MARGIN;
    const spaceAbove = topBase - gap - PANE_MARGIN;
    const top =
      spaceBelow >= height || spaceBelow >= spaceAbove
        ? topBase + BUTTON_SIZE + gap
        : topBase - gap - height;
    const left = leftBase + BUTTON_SIZE - width;
    element.style.left = `${Math.round(
      Math.min(Math.max(PANE_MARGIN, left), paneRect.width - width - PANE_MARGIN),
    )}px`;
    element.style.top = `${Math.round(
      Math.min(Math.max(PANE_MARGIN, top), paneRect.height - height - PANE_MARGIN),
    )}px`;
  }

  function setStatus(text: string, isError = false): void {
    statusEl.textContent = text;
    statusEl.classList.toggle("is-error", isError);
  }

  function reasonFor(spec: AiActionSpec, current = host.capture()): string | null {
    if (!host.canWrite() && spec.apply !== "answer") {
      return "The document is read-only — copy the answer instead.";
    }
    if (spec.id === "ask") return null;
    if (spec.id === "continue") {
      if (current.preceding.trim() || current.selection.trim()) return null;
      return "Write something before the caret first.";
    }
    const passage = current.hasSelection ? current.selection : current.paragraph;
    if (!passage.trim()) return "Write or select some text first.";
    if (passage.length > 24_000) {
      return "Select a shorter passage — up to 24,000 characters.";
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Palette
  // -------------------------------------------------------------------------

  function renderPalette(): void {
    const results = searchActions(search.value);
    const groups = groupedActions(results);
    const current = host.capture();
    rows = [];
    activeIndex = 0;
    const fragment = document.createDocumentFragment();

    if (groups.length === 0) {
      const empty = document.createElement("p");
      empty.className = "ai-empty";
      empty.textContent = "No action matches that search.";
      fragment.appendChild(empty);
    }

    for (const group of groups) {
      const heading = document.createElement("div");
      heading.className = "ai-group";
      heading.textContent = group.label;
      heading.setAttribute("role", "presentation");
      fragment.appendChild(heading);
      for (const spec of group.actions) {
        const reason = reasonFor(spec, current);
        const row = document.createElement("button");
        row.type = "button";
        row.className = "ai-row";
        row.id = `ai-row-${spec.id}`;
        row.setAttribute("role", "option");
        row.setAttribute("aria-selected", "false");
        row.innerHTML = `<span class="ai-row-icon">${iconSvg(spec.icon)}</span><span class="ai-row-text"><span class="ai-row-label"></span><span class="ai-row-description"></span></span>`;
        row.querySelector(".ai-row-label")!.textContent = spec.label;
        row.querySelector(".ai-row-description")!.textContent = reason ?? spec.description;
        row.classList.toggle("is-disabled", Boolean(reason));
        const index = rows.length;
        row.addEventListener("pointerenter", () => setActive(index));
        row.addEventListener("click", () => choose(spec, reason));
        rows.push({ action: spec, element: row, reason });
        fragment.appendChild(row);
      }
    }
    actionsEl.replaceChildren(fragment);
    setActive(0);
  }

  function setActive(index: number): void {
    if (rows.length === 0) {
      search.removeAttribute("aria-activedescendant");
      return;
    }
    activeIndex = (index + rows.length) % rows.length;
    rows.forEach((row, position) => {
      const active = position === activeIndex;
      row.element.classList.toggle("is-active", active);
      row.element.setAttribute("aria-selected", String(active));
    });
    const current = rows[activeIndex];
    search.setAttribute("aria-activedescendant", current.element.id);
    current.element.scrollIntoView({ block: "nearest" });
  }

  function choose(spec: AiActionSpec, reason: string | null): void {
    if (reason) {
      host.toast(reason);
      return;
    }
    closePalette();
    openPanel(spec);
  }

  function openPalette(): void {
    if (!ready()) {
      host.openSettings();
      return;
    }
    closeHistory();
    panelOpen = false;
    panel.hidden = true;
    paletteOpen = true;
    palette.hidden = false;
    search.value = "";
    renderPalette();
    placePopover(palette, PALETTE_WIDTH, 520);
    search.focus();
  }

  function closePalette(): void {
    paletteOpen = false;
    palette.hidden = true;
  }

  // -------------------------------------------------------------------------
  // History
  // -------------------------------------------------------------------------

  function nextHistoryId(): string {
    historySeq += 1;
    return `ai-history-${Date.now()}-${historySeq}`;
  }

  function historyEntryById(id: string): AiHistoryEntry | undefined {
    return historyEntries.find((entry) => entry.id === id);
  }

  function historyRequestLine(entry: AiHistoryEntry): string {
    const document = entry.documentName ? ` · ${entry.documentName}` : "";
    if (entry.question.trim()) {
      return `“${previewText(entry.question, 100)}”${document}`;
    }
    return `${previewText(entry.contextSummary, 100)}${document}`;
  }

  function focusHistory(id?: string): void {
    const rows = Array.from(historyList.querySelectorAll<HTMLButtonElement>(".ai-history-row"));
    const target = id ? rows.find((row) => row.dataset.entryId === id) : rows[0];
    (target ?? historyClose).focus();
  }

  function openHistory(): void {
    if (!ready()) {
      host.openSettings();
      return;
    }
    paletteOpen = false;
    palette.hidden = true;
    panelOpen = false;
    panel.hidden = true;
    historyOpen = true;
    historyDetailId = null;
    historyEl.hidden = false;
    renderHistory();
    placeDocumentPopover(historyEl);
    focusHistory();
  }

  function closeHistory(): void {
    historyOpen = false;
    historyDetailId = null;
    historyEl.hidden = true;
  }

  function renderHistory(): void {
    if (!historyOpen) return;
    if (historyDetailId && !historyEntryById(historyDetailId)) historyDetailId = null;
    const entry = historyDetailId ? historyEntryById(historyDetailId) : undefined;

    historyTitleEl.textContent = entry ? historyTitle(entry.action, entry.parameter) : "History";
    historyBack.hidden = !entry;
    historyCount.hidden = Boolean(entry) || historyEntries.length === 0;
    historyCount.textContent = `${historyEntries.length} of ${MAX_AI_HISTORY}`;
    historyList.hidden = Boolean(entry);
    historyDetail.hidden = !entry;
    historyFooter.hidden = Boolean(entry);
    if (entry) renderHistoryDetail(entry);
    else renderHistoryList();
    placeDocumentPopover(historyEl);
  }

  function renderHistoryList(): void {
    historyList.replaceChildren();
    if (historyEntries.length === 0) {
      const empty = document.createElement("div");
      empty.className = "ai-history-empty";
      const title = document.createElement("p");
      title.className = "ai-history-empty-title";
      title.textContent = "No answers yet";
      const text = document.createElement("p");
      text.className = "ai-empty";
      text.textContent =
        "Answers you generate are kept here for this session only. The last 10 are kept.";
      const browse = document.createElement("button");
      browse.type = "button";
      browse.className = "ai-link";
      browse.textContent = "Browse actions";
      browse.addEventListener("click", () => {
        closeHistory();
        openPalette();
      });
      empty.append(title, text, browse);
      historyList.appendChild(empty);
      historyClear.hidden = true;
      return;
    }

    historyClear.hidden = false;
    const fragment = document.createDocumentFragment();
    for (const entry of historyEntries) {
      const spec = actionById(entry.action);
      const row = document.createElement("button");
      row.type = "button";
      row.className = "ai-history-row";
      row.dataset.entryId = entry.id;
      row.innerHTML = `<span class="ai-history-icon">${iconSvg(spec?.icon ?? "")}</span><span class="ai-history-main"><span class="ai-history-row-head"><span class="ai-history-action"></span><span class="ai-history-time"></span></span><span class="ai-history-request"></span><span class="ai-history-preview"></span></span>`;
      const title = historyTitle(entry.action, entry.parameter);
      const time = formatHistoryAge(entry.createdAt);
      row.querySelector(".ai-history-action")!.textContent = title;
      const timeEl = row.querySelector<HTMLElement>(".ai-history-time")!;
      timeEl.textContent = time;
      timeEl.title = new Date(entry.createdAt).toLocaleString();
      row.querySelector(".ai-history-request")!.textContent = historyRequestLine(entry);
      row.querySelector(".ai-history-preview")!.textContent = previewText(entry.answer, 140);
      row.setAttribute("aria-label", `${title}, ${historyRequestLine(entry)}, ${time}`);
      row.addEventListener("click", () => {
        historyDetailId = entry.id;
        renderHistory();
        historyBack.focus();
      });
      fragment.appendChild(row);
    }
    historyList.appendChild(fragment);
  }

  function renderHistoryDetail(entry: AiHistoryEntry): void {
    historyDetail.replaceChildren();
    const meta = document.createElement("div");
    meta.className = "ai-history-meta";
    const pieces = [formatHistoryAge(entry.createdAt), entry.documentName];
    if (entry.model) pieces.push(entry.host ? `${entry.model} · ${entry.host}` : entry.model);
    meta.textContent = pieces.filter(Boolean).join(" · ");
    meta.title = new Date(entry.createdAt).toLocaleString();
    historyDetail.appendChild(meta);

    if (entry.question.trim()) {
      const block = document.createElement("div");
      block.className = "ai-history-question";
      const label = document.createElement("span");
      label.className = "ai-history-question-label";
      label.textContent = "Question";
      const text = document.createElement("p");
      text.textContent = entry.question;
      block.append(label, text);
      historyDetail.appendChild(block);
    }

    if (entry.context.trim()) {
      const details = document.createElement("details");
      details.className = "ai-context ai-history-context";
      const summary = document.createElement("summary");
      summary.className = "ai-context-summary";
      summary.textContent = entry.contextSummary || "Captured context";
      const pre = document.createElement("pre");
      pre.className = "ai-context-text";
      pre.textContent = entry.context;
      details.append(summary, pre);
      historyDetail.appendChild(details);
    }

    const head = document.createElement("div");
    head.className = "ai-result-head";
    const label = document.createElement("span");
    label.className = "ai-result-label";
    label.textContent = "Answer";
    head.appendChild(label);
    if (entry.truncated) {
      const badge = document.createElement("span");
      badge.className = "ai-history-badge";
      badge.textContent = "Truncated";
      head.appendChild(badge);
    }
    historyDetail.appendChild(head);

    const answer = document.createElement("div");
    answer.className = "ai-history-answer ai-markdown";
    answer.innerHTML = markdownHtml(entry.answer);
    if (!answer.textContent?.trim()) answer.textContent = entry.answer;
    historyDetail.appendChild(answer);

    if (entry.notes.trim()) {
      const notes = document.createElement("details");
      notes.className = "ai-notes";
      const summary = document.createElement("summary");
      summary.textContent = "What changed";
      const text = document.createElement("div");
      text.className = "ai-notes-text";
      text.textContent = entry.notes;
      notes.append(summary, text);
      historyDetail.appendChild(notes);
    }

    const actions = document.createElement("div");
    actions.className = "ai-footer-actions ai-history-detail-actions";
    actions.append(
      actionButton("Copy", false, () => void copyHistory(entry)),
      actionButton(
        "Insert below",
        true,
        () => insertHistory(entry),
        !host.canWrite(),
        host.canWrite()
          ? "Insert the answer below the current paragraph."
          : "The document is read-only.",
      ),
    );
    historyDetail.appendChild(actions);
  }

  function backToHistory(): void {
    const previous = historyDetailId;
    historyDetailId = null;
    renderHistory();
    focusHistory(previous ?? undefined);
  }

  async function copyHistory(entry: AiHistoryEntry): Promise<void> {
    const copied = await writeClipboardText(entry.answer);
    host.toast(copied ? "Copied the answer to the clipboard." : "The clipboard is unavailable.");
  }

  function insertHistory(entry: AiHistoryEntry): void {
    if (!host.canWrite()) {
      host.toast("The document is read-only — copy the answer instead.");
      return;
    }
    const current = host.capture();
    const at = Math.min(current.paragraphTo, current.text.length);
    const plan: ApplyPlan = {
      kind: "insert",
      from: at,
      to: at,
      text: blockInsertion(current.text, at, entry.answer),
    };
    if (!host.apply(plan)) {
      host.toast("The answer could not be inserted — the document changed.");
      return;
    }
    closeHistory();
    host.focusEditor();
    host.toast("Inserted the answer — undo with Ctrl/Cmd+Z.");
  }

  /**
   * Record a completed answer once. Regenerate keeps the entry id, so replacing
   * the same request cannot grow the list.
   */
  function recordHistory(): void {
    if (!action || !capture || !entryId) return;
    if (answerStopped || !answerText.trim()) return;
    const spec = action;
    const context = requestContext ?? { summary: "", text: "" };
    const entry: AiHistoryEntry = {
      id: entryId,
      action: spec.id,
      parameter: spec.parameter === "none" ? null : parameterValue || null,
      question: spec.id === "ask" ? pendingQuestion.trim() : "",
      contextSummary: context.summary,
      context: context.text,
      answer: answerText.trim(),
      notes: notes.trim(),
      model: startedInfo?.model ?? config.model,
      host: startedInfo?.host ?? hostOf(config.baseUrl),
      documentName: host.documentName(),
      language: capture.language,
      createdAt: Date.now(),
      truncated: answerTruncated,
    };
    historyEntries = rememberRequest(historyEntries, entry);
    if (historyOpen && !historyDetailId) renderHistory();
  }

  // -------------------------------------------------------------------------
  // Panel
  // -------------------------------------------------------------------------

  function openPanel(spec: AiActionSpec): void {
    // A new action invalidates any answer still arriving for the previous one.
    requestId = null;
    entryId = null;
    requestContext = null;
    action = spec;
    capture = host.capture();
    const targetFrom = spec.apply === "replace" ? capture.passageFrom : capture.selectionFrom;
    const targetTo = spec.apply === "replace" ? capture.passageTo : capture.selectionTo;
    target = {
      sessionId: host.sessionId(),
      revision: host.revision(),
      from: targetFrom,
      to: targetTo,
      text: capture.text.slice(targetFrom, targetTo),
    };
    answerText = "";
    notes = "";
    answerTruncated = false;
    answerStopped = false;
    errorMessage = "";
    startedInfo = null;
    showChanges = false;
    askHistory = [];
    pendingQuestion = "";
    parameterValue = defaultParameter(spec.id, capture.language);
    state = spec.parameter === "none" ? "idle" : "parameter";
    panelOpen = true;
    panel.hidden = false;
    panelTitle.textContent = spec.label;
    buildParams();
    renderContext();
    renderPanel();
    placeDocumentPopover(panel);
    if (spec.id === "ask") {
      askInput.value = "";
      askInput.focus();
    } else if (spec.parameter !== "none") {
      paramsEl.querySelector<HTMLElement>("select, input")?.focus();
    } else {
      startRequest();
    }
  }

  function buildParams(): void {
    paramsEl.replaceChildren();
    if (!action || action.parameter === "none") {
      paramsEl.hidden = true;
      return;
    }
    paramsEl.hidden = false;

    const label = document.createElement("label");
    label.className = "ai-param";
    let control: HTMLSelectElement | HTMLInputElement;
    if (action.id === "tone") {
      const select = document.createElement("select");
      for (const tone of TONES) {
        const option = document.createElement("option");
        option.value = tone;
        option.textContent = tone;
        select.appendChild(option);
      }
      select.value = parameterValue;
      select.addEventListener("change", () => {
        parameterValue = select.value;
        entryId = null;
        updateGenerate();
      });
      control = select;
      label.append("Tone");
    } else if (action.id === "translate") {
      const input = document.createElement("input");
      input.type = "text";
      input.placeholder = "Target language";
      input.value = parameterValue;
      input.setAttribute("list", "ai-language-list");
      input.addEventListener("input", () => {
        parameterValue = input.value;
        entryId = null;
        updateGenerate();
      });
      control = input;
      label.append("Translate to");
    } else {
      const select = document.createElement("select");
      const language = capture?.language ?? "markdown";
      for (const markup of convertTargets(language)) {
        const option = document.createElement("option");
        option.value = markup.id;
        option.textContent = markup.label;
        select.appendChild(option);
      }
      if (!convertTargets(language).some((markup) => markup.id === parameterValue)) {
        parameterValue = convertTargets(language)[0]?.id ?? "html";
      }
      select.value = parameterValue;
      select.addEventListener("change", () => {
        parameterValue = select.value;
        entryId = null;
        updateGenerate();
      });
      control = select;
      label.append("Convert to");
    }
    control.className = "ai-param-control";
    label.appendChild(control);

    const generate = document.createElement("button");
    generate.type = "button";
    generate.className = "ai-generate";
    generate.textContent = "Generate";
    generate.addEventListener("click", () => {
      if (state === "running") cancel();
      else startRequest();
    });
    paramsEl.append(label, generate);

    const list = document.createElement("datalist");
    list.id = "ai-language-list";
    for (const language of LANGUAGES) {
      const option = document.createElement("option");
      option.value = language;
      list.appendChild(option);
    }
    paramsEl.appendChild(list);
  }

  function updateGenerate(): void {
    if (!action) return;
    if (action.id === "ask") {
      const running = state === "running";
      askGenerate.textContent = running ? "Stop" : "Generate";
      askGenerate.disabled = !running && !askInput.value.trim();
      return;
    }
    if (action.parameter === "none") return;
    const generate = paramsEl.querySelector<HTMLButtonElement>(".ai-generate");
    if (!generate) return;
    const running = state === "running";
    generate.textContent = running ? "Stop" : "Generate";
    generate.disabled =
      !running && !parameterIsValid(action.id, parameterValue, capture?.language ?? "markdown");
  }

  function describeContext(
    spec: AiActionSpec,
    current: Capture,
  ): { summary: string; text: string } {
    const preceded = trimPreceding(current.preceding);
    const preview = (() => {
      if (spec.id === "ask") {
        return current.hasSelection ? `<passage>\n${current.selection}\n</passage>` : "";
      }
      if (spec.id === "continue") {
        const lines: string[] = [];
        if (preceded.text.trim()) {
          lines.push(`<preceding_text>\n${preceded.text}\n</preceding_text>`);
        }
        if (current.hasSelection) {
          lines.push(`<passage>\n${current.selection}\n</passage>`);
        }
        return lines.join("\n\n");
      }
      const passage = current.hasSelection ? current.selection : current.paragraph;
      return `<passage>\n${passage}\n</passage>`;
    })();

    let summary: string;
    if (spec.id === "ask") {
      summary = current.hasSelection
        ? `Selection · ${formatCount(current.selection.length)} characters`
        : "No document context";
    } else if (spec.id === "continue") {
      summary = current.hasSelection
        ? `Selection · ${formatCount(current.selection.length)} characters, plus the text before it`
        : `${formatCount(preceded.text.length)} characters before the caret`;
      if (preceded.truncated) summary += " · trimmed to 12,000";
    } else {
      summary = `${current.hasSelection ? "Selection" : "Current paragraph"} · ${formatCount(
        (current.hasSelection ? current.selection : current.paragraph).length,
      )} characters`;
    }
    return { summary, text: preview };
  }

  function renderContext(): void {
    if (!action || !capture) return;
    const context = describeContext(action, capture);
    requestContext = context;
    contextSummary.textContent = `${context.summary} · exact context`;
    contextText.textContent = context.text;
  }

  function renderPanel(): void {
    if (!panelOpen || !action) return;
    const spec = action;
    panelTitle.textContent = spec.label;

    const model = startedInfo?.model ?? config.model;
    const endpoint = startedInfo?.host ?? hostOf(config.baseUrl);
    chip.hidden = !model;
    chip.textContent = endpoint ? `${model} · ${endpoint}` : model;
    chip.title = endpoint ? `Model ${model} at ${endpoint}` : `Model ${model}`;

    paramsEl.hidden = spec.parameter === "none";
    askRow.hidden = spec.id !== "ask";
    chatEl.hidden = spec.id !== "ask";
    resultEl.hidden = spec.id === "ask" || (!answerText && state !== "running");
    notesEl.hidden = spec.id !== "improve" || !notes;
    notesText.textContent = notes;

    if (spec.apply === "replace") {
      resultLabel.textContent = "Answer";
    } else if (spec.apply === "block") {
      resultLabel.textContent = "Answer";
    } else {
      resultLabel.textContent = "Continuation";
    }

    renderAnswer();
    updateGenerate();
    renderFooter();
    if (panelOpen) placeDocumentPopover(panel);
  }

  function renderAnswerText(): void {
    // Parsing and sanitising a growing answer on every animation frame makes
    // streaming stutter, so the live text stays plain; the completed answer is
    // rendered like the Ask bubble and the history detail.
    const plain = state === "running";
    answerEl.classList.toggle("is-plain", plain);
    if (plain) answerEl.textContent = answerText;
    else answerEl.innerHTML = markdownHtml(answerText);
    answerSource.hidden = plain || !answerText.trim();
    answerSourceText.textContent = answerText;
  }

  function renderAnswer(): void {
    if (!action || !panelOpen) return;
    if (action.id === "ask") {
      renderChat();
      return;
    }
    const canDiff = action.apply === "replace" && answerText.trim().length > 0;
    for (const toggle of toggleButtons) {
      toggle.hidden = !canDiff;
      toggle.classList.toggle("active", (toggle.dataset.view === "changes") === showChanges);
    }
    if (canDiff && showChanges && capture) {
      answerEl.hidden = true;
      answerSource.hidden = true;
      diffEl.hidden = false;
      const source = capture.hasSelection ? capture.selection : capture.paragraph;
      const parts = wordDiff(source, answerText);
      diffEl.replaceChildren(
        ...parts.map((part) => {
          const span = document.createElement("span");
          span.className = `ai-diff-${part.kind}`;
          span.textContent = part.value;
          return span;
        }),
      );
      const summary = diffSummary(parts);
      changesSummary.textContent = `${summary.added} added · ${summary.removed} removed`;
    } else {
      answerEl.hidden = false;
      diffEl.hidden = true;
      changesSummary.textContent = "";
      renderAnswerText();
    }
  }

  function chatBubble(role: "user" | "assistant", text: string, render: boolean): HTMLElement {
    const bubble = document.createElement("div");
    bubble.className = `ai-chat-bubble ai-chat-${role}`;
    if (role === "assistant" && render) {
      bubble.classList.add("ai-markdown");
      bubble.innerHTML = markdownHtml(text);
      if (!text.trim()) bubble.textContent = "…";
      const details = document.createElement("details");
      details.className = "ai-chat-source";
      const summary = document.createElement("summary");
      summary.textContent = "Source";
      const pre = document.createElement("pre");
      pre.textContent = text;
      details.append(summary, pre);
      bubble.appendChild(details);
    } else {
      bubble.textContent = text;
    }
    return bubble;
  }

  function renderChat(): void {
    if (!panelOpen) return;
    const fragment = document.createDocumentFragment();
    for (const turn of askHistory) {
      fragment.appendChild(chatBubble(turn.role, turn.content, true));
    }
    if (pendingQuestion) fragment.appendChild(chatBubble("user", pendingQuestion, false));
    if (answerText && (state === "running" || state === "error")) {
      fragment.appendChild(chatBubble("assistant", answerText, false));
    }
    if (fragment.childNodes.length === 0) {
      const empty = document.createElement("p");
      empty.className = "ai-empty";
      empty.textContent = "Ask a question about the selection, or ask anything.";
      fragment.appendChild(empty);
    }
    chatEl.replaceChildren(fragment);
  }

  function actionButton(
    label: string,
    primary: boolean,
    onClick: () => void | Promise<void>,
    disabled = false,
    title = "",
  ): HTMLButtonElement {
    const element = document.createElement("button");
    element.type = "button";
    element.className = `ai-action${primary ? " is-primary" : ""}`;
    element.textContent = label;
    element.disabled = disabled;
    if (title) element.title = title;
    element.addEventListener("click", () => void onClick());
    return element;
  }

  function stale(): boolean {
    if (!target) return true;
    return !targetIsCurrent(target, host.sessionId(), host.revision(), host.capture().text);
  }

  function canApply(): boolean {
    return state === "done" && !answerStopped && answerText.trim().length > 0 && host.canWrite();
  }

  function renderFooter(): void {
    footerActions.replaceChildren();
    if (!action) {
      setStatus("");
      return;
    }
    const spec = action;

    if (state === "idle" || state === "parameter") {
      setStatus(
        state === "parameter"
          ? "Choose a value, then Generate."
          : spec.id === "ask"
            ? "Type a question, then Generate."
            : "Ready.",
      );
      return;
    }

    if (state === "running") {
      setStatus(startedInfo ? "Generating…" : "Contacting the model…");
      footerActions.appendChild(actionButton("Stop", false, cancel));
      return;
    }

    if (state === "error") {
      setStatus(errorMessage, true);
      if (answerText.trim()) {
        footerActions.appendChild(actionButton("Copy", false, () => void copyAnswer()));
      }
      footerActions.appendChild(actionButton("Retry", true, () => startRequest("retry")));
      footerActions.appendChild(actionButton("Open AI Settings", false, () => host.openSettings()));
      return;
    }

    // Done.
    if (answerStopped) {
      setStatus("Stopped — copy the partial answer, or regenerate it.");
    } else if (answerTruncated) {
      setStatus("Answer ready (truncated at 32,000 characters).");
    } else {
      setStatus("Answer ready.");
    }

    const readOnly = !host.canWrite();
    const isStale = stale();
    const blockedReason = readOnly
      ? "The document is read-only."
      : isStale
        ? "The document changed while the answer was arriving — insert it below instead."
        : "";

    if (spec.apply === "answer") {
      footerActions.appendChild(actionButton("Copy", true, () => void copyAnswer()));
      footerActions.appendChild(
        actionButton("Insert below", false, () => applyAnswer("below"), !canApply(), blockedReason),
      );
      footerActions.appendChild(actionButton("New conversation", false, newConversation));
      return;
    }

    if (spec.apply === "continue") {
      footerActions.appendChild(
        actionButton("Insert", true, () => applyAnswer("insert"), !canApply(), blockedReason),
      );
      footerActions.appendChild(actionButton("Copy", false, () => void copyAnswer()));
      footerActions.appendChild(
        actionButton("Regenerate", false, () => startRequest("regenerate")),
      );
      return;
    }

    if (spec.apply === "block") {
      footerActions.appendChild(
        actionButton("Insert below", true, () => applyAnswer("below"), !canApply(), blockedReason),
      );
      footerActions.appendChild(actionButton("Copy", false, () => void copyAnswer()));
      footerActions.appendChild(
        actionButton("Regenerate", false, () => startRequest("regenerate")),
      );
      return;
    }

    // Rewrite: Replace is primary, Insert below is the safe alternative.
    const replaceDisabled = !canApply() || isStale;
    footerActions.appendChild(
      actionButton(
        "Replace selection",
        true,
        () => applyAnswer("replace"),
        replaceDisabled,
        blockedReason,
      ),
    );
    footerActions.appendChild(
      actionButton("Insert below", false, () => applyAnswer("below"), !canApply(), blockedReason),
    );
    footerActions.appendChild(actionButton("Copy", false, () => void copyAnswer()));
    footerActions.appendChild(actionButton("Regenerate", false, () => startRequest("regenerate")));
  }

  async function copyAnswer(): Promise<void> {
    const text = answerText.trim();
    if (!text) return;
    const copied = await writeClipboardText(text);
    host.toast(copied ? "Copied to the clipboard." : "The clipboard is unavailable.");
  }

  function applyAnswer(kind: "replace" | "insert" | "below"): void {
    if (!action || !capture || !answerText.trim()) return;
    if (!host.canWrite()) {
      host.toast("The document is read-only — copy the answer instead.");
      return;
    }
    const current = host.capture();
    let plan: ApplyPlan;
    if (kind === "replace") {
      if (stale()) {
        setStatus(
          "The document changed while the answer was arriving — insert it below instead.",
          true,
        );
        return;
      }
      plan = {
        kind: "replace",
        from: capture.passageFrom,
        to: capture.passageTo,
        text: answerText.trim(),
      };
    } else if (kind === "insert") {
      const at = Math.min(
        capture.hasSelection ? capture.selectionTo : capture.caret,
        current.text.length,
      );
      plan = {
        kind: "insert",
        from: at,
        to: at,
        text: joinContinuation(current.text.slice(0, at), answerText),
      };
    } else {
      const at = Math.min(capture.paragraphTo, current.text.length);
      plan = {
        kind: "insert",
        from: at,
        to: at,
        text: blockInsertion(current.text, at, answerText),
      };
    }
    if (!host.apply(plan)) {
      host.toast("The answer could not be applied — the document changed.");
      return;
    }
    const count =
      kind === "replace" ? capture.passageTo - capture.passageFrom : answerText.trim().length;
    host.toast(
      kind === "replace"
        ? `Replaced ${formatCount(count)} characters — undo with Ctrl/Cmd+Z.`
        : "Inserted the answer — undo with Ctrl/Cmd+Z.",
    );
    close();
  }

  // -------------------------------------------------------------------------
  // Requests
  // -------------------------------------------------------------------------

  type RequestMode = "new" | "retry" | "regenerate";

  function startRequest(mode: RequestMode = "new"): void {
    if (!action || !capture) return;
    if (state === "running") {
      cancel();
      return;
    }
    const spec = action;
    const parameter = spec.parameter === "none" ? null : parameterValue;
    if (
      spec.parameter !== "none" &&
      !parameterIsValid(spec.id, parameter ?? "", capture.language)
    ) {
      setStatus(
        spec.id === "translate" ? "Choose a target language first." : "Choose a valid value first.",
        true,
      );
      return;
    }
    const question = spec.id === "ask" ? askInput.value.trim() : "";
    if (spec.id === "ask" && !question) {
      setStatus("Type a question first.", true);
      askInput.focus();
      return;
    }

    // A new Ask exchange is a new request; Retry and Regenerate keep the entry
    // they are repairing so a successful answer replaces it instead of adding
    // a second row for the same question.
    if (!entryId || (spec.id === "ask" && mode === "new")) {
      entryId = nextHistoryId();
    }

    const id = `ai-${Date.now()}-${++requestSeq}`;
    requestId = id;
    state = "running";
    answerText = "";
    notes = "";
    answerTruncated = false;
    answerStopped = false;
    errorMessage = "";
    startedInfo = null;
    showChanges = false;
    if (spec.id === "ask") pendingQuestion = question;

    const history = spec.id === "ask" ? trimHistory(askHistory).history : [];
    const request = buildRequest(id, capture, spec.id, parameter, question, history);

    renderPanel();
    const call = api.aiComplete(request, (event) => {
      if (requestId !== id) return;
      onEvent(event);
    });
    channel = call.channel;
    void call.promise
      .catch((error: unknown) => {
        if (requestId !== id) return;
        onEvent({ kind: "error", message: String(error) });
      })
      .finally(() => {
        if (channel === call.channel) channel = null;
      });
  }

  function onEvent(event: api.AiEvent): void {
    switch (event.kind) {
      case "started":
        startedInfo = event;
        renderPanel();
        break;
      case "delta":
        answerText += event.text;
        scheduleAnswer();
        break;
      case "done":
        answerText = event.text;
        notes = event.notes;
        answerTruncated = event.truncated;
        answerStopped = event.stopped;
        state = "done";
        // The answer is remembered even if the palette or the history list is
        // covering the panel: opening another surface must not lose it.
        recordHistory();
        if (action?.id === "ask" && !event.stopped && event.text.trim()) {
          if (pendingQuestion) {
            askHistory = [
              ...askHistory,
              { role: "user", content: pendingQuestion },
              { role: "assistant", content: event.text },
            ];
          }
          pendingQuestion = "";
          askInput.value = "";
        }
        renderPanel();
        break;
      case "error":
        state = "error";
        errorMessage = event.message;
        renderPanel();
        break;
    }
  }

  function scheduleAnswer(): void {
    if (answerFrame) return;
    answerFrame = requestAnimationFrame(() => {
      answerFrame = 0;
      renderAnswer();
      if (panelOpen) {
        const atBottom = chatEl.scrollTop + chatEl.clientHeight >= chatEl.scrollHeight - 24;
        if (atBottom) chatEl.scrollTop = chatEl.scrollHeight;
      }
    });
  }

  function cancel(): void {
    if (state !== "running" || !requestId) return;
    void api.aiCancel(requestId).catch(() => undefined);
    setStatus("Stopping…");
  }

  function newConversation(): void {
    askHistory = [];
    pendingQuestion = "";
    answerText = "";
    notes = "";
    errorMessage = "";
    startedInfo = null;
    state = "idle";
    entryId = null;
    requestContext = null;
    capture = host.capture();
    target = {
      sessionId: host.sessionId(),
      revision: host.revision(),
      from: capture.selectionFrom,
      to: capture.selectionTo,
      text: capture.text.slice(capture.selectionFrom, capture.selectionTo),
    };
    askInput.value = "";
    renderContext();
    renderPanel();
    askInput.focus();
  }

  function close(): void {
    closeButtonMenu();
    cancel();
    requestId = null;
    closeHistory();
    paletteOpen = false;
    panelOpen = false;
    palette.hidden = true;
    panel.hidden = true;
    cancelAnimationFrame(answerFrame);
    answerFrame = 0;
  }

  // -------------------------------------------------------------------------
  // Interaction
  // -------------------------------------------------------------------------

  button.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    const start = { x: event.clientX, y: event.clientY };
    const origin = position ?? { x: 0, y: 0 };
    dragMoved = false;
    button.setPointerCapture(event.pointerId);

    const move = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== event.pointerId) return;
      if (!dragMoved && !movedEnough(start, { x: moveEvent.clientX, y: moveEvent.clientY })) {
        return;
      }
      if (!dragMoved) closePalette();
      dragMoved = true;
      const rect = pane.getBoundingClientRect();
      position = clampButtonPosition(
        {
          x: origin.x + moveEvent.clientX - start.x,
          y: origin.y + moveEvent.clientY - start.y,
        },
        rect.width,
        rect.height,
        BUTTON_SIZE,
        PANE_MARGIN,
      );
      anchor = anchorFromPosition(position, rect.width, rect.height, BUTTON_SIZE, PANE_MARGIN);
      button.style.left = `${Math.round(position.x)}px`;
      button.style.top = `${Math.round(position.y)}px`;
      if (panelOpen) placeDocumentPopover(panel);
    };
    const up = (upEvent: PointerEvent) => {
      if (upEvent.pointerId !== event.pointerId) return;
      button.removeEventListener("pointermove", move);
      button.removeEventListener("pointerup", up);
      button.removeEventListener("pointercancel", up);
      if (button.hasPointerCapture(event.pointerId)) {
        button.releasePointerCapture(event.pointerId);
      }
      suppressClick = dragMoved;
    };
    button.addEventListener("pointermove", move);
    button.addEventListener("pointerup", up);
    button.addEventListener("pointercancel", up);
  });

  button.addEventListener("click", () => {
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    if (paletteOpen) closePalette();
    else openPalette();
  });

  // The webview's own menu (Back, Refresh, Save as, Print) has no meaning on a
  // floating assistant control. This listener owns the whole gesture, exactly
  // as the editor's menu owns its surface.
  button.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    event.stopPropagation();
    openButtonMenu(event.clientX, event.clientY);
  });

  // The keyboard route to the same menu: the Menu key, or Shift+F10.
  button.addEventListener("keydown", (event) => {
    if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = button.getBoundingClientRect();
    openButtonMenu(rect.left, rect.bottom + 2);
  });

  search.addEventListener("input", () => renderPalette());
  search.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive(activeIndex + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive(activeIndex - 1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const current = rows[activeIndex];
      if (current) choose(current.action, current.reason);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closePalette();
      button.focus();
    }
  });

  palette
    .querySelector<HTMLButtonElement>('[data-command="history"]')!
    .addEventListener("click", () => {
      closePalette();
      openHistory();
    });
  palette
    .querySelector<HTMLButtonElement>('[data-command="settings"]')!
    .addEventListener("click", () => {
      close();
      host.openSettings();
    });

  historyClose.addEventListener("click", () => {
    closeHistory();
    button.focus();
  });
  historyBack.addEventListener("click", backToHistory);
  historyClear.addEventListener("click", () => {
    historyEntries = [];
    historyDetailId = null;
    renderHistory();
    historyClose.focus();
    host.toast("Assistant history cleared.");
  });
  historyEl.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (historyDetailId) backToHistory();
      else {
        closeHistory();
        button.focus();
      }
      return;
    }
    if (historyDetailId || (event.key !== "ArrowDown" && event.key !== "ArrowUp")) return;
    const historyRows = Array.from(
      historyList.querySelectorAll<HTMLButtonElement>(".ai-history-row"),
    );
    if (historyRows.length === 0) return;
    event.preventDefault();
    const index = historyRows.indexOf(document.activeElement as HTMLButtonElement);
    const step = event.key === "ArrowDown" ? 1 : -1;
    const next = index < 0 ? 0 : (index + step + historyRows.length) % historyRows.length;
    historyRows[next].focus();
  });

  closeButton.addEventListener("click", () => {
    close();
    host.focusEditor();
  });

  for (const handle of root.querySelectorAll<HTMLButtonElement>(".ai-resize")) {
    const element = handle.closest<HTMLElement>(".ai-popover");
    if (!element) continue;
    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      startResize(event, element, handle);
    });
    handle.addEventListener("dblclick", (event) => {
      event.preventDefault();
      event.stopPropagation();
      customPopoverRect = null;
      placeDocumentPopover(element);
    });
    handle.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (!event.key.startsWith("Arrow")) return;
      event.preventDefault();
      event.stopPropagation();
      nudgeResize(event, element);
    });
  }

  for (const toggle of toggleButtons) {
    toggle.addEventListener("click", () => {
      showChanges = toggle.dataset.view === "changes";
      renderAnswer();
    });
  }

  askInput.addEventListener("input", () => updateGenerate());
  askInput.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      if (state !== "running") startRequest();
    }
  });
  askGenerate.addEventListener("click", () => {
    if (state === "running") cancel();
    else startRequest();
  });

  panel.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    if (state === "running") cancel();
    else {
      close();
      host.focusEditor();
    }
  });

  document.addEventListener(
    "pointerdown",
    (event) => {
      if (!paletteOpen && !historyOpen) return;
      if (event.target instanceof Node && root.contains(event.target)) return;
      closePalette();
      closeHistory();
    },
    true,
  );

  window.addEventListener("resize", () => {
    placeButton();
    placeOpenPopovers();
  });

  // The button has no position until the pane has a size. A ResizeObserver
  // covers the first layout, the sidebar toggle, the splitter and a window
  // restore without asking the shell to call anything.
  new ResizeObserver(() => {
    placeButton();
    placeOpenPopovers();
  }).observe(pane);

  function resetPosition(): void {
    const rect = pane.getBoundingClientRect();
    anchor = null;
    position = defaultButtonPosition(
      rect.width,
      rect.height,
      BUTTON_SIZE,
      ANCHOR_SIDE_MARGIN,
      PANE_MARGIN,
    );
    placeButton();
    customPopoverRect = null;
    if (panelOpen) placeDocumentPopover(panel);
    if (historyOpen) placeDocumentPopover(historyEl);
  }

  function sync(): void {
    config = host.config();
    const visible = ready();
    root.hidden = !visible;
    if (!visible) {
      close();
      return;
    }
    placeButton();
    placeOpenPopovers();
  }

  function onViewMode(mode: api.ViewMode): void {
    if (mode === "preview") close();
    else sync();
  }

  sync();

  return {
    sync,
    close,
    cancel,
    resetPosition,
    onViewMode,
    isOpen: () => paletteOpen || panelOpen || historyOpen,
  };
}
