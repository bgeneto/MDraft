//! Headless LuaLaTeX adapter. The SDK loads only on use.
import type { LatexProjectSnapshot } from "./api";
import {
  collectLatexReferences,
  lineTextOf,
  MAX_REFERENCE_DIAGNOSTICS,
  type LatexDiagnostic,
} from "./latex-references.ts";
import type { WasmTexCompiler } from "wasmtex/headless";
import {
  bundledLibraryFiles,
  LIBRARY_PREFIX,
  libraryLookupNames,
  reservedProjectPath,
} from "./latex-texmf.ts";
import { LATEX_ENGINE_YEAR } from "./latex-engine.ts";
import type { TexEngine } from "./latex-engine-choice.ts";
import { perfMark, perfMeasure } from "./perf.ts";
import { LatestWinsGate } from "./latex-scheduler.ts";
export { SupersededError } from "./latex-scheduler.ts";
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
 * The warm engine (docs/adr/2026-11-12-latex-engine-lifetime.md).
 *
 * One compiler stays alive between compiles of the same project, so an edit
 * pays only for the changed files and the typeset, not for booting the worker,
 * loading 10 MB of wasm and format and loading the preamble's packages again.
 * `files` is what the engine currently holds, so the next compile sends only
 * the difference.
 */
interface WarmEngine {
  key: string;
  /** The TeX engine this worker runs (stage 6.2); another engine needs another worker. */
  engine: TexEngine;
  compiler: WasmTexCompiler;
  /** The stable `jobs/<session>/mirror/` segment for this engine's lifetime. */
  session: number;
  files: Map<string, string | Uint8Array>;
  compiles: number;
  booted: boolean;
  /** The progress callback of the compile in flight, if any. */
  progress: ((phase: LatexPhase, count?: number) => void) | null;
  /** Built with heap checkpoints (stage 3.2): compiles and previews may resume. */
  checkpoints: boolean;
  lastActivity: number;
}

/** What the reader is waiting for. Truthful by construction: see S1 of the plan. */
export type LatexPhase = "loading" | "compiling" | "downloading";

let warm: WarmEngine | null = null;
let sessionCounter = 0;
let generation = 0;
let autoToken = 0;
const gate = new LatestWinsGate();
/** Engine crashes per project key, for the circuit breaker. */
const crashes = new Map<string, number[]>();
const BREAKER_WINDOW_MS = 10 * 60_000;
/** A compile with no progress at all for this long is presumed hung. */
const WATCHDOG_IDLE_MS = 120_000;

/** Two engine failures within ten minutes stop reuse for that project this session. */
function breakerTripped(key: string): boolean {
  const now = Date.now();
  const recent = (crashes.get(key) ?? []).filter((at) => now - at < BREAKER_WINDOW_MS);
  crashes.set(key, recent);
  return recent.length >= 2;
}

function recordCrash(key: string): void {
  crashes.set(key, [...(crashes.get(key) ?? []), Date.now()]);
}

function disposeWarm(): void {
  const engine = warm;
  warm = null;
  engine?.compiler.dispose();
}

/**
 * Dispose the engine and abandon its job. Only for real disposal boundaries:
 * engine disabled or changed, an explicit Cancel, a closed project. Typing is
 * not one of them; a newer revision simply runs after the current one.
 */
export function cancelLatex(): void {
  generation += 1;
  gate.dropWaiting(new Error("Compilation cancelled."));
  disposeWarm();
}

/** Diagnostics for the probe and the Logs view: what the engine holds now. */
export function latexEngineInfo(): {
  key: string | null;
  engine: TexEngine | null;
  session: number | null;
  compiles: number;
  busy: boolean;
} {
  return {
    key: warm?.key ?? null,
    engine: warm?.engine ?? null,
    session: warm?.session ?? null,
    compiles: warm?.compiles ?? 0,
    busy: gate.holder !== null,
  };
}

