//! Application chrome for both compiled formats. Rendered documents never own it.
import { splitLinkedText } from "./latex-backend";

export interface CompiledStatusLink {
  /** Exact substring to render as an inline button link. */
  text: string;
  /** Optional starting offset when `text` could appear earlier in the sentence. */
  index?: number;
  title?: string;
  run: () => void;
}

export interface CompiledStatus {
  label: string;
  severity: "neutral" | "success" | "warning" | "error";
  detail?: string;
  detailLink?: CompiledStatusLink;
  engine?: string;
}

/**
 * Render `text` into `target`, turning `link.text` into an inline button when
 * present. Uses text nodes only so arbitrary filenames cannot inject markup.
 */
export function renderLinkedText(
  target: HTMLElement,
  text: string,
  link?: CompiledStatusLink,
): void {
  const parts = link ? splitLinkedText(text, link.text, link.index) : null;
  if (!parts || !link) {
    target.textContent = text;
    return;
  }
  const button = document.createElement("button");
  button.type = "button";
  button.className = "preview-file-link";
  button.textContent = parts.link;
  if (link.title) button.title = link.title;
  button.addEventListener("click", link.run);
  target.replaceChildren(
    document.createTextNode(parts.before),
    button,
    document.createTextNode(parts.after),
  );
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
  | "clock"
  | "chevron"
  | "restart"
  | "close"
  | "check"
  | "previous"
  | "next";

const IS_MAC = /Mac|iPhone|iPad/.test(navigator.userAgent);

export class CompiledPreviewUi {
  private compile = this.button("Compile", "compiled-compile", "play");
  // Split button for both LaTeX and Typst: the main half compiles (or cancels),
  // and the chevron opens compile actions plus Auto-compile / Manual mode.
  private more = this.button("", "compiled-compile-more", "chevron");
  private split = document.createElement("div");
  private menu: HTMLElement | null = null;
  private closeMenuListeners: (() => void) | null = null;
  private compileClean: () => void;
  private readonly setAuto: (on: boolean) => void;
  private format: "latex" | "typst" = "latex";
  private autoCompile = true;
  private toggle = this.button("Logs", "compiled-logs-toggle", "logs");
  // The visible label is short to leave the status beside it room, and hides
  // below the compact breakpoint; the accessible name stays "Save PDF".
  private save = this.button("PDF", "compiled-save-pdf", "download");
  private modes = document.createElement("div");
  private pages = document.createElement("div");
  private pagePrevious = this.button("", "compiled-page-step", "previous");
  private pageField = document.createElement("input");
  private pageTotal = document.createElement("span");
  private pageNext = this.button("", "compiled-page-step", "next");
  private pageAllowed = false;
  private pageTotalCount = 0;
  private currentPage = 1;
  private pageEditing = false;
  private readonly goToPage: (page: number) => void;
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
  private badges = document.createElement("span");
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
      compileClean(): void;
      cancel(): void;
      auto(on: boolean): void;
      save(): void;
      mode(mode: "document" | "pages"): void;
      /** Jump a paged preview to a 1-based page. */
      goToPage(page: number): void;
      copy(text: string): void;
    },
  ) {
    this.goToPage = actions.goToPage;
    this.setAuto = actions.auto;
    const header = shell.querySelector<HTMLElement>("#compiled-controls")!;
    header.className = "compiled-toolbar";
    const row = document.createElement("div");
    row.className = "compiled-actions";
    this.modes.className = "compiled-modes";
    this.modes.setAttribute("role", "group");
    this.modes.setAttribute("aria-label", "Typst preview mode");
    for (const mode of ["document", "pages"] as const) {
      const button = this.button(mode === "pages" ? "Pages" : "Document", "compiled-mode");
      button.dataset.mode = mode;
      button.addEventListener("click", () => actions.mode(mode));
      this.modes.append(button);
    }
    this.pages.className = "compiled-pages";
    this.pages.setAttribute("role", "group");
    this.pages.setAttribute("aria-label", "Page navigation");
    this.pages.hidden = true;
    this.pagePrevious.setAttribute("aria-label", "Previous page");
    this.pagePrevious.title = "Previous page (Shift+click for first page)";
    this.pageNext.setAttribute("aria-label", "Next page");
    this.pageNext.title = "Next page (Shift+click for last page)";
    const pageBox = document.createElement("div");
    pageBox.className = "compiled-page-box";
    this.pageField.type = "text";
    this.pageField.className = "compiled-page-field";
    this.pageField.inputMode = "numeric";
    this.pageField.autocomplete = "off";
    this.pageField.spellcheck = false;
    this.pageField.setAttribute("aria-label", "Page number");
    this.pageTotal.className = "compiled-page-total";
    pageBox.append(this.pageField, this.pageTotal);
    this.pages.append(this.pagePrevious, pageBox, this.pageNext);
    this.pagePrevious.addEventListener("click", (event) =>
      this.requestPage(event.shiftKey ? 1 : this.pageBase() - 1),
    );
    this.pageNext.addEventListener("click", (event) =>
      this.requestPage(event.shiftKey ? this.pageTotalCount : this.pageBase() + 1),
    );
    this.pageField.addEventListener("focus", () => {
      this.pageEditing = false;
      this.pageField.select();
    });
    this.pageField.addEventListener("input", () => {
      this.pageEditing = true;
    });
    this.pageField.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        this.commitPageEdit();
      } else if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        this.pageEditing = false;
        this.showCurrentPage();
        this.pageField.blur();
      }
    });
    this.pageField.addEventListener("blur", (event) => {
      // A page button receives the focus before its click; committing the field
      // first would jump twice. The button uses the typed page as its base.
      if (event.relatedTarget instanceof Node && this.pages.contains(event.relatedTarget)) return;
      if (this.pageEditing) this.commitPageEdit();
      else this.showCurrentPage();
    });
    this.toggle.setAttribute("aria-controls", logs.id);
    this.toggle.setAttribute("aria-pressed", "false");
    this.toggle.dataset.hasIssues = "false";
    this.badges.className = "compiled-issue-badges";
    this.badges.hidden = true;
    this.toggle.append(this.badges);
    this.message.className = "compiled-message latex-build-message";
    this.message.setAttribute("role", "status");
    this.condition.className = "compiled-condition";
    this.stateLabel.className = "compiled-state-label";
    this.stateDetail.className = "compiled-state-detail";
    this.engine.className = "compiled-engine";
    this.condition.append(this.icon("clock"), this.stateLabel);
    this.message.append(this.condition, this.stateDetail, this.engine);
    this.notice.className = "compiled-notice";
    this.notice.hidden = true;
    this.save.setAttribute("aria-label", "Save PDF");
    this.compileClean = actions.compileClean;
    this.split.className = "compiled-split compiled-split-joined";
    this.split.setAttribute("role", "group");
    this.split.setAttribute("aria-label", "Compile");
    this.more.setAttribute("aria-label", "More compile options");
    this.more.setAttribute("aria-haspopup", "menu");
    this.more.setAttribute("aria-expanded", "false");
    this.more.title = "More compile options";
    this.more.addEventListener("click", () => (this.menu ? this.closeMenu(true) : this.openMenu()));
    this.more.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowDown" || this.more.disabled) return;
      event.preventDefault();
      this.openMenu();
    });
    this.split.append(this.compile, this.more);
    const divider = document.createElement("span");
    divider.className = "compiled-divider";
    divider.setAttribute("aria-hidden", "true");
    const end = document.createElement("div");
    end.className = "compiled-end";
    end.append(this.toggle, this.save);
    row.append(this.split, this.modes, this.pages, this.message, divider, end);
    header.append(row, this.notice);
    this.compile.addEventListener("click", () =>
      this.busy ? actions.cancel() : actions.compile(),
    );
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
    // Logs is a toggle, which is easy to miss: the panel also offers its own
    // way back to the preview, returning focus to the toggle it came from.
    const close = this.button("", "compiler-logs-close", "close");
    close.setAttribute("aria-label", "Close logs");
    close.title = "Hide logs and return to preview";
    close.addEventListener("click", () => {
      this.showLogs(false);
      this.toggle.focus();
    });
    const head = document.createElement("div");
    head.className = "compiler-logs-head";
    head.append(this.title, close);
    logs.append(head, this.caption, tabs, this.problems, this.raw);
    this.selectLog(false);
    this.reset();
  }

  /**
   * Show the reading page and the page total for a paged preview.
   *
   * `total` 0 hides the strip, which is what every non-paged surface reports.
   * While the reader is typing, the field keeps their text: a compile status
   * update must not overwrite a half-typed page number.
   */
  pageInfo(page: number, total: number): void {
    this.pageTotalCount = Number.isFinite(total) && total > 0 ? Math.floor(total) : 0;
    if (this.pageTotalCount > 0) {
      const wanted = Number.isFinite(page) ? Math.round(page) : 1;
      this.currentPage = Math.min(this.pageTotalCount, Math.max(1, wanted));
    } else {
      this.currentPage = 1;
      this.pageEditing = false;
    }
    this.syncPageVisibility();
  }

  private syncPageVisibility(): void {
    const show = this.pageAllowed && this.pageTotalCount > 0;
    this.pages.hidden = !show;
    if (!show) {
      this.pageEditing = false;
      return;
    }
    this.pageField.style.setProperty(
      "--page-digits",
      String(Math.max(1, String(this.pageTotalCount).length)),
    );
    if (!this.pageEditing) this.showCurrentPage();
    this.updatePageButtons();
  }

  private showCurrentPage(): void {
    this.pageField.value = String(this.currentPage);
    this.pageTotal.textContent = this.pageTotalCount > 0 ? `/ ${this.pageTotalCount}` : "";
  }

  private updatePageButtons(): void {
    const atStart = this.currentPage <= 1;
    const atEnd = this.currentPage >= this.pageTotalCount;
    this.pagePrevious.disabled = atStart;
    this.pageNext.disabled = atEnd;
  }

  /** The page a step button should move from, including a typed page. */
  private pageBase(): number {
    if (!this.pageEditing) return this.currentPage;
    return this.readPage() ?? this.currentPage;
  }

  private readPage(): number | null {
    const text = this.pageField.value.trim();
    if (!/^\d+$/.test(text)) return null;
    const page = Number.parseInt(text, 10);
    return Number.isFinite(page) ? page : null;
  }

  private commitPageEdit(): void {
    const page = this.readPage();
    this.pageEditing = false;
    if (page === null) this.showCurrentPage();
    else this.requestPage(page);
  }

  private requestPage(page: number): void {
    if (this.pageTotalCount <= 0 || !Number.isFinite(page)) return;
    const target = Math.min(this.pageTotalCount, Math.max(1, Math.round(page)));
    this.pageEditing = false;
    this.currentPage = target;
    this.showCurrentPage();
    this.updatePageButtons();
    this.goToPage(target);
  }

  private icon(name: Icon): SVGSVGElement {
    const paths: Record<Icon, string> = {
      play: '<path d="m9 5 12 7-12 7a1 1 0 0 1-1.5-.9V5.9A1 1 0 0 1 9 5Z"/>',
      stop: '<rect x="6" y="6" width="12" height="12" rx="1"/>',
      // A console window with a prompt: reads as "compiler output" at 16 px,
      // where the old tree-of-lines glyph looked like a broken list icon.
      logs: '<rect x="2.5" y="4" width="19" height="16" rx="2.5"/><path d="m7 9.5 3 2.5-3 2.5M13 15h4"/>',
      download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
      copy: '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
      error: '<circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/>',
      problem: '<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6m0-6 6 6"/>',
      warning:
        '<path d="m21.7 18-8-14a2 2 0 0 0-3.4 0l-8 14a2 2 0 0 0 1.7 3h16a2 2 0 0 0 1.7-3ZM12 9v4M12 17h.01"/>',
      ready: '<circle cx="12" cy="12" r="10"/><path d="m8 12 3 3 5-6"/>',
      clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
      chevron: '<path d="m6 9 6 6 6-6"/>',
      restart: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
      close: '<path d="M18 6 6 18M6 6l12 12"/>',
      check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
      previous: '<path d="m15 6-6 6 6 6"/>',
      next: '<path d="m9 6 6 6-6 6"/>',
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

  private syncCompileTitle(): void {
    this.compile.title = this.busy
      ? "Cancel compilation"
      : this.autoCompile
        ? "Compile (Auto-compile on)"
        : "Compile (Manual mode)";
  }

  private updateStatusTooltip(): void {
    const parts = [
      this.stateLabel.textContent?.trim(),
      this.stateDetail.hidden ? "" : this.stateDetail.textContent?.trim(),
      this.issueText,
      this.engine.hidden ? "" : this.engine.textContent?.trim(),
    ].filter(Boolean);
    this.message.title = parts.join(" · ");
  }

  configure(format: "latex" | "typst", auto: boolean, mode = "pages", fileName = ""): void {
    if (this.format !== format) this.closeMenu();
    this.format = format;
    this.autoCompile = auto;
    this.syncCompileTitle();
    this.shell.classList.add("compiled-preview");
    this.shell.dataset.compiler = format;
    this.shell.querySelector<HTMLElement>("#compiled-controls")!.hidden = false;
    this.title.textContent = format === "latex" ? "LaTeX logs" : "Typst logs";
    this.caption.textContent = fileName ? `${fileName} · Latest compilation` : "Latest compilation";
    this.save.classList.toggle("latex-save-pdf", format === "latex");
    this.modes.hidden = format !== "typst";
    this.pageAllowed = format === "latex" || mode === "pages";
    this.save.hidden = format === "typst" && mode !== "pages";
    for (const button of this.modes.querySelectorAll("button")) {
      button.setAttribute("aria-pressed", String(button.dataset.mode === mode));
    }
    this.syncPageVisibility();
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
    const detailText = state?.detail ?? details.join(" · ");
    renderLinkedText(this.stateDetail, detailText, state?.detailLink);
    this.stateDetail.hidden = !detailText;
    this.engine.textContent = state?.engine ?? "";
    this.engine.hidden = !this.engine.textContent;
    this.busy = busy;
    this.compile.querySelector(".compiled-button-label")!.textContent = busy ? "Cancel" : "Compile";
    this.compile.querySelector("svg")!.replaceWith(this.icon(busy ? "stop" : "play"));
    this.compile.classList.toggle("latex-cancel", busy);
    this.syncCompileTitle();
    this.updateStatusTooltip();
    // While a build runs the main half is Cancel; a second compile from the
    // menu would only race it, so the menu waits for the build to end.
    this.more.disabled = busy;
    if (busy) this.closeMenu();
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
    const chip = (severity: "error" | "warning", value: number): HTMLSpanElement => {
      const node = document.createElement("span");
      node.className = "compiled-issue-count";
      node.dataset.severity = severity;
      node.append(
        this.icon(severity === "error" ? "problem" : "warning"),
        document.createTextNode(String(value)),
      );
      return node;
    };
    const chips: HTMLSpanElement[] = [];
    if (errors > 0) chips.push(chip("error", errors));
    if (warnings > 0) chips.push(chip("warning", warnings));
    this.badges.replaceChildren(...chips);
    this.badges.hidden = chips.length === 0;
    this.toggle.dataset.hasIssues = chips.length > 0 ? "true" : "false";
    this.toggle.setAttribute("aria-label", this.issueText ? `Logs, ${this.issueText}` : "Logs");
    this.updateStatusTooltip();
  }

  /** Forget the previous build's problems and output, for a build from scratch. */
  clearLogs(): void {
    this.details(document.createElement("div"), "", 0, false);
  }

  private openMenu(): void {
    if (this.menu || this.more.disabled) return;
    const host = document.createElement("div");
    host.className = "editor-menu compiled-compile-menu";
    host.setAttribute("role", "menu");
    host.setAttribute("aria-label", "Compile options");
    host.tabIndex = -1;
    const entry = (
      icon: Icon,
      text: string,
      hint: string,
      shortcut: string,
      run: () => void,
      radio?: { mode: "auto" | "manual"; checked: boolean },
    ): HTMLButtonElement => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "editor-menu-item compiled-compile-option";
      button.setAttribute("role", radio ? "menuitemradio" : "menuitem");
      if (radio) {
        button.dataset.compileMode = radio.mode;
        button.setAttribute("aria-checked", String(radio.checked));
      }
      const body = document.createElement("span");
      body.className = "compiled-option-body";
      const label = document.createElement("span");
      label.className = "editor-menu-label";
      label.textContent = text;
      const detail = document.createElement("span");
      detail.className = "compiled-option-hint";
      detail.textContent = hint;
      body.append(label, detail);
      button.append(this.icon(icon), body);
      if (shortcut) {
        const keys = document.createElement("span");
        keys.className = "editor-menu-shortcut";
        keys.textContent = shortcut;
        button.append(keys);
      }
      button.addEventListener("click", () => {
        this.closeMenu(true);
        run();
      });
      return button;
    };
    const chooseAuto = (on: boolean): void => {
      if (this.autoCompile === on) return;
      this.autoCompile = on;
      this.syncCompileTitle();
      this.setAuto(on);
    };
    host.append(
      entry(
        "play",
        "Compile",
        "Update the preview from the current sources",
        IS_MAC ? "\u21e7\u2318\u21a9" : "Ctrl+Shift+Enter",
        () => this.compile.click(),
      ),
    );
    if (this.format === "latex") {
      host.append(
        entry(
          "restart",
          "Recompile from scratch",
          "Discard cached build state and logs, then compile",
          "",
          () => this.compileClean(),
        ),
      );
    }
    const sep = document.createElement("div");
    sep.className = "editor-menu-sep";
    sep.setAttribute("role", "separator");
    const heading = document.createElement("div");
    heading.className = "compiled-menu-heading";
    heading.setAttribute("role", "presentation");
    heading.textContent = "Compile mode";
    host.append(
      sep,
      heading,
      entry(
        "check",
        "Auto-compile",
        "Rebuild automatically as you edit",
        "",
        () => chooseAuto(true),
        { mode: "auto", checked: this.autoCompile },
      ),
      entry(
        "check",
        "Manual compile",
        "Build only when you click Compile",
        "",
        () => chooseAuto(false),
        { mode: "manual", checked: !this.autoCompile },
      ),
    );
    document.body.append(host);
    const anchor = this.split.getBoundingClientRect();
    const width = host.offsetWidth;
    host.style.top = `${Math.round(anchor.bottom + 4)}px`;
    host.style.left = `${Math.round(Math.max(8, Math.min(anchor.left, window.innerWidth - width - 8)))}px`;
    this.menu = host;
    this.more.setAttribute("aria-expanded", "true");
    host.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });

    const onPointer = (event: MouseEvent): void => {
      const target = event.target as Node;
      if (host.contains(target) || this.more.contains(target)) return;
      this.closeMenu();
    };
    const onKey = (event: KeyboardEvent): void => {
      const items = [...host.querySelectorAll<HTMLButtonElement>("button")];
      const at = items.indexOf(document.activeElement as HTMLButtonElement);
      const move = (index: number): void => {
        event.preventDefault();
        items[(index + items.length) % items.length]?.focus();
      };
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        this.closeMenu(true);
      } else if (event.key === "Tab") this.closeMenu();
      else if (event.key === "ArrowDown") move(at + 1);
      else if (event.key === "ArrowUp") move(at - 1);
      else if (event.key === "Home") move(0);
      else if (event.key === "End") move(items.length - 1);
    };
    const onBlur = (): void => this.closeMenu();
    document.addEventListener("mousedown", onPointer, true);
    host.addEventListener("keydown", onKey);
    window.addEventListener("blur", onBlur);
    window.addEventListener("resize", onBlur);
    this.closeMenuListeners = () => {
      document.removeEventListener("mousedown", onPointer, true);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("resize", onBlur);
    };
  }

  private closeMenu(restoreFocus = false): void {
    if (!this.menu) return;
    this.closeMenuListeners?.();
    this.closeMenuListeners = null;
    this.menu.remove();
    this.menu = null;
    this.more.setAttribute("aria-expanded", "false");
    if (restoreFocus) this.more.focus({ preventScroll: true });
  }

  /** Replace the Compiler output text while a compile runs; problems stay as they are. */
  liveOutput(output: string): void {
    this.log = output;
    this.raw.textContent = output || "The compiler reported no messages.";
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
    this.pages.inert = on;
    this.pages.classList.toggle("is-muted", on);
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
    this.closeMenu();
    this.explicitLogs = false;
    this.pageAllowed = false;
    this.pageTotalCount = 0;
    this.pageEditing = false;
    this.pages.hidden = true;
    this.pageField.value = "";
    this.pageTotal.textContent = "";
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
