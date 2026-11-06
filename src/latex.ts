//! Headless LuaLaTeX adapter. The SDK and SyncTeX parser load only on use.
import type { LatexProjectSnapshot } from "./api";
import type { WasmTexCompiler } from "wasmtex/headless";
import type { SynctexData, SynctexParser } from "wasmtex/synctex";

export interface LatexResult {
  pdf: Uint8Array;
  parser: SynctexParser;
  mapping: SynctexData;
  files: ReadonlySet<string>;
  mainFile: string;
  log: string;
}

function projectName(path: string): string {
  return path.replace(/^\/?work\/(?:\.\/)?/, "").replace(/^\.\//, "");
}

/** Accept inverse navigation only when one exact project line owns the point. */
export function latexSourceAt(
  result: LatexResult,
  page: number,
  x: number,
  y: number,
): { file: string; line: number } | null {
  const contains = (r: { page: number; x: number; y: number; width: number; height: number }) =>
    r.page === page && x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height;
  const inverse = result.parser.inverseLookupDetailed(result.mapping, page, x, y, {
    acceptSource: (source) => result.files.has(projectName(source.file)),
  });
  if (!inverse || !inverse.container || !contains(inverse.container)) return null;
  const candidates = new Map<string, { file: string; line: number }>();
  const seen = new Set<string>();
  for (const node of result.mapping.pages.get(page) ?? []) {
    const file = projectName(result.mapping.inputs.get(node.input) ?? "");
    if (!result.files.has(file) || node.line < 1) continue;
    const key = `${file}:${node.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (seen.size > 3000) return null;
    const forward = result.parser.forwardLookupDetailed(result.mapping, file, node.line);
    // TeX often attributes an entire shipped page to \end{document}; such a
    // page-wide structural node is not evidence for an individual click.
    if (forward?.match === "exact" && forward.regions.length <= 6 && forward.regions.some(contains))
      candidates.set(key, { file, line: node.line });
  }
  const file = projectName(inverse.source.file);
  const key = `${file}:${inverse.source.line}`;
  return candidates.size === 1 ? (candidates.get(key) ?? null) : null;
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

/** The PoC supports literal project-relative references, not TeX path macros. */
export function validateLatexReferences(
  sources: ReadonlyMap<string, string>,
  files: ReadonlySet<string>,
  mainFile = "main.tex",
): void {
  const command =
    /\\(input|include|includegraphics|bibliography|addbibresource)\s*(?:\[[^\]]*\]\s*)?\{([^{}]*)\}/g;
  const pending = [mainFile];
  const visited = new Set<string>();
  while (pending.length) {
    const sourceName = pending.pop()!;
    if (visited.has(sourceName)) continue;
    visited.add(sourceName);
    const text = sources.get(sourceName);
    if (text === undefined) throw new Error(`Missing project source: ${sourceName}`);
    for (const line of text.split(/\r?\n/)) {
      const withoutComment = line.replace(/(^|[^\\])%.*/, "$1");
      for (const match of withoutComment.matchAll(command)) {
        const kind = match[1];
        const references = kind === "bibliography" ? match[2].split(",") : [match[2]];
        for (const raw of references) {
          const name = raw.trim().replace(/^\.\//, "");
          if (
            !name ||
            /[\\{}#$~:]/.test(name) ||
            name.startsWith("/") ||
            name.split("/").some((part) => !part || part === ".." || part === ".")
          ) {
            throw new Error(
              `Unsupported non-literal or unsafe \\${kind} reference in ${sourceName}: ${raw}`,
            );
          }
          const hasExtension = /\.[^/]+$/.test(name);
          const suffixes = hasExtension
            ? [""]
            : kind === "includegraphics"
              ? [".pdf", ".png", ".jpg", ".jpeg"]
              : kind === "bibliography" || kind === "addbibresource"
                ? [".bib"]
                : [".tex"];
          const resolved = suffixes.map((suffix) => name + suffix).find((path) => files.has(path));
          if (!resolved) {
            throw new Error(`Missing project file for \\${kind} in ${sourceName}: ${raw}`);
          }
          if ((kind === "input" || kind === "include") && sources.has(resolved))
            pending.push(resolved);
        }
      }
      const unmatched = withoutComment.replace(command, "");
      if (/\\(?:input|include|includegraphics|bibliography|addbibresource)\b/.test(unmatched))
        throw new Error(`Unsupported non-literal project reference in ${sourceName}.`);
    }
  }
}

/** Compile exactly this snapshot, with no engine auto-detection or remote source. */
export async function compileLatex(snapshot: LatexProjectSnapshot): Promise<LatexResult> {
  cancelLatex();
  const owner = generation;
  const [{ WasmTexCompiler }, { SynctexParser }] = await Promise.all([
    import("wasmtex/headless"),
    import("wasmtex/synctex"),
  ]);
  if (generation !== owner) throw new Error("Compilation cancelled.");
  const files: Record<string, string | Uint8Array> = {};
  for (const file of snapshot.files) {
    const bytes = binary(file.data);
    files[file.path] = /\.(?:tex|bib|sty|cls|bst)$/i.test(file.path)
      ? new TextDecoder("utf-8", { fatal: true }).decode(bytes)
      : bytes;
  }
  validateLatexReferences(
    new Map(
      Object.entries(files).filter(
        (entry): entry is [string, string] =>
          /\.tex$/i.test(entry[0]) && typeof entry[1] === "string",
      ),
    ),
    new Set(Object.keys(files)),
    snapshot.mainFile,
  );
  const original = files[snapshot.mainFile];
  if (typeof original !== "string") throw new Error("The main .tex file is missing.");
  // The pinned Lua engine does not set --synctex. Prefix on the same line, so
  // the original source and every SyncTeX line number remain unchanged.
  files[snapshot.mainFile] = original.startsWith("\uFEFF")
    ? `\uFEFF\\synctex=1\\relax ${original.slice(1)}`
    : `\\synctex=1\\relax ${original}`;
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
      throw new Error(hint + detail);
    }
    if (/LaTeX Warning: File .+ not found/i.test(result.log)) {
      throw new Error("A project image or input is missing.\n" + result.log.slice(-6000));
    }
    // The SDK's Lua result currently omits SyncTeX. Its pinned worker protocol
    // exposes the binary file; fail closed if a future SDK changes this shape.
    const job = snapshot.mainFile
      .split("/")
      .pop()!
      .replace(/\.tex$/i, "");
    const internal = compiler as unknown as {
      engine?: {
        tex?: {
          postMessageWithResponse(
            request: { cmd: string; url: string; encoding: string },
            response: string,
          ): Promise<{ data?: Uint8Array | ArrayBuffer }>;
        };
      };
    };
    const worker = internal.engine?.tex;
    if (!worker) throw new Error("This WasmTex build cannot read LuaLaTeX SyncTeX output.");
    const sync = await worker.postMessageWithResponse(
      { cmd: "readfile", url: `${job}.synctex.gz`, encoding: "binary" },
      "cmd:readfile",
    );
    if (!sync.data) throw new Error("LuaLaTeX did not produce SyncTeX output.");
    const parser = new SynctexParser();
    const mapping = await parser.parse(new Uint8Array(sync.data));
    return {
      pdf: result.pdf.slice(),
      parser,
      mapping,
      mainFile: snapshot.mainFile,
      files: new Set(snapshot.files.map((file) => file.path)),
      log: result.log,
    };
  } finally {
    compiler.dispose();
    if (active === compiler) active = null;
  }
}
