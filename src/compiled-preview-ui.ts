//! Application chrome for both compiled formats. Rendered documents never own it.
export interface CompiledStatus {
  label: string;
  severity: "neutral" | "success" | "warning" | "error";
  detail?: string;
  engine?: string;
}

type Icon =
  | "play"
  | "stop"
  | "logs"
  | "download"
  | "copy"
  | "error"
  | "problem"
  | "warning"
  | "ready"
  | "clock";

export class CompiledPreviewUi {
  private compile = this.button("Compile", "compiled-compile", "play");
  private auto = document.createElement("input");
  private toggle = this.button("Logs", "compiled-logs-toggle", "logs");
  private save = this.button("Save PDF…", "compiled-save-pdf", "download");
  private modes = document.createElement("div");
  private message = document.createElement("span");
  private condition = document.createElement("span");
  private stateLabel = document.createElement("span");
  private stateDetail = document.createElement("span");
  private engine = document.createElement("span");
  private phaseText = "";
  private issueText = "";
  private title = document.createElement("h2");
  private caption = document.createElement("p");
  private notice = document.createElement("div");
  private problems = document.createElement("div");
  private raw = document.createElement("pre");
  private count = document.createElement("span");
  private explicitLogs = false;
  private busy = false;
  private log = "";
  private problemTab = this.button("Problems", "compiler-tab");
  private outputTab = this.button("Compiler output", "compiler-tab");