function sameContent(a: string | Uint8Array | undefined, b: string | Uint8Array): boolean {
  if (a === undefined) return false;
  if (typeof a === "string" || typeof b === "string") return a === b;
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) return false;
  return true;
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

/** The engine inputs of a snapshot: decoded sources, the reference scan and library files. */
interface PreparedInputs {
  files: Record<string, string | Uint8Array>;
  decoded: Map<string, string>;
  sources: Map<string, string>;
  reachable: ReadonlySet<string>;
  libraryCount: number;
  inputs: Record<string, string | Uint8Array>;
}

/**
 * Decode a snapshot and check its references. Shared by the canonical compile
 * and the interactive preview so both hand the engine identical inputs.
 */
function prepareInputs(snapshot: LatexProjectSnapshot): PreparedInputs {
  const textSource = /\.(?:tex|bib|sty|cls|bst)$/i;
  const files: Record<string, string | Uint8Array> = {};
  const decoded = new Map<string, string>();
  const decodeStarted = perfMark("snapshot-decode-start", {
    files: snapshot.files.length,
    libraries: snapshot.texmf?.files.length ?? 0,
  });
  let decodedBytes = 0;
  for (const file of snapshot.files) {
    const bytes = binary(file.data);
    decodedBytes += bytes.length;
    if (!textSource.test(file.path)) {
      files[file.path] = bytes;
      continue;
    }
    const encoding = file.encoding ?? "UTF-8";
    const source = new TextDecoder(encoding, { fatal: true }).decode(bytes);
    decoded.set(file.path, source);
    // A UTF-8 string reaches the engine as UTF-8. A legacy source must travel
    // as its original bytes: re-encoding it as a JavaScript string would change
    // what the document's `inputenc` reads. TextDecoder above is only for the
    // reference scan and diagnostics.
    files[file.path] = encoding.toUpperCase() === "UTF-8" ? source : bytes;
  }
  perfMeasure("snapshot-decode", decodeStarted, {
    files: snapshot.files.length,
    bytes: decodedBytes,
    sources: decoded.size,
  });
  const sources = new Map([...decoded.entries()].filter(([path]) => /\.tex$/i.test(path)));
  const reserved = Object.keys(files).find(reservedProjectPath);
  if (reserved) {
    throw new Error(
      `${reserved} uses the name MDraft reserves for local libraries (${LIBRARY_PREFIX}). Rename it.`,
    );
  }
  // Libraries resolve through the engine's search path; the check only needs to
  // know their names, so a library input is not reported as a missing file.
  const known = new Set([...Object.keys(files), ...libraryLookupNames(snapshot.texmf)]);
  const scan = collectLatexReferences(sources, known, snapshot.mainFile);
  if (scan.diagnostics.length) {
    throw new LatexBuildError(scan.diagnostics[0].message, scan.diagnostics, "", scan.truncated);
  }
  const reachable = scan.reachable;
  if (!decoded.has(snapshot.mainFile)) throw new Error("The main .tex file is missing.");
  // Library files travel separately from `files`: they are engine inputs, not
  // project sources, so they never reach `sources`, `reachable` or the result.
  const library = bundledLibraryFiles(
    snapshot.texmf,
    new Set(Object.keys(files)),
    [...sources.values()].concat(
      [...decoded.entries()]
        .filter(([path]) => /\.(?:cls|sty)$/i.test(path))
        .map(([, value]) => value),
    ),
  );
  const inputs: Record<string, string | Uint8Array> = { ...library.files, ...files };
  return {
    files,
    decoded,
    sources,
    reachable,
    libraryCount: Object.keys(library.files).length,
    inputs,
  };
}

/**
 * Compile exactly this snapshot, with no engine auto-detection or remote source.
 *
 * `key` identifies the project (main file, engine year, library revision): the
 * same key reuses the warm engine. `token` orders concurrent requests: a
 * request that arrives while the engine is busy waits, and a newer one replaces
 * it (`SupersededError`). The running compile is never aborted for typing.
 */
