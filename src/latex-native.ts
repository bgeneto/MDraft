//! The native backend's result in the preview's own shape.
//!
//! The Rust runner returns the compiler's facts — exit status, PDF bytes, log,
//! structured diagnostics — and this module turns them into the same
//! `LatexResult`/`LatexBuildError` the bundled engine produces. Keeping the
//! conversion here means both backends pass through one set of preview rules:
//! warning-only output is current, a partial PDF is never a success, and a
//! diagnostic points at a line only when that line is in the captured snapshot.

import type { LatexNativeResult, LatexProjectSnapshot } from "./api";
import { LatexBuildError, type LatexDiagnostic, type LatexResult } from "./latex.ts";
import { lineTextOf } from "./latex-references.ts";
import { libraryOrigin } from "./latex-texmf.ts";

function decodeBase64Data(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function decodeText(data: string, encoding = "UTF-8"): string {
  return new TextDecoder(encoding, { fatal: false }).decode(decodeBase64Data(data));
}

/** The project's `.tex` sources, in the order the viewer maps them. */
export function nativeSources(
  snapshot: LatexProjectSnapshot,
): Array<{ path: string; source: string }> {
  return snapshot.files
    .filter((file) => /\.tex$/i.test(file.path))
    .map((file) => ({
      path: file.path,
      source: decodeText(file.data, file.encoding)
        .replace(/^\uFEFF/, "")
        .replace(/\r\n?/g, "\n"),
    }))
    .sort((left, right) =>
      left.path === snapshot.mainFile
        ? -1
        : right.path === snapshot.mainFile
          ? 1
          : left.path.localeCompare(right.path),
    );
}

function lineText(sources: ReadonlyMap<string, string>, file: string, line: number): string {
  if (!file || line < 1) return "";
  const text = sources.get(file);
  if (!text) return "";
  return lineTextOf(text.split("\n")[line - 1] ?? "");
}

/**
 * The diagnostics a native result owns.
 *
 * The snapshot is the authority on what text the compiler read; a message whose
 * file is not in it is still shown, but with no line text and therefore no
 * navigation, which is the fail-safe rule the bundled path follows too.
 */
export function nativeDiagnostics(
  result: LatexNativeResult,
  snapshot: LatexProjectSnapshot,
): { diagnostics: LatexDiagnostic[]; warnings: LatexDiagnostic[] } {
  const sourceMap = new Map(nativeSources(snapshot).map((file) => [file.path, file.source]));
  const diagnostics = result.diagnostics.map((entry) => {
    // A message from a staged library names the reader's own file, never the
    // job path. It has no line text, so it is shown but cannot navigate: a
    // library file is not a project source.
    const origin = libraryOrigin(snapshot.texmf, entry.file);
    return {
      file: origin ?? entry.file,
      line: entry.line,
      column: 0,
      endColumn: 0,
      severity: entry.severity,
      code: origin ? "library" : entry.code,
      message: origin ? `${entry.message} (local library: ${origin})` : entry.message,
      text: "",
      lineText: origin ? "" : lineText(sourceMap, entry.file, entry.line),
      searched: [],
    };
  });
  return {
    diagnostics,
    warnings: diagnostics.filter((entry) => entry.severity === "warning"),
  };
}

/** The sentence the preview shows above the problem list. */
export function nativeFailureMessage(result: LatexNativeResult): string {
  if (result.cancelled) return "Compilation cancelled.";
  if (result.timedOut) return "Compilation timed out.";
  if (result.error) return result.error;
  if (!result.pdf && !result.partialPdf) return "The compiler produced no PDF.";
  return "Compilation failed.";
}

/**
 * Convert a result, or throw the error shape the preview already understands.
 *
 * A cancelled or timed-out job never publishes bytes, diagnostics or a
 * completion state: the runner's late output belongs to a revision the reader
 * has already left.
 */
/**
 * The name a reader knows an engine by.
 *
 * The native runner reports the executable it ran (`pdflatex`); every label that
 * says what produced a PDF — the export row, the save dialog, the status line —
 * shows this form instead. An unknown executable keeps its own name rather than
 * being passed off as a known engine.
 */
export function latexEngineName(engine: string | undefined | null): string {
  const key = (engine ?? "").trim().toLowerCase();
  if (key === "lualatex") return "LuaLaTeX";
  if (key === "pdflatex") return "pdfLaTeX";
  if (key === "xelatex") return "XeLaTeX";
  return (engine ?? "").trim() || "LaTeX";
}

export function nativeToLatex(
  result: LatexNativeResult,
  snapshot: LatexProjectSnapshot,
): LatexResult {
  const sources = nativeSources(snapshot);
  const { diagnostics, warnings } = nativeDiagnostics(result, snapshot);
  if (!result.success || !result.pdf) {
    const partial = result.cancelled ? null : result.partialPdf;
    throw new LatexBuildError(
      nativeFailureMessage(result),
      diagnostics,
      result.log,
      result.logTruncated,
      partial ? decodeBase64Data(partial) : null,
    );
  }
  return {
    pdf: decodeBase64Data(result.pdf),
    sources,
    files: new Set(snapshot.files.map((file) => file.path)),
    mainFile: snapshot.mainFile,
    log: result.log,
    warnings,
    warningsTruncated: result.warningsTruncated,
    engine: latexEngineName(result.engine),
    elapsedMs: result.elapsedMs,
  };
}
