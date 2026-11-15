//! The Optional tools dialog and its background install queue.
//!
//! The dialog is a view over controller state, not the owner of the install.
//! Closing it removes the DOM but leaves the `invoke` promise, the queue and the
//! status-bar indicator running. This is deliberate: a 40 MB download must not
//! hold the editor hostage, and there is no Cancel control.
//!
//! The controller never imports Tauri or `api` directly. The shell supplies a
//! host that reads statuses, starts one install and updates the status bar; the
//! pure selection and status rules live in `optional-tools-state.ts`.

import {
  OPTIONAL_TOOL_META,
  OPTIONAL_TOOL_NAME,
  OPTIONAL_TOOLS,
  defaultSelection,
  downloadLabel,
  formatDownloadBytes,
  isInstallable,
  isReady,
  normalizeStatuses,
  progressPercent,
  type OptionalTool,
  type OptionalToolPhase,
  type OptionalToolRuntime,
  type OptionalToolStatus,
  type OptionalToolsMode,
  type RawOptionalToolsStatuses,
} from "./optional-tools-state";

export interface OptionalToolProgress {
  tool: OptionalTool;
  phase: OptionalToolPhase;
  received: number;
  total: number | null;
}

export interface OptionalToolsIndicator {
  tool: OptionalTool;
  phase: OptionalToolPhase;
  received: number;
  total: number | null;
  /** One-based position in the queue. */
  index: number;
  count: number;
}

export interface OptionalToolsHost {
  /** Read all three statuses; the shell mirrors the answers into its caches. */
  loadStatuses(): Promise<RawOptionalToolsStatuses>;
  /** Download, verify and install one tool. Throws with a reader-facing message. */
  install(tool: OptionalTool): Promise<void>;
  /** Present in only one place: the dialog hides it while open. */
  showIndicator(state: OptionalToolsIndicator | null): void;
  toast(text: string, ms?: number): void;
  /** Open the project's download page for a tool that cannot be installed here. */
  openDownloadPage(): void;
  /** Open Preferences › LaTeX for a native-engine problem. */
  openLatexPreferences(): void;
  /** Turn on bundled TeX when its verified assets are already on disk. */
  enableLatex(): Promise<void>;
  /** Restore focus when the previous element is gone. */
  focusEditor(): void;
}

export type InstallOutcome = "ready" | "declined" | "failed";

interface OpenOptions {
  /** The full sentence above the rows in context mode. */
  context?: string;
  /** The tools the blocked action needs. */
  required?: readonly OptionalTool[];
  /** Skip the host probe when the caller already has the raw answers. */
  statuses?: RawOptionalToolsStatuses;
}

interface RowRefs {
  root: HTMLElement;
  progress: HTMLProgressElement | null;
  status: HTMLElement | null;
  /** The live region is updated on phase changes, never on every byte. */
  live: HTMLElement | null;
  phase: OptionalToolPhase | null;
}

type CloseReason = "declined" | "background";

const META_ORDER = OPTIONAL_TOOLS;

function node<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = "",
  text = "",
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text) element.textContent = text;
  return element;
}

function button(label: string, className = ""): HTMLButtonElement {
  const element = node("button", className, label);
  element.type = "button";
  return element;
}

function sourceLabel(status: Extract<OptionalToolStatus, { kind: "ready" }>): string {
  const version = status.version ? ` · ${status.version}` : "";
  if (status.source === "path") return `Found on PATH${version}`;
  if (status.source === "native") return `Using ${status.version ?? "the installed engine"}`;
  if (status.source === "managed") return `Installed by MDraft${version}`;
  return `Installed${version}`;
}

/** A short sentence for the live region; it changes only between phases. */
function livePhaseText(runtime: Extract<OptionalToolRuntime, { kind: "active" }>): string {
  if (runtime.phase === "verifying") return "Verifying the download.";
  if (runtime.phase === "unpacking") return "Unpacking the download.";
  if (runtime.phase === "ready") return "Installed.";
  return "Downloading.";
}

function phaseText(runtime: Extract<OptionalToolRuntime, { kind: "active" }>): string {
  if (runtime.phase === "verifying") return "Verifying checksum…";
  if (runtime.phase === "unpacking") return "Unpacking…";
  if (runtime.phase === "ready") return "Installed";
  const total = runtime.total;
  if (total && total > 0) {
    return `Downloading… ${formatDownloadBytes(runtime.received)} of ${formatDownloadBytes(total)}`;
  }
  if (runtime.received > 0) return `Downloading… ${formatDownloadBytes(runtime.received)}`;
  return "Downloading…";
}

