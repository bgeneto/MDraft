//! Which LaTeX preview backend draws a document, and why it cannot.
//!
//! TeXpresso is the production backend: it typesets incrementally into a frame
//! of its own and its own exporter writes the PDF that export and print use.
//! WasmTex is disabled, not deleted (docs/architecture.md):
//! its code and the hidden `view.latexBackend.wasmtex` test hook remain, but no
//! install flow, default or reader-facing control selects it.
//!
//! Pure: no DOM, no IPC, so `scripts/texpresso-unit.mjs` can import it.

import type { TexEngine } from "./latex-engine-choice";
import type { TexpressoEngine } from "./texpresso/protocol";

export type LatexPreviewBackend = "wasmtex" | "texpresso";

export const DEFAULT_LATEX_PREVIEW_BACKEND: LatexPreviewBackend = "texpresso";

/** The engine download, for the reader's message (the twelve pinned assets). */
export const TEXPRESSO_ENGINE_MIB = 15;
/** The only TeX Live snapshot the pinned app has. */
export const TEXPRESSO_TEXLIVE_YEAR = "2026";

let backend: LatexPreviewBackend = DEFAULT_LATEX_PREVIEW_BACKEND;

export function latexPreviewBackend(): LatexPreviewBackend {
  return backend;
}

/** Returns true when the backend changed. */
export function setLatexPreviewBackend(next: LatexPreviewBackend): boolean {
  if (next === backend) return false;
  backend = next;
  return true;
}

/** TeXpresso's engine for a bundled TeX engine; null for pdfLaTeX, which it lacks. */
export function texpressoEngineFor(engine: TexEngine): TexpressoEngine | null {
  if (engine === "lualatex") return "luatex";
  if (engine === "xelatex") return "xetex";
  return null;
}

/**
 * Why the preview cannot draw this build. Every one is named on the engine
 * chip or in the pane: nothing switches engines quietly, and there is no
 * second bundled engine to fall back to.
 */
export type TexpressoFallback = "native" | "year" | "jspi" | "encoding" | "library" | "failed";

export interface TexpressoInputs {
  /** The engine backend: an installed distribution keeps its own compiler. */
  backend: "bundled" | "native" | "none";
  engine: TexEngine;
  /** The WasmTex year profile; TeXpresso's bundle is TeX Live 2026. */
  year: string;
  jspi: boolean;
  /** A project text file that is not UTF-8, or null. */
  nonUtf8: string | null;
  /** Whether local library files could not be placed in the frame's project. */
  libraryConflict: string | null;
  /** The frame failed for this project and its restart failed too. */
  failed: boolean;
}

export function texpressoFallback(input: TexpressoInputs): TexpressoFallback | null {
  if (input.backend !== "bundled") return "native";
  if (input.year !== "2026") return "year";
  if (!input.jspi) return "jspi";
  if (input.failed) return "failed";
  if (input.nonUtf8 !== null) return "encoding";
  if (input.libraryConflict !== null) return "library";
  return null;
}

/** The reader's sentence for a build the incremental preview cannot draw. */
export function texpressoFallbackText(
  reason: TexpressoFallback,
  detail: { file?: string | null } = {},
): string {
  switch (reason) {
    case "native":
      return "an installed TeX distribution compiles this project";
    case "year":
      return "the incremental preview needs the TeX Live 2026 data";
    case "jspi":
      return "this webview lacks WebAssembly JSPI, which the preview needs";
    case "encoding":
      return `the preview reads UTF-8 only; ${detail.file ?? "a project file"} is not`;
    case "library":
      return `a local library file cannot be placed in the preview's project${detail.file ? ` (${detail.file})` : ""}`;
    case "failed":
      return "the preview stopped responding and its restart failed";
  }
}
