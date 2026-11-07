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

  constructor(
    message: string,
    diagnostics: readonly LatexDiagnostic[] = [],
    log = "",
    truncated = false,
  ) {
    super(message);
    this.name = "LatexBuildError";
    this.diagnostics = diagnostics;
    this.log = log;
    this.truncated = truncated;
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
): LatexDiagnostic[] {
  const reported = result.telemetry?.diagnostics?.length
    ? result.telemetry.diagnostics
    : result.errors;
  const out: LatexDiagnostic[] = [];
  const seen = new Set<string>();
  for (const entry of reported) {
    if (!entry.message || out.length >= MAX_REFERENCE_DIAGNOSTICS) continue;
    const file = projectSource(entry.file, sources);
    const line = entry.line ?? 0;
    const key = `${file}\u0000${line}\u0000${entry.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
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
  return out;
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
export async function compileLatex(snapshot: LatexProjectSnapshot): Promise<LatexResult> {
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
  const compiler = new WasmTexCompiler({
    engine: "lualatex",
    texliveVersion: "2025",
    texliveUrl: `${base}mirror/`,
    assetBaseUrl: "/",
    formatAssetBaseUrl: base,
    mainFile: snapshot.mainFile,
    persistentCache: false, // The Rust transport persists the exact mirror URLs.
    files,
  });
  active = compiler;
  try {
    await compiler.init();
    const result = await compiler.compile();
    const blocking = result.errors.filter(
      (entry) =>
        entry.severity === "error" ||
        /citation .+ undefined|empty bibliography|undefined references|run biber/i.test(
          entry.message,
        ),
    );
    if (!result.success || !result.pdf || blocking.length) {
      const detail =
        result.errors.map((entry) => entry.message).join("\n") || result.log.slice(-6000);
      const hint = result.errors.some((entry) => entry.code === "missing-package")
        ? "A package could not be loaded. If you are offline, connect once to download it; otherwise check the package name.\n"
        : /biblatex/i.test(detail)
          ? "The experimental biblatex-lite fallback could not produce this bibliography; full Biber is not included.\n"
          : "";
      const diagnostics = compileDiagnostics(result, sources);
      throw new LatexBuildError(
        hint + detail,
        diagnostics,
        result.log,
        diagnostics.length >= MAX_REFERENCE_DIAGNOSTICS,
      );
    }
    if (/LaTeX Warning: File .+ not found/i.test(result.log)) {
      throw new LatexBuildError(
        "A project image or input is missing.\n" + result.log.slice(-6000),
        [],
        result.log,
      );
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
      log: result.log,
    };
  } finally {
    compiler.dispose();
    if (active === compiler) active = null;
  }
}
