//! Which LaTeX preview backend draws a document, and why it falls back.
//!
//! Two backends exist (docs/adr/2026-11-13-latex-preview-backends.md): WasmTex
//! compiles a PDF that PDF.js draws, and TeXpresso typesets incrementally into
//! a frame of its own while WasmTex keeps compiling, at idle, the PDF that
//! export and print use. The default is one constant. The only other writer is
//! the hidden `view.latexBackend` command the tests use; there is no reader
//! facing switch until the comparison is decided.
//!
//! Pure: no DOM, no IPC, so `scripts/texpresso-unit.mjs` can import it.

import type { TexEngine } from "./latex-engine-choice";
import type { TexpressoEngine } from "./texpresso/protocol";

export type LatexPreviewBackend = "wasmtex" | "texpresso";

export const DEFAULT_LATEX_PREVIEW_BACKEND: LatexPreviewBackend = "wasmtex";

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
 * Why TeXpresso does not draw this build. Every one is named on the engine
 * chip: nothing switches engines quietly.
 */
export type TexpressoFallback =
  "native" | "pdflatex" | "year" | "jspi" | "encoding" | "library" | "failed";

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
  if (texpressoEngineFor(input.engine) === null) return "pdflatex";
  if (input.year !== "2026") return "year";
  if (!input.jspi) return "jspi";
  if (input.failed) return "failed";
  if (input.nonUtf8 !== null) return "encoding";
  if (input.libraryConflict !== null) return "library";
  return null;
}

/** The chip's sentence for a fallback, completing "<engine> · WasmTex (…)". */
export function texpressoFallbackText(
  reason: TexpressoFallback,
  detail: { file?: string | null } = {},
): string {
  switch (reason) {
    case "native":
      return "an installed TeX distribution compiles this project";
    case "pdflatex":
      return "TeXpresso has no pdfTeX";
    case "year":
      return "TeXpresso needs the TeX Live 2026 engine profile";
    case "jspi":
      return "this webview lacks WebAssembly JSPI, which TeXpresso needs";
    case "encoding":
      return `TeXpresso reads UTF-8 only; ${detail.file ?? "a project file"} is not`;
    case "library":
      return `a local library file cannot be placed in TeXpresso's project${detail.file ? ` (${detail.file})` : ""}`;
    case "failed":
      return "the TeXpresso preview stopped responding and its restart failed";
  }
}
