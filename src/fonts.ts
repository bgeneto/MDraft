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
  /** Text that shows the face doing the job it is chosen for. */
  sample: string;
  /** Used when the field is empty. */
  fallback: string;
  /**
   * Which set of OpenType switches applies.
   *
   * The specimen honours this, so a reader turning code ligatures off does not
   * see them in the sample and conclude the setting did nothing.
   */
  features: "code" | "prose";
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
    // Chosen to expose the glyphs that decide whether a coding face is usable:
    // zero against capital O, one against lower-case l and capital I, and two
    // ligatures — `=>` and `->` — that Fira Code and JetBrains Mono draw.
    sample: "const sum = (a1, b0) => a1 + b0; // Il1 O0",
    // Fira Code, which is the editor's own face. It is not used in the preview:
    // its ligatures are drawn for code, and prose set in them reads as code.
    fallback: '"Fira Code", "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    features: "code",
  },
  {
    id: "bodyFont",
    label: "Preview text",
    help: "Prose in the preview, and in exported documents.",
    variable: "--font-body",
    sample: "Hamburgefonstiv — the quick brown fox jumps over 1,234 lazy dogs.",
    fallback: '"Source Serif 4", Charter, Georgia, "Times New Roman", serif',
    features: "prose",
  },
  {
    id: "headingFont",
    label: "Preview headings",
    help: "Headings in the preview and in exports. A sans beside a serif body is the usual pairing.",
    variable: "--font-heading",
    sample: "Heading One — Typography & the Art of the Letterform",
    fallback: '"Source Sans 3", Inter, system-ui, "Segoe UI", Arial, sans-serif',
    features: "prose",
  },
  {
    id: "codeFont",
    label: "Preview code",
    help: "Fenced and inline code in the preview. The editor has its own setting above.",
    variable: "--font-code",
    sample: "fn main() { let total: u32 = 1_000; } // 0O 1lI -> =>",
    fallback: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    features: "code",
  },
];

/**
 * Faces offered in the picker, ahead of whatever the reader types.
 *
 * The four bundled families come first because they are the only ones guaranteed
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

export interface TypographyPreset {
  id: string;
  label: string;
  /** What the preset is for, shown under the picker. */
  note: string;
  values: Record<string, string | number | boolean>;
}

/**
 * Coherent starting points.
 *
 * Chosen as complete typographic systems rather than single font swaps, because
 * the hard part of choosing type is the pairing, not the individual face. Each
 * one is a defensible answer on its own; the fields below let it be dismantled.
 *
 * The first matches `Settings::default()` exactly, so a fresh installation
 * reports it rather than falling through to "custom".
 */
export const TYPOGRAPHY_PRESETS: TypographyPreset[] = [
  {
    id: "default",
    label: "Default",
    note: "Serif prose, sans headings, tabular figures in tables. Ligatures in code stay off: whether `->` should be an arrow is a real disagreement, and the plain reading is the safe default.",
    values: {
      ...ROLE_DEFAULTS,
      bodyFontSize: 16,
      ligaturesInCode: false,
      tabularFigures: true,
      oldstyleFigures: false,
      slashedZero: false,
    },
  },
  {
    id: "literary",
    label: "Literary",
    note: "The default with oldstyle figures and code ligatures on — figures that sit in running text rather than shout, and a slightly larger measure for long reading.",
    values: {
      ...ROLE_DEFAULTS,
      bodyFontSize: 17,
      ligaturesInCode: true,
      tabularFigures: true,
      oldstyleFigures: true,
      slashedZero: true,
    },
  },
  {
    id: "technical",
    label: "Technical",
    note: "Inter throughout, lining figures everywhere, and no code ligatures — for reading source rather than prose.",
    values: {
      ...ROLE_DEFAULTS,
      sourceFont: '"JetBrains Mono", ui-monospace, monospace',
      bodyFont: 'Inter, system-ui, "Segoe UI", sans-serif',
      headingFont: 'Inter, system-ui, "Segoe UI", sans-serif',
      codeFont: '"JetBrains Mono", ui-monospace, monospace',
      bodyFontSize: 16,
      ligaturesInCode: false,
      tabularFigures: true,
      oldstyleFigures: false,
      slashedZero: true,
    },
  },
  {
    id: "superfamily",
    label: "Source superfamily",
    note: "Source Serif 4 and Source Sans 3, drawn to the same skeleton, with Fira Code in the editor. The two Source faces were designed together, so the pairing cannot clash.",
    values: {
      ...ROLE_DEFAULTS,
      sourceFont: '"Fira Code", "JetBrains Mono", ui-monospace, monospace',
      bodyFont: '"Source Serif 4", Georgia, serif',
      headingFont: '"Source Sans 3", system-ui, sans-serif',
      bodyFontSize: 17,
      ligaturesInCode: true,
      tabularFigures: true,
      oldstyleFigures: false,
      slashedZero: true,
    },
  },
  {
    id: "system",
    label: "System only",
    note: "No bundled faces. Uses whatever the operating system provides, and exports accordingly — nothing is embedded.",
    values: {
      sourceFont: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
      bodyFont: 'Georgia, "Iowan Old Style", "Times New Roman", serif',
      headingFont: 'system-ui, "Segoe UI", -apple-system, Roboto, sans-serif',
      codeFont: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
      bodyFontSize: 16,
      ligaturesInCode: false,
      tabularFigures: true,
      oldstyleFigures: false,
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
