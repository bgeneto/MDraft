//! The `<Family>.fontspec` files MDraft adds to a XeLaTeX preview project.
//!
//! The preview's XeTeX is built without fontconfig, so it has no index from a
//! family name to font files: `\setmainfont{Latin Modern Roman}` fails with
//! fontspec's "cannot be found" and the document is set in `nullfont`, while
//! the same name works under LuaLaTeX through the luaotfload names database
//! the preview ships. Before fontspec looks a name up it inputs
//! `<name without spaces>.fontspec` when one exists
//! (`\__fontspec_load_external_fontoptions:N`); TeX Live ships 170 such files.
//! For each TeX Live family a project names, this module writes one that
//! points every style at its file, the way luaotfload resolves the name.
//!
//! The table comes from `font-families.json`, generated from the pinned TeX
//! Live snapshot by `scripts/texpresso-font-families.mjs`. Each style maps to
//! its 10 pt design, so an optical-size family such as Latin Modern uses the
//! 10 pt design at every size in the preview. The reader's folder is never
//! written: these files exist only in the frame's copy, like `luaotfload.conf`.

/** The generated table (`font-families.json`). */
export interface FontFamilies {
  /** TeX Live's own `<Name>.fontspec` files, by name: those win. */
  shipped: readonly string[];
  /** luaotfload's family key → regular, bold, italic and bold italic files. */
  families: Readonly<Record<string, readonly (string | null)[]>>;
}

/** How each command takes its arguments before the font name. */
type Shape = "plain" | "control" | "babel" | "family";

const SHAPES: Record<string, Shape> = {
  setmainfont: "plain",
  setsansfont: "plain",
  setmonofont: "plain",
  setromanfont: "plain",
  setmathfont: "plain",
  fontspec: "plain",
  setCJKmainfont: "plain",
  setCJKsansfont: "plain",
  setCJKmonofont: "plain",
  newfontfamily: "control",
  renewfontfamily: "control",
  setfontfamily: "control",
  providefontfamily: "control",
  newfontface: "control",
  renewfontface: "control",
  setfontface: "control",
  providefontface: "control",
  babelfont: "babel",
  setCJKfamilyfont: "family",
};

/** A command name ends at a letter, `@`, or one of expl3's `_` and `:`. */
const COMMAND = new RegExp(`\\\\(${Object.keys(SHAPES).join("|")})(?![A-Za-z@_:])`, "g");

/** A family name as fontspec would look it up: no macros, groups, paths or extensions. */
const PLAIN_NAME = /^[A-Za-z0-9][A-Za-z0-9 _+-]*$/;

