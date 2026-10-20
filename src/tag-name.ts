//! Which tag a typed `>` would close — the pure part of the tag closer.
//!
//! Kept apart from the editor extension so the edge cases can be tested without
//! a DOM or a CodeMirror view. The rules are deliberately conservative: a false
//! positive inserts a closing tag into prose, a false negative costs one typing
//! motion, so every ambiguous shape is left alone.

/**
 * Elements that never take a closing tag.
 *
 * Exported because the paste source rule (`src/paste/detect.ts`) needs the same
 * list to tell markup from prose; the two must not drift.
 */
export const VOID_ELEMENTS = new Set(
  "area base br col embed hr img input keygen link meta param source track wbr".split(" "),
);

/**
 * An opening tag that ends exactly at the caret, with an optional attribute
 * run. The `<` has to be followed by a letter, so `<!`, `<?` and `<3` never
 * match; the attribute run may not contain `<` or `>`.
 */
const OPEN_TAG = /<([A-Za-z][A-Za-z0-9:-]*)((?:\s[^<>]*)?)$/;

/**
 * The tag name a `>` typed after `before` should close, or null.
 *
 * `before` is the text of the current line up to the caret, without the `>`
 * being typed.
 */
export function tagToClose(before: string): string | null {
  const match = OPEN_TAG.exec(before);
  if (!match) return null;
  const start = match.index ?? 0;
  // `\<p>` is an escape in Markdown, not a tag.
  if (start > 0 && before[start - 1] === "\\") return null;
  const name = match[1];
  const rest = match[2] ?? "";
  // `<br />` and `<img/>` close themselves.
  if (rest.trimEnd().endsWith("/")) return null;
  if (VOID_ELEMENTS.has(name.toLowerCase())) return null;
  return name;
}
