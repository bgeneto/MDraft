//! Headless LuaLaTeX adapter. The SDK loads only on use.
import type { LatexProjectSnapshot } from "./api";
import {
  collectLatexReferences,
  lineTextOf,
  MAX_REFERENCE_DIAGNOSTICS,
  type LatexDiagnostic,
} from "./latex-references.ts";
import type { WasmTexCompiler } from "wasmtex/headless";
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
function compileDiagnostics(
  result: {
    errors: readonly ReportedProblem[];
    telemetry?: { diagnostics?: readonly ReportedProblem[] };
  },
  sources: ReadonlyMap<string, string>,
): { diagnostics: LatexDiagnostic[]; truncated: boolean } {
  const reported = result.telemetry?.diagnostics?.length
    ? result.telemetry.diagnostics
    : result.errors;
  const out: LatexDiagnostic[] = [];
  const seen = new Set<string>();
  let truncated = false;
  for (const entry of reported) {
    if (entry.severity !== "warning" && entry.severity !== "error") continue;
    if (!entry.message) continue;
    const file = projectSource(entry.file, sources);
    const line = entry.line ?? 0;
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

let active: WasmTexCompiler | null = null;
let generation = 0;

export function cancelLatex(): void {
  generation += 1;
  active?.dispose();
  active = null;
}

function binary(base64: string): Uint8Array {
  const value = atob(base64);
  return Uint8Array.from(value, (char) => char.charCodeAt(0));
}

/**
 * The old throwing contract, re-exported for the app-free suites.
 *
 * `compileLatex` uses `collectLatexReferences` so it can carry every problem
 * into the preview pane; this wrapper keeps the first-problem `Error` that
 * `latex-references-unit.mjs` and `latex-sync-unit.mjs` assert on.
 */
export {
  collectLatexReferences,
  LatexReferenceError,
  validateLatexReferences,
  type LatexDiagnostic,
  type LatexReferenceScan,
} from "./latex-references.ts";

/** Compile exactly this snapshot, with no engine auto-detection or remote source. */
export async function compileLatex(
  snapshot: LatexProjectSnapshot,
  onProgress?: (phase: "resolving" | "downloading" | "compiling") => void,
): Promise<LatexResult> {
  cancelLatex();
  const owner = generation;
  const { WasmTexCompiler } = await import("wasmtex/headless");
  if (generation !== owner) throw new Error("Compilation cancelled.");
  const files: Record<string, string | Uint8Array> = {};
  for (const file of snapshot.files) {
    const bytes = binary(file.data);
    files[file.path] = /\.(?:tex|bib|sty|cls|bst)$/i.test(file.path)
      ? new TextDecoder("utf-8", { fatal: true }).decode(bytes)
      : bytes;
  }
  const sources = new Map(
    Object.entries(files).filter(
      (entry): entry is [string, string] =>
        /\.tex$/i.test(entry[0]) && typeof entry[1] === "string",
    ),
  );
  const scan = collectLatexReferences(sources, new Set(Object.keys(files)), snapshot.mainFile);
  if (scan.diagnostics.length) {
    throw new LatexBuildError(scan.diagnostics[0].message, scan.diagnostics, "", scan.truncated);
  }
  const reachable = scan.reachable;
  const original = files[snapshot.mainFile];
  if (typeof original !== "string") throw new Error("The main .tex file is missing.");
  const base =
    location.protocol === "tauri:"
      ? "mdraft-tex://localhost/"
      : `${location.protocol}//mdraft-tex.localhost/`;
  let downloads = 0;
  const compiler = new WasmTexCompiler({
    engine: "lualatex",
    texliveVersion: "2025",
    texliveUrl: `${base}jobs/${owner}/mirror/`,
    assetBaseUrl: "/",
    formatAssetBaseUrl: base,
    mainFile: snapshot.mainFile,
    persistentCache: false, // The Rust transport persists the exact mirror URLs.
    onLoadProgress: () => {
      if (generation === owner && active === compiler && downloads === 0) onProgress?.("resolving");
    },
    files,
  });
  active = compiler;
  let unlisten: (() => void) | undefined;
  try {
    const { listen } = await import("@tauri-apps/api/event");
    unlisten = await listen<[string, boolean]>("latex-package-download", (event) => {
      if (generation !== owner || active !== compiler || event.payload[0] !== String(owner)) return;
      downloads = Math.max(0, downloads + (event.payload[1] ? 1 : -1));
      onProgress?.(downloads ? "downloading" : "compiling");
    });
    if (generation !== owner) throw new Error("Compilation cancelled.");
    await compiler.init();
    const result = await compiler.compile();
    const log =
      result.log.length > 200_000
        ? `Earlier compiler output was omitted.\n\n${result.log.slice(-200_000)}`
        : result.log;
    const report = compileDiagnostics(result, sources);
    if (latexBuildFailed(result) || !result.pdf) {
      const detail =
        result.errors.map((entry) => entry.message).join("\n") || result.log.slice(-6000);
      const hint = result.errors.some((entry) => entry.code === "missing-package")
        ? "A package could not be loaded. If you are offline, connect once to download it; otherwise check the package name.\n"
        : /biblatex/i.test(detail)
          ? "The experimental biblatex-lite fallback could not produce this bibliography; full Biber is not included.\n"
          : "";
      throw new LatexBuildError(
        hint + detail,
        report.diagnostics,
        log,
        report.truncated,
        result.pdf,
      );
    }
    const warnings = report.diagnostics.filter((diagnostic) => diagnostic.severity === "warning");
    let warningsTruncated = report.truncated;
    for (const match of result.log.matchAll(/LaTeX Warning: File .+ not found[^\r\n]*/gi)) {
      if (!warnings.some((warning) => warning.message.includes(match[0]))) {
        if (warnings.length >= MAX_REFERENCE_DIAGNOSTICS) {
          warningsTruncated = true;
          break;
        }
        warnings.push({
          file: "",
          line: 0,
          column: 0,
          endColumn: 0,
          severity: "warning",
          code: "compile",
          message: match[0],
          text: "",
          lineText: "",
          searched: [],
        });
      }
    }
    return {
      pdf: result.pdf.slice(),
      sources: Object.entries(files)
        .filter(
          (entry): entry is [string, string] =>
            reachable.has(entry[0]) && /\.tex$/i.test(entry[0]) && typeof entry[1] === "string",
        )
        .sort(([a], [b]) =>
          a === snapshot.mainFile ? -1 : b === snapshot.mainFile ? 1 : a.localeCompare(b),
        )
        .map(([path, text]) => ({
          path,
          source: text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n"),
        })),
      mainFile: snapshot.mainFile,
      files: reachable,
      log,
      warnings,
      warningsTruncated,
      engine: "LuaLaTeX",
    };
  } finally {
    unlisten?.();
    compiler.dispose();
    if (active === compiler) active = null;
  }
}
