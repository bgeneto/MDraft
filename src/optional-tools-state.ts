//! Pure state for the Optional tools dialog.
//!
//! The dialog is a view over this module plus the install controller. Keeping
//! the selection, totals and status classification here means the rules can be
//! tested without a DOM, a Tauri command or a network.

import type { LatexEngineStatus, PandocStatus, TypstStatus } from "./api";

export type OptionalTool = "pandoc" | "typst" | "latex";
export type OptionalToolPhase = "downloading" | "verifying" | "unpacking" | "ready";
export type OptionalToolsMode = "first-run" | "context" | "manage";
export type OptionalToolSource = "managed" | "path" | "native";

/** The row order in the dialog, the queue and the status bar. */
export const OPTIONAL_TOOLS: readonly OptionalTool[] = ["pandoc", "typst", "latex"];

export interface OptionalToolMeta {
  tool: OptionalTool;
  /** The outcome, not the engine, is the title a reader scans. */
  title: string;
  /** The engine, size and the formats it unlocks. */
  hint: string;
  /** Approximate compressed download, for the button total. */
  sizeMb: number;
  recommended: boolean;
}

export const OPTIONAL_TOOL_META: Record<OptionalTool, OptionalToolMeta> = {
  pandoc: {
    tool: "pandoc",
    title: "Word, EPUB and more conversion formats",
    hint: "Pandoc · about 40 MB · DOCX, ODT, EPUB and most other formats",
    sizeMb: 40,
    recommended: true,
  },
  typst: {
    tool: "typst",
    title: "Typst documents",
    hint: "Typst · about 14 MB · typeset PDF and .typ preview",
    sizeMb: 14,
    recommended: false,
  },
  latex: {
    tool: "latex",
    title: "LaTeX documents",
    hint: "Bundled TeX · about 20 MB + packages on demand · preview and compile .tex",
    sizeMb: 20,
    recommended: false,
  },
};

export const OPTIONAL_TOOL_NAME: Record<OptionalTool, string> = {
  pandoc: "Pandoc",
  typst: "Typst",
  latex: "TeX",
};

export type OptionalToolStatus =
  /** Not present and installable through this dialog. */
  | { kind: "missing"; canInstall: boolean; hint: string | null }
  /** Present and usable. */
  | { kind: "ready"; version: string | null; source: OptionalToolSource | null }
  /** Present on disk but switched off; enabling is a setting, not a download. */
  | { kind: "off"; version: string | null }
  /** Present in a form this dialog cannot repair; the hint says where to go. */
  | { kind: "blocked"; hint: string; action: "download-page" | "latex-preferences" };

export type OptionalToolRuntime =
  | { kind: "idle" }
  | { kind: "queued" }
  | {
      kind: "active";
      phase: OptionalToolPhase;
      received: number;
      total: number | null;
    }
  | { kind: "failed"; message: string };

export interface RawOptionalToolsStatuses {
  pandoc: PandocStatus;
  typst: TypstStatus;
  latex: LatexEngineStatus;
}

/** The backend's three status shapes, reduced to what the dialog needs. */
export function normalizeStatuses(
  raw: RawOptionalToolsStatuses,
): Record<OptionalTool, OptionalToolStatus> {
  const pandoc: OptionalToolStatus = raw.pandoc.found
    ? {
        kind: "ready",
        version: raw.pandoc.version,
        source:
          raw.pandoc.source === "managed"
            ? "managed"
            : raw.pandoc.source === "path"
              ? "path"
              : null,
      }
    : { kind: "missing", canInstall: true, hint: null };

  const typst: OptionalToolStatus = raw.typst.found
    ? {
        kind: "ready",
        version: raw.typst.version,
        source:
          raw.typst.source === "managed" ? "managed" : raw.typst.source === "path" ? "path" : null,
      }
    : raw.typst.canInstall
      ? { kind: "missing", canInstall: true, hint: raw.typst.hint || null }
      : { kind: "blocked", hint: raw.typst.hint, action: "download-page" };

  const latex: OptionalToolStatus = (() => {
    if (raw.latex.backend === "native") {
      return raw.latex.problem
        ? { kind: "blocked", hint: raw.latex.problem, action: "latex-preferences" }
        : {
            kind: "ready",
            version: raw.latex.nativeDistribution ?? raw.latex.nativeEngine,
            source: "native",
          };
    }
    if (raw.latex.previewInstalled) {
      return raw.latex.bundledEnabled
        ? { kind: "ready", version: null, source: "managed" }
        : { kind: "off", version: null };
    }
    return { kind: "missing", canInstall: true, hint: null };
  })();

  return { pandoc, typst, latex };
}

export function isInstallable(status: OptionalToolStatus): boolean {
  return status.kind === "missing" && status.canInstall;
}

export function isReady(status: OptionalToolStatus): boolean {
  return status.kind === "ready";
}

/**
 * What starts checked.
 *
 * First run suggests Pandoc because it unlocks the most formats. Context mode
 * checks exactly what the blocked action needs. The manage view starts empty so
 * opening it to inspect status never preselects a download.
 */
export function defaultSelection(
  mode: OptionalToolsMode,
  statuses: Record<OptionalTool, OptionalToolStatus>,
  required: readonly OptionalTool[] = [],
): OptionalTool[] {
  if (mode === "first-run") {
    return isInstallable(statuses.pandoc) ? ["pandoc"] : [];
  }
  if (mode === "context") {
    return [...new Set(required.filter((tool) => isInstallable(statuses[tool])))];
  }
  return [];
}

/** The primary button's label for the current selection. */
export function downloadLabel(
  selected: readonly OptionalTool[],
  statuses: Record<OptionalTool, OptionalToolStatus>,
): string {
  const missing = selected.filter((tool) => isInstallable(statuses[tool]));
  if (missing.length === 0) return "Done";
  const total = missing.reduce((sum, tool) => sum + OPTIONAL_TOOL_META[tool].sizeMb, 0);
  return `Download ${missing.length} item${missing.length === 1 ? "" : "s"} (≈ ${total} MB)`;
}

export function progressPercent(received: number, total: number | null): number | null {
  if (!total || total <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((received / total) * 100)));
}

export function formatDownloadBytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
