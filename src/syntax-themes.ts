//! Editor syntax themes.
//!
//! Each palette styles both the markdown source structure (headings, emphasis,
//! links, markers, quotes, lists) and ordinary code inside fenced blocks, and it
//! owns the writing surface's own background and text colour — so picking
//! "Solarized Light" while the rest of the app is dark still yields a readable
//! editor instead of light-on-dark tokens.
//!
//! The well-known palettes are close approximations of their namesakes, tuned
//! for a text editor rather than ported byte-for-byte from a colour scheme file.

import { HighlightStyle } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";

export interface SyntaxPalette {
  id: string;
  label: string;
  dark: boolean;

  /** Writing surface. */
  surface: string;
  text: string;
  muted: string;
  selection: string;
  activeLine: string;
  gutter: string;
  /**
   * The word-sync mark. Opaque, and judged against `surface`: a translucent
   * yellow on a teal or blue-black surface blends green and stops reading as a
   * mark at all. `syncPeak` is the pulse's lighter beat; the resting colour is
   * what remains after it.
   */
  sync: string;
  syncPeak: string;

  /** Markdown structure. */
  heading: string;
  strong: string;
  emphasis: string;
  strike: string;
  link: string;
  url: string;
  code: string;
  quote: string;
  /**
   * List content, not the bullet: `@lezer/markdown` tags the whole
   * `BulletList`/`OrderedList` subtree as `list`, so one bullet can be a whole
   * paragraph wearing this colour. Kept a muted violet rather than the
   * palette's keyword red, which reads as an error across a long list item.
   */
  list: string;
  separator: string;
  marker: string;

  /** Code inside fences. */
  keyword: string;
  string: string;
  number: string;
  comment: string;
  type: string;
  func: string;
  variable: string;
}

/** Follows the application's light/dark setting. */
export const AUTO_ID = "auto";

const paper: SyntaxPalette = {
  id: "paper",
  label: "Paper",
  dark: false,
  surface: "#ffffff",
  text: "#24292f",
  muted: "#8a8f98",
  selection: "rgba(84, 174, 255, 0.28)",
  activeLine: "rgba(0, 0, 0, 0.035)",
  gutter: "#a0a6ad",
  sync: "#ffe08a",
  syncPeak: "#ffc107",
  heading: "#0550ae",
  strong: "#111827",
  emphasis: "#7c3aed",
  strike: "#8a8f98",
  link: "#0969da",
  url: "#0a3069",
  code: "#bc4c00",
  quote: "#57606a",
  list: "#6e5494",
  separator: "#d0d7de",
  marker: "#98a1ab",
  keyword: "#cf222e",
  string: "#0a3069",
  number: "#0550ae",
  comment: "#6e7781",
  type: "#953800",
  func: "#8250df",
  variable: "#24292f",
};

const ink: SyntaxPalette = {
  id: "ink",
  label: "Ink",
  dark: true,
  surface: "#1e1e1e",
  text: "#d6d6d6",
  muted: "#8b8b8b",
  selection: "rgba(80, 140, 255, 0.32)",
  activeLine: "rgba(255, 255, 255, 0.05)",
  gutter: "#6e7681",
  sync: "#7a5c10",
  syncPeak: "#c49214",
  heading: "#7cb7ff",
  strong: "#ffffff",
  emphasis: "#c792ea",
  strike: "#8b8b8b",
  link: "#6cb6ff",
  url: "#9ecbff",
  code: "#ffab70",
  quote: "#9aa5b1",
  list: "#b5a3d1",
  separator: "#444c56",
  marker: "#7d8590",
  keyword: "#ff7b72",
  string: "#a5d6ff",
  number: "#79c0ff",
  comment: "#8b949e",
  type: "#ffa657",
  func: "#d2a8ff",
  variable: "#d6d6d6",
};

const githubLight: SyntaxPalette = {
  ...paper,
  id: "github-light",
  label: "GitHub Light",
  surface: "#ffffff",
  text: "#1f2328",
  gutter: "#8c959f",
  heading: "#0550ae",
  code: "#0a3069",
  comment: "#59636e",
  marker: "#8c959f",
};