export async function compileLatex(
  snapshot: LatexProjectSnapshot,
  onProgress?: (phase: LatexPhase, count?: number) => void,
  options: {
    key?: string;
    token?: number;
    edit?: { path: string; offset: number };
    /** The bundled engine (stage 6.2); LuaLaTeX when not given. */
    engine?: TexEngine;
  } = {},
): Promise<LatexResult> {
  const texEngine = options.engine ?? "lualatex";
  const owner = generation;
  const moduleStarted = perfMark("module-start", { mainFile: snapshot.mainFile });
  const { WasmTexCompiler } = await import("wasmtex/headless");
  perfMeasure("module", moduleStarted);
  if (generation !== owner) throw new Error("Compilation cancelled.");
  const { files, decoded, sources, reachable, libraryCount, inputs } = prepareInputs(snapshot);
  const base =
    location.protocol === "tauri:"
      ? "mdraft-tex://localhost/"
      : `${location.protocol}//mdraft-tex.localhost/`;
  // Without a key there is nothing to match against: the compile still runs on
  // the warm slot, but under a key no later request can share.
  const key = options.key ?? `unkeyed:${snapshot.mainFile}:${++autoToken}`;
  const release = await gate.acquire(options.token ?? ++autoToken);
  let downloads = 0;
  let unlisten: (() => void) | undefined;
  let engine: WarmEngine | null = null;
  try {
    if (generation !== owner) throw new Error("Compilation cancelled.");
    const reuse =
      warm !== null && warm.key === key && warm.engine === texEngine && !breakerTripped(key);
    const initStarted = perfMark("init-start", {
      engine: texEngine,
      files: Object.keys(files).length,
      libraries: libraryCount,
      reuse,
    });
    if (reuse && warm) {
      engine = warm;
      const held = engine.files;
      const names = Object.keys(inputs);
      const fileSetChanged = names.length !== held.size || names.some((name) => !held.has(name));
      if (fileSetChanged) {
        // An added or removed \include changes the project's shape; the SDK
        // replaces the file system but keeps the worker and its loaded engine.
        await engine.compiler.loadProject(inputs);
      } else {
        for (const name of names) {
          if (!sameContent(held.get(name), inputs[name]))
            engine.compiler.setFile(name, inputs[name]);
        }
      }
      perfMeasure("init", initStarted, {
        warm: "reused",
        fileSetChanged,
        files: names.length,
        session: engine.session,
      });
    } else {
      disposeWarm();
      const session = ++sessionCounter;
      const compiler = new WasmTexCompiler({
        engine: texEngine,
        // From `src-tauri/latex-engine.json`, the file the Rust side derives its asset
        // root, mirror and digests from (docs/adr/2026-11-12-engine-profile-config.md).
        texliveVersion: LATEX_ENGINE_YEAR,
        // A stable segment for the engine's lifetime: the transport keeps no
        // per-job state; downloads are attributed to the compile in flight.
        texliveUrl: `${base}jobs/${session}/mirror/`,
        assetBaseUrl: "/",
        formatAssetBaseUrl: base,
        mainFile: snapshot.mainFile,
        persistentCache: false, // The Rust transport persists the exact mirror URLs.
        // Heap checkpoints (stage 3.2): the checkpoint build snapshots the engine
        // before the paragraph being edited, so the next compile and page preview
        // resume there instead of re-running the preamble and every page above.
        // The budget bounds the retained sparse images (Phase 4 memory budget).
        // pdfTeX and XeTeX keep the SDK's own incremental paths.
        luatexHeapCheckpoints: texEngine === "lualatex" ? CHECKPOINT_BUDGET : undefined,
        tikzExternalization: TIKZ_EXTERNALIZATION,
        onLoadProgress: (event) => {
          const current = warm?.compiler === compiler ? warm : null;
          if (!current) return;
          current.lastActivity = performance.now();
          if (downloads > 0) return;
          if (event.phase === "format") {
            if (event.percent >= 100) current.booted = true;
            current.progress?.(current.booted ? "compiling" : "loading");
          }
        },
        files: inputs,
      });
      engine = {
        key,
        engine: texEngine,
        compiler,
        session,
        files: new Map(),
        compiles: 0,
        booted: false,
        progress: null,
        checkpoints: texEngine === "lualatex",
        lastActivity: performance.now(),
      };
      warm = engine;
      onProgress?.("loading");
      await compiler.init();
      perfMeasure("init", initStarted, {
        warm: "created",
        files: Object.keys(files).length,
        libraries: libraryCount,
        session,
      });
    }
    const current = engine;
    current.progress = (phase, count) => {
      if (generation === owner) onProgress?.(phase, count);
    };
    if (current.booted) onProgress?.("compiling");
    const { listen } = await import("@tauri-apps/api/event");
    unlisten = await listen<[string, boolean]>("latex-package-download", (event) => {
      if (generation !== owner || warm !== current || event.payload[0] !== String(current.session))
        return;
      current.lastActivity = performance.now();
      downloads = Math.max(0, downloads + (event.payload[1] ? 1 : -1));
      onProgress?.(downloads ? "downloading" : "compiling", downloads);
    });
    if (generation !== owner) throw new Error("Compilation cancelled.");
    const compileStarted = perfMark("compile-start", {
      mainFile: snapshot.mainFile,
      reuse,
      session: current.session,
    });
    current.lastActivity = performance.now();
    // The watchdog: a compile that shows no progress at all for two minutes is
    // presumed hung. Disposal is the only way to stop the SDK's worker.
    let watchdog = 0;
    const hung = new Promise<never>((_, reject) => {
      const check = (): void => {
        if (performance.now() - current.lastActivity > WATCHDOG_IDLE_MS) {
          reject(new Error("The LaTeX engine stopped responding and was restarted."));
          return;
        }
        watchdog = window.setTimeout(check, 5000);
      };
      watchdog = window.setTimeout(check, 5000);
    });
    let result: Awaited<ReturnType<WasmTexCompiler["compile"]>>;
    try {
      // The caret marks where the reader is working: the SDK places a
      // checkpoint before that paragraph during this pass, which runs anyway.
      result = await Promise.race([
        current.compiler.compile(
          options.edit ? { incrementalPreparation: options.edit } : undefined,
        ),
        hung,
      ]);
    } finally {
      window.clearTimeout(watchdog);
    }
    recordCost(key, "compile", performance.now() - compileStarted);
    current.files = new Map(Object.entries(inputs));
    current.compiles += 1;
    current.booted = true;
    perfMeasure("compile", compileStarted, {
      compileTime: result.compileTime,
      success: result.success,
      pdfBytes: result.pdf?.length ?? 0,
      logBytes: result.log.length,
      // Engine banners in the returned log: a lower bound on the TeX passes,
      // since the SDK may keep only some passes' logs. LuaLaTeX reports no
      // per-pass timings, so this is the only pass signal the probe has.
      banners: (result.log.match(/^This is (?:LuaHBTeX|pdfTeX|XeTeX)/gm) ?? []).length,
      engine: texEngine,
      reuse,
      compiles: current.compiles,
      // TikZ externalization (stage 6.1): figures rendered versus reused.
      tikz: result.telemetry?.tikzExternalization
        ? {
            mode: result.telemetry.tikzExternalization.mode,
            figures: result.telemetry.tikzExternalization.figures,
            compiled: result.telemetry.tikzExternalization.compiled,
            reused: result.telemetry.tikzExternalization.reused,
            failed: result.telemetry.tikzExternalization.failed.length,
            figureTimeMs: result.telemetry.tikzExternalization.figureTimeMs,
            fallback: result.telemetry.tikzExternalization.fallback ?? false,
            blocked: result.telemetry.tikzExternalization.blocked ?? null,
          }
        : null,
      // The checkpoint engine's own account of the pass: whether it resumed,
      // how long the heap restore took and what checkpoints it captured.
      phase: result.phaseTimings
        ? {
            resume: result.phaseTimings.checkpointResume ?? false,
            heapRestoreMs: result.phaseTimings.heapRestoreMs,
            texRunMs: result.phaseTimings.texRunMs,
            postProcessMs: result.phaseTimings.postProcessMs,
            heapSizeBytes: result.phaseTimings.heapSizeBytes,
          }
        : null,
      checkpoints: (result.heapCheckpoints ?? []).map((record) => ({
        line: record.line,
        path: record.path ?? null,
        bytes: record.bytes,
        ms: record.ms,
      })),
    });
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
      sources: [...decoded.entries()]
        .filter(([path]) => reachable.has(path) && /\.tex$/i.test(path))
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
  } catch (error) {
    // A LaTeX build failure means the engine ran and produced a log: it stays
    // warm. Anything else (init, worker, watchdog) leaves it in an unknown
    // state, so it is disposed and counted for the circuit breaker.
    if (!(error instanceof LatexBuildError) && engine && warm === engine) {
      if (generation === owner) recordCrash(key);
      disposeWarm();
    }
    throw error;
  } finally {
    unlisten?.();
    if (engine) engine.progress = null;
    // With the breaker tripped the project compiles in a fresh engine each time,
    // the behaviour before warm reuse, until the session ends.
    if (warm && breakerTripped(warm.key)) disposeWarm();
    release();
  }
}

