//! Shared LaTeX result and diagnostic types, and the compiler-log reader.
//!
//! The bundled WebAssembly compile path was removed in 0.9.5. The live preview
//! runs TeXpresso or PhiTeX in its own frame; the native backend still uses
//! these types and the log/diagnostic helpers. Pure: no DOM, no IPC.

import { lineTextOf, MAX_REFERENCE_DIAGNOSTICS, type LatexDiagnostic } from "./latex-references.ts";
import type { PdfSourceFile } from "./pdf-page-map";

export interface LatexResult {
  pdf: Uint8Array;
  sources: PdfSourceFile[];
  files: ReadonlySet<string>;
  mainFile: string;
  log: string;
  warnings: LatexDiagnostic[];
  warningsTruncated: boolean;
  /** The engine that produced the bytes, for Save/Export labels. */
  engine?: string;
  /** Wall-clock time the compile took, when the backend measured it. */
  elapsedMs?: number;
  /** Build passes the installed engine needed, when measured. */
  passes?: number;
}

/**
 * A failed LaTeX build, with every problem the UI can point at.
 *
 * `message` stays the plain first-problem text so a caller that only has a
 * string (a toast, a test) keeps working; the preview pane reads `diagnostics`
 * and renders the navigable list.
 */
export class LatexBuildError extends Error {
  readonly diagnostics: readonly LatexDiagnostic[];
  readonly log: string;
  readonly truncated: boolean;
  readonly partialPdf: Uint8Array | null;

  constructor(
    message: string,
    diagnostics: readonly LatexDiagnostic[] = [],
    log = "",
    truncated = false,
    partialPdf: Uint8Array | null = null,
  ) {
    super(message);
    this.name = "LatexBuildError";
    this.diagnostics = diagnostics;
    this.log = log;
    this.truncated = truncated;
    this.partialPdf = partialPdf?.slice() ?? null;
  }
}

/**
 * The snapshot's name for a path the compiler reported.
 *
 * The SDK reports `./main.tex`, `main.tex` or an absolute path depending on the
 * engine and the message. Only a name that matches a project source can be
 * marked; the raw path is still shown when it cannot be resolved, so a message
 * never disappears just because its path was odd.
 */
function projectSource(value: string | undefined, sources: ReadonlyMap<string, string>): string {
  if (!value) return "";
  const name = value.replace(/\\/g, "/").replace(/^\.\//, "");
  if (sources.has(name)) return name;
  for (const key of sources.keys()) {
    if (name.endsWith(`/${key}`)) return key;
  }
  return name;
}

/**
 * The file TeX had open at offset `at` of its log, or null.
 *
 * TeX prints `(` and the file name when it opens a file and `)` when it closes
 * it; names with spaces are quoted (`("./Resumo executivo.tex"`). Walking the
 * log up to `at` with a stack of those parentheses gives the innermost open
 * file — the usual way TeX log readers place a warning. A parenthesis that does
 * not start a file name (prose such as "(see the transcript file)") is pushed
 * as null, so its `)` pops the right entry.
 */
export function openFileAt(log: string, at: number): string | null {
  const stack: Array<string | null> = [];
  const name = /\("([^"]+)"|\(([^\s()"]+)/y;
  for (let i = 0; i < at; i += 1) {
    const char = log[i];
    if (char === "(") {
      name.lastIndex = i;
      const match = name.exec(log);
      const candidate = match ? (match[1] ?? match[2]) : null;
      stack.push(candidate && /\.[A-Za-z]{1,4}$/.test(candidate) ? candidate : null);
    } else if (char === ")") stack.pop();
  }
  for (let i = stack.length - 1; i >= 0; i -= 1) if (stack[i]) return stack[i];
  return null;
}

/** The compiled line a diagnostic points at, or "" when there is none. */
function sourceLine(sources: ReadonlyMap<string, string>, file: string, line: number): string {
  const text = sources.get(file);
  if (!text || line < 1) return "";
  const lines = text.split(/\r?\n/);
  return lineTextOf(lines[line - 1] ?? "");
}

/** What the SDK reports for one compile problem, in the fields both shapes share. */
interface ReportedProblem {
  code?: string;
  severity?: "error" | "warning" | "info";
  message: string;
  file?: string;
  line?: number;
}

export function latexBuildFailed(result: {
  success: boolean;
  pdf: Uint8Array | null;
  errors: readonly ReportedProblem[];
  telemetry?: { diagnostics?: readonly ReportedProblem[] };
}): boolean {
  return (
    !result.success ||
    !result.pdf ||
    result.errors.some((entry) => entry.severity === "error") ||
    Boolean(result.telemetry?.diagnostics?.some((entry) => entry.severity === "error"))
  );
}

