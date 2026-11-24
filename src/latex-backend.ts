//! Which LaTeX preview engine draws a bundled document, and why it cannot.
//!
//! TeXpresso is the JSPI engine used on Windows/macOS and on Linux with
//! WebKitGTK 2.54+. PhiTeX is the single-threaded WebAssembly compatibility
//! engine for Linux webviews that lack JSPI (Ubuntu 26.04/26.10 ship WebKitGTK
//! 2.52.6). The selection is a capability decision, never a preference: the
//! reader only sees the TeX engine name.
//!
//! Pure: no DOM, no IPC, so `scripts/texpresso-unit.mjs` and the PhiTeX unit
//! suite can import it.

import type { TexEngine } from "./latex-engine-choice";
import type { EngineFailure, TexpressoEngine } from "./texpresso/protocol";

export type LatexPreviewBackend = "texpresso" | "phitex";

/** The engine download, for the reader's message. */
export const PREVIEW_ENGINE_MIB: Record<LatexPreviewBackend, number> = {
  texpresso: 15,
  phitex: 33,
};
/** The only TeX Live snapshot either pinned preview has. */
export const BUNDLED_TEXLIVE_YEAR = "2026";

/** JSPI is the only reason TeXpresso cannot run on a webview. */
export function webAssemblyJspi(): boolean {
  const wasm =
    typeof WebAssembly === "undefined" ? null : (WebAssembly as { [key: string]: unknown });
  return (
    wasm !== null && typeof wasm.Suspending === "function" && typeof wasm.promising === "function"
  );
}

/**
 * PhiTeX's single-thread host needs no JSPI and no shared memory, but it does
 * need module workers, streamed wasm compilation and gzip decompression in the
 * frame. All are present in WebKitGTK 2.52; a webview missing one gets the
 * honest "preview unavailable" reason instead of an engine that cannot boot.
 */
export function phitexCapable(): boolean {
  return (
    typeof WebAssembly !== "undefined" &&
    typeof WebAssembly.compile === "function" &&
    typeof Worker === "function" &&
    typeof DecompressionStream === "function"
  );
}

/** Linux includes WSL2; Android is excluded by its own user agent. */
export function isLinuxWebview(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Linux/i.test(navigator.userAgent) && !/Android/i.test(navigator.userAgent);
}

export interface PreviewSelectionInput {
  linux: boolean;
  jspi: boolean;
  phitex: boolean;
}

/**
 * The engine the product should use. Windows/macOS keep TeXpresso even when a
 * beta webview lacks JSPI: the compatibility engine is a Linux-only fallback.
 */
export function selectLatexPreviewBackend(input: PreviewSelectionInput): LatexPreviewBackend {
  if (input.linux && !input.jspi && input.phitex) return "phitex";
  return "texpresso";
}

/** The selected backend for this webview. */
export function latexPreviewBackend(): LatexPreviewBackend {
  return selectLatexPreviewBackend({
    linux: isLinuxWebview(),
    jspi: webAssemblyJspi(),
    phitex: phitexCapable(),
  });
}

/** TeXpresso's engine for a bundled TeX engine; null for pdfLaTeX, which it lacks. */
export function texpressoEngineFor(engine: TexEngine): TexpressoEngine | null {
  if (engine === "lualatex") return "luatex";
  if (engine === "xelatex") return "xetex";
  return null;
}

/** The frame engine for a bundled TeX engine under the selected backend. */
export function previewEngineFor(
  backend: LatexPreviewBackend,
  engine: TexEngine,
): TexpressoEngine | null {
  // PhiTeX has no LuaLaTeX; the caller reports the named reason before mounting.
  if (backend === "phitex" && engine === "lualatex") return null;
  return texpressoEngineFor(engine);
}

/** The download size sentence for the selected backend. */
export function previewEngineMib(backend: LatexPreviewBackend): number {
  return PREVIEW_ENGINE_MIB[backend];
}

/**
 * Why the preview cannot draw this build. Every one is named on the engine
 * chip or in the pane: nothing switches engines quietly.
 */
export type TexpressoFallback =
  "native" | "year" | "jspi" | "lua" | "encoding" | "library" | "failed";

export interface TexpressoInputs {
  /** The engine backend: an installed distribution keeps its own compiler. */
  backend: "bundled" | "native" | "none";
  /** The selected bundled preview engine. */
  preview: LatexPreviewBackend;
  engine: TexEngine;
  /** The TeX Live year of the pinned bundle. */
  year: string;
  jspi: boolean;
  phitex: boolean;
  /** A project text file that is not UTF-8, or null. */
  nonUtf8: string | null;
  /** A project file inside the folder name reserved for local libraries, or null. */
  libraryConflict: string | null;
  /** The frame failed for this project and its restart failed too. */
  failed: boolean;
}