/**
 * Compile the snapshot on a fresh, checkpoint-free engine and return its PDF.
 *
 * The oracle for re-anchoring (stage 3.4): the warm engine resumes from heap
 * checkpoints and keeps auxiliary files between passes, so now and then its
 * result is compared with what a cold engine produces from the same inputs.
 * Runs through the same gate, so it never competes with the warm engine for
 * the reader's CPU; it is only started when the reader is idle. Null when the
 * build fails or produces no PDF (nothing to compare).
 */
export async function compileFresh(
  snapshot: LatexProjectSnapshot,
  token: number,
  engine: TexEngine = "lualatex",
): Promise<Uint8Array | null> {
  const { WasmTexCompiler } = await import("wasmtex/headless");
  const prepared = prepareInputs(snapshot);
  const base =
    location.protocol === "tauri:"
      ? "mdraft-tex://localhost/"
      : `${location.protocol}//mdraft-tex.localhost/`;
  const release = await gate.acquire(token);
  const compiler = new WasmTexCompiler({
    engine,
    texliveVersion: LATEX_ENGINE_YEAR,
    texliveUrl: `${base}jobs/${++sessionCounter}/mirror/`,
    assetBaseUrl: "/",
    formatAssetBaseUrl: base,
    mainFile: snapshot.mainFile,
    persistentCache: false,
    files: prepared.inputs,
  });
  try {
    await compiler.init();
    const result = await compiler.compile();
    return result.success && result.pdf ? result.pdf.slice() : null;
  } catch {
    return null;
  } finally {
    compiler.dispose();
    release();
  }
}

