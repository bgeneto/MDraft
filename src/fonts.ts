//! The bundled typefaces, and the roles the editor and preview use them in.
//!
//! Thirteen families are compiled into the application under the SIL Open Font
//! License, so the typography does not depend on what the reader happens to have
//! installed. `scripts/fetch-fonts.ps1` downloads the pins in
//! `scripts/font-sources.json`, subsets the variable text faces with
//! `scripts/subset-fonts.py`, and writes `assets/fonts/fonts.json`; the files
//! themselves are committed, so an ordinary build needs neither Python nor a
//! network connection.
//!
//! The presets are complete systems rather than one family swapped in:
//!
//!  * **Source Serif 4 / Source Sans 3** for the neutral Serif preset, a
//!    superfamily drawn to one skeleton, with Fira Code in the editor and code.
//!  * **EB Garamond / IBM Plex Mono** for Renaissance. Both are humanist and
//!    low-contrast; Garamond's serif headings keep the page in one voice, and
//!    Plex's larger x-height is the concession code needs.
//!  * **Bodoni Moda / Archivo / JetBrains Mono** for Editorial. Didone hairlines
//!    under a grotesque heading; JetBrains is the already-bundled grotesque code
//!    face, with ligatures and a slashed zero.
//!  * **Jost / Azeret Mono** for Bauhaus. Geometric prose and headings over a
//!    geometric code face; there is no serif anywhere in the preset.
//!  * **Alegreya / Caveat / Victor Mono** for Notebook. A calligraphic serif, a
//!    handwriting heading and a narrow mono whose italic is cursive.
//!
//! Why EB Garamond rather than Cormorant: the latter is a display cut and too
//! light at 16–18 px. Why Bodoni Moda rather than Libre Bodoni: the optical-size
//! axis picks the text cut at the size in use. Why Jost rather than Poppins:
//! Poppins has no italic and one width. Why Alegreya rather than Lora: Lora's
//! OFL reserves the name, so a subset would have to be renamed.

import catalogue from "./assets/fonts/fonts.json";
import type { EditorLineHeight } from "./api";

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
  /** Present for release-archive families; the Google and woff2 families have
   * their source pins in scripts/font-sources.json instead. */
  archive?: string;
  archiveSha256?: string;
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
 * be pure weight: the Renaissance code stack ends `"IBM Plex Mono", "JetBrains
 * Mono", …`, and carrying JetBrains as well would add its files for a face that
 * cannot render.
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
    label: "Source Editor",
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
    help: "Headings in the preview and in exports. A sans beside a serif body is the usual pairing; some presets keep the serif in the headings.",
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
  "Inter",
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
].filter((name, index, all) => all.indexOf(name) === index);

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
 * The application defaults for the four per-preset reader adjustments.
 *
 * These mirror the defaults in `src-tauri/src/settings.rs`. They are
 * deliberately *not* part of a preset's identity (`values`): Editor font size,
 * Preview font size, Math scale and Code scale are remembered per preset in
 * `Settings::preset_overrides`, so an unadjusted preset starts at its own
 * `defaults` (or here when omitted).
 */
export const DEFAULT_EDITOR_FONT_SIZE = 15;
export const DEFAULT_BODY_FONT_SIZE = 16;
export const DEFAULT_MATH_SCALE = 95;
// 100 keeps the preview's own 86% block / 88% inline ratios. A code face with a
// large x-height reads bigger than the prose at that ratio, which is why the
// reader can raise it to about 116; the panel allows 70–130.
export const DEFAULT_CODE_SCALE = 100;

/**
 * Line-height multipliers for the source pane, keyed by the stored name.
 *
 * Compact is 1.3 rather than 1.25: at the 10 px minimum a 1.25 line box is
 * 12.5 px, tight enough for tall ascenders to meet the descenders above. The
 * names are what `settings.json` stores, so a hand-edited value cannot become
 * an invalid CSS declaration; an unknown name falls back to Normal.
 */
export const EDITOR_LINE_HEIGHTS: Record<EditorLineHeight, number> = {
  compact: 1.3,
  normal: 1.5,
  wide: 1.8,
};

export const DEFAULT_EDITOR_LINE_HEIGHT: EditorLineHeight = "normal";