  constructor(
    private shell: HTMLElement,
    private pane: HTMLElement,
    private logs: HTMLElement,
    actions: {
      compile(): void;
      cancel(): void;
      auto(on: boolean): void;
      save(): void;
      mode(mode: "document" | "pages"): void;
      copy(text: string): void;
    },
  ) {
    const header = shell.querySelector<HTMLElement>("#compiled-controls")!;
    header.className = "compiled-toolbar";
    const row = document.createElement("div");
    row.className = "compiled-actions";
    this.auto.type = "checkbox";
    this.auto.setAttribute("role", "switch");
    const label = document.createElement("label");
    label.className = "compiled-auto latex-auto";
    label.append(this.auto, document.createTextNode("Auto-compile"));
    this.modes.className = "compiled-modes";
    this.modes.setAttribute("role", "group");
    this.modes.setAttribute("aria-label", "Typst preview mode");
    for (const mode of ["document", "pages"] as const) {
      const button = this.button(mode === "pages" ? "Pages" : "Document", "compiled-mode");
      button.dataset.mode = mode;
      button.addEventListener("click", () => actions.mode(mode));
      this.modes.append(button);
    }
    this.toggle.setAttribute("aria-controls", logs.id);
    this.toggle.setAttribute("aria-pressed", "false");
    this.count.className = "compiled-issue-count";
    this.toggle.append(this.count);
    this.message.className = "compiled-message latex-build-message";
    this.message.setAttribute("role", "status");
    this.condition.className = "compiled-condition";
    this.stateLabel.className = "compiled-state-label";
    this.stateDetail.className = "compiled-state-detail";
    this.engine.className = "compiled-engine";
    this.condition.append(this.icon("clock"), this.stateLabel);
    this.message.append(this.condition, " ", this.stateDetail, " ", this.engine);
    this.notice.className = "compiled-notice";
    this.notice.hidden = true;
    row.append(this.compile, label, this.modes, this.toggle, this.save);
    header.append(row, this.message, this.notice);
    this.compile.addEventListener("click", () =>
      this.busy ? actions.cancel() : actions.compile(),
    );
    this.auto.addEventListener("change", () => actions.auto(this.auto.checked));
    this.toggle.addEventListener("click", () => this.showLogs(!this.logsOpen));
    this.save.addEventListener("click", actions.save);
    this.caption.className = "compiler-log-caption";
    const tabs = document.createElement("div");
    tabs.className = "compiler-tabs";
    const choices = document.createElement("div");
    choices.setAttribute("role", "tablist");
    choices.setAttribute("aria-label", "Compiler logs");
    const copy = this.button("Copy log", "compiled-copy-log", "copy");
    copy.addEventListener("click", () => actions.copy(this.log));
    this.raw.className = "compiler-output";
    this.problems.id = "compiler-problems";
    this.raw.id = "compiler-output";
    for (const [button, panel] of [
      [this.problemTab, this.problems],
      [this.outputTab, this.raw],
    ]) {
      button.id = `${panel.id}-tab`;
      button.setAttribute("role", "tab");
      button.setAttribute("aria-controls", panel.id);
      panel.setAttribute("role", "tabpanel");
      panel.setAttribute("aria-labelledby", button.id);
      button.addEventListener("click", () => {
        this.explicitLogs = true;
        this.selectLog(button === this.outputTab);
      });
      button.addEventListener("keydown", (event) => {
        const key = (event as KeyboardEvent).key;
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(key)) return;
        event.preventDefault();
        const next =
          key === "Home"
            ? this.problemTab
            : key === "End"
              ? this.outputTab
              : button === this.problemTab
                ? this.outputTab
                : this.problemTab;
        next.click();
        next.focus();
      });
    }
    choices.append(this.problemTab, this.outputTab);
    tabs.append(choices, copy);
    logs.append(this.title, this.caption, tabs, this.problems, this.raw);
    this.selectLog(false);
    this.reset();
  }

  private icon(name: Icon): SVGSVGElement {
    const paths: Record<Icon, string> = {
      play: '<path d="m9 5 12 7-12 7a1 1 0 0 1-1.5-.9V5.9A1 1 0 0 1 9 5Z"/>',
      stop: '<rect x="6" y="6" width="12" height="12" rx="1"/>',
      logs: '<path d="M21 12h-8M21 6H8M21 18h-8M3 6v4a2 2 0 0 0 2 2h3M3 10v6a2 2 0 0 0 2 2h3"/>',
      download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
      copy: '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
      error: '<circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/>',
      problem: '<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6m0-6 6 6"/>',
      warning:
        '<path d="m21.7 18-8-14a2 2 0 0 0-3.4 0l-8 14a2 2 0 0 0 1.7 3h16a2 2 0 0 0 1.7-3ZM12 9v4M12 17h.01"/>',
      ready: '<circle cx="12" cy="12" r="10"/><path d="m8 12 3 3 5-6"/>',
      clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
    };
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "1.75");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    svg.classList.add("compiled-icon");
    svg.innerHTML = paths[name];
    return svg;
  }

  private button(text: string, className: string, icon?: Icon): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className;
    if (icon) {
      const label = document.createElement("span");
      label.className = "compiled-button-label";
      label.textContent = text;
      button.append(this.icon(icon), label);
    } else button.textContent = text;
    return button;
  }

  get logsOpen(): boolean {
    return this.toggle.getAttribute("aria-pressed") === "true";
  }
  get phase(): string {
    return this.phaseText;
  }
  get issueSummary(): string {
    return this.issueText;
  }

  configure(format: "latex" | "typst", auto: boolean, mode = "pages", fileName = ""): void {
    this.shell.classList.add("compiled-preview");
    this.shell.dataset.compiler = format;
    this.shell.querySelector<HTMLElement>("#compiled-controls")!.hidden = false;
    this.auto.checked = auto;
    this.title.textContent = format === "latex" ? "LaTeX logs" : "Typst logs";
    this.caption.textContent = fileName ? `${fileName} · Latest compilation` : "Latest compilation";
    this.save.classList.toggle("latex-save-pdf", format === "latex");
    this.modes.hidden = format !== "typst";
    this.save.hidden = format === "typst" && mode !== "pages";
    for (const button of this.modes.querySelectorAll("button")) {
      button.setAttribute("aria-pressed", String(button.dataset.mode === mode));
    }
  }

  status(message: string, busy = false, saveable = false, state?: CompiledStatus): void {
    this.phaseText = message;
    const [label, ...details] = message.split(" · ");
    const severity = state?.severity ?? "neutral";
    this.condition.dataset.severity = severity;
    this.condition
      .querySelector("svg")!
      .replaceWith(
        this.icon(severity === "success" ? "ready" : severity === "neutral" ? "clock" : severity),
      );
    this.stateLabel.textContent = state?.label ?? label;
    this.stateDetail.textContent = state?.detail ?? details.join(" · ");
    this.stateDetail.hidden = !this.stateDetail.textContent;
    this.engine.textContent = state?.engine ?? "";
    this.engine.hidden = !this.engine.textContent;
    this.busy = busy;
    this.compile.querySelector(".compiled-button-label")!.textContent = busy ? "Cancel" : "Compile";
    this.compile.querySelector("svg")!.replaceWith(this.icon(busy ? "stop" : "play"));
    this.compile.classList.toggle("latex-cancel", busy);
    this.save.disabled = busy || !saveable;
    this.save.title = saveable ? "Save the displayed PDF" : "Compile a current PDF before saving";
  }

  details(panel: HTMLElement, output: string, count: number, failure: boolean): void {
    this.log = output;
    let errors = 0;
    let warnings = 0;
    for (const row of panel.querySelectorAll<HTMLElement>(".latex-problem,.compiled-issue")) {
      const warning =
        row.dataset.severity === "warning" ||
        row.classList.contains("compiled-warning") ||
        /^\s*warning:/i.test(row.textContent ?? "");
      row.dataset.severity = warning ? "warning" : "error";
      if (warning) warnings += 1;
      else errors += 1;
      if (!row.querySelector(":scope > .compiled-issue-body")) {
        const body = document.createElement("span");
        body.className = "compiled-issue-body";
        body.append(...row.childNodes);
        row.append(this.icon(warning ? "warning" : "problem"), body);
      }
    }
    if (!errors && !warnings && count) {
      if (failure) errors = count;
      else warnings = count;
    }
    this.issueText = [
      errors ? `${errors} error${errors === 1 ? "" : "s"}` : "",
      warnings ? `${warnings} warning${warnings === 1 ? "" : "s"}` : "",
    ]
      .filter(Boolean)
      .join(" · ");
    if (!panel.textContent?.trim())
      panel.textContent = failure
        ? output.split("\n")[0] || "Compilation failed; see Compiler output."
        : "No problems reported.";
    this.problems.replaceChildren(panel);
    this.raw.textContent = output || "The compiler reported no messages.";
    this.raw.className = failure ? "compiler-output typst-error" : "compiler-output";
    this.count.textContent = String(count);
    this.count.hidden = count === 0;
    this.count.dataset.severity = failure ? "error" : "warning";
    this.toggle.setAttribute(
      "aria-label",
      count ? `Logs, ${count} problem${count === 1 ? "" : "s"}` : "Logs",
    );
  }

  note(node: HTMLElement | null): void {
    this.notice.replaceChildren(...(node ? [node] : []));
    this.notice.hidden = !node;
  }

  outputReady(): void {
    if (!this.explicitLogs) this.showLogs(false, false);
  }

  showLogs(on: boolean, explicit = true): void {
    if (explicit) this.explicitLogs = on;
    this.toggle.setAttribute("aria-pressed", String(on));
    this.toggle.title = on ? "Hide logs and return to preview" : "Show compiler logs";
    this.shell.classList.toggle("logs-open", on);
    this.pane.inert = on;
    this.pane.setAttribute("aria-hidden", String(on));
    this.logs.inert = !on;
    this.logs.setAttribute("aria-hidden", String(!on));
  }

  private selectLog(output: boolean): void {
    this.problemTab.setAttribute("aria-selected", String(!output));
    this.outputTab.setAttribute("aria-selected", String(output));
    this.problems.hidden = output;
    this.raw.hidden = !output;
  }

  reset(): void {
    this.explicitLogs = false;
    this.status("", false, false);
    this.showLogs(false, false);
    this.shell.classList.remove("compiled-preview");
    delete this.shell.dataset.compiler;
    this.shell.querySelector<HTMLElement>("#compiled-controls")!.hidden = true;
    this.details(document.createElement("div"), "", 0, false);
    this.note(null);
    this.selectLog(false);
  }
}
