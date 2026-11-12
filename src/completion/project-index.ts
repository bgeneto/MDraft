//! The project references the LaTeX popup offers: labels, citation keys and
//! image files.
//!
//! Pure functions over the text of the open project, so the whole index is a unit
//! test with no editor and no filesystem. The caller supplies the sources it
//! already has — the active buffer plus whatever the project snapshot read — and
//! this module answers three questions: which `\label{}` keys exist, which
//! `\cite{}` keys the document uses, and which image paths it names.
//!
//! **It never reads a file and never compiles.** The plan's rule is that
//! completion must not trigger a compile or a disk read of its own; the sources
//! arrive from the snapshot the preview already built.

/** What the popup can offer for a reference context. */
export interface ProjectReferences {
  /** `\label{…}` keys, in document order, without duplicates. */
  labels: readonly string[];
  /** `\cite{…}` keys, in document order, without duplicates. */
  citations: readonly string[];
  /** Image paths named by `\includegraphics`, without duplicates. */
  images: readonly string[];
}

const EMPTY: ProjectReferences = { labels: [], citations: [], images: [] };

/** Strip a `%` comment from one line, respecting an escaped `\%`. */
function stripComment(line: string): string {
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] !== "%") continue;
    let slashes = 0;
    for (let back = index - 1; back >= 0 && line[back] === "\\"; back -= 1) slashes += 1;
    if (slashes % 2 === 0) return line.slice(0, index);
  }
  return line;
}

/**
 * Every match of `pattern` across the sources, in insertion order.
 *
 * The sources are a `Map`, whose iteration order is the order the caller added
 * them: the active buffer first, then the project's files. That is the order a
 * reader expects to see their own labels in.
 */
function collect(
  sources: ReadonlyMap<string, string>,
  pattern: RegExp,
  transform: (raw: string) => string[],
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const text of sources.values()) {
    for (const line of text.split(/\r?\n/)) {
      const code = stripComment(line);
      for (const match of code.matchAll(pattern)) {
        for (const raw of transform(match[1])) {
          const value = raw.trim();
          if (!value || seen.has(value)) continue;
          seen.add(value);
          out.push(value);
        }
      }
    }
  }
  return out;
}

/**
 * The references a project declares.
 *
 * `\label` and `\cite` take a single key; `\cite` also accepts a comma-separated
 * list, which is the form `\cite{knuth84,lamport94}` uses. `\includegraphics`
 * takes a path, optionally after an options group.
 */
export function projectReferences(sources: ReadonlyMap<string, string>): ProjectReferences {
  if (sources.size === 0) return EMPTY;

  const labels = collect(sources, /\\label\s*\{([^{}]*)\}/g, (raw) => [raw]);
  const citations = collect(
    sources,
    /\\[cC]ite[a-zA-Z]*\*?\s*(?:\[[^\]]*\]\s*){0,2}\{([^{}]*)\}/g,
    (raw) => raw.split(","),
  );
  const images = collect(
    sources,
    /\\includegraphics\*?\s*(?:\[[^\]]*\]\s*)?\{([^{}]*)\}/g,
    (raw) => [raw],
  );

  return { labels, citations, images };
}

/**
 * The keys a `.bib` file defines.
 *
 * A citation key that no `.bib` defines is a compile error, but offering only
 * defined keys would be worse than offering none: a reader writing the citation
 * before the bibliography is a normal way to work. The two lists are therefore
 * kept separate and the caller decides — the popup offers the document's own
 * `\cite` keys first, because those are the ones that already compile.
 */
export function bibliographyKeys(bibSources: ReadonlyMap<string, string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const text of bibSources.values()) {
    for (const match of text.matchAll(/@[a-zA-Z]+\s*\{\s*([^,\s}]+)\s*,/g)) {
      const key = match[1].trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(key);
    }
  }
  return out;
}
