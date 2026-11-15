//! Fuzzy matching of workspace paths for the Explorer's filter.
//!
//! Pure and DOM-free, so `scripts/fuzzy-unit.mjs` loads it under Node directly.
//! A query matches a path when its characters appear in order (a subsequence).
//! Among the possible alignments the best-scoring one is kept, in the family of
//! fzf and VS Code's quick open: characters at a word start, in a run, or inside
//! the file name score more than scattered ones in the folder part, so `amb`
//! ranks `config/ambientes.tex` above `figs/a-map-b.png`.
//!
//! Matching ignores case and accents (`acao` finds `ação.svg`), and positions
//! are reported in the original string so the caller can highlight them.

/** A path folded once for repeated matching. */
export interface Prepared {
  text: string;
  /** Lower-case, accent-free form of `text`. */
  folded: string;
  /** `map[i]` is the index in `text` of `folded[i]`. */
  map: number[];
  /** Index in `folded` where the last segment (the name) starts. */
  base: number;
}

export interface Match {
  score: number;
  /** Indices into the original text, ascending, without duplicates. */
  positions: number[];
}

const COMBINING = /[̀-ͯ]/g;

/** Fold one string: NFD, drop combining marks, lower-case, `\` → `/`. */
export function prepare(text: string): Prepared {
  let folded = "";
  const map: number[] = [];
  let index = 0;
  for (const char of text) {
    const out = (char === "\\" ? "/" : char).normalize("NFD").replace(COMBINING, "").toLowerCase();
    for (const unit of out) {
      folded += unit;
      map.push(index);
    }
    index += char.length;
  }
  return { text, folded, map, base: folded.lastIndexOf("/") + 1 };
}

/** Split a query into folded, non-empty terms; every term must match. */
export function prepareQuery(query: string): string[] {
  return query
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((term) => prepare(term).folded);
}

const MATCH = 16;
const BOUNDARY = 10;
const HUMP = 7;
const CONSECUTIVE = 12;
const IN_NAME = 6;
const GAP_START = 3;
const GAP_EXTEND = 1;

function bonusAt(prepared: Prepared, j: number): number {
  if (j === 0) return BOUNDARY;
  const before = prepared.folded[j - 1];
  if (before === "/") return BOUNDARY;
  if (before === "-" || before === "_" || before === "." || before === " ") return BOUNDARY - 2;
  // A camelCase hump: compare the original characters, since folding lowers them.
  const original = prepared.text[prepared.map[j]];
  const previous = prepared.text[prepared.map[j - 1]];
  if (
    original !== undefined &&
    previous !== undefined &&
    original !== original.toLowerCase() &&
    previous === previous.toLowerCase()
  )
    return HUMP;
  if (/\d/.test(prepared.folded[j]) && !/\d/.test(before)) return HUMP;
  return 0;
}

/** Cheap rejection before the scoring pass. */
function isSubsequence(term: string, folded: string): boolean {
  let at = 0;
  for (const char of term) {
    at = folded.indexOf(char, at);
    if (at < 0) return false;
    at += 1;
  }
  return true;
}

/**
 * Best alignment of one term in a prepared path.
 *
 * Dynamic programming over (term index, path index): `score[i][j]` is the best
 * score with term[i] matched at path[j]. Gaps cost a little, runs and word
 * starts earn a lot, and characters in the file name earn a bonus.
 */
function matchTerm(term: string, prepared: Prepared): Match | null {
  const text = prepared.folded;
  const n = text.length;
  const m = term.length;
  if (m === 0) return { score: 0, positions: [] };
  if (m > n || !isSubsequence(term, text)) return null;
  const NONE = -Infinity;
  // back[i * n + j]: the path index term[i - 1] was matched at, for term[i] at j.
  const back = new Int32Array(m * n).fill(-1);
  let previous = new Float64Array(n).fill(NONE);
  for (let j = 0; j < n; j += 1) {
    if (text[j] === term[0]) {
      const lead = j === 0 ? 0 : GAP_START + GAP_EXTEND * Math.min(j - 1, 8);
      previous[j] =
        MATCH + bonusAt(prepared, j) * 2 + (j >= prepared.base ? IN_NAME : 0) - lead * 0.25;
    }
  }
  for (let i = 1; i < m; i += 1) {
    const current = new Float64Array(n).fill(NONE);
    // The best predecessor seen so far at a distance > 1, with its gap cost
    // folded in lazily: score - GAP_EXTEND * (j - k).
    let bestFar = NONE;
    let bestFarAt = -1;
    for (let j = i; j < n; j += 1) {
      // Candidate predecessor k = j - 2 joins the "far" pool.
      const k = j - 2;
      if (k >= 0 && previous[k] !== NONE) {
        const value = previous[k] - GAP_START + GAP_EXTEND * k;
        if (value > bestFar) {
          bestFar = value;
          bestFarAt = k;
        }
      }
      if (text[j] !== term[i]) continue;
      const gain = MATCH + bonusAt(prepared, j) + (j >= prepared.base ? IN_NAME : 0);
      let best = NONE;
      let from = -1;
      if (previous[j - 1] !== NONE) {
        best = previous[j - 1] + gain + CONSECUTIVE;
        from = j - 1;
      }
      if (bestFar !== NONE) {
        const far = bestFar - GAP_EXTEND * (j - 1) + gain;
        if (far > best) {
          best = far;
          from = bestFarAt;
        }
      }
      if (from >= 0) {
        current[j] = best;
        back[i * n + j] = from;
      }
    }
    previous = current;
  }
  let end = -1;
  let score = NONE;
  for (let j = 0; j < n; j += 1) {
    if (previous[j] > score) {
      score = previous[j];
      end = j;
    }
  }
  if (end < 0) return null;
  const folded: number[] = [end];
  for (let i = m - 1, j = end; i > 0; i -= 1) {
    j = back[i * n + j];
    folded.push(j);
  }
  folded.reverse();
  return { score, positions: folded.map((j) => prepared.map[j]) };
}

/** Match every term of a query against one path, or null when any term misses. */
export function match(terms: string[], prepared: Prepared): Match | null {
  let score = 0;
  const positions = new Set<number>();
  for (const term of terms) {
    const found = matchTerm(term, prepared);
    if (!found) return null;
    score += found.score;
    for (const p of found.positions) positions.add(p);
  }
  // Prefer shorter, shallower paths when the alignment scores tie.
  score -= prepared.folded.length * 0.05;
  return { score, positions: [...positions].sort((a, b) => a - b) };
}

export interface Ranked<T> extends Match {
  item: T;
}

/**
 * Rank `items` against `query`, best first. Ties keep the input order, which
 * for the workspace index is breadth-first natural order.
 */
export function rank<T>(items: T[], prepared: (item: T) => Prepared, query: string): Ranked<T>[] {
  const terms = prepareQuery(query);
  if (terms.length === 0) return [];
  const out: Array<Ranked<T> & { order: number }> = [];
  items.forEach((item, order) => {
    const found = match(terms, prepared(item));
    if (found) out.push({ item, order, ...found });
  });
  out.sort((a, b) => b.score - a.score || a.order - b.order);
  return out;
}
