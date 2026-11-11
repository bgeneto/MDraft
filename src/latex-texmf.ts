//! Local TEXMF libraries on the frontend: pure preparation, no I/O.
//!
//! Rust captures the enabled library folders into a separate, content-addressed
//! snapshot. This module turns it into what each consumer needs without ever
//! mixing it into the project: the bundled engine's namespaced MEMFS files and
//! manifest, the narrow bibliography handoff, the names the reference check may
//! treat as resolvable, completion names, and a readable origin for a
//! diagnostic that points into a library.

import type { LatexTexmfSnapshot } from "./api";

/** The reserved project prefix the bundled engine's search paths read. */
export const LIBRARY_PREFIX = ".mdraft-texmf";

/** Whether a project path collides with the reserved library namespace. */
export function reservedProjectPath(path: string): boolean {
  const normal = path.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
  return normal === LIBRARY_PREFIX || normal.startsWith(`${LIBRARY_PREFIX}/`);
}

function bytesOf(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/**
 * The names a `\bibliographystyle`/`\bibliography` in the project requests,
 * from literal arguments only (a computed name is outside the static handoff).
 */
export function requestedBibliography(sources: Iterable<string>): {
  styles: string[];
  databases: string[];
} {
  const styles = new Set<string>();
  const databases = new Set<string>();
  for (const text of sources) {
    const code = text
      .split(/\r?\n/)
      .map((line) => line.replace(/(^|[^\\])%.*$/, "$1"))
      .join("\n");
    for (const match of code.matchAll(/\\bibliographystyle\s*\{([^{}\\]+)\}/g)) {
      const name = match[1].trim();
      if (name) styles.add(name);
    }
    for (const match of code.matchAll(/\\bibliography\s*\{([^{}\\]+)\}/g)) {
      for (const part of match[1].split(",")) {
        const name = part.trim();
        if (name) databases.add(name);
      }
    }
  }
  return { styles: [...styles], databases: [...databases] };
}

/**
 * The bundled engine's library inputs: every captured runtime file under
 * `.mdraft-texmf/<root>/<TDS path>` plus the versioned manifest the worker's
 * search-path hook reads, and the bibliography handoff.
 *
 * The SDK forwards project `.bib` files and a root-level `<style>.bst` to its
 * separate BibTeX worker, so a requested library style or database is handed
 * over under its requested root name — only when the project has no file of
 * that name, so a project copy always wins. Everything else stays namespaced.
 */
export function bundledLibraryFiles(
  snapshot: LatexTexmfSnapshot | undefined,
  projectFiles: ReadonlySet<string>,
  sources: Iterable<string>,
): { files: Record<string, string | Uint8Array>; handedOff: string[] } {
  const files: Record<string, string | Uint8Array> = {};
  const handedOff: string[] = [];
  if (!snapshot || snapshot.roots.length === 0) return { files, handedOff };
  for (const file of snapshot.files) {
    if (file.path.startsWith("bibtex/")) continue;
    files[`${LIBRARY_PREFIX}/${file.root}/${file.path}`] = bytesOf(file.data);
  }
  files[`${LIBRARY_PREFIX}/manifest.json`] = JSON.stringify({
    version: 1,
    roots: snapshot.roots.length,
  });
  // A library class often sets the style itself (a thesis class choosing its
  // house .bst), so its own text is scanned too.
  const libraryText = snapshot.files
    .filter((file) => /\.(?:cls|sty)$/i.test(file.path))
    .map((file) => new TextDecoder("utf-8", { fatal: false }).decode(bytesOf(file.data)));
  const { styles, databases } = requestedBibliography([...sources, ...libraryText]);
  const handoff = (name: string, extension: "bst" | "bib"): void => {
    const target = name.endsWith(`.${extension}`) ? name : `${name}.${extension}`;
    if (target.includes("/") || projectFiles.has(target)) return;
    const directory = `bibtex/${extension}/`;
    // Roots are captured in search order, so the first match is the one TeX
    // would have found.
    const match = snapshot.files.find(
      (file) => file.path.startsWith(directory) && basename(file.path) === target,
    );
    if (!match) return;
    files[target] = new TextDecoder("utf-8", { fatal: false }).decode(bytesOf(match.data));
    handedOff.push(target);
  };
  for (const style of styles) handoff(style, "bst");
  for (const database of databases) handoff(database, "bib");
  return { files, handedOff };
}

/**
 * Names the engine can resolve from the libraries, for the reference check:
 * every TeX-searchable file's basename and its path below `tex/<format>/`, so
 * `\input{part}` and `\input{mypkg/part}` are both recognised.
 */
export function libraryLookupNames(snapshot: LatexTexmfSnapshot | undefined): Set<string> {
  const names = new Set<string>();
  for (const file of snapshot?.files ?? []) {
    const parts = file.path.split("/");
    if (parts[0] === "tex" && parts.length > 2) {
      for (let start = 2; start < parts.length; start += 1) names.add(parts.slice(start).join("/"));
    } else if (parts[0] === "bibtex") {
      names.add(basename(file.path));
    }
  }
  return names;
}

/** Local class and package names, deduplicated by lookup priority. */
export function libraryNames(snapshot: LatexTexmfSnapshot | undefined): {
  classes: Array<{ name: string; origin: string }>;
  packages: Array<{ name: string; origin: string }>;
} {
  const classes = new Map<string, string>();
  const packages = new Map<string, string>();
  for (const file of snapshot?.files ?? []) {
    if (!file.path.startsWith("tex/")) continue;
    const name = basename(file.path);
    const origin = snapshot!.roots[file.root]?.label ?? "";
    const cls = /^(.+)\.cls$/.exec(name);
    const sty = /^(.+)\.sty$/.exec(name);
    if (cls && !classes.has(cls[1])) classes.set(cls[1], origin);
    if (sty && !packages.has(sty[1])) packages.set(sty[1], origin);
  }
  const list = (map: Map<string, string>) =>
    [...map]
      .map(([name, origin]) => ({ name, origin }))
      .sort((a, b) => a.name.localeCompare(b.name));
  return { classes: list(classes), packages: list(packages) };
}

/**
 * The reader's own file behind a path an engine reported inside a staged or
 * namespaced library, or `null` for a project path.
 */
export function libraryOrigin(
  snapshot: LatexTexmfSnapshot | undefined,
  reported: string,
): string | null {
  if (!snapshot) return null;
  const normal = reported.replace(/\\/g, "/");
  const match = /(?:^|\/)(?:\.\.\/texmf|\.mdraft-texmf)\/(\d+)\/(.+)$/.exec(normal);
  if (!match) return null;
  const root = Number(match[1]);
  const file = snapshot.files.find((entry) => entry.root === root && entry.path === match[2]);
  return file?.origin ?? null;
}
