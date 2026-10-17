//! The bundled typefaces, and the roles the editor and preview use them in.
//!
//! Four families are compiled into the application under the SIL Open Font
//! License, so the typography does not depend on what the reader happens to have
//! installed. `scripts/fetch-fonts.ps1` downloads them, verifies each archive
//! against a pinned SHA-256 and writes `assets/fonts/fonts.json`; the files
//! themselves are committed, so an ordinary build needs neither that script nor
//! a network connection.
//!
//! Why these four, given that mathematics is fixed to KaTeX's Computer Modern:
//!
//!  * **Source Serif 4** for prose. A screen-first serif with a real optical
//!    size axis, true italics and moderate contrast, which is what sits
//!    comfortably beside a Didone like Computer Modern.
//!  * **Source Sans 3** for headings. Designed by Adobe as Source Serif's
//!    companion, so the two share a skeleton — the safe typographic pairing is a
//!    superfamily rather than two unrelated faces.
//!  * **Inter** as the alternative sans. More display presence, and an unusually
//!    complete set of OpenType alternates.
//!  * **JetBrains Mono** for code. Drawn with programming ligatures as a
//!    headline feature, which is what makes the ligature switch worth having.

import catalogue from "./assets/fonts/fonts.json";

export interface BundledFace {
  file: string;
  style: string;
  weight: string;
  bytes: number;
  sha256: string;
}

export interface BundledFamily {
  id: string;
  name: string;
  tag: string;
  source: string;
  licence: string;
  licenceFile: string;
  archive: string;
  archiveSha256: string;
  files: BundledFace[];
}

/** The bundled families, in the order the picker should offer them. */
export const BUNDLED_FAMILIES = catalogue.families as BundledFamily[];

/**
 * Vite rewrites every `url()`-able asset to a hashed path at build time. The
 * glob is what turns the file names in `fonts.json` into URLs, in development
 * and in the packaged application alike.
 */
const fontUrls = import.meta.glob("./assets/fonts/*.woff2", {
  query: "?url",
  import: "default",
  eager: true,
}) as Record<string, string>;

function urlOf(file: string): string | null {
  return fontUrls[`./assets/fonts/${file}`] ?? null;
}

/**
 * The bundled families that will actually be rendered by these stacks.
 *
 * Only the *first* bundled family in each stack counts. A stack is a fallback
 * chain, so anything after the winner can never be used — and embedding it would
 * be pure weight: the default heading stack ends `"Source Sans 3", Inter, …`,
 * and carrying Inter as well added nearly a megabyte of base64 to every export
 * for a face that cannot render.
 */
export function familiesIn(stacks: string[]): BundledFamily[] {
  const winners = new Set<string>();
  for (const stack of stacks) {
    // Ordered by position, so the earliest mention in the stack wins rather
    // than the earliest family in the catalogue.
    let best: { name: string; at: number } | null = null;
    for (const family of BUNDLED_FAMILIES) {
      const at = stack.indexOf(family.name);
      if (at === -1) continue;
      if (!best || at < best.at) best = { name: family.name, at };
    }
    if (best) winners.add(best.name);
  }
  return BUNDLED_FAMILIES.filter((family) => winners.has(family.name));
}

let installed = false;

/**
 * Declare the bundled faces to the document.
 *
 * Injected rather than written into a stylesheet so that the family names, the
 * weights and the file list all come from the same `fonts.json` the fetch script
 * generates: a stylesheet would be a second copy to keep in step.
 *
 * `font-display: swap` because these are text faces loaded from local files. The
 * swap window is a millisecond or two, and a fallback that appears and corrects
 * itself is better than text that does not appear at all if a file is missing.
 */
export function installBundledFonts(): void {
  if (installed) return;
  const rules: string[] = [];
  for (const family of BUNDLED_FAMILIES) {
    for (const face of family.files) {
      const url = urlOf(face.file);
      if (!url) {
        console.warn(`[fonts] no asset URL for ${face.file}; skipping`);
        continue;
      }
      rules.push(
        [
          "@font-face{",
          `font-family:"${family.name}";`,
          `font-style:${face.style};`,
          `font-weight:${face.weight};`,
          "font-display:swap;",
          `src:url("${url}") format("woff2");`,
          "}",
        ].join(""),
      );
    }
  }
  const style = document.createElement("style");
  style.id = "bundled-fonts";
  style.textContent = rules.join("\n");
  document.head.appendChild(style);
  installed = true;
}

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

export interface TypographyRole {
  /** Settings key, and the suffix of the CSS variable. */
  id: "sourceFont" | "bodyFont" | "headingFont" | "codeFont";
  label: string;
  help: string;
  /** The CSS variable the role is published as. */
  variable: string;
  /** Used when the setting is empty. */
  fallback: string;
}

