//! highlight.js styles are injected at runtime so the light and dark themes can
//! coexist without both stylesheets applying at once.

import light from "highlight.js/styles/github.css?inline";
import dark from "highlight.js/styles/github-dark.css?inline";

let styleEl: HTMLStyleElement | null = null;

export function applyHighlightTheme(isDark: boolean): void {
  if (!styleEl) {
    styleEl = document.createElement("style");
    styleEl.id = "hljs-theme";
    document.head.appendChild(styleEl);
  }
  styleEl.textContent = isDark ? dark : light;
}

/**
 * The token colours for a given appearance, without applying them.
 *
 * Printing needs this: a document exported while the editor is dark would carry
 * light-on-dark token colours, and a browser printing onto white paper without
 * background graphics would render them as pale text on white — unreadable. The
 * print document therefore always asks for the light palette.
 */
export function highlightThemeCss(isDark: boolean): string {
  return isDark ? dark : light;
}