/** Recycle the warm engine after this many compiles (Phase 4.1; see `recycleWarmEngine`). */
export const RECYCLE_AFTER_COMPILES = 400;

/**
 * Replace the warm engine with a freshly booted one, blue/green (Phase 4.1).
 *
 * WASM linear memory only grows, and a long session leaves the engine holding
 * its high-water mark. At idle, a spare engine boots and compiles the current
 * inputs on its own; only when it has succeeded does it take the old one's
 * place, so the reader never waits for a cold engine. A failure keeps the old
 * engine. Returns whether the swap happened.
 */
export async function recycleWarmEngine(
  snapshot: LatexProjectSnapshot,
  key: string,
  token: number,
): Promise<boolean> {
  const old = warm;
  if (!old || old.key !== key) return false;
  const { WasmTexCompiler } = await import("wasmtex/headless");
  const prepared = prepareInputs(snapshot);
  const base =
    location.protocol === "tauri:"
      ? "mdraft-tex://localhost/"
      : `${location.protocol}//mdraft-tex.localhost/`;
  const release = await gate.acquire(token);
  const session = ++sessionCounter;
  const compiler = new WasmTexCompiler({
    engine: old.engine,
    texliveVersion: LATEX_ENGINE_YEAR,
    texliveUrl: `${base}jobs/${session}/mirror/`,
    assetBaseUrl: "/",
    formatAssetBaseUrl: base,
    mainFile: snapshot.mainFile,
    persistentCache: false,
    luatexHeapCheckpoints: old.engine === "lualatex" ? CHECKPOINT_BUDGET : undefined,
    tikzExternalization: TIKZ_EXTERNALIZATION,
    files: prepared.inputs,
  });
  const started = perfMark("recycle-start", { compiles: old.compiles, session });
  try {
    await compiler.init();
    const result = await compiler.compile();
    if (!result.success || warm !== old) {
      compiler.dispose();
      perfMeasure("recycle", started, { swapped: false });
      return false;
    }
    warm = {
      key,
      engine: old.engine,
      compiler,
      session,
      files: new Map(Object.entries(prepared.inputs)),
      compiles: 1,
      booted: true,
      progress: null,
      lastActivity: performance.now(),
      checkpoints: old.checkpoints,
    };
    old.compiler.dispose();
    perfMeasure("recycle", started, { swapped: true, previousCompiles: old.compiles, session });
    return true;
  } catch {
    compiler.dispose();
    perfMeasure("recycle", started, { swapped: false });
    return false;
  } finally {
    release();
  }
}

