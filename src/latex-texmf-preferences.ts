//! Preferences › LaTeX › Local packages and classes.
//!
//! Built from the panel's ordinary rows (notes, checkboxes, selects, buttons),
//! so every control is labelled, keyboard reachable and searchable like the rest
//! of Preferences. The rows only describe; every change goes through the typed
//! `latex_texmf_*` commands via the host.

import type * as api from "./api";
import type { Row } from "./preferences";

export interface TexmfPreferencesHost {
  /** The registered roots, or null before the first read. */
  texmfConfig(): api.LatexTexmfConfig | null;
  /**
   * Whether the cached list is old enough to re-read when the group is drawn.
   * The list can change outside this panel (another window, a script), and a
   * fresh read after each re-read stops this from looping.
   */
  texmfStale(): boolean;
  /** The latest inspection per root id. */
  texmfReport(id: string): api.LatexTexmfReport | undefined;
  /** The root id (or "add"/"personal") an action is running for, if any. */
  texmfBusy(): string | null;
  refreshTexmf(ids?: string[]): Promise<void>;
  texmfAction(action: api.LatexTexmfAction): Promise<void>;
  /** Picker → inspection → confirmation → register. Cancel saves nothing. */
  texmfAddFolder(): Promise<void>;
  texmfUsePersonal(): Promise<void>;
  texmfOpen(id: string): Promise<void>;
}

const LAYOUTS: [string, string][] = [
  ["tds", "TEXMF tree (tex/latex/…, bibtex/…, fonts/…)"],
  ["packages", "Folder of packages (.sty/.cls files, any subfolders)"],
];

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** One line a reader can act on, for a root's latest inspection. */
export function texmfStatusText(report: api.LatexTexmfReport | undefined, busy: boolean): string {
  if (busy) return "Checking…";
  if (!report) return "Not checked yet.";
  const issues = report.issues
    .filter((issue) => issue.severity !== "info")
    .map((issue) => `${issue.message} ${issue.paths.slice(0, 4).join(", ")}`.trim());
  switch (report.status) {
    case "ok": {
      const found = `${plural(report.names.classes.length, "class", "classes")}, ${plural(report.names.packages.length, "package")} (${plural(report.files, "file")}).`;
      const shadowed = report.issues.find((issue) => issue.code === "shadowed");
      return shadowed ? `${found} ${shadowed.message}` : found;
    }
    case "empty":
      return report.message ?? "No package files yet.";
    case "conflicting":
      return [report.message ?? "Two files would answer the same name.", ...issues].join(" ");
    default:
      return report.message ?? "Unavailable.";
  }
}

export function texmfRows(host: TexmfPreferencesHost, refresh: () => void): Row[] {
  const config = host.texmfConfig();
  if ((config === null || host.texmfStale()) && host.texmfBusy() === null) {
    void host.refreshTexmf().then(refresh);
  }
  const busy = host.texmfBusy();
  const rows: Row[] = [
    { kind: "heading", label: "Local packages and classes" },
    {
      kind: "note",
      label: "Search order",
      text: "Project files, then enabled folders from top to bottom, then the engine's standard packages. Works with the bundled LuaLaTeX and with an installed distribution (MiKTeX, TeX Live, TeX Live in WSL); MDraft passes the folders itself, so there is no TEXMFHOME or TEXINPUTS to set.",
    },
  ];
  if (config && config.roots.length === 0) {
    rows.push({
      kind: "note",
      label: "Getting started",
      text: "Add a folder once to use your own classes and packages in every LaTeX project. In a TEXMF tree, give each package its own folder: texmf/tex/latex/my-package/my-package.sty, texmf/tex/latex/my-class/my-class.cls.",
    });
  }
  const personal = config?.roots.find((root) => root.kind === "personal");
  rows.push(
    {
      kind: "button",
      label: "",
      text: personal ? "Open personal folder" : "Create personal folder…",
      help: personal
        ? "Opens texmf/tex/latex/local in MDraft's settings folder."
        : `Creates texmf/tex/latex/local in MDraft's settings folder${config ? ` (${config.personalPath})` : ""}, adds it to this list and opens it. An existing folder is opened as it is; nothing is overwritten.`,
      disabled: () => busy !== null,
      disabledTitle: "Wait for the current check to finish.",
      action: () => (personal ? host.texmfOpen(personal.id) : host.texmfUsePersonal()),
    },
    {
      kind: "button",
      label: "",
      text: "Add folder…",
      help: "Choose a TEXMF tree or a folder of .sty/.cls files. It is checked before it is added and nothing is copied; your files stay where they are.",
      disabled: () => busy !== null || (config?.roots.length ?? 0) >= 8,
      disabledTitle:
        (config?.roots.length ?? 0) >= 8
          ? "At most 8 folders can be registered."
          : "Wait for the current check to finish.",
      action: () => host.texmfAddFolder(),
    },
  );
  const roots = config?.roots ?? [];
  roots.forEach((root, index) => {
    const report = host.texmfReport(root.id);
    const name = `${index + 1}. ${root.label}`;
    rows.push(
      {
        kind: "note",
        label: name,
        text: `${root.resolved} — ${root.enabled ? texmfStatusText(report, busy === root.id) : "Off: not used when compiling."}`,
      },
      {
        kind: "checkbox",
        label: `Use ${root.label}`,
        help: "When off, the folder stays in the list but is not used. Turn a missing or broken folder off to compile without it.",
        get: () => root.enabled,
        set: (enabled) => void host.texmfAction({ type: "setEnabled", id: root.id, enabled }),
      },
    );
    if (root.kind === "folder") {
      rows.push({
        kind: "select",
        label: `Layout of ${root.label}`,
        help:
          report && report.detectedLayout !== root.layout
            ? `This folder looks like a ${report.detectedLayout === "tds" ? "TEXMF tree" : "folder of packages"}.`
            : undefined,
        options: LAYOUTS,
        get: () => root.layout,
        set: (layout) =>
          void host.texmfAction({
            type: "setLayout",
            id: root.id,
            layout: layout as api.LatexTexmfLayout,
          }),
      });
    }
    rows.push(
      {
        kind: "button",
        label: "",
        text: `Open ${root.label}`,
        action: () => host.texmfOpen(root.id),
      },
      {
        kind: "button",
        label: "",
        text: `Check ${root.label} again`,
        help: "Re-reads the folder. It never compiles or downloads.",
        disabled: () => busy !== null,
        disabledTitle: "Wait for the current check to finish.",
        action: async () => {
          await host.refreshTexmf([root.id]);
          refresh();
        },
      },
      {
        kind: "button",
        label: "",
        text: `Move ${root.label} up`,
        disabled: () => index === 0,
        disabledTitle: "Already searched first.",
        action: () => host.texmfAction({ type: "move", id: root.id, offset: -1 }),
      },
      {
        kind: "button",
        label: "",
        text: `Move ${root.label} down`,
        disabled: () => index === roots.length - 1,
        disabledTitle: "Already searched last.",
        action: () => host.texmfAction({ type: "move", id: root.id, offset: 1 }),
      },
      {
        kind: "button",
        label: "",
        text: `Remove ${root.label}`,
        help: "Removes the folder from this list. Its files are not deleted.",
        action: () => host.texmfAction({ type: "remove", id: root.id }),
      },
    );
  });
  return rows;
}
