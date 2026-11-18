//! The reader's local TEXMF libraries as the TeXpresso frame sees them.
//!
//! The frame's engine has no search path: it asks its host for a name (with
//! extensions) and the host answers from the project, then from the TeX Live
//! bundle. MDraft sends library files under the reserved
//! `.mdraft-texmf/<root>/<TDS path>` and a manifest of which stored file answers
//! each name; the patched worker (texpresso-shell/worker.js) consults it after
//! the project and before TeX Live. That is the order kpathsea gives the job
//! folder, TEXMFHOME and TEXMFDIST.
//!
//! Pure: no DOM, no IPC, so `scripts/texpresso-unit.mjs` imports it directly.

import type * as api from "../api";
import { LIBRARY_PREFIX } from "../latex-texmf.ts";
import type { TexpressoEngine } from "./protocol.ts";

/** The manifest the frame's worker reads. */
export const LIBRARY_INDEX = `${LIBRARY_PREFIX}/index.json`;

/**
 * TeX Live's `TEXINPUTS.lualatex` and `TEXINPUTS.xelatex` directories, per
 * root: `$TEXMF/tex/{<format>,latex,<engine>,generic,}//`. The empty last
 * alternative is the rest of `tex/`, searched after these.
 */
const TEX_DIRS: Record<TexpressoEngine, readonly string[]> = {
  luatex: ["tex/lualatex/", "tex/latex/", "tex/luatex/", "tex/generic/"],
  xetex: ["tex/xelatex/", "tex/latex/", "tex/xetex/", "tex/generic/"],
};
/** `LUAINPUTS`, the same list the previous bundled engine's search hook uses. */
const LUA_DIRS = ["scripts/", "tex/luatex/", "tex/plain/", "tex/generic/", "tex/latex/"];
const LUA = /\.(?:lua|luc|texlua)$/i;

/** One library file answering a name. */
interface Candidate {
  root: number;
  rank: number;
  path: string;
  stored: string;
  origin: string;
}

/** Search rank within a root: lower is found first. */
function rank(path: string, engine: TexpressoEngine): number {
  const dirs = LUA.test(path) ? LUA_DIRS : TEX_DIRS[engine];
  const at = dirs.findIndex((dir) => path.startsWith(dir));
  if (at >= 0) return at;
  // The rest of tex/ (the empty alternative), then fonts and BibTeX, which
  // live in search paths of their own and never compete with tex/ names.
  return path.startsWith("tex/") ? dirs.length : dirs.length + 1;
}

/**
 * The names TeX may ask for: below `tex/` and `scripts/`, every trailing
 * part of the path, so `\usepackage{abntex}` and `\input{abntex/part}` both
 * resolve; fonts and BibTeX files by file name alone.
 */
function namesOf(path: string): string[] {
  const parts = path.split("/");
  if ((parts[0] === "tex" || parts[0] === "scripts") && parts.length > 2) {
    const names: string[] = [];
    for (let start = 1; start < parts.length; start += 1) names.push(parts.slice(start).join("/"));
    return names;
  }
  return parts.length > 1 ? [parts[parts.length - 1]] : [];
}

export interface LibraryIndex {
  /** Lookup name → stored path, highest priority first. */
  names: Array<[string, string]>;
  /** Lookup name → the reader's own file, for messages. */
  origins: Map<string, string>;
  /** Library files the project's own file of the same name replaces. */
  shadowed: Array<{ name: string; origin: string }>;
}

/**
 * Which stored library file answers each name for this engine. Roots are
 * searched in order; within a root, the engine's format directories in TeX
 * Live's order. A name the project itself holds is answered by the project, so
 * it is left out and reported. Two files of one root that answer the same name
 * in the same directory never get here: capture rejects that root as ambiguous.
 */
export function libraryIndex(
  snapshot: api.LatexTexmfSnapshot | undefined,
  engine: TexpressoEngine,
  projectPaths: ReadonlySet<string>,
): LibraryIndex {
  const best = new Map<string, Candidate>();
  for (const file of snapshot?.files ?? []) {
    const candidate: Candidate = {
      root: file.root,
      rank: rank(file.path, engine),
      path: file.path,
      stored: `${LIBRARY_PREFIX}/${file.root}/${file.path}`,
      origin: file.origin,
    };
    for (const name of namesOf(file.path)) {
      const held = best.get(name);
      if (!held || before(candidate, held)) best.set(name, candidate);
    }
  }
  const ordered = [...best.entries()].sort(([a, x], [b, y]) =>
    before(x, y) ? -1 : before(y, x) ? 1 : a < b ? -1 : a > b ? 1 : 0,
  );
  const index: LibraryIndex = { names: [], origins: new Map(), shadowed: [] };
  for (const [name, candidate] of ordered) {
    if (projectPaths.has(name)) {
      // Only a whole file name is worth telling: a project `abnt.cls` replacing
      // the library's, not every path suffix that happens to match too.
      if (!name.includes("/")) index.shadowed.push({ name, origin: candidate.origin });
      continue;
    }
    index.names.push([name, candidate.stored]);
    index.origins.set(name, candidate.origin);
  }
  return index;
}

function before(a: Candidate, b: Candidate): boolean {
  if (a.root !== b.root) return a.root < b.root;
  if (a.rank !== b.rank) return a.rank < b.rank;
  return a.path < b.path;
}