/**
 * Stop trusting the warm engine for a project: a re-anchoring compare found
 * its result different from a fresh compile. Trips the circuit breaker, so the
 * project compiles on a fresh engine every time for the rest of the session.
 */
export function distrustWarmEngine(key: string): void {
  recordCrash(key);
  recordCrash(key);
  if (warm?.key === key) disposeWarm();
}

/** Measured wall times per project, for deciding whether the interactive lane pays. */
const laneCosts = new Map<string, { preview: number | null; compile: number | null }>();

function recordCost(key: string, lane: "preview" | "compile", ms: number): void {
  const entry = laneCosts.get(key) ?? { preview: null, compile: null };
  const previous = entry[lane];
  entry[lane] = previous === null ? ms : previous * 0.7 + ms * 0.3;
  laneCosts.set(key, entry);
}

/**
 * Whether a preview is expected to show the edit clearly sooner than the full
 * compile would: it runs before the canonical compile on the same worker, so
 * a preview that costs most of a compile only delays the exact result.
 */
export function interactiveLaneWorthwhile(key: string): boolean {
  // Rejected twice by its gate (docs/plans/2026-11-12-latex-compile-cost.md,
  // stage 2.2): on both engines a preview plus the exact compile cost about
  // 1 s more E2C than the exact compile alone. Off until a cheaper preview
  // path is measured; the code stays for that evaluation.
  if (!INTERACTIVE_LANE) return false;
  // Measured in Phase 1: without checkpoints a page preview re-typesets from
  // the format up to the edited page, which delayed the exact result by up to
  // 1.5 s for a small E2P gain. The lane runs only on a checkpoint engine.
  if (!warm || warm.key !== key || !warm.checkpoints) return false;
  const entry = laneCosts.get(key);
  if (!entry || entry.preview === null || entry.compile === null) return true;
  return entry.preview < 0.6 * entry.compile;
}