/**
 * Turn the SDK's compile errors into the same diagnostics the reference scan
 * produces.
 *
 * A compiler error usually carries a line but no column, so the editor marks
 * the whole line; the reference scan is the precise-command half. Telemetry is
 * preferred because it is the superset and carries a stable `code`; `errors`
 * is the fallback for an older asset.
 */
export function compileDiagnostics(
  result: {
    errors: readonly ReportedProblem[];
    telemetry?: { diagnostics?: readonly ReportedProblem[] };
    log?: string;
  },
  sources: ReadonlyMap<string, string>,
): { diagnostics: LatexDiagnostic[]; truncated: boolean } {
  const reported = result.telemetry?.diagnostics?.length
    ? result.telemetry.diagnostics
    : result.errors;
  const out: LatexDiagnostic[] = [];
  const seen = new Set<string>();
  // The SDK looks only five lines ahead of `! ...`. Normal LaTeX help text
  // already exceeds that, so valid project errors lost their line and link.
  // Recover the compiler's own l.<n> pointer within the same error block.
  const pointers = new Map<string, number[]>();
  let pendingMessage: string | null = null;
  for (const line of (result.log ?? "").split(/\r?\n/)) {
    const error = /^!\s+(.+)/.exec(line);
    if (error) pendingMessage = error[1].trim();
    else if (
      /^(?:LaTeX Warning:|Package \S+ Warning:|Overfull |Underfull |Output written |Transcript written )/.test(
        line,
      )
    )
      pendingMessage = null;
    else {
      const pointer = /^l\.(\d+)(?:\s|$)/.exec(line);
      if (pendingMessage && pointer) {
        const locations = pointers.get(pendingMessage) ?? [];
        locations.push(Number(pointer[1]));
        pointers.set(pendingMessage, locations);
        pendingMessage = null;
      }
    }
  }
  let truncated = false;
  // A LaTeX warning carries its place in its own text ("... undefined on input
  // line 12."), and the SDK reports such warnings with line 0 and the main file.
  // TeX wraps the log at 79 columns and the SDK keeps only the first physical
  // line, so the number is usually cut off ("... on input li") and is read from
  // the log with the wrap undone. The file is the one TeX had open at that
  // point of the log — an `\input` chapter, not necessarily the main file. A
  // cursor per message keeps two identical warnings on their own occurrences.
  const log = result.log ?? "";
  const warningCursor = new Map<string, number>();
  const warningPlace = (message: string): { line: number; file: string | null } => {
    const from = warningCursor.get(message) ?? 0;
    const at = log.indexOf(message, from);
    if (at >= 0) warningCursor.set(message, at + message.length);
    const own = /\bon input line (\d+)/.exec(message);
    const tail = at >= 0 ? log.slice(at, at + message.length + 240).replace(/\r?\n/g, "") : "";
    const line = Number(own?.[1] ?? /\bon input line (\d+)/.exec(tail)?.[1] ?? 0);
    const open = at >= 0 ? openFileAt(log, at) : null;
    const file = open ? projectSource(open, sources) : "";
    return { line, file: file && sources.has(file) ? file : null };
  };
  for (const entry of reported) {
    if (entry.severity !== "warning" && entry.severity !== "error") continue;
    if (!entry.message) continue;
    const place = entry.severity === "warning" && !entry.line ? warningPlace(entry.message) : null;
    const file = place?.file ?? projectSource(entry.file, sources);
    const pointer =
      entry.severity === "error" ? pointers.get(entry.message.trim())?.shift() : undefined;
    const line = entry.line || pointer || place?.line || 0;
    const key = `${file}\u0000${line}\u0000${entry.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (out.length >= MAX_REFERENCE_DIAGNOSTICS) {
      truncated = true;
      continue;
    }
    out.push({
      file,
      line,
      column: 0,
      endColumn: 0,
      severity: entry.severity === "warning" ? "warning" : "error",
      code: entry.code ? `compile:${entry.code}` : "compile",
      message: entry.message,
      text: "",
      lineText: file && line ? sourceLine(sources, file, line) : "",
      searched: [],
    });
  }
  return { diagnostics: out, truncated };
}

/**
 * The old throwing contract, re-exported for the app-free suites.
 *
 * The live preview no longer compiles in this module, but the validator's
 * first-problem `Error` remains the contract `latex-references-unit.mjs` and
 * `latex-sync-unit.mjs` assert on.
 */
export {
  collectLatexReferences,
  LatexReferenceError,
  validateLatexReferences,
  type LatexDiagnostic,
  type LatexReferenceScan,
} from "./latex-references.ts";
