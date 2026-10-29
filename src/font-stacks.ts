//! CSS `font-family` stack helpers.
//!
//! The set of installed families is arbitrary, so a family name can contain
//! spaces, commas, quotes or characters that are not a CSS identifier. The
//! picker stores a complete stack, and these are the only functions that build
//! or read one. Keeping them pure makes the quoting rules testable without an
//! application; a stray quote in a family name would otherwise silently break
//! the declaration and fall back to the browser's default face.

/**
 * CSS generic family keywords, which must stay unquoted.
 *
 * An installed font could technically be called `serif`, but quoting it would
 * turn the keyword into a family name that no browser resolves. The Rust
 * enumeration drops these names for the same reason.
 */
const GENERIC_FAMILIES = new Set([
  "serif",
  "sans-serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
  "ui-serif",
  "ui-sans-serif",
  "ui-monospace",
  "ui-rounded",
  "emoji",
  "math",
  "fangsong",
]);

/** True for a CSS generic family keyword, which must stay unquoted. */
export function isGenericFamily(family: string): boolean {
  return GENERIC_FAMILIES.has(family.trim().toLowerCase());
}

/** A bare name CSS accepts without quotes; anything else is quoted. */
const CSS_IDENTIFIER = /^-?[A-Za-z_][A-Za-z0-9_-]*$/;

/**
 * Split a stack into family names, honouring quotes and escapes.
 *
 * The old implementation split on every comma, which breaks the first family
 * of `"Foo, Bar", serif`. A stack is a comma-separated list where a quoted
 * family may contain the separator, so this is the small parser the picker and
 * the preset comparison both use.
 */
export function parseFamilies(stack: string): string[] {
  const families: string[] = [];
  let value = "";
  let quote: '"' | "'" | null = null;
  let escaped = false;

  const flush = (): void => {
    const family = value.trim();
    if (family) families.push(family);
    value = "";
  };

  for (const character of stack) {
    if (escaped) {
      value += character;
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
      else value += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === ",") {
      flush();
      continue;
    }
    value += character;
  }
  flush();
  return families;
}

/** The first family named in a stack, without its quotes. */
export function firstFamily(stack: string): string {
  return parseFamilies(stack)[0] ?? "";
}

/**
 * One family as a CSS `font-family` item.
 *
 * Generic keywords stay bare; a simple identifier stays bare for readability;
 * everything else is double-quoted, with `"` and `\` escaped. The result is
 * only ever assigned to a CSS custom property, never interpolated into HTML.
 */
export function cssFamily(family: string): string {
  const name = family.trim();
  if (!name) return "";
  if (GENERIC_FAMILIES.has(name.toLowerCase())) return name;
  if (CSS_IDENTIFIER.test(name)) return name;
  return `"${name.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Put `family` at the front of the fallback chain `base` already carries.
 *
 * `base` is the preset's built-in stack for the role (or the role's application
 * fallback under System/Custom), not the previous choice's stack: editing one
 * face should not accumulate the tails of every earlier edit. The chosen
 * family is removed from the tail so selecting `Georgia` in a stack that
 * already ends in `Georgia` does not produce it twice.
 *
 * An empty family means "use the base as it stands", which is how the System
 * default entry is represented.
 */
export function stackWith(family: string, base: string): string {
  const chosen = family.trim();
  if (!chosen) return base;

  const key = chosen.toLowerCase();
  const tail = parseFamilies(base)
    .slice(1)
    .filter((name) => name.toLowerCase() !== key)
    .map(cssFamily);
  return [cssFamily(chosen), ...tail].join(", ");
}