/**
 * The four places a typeface is chosen.
 *
 * Deliberately four and not two: a markdown editor has a source pane where the
 * text is not the document but the instructions for it, and a reader who wants a
 * proportional face there — or a monospaced one in a preview code block — should
 * not have to accept the other pane's choice.
 */
export const TYPOGRAPHY_ROLES: TypographyRole[] = [
  {
    id: "sourceFont",
    label: "Editor",
    help: "The source pane. Monospaced by default, but any family will work.",
    variable: "--font-source",
    // The system monospace, which is what the default "System" preset asks for.
    // Fira Code is a preset choice, not the fallback: it is the editor face of
    // the "Serif" preset alone, because its ligatures are drawn for code and a
    // reader who has not asked for them is better served by a plain monospace.
    fallback: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
  },
  {
    id: "bodyFont",
    label: "Preview text",
    help: "Prose in the preview, and in exported documents.",
    variable: "--font-body",
    // The same stack as the headings, so the default "System" preset reads as
    // one coherent system face rather than a serif pasted beside a sans.
    fallback: 'system-ui, "Segoe UI", -apple-system, Roboto, sans-serif',
  },
  {
    id: "headingFont",
    label: "Preview headings",
    help: "Headings in the preview and in exports. A sans beside a serif body is the usual pairing.",
    variable: "--font-heading",
    fallback: 'system-ui, "Segoe UI", -apple-system, Roboto, sans-serif',
  },
  {
    id: "codeFont",
    label: "Preview code",
    help: "Fenced and inline code in the preview. The editor has its own setting above.",
    variable: "--font-code",
    fallback: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
  },
];

/**
 * Faces offered in each picker.
 *
 * The bundled families come first because they are the only ones guaranteed
 * to exist on every machine. The rest are the faces most likely to be present on
 * Windows, macOS and a typical Linux desktop, so the list is useful without
 * pretending to be a system font enumeration — which Tauri does not offer, and
 * which the webview's own font API does not expose reliably.
 */
export const FONT_SUGGESTIONS: string[] = [
  ...BUNDLED_FAMILIES.map((family) => family.name),
  "Cascadia Code",
  "Consolas",
  "Fira Code",
  "IBM Plex Mono",
  "SF Mono",
  "Menlo",
  "Georgia",
  "Charter",
  "Palatino Linotype",
  "Cambria",
  "Iowan Old Style",
  "Times New Roman",
  "Segoe UI",
  "Segoe UI Variable",
  "system-ui",
  "Arial",
  "Helvetica Neue",
  "Verdana",
];

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

/**
 * The built-in value for each role, keyed by settings field.
 *
 * The presets below are built from this rather than repeating the stacks, so a
 * preset that claims to be "the default" really is one — the preset picker
 * detects the active preset by comparing values, and a stray character here
 * would leave a fresh installation reporting "custom".
 */
const ROLE_DEFAULTS: Record<string, string> = Object.fromEntries(
  TYPOGRAPHY_ROLES.map((role) => [role.id, role.fallback]),
);

/**
 * The application defaults for the two per-preset reader adjustments.
 *
 * These mirror `default_body_font_size()` and `default_math_font_scale()` in
 * `src-tauri/src/settings.rs`. They are deliberately *not* part of a preset:
 * Preview text size and Math scale are remembered per preset in
 * `Settings::preset_overrides`, so an unadjusted preset starts here.
 */
export const DEFAULT_BODY_FONT_SIZE = 16;
export const DEFAULT_MATH_SCALE = 100;

export interface TypographyPreset {
  id: string;
  label: string;
  /** What the preset is for, shown under the picker. */
  note: string;
  /**
   * What identifies the preset: the four font stacks and the OpenType
   * booleans. Preview text size and Math scale are reader adjustments and are
   * stored separately, so editing one does not change the active preset.
   */
  values: Record<string, string | boolean>;
}

/**
 * Coherent starting points.
 *
 * Chosen as complete typographic systems rather than single font swaps, because
 * the hard part of choosing type is the pairing, not the individual face. Each
 * one is a defensible answer on its own; the fields below let it be dismantled.
 *
 * The System preset matches `Settings::default()` exactly, so a fresh
 * installation reports it rather than falling through to "custom". It comes
 * first because that is the default: the application should not depend on a face
 * the reader's machine may not own until the reader asks for one.
 *
 * Fira Code is the editor and preview-code face of the Serif preset only. Every
 * other preset names JetBrains Mono, or the system monospace for System, so the
 * ligature-drawing face is a deliberate choice rather than an inherited default.
 */
