//! The local-packages setting uses one folder control, shared by both engines.
import type * as api from "./api";
import type { Row } from "./preferences";

export interface TexmfPreferencesHost {
  texmfConfig(): api.LatexTexmfConfig | null;
  texmfStale(): boolean;
  texmfReport(id: string): api.LatexTexmfReport | undefined;
  texmfBusy(): string | null;
  texmfError(): string | null;
  refreshTexmf(ids?: string[]): Promise<void>;
  texmfAction(action: api.LatexTexmfAction): Promise<void>;
  texmfChooseFolder(): Promise<void>;
  texmfOpen(id: string): Promise<void>;
}

const LAYOUTS: [api.LatexTexmfLayout, string][] = [
  ["packages", "Folder of packages"],
  ["tds", "TEXMF tree"],
];
let additionalOpen = false;

export function texmfStatusText(report: api.LatexTexmfReport | undefined, busy: boolean): string {
  if (busy || !report) return "Checking…";
  if (report.status === "empty") return "No packages yet.";
  if (report.status === "ok") {
    const packages = report.names.packages.length;
    const classes = report.names.classes.length;
    return `${packages} package${packages === 1 ? "" : "s"}, ${classes} ${classes === 1 ? "class" : "classes"}`;
  }
  if (report.status === "missing") return "Folder not found. Choose another folder or turn it off.";
  if (report.status === "conflicting") {
    const paths = report.issues.find((issue) => issue.severity === "error")?.paths.slice(0, 2);
    return `Conflicting files${paths?.length ? `: ${paths.join(", ")}` : ". Keep one copy of each package."}`;
  }
  return report.message ?? "Folder unavailable. Choose another folder or turn it off.";
}

export function texmfRows(host: TexmfPreferencesHost, refresh: () => void): Row[] {
  if (host.texmfStale() && host.texmfBusy() === null && host.texmfError() === null) {
    void host.refreshTexmf().then(refresh);
  }
  return [
    { kind: "heading", label: "Local packages" },
    { kind: "localPackages", label: "Local packages", host, refresh },
  ];
}