export function createOptionalTools(host: OptionalToolsHost): OptionalToolsController {
  return new OptionalToolsController(host);
}

export class OptionalToolsController {
  private readonly host: OptionalToolsHost;
  private mode: OptionalToolsMode = "manage";
  private contextText: string | null = null;
  private statuses: Record<OptionalTool, OptionalToolStatus> | null = null;
  private runtime: Record<OptionalTool, OptionalToolRuntime> = {
    pandoc: { kind: "idle" },
    typst: { kind: "idle" },
    latex: { kind: "idle" },
  };
  private selected = new Set<OptionalTool>();
  private locked = new Set<OptionalTool>();
  private required = new Set<OptionalTool>();
  private queue: OptionalTool[] = [];
  private queueIndex = 0;
  private active: OptionalTool | null = null;
  private busy = false;
  private opening = false;
  private dialog: HTMLDialogElement | null = null;
  private previousFocus: HTMLElement | null = null;
  private resolveInstall: ((outcome: InstallOutcome) => void) | null = null;
  private list: HTMLElement | null = null;
  private contextLine: HTMLElement | null = null;
  private note: HTMLElement | null = null;
  private primary: HTMLButtonElement | null = null;
  private secondary: HTMLButtonElement | null = null;
  private rows = new Map<OptionalTool, RowRefs>();

  constructor(host: OptionalToolsHost) {
    this.host = host;
  }

  isOpen(): boolean {
    return this.dialog !== null;
  }

  isBusy(): boolean {
    return this.busy;
  }

  /**
   * Open the dialog. `first-run` stays silent when nothing is missing; `manage`
   * and `context` always show what the caller asked for.
   */
  async open(mode: OptionalToolsMode = "manage", options: OpenOptions = {}): Promise<void> {
    if (this.dialog) {
      if (!this.busy) {
        this.mode = mode;
        this.contextText = options.context ?? null;
        this.required = new Set(options.required ?? []);
        this.applyDefaultSelection();
      }
      this.render();
      this.dialog.focus();
      return;
    }
    if (this.opening) return;
    if (document.querySelector("dialog[open], .prefs-overlay:not([hidden])")) return;

    this.opening = true;
    try {
      const raw = options.statuses ?? (await this.host.loadStatuses());
      this.statuses = normalizeStatuses(raw);
      if (!this.busy) {
        this.mode = mode;
        this.contextText = options.context ?? null;
        this.required = new Set(options.required ?? []);
        this.applyDefaultSelection();
      }
      if (this.mode === "first-run" && !this.hasMissingTool()) return;
      this.buildDialog();
    } catch (error) {
      // A first-run probe failure must not greet the reader with an error. An
      // explicit Tools open has a reader waiting, so it gets the reason.
      if (mode !== "first-run") {
        this.host.toast(`Could not check the optional tools: ${String(error)}`, 5200);
      }
    } finally {
      this.opening = false;
    }
  }

  /**
   * Open context mode for one export or preview, and resolve when the tools it
   * needs are ready.
   *
   * A tool that is installed but switched off does not download: the dialog
   * offers Enable, and the promise waits for it. A tool this build cannot
   * install returns `failed` after the dialog explains why.
   */
  async installFor(required: readonly OptionalTool[], context: string): Promise<InstallOutcome> {
    if (this.busy || this.resolveInstall) {
      this.host.toast("Wait for the current setup to finish.");
      return "failed";
    }
    let raw: RawOptionalToolsStatuses;
    try {
      raw = await this.host.loadStatuses();
    } catch (error) {
      this.host.toast(`Could not check the optional tools: ${String(error)}`, 5200);
      return "failed";
    }
    const statuses = normalizeStatuses(raw);
    this.statuses = statuses;
    const unique = [...new Set(required)];
    if (unique.every((tool) => isReady(statuses[tool]))) return "ready";

    this.mode = "context";
    this.contextText = context;
    this.required = new Set(unique);
    this.applyDefaultSelection();
    this.showDialog();

    if (unique.some((tool) => statuses[tool].kind === "blocked")) {
      // The row names the manual route. There is no download to wait for.
      return "failed";
    }
    return new Promise<InstallOutcome>((resolve) => {
      this.resolveInstall = resolve;
    });
  }

