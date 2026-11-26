/**
 * Chat-assistant figures in fenced code blocks.
 *
 * ChatGPT and similar assistants answer with figures written as markup in a
 * fence: plain ```svg, or an undocumented component dialect (`<card>`, `<box>`,
 * `<grid>`, `<svg>` with `{#each}` loops). This module decides whether a fence
 * is such a figure and compiles it to a validated node tree. It is pure, so it
 * runs in Node for the unit suite; `dom.ts` paints the tree.
 */

import { Budget, WidgetError } from "./expr.ts";
import { parseTemplate, type ParseMode } from "./template.ts";
import { renderFigure, type VNode } from "./render.ts";

export type { VNode } from "./render.ts";

export type WidgetResult =
  | { kind: "none" }
  | { kind: "ok"; nodes: VNode[] }
  | { kind: "error"; message: string; line?: number };

/** Fence languages whose content may be a figure. */
const TEMPLATE_LANGUAGES = new Set(["", "svelte", "jsx", "widget"]);
/** The first tag a component figure starts with. Anything else stays code. */
const FIGURE_ROOTS = /^<(svg|card|box|row|grid)[\s/>]/;

function skipPreamble(source: string, template: boolean): string {
  let rest = source;
  for (;;) {
    rest = rest.trimStart();
    if (rest.startsWith("<!--")) {
      const end = rest.indexOf("-->");
      if (end < 0) return rest;
      rest = rest.slice(end + 3);
      continue;
    }
    if (rest.startsWith("<?") || rest.startsWith("<!DOCTYPE") || rest.startsWith("<!doctype")) {
      const end = rest.indexOf(">");
      if (end < 0) return rest;
      rest = rest.slice(end + 1);
      continue;
    }
    if (template && (rest.startsWith("{@body") || rest.startsWith("{@const"))) {
      // Declarations come first in interactive figures; find where they end
      // without parsing them, which the compiler does properly afterwards.
      let depth = 0;
      let end = -1;
      for (let i = 0; i < rest.length; i += 1) {
        const c = rest[i];
        if (c === "{") depth += 1;
        else if (c === "}" && --depth === 0) {
          end = i;
          break;
        }
      }
      if (end < 0) return rest;
      rest = rest.slice(end + 1);
      continue;
    }
    return rest;
  }
}

/** Whether a fence should be treated as a figure at all. */
export function figureMode(source: string, language: string): ParseMode | null {
  const lang = language.trim().toLowerCase();
  if (lang === "svg") return /^<svg[\s/>]/.test(skipPreamble(source, false)) ? "svg" : null;
  if (!TEMPLATE_LANGUAGES.has(lang)) return null;
  return FIGURE_ROOTS.test(skipPreamble(source, true)) ? "template" : null;
}

/** Compile a fence; `none` means it is ordinary code. */
export function compileWidget(source: string, language: string): WidgetResult {
  const mode = figureMode(source, language);
  if (!mode) return { kind: "none" };
  try {
    const nodes = renderFigure(parseTemplate(source, mode), new Budget());
    if (!nodes.some((n) => n.t === "el")) return { kind: "error", message: "the figure is empty" };
    return { kind: "ok", nodes };
  } catch (error) {
    if (error instanceof WidgetError)
      return { kind: "error", message: error.message, line: error.line };
    // A RangeError from deep recursion or any other surprise is still a figure
    // that cannot be shown; the code block stays.
    return { kind: "error", message: error instanceof Error ? error.message : String(error) };
  }
}

const CACHE_LIMIT = 128;
const cache = new Map<string, WidgetResult>();

/**
 * `compileWidget` with a bounded cache. Every keystroke re-renders the edited
 * block, and a document can hold the same figure many times.
 */
export function compileWidgetCached(source: string, language: string): WidgetResult {
  const key = `${language}\u0001${source}`;
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const result = compileWidget(source, language);
  cache.set(key, result);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  return result;
}