export const TYPOGRAPHY_PRESETS: TypographyPreset[] = [
  {
    id: "system",
    label: "System",
    note: "The default: no bundled faces. Prose, headings and code use whatever the operating system provides, so nothing is embedded in an export.",
    values: {
      ...ROLE_DEFAULTS,
      ligaturesInCode: false,
      tabularFigures: true,
      oldstyleFigures: false,
      slashedZero: false,
    },
  },
  {
    id: "superfamily",
    label: "Serif",
    note: "Source Serif 4 and Source Sans 3, drawn to the same skeleton, with Fira Code in the editor and in preview code. The two Source faces were designed together, so the pairing cannot clash.",
    values: {
      ...ROLE_DEFAULTS,
      sourceFont: '"Fira Code", "JetBrains Mono", ui-monospace, monospace',
      bodyFont: '"Source Serif 4", Georgia, serif',
      headingFont: '"Source Sans 3", system-ui, sans-serif',
      codeFont: '"Fira Code", "JetBrains Mono", ui-monospace, monospace',
      ligaturesInCode: true,
      tabularFigures: true,
      oldstyleFigures: false,
      slashedZero: true,
    },
  },
  {
    id: "classic",
    label: "Classic",
    note: "The original MDraft pairing: Source Serif 4 under Source Sans 3, with JetBrains Mono in the editor and in preview code, and code ligatures off.",
    values: {
      ...ROLE_DEFAULTS,
      sourceFont: '"JetBrains Mono", ui-monospace, monospace',
      bodyFont: '"Source Serif 4", Charter, Georgia, "Times New Roman", serif',
      headingFont: '"Source Sans 3", Inter, system-ui, "Segoe UI", Arial, sans-serif',
      codeFont: '"JetBrains Mono", ui-monospace, monospace',
      ligaturesInCode: false,
      tabularFigures: true,
      oldstyleFigures: false,
      slashedZero: false,
    },
  },
  {
    id: "literary",
    label: "Literary",
    note: "Source Serif 4 with oldstyle figures and code ligatures on — figures that sit in running text rather than shout. JetBrains Mono sets the code.",
    values: {
      ...ROLE_DEFAULTS,
      sourceFont: '"JetBrains Mono", ui-monospace, monospace',
      bodyFont: '"Source Serif 4", Charter, Georgia, "Times New Roman", serif',
      headingFont: '"Source Sans 3", Inter, system-ui, "Segoe UI", Arial, sans-serif',
      codeFont: '"JetBrains Mono", ui-monospace, monospace',
      ligaturesInCode: true,
      tabularFigures: true,
      oldstyleFigures: true,
      slashedZero: true,
    },
  },
  {
    id: "technical",
    label: "Technical",
    note: "Inter throughout, lining figures everywhere, and no code ligatures — for reading source rather than prose. JetBrains Mono in both code roles.",
    values: {
      ...ROLE_DEFAULTS,
      sourceFont: '"JetBrains Mono", ui-monospace, monospace',
      bodyFont: 'Inter, system-ui, "Segoe UI", sans-serif',
      headingFont: 'Inter, system-ui, "Segoe UI", sans-serif',
      codeFont: '"JetBrains Mono", ui-monospace, monospace',
      ligaturesInCode: false,
      tabularFigures: true,
      oldstyleFigures: false,
      slashedZero: true,
    },
  },
];

// ---------------------------------------------------------------------------
// Export embedding
// ---------------------------------------------------------------------------

function toBase64(bytes: Uint8Array): string {
  // Chunked because String.fromCharCode.apply overflows the argument list on a
  // file of any size, and a font is a few hundred kilobytes.
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * `@font-face` rules carrying the faces as data URLs, for a document that will
 * be read outside the application.
 *
 * This is not a refinement. An exported file references a family by *name*, and
 * the reader's machine has no reason to own it — a PDF printed from the
 * exported HTML would silently fall back and no longer match the preview. Only
 * the families actually named in `stacks` are embedded, so a document using one
 * face does not carry three.
 *
 * Returns an empty string when nothing bundled is in use, which is the correct
 * outcome for a stack made entirely of system fonts.
 */
export async function embeddedFontCss(stacks: string[]): Promise<string> {
  const families = familiesIn(stacks);
  if (families.length === 0) return "";

  const rules: string[] = [];
  for (const family of families) {
    for (const face of family.files) {
      const url = urlOf(face.file);
      if (!url) continue;
      try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const bytes = new Uint8Array(await response.arrayBuffer());
        rules.push(
          [
            "@font-face{",
            `font-family:"${family.name}";`,
            `font-style:${face.style};`,
            `font-weight:${face.weight};`,
            `src:url(data:font/woff2;base64,${toBase64(bytes)}) format("woff2");`,
            "}",
          ].join(""),
        );
      } catch (error) {
        // A missing face must not cost the reader the whole export: the stack
        // still names system fallbacks.
        console.warn(`[fonts] could not embed ${face.file}: ${String(error)}`);
      }
    }
  }
  return rules.join("\n");
}

/** Bytes that an embedded export would add, for a warning before it is written. */
export function embeddedFontBytes(stacks: string[]): number {
  return familiesIn(stacks)
    .flatMap((family) => family.files)
    .reduce((total, face) => total + face.bytes, 0);
}
