//! Text identity after the document's own scripts rewrote it.
//!
//! The host names a text node by its stamp and its position among the stamp's
//! text nodes as parse5 saw them. A math renderer (MathJax, KaTeX auto-render)
//! splits a text node around each formula and replaces the formula with an
//! element; a code highlighter splits the text into token spans. Every later
//! position shifts, so a word that is still on screen, unchanged, loses its
//! identity.
//!
//! This aligns the stamp's current text nodes with the host's original texts so
//! the guest can keep speaking in original coordinates. It is spliced into
//! `html-bridge.js` (the `export` keyword is removed there) and loaded directly
//! by the unit test. It never invents a position: a node whose text cannot be
//! placed without a guess stays unmapped.

/** How many original texts a match may skip ahead. */
const ALIGN_WINDOW = 64;

/**
 * Align observed text nodes with the stamp's original texts.
 *
 * `original[i]` is the decoded text of the stamp's i-th original text node and
 * `parents[i]` the ordinal of its parent element (-1 for the stamp itself).
 * Each observed entry is `{ text, parent, element, last }`: the node's current
 * text, its parent's ordinal counted the same way, whether an element was
 * passed since the previous observed node, and whether no later observed node
 * with visible text shares its parent.
 *
 * Returns, per observed node, `{ index, base }` — its text is
 * `original[index].slice(base, base + text.length)` — or `null`.
 *
 * A match continues where the previous one ended, skipping only whitespace,
 * or skips original text that something replaced. The second kind needs an
 * element passed since the last match and the original parent: renderers keep
 * the remaining pieces in the parent they split, and this is what stops a cell
 * after a formula cell from being placed inside that formula's source.
 */
export function alignTextRuns(original, parents, observed) {
  const result = [];
  if (original.length === observed.length) {
    let same = true;
    for (let i = 0; i < original.length && same; i += 1) same = observed[i].text === original[i];
    if (same) {
      for (let i = 0; i < original.length; i += 1) result.push({ index: i, base: 0 });
      return result;
    }
  }
  let at = 0;
  let offset = 0;
  let element = false;
  for (let j = 0; j < observed.length; j += 1) {
    const item = observed[j];
    if (item.element) element = true;
    const text = item.text;
    if (!/\S/.test(text)) {
      result.push(null);
      continue;
    }
    let found = null;
    for (let k = at; k < original.length && k <= at + ALIGN_WINDOW; k += 1) {
      const source = original[k];
      let pos = source.indexOf(text, k === at ? offset : 0);
      if (pos < 0) continue;
      if (blankBetween(original, at, offset, k, pos)) {
        found = { index: k, base: pos };
        break;
      }
      // Skipped visible text with nothing inserted in its place is an edit,
      // not a renderer; no later candidate can do better.
      if (!element) break;
      if (parents[k] !== item.parent) continue;
      // The last piece of a split node ends where the original text ended; the
      // first occurrence could be inside the formula that was replaced.
      const suffix = source.length - text.length;
      if (item.last && suffix > pos && source.endsWith(text)) pos = suffix;
      found = { index: k, base: pos };
      break;
    }
    if (found) {
      at = found.index;
      offset = found.base + text.length;
      element = false;
    }
    result.push(found);
  }
  return result;
}

/** True when only whitespace lies between the cursor and a candidate. */
function blankBetween(original, at, offset, index, base) {
  for (let i = at; i <= index; i += 1) {
    const from = i === at ? offset : 0;
    const to = i === index ? base : original[i].length;
    if (to > from && /\S/.test(original[i].slice(from, to))) return false;
  }
  return true;
}
