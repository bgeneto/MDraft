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
  convertTargets,
  defaultParameter,
  groupedActions,
  parameterIsValid,
  searchActions,
  type AiActionSpec,
} from "./actions";
import {
  blockInsertion,
  buildRequest,
  clampButtonPosition,
  defaultButtonPosition,
  joinContinuation,
  movedEnough,
  targetIsCurrent,
  trimHistory,
  trimPreceding,
  type ApplyPlan,
  type Capture,
  type Point,
} from "./context";
import { diffSummary, wordDiff } from "./diff";

const BUTTON_SIZE = 40;
const PALETTE_WIDTH = 340;
const PANEL_WIDTH = 440;
const PANE_MARGIN = 8;
const ANCHOR_MARGIN = 20;

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
}

export interface AssistantHandle {
  /** Re-read the configuration and show or hide the button. */
  sync(): void;
  /** Open the palette, or Preferences when the assistant is not configured. */
  open(): void;
  close(): void;
  /** Stop an in-flight request; the panel stays open on its partial answer. */
  cancel(): void;
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

function chatHtml(text: string): string {
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
  return container.innerHTML;
}

export function createAssistant(pane: HTMLElement, host: AssistantHost): AssistantHandle {
  const root = document.createElement("div");
  root.className = "ai-assistant";
  root.hidden = true;
  root.innerHTML = `
    <button class="ai-fab" type="button" aria-label="AI Assistant" title="AI Assistant (Ctrl+Shift+Space)">
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
        <button class="ai-link" type="button" data-command="reset">Reset button position</button>
        <button class="ai-link" type="button" data-command="settings">AI Assistant Settings…</button>
      </div>
    </div>
    <section class="ai-popover ai-panel" role="dialog" aria-modal="false" aria-labelledby="ai-panel-title" hidden>
      <header class="ai-panel-header">
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
          <pre class="ai-answer"></pre>
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
  let paletteOpen = false;
  let panelOpen = false;
  let activeIndex = 0;
  let rows: { action: AiActionSpec; element: HTMLButtonElement; reason: string | null }[] = [];
  let suppressClick = false;
  let answerFrame = 0;
  let dragMoved = false;
  let userMoved = false;

  function ready(): boolean {
    if (!config.enabled || !config.model.trim()) return false;
    try {
      const url = new URL(config.baseUrl.trim());
      return url.protocol === "http:" || url.protocol === "https:";
    } catch {
      return false;
    }
  }

  function placeButton(): void {
    if (root.hidden) return;
    const rect = pane.getBoundingClientRect();
    if (rect.width < BUTTON_SIZE + PANE_MARGIN * 2 || rect.height < BUTTON_SIZE + PANE_MARGIN * 2) {
      return;
    }
    if (!position || !userMoved) {
      // Until the reader drags it, the button follows the bottom-right anchor.
      // The first layout can still be settling (fonts, tabs, status bar), so a
      // position captured once would leave the button 100+ px from the corner.
      position = defaultButtonPosition(rect.width, rect.height, BUTTON_SIZE, ANCHOR_MARGIN);
    }
    position = clampButtonPosition(position, rect.width, rect.height, BUTTON_SIZE, PANE_MARGIN);
    button.style.left = `${Math.round(position.x)}px`;
    button.style.top = `${Math.round(position.y)}px`;
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
  // Panel
  // -------------------------------------------------------------------------

  function openPanel(spec: AiActionSpec): void {
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
    placePopover(panel, PANEL_WIDTH);
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

  function renderContext(): void {
    if (!action || !capture) return;
    const current = capture;
    const preceded = trimPreceding(current.preceding);
    const preview = (() => {
      if (action.id === "ask") {
        return current.hasSelection ? `<passage>\n${current.selection}\n</passage>` : "";
      }
      if (action.id === "continue") {
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
    if (action.id === "ask") {
      summary = current.hasSelection
        ? `Selection · ${formatCount(current.selection.length)} characters`
        : "No document context";
    } else if (action.id === "continue") {
      summary = current.hasSelection
        ? `Selection · ${formatCount(current.selection.length)} characters, plus the text before it`
        : `${formatCount(preceded.text.length)} characters before the caret`;
      if (preceded.truncated) summary += " · trimmed to 12,000";
    } else {
      summary = `${current.hasSelection ? "Selection" : "Current paragraph"} · ${formatCount(
        (current.hasSelection ? current.selection : current.paragraph).length,
      )} characters`;
    }
    contextSummary.textContent = `${summary} · exact context`;
    contextText.textContent = preview;
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
    if (panelOpen) placePopover(panel, PANEL_WIDTH);
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
      answerEl.textContent = answerText;
    }
  }

  function chatBubble(role: "user" | "assistant", text: string, render: boolean): HTMLElement {
    const bubble = document.createElement("div");
    bubble.className = `ai-chat-bubble ai-chat-${role}`;
    if (role === "assistant" && render) {
      bubble.classList.add("ai-chat-markdown");
      bubble.innerHTML = chatHtml(text);
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
      footerActions.appendChild(actionButton("Retry", true, () => startRequest()));
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
      footerActions.appendChild(actionButton("Regenerate", false, () => startRequest()));
      return;
    }

    if (spec.apply === "block") {
      footerActions.appendChild(
        actionButton("Insert below", true, () => applyAnswer("below"), !canApply(), blockedReason),
      );
      footerActions.appendChild(actionButton("Copy", false, () => void copyAnswer()));
      footerActions.appendChild(actionButton("Regenerate", false, () => startRequest()));
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
    footerActions.appendChild(actionButton("Regenerate", false, () => startRequest()));
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

  function startRequest(): void {
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
    const call = api.aiComplete(request, (event) => onEvent(event));
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
    if (!panelOpen) return;
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
    cancel();
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
      userMoved = true;
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
      button.style.left = `${Math.round(position.x)}px`;
      button.style.top = `${Math.round(position.y)}px`;
      if (panelOpen) placePopover(panel, PANEL_WIDTH);
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
    .querySelector<HTMLButtonElement>('[data-command="reset"]')!
    .addEventListener("click", () => {
      const rect = pane.getBoundingClientRect();
      userMoved = false;
      position = defaultButtonPosition(rect.width, rect.height, BUTTON_SIZE, ANCHOR_MARGIN);
      placeButton();
      closePalette();
      host.toast("Assistant button position reset.");
    });
  palette
    .querySelector<HTMLButtonElement>('[data-command="settings"]')!
    .addEventListener("click", () => {
      close();
      host.openSettings();
    });

  closeButton.addEventListener("click", () => {
    close();
    host.focusEditor();
  });

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
      if (!paletteOpen) return;
      if (event.target instanceof Node && root.contains(event.target)) return;
      closePalette();
    },
    true,
  );

  window.addEventListener("resize", () => {
    placeButton();
    if (paletteOpen) placePopover(palette, PALETTE_WIDTH, 520);
    if (panelOpen) placePopover(panel, PANEL_WIDTH);
  });

  // The button has no position until the pane has a size. A ResizeObserver
  // covers the first layout, the sidebar toggle, the splitter and a window
  // restore without asking the shell to call anything.
  new ResizeObserver(() => placeButton()).observe(pane);

  function sync(): void {
    config = host.config();
    const visible = ready();
    root.hidden = !visible;
    if (!visible) {
      close();
      return;
    }
    placeButton();
    if (paletteOpen) placePopover(palette, PALETTE_WIDTH, 520);
    if (panelOpen) placePopover(panel, PANEL_WIDTH);
  }

  function onViewMode(mode: api.ViewMode): void {
    if (mode === "preview") close();
    else sync();
  }

  sync();

  return {
    sync,
    open: openPalette,
    close,
    cancel,
    onViewMode,
    isOpen: () => paletteOpen || panelOpen,
  };
}
