//! Headless LuaLaTeX adapter. The SDK and SyncTeX parser load only on use.
import type { LatexProjectSnapshot } from "./api";
import {
  hasUnparsedReference,
  isLiteralReference,
  maskLiteralRegions,
  referencesIn,
} from "./latex-references.ts";
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
  if (!inverse) {
    console.info(`[latex-source] no inverse match for ${page} at ${Math.round(x)},${Math.round(y)}`);
    return null;
  }

  // **The container is optional, and requiring it broke click navigation.**
  //
  // The bracket search that fills `container` needs box nodes. A mapping produced
  // by the private worker fallback is a flat node list with no boxes, so
  // `container` is null there and every click returned null — measured on the
  // shipped LaTeX Reference: `method nearest-child`, no container, nothing painted.
  //
  // Without a container the click is answered by the candidate loop below, which
  // checks each node's *forward* regions against the click. That is the reliable
  // signal: a node's own region can be degenerate (a kern is 0pt wide), while its
  // forward lookup returns the typeset box the line actually occupies.
  const container = inverse.container;
  if (container && !contains(container)) {
    console.info(`[latex-source] click is outside the container (method ${inverse.method})`);
    return null;
  }
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

  // **Without a container, the inverse match is the answer.**
  //
  // The candidate loop exists to disambiguate: several source lines can share a
  // region, and the loop keeps only those whose *own* forward lookup lands on the
  // click. That needs non-degenerate box geometry, which a mapping from the private
  // worker fallback does not have — measured on the shipped reference: 510 nodes,
  // an inverse region of `0x8`, and zero candidates for a click the inverse match
  // had already resolved to `latex-reference.tex:30`.
  //
  // So the loop is the *confirmation* step for a box-rich mapping, and the inverse
  // match is the answer when there is no container to confirm against. It has
  // already done the geometric work: it found the node under the click and its
  // source. Refusing that answer is what made every click do nothing.
  if (!container) {
    if (candidates.size > 0 && !candidates.has(key)) {
      // The loop disagreed with the inverse match. With no container to arbitrate,
      // the loop's evidence is the weaker kind, so the inverse match still wins —
      // but the disagreement is worth reporting.
      console.info(
        `[latex-source] no container; ${candidates.size} candidate(s) disagree with ${key}`,
      );
    }
    return { file, line: inverse.source.line };
  }

  if (candidates.size !== 1) {
    console.info(
      `[latex-source] ${candidates.size} candidate(s) for ${key}` +
        ` (nodes: ${(result.mapping.pages.get(page) ?? []).length}` +
        `, inverse region: ${Math.round(inverse.region.width)}x${Math.round(inverse.region.height)}` +
        ` at ${Math.round(inverse.region.x)},${Math.round(inverse.region.y)})`,
    );
    return null;
  }
  return candidates.get(key) ?? null;
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
 * The PoC supports literal project-relative references, not TeX path macros.
 *
 * Literal regions — `\verb`, the verbatim-like environments, `\iffalse … \fi` —
 * are masked before the scan, so a document that *shows* `\input{…}` as an
 * example is not mistaken for one that calls it. That distinction is the whole
 * point: the shipped LaTeX Reference does exactly that, and rejecting it meant
 * Help › LaTeX Reference produced a document that could not compile.
 */
export function validateLatexReferences(
  sources: ReadonlyMap<string, string>,
  files: ReadonlySet<string>,
  mainFile = "main.tex",
): void {
  const pending = [mainFile];
  const visited = new Set<string>();
  while (pending.length) {
    const sourceName = pending.pop()!;
    if (visited.has(sourceName)) continue;
    visited.add(sourceName);
    const text = sources.get(sourceName);
    if (text === undefined) throw new Error(`Missing project source: ${sourceName}`);

    // Mask once per file, so the reference scan and the leftover check agree
    // about which regions are literal.
    const masked = maskLiteralRegions(text);

    for (const reference of referencesIn(masked, sourceName)) {
      const { kind, name } = reference;
      if (!isLiteralReference(name)) {
        throw new Error(
          `Unsupported non-literal or unsafe \\${kind} reference in ${sourceName}: ${name}`,
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
        throw new Error(`Missing project file for \\${kind} in ${sourceName}: ${name}`);
      }
      if ((kind === "input" || kind === "include") && sources.has(resolved)) {
        pending.push(resolved);
      }
    }

    if (hasUnparsedReference(masked)) {
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
    // SyncTeX, in the order decision D6 specifies: the **public** route first
    // (`synctexData ?? parse(synctex)`), then the private worker read as a
    // fallback.
    //
    // The fallback is not dead code. Measured against the pinned engine build on
    // 2026-11-07: a LuaLaTeX compile of `samples/latex-poc` succeeds and returns a
    // 42 KB PDF with `synctexData` absent and `synctex` null — the engine does not
    // emit SyncTeX for this build at all, despite the `\synctex=1\relax` prefix.
    // Removing the fallback in step 11 therefore turned a working feature into
    // "LuaLaTeX did not produce SyncTeX output for this document", which is what
    // the preview showed. D6 anticipated exactly this.
    const parser = new SynctexParser();
    let mapping =
      result.synctexData ?? (result.synctex ? await parser.parse(new Uint8Array(result.synctex)) : null);

    if (!mapping) {
      // The private route: the pinned worker protocol exposes the file the engine
      // wrote, which the public result does not always carry. It is a fallback, so
      // a failure here is not fatal — the caller gets the diagnostic below.
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
      if (worker) {
        try {
          const sync = await worker.postMessageWithResponse(
            { cmd: "readfile", url: `${job}.synctex.gz`, encoding: "binary" },
            "cmd:readfile",
          );
          if (sync.data) mapping = await parser.parse(new Uint8Array(sync.data));
        } catch {
          // The engine wrote no SyncTeX file either. Fall through to the
          // diagnostic, which names what was missing.
        }
      }
    }

    if (!mapping) {
      // Name what was actually missing. "Did not produce SyncTeX output" sent a
      // reader looking at their document when the cause can be the engine build,
      // the `\synctex=1` prefix, or a compile that never ran. The three facts that
      // distinguish those cases are cheap to report and expensive to guess.
      throw new Error(
        "LuaLaTeX did not produce SyncTeX output for this document.\n" +
          `synctexData: ${result.synctexData === undefined ? "absent" : String(result.synctexData)}\n` +
          `synctex: ${result.synctex ? `${result.synctex.length} bytes` : "null"}\n` +
          `pdf: ${result.pdf ? `${result.pdf.length} bytes` : "null"}`,
      );
    }
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