const githubDark: SyntaxPalette = {
  ...ink,
  id: "github-dark",
  label: "GitHub Dark",
  surface: "#0d1117",
  text: "#e6edf3",
  gutter: "#6e7681",
  heading: "#79c0ff",
  strong: "#ffffff",
  link: "#6cb6ff",
  code: "#a5d6ff",
  quote: "#9198a1",
  list: "#b5a3d1",
  separator: "#30363d",
  marker: "#6e7681",
};

const oneDark: SyntaxPalette = {
  ...ink,
  id: "one-dark",
  label: "One Dark",
  surface: "#282c34",
  text: "#abb2bf",
  muted: "#7f848e",
  selection: "rgba(97, 175, 239, 0.30)",
  activeLine: "rgba(255, 255, 255, 0.045)",
  gutter: "#5c6370",
  sync: "#6e5410",
  syncPeak: "#c4921a",
  heading: "#e06c75",
  strong: "#d7dae0",
  emphasis: "#c678dd",
  link: "#61afef",
  url: "#98c379",
  code: "#98c379",
  quote: "#7f848e",
  list: "#e06c75",
  separator: "#3e4451",
  marker: "#5c6370",
  keyword: "#c678dd",
  string: "#98c379",
  number: "#d19a66",
  comment: "#5c6370",
  type: "#e5c07b",
  func: "#61afef",
  variable: "#abb2bf",
};

const solarizedLight: SyntaxPalette = {
  ...paper,
  id: "solarized-light",
  label: "Solarized Light",
  surface: "#fdf6e3",
  text: "#657b83",
  muted: "#93a1a1",
  selection: "rgba(38, 139, 210, 0.22)",
  activeLine: "rgba(101, 123, 131, 0.07)",
  gutter: "#b3b3a8",
  sync: "#f3d36b",
  syncPeak: "#e6b422",
  heading: "#268bd2",
  strong: "#073642",
  emphasis: "#6c71c4",
  strike: "#93a1a1",
  link: "#268bd2",
  url: "#2aa198",
  code: "#cb4b16",
  quote: "#93a1a1",
  list: "#859900",
  separator: "#eee8d5",
  marker: "#b3b3a8",
  keyword: "#859900",
  string: "#2aa198",
  number: "#d33682",
  comment: "#93a1a1",
  type: "#b58900",
  func: "#268bd2",
  variable: "#657b83",
};

const solarizedDark: SyntaxPalette = {
  ...ink,
  id: "solarized-dark",
  label: "Solarized Dark",
  surface: "#002b36",
  text: "#93a1a1",
  muted: "#657b83",
  selection: "rgba(38, 139, 210, 0.28)",
  activeLine: "rgba(147, 161, 161, 0.07)",
  gutter: "#586e75",
  sync: "#5c4810",
  syncPeak: "#c49a1a",
  heading: "#268bd2",
  strong: "#eee8d5",
  emphasis: "#6c71c4",
  link: "#268bd2",
  url: "#2aa198",
  code: "#cb4b16",
  quote: "#657b83",
  list: "#859900",
  separator: "#073642",
  marker: "#586e75",
  keyword: "#859900",
  string: "#2aa198",
  number: "#d33682",
  comment: "#586e75",
  type: "#b58900",
  func: "#268bd2",
  variable: "#93a1a1",
};

const nord: SyntaxPalette = {
  ...ink,
  id: "nord",
  label: "Nord",
  surface: "#2e3440",
  text: "#d8dee9",
  muted: "#7b88a1",
  selection: "rgba(136, 192, 208, 0.26)",
  activeLine: "rgba(216, 222, 233, 0.05)",
  gutter: "#616e88",
  sync: "#7a5c20",
  syncPeak: "#c4a35a",
  heading: "#88c0d0",
  strong: "#eceff4",
  emphasis: "#b48ead",
  link: "#88c0d0",
  url: "#8fbcbb",
  code: "#a3be8c",
  quote: "#7b88a1",
  list: "#81a1c1",
  separator: "#3b4252",
  marker: "#616e88",
  keyword: "#81a1c1",
  string: "#a3be8c",
  number: "#b48ead",
  comment: "#616e88",
  type: "#8fbcbb",
  func: "#88c0d0",
  variable: "#d8dee9",
};

/** Concrete palettes, in the order they appear in Preferences. */
export const PALETTES: SyntaxPalette[] = [
  paper,
  ink,
  githubLight,
  githubDark,
  oneDark,
  solarizedLight,
  solarizedDark,
  nord,
];