  /** One event from Rust. A stale or foreign tool is ignored. */
  progress(progress: OptionalToolProgress): void {
    if (progress.tool !== this.active) return;
    this.runtime[progress.tool] = {
      kind: "active",
      phase: progress.phase,
      received: progress.received,
      total: progress.total,
    };
    this.updateRow(progress.tool);
    this.updateIndicator();
  }

  private applyDefaultSelection(): void {
    if (!this.statuses) return;
    this.selected = new Set(defaultSelection(this.mode, this.statuses, [...this.required]));
    this.locked = new Set(
      this.mode === "context"
        ? [...this.required].filter((tool) => isInstallable(this.statuses![tool]))
        : [],
    );
  }

  private hasMissingTool(): boolean {
    if (!this.statuses) return false;
    return OPTIONAL_TOOLS.some((tool) => this.statuses![tool].kind === "missing");
  }

  // -------------------------------------------------------------------------
  // Dialog construction
  // -------------------------------------------------------------------------

  private showDialog(): void {
    if (this.dialog) {
      this.render();
      this.dialog.focus();
      return;
    }
    this.buildDialog();
  }

  private buildDialog(): void {
    if (!this.statuses) return;
    this.previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = node("dialog", "optional-tools-dialog");
    dialog.setAttribute("aria-labelledby", "optional-tools-title");

    const header = node("header", "optional-tools-header");
    const title = node("h2", "", "Optional tools");
    title.id = "optional-tools-title";
    const subtitle = node(
      "p",
      "optional-tools-subtitle",
      "MDraft uses separate open-source tools for some export formats and previews. " +
        "Add only what you need — the editor and Markdown preview work without them.",
    );
    header.append(title, subtitle);

    const contextLine = node("p", "optional-tools-context");
    contextLine.hidden = !this.contextText;
    contextLine.textContent = this.contextText ?? "";

    const list = node("div", "optional-tools-list");
    list.setAttribute("role", "group");
    list.setAttribute("aria-labelledby", "optional-tools-title");

    const footer = node("div", "optional-tools-footer");
    const note = node(
      "p",
      "optional-tools-note",
      "Nothing is downloaded until you press Download. You can add these later from the Tools menu.",
    );
    const trust = node(
      "p",
      "optional-tools-trust",
      "Official releases, checksum-verified; no administrator rights. Your documents are never uploaded.",
    );
    const actions = node("div", "optional-tools-actions");
    const secondary = button("Not now", "optional-tools-secondary");
    const primary = button("Done", "optional-tools-primary");
    actions.append(secondary, primary);
    footer.append(note, trust, actions);

    dialog.append(header, contextLine, list, footer);
    this.dialog = dialog;
    this.list = list;
    this.contextLine = contextLine;
    this.note = note;
    this.primary = primary;
    this.secondary = secondary;

    secondary.addEventListener("click", () => {
      this.close(this.busy ? "background" : "declined");
    });
    primary.addEventListener("click", () => {
      if (this.busy) return;
      if (this.primaryLabel() === "Done") {
        this.close("declined");
        return;
      }
      void this.start();
    });

    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      this.requestClose();
    });
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) this.requestClose();
    });
    // The shell's menu accelerators run in the capture phase; this keeps the
    // editor's keymaps out while the dialog is modal.
    dialog.addEventListener("keydown", (event) => event.stopPropagation());

    this.render();
    document.body.append(dialog);
    try {
      dialog.showModal();
    } catch {
      this.close("declined");
      return;
    }
    this.focusFirstRow();
    this.updateIndicator();
  }

  private focusFirstRow(): void {
    const first = this.dialog?.querySelector<HTMLInputElement>(
      ".optional-tools-row input:not(:disabled)",
    );
    (first ?? this.primary)?.focus();
  }

  private requestClose(): void {
    this.close(this.busy ? "background" : "declined");
  }

  private close(reason: CloseReason): void {
    const dialog = this.dialog;
    if (!dialog) return;
    this.dialog = null;
    this.list = null;
    this.contextLine = null;
    this.note = null;
    this.primary = null;
    this.secondary = null;
    this.rows.clear();
    dialog.close();
    dialog.remove();

    if (this.busy) {
      this.updateIndicator();
      this.restoreFocus();
      return;
    }
    if (this.resolveInstall) {
      const resolve = this.resolveInstall;
      this.resolveInstall = null;
      resolve(reason === "background" ? "failed" : "declined");
    }
    this.updateIndicator();
    this.restoreFocus();
  }

  private restoreFocus(): void {
    const previous = this.previousFocus;
    this.previousFocus = null;
    if (
      previous &&
      previous !== document.body &&
      previous !== document.documentElement &&
      previous.isConnected &&
      previous.getClientRects().length > 0
    ) {
      previous.focus({ preventScroll: true });
    } else {
      this.host.focusEditor();
    }
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  private render(): void {
    if (!this.dialog) return;
    if (this.contextLine) {
      this.contextLine.hidden = !this.contextText;
      this.contextLine.textContent = this.contextText ?? "";
    }
    this.renderRows();
    this.renderFooter();
  }

  private renderRows(): void {
    if (!this.list || !this.statuses) return;
    this.rows.clear();
    this.list.replaceChildren(...META_ORDER.map((tool) => this.buildRow(tool)));
  }

  private buildRow(tool: OptionalTool): HTMLElement {
    const meta = OPTIONAL_TOOL_META[tool];
    const status = this.statuses![tool];
    const runtime = this.runtime[tool];

    if (runtime.kind === "active") return this.buildProgressRow(tool, runtime);
    if (runtime.kind === "failed") return this.buildFailedRow(tool, runtime.message);
    if (runtime.kind === "queued") {
      const row = node("div", "optional-tools-row is-queued");
      row.dataset.tool = tool;
      row.append(
        this.rowBody(meta.title, meta.hint),
        node("span", "optional-tools-state", "Waiting…"),
      );
      return row;
    }
    if (status.kind === "missing") return this.buildMissingRow(tool, status);
    if (status.kind === "ready") return this.buildReadyRow(tool, status);
    if (status.kind === "off") return this.buildOffRow(tool);
    return this.buildBlockedRow(tool, status);
  }

  private rowBody(title: string, hint: string): HTMLElement {
    const body = node("span", "optional-tools-row-body");
    body.append(
      node("span", "optional-tools-row-title", title),
      node("span", "optional-tools-row-hint", hint),
    );
    return body;
  }

  private buildMissingRow(
    tool: OptionalTool,
    status: Extract<OptionalToolStatus, { kind: "missing" }>,
  ): HTMLElement {
    const meta = OPTIONAL_TOOL_META[tool];
    const row = node("label", "optional-tools-row");
    row.dataset.tool = tool;
    const input = node("input");
    input.type = "checkbox";
    input.checked = this.selected.has(tool);
    input.disabled = this.busy || this.locked.has(tool);
    input.setAttribute("aria-label", meta.title);
    input.addEventListener("change", () => {
      if (input.checked) this.selected.add(tool);
      else this.selected.delete(tool);
      this.renderFooter();
    });

    const body = node("span", "optional-tools-row-body");
    const title = node("span", "optional-tools-row-title", meta.title);
    if (meta.recommended && this.mode !== "context") {
      title.append(node("span", "optional-tools-chip", "Recommended"));
    }
    if (this.locked.has(tool)) {
      title.append(node("span", "optional-tools-chip is-required", "Required"));
    }
    body.append(title, node("span", "optional-tools-row-hint", meta.hint));
    if (status.hint) appendExtraHint(body, status.hint);
    row.append(input, body);
    return row;
  }

  private buildReadyRow(
    tool: OptionalTool,
    status: Extract<OptionalToolStatus, { kind: "ready" }>,
  ): HTMLElement {
    const meta = OPTIONAL_TOOL_META[tool];
    const row = node("div", "optional-tools-row is-ready");
    row.dataset.tool = tool;
    const body = node("span", "optional-tools-row-body");
    body.append(
      node("span", "optional-tools-row-title", meta.title),
      node("span", "optional-tools-row-hint", meta.hint),
      node("span", "optional-tools-state is-ready", sourceLabel(status)),
    );
    row.append(node("span", "optional-tools-check", "✓"), body);
    return row;
  }

  private buildOffRow(tool: OptionalTool): HTMLElement {
    const meta = OPTIONAL_TOOL_META[tool];
    const row = node("div", "optional-tools-row is-off");
    row.dataset.tool = tool;
    const body = node("span", "optional-tools-row-body");
    const state = node("span", "optional-tools-state", "Installed, off");
    const enable = button("Enable", "optional-tools-link");
    enable.disabled = this.busy;
    enable.addEventListener("click", () => void this.enableTool(tool));
    state.append(" · ", enable);
    body.append(
      node("span", "optional-tools-row-title", meta.title),
      node("span", "optional-tools-row-hint", meta.hint),
      state,
    );
    row.append(node("span", "optional-tools-check is-off", "○"), body);
    return row;
  }

  private buildBlockedRow(
    tool: OptionalTool,
    status: Extract<OptionalToolStatus, { kind: "blocked" }>,
  ): HTMLElement {
    const meta = OPTIONAL_TOOL_META[tool];
    const row = node("div", "optional-tools-row is-blocked");
    row.dataset.tool = tool;
    const body = node("span", "optional-tools-row-body");
    const state = node("span", "optional-tools-state is-warning", status.hint);
    const action = button(
      status.action === "download-page" ? "Open download page" : "Preferences › LaTeX",
      "optional-tools-link",
    );
    action.addEventListener("click", () => {
      if (status.action === "download-page") this.host.openDownloadPage();
      else this.host.openLatexPreferences();
    });
    state.append(" ", action);
    body.append(
      node("span", "optional-tools-row-title", meta.title),
      node("span", "optional-tools-row-hint", meta.hint),
      state,
    );
    row.append(node("span", "optional-tools-check is-blocked", "!"), body);
    return row;
  }

  private buildProgressRow(
    tool: OptionalTool,
    runtime: Extract<OptionalToolRuntime, { kind: "active" }>,
  ): HTMLElement {
    const meta = OPTIONAL_TOOL_META[tool];
    const row = node("div", "optional-tools-row is-active");
    row.dataset.tool = tool;
    row.setAttribute("aria-busy", "true");
    const body = node("span", "optional-tools-row-body");
    const status = node("span", "optional-tools-state", phaseText(runtime));
    const progress = node("progress", "optional-tools-progress");
    progress.max = 100;
    const percent = progressPercent(runtime.received, runtime.total);
    if (percent === null) progress.removeAttribute("value");
    else progress.value = percent;
    progress.setAttribute("aria-label", `${OPTIONAL_TOOL_NAME[tool]} download`);
    const live = node("span", "optional-tools-live", livePhaseText(runtime));
    live.setAttribute("aria-live", "polite");
    body.append(
      node("span", "optional-tools-row-title", meta.title),
      node("span", "optional-tools-row-hint", meta.hint),
      progress,
      status,
      live,
    );
    row.append(node("span", "optional-tools-check is-active", "↓"), body);
    this.rows.set(tool, {
      root: row,
      progress,
      status,
      live,
      phase: runtime.phase,
    });
    return row;
  }

  private buildFailedRow(tool: OptionalTool, message: string): HTMLElement {
    const meta = OPTIONAL_TOOL_META[tool];
    const row = node("div", "optional-tools-row is-failed");
    row.dataset.tool = tool;
    const body = node("span", "optional-tools-row-body");
    const retry = button("Retry", "optional-tools-link");
    retry.disabled = this.busy;
    retry.addEventListener("click", () => void this.retry(tool));
    body.append(
      node("span", "optional-tools-row-title", meta.title),
      node("span", "optional-tools-row-hint", meta.hint),
      node("span", "optional-tools-state is-error", message),
      retry,
    );
    row.append(node("span", "optional-tools-check is-failed", "!"), body);
    return row;
  }

  private updateRow(tool: OptionalTool): void {
    const refs = this.rows.get(tool);
    const runtime = this.runtime[tool];
    if (!refs || runtime.kind !== "active") {
      this.renderRows();
      return;
    }
    if (refs.progress) {
      const percent = progressPercent(runtime.received, runtime.total);
      if (percent === null) refs.progress.removeAttribute("value");
      else refs.progress.value = percent;
    }
    if (refs.status) refs.status.textContent = phaseText(runtime);
    if (refs.live && refs.phase !== runtime.phase) {
      refs.phase = runtime.phase;
      refs.live.textContent = livePhaseText(runtime);
    }
  }

  private primaryLabel(): string {
    if (!this.statuses) return "Done";
    return downloadLabel([...this.selected], this.statuses);
  }

  private renderFooter(): void {
    if (!this.primary || !this.secondary || !this.note) return;
    if (this.busy) {
      this.primary.textContent = "Downloading…";
      this.primary.disabled = true;
      this.secondary.textContent = "Continue in background";
      this.secondary.hidden = false;
      this.note.textContent =
        "You can close this window; the download continues in the background.";
      return;
    }
    const label = this.primaryLabel();
    this.primary.textContent = label;
    this.primary.disabled = false;
    this.secondary.textContent = "Not now";
    this.secondary.hidden = label === "Done";
    this.note.textContent =
      "Nothing is downloaded until you press Download. You can add these later from the Tools menu.";
  }

  // -------------------------------------------------------------------------
  // Installs
  // -------------------------------------------------------------------------

  private async start(): Promise<void> {
    if (this.busy || !this.statuses) return;
    const installable = META_ORDER.filter(
      (tool) => this.selected.has(tool) && isInstallable(this.statuses![tool]),
    );
    if (installable.length === 0) return;

    this.busy = true;
    this.queue = installable;
    this.queueIndex = 0;
    for (const tool of installable) this.runtime[tool] = { kind: "queued" };
    this.render();
    this.secondary?.focus();

    for (let index = 0; index < this.queue.length; index += 1) {
      const tool = this.queue[index];
      this.queueIndex = index;
      this.active = tool;
      this.runtime[tool] = {
        kind: "active",
        phase: "downloading",
        received: 0,
        total: null,
      };
      this.render();
      this.updateIndicator();
      try {
        await this.host.install(tool);
        try {
          this.statuses = normalizeStatuses(await this.host.loadStatuses());
        } catch {
          // The install itself succeeded; the next explicit check repairs the
          // status. Do not turn a successful install into a failure.
        }
        this.runtime[tool] = { kind: "idle" };
        this.selected.delete(tool);
        this.host.toast(`${OPTIONAL_TOOL_NAME[tool]} installed.`, 3200);
        this.settleRequired();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.runtime[tool] = { kind: "failed", message };
        this.host.toast(`Could not install ${OPTIONAL_TOOL_NAME[tool]}: ${message}`, 6200);
        this.settleFailed(tool);
      }
      this.render();
      this.updateIndicator();
    }

    this.active = null;
    this.busy = false;
    this.render();
    this.updateIndicator();
    this.settleRequired();
  }

  private settleRequired(): void {
    if (!this.resolveInstall || !this.statuses) return;
    if ([...this.required].every((tool) => isReady(this.statuses![tool]))) {
      const resolve = this.resolveInstall;
      this.resolveInstall = null;
      resolve("ready");
    }
  }

  private settleFailed(tool: OptionalTool): void {
    if (!this.resolveInstall || !this.required.has(tool)) return;
    const resolve = this.resolveInstall;
    this.resolveInstall = null;
    resolve("failed");
  }

  private async retry(tool: OptionalTool): Promise<void> {
    if (this.busy || !this.statuses) return;
    if (!isInstallable(this.statuses[tool])) {
      this.render();
      return;
    }
    this.selected = new Set([tool]);
    await this.start();
  }

  private async enableTool(tool: OptionalTool): Promise<void> {
    if (this.busy || tool !== "latex") return;
    try {
      await this.host.enableLatex();
      this.statuses = normalizeStatuses(await this.host.loadStatuses());
      this.host.toast("Bundled TeX is enabled.", 3200);
      this.settleRequired();
      this.render();
    } catch (error) {
      this.host.toast(`Could not enable bundled TeX: ${String(error)}`, 6200);
    }
  }

  private updateIndicator(): void {
    if (this.busy && this.active && !this.dialog) {
      const runtime = this.runtime[this.active];
      if (runtime.kind === "active") {
        this.host.showIndicator({
          tool: this.active,
          phase: runtime.phase,
          received: runtime.received,
          total: runtime.total,
          index: this.queueIndex + 1,
          count: this.queue.length,
        });
        return;
      }
    }
    this.host.showIndicator(null);
  }
}

/**
 * A missing Typst can carry a second sentence from the backend. It belongs in
 * the row as text, never as another control.
 */
function appendExtraHint(body: HTMLElement, hint: string): void {
  body.append(node("span", "optional-tools-row-hint is-extra", hint));
}