/** A span of pages for the interactive lane. Display only: no SyncTeX, no export. */
export interface LatexPagePreview {
  pdf: Uint8Array;
  /** The page of the full document that the preview's first page replaces. */
  firstPage: number;
  compileTime: number;
}

/** The interactive lane (stage 2.2); see `interactiveLaneWorthwhile`. */
const INTERACTIVE_LANE = false;

/** Retained heap checkpoints: the edit's paragraph and the previous chapter's. */
const CHECKPOINT_BUDGET = { maxCheckpoints: 4, maxBytes: 128 * 1024 * 1024 };

/**
 * TikZ externalization (stage 6.1). "document" is the SDK default: only a
 * document that calls `\tikzexternalize` gets its figures rendered by sibling
 * compilers and cached by MD5. "auto" would extend that to every TikZ document;
 * the decision and its measurement are in docs/plans/2026-11-12-latex-compile-cost.md.
 */
const TIKZ_EXTERNALIZATION = { mode: "document" as const };

/** A preview that shows no progress for this long is abandoned with its engine. */
const PREVIEW_TIMEOUT_MS = 30_000;

/**
 * Typeset only the pages the reader is looking at, on the warm engine.
 *
 * The interactive lane of docs/plans/2026-11-12-latex-compile-cost.md (2.2):
 * the SDK's `previewPages(limit, { placement: true })` uses the last full
 * pass's references, typesets an edited `\include` chapter alone, and resumes
 * from a heap checkpoint when the engine has one. Returns null whenever the
 * canonical compile must answer instead: no warm engine for this project, no
 * full pass yet, a changed file set, a reference problem, or an SDK refusal.
 * A failed preview is never a failed build; the canonical compile reports.
 */
export async function previewLatexPages(
  snapshot: LatexProjectSnapshot,
  options: { key: string; token: number; pageLimit: number },
): Promise<LatexPagePreview | null> {
  const engine = warm;
  if (!engine || engine.key !== options.key || engine.compiles === 0 || breakerTripped(options.key))
    return null;
  let prepared: PreparedInputs;
  try {
    prepared = prepareInputs(snapshot);
  } catch {
    return null;
  }
  const release = await gate.acquire(options.token);
  try {
    if (warm !== engine) return null;
    const names = Object.keys(prepared.inputs);
    if (names.length !== engine.files.size || names.some((name) => !engine.files.has(name)))
      return null;
    for (const name of names) {
      if (!sameContent(engine.files.get(name), prepared.inputs[name]))
        engine.compiler.setFile(name, prepared.inputs[name]);
    }
    engine.files = new Map(Object.entries(prepared.inputs));
    const started = perfMark("preview-start", { pageLimit: options.pageLimit });
    let timer = 0;
    const timeout = new Promise<never>((_, reject) => {
      timer = window.setTimeout(
        () => reject(new Error("The LaTeX page preview stopped responding.")),
        PREVIEW_TIMEOUT_MS,
      );
    });
    let result: Awaited<ReturnType<WasmTexCompiler["previewPages"]>>;
    try {
      result = await Promise.race([
        engine.compiler.previewPages(options.pageLimit, { placement: true }),
        timeout,
      ]);
    } catch (error) {
      if (warm === engine) {
        recordCrash(engine.key);
        disposeWarm();
      }
      perfMeasure("preview", started, { ok: false, error: String(error) });
      return null;
    } finally {
      window.clearTimeout(timer);
    }
    recordCost(engine.key, "preview", performance.now() - started);
    perfMeasure("preview", started, {
      ok: result !== null,
      firstPage: result?.firstPage ?? null,
      pageLimit: options.pageLimit,
      sdkTime: result?.compileTime ?? null,
    });
    if (!result) return null;
    return {
      pdf: result.pdf.slice(),
      firstPage: result.firstPage ?? 1,
      compileTime: result.compileTime,
    };
  } finally {
    release();
  }
}
