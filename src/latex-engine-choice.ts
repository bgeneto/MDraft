/**
 * Which bundled TeX engine compiles a LaTeX project (stage 6.2 of
 * docs/architecture.md, ADR 2026-11-13-per-project-tex-engine).
 *
 * The engine is a visible choice, never a silent switch. The first rule that
 * applies wins:
 *
 * 1. A `% !TeX program = …` magic comment in the main file. It is portable to
 *    TeXstudio and LaTeX Workshop.
 * 2. The project's own choice, made from the status-bar engine chip and stored
 *    per main document.
 * 3. The Preferences default. "auto" detects from the preamble: Lua intent →
 *    LuaLaTeX, XeTeX-only or Unicode packages → XeLaTeX, otherwise LuaLaTeX.
 *    pdfLaTeX is not offered: the bundled preview engine has no pdfTeX. An
 *    installed TeX distribution keeps its own engine choice in Preferences.
 *
 * Pure and cheap: called on every compile.
 */
export type TexEngine = "lualatex" | "pdflatex" | "xelatex";
export type EngineSetting = TexEngine | "auto";

export const ENGINE_LABELS: Record<TexEngine, string> = {
  lualatex: "LuaLaTeX",
  pdflatex: "pdfLaTeX",
  xelatex: "XeLaTeX",
};

export interface EngineChoice {
  engine: TexEngine;
  /** Which rule decided: the magic comment, the project, the default or detection. */
  source: "magic" | "project" | "default" | "auto";
  /** Shown on the chip: "magic comment", "project", "default" or "auto: <why>". */
  reason: string;
}

export function isTexEngine(value: unknown): value is TexEngine {
  return value === "lualatex" || value === "pdflatex" || value === "xelatex";
}

/** The `% !TeX program` value in the first lines of a source, mapped to an engine. */
export function magicProgram(source: string): TexEngine | null {
  const head = source.slice(0, 4096);
  const match = /^[ \t]*%[ \t]*!TEX[ \t]+(?:TS-)?program[ \t]*=[ \t]*([A-Za-z-]+)/im.exec(head);
  if (!match) return null;
  const name = match[1].toLowerCase();
  if (name === "lualatex" || name === "luatex" || name === "lualatex-dev") return "lualatex";
  if (name === "xelatex" || name === "xetex" || name === "xelatex-dev") return "xelatex";
  if (name === "pdflatex" || name === "pdftex" || name === "latex" || name === "pdflatex-dev")
    return "pdflatex";
  return null;
}

/**
 * The bundled engine actually used. A magic comment, a project choice written
 * before pdfLaTeX left the menu, or an old Preferences default may still name
 * it; the incremental preview has no pdfTeX, so LuaLaTeX draws it and the chip
 * says why.
 */
function bundledEngine(engine: TexEngine): { engine: TexEngine; reason: string | null } {
  return engine === "pdflatex"
    ? { engine: "lualatex", reason: "pdfLaTeX is not available; LuaLaTeX used" }
    : { engine, reason: null };
}

/** Resolve the engine for a main file's source under the three rules above. */
export function resolveTexEngine(
  mainSource: string,
  project: TexEngine | null | undefined,
  fallback: string | null | undefined,
): EngineChoice {
  const magic = magicProgram(mainSource);
  if (magic) {
    const fixed = bundledEngine(magic);
    return {
      engine: fixed.engine,
      source: "magic",
      reason: fixed.reason ? `magic comment (${fixed.reason})` : "magic comment",
    };
  }
  if (isTexEngine(project)) {
    const fixed = bundledEngine(project);
    return {
      engine: fixed.engine,
      source: "project",
      reason: fixed.reason ? `project (${fixed.reason})` : "project",
    };
  }
  if (isTexEngine(fallback)) {
    const fixed = bundledEngine(fallback);
    return {
      engine: fixed.engine,
      source: "default",
      reason: fixed.reason ? `default (${fixed.reason})` : "default",
    };
  }
  // "auto", or an unreadable setting: detect from the preamble.
  const detected = detectTexEngine(mainSource);
  return { engine: detected.engine, source: "auto", reason: `auto: ${detected.reason}` };
}

/** The source with TeX comments removed (an escaped `\%` is not a comment). */
function uncommented(source: string): string {
  return source.replace(/(^|[^\\])%.*$/gm, "$1");
}

/** Uncommented preamble text: everything before `\begin{document}`. */
function preamble(source: string): string {
  const code = uncommented(source);
  const end = code.search(/\\begin\s*\{document\}/);
  return end < 0 ? code : code.slice(0, end);
}

const PACKAGE = String.raw`\\(?:usepackage|RequirePackage)(?:\[[^\]]*\])?\{[^}]*\b`;
const LUA_PACKAGES = new RegExp(
  PACKAGE +
    String.raw`(?:luacode|luatexbase|luaotfload|luatexja|lua-ul|luacolor|lua-visual-debug|luamplib|selnolig|luavlna|chickenize)\b`,
);
const XETEX_ONLY = new RegExp(PACKAGE + String.raw`(?:xeCJK|xetexko|xltxtra|xunicode)\b`);
const UNICODE_ENGINE = new RegExp(
  PACKAGE +
    String.raw`(?:fontspec|unicode-math|polyglossia|mathspec|ctex)\b|\\(?:setmainfont|setsansfont|setmonofont|newfontfamily|setmathfont)\b`,
);

/** The engine a document needs, from its preamble (the SDK's documented precedence). */
export function detectTexEngine(source: string): { engine: TexEngine; reason: string } {
  const head = preamble(source);
  if (/\\directlua\b/.test(uncommented(source)) || LUA_PACKAGES.test(head))
    return { engine: "lualatex", reason: "Lua code" };
  if (XETEX_ONLY.test(head)) return { engine: "xelatex", reason: "XeTeX-only package" };
  if (UNICODE_ENGINE.test(head)) return { engine: "xelatex", reason: "fontspec" };
  // The bundled preview is LuaTeX-only besides XeTeX; there is no pdfTeX.
  return { engine: "lualatex", reason: "no Unicode packages" };
}

/**
 * A requirement the chosen engine cannot meet, worded for the reader, or null.
 * Only certain incompatibilities are named, so the message is never a guess:
 * Lua code needs LuaLaTeX, and `fontspec` needs a Unicode engine.
 */
export function engineMismatch(mainSource: string, engine: TexEngine): string | null {
  const code = uncommented(mainSource);
  const head = preamble(mainSource);
  if (engine !== "lualatex" && (/\\directlua\b/.test(code) || LUA_PACKAGES.test(head)))
    return `This document runs Lua code, which only LuaLaTeX can run.`;
  if (engine === "pdflatex" && UNICODE_ENGINE.test(head))
    return "This document loads fontspec or unicode-math, which need XeLaTeX or LuaLaTeX.";
  return null;
}
