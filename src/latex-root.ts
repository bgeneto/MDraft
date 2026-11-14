//! Main-document resolution for multi-file LaTeX projects (GAP-034).
//!
//! Rules 1, 3 and 5 of docs/architecture.md: a
//! `% !TeX root` magic comment names the main file; otherwise a file with its
//! own `\documentclass` is a main file; otherwise the previously pinned project
//! root is kept, and failing that the reader is told how to name one. Rules 2
//! and 4 (an explicit choice, the include graph) need a workspace and arrive
//! with it. Pure: `scripts/latex-root-unit.mjs` tests it without the app.

import { commentStart, maskLiteralRegions } from "./latex-references.ts";

/** How many leading lines may carry a magic comment, as TeXstudio reads them. */
const MAGIC_LINES = 20;

/** The value of a `% !TeX <key> = value` magic comment in the first lines, or null. */
export function magicComment(source: string, key: string): string | null {
  const lines = (source.charCodeAt(0) === 0xfeff ? source.slice(1) : source).split(
    /\r\n?|\n/,
    MAGIC_LINES,
  );
  const pattern = new RegExp(`^\\s*%\\s*!\\s*TEX\\s+(?:TS-)?${key}\\s*=\\s*(.+?)\\s*$`, "i");
  for (const line of lines) {
    const match = pattern.exec(line);
    if (match) return match[1].replace(/^"(.*)"$/, "$1");
  }
  return null;
}

/** The source with verbatim regions and `%` comments blanked. */
function codeOf(source: string): string {
  // `maskLiteralRegions` blanks verbatim-like regions; `%` comments are cut
  // per line with the same odd/even backslash rule the reference scan uses.
  return maskLiteralRegions(source)
    .split("\n")
    .map((line) => {
      const at = commentStart(line);
      return at < 0 ? line : line.slice(0, at);
    })
    .join("\n");
}

/** True when the source declares its own document class outside comments and verbatim text. */
export function hasDocumentClass(source: string): boolean {
  return /\\documentclass\s*(?:\[[^\]]*\]\s*)?\{/.test(codeOf(source));
}

/**
 * True when the source can be compiled as a main file: it declares a class, or
 * it opens the document body. The second covers templates that keep
 * `\documentclass` in an `\input` header; a chapter has neither.
 */
export function isMainCandidate(source: string): boolean {
  const code = codeOf(source);
  return /\\documentclass\s*(?:\[[^\]]*\]\s*)?\{/.test(code) || /\\begin\s*\{document\}/.test(code);
}

/** Resolve a magic-comment path against the directory of the file that names it. */
export function resolveRootPath(directory: string, target: string): string | null {
  const cleaned = target.trim().replace(/\\/g, "/");
  if (!cleaned) return null;
  // An absolute target (drive letter, UNC or POSIX root) is used as written.
  const absolute = /^(?:[A-Za-z]:\/|\/\/|\/)/.test(cleaned);
  const parts = (absolute ? cleaned : `${directory.replace(/\\/g, "/")}/${cleaned}`).split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "." || (part === "" && out.length > 0)) continue;
    if (part === "..") {
      if (out.length <= 1) return null;
      out.pop();
      continue;
    }
    out.push(part);
  }
  let path = out.join("/");
  if (!/\.tex$/i.test(path)) path += ".tex";
  return /^[A-Za-z]:\//.test(path) && directory.includes("\\") ? path.replace(/\//g, "\\") : path;
}

export type MainDocument =
  { kind: "comment"; path: string } | { kind: "self" } | { kind: "pinned" } | { kind: "missing" };

/**
 * Decide which file to compile for the active document.
 *
 * `pinnedContains` says whether the pinned project (the last successful or
 * failed root) contains this file; only then may the pin win over rule 5.
 */
export function resolveMainDocument(input: {
  directory: string;
  source: string;
  pinnedContains: boolean;
}): MainDocument {
  const named = magicComment(input.source, "root");
  if (named) {
    const path = resolveRootPath(input.directory, named);
    if (path) return { kind: "comment", path };
  }
  if (isMainCandidate(input.source)) return { kind: "self" };
  if (input.pinnedContains) return { kind: "pinned" };
  return { kind: "missing" };
}
