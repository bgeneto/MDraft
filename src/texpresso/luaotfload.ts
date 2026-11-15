//! The luaotfload configuration MDraft adds to a LuaLaTeX preview project.
//!
//! When luaotfload cannot find a font, by file or by name, it rebuilds its
//! names database: `reload_db` in `luaotfload-database.lua` opens every font
//! under the TEXMF trees. In the preview each of those opens is a bundle
//! download, so one missing font (`\setmainfont{Arial}`, a typo, a font the
//! preview never received) cost about 3,300 downloads and 1 GB, and every
//! compile started the scan again because the font was still missing.
//!
//! `update-live = false` makes `update_names` return the database it has. The
//! preview ships a prebuilt one (`luatexCache` in the shell's `config.js`), so
//! a family name that is in TeX Live still resolves; a font that is not fails
//! at once with fontspec's "cannot be found". luaotfload looks for
//! `./luaotfload.conf` before its kpse lookups, and the frame's project root is
//! the job's current directory.

import type { TexpressoEngine } from "./protocol.ts";

export const LUAOTFLOAD_CONFIG = "luaotfload.conf";

/** The names luaotfload reads before its kpse lookups (`config_paths`). */
const READER_CONFIGS = new Set([LUAOTFLOAD_CONFIG, "luaotfloadrc"]);

export const LUAOTFLOAD_CONFIG_TEXT =
  "; Added by MDraft to the LuaLaTeX preview only: a missing font fails at once\n" +
  "; instead of rebuilding the font index from every TeX Live font.\n" +
  "[db]\n" +
  "update-live = false\n";

/**
 * The configuration file to add for `engine`, or null: XeTeX does not read
 * it, and a project with its own configuration keeps it.
 */
export function luaotfloadConfig(
  engine: TexpressoEngine,
  projectPaths: Iterable<string>,
): string | null {
  if (engine !== "luatex") return null;
  for (const path of projectPaths) if (READER_CONFIGS.has(path.toLowerCase())) return null;
  return LUAOTFLOAD_CONFIG_TEXT;
}