/** Resolve a stored setting to a concrete palette. */
export function resolvePalette(id: string, appIsDark: boolean): SyntaxPalette {
  if (id === AUTO_ID) return appIsDark ? ink : paper;
  return PALETTES.find((palette) => palette.id === id) ?? (appIsDark ? ink : paper);
}

/** Options for the Preferences dropdown. */
export const PALETTE_OPTIONS: [string, string][] = [
  [AUTO_ID, "Match the application theme"],
  ...PALETTES.map((p) => [p.id, `${p.label}${p.dark ? " (dark)" : ""}`] as [string, string]),
];

export function buildHighlightStyle(palette: SyntaxPalette): HighlightStyle {
  return HighlightStyle.define(
    [
      // ---- markdown structure ------------------------------------------
      { tag: t.heading1, color: palette.heading, fontWeight: "700" },
      { tag: t.heading2, color: palette.heading, fontWeight: "700" },
      { tag: t.heading3, color: palette.heading, fontWeight: "650" },
      { tag: t.heading4, color: palette.heading, fontWeight: "650" },
      { tag: t.heading5, color: palette.heading, fontWeight: "600" },
      { tag: t.heading6, color: palette.heading, fontWeight: "600" },
      { tag: t.heading, color: palette.heading, fontWeight: "700" },
      { tag: t.strong, color: palette.strong, fontWeight: "700" },
      { tag: t.emphasis, color: palette.emphasis, fontStyle: "italic" },
      { tag: t.strikethrough, color: palette.strike, textDecoration: "line-through" },
      { tag: t.link, color: palette.link, textDecoration: "underline" },
      { tag: t.url, color: palette.url },
      { tag: t.monospace, color: palette.code },
      { tag: t.quote, color: palette.quote, fontStyle: "italic" },
      { tag: t.list, color: palette.list },
      { tag: t.contentSeparator, color: palette.separator, fontWeight: "700" },
      { tag: t.labelName, color: palette.marker },
      { tag: t.escape, color: palette.number },
      { tag: t.character, color: palette.number },

      // Punctuation that belongs to the markdown syntax itself: the `#`, `>`,
      // backticks and bullet dashes. Dimmed so the prose stands out.
      { tag: t.processingInstruction, color: palette.marker },
      { tag: t.punctuation, color: palette.marker },
      { tag: t.meta, color: palette.marker },
      { tag: t.comment, color: palette.comment, fontStyle: "italic" },

      // ---- code inside fences ------------------------------------------
      { tag: [t.keyword, t.modifier, t.operatorKeyword, t.controlKeyword], color: palette.keyword },
      { tag: [t.string, t.special(t.string), t.regexp], color: palette.string },
      { tag: [t.number, t.bool, t.null, t.atom], color: palette.number },
      { tag: [t.typeName, t.className, t.namespace], color: palette.type },
      {
        tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName],
        color: palette.func,
      },
      { tag: [t.definition(t.variableName), t.variableName], color: palette.variable },
      { tag: [t.propertyName, t.attributeName], color: palette.func },
      { tag: [t.tagName], color: palette.keyword },
      { tag: [t.deleted], color: palette.keyword },
      { tag: [t.inserted], color: palette.string },
    ],
    { themeType: palette.dark ? "dark" : "light" },
  );
}

/** Chrome for the writing surface, so the palette is self-consistent. */
export function buildChromeTheme(palette: SyntaxPalette) {
  return EditorView.theme(
    {
      "&": {
        backgroundColor: palette.surface,
        color: palette.text,
        // The sync mark is judged against this surface, not against the
        // application chrome, so the palette publishes it. The stylesheet owns
        // the background property itself; these are only the colours.
        "--editor-sync": palette.sync,
        "--editor-sync-peak": palette.syncPeak,
      },
      ".cm-content": { caretColor: palette.text },
      ".cm-gutters": { color: palette.gutter },
      ".cm-activeLine": { backgroundColor: palette.activeLine },
      ".cm-activeLineGutter": { backgroundColor: "transparent", color: palette.text },
      ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
        backgroundColor: `${palette.selection} !important`,
      },
      ".cm-cursor, .cm-dropCursor": { borderLeftColor: palette.text, borderLeftWidth: "2px" },
      ".cm-selectionMatch": { backgroundColor: palette.activeLine },
    },
    { dark: palette.dark },
  );
}