export function texpressoFallback(input: TexpressoInputs): TexpressoFallback | null {
  if (input.backend !== "bundled") return "native";
  if (input.year !== BUNDLED_TEXLIVE_YEAR) return "year";
  if (input.preview === "phitex") {
    if (!input.phitex) return "jspi";
    if (input.engine === "lualatex") return "lua";
  } else if (!input.jspi) {
    return "jspi";
  }
  if (input.failed) return "failed";
  if (input.nonUtf8 !== null) return "encoding";
  if (input.libraryConflict !== null) return "library";
  return null;
}

/** Prefix before the filename in the encoding fallback sentence. */
export const ENCODING_FALLBACK_PREFIX = "the preview reads UTF-8 only; ";

/** The reader's sentence for a build the incremental preview cannot draw. */
export function texpressoFallbackText(
  reason: TexpressoFallback,
  detail: { file?: string | null } = {},
): string {
  switch (reason) {
    case "native":
      return "an installed TeX distribution compiles this project";
    case "year":
      return `the incremental preview needs the TeX Live ${BUNDLED_TEXLIVE_YEAR} data`;
    case "jspi":
      return "this webview lacks WebAssembly JSPI, and the compatibility preview is unavailable";
    case "lua":
      return "the compatibility preview does not run LuaLaTeX; use an installed TeX distribution for this document";
    case "encoding":
      return `${ENCODING_FALLBACK_PREFIX}${detail.file ?? "a project file"} is not — use File › Encoding and Line Endings… to convert it`;
    case "library":
      return `${detail.file ?? "a project file"} is inside .mdraft-texmf, the folder name MDraft reserves for local libraries; rename it`;
    case "failed":
      return "the preview stopped responding and its restart failed";
  }
}

/**
 * Split a message around an inline linked filename. Prefers an explicit `index`
 * when valid so a short filename cannot match an earlier word in the sentence.
 */
export function splitLinkedText(
  text: string,
  needle: string,
  index?: number,
): { before: string; link: string; after: string } | null {
  if (!needle) return null;
  const at =
    index !== undefined && index >= 0 && text.startsWith(needle, index)
      ? index
      : text.indexOf(needle);
  if (at < 0) return null;
  return {
    before: text.slice(0, at),
    link: needle,
    after: text.slice(at + needle.length),
  };
}

/**
 * Label for the centered preview-pane action when a non-UTF-8 file blocks the
 * bundled preview. When the offending file is already the active tab, the
 * action opens Convert directly; otherwise it names the project file it will
 * open first.
 */
export function encodingFallbackActionLabel(
  file: string | null,
  sameAsActive: boolean,
): string | null {
  if (!file) return null;
  return sameAsActive ? "Convert to UTF-8…" : `Open ${file} to convert…`;
}

/**
 * The reader's account of a build the preview engine abandoned part-way. The
 * first sentence is the status line's; the rest goes to Logs. An out-of-memory
 * stop is the engine's limit, not the document's fault, and long documents
 * reach it (a 592-page book stops near page 450), so the advice is the route
 * without that limit.
 */
export function engineFailureText(failure: EngineFailure): { status: string; detail: string } {
  const after = failure.pages > 0 ? ` after page ${failure.pages}` : "";
  if (failure.reason === "memory") {
    return {
      status: `The preview engine ran out of memory${after}.`,
      detail:
        "The pages after that, the table of contents and anything else LaTeX writes at the end of the document are missing, and Save PDF keeps only the pages shown. The bundled engine's memory is limited, and long documents can reach that limit; an installed TeX distribution (Preferences › LaTeX) compiles the whole document. Edits to this document no longer start a build, because each would stop at the same place; select Compile to try again.",
    };
  }
  return {
    status: `The preview engine stopped${after}: ${failure.message}`,
    detail:
      "The pages after that are missing, and Save PDF keeps only the pages shown. Recompile from scratch to try again, or compile with an installed TeX distribution (Preferences › LaTeX).",
  };
}

/**
 * Whether the host releases the frame and holds the project after this
 * failure. Only running out of memory qualifies: the engine has released its
 * history by then, so the next build starts again from page 1 and stops at the
 * same place (measured on a 592-page book: two minutes at 7–11 GB per build),
 * and the frame's idle engine still holds about 5 GB. Any other stop may be a
 * one-off, and the frame stays for the reader's retry.
 */
export function engineFailureHolds(failure: EngineFailure): boolean {
  return failure.reason === "memory";
}

/**
 * The reader's account of a preview frame that stopped answering while it
 * prepared the PDF (`TexpressoSession.exportPdf`). The status sentence leads
 * Logs; the detail follows it. The one cause measured is a font the document
 * names that cannot be found: XeLaTeX sets the text in `nullfont`, and on a
 * 106-page book the frame never answered again.
 */
export const UNRESPONSIVE_PREVIEW = {
  status: "The preview stopped responding while it prepared the PDF.",
  detail:
    "This can happen when a font the document names cannot be found and the text is set without one; see the errors below. The preview was closed to free its memory. Fix the errors, then select Compile.",
} as const;