export interface TypographyPreset {
  id: string;
  label: string;
  /** What the preset is for, shown under the picker. */
  note: string;
  /**
   * Starting sizes for this preset before the reader adjusts them.
   * Absent fields fall back to the application defaults (15 px / 16 px / 95% /
   * 100%). Each preset tunes its code scale to the mono it names, because those
   * faces have different apparent heights at the same nominal size; System keeps
   * 100% because its code face is whatever the reader's machine provides.
   */
  defaults?: {
    editorFontSize?: number;
    bodyFontSize?: number;
    mathFontScale?: number;
    codeFontScale?: number;
  };
  /**
   * What identifies the preset: the four font stacks and the OpenType
   * booleans. Editor font size, Preview font size, Math scale and Code scale are
   * reader adjustments and are stored separately, so editing one does not
   * change the active preset.
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
 * Fira Code is the editor and preview-code face of the Serif preset only.
 * JetBrains Mono, which Classic, Literary and Technical used to share, now
 * belongs to Editorial alone; the other new presets name their own mono, so the
 * ligature-drawing face is a deliberate choice rather than an inherited default.
 */
export const TYPOGRAPHY_PRESETS: TypographyPreset[] = [
  {
    id: "system",
    label: "System",
    note: "The default: no bundled faces. Prose, headings and code use whatever the operating system provides, so nothing is embedded in an export.",
    defaults: {
      mathFontScale: 95,
    },
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
    defaults: {
      bodyFontSize: 17,
      mathFontScale: 88,
      codeFontScale: 98,
    },
    values: {
      ...ROLE_DEFAULTS,
      sourceFont: '"Fira Code", "JetBrains Mono", ui-monospace, monospace',
      bodyFont: '"Source Serif 4", Georgia, serif',
      headingFont: '"Source Sans 3", system-ui, sans-serif',
      codeFont: '"Fira Code", "JetBrains Mono", ui-monospace, monospace',
      ligaturesInCode: true,
      tabularFigures: true,
      oldstyleFigures: true,
      slashedZero: true,
    },
  },
  {
    id: "renaissance",
    label: "Renaissance",
    note: "Garamond's 16th-century old style: low contrast, a small x-height, serif headings and oldstyle figures. IBM Plex Mono sets the editor and code.",
    defaults: {
      bodyFontSize: 19,
      mathFontScale: 80,
      codeFontScale: 90,
    },
    values: {
      ...ROLE_DEFAULTS,
      sourceFont: '"IBM Plex Mono", "JetBrains Mono", ui-monospace, monospace',
      bodyFont: '"EB Garamond", "Source Serif 4", Georgia, "Times New Roman", serif',
      headingFont: '"EB Garamond", "Source Serif 4", Georgia, "Times New Roman", serif',
      codeFont: '"IBM Plex Mono", "JetBrains Mono", ui-monospace, monospace',
      ligaturesInCode: false,
      tabularFigures: true,
      oldstyleFigures: true,
      slashedZero: true,
    },
  },
  {
    id: "editorial",
    label: "Editorial",
    note: "Bodoni Moda's hairline Didone against Archivo's grotesque headings, with JetBrains Mono in code. Lining figures and ligatures; the page behaves like a magazine.",
    defaults: {
      bodyFontSize: 17,
      mathFontScale: 90,
      codeFontScale: 96,
    },
    values: {
      ...ROLE_DEFAULTS,
      sourceFont: '"JetBrains Mono", ui-monospace, monospace',
      bodyFont: '"Bodoni Moda", "Source Serif 4", "Times New Roman", serif',
      headingFont: '"Archivo", "Source Sans 3", system-ui, sans-serif',
      codeFont: '"JetBrains Mono", ui-monospace, monospace',
      ligaturesInCode: true,
      tabularFigures: true,
      oldstyleFigures: false,
      slashedZero: true,
    },
  },
  {
    id: "bauhaus",
    label: "Bauhaus",
    note: "Jost's circles and straight lines in prose and headings, with Azeret Mono's geometric code. No serif anywhere; proportional figures and the arrow ligature.",
    defaults: {
      bodyFontSize: 17,
      mathFontScale: 90,
      codeFontScale: 93,
    },
    values: {
      ...ROLE_DEFAULTS,
      sourceFont: '"Azeret Mono", "JetBrains Mono", ui-monospace, monospace',
      bodyFont: '"Jost", "Source Sans 3", system-ui, sans-serif',
      headingFont: '"Jost", "Source Sans 3", system-ui, sans-serif',
      codeFont: '"Azeret Mono", "JetBrains Mono", ui-monospace, monospace',
      ligaturesInCode: true,
      // Jost's `tnum` is a fullwidth set, not a tabular one; the preview tables
      // keep the proportional figures rather than turning digits into wide
      // fullwidth glyphs.
      tabularFigures: false,
      oldstyleFigures: false,
      slashedZero: true,
    },
  },
  {
    id: "notebook",
    label: "Notebook",
    note: "Alegreya's calligraphic serif under Caveat's handwriting, with Victor Mono's narrow, cursive-italic code. A notebook rather than a printed page.",
    defaults: {
      bodyFontSize: 17,
      mathFontScale: 86,
      codeFontScale: 93,
    },
    values: {
      ...ROLE_DEFAULTS,
      sourceFont: '"Victor Mono", "JetBrains Mono", ui-monospace, monospace',
      bodyFont: '"Alegreya", "Source Serif 4", Georgia, serif',
      headingFont: '"Caveat", "Alegreya", cursive',
      codeFont: '"Victor Mono", "JetBrains Mono", ui-monospace, monospace',
      ligaturesInCode: true,
      tabularFigures: true,
      oldstyleFigures: true,
      // Victor Mono's slashed zero is a stylistic set (`ss02`), not the `zero`
      // feature that `font-variant-numeric` can request.
      slashedZero: false,
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