/** fontspec loads by file name when either key is given. */
const FILE_OPTIONS = /(?:^|[\s,{])(?:Path|Extension)\s*=/i;

const STYLE_KEYS = ["UprightFont", "BoldFont", "ItalicFont", "BoldItalicFont"];

/** TeX's comments end a line; `\%` is a percent sign. */
const stripComments = (text: string): string => text.replace(/(^|[^\\])%.*$/gm, "$1");

/** luaotfload's `sanitize_fontname`: lower case, letters and digits only. */
const familyKey = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * The balanced `{…}` or `[…]` group at `at` after spaces, as [content, end],
 * or null. A bracket group may hold braces (`BoldFont={*-Bold}`).
 */
function group(text: string, at: number, open: "{" | "["): [string, number] | null {
  while (at < text.length && /\s/.test(text[at])) at += 1;
  if (text[at] !== open) return null;
  const close = open === "{" ? "}" : "]";
  let braces = 0;
  for (let i = at + 1; i < text.length; i += 1) {
    const char = text[i];
    if (char === "\\") {
      i += 1;
      continue;
    }
    if (char === "{") braces += 1;
    else if (char === "}") {
      if (braces === 0) {
        if (open === "{") return [text.slice(at + 1, i), i + 1];
        return null;
      }
      braces -= 1;
    } else if (char === close && braces === 0) return [text.slice(at + 1, i), i + 1];
  }
  return null;
}

/** A control sequence, bare or braced (`\newfontfamily{\foo}`), as its end. */
function controlSequence(text: string, at: number): number | null {
  const braced = group(text, at, "{");
  if (braced) return /^\s*\\[A-Za-z@]+\s*$/.test(braced[0]) ? braced[1] : null;
  const bare = /^\s*\\[A-Za-z@]+/.exec(text.slice(at, at + 200));
  return bare ? at + bare[0].length : null;
}

/** The font names a TeX source gives fontspec, with their options. */
function namedFonts(source: string): { name: string; options: string }[] {
  const text = stripComments(source);
  const found: { name: string; options: string }[] = [];
  for (const match of text.matchAll(COMMAND)) {
    let at = match.index + match[0].length;
    const shape = SHAPES[match[1]];
    if (shape === "control") {
      const end = controlSequence(text, at);
      if (end === null) continue;
      at = end;
    } else if (shape === "babel") {
      const language = group(text, at, "[");
      if (language) at = language[1];
      const family = group(text, at, "{");
      if (!family) continue;
      at = family[1];
    } else if (shape === "family") {
      const family = group(text, at, "{");
      if (!family) continue;
      at = family[1];
    }
    const before = group(text, at, "[");
    if (before) at = before[1];
    const name = group(text, at, "{");
    if (!name) continue;
    const after = group(text, name[1], "[");
    found.push({
      name: name[0].trim().replace(/\s+/g, " "),
      options: `${before?.[0] ?? ""},${after?.[0] ?? ""}`,
    });
  }
  return found;
}

/**
 * The `.fontspec` text that points each style of `name` at its file.
 *
 * `Font` is for a name fontspec loads as one face rather than as a family:
 * unicode-math sets its script sizes with `SizeFeatures = {…, Font = <name>}`,
 * and for such a name fontspec reads only `Font` from these options. Without it
 * `\setmathfont{TeX Gyre Pagella Math}` still failed. As a family option the
 * key does nothing.
 */
function fontspecText(name: string, files: readonly (string | null)[]): string {
  const extension = /\.[^.]+$/.exec(files[0] ?? "")?.[0] ?? "";
  const base = (file: string): string => file.slice(0, -extension.length);
  const lines = [`Extension = ${extension}`, `Font = ${base(files[0] ?? "")}`];
  files.forEach((file, i) => {
    if (file) lines.push(`${STYLE_KEYS[i]} = ${base(file)}`);
  });
  return (
    "% Added by MDraft to the XeLaTeX preview only, which has no system font\n" +
    "% index: the TeX Live files for this family, as LuaLaTeX finds them.\n" +
    `\\defaultfontfeatures[${name}]\n  {${lines.join(",\n   ")}}\n`
  );
}

/**
 * The `<Family>.fontspec` files to add, by file name, for the TeX Live
 * families `sources` name. A name given as a file, a name not in TeX Live, a
 * name TeX Live has its own file for, and a name the project already has a
 * file for are left alone.
 */
export function fontspecFiles(
  sources: Iterable<string>,
  projectPaths: Iterable<string>,
  table: FontFamilies,
): Map<string, string> {
  const shipped = new Set(table.shipped);
  // TeX looks for the file in the job's directory, the project root.
  const taken = new Set<string>();
  for (const path of projectPaths) if (!path.includes("/")) taken.add(path.toLowerCase());
  const added = new Map<string, string>();
  for (const source of sources) {
    for (const { name, options } of namedFonts(source)) {
      if (!PLAIN_NAME.test(name) || FILE_OPTIONS.test(options)) continue;
      const key = familyKey(name);
      const files = Object.prototype.hasOwnProperty.call(table.families, key)
        ? table.families[key]
        : undefined;
      if (!files?.[0]) continue;
      const base = name.replace(/ /g, "");
      const file = `${base}.fontspec`;
      if (shipped.has(base) || taken.has(file.toLowerCase()) || added.has(file)) continue;
      added.set(file, fontspecText(name, files));
    }
  }
  return added;
}