/** Focus keys survive the panel's asynchronous redraws and native pickers. */
export function renderTexmfControl(host: TexmfPreferencesHost, refresh: () => void): HTMLElement {
  const block = document.createElement("div");
  block.className = "prefs-local-packages";
  const roots = host.texmfConfig()?.roots ?? [];
  const busy = host.texmfBusy() !== null;
  const run = (action: () => Promise<void>) => void action().finally(refresh);

  function button(text: string, key: string, action: () => Promise<void>): HTMLButtonElement {
    const element = document.createElement("button");
    element.type = "button";
    element.className = "prefs-button";
    element.textContent = text;
    element.dataset.prefsFocus = key;
    element.disabled = busy;
    element.addEventListener("click", () => run(action));
    return element;
  }

  function folder(root: api.LatexTexmfRootView | undefined, index: number): HTMLElement {
    const group = document.createElement("div");
    group.className = "prefs-package-folder";
    group.dataset.rootId = root?.id ?? "";
    const key = index === 0 ? "primary" : root!.id;

    function row(name: string, widget: HTMLElement): void {
      const line = document.createElement("div");
      line.className = "prefs-row";
      if (widget instanceof HTMLInputElement) line.classList.add("prefs-row-checkbox");
      const label = document.createElement("label");
      label.className = "prefs-label";
      label.textContent = name;
      widget.id = `prefs-local-${key}-${name.replace(/ /g, "-")}`;
      if (widget instanceof HTMLInputElement || widget instanceof HTMLSelectElement)
        label.htmlFor = widget.id;
      const cell = document.createElement("div");
      cell.className = "prefs-control";
      cell.append(widget);
      line.append(label, cell);
      group.append(line);
    }

    const enabled = document.createElement("input");
    enabled.type = "checkbox";
    enabled.checked = root?.enabled ?? false;
    enabled.disabled = busy;
    enabled.dataset.prefsFocus = `${key}-enabled`;
    enabled.addEventListener("change", () =>
      run(() =>
        host.texmfAction(
          root
            ? { type: "setEnabled", id: root.id, enabled: enabled.checked }
            : { type: "setPrimary" },
        ),
      ),
    );
    row(index === 0 ? "Use local packages" : `Use ${root?.label}`, enabled);

    const location = document.createElement("div");
    location.className = "prefs-folder-location";
    const path = document.createElement("span");
    path.className = "prefs-folder-path";
    path.textContent = root?.resolved ?? (host.texmfConfig() ? "No folder selected" : "Checking…");
    location.append(path);
    const actions = document.createElement("div");
    actions.className = "prefs-actions";
    if (index === 0) {
      const open = button("Open", `${key}-open`, () => host.texmfOpen(root!.id));
      open.disabled ||= !root;
      actions.append(
        open,
        button("Choose folder…", `${key}-choose`, () => host.texmfChooseFolder()),
      );
    } else if (root) {
      const menu = document.createElement("details");
      menu.className = "prefs-folder-menu";
      const summary = document.createElement("summary");
      summary.textContent = "⋯";
      summary.setAttribute("aria-label", `Actions for ${root.label}`);
      summary.dataset.prefsFocus = `${key}-menu`;
      const items = document.createElement("div");
      items.className = "prefs-folder-menu-items";
      items.append(button("Open", `${key}-open`, () => host.texmfOpen(root.id)));
      for (const [offset, text] of [
        [-1, "Move up"],
        [1, "Move down"],
      ] as const) {
        const move = button(text, `${key}-${offset}`, () =>
          host.texmfAction({ type: "move", id: root.id, offset }),
        );
        move.disabled ||= index + offset >= roots.length;
        items.append(move);
      }
      items.append(
        button("Remove", `${key}-remove`, () => host.texmfAction({ type: "remove", id: root.id })),
      );
      menu.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          menu.open = false;
          summary.focus();
        }
      });
      menu.append(summary, items);
      actions.append(menu);
    }
    location.append(actions);
    row("Folder", location);

    const layout = document.createElement("select");
    layout.setAttribute(
      "aria-label",
      index === 0 ? "Local packages layout" : `Layout of ${root?.label}`,
    );
    layout.title =
      "Folder of packages: .sty/.cls files and subfolders. TEXMF tree: tex/latex/…, bibtex/…, fonts/….";
    for (const [value, text] of LAYOUTS) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = text;
      layout.append(option);
    }
    layout.value = root?.layout ?? "packages";
    layout.disabled = busy || !root;
    layout.dataset.prefsFocus = `${key}-layout`;
    layout.addEventListener("change", () => {
      if (root)
        run(() =>
          host.texmfAction({
            type: "setLayout",
            id: root.id,
            layout: layout.value as api.LatexTexmfLayout,
          }),
        );
    });
    row("Layout", layout);

    const status = document.createElement("div");
    status.className = "prefs-folder-status";
    status.setAttribute("role", "status");
    const report = root && host.texmfReport(root.id);
    const error = host.texmfError();
    status.textContent =
      error ?? (!root ? "" : !root.enabled ? "Off" : texmfStatusText(report || undefined, busy));
    if (error || (report && !["ok", "empty"].includes(report.status))) {
      status.classList.add("has-error");
      status.append(button("Retry", `${key}-retry`, () => host.refreshTexmf()));
    }
    group.append(status);
    return group;
  }

  block.append(folder(roots[0], 0));
  if (roots.length > 1) {
    const details = document.createElement("details");
    details.className = "prefs-additional-folders";
    details.open = additionalOpen;
    const summary = document.createElement("summary");
    summary.textContent = `Additional folders (${roots.length - 1})`;
    summary.dataset.prefsFocus = "additional-folders";
    details.addEventListener("toggle", () => {
      additionalOpen = details.open;
    });
    details.append(summary, ...roots.slice(1).map((root, i) => folder(root, i + 1)));
    block.append(details);
  }
  return block;
}
