//! Preferences panel.
//!
//! Follows the layout of Typora's Preferences window: a search box above a
//! vertical list of sections on the left, and the selected section's rows on the
//! right. Every row is backed by a real setting — the panel never shows an
//! option that does nothing.
//!
//! It is a non-modal floating card, not a full-screen page: a font or spacing
//! change is visible in the document behind it as it is made, and the card can
//! be dragged and resized without leaving the webview.

import * as api from "./api";
import {
  DEFAULT_BODY_FONT_SIZE,
  DEFAULT_EDITOR_FONT_SIZE,
  DEFAULT_EDITOR_LINE_HEIGHT,
  DEFAULT_MATH_SCALE,
  EDITOR_LINE_HEIGHTS,
  FONT_SUGGESTIONS,
  TYPOGRAPHY_PRESETS,
  TYPOGRAPHY_ROLES,
  type TypographyPreset,
  type TypographyRole,
} from "./fonts";
import { PALETTE_OPTIONS } from "./syntax-themes";
import { dictionaryOptions, spellcheckAvailabilityNote } from "./spellcheck";

export interface PreferencesHost {
  settings(): api.Settings;
  update(patch: Partial<api.Settings>): void;
  clearRecent(): void;
  /** Write the document as a standalone HTML file. */
  exportHtml(): void;
  /** Print the document to PDF through the system browser. */
  exportPdf(): void;
  openDocumentation(which: "reference" | "shortcuts" | "licences"): void;
  version(): string;
  /** Last known pandoc status, or null before the first check. */
  pandocStatus(): api.PandocStatus | null;
  /** Check for pandoc and offer to install it if it is missing. */
  setupPandoc(): Promise<void>;
  /** Check for Typst and offer to install it if it is missing. */
  setupTypst(): Promise<void>;
  /** Ask the user for a reference/style file. Empty string when cancelled. */
  chooseStyleReference(current: string): Promise<string>;
}

export interface PreferencesHandle {
  open(): void;
  close(): void;
  toggle(): void;
  isOpen(): boolean;
  /** Redraw after something outside the panel changed a setting. */
  refresh(): void;
}

type Row =
  | { kind: "heading"; label: string }
  | { kind: "note"; label: string; text: string }
  | {
      kind: "checkbox";
      label: string;
      help?: string;
      get: () => boolean;
      set: (value: boolean) => void;
    }
  | {
      kind: "select";
      label: string;
      help?: string;
      options: [string, string][];
      get: () => string;
      set: (value: string) => void;
    }
  /**
   * A fixed set of alternatives, shown as buttons rather than a dropdown.
   *
   * Used where choosing an option changes the rest of the panel. A native
   * `<select>` fires `change` *while its popup is still open*, so rebuilding the
   * panel in that handler tore the control out from under the interaction and the
   * choice was lost — the preset picker could not be used at all. Buttons finish
   * their click before anything is rebuilt, so there is nothing to race against,
   * and every option is visible without being opened.
   */
  | {
      kind: "choices";
      label: string;
      help?: string;
      options: [string, string][];
      get: () => string;
      set: (value: string) => void;
    }
  | {
      kind: "number";
      label: string;
      help?: string;
      min: number;
      max: number;
      suffix?: string;
      get: () => number;
      set: (value: number) => void;
    }
  | {
      kind: "text";
      label: string;
      help?: string;
      placeholder?: string;
      get: () => string;
      set: (value: string) => void;
    }
  | {
      kind: "button";
      label: string;
      help?: string;
      text: string;
      action: () => void | Promise<void>;
    };

interface Section {
  id: string;
  title: string;
  rows: Row[];
}

/** Everything a row can be found by, lower-cased once. */
function rowSearchText(row: Row): string {
  const parts: string[] = [row.label];
  if ("help" in row && row.help) parts.push(row.help);
  if (row.kind === "note" || row.kind === "button") parts.push(row.text);
  if (row.kind === "select" || row.kind === "choices") {
    for (const [, label] of row.options) parts.push(label);
  }
  return parts.join(" ").toLowerCase();
}

/**
 * Every query word must occur somewhere in the text.
 *
 * `includes` alone already made each word a partial match; requiring all words
 * rather than the whole phrase lets "locations recent" find "Recent Locations".
 */
function matchesTerms(text: string, terms: string[]): boolean {
  const haystack = text.toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

function rowMatches(row: Row, terms: string[]): boolean {
  return matchesTerms(rowSearchText(row), terms);
}

/**
 * Keep the rows a query names, with a group heading for context.
 *
 * A heading is a searchable category. When "Recent Locations" matches, its
 * whole group comes with it — the settings underneath are not expected to
 * repeat the group's word. A matching setting stays under its heading, and a
 * heading with neither a matching name nor a matching row disappears.
 */
function filterSection(section: Section, terms: string[]): Section | null {
  // A section's own name stands for all of it.
  if (matchesTerms(section.title, terms)) return section;

  const rows: Row[] = [];
  let heading: Row | null = null;
  let grouped: Row[] = [];
  let matched = false;

  const flush = (): void => {
    if (heading === null && grouped.length === 0) return;

    if (heading !== null && rowMatches(heading, terms)) {
      rows.push(heading, ...grouped);
      matched = true;
    } else {
      const hits = grouped.filter((row) => rowMatches(row, terms));
      if (hits.length > 0) {
        if (heading !== null) rows.push(heading);
        rows.push(...hits);
        matched = true;
      }
    }

    heading = null;
    grouped = [];
  };

  for (const row of section.rows) {
    if (row.kind === "heading") {
      flush();
      heading = row;
    } else {
      grouped.push(row);
    }
  }
  flush();

  return matched ? { ...section, rows } : null;
}

// ---------------------------------------------------------------------------
// Typography
// ---------------------------------------------------------------------------

/**
 * The first family named in a `font-family` stack, without its quotes.
 *
 * Used to decide which face a dropdown should report for a setting written by a
 * preset, an older version, or by hand.
 */
function firstFamily(stack: string): string {
  const first = stack.split(",")[0] ?? "";
  return first.trim().replace(/^["']|["']$/g, "");
}

/**
 * A stack that begins with `family` and keeps the role's own fallbacks behind it.
 *
 * The tail is what makes the choice safe: a family with nothing behind it renders
 * as whatever the machine happens to have, and a missing face would fall through
 * to the browser's default serif in the middle of a code block.
 */
function stackWith(family: string, fallback: string): string {
  const quoted = /\s/.test(family) ? `"${family}"` : family;
  const tail = fallback
    .split(",")
    .map((part) => part.trim())
    .slice(1)
    // The chosen face is often already in the fallback tail — choosing
    // "Segoe UI" used to produce `"Segoe UI", "Segoe UI", …`.
    .filter((part) => part.replace(/^["']|["']$/g, "") !== family);
  return [quoted, ...tail].join(", ");
}

/**
 * The value a face picker reports for a role's stored stack.
 *
 * The built-in stack is represented by the empty string, which is also how the
 * settings spell "use the default". Everything else is reported by the face it
 * begins with, because that is the only decision a single dropdown can express.
 */
function fontSelection(role: TypographyRole, raw: string): string {
  const current = raw || role.fallback;
  if (current === role.fallback) return "";
  const family = firstFamily(current);
  return FONT_SUGGESTIONS.includes(family) ? family : current;
}

/**
 * Options for one face picker.
 *
 * A stack whose first family is not one of the suggestions is added as a custom
 * entry, so a setting from an older version or from a hand-edited settings.json
 * stays visible instead of leaving the control blank — or, worse, being silently
 * replaced the first time the panel is opened.
 */
function fontOptions(role: TypographyRole, raw: string): [string, string][] {
  const options: [string, string][] = [["", "Default (built-in stack)"]];
  for (const family of FONT_SUGGESTIONS) options.push([family, family]);
  const current = raw || role.fallback;
  const family = firstFamily(current);
  if (current !== role.fallback && !FONT_SUGGESTIONS.includes(family)) {
    options.push([current, `Custom — ${family || current}`]);
  }
  return options;
}

/**
 * The typography section: presets, then one row per role, then the OpenType
 * decisions that a family name alone does not express.
 *
 * The preset picker exists because choosing type is a pairing problem, not a
 * font problem. Each preset is a complete system, and the fields below it are
 * there to be dismantled by someone who already knows what they want.
 *
 * Each face is one dropdown. A text field for the CSS stack and a specimen
 * beneath it were two more ways to say the same thing — and the stack field
 * could be typed into, which made the picker beside it ambiguous. The stack is
 * still what gets stored; it is just no longer a second control.
 */
function typographyRows(host: PreferencesHost): Row[] {
  const s = () => host.settings();
  const overrides = () => s().presetOverrides ?? {};

  /**
   * Remember a size for the active preset, or keep it global under Custom.
   *
   * The top-level value is always written: it is what the editor, preview and
   * exports read. The map entry is what makes the next visit to the same preset
   * restore the reader's choice.
   */
  const updateSize = (key: "editorFontSize" | "bodyFontSize" | "mathFontScale", value: number) => {
    const preset = activePreset(host);
    if (!preset) {
      host.update({ [key]: value } as Partial<api.Settings>);
      return;
    }
    const next = { ...overrides() };
    next[preset.id] = { ...next[preset.id], [key]: value };
    host.update({ [key]: value, presetOverrides: next } as Partial<api.Settings>);
  };

  const rows: Row[] = [
    {
      kind: "choices",
      label: "Preset",
      help: "Sets the faces and OpenType options below at once. Editor font size, Preview font size and Math scale are remembered separately for each preset; switching back restores them. Changing a face leaves the preset — nothing is locked.",
      options: [
        ...TYPOGRAPHY_PRESETS.map((preset) => [preset.id, preset.label] as [string, string]),
        // Always present, so the control is never blank: it is what the picker
        // shows once a field below has been edited away from every preset.
        ["custom", "Custom"],
      ],
      // The preset's identity is detected from its fixed values; the three sizes
      // are remembered separately in `presetOverrides`. Picking a preset writes
      // both, and the picker then reports whichever identity is in force.
      get: () => activePreset(host)?.id ?? "custom",
      set: (value) => {
        const preset = TYPOGRAPHY_PRESETS.find((entry) => entry.id === value);
        if (!preset) return;

        // The preset being left keeps the sizes the reader gave it. This is
        // also the lazy migration for a settings file written before
        // `presetOverrides` existed: the current globals become its entry.
        const next = { ...overrides() };
        const current = activePreset(host);
        if (current) {
          const entry = { ...next[current.id] };
          if (entry.editorFontSize === undefined) entry.editorFontSize = s().editorFontSize;
          if (entry.bodyFontSize === undefined) entry.bodyFontSize = s().bodyFontSize;
          if (entry.mathFontScale === undefined) entry.mathFontScale = s().mathFontScale;
          next[current.id] = entry;
        }

        const remembered = next[preset.id] ?? {};
        host.update({
          ...preset.values,
          editorFontSize:
            remembered.editorFontSize ??
            preset.defaults?.editorFontSize ??
            DEFAULT_EDITOR_FONT_SIZE,
          bodyFontSize:
            remembered.bodyFontSize ?? preset.defaults?.bodyFontSize ?? DEFAULT_BODY_FONT_SIZE,
          mathFontScale:
            remembered.mathFontScale ?? preset.defaults?.mathFontScale ?? DEFAULT_MATH_SCALE,
          presetOverrides: next,
        } as Partial<api.Settings>);
      },
    },
    {
      kind: "note",
      label: "",
      text:
        activePreset(host)?.note ??
        "Set by hand, so no preset matches exactly. The four faces below are the ones in use.",
    },
    { kind: "heading", label: "Faces" },
    {
      kind: "number",
      label: "Editor font size",
      help: "Source text in the editor. Remembered for the active preset; under Custom it applies to the current setup.",
      min: 10,
      max: 40,
      suffix: "px",
      get: () => s().editorFontSize,
      set: (value) => updateSize("editorFontSize", value),
    },
  ];

  for (const role of TYPOGRAPHY_ROLES) {
    const raw = () => s()[role.id];
    rows.push({
      kind: "select",
      label: role.label,
      help: role.help,
      options: fontOptions(role, raw()),
      // Report the face actually in use, not the whole stack: the fallback tail
      // is an implementation detail, and showing it here is what made the old
      // text field look like a second, competing picker.
      get: () => fontSelection(role, raw()),
      set: (value) => {
        if (value === fontSelection(role, raw())) return;
        // "" is how the settings spell "the built-in stack"; every other value
        // is a family, and the role's own fallbacks are rebuilt behind it.
        host.update({
          [role.id]: value === "" ? "" : stackWith(value, role.fallback),
        } as Partial<api.Settings>);
      },
    });
  }

  rows.push(
    {
      kind: "number",
      label: "Preview font size",
      help: "Prose in the preview and in exports. Remembered for the active preset; under Custom it applies to the current setup.",
      min: 11,
      max: 32,
      suffix: "px",
      get: () => s().bodyFontSize,
      set: (value) => updateSize("bodyFontSize", value),
    },
    {
      kind: "number",
      label: "Math scale",
      help: "Scales the mathematics in the preview and in exports. KaTeX draws formulas at 121% of the surrounding text, so about 83% makes them match the prose; 100% leaves KaTeX's own ratio alone. Remembered for the active preset; under Custom it applies to the current setup.",
      min: 70,
      max: 130,
      suffix: "%",
      get: () => s().mathFontScale,
      set: (value) => updateSize("mathFontScale", value),
    },
    {
      kind: "note",
      label: "Bundled faces",
      text: "The bundled families are under the SIL Open Font License, so they look the same on every machine and travel inside exported HTML and PDF. Any other family comes from your operating system: it renders here, but a reader without it sees a fallback.",
    },
    { kind: "heading", label: "OpenType" },
    {
      kind: "checkbox",
      label: "Ligatures in code",
      help: "Turns the programming ligatures of faces that have them — JetBrains Mono draws `->`, `=>` and `!=` as single glyphs. Off by default, because whether a source file should look like that is a real disagreement.",
      get: () => s().ligaturesInCode,
      set: (value) => host.update({ ligaturesInCode: value }),
    },
    {
      kind: "checkbox",
      label: "Tabular figures in tables",
      help: "Gives every digit the same width so columns of numbers line up. Worth leaving on: proportional figures in a table are one of the few typographic choices that is simply wrong.",
      get: () => s().tabularFigures,
      set: (value) => host.update({ tabularFigures: value }),
    },
    {
      kind: "checkbox",
      label: "Oldstyle figures in prose",
      help: "Figures with ascenders and descenders, so 1,234 sits in running text instead of shouting. Needs a face that has them; Source Serif 4 and Georgia do.",
      get: () => s().oldstyleFigures,
      set: (value) => host.update({ oldstyleFigures: value }),
    },
    {
      kind: "checkbox",
      label: "Slashed zero in code",
      help: "Distinguishes 0 from capital O. Turns on tabular figures with it, since code is read in columns.",
      get: () => s().slashedZero,
      set: (value) => host.update({ slashedZero: value }),
    },
  );

  return rows;
}

/**
 * The preset whose values match the settings exactly, if any.
 *
 * Compares the *resolved* value for the font fields, because an empty setting
 * means "the built-in default for that role" — comparing the raw string would
 * make every fresh installation report "custom", which is precisely backwards.
 *
 * Editor font size, Preview font size and Math scale are deliberately absent
 * from `values`: they are reader adjustments in `presetOverrides`, so editing
 * one does not make the active preset look custom.
 */
function activePreset(host: PreferencesHost): TypographyPreset | null {
  const settings = host.settings() as unknown as Record<string, unknown>;
  const resolve = (key: string): unknown => {
    const raw = settings[key];
    const role = TYPOGRAPHY_ROLES.find((entry) => entry.id === key);
    if (role && (raw === "" || raw === undefined || raw === null)) return role.fallback;
    return raw;
  };
  return (
    TYPOGRAPHY_PRESETS.find((preset) =>
      Object.entries(preset.values).every(([key, value]) => resolve(key) === value),
    ) ?? null
  );
}

// ---------------------------------------------------------------------------
// Export targets
// ---------------------------------------------------------------------------

/**
 * Which export target the panel is editing.
 *
 * Kept outside `buildSections` because that function runs on every redraw, and
 * the panel would otherwise snap back to the first format each time a field
 * committed.
 */
let editingExport: string | null = null;

function patchFormat(host: PreferencesHost, id: string, patch: Partial<api.ExportFormat>): void {
  const next = host
    .settings()
    .exportFormats.map((format) => (format.id === id ? { ...format, ...patch } : format));
  host.update({ exportFormats: next });
}

function addFormat(host: PreferencesHost): void {
  const existing = host.settings().exportFormats;
  // The id is what the menu entry and the saved settings key off, so it is
  // generated here rather than typed: naming a format must not be able to
  // change its identity, or every rename would orphan the menu entry.
  let n = 1;
  while (existing.some((format) => format.id === `custom${n}`)) n += 1;
  const created: api.ExportFormat = {
    ...api.emptyExportFormat(),
    id: `custom${n}`,
    label: `Custom ${n}`,
    // .docx is the friendliest starting point: pandoc writes it with no extra
    // arguments and no LaTeX installation.
    extension: "docx",
  };
  editingExport = created.id;
  host.update({ exportFormats: [...existing, created] });
}

function removeFormat(host: PreferencesHost, id: string): void {
  const next = host.settings().exportFormats.filter((format) => format.id !== id);
  editingExport = next[0]?.id ?? null;
  host.update({ exportFormats: next });
}

function exportRows(host: PreferencesHost): Row[] {
  const formats = host.settings().exportFormats;
  const status = host.pandocStatus();

  const rows: Row[] = [
    {
      kind: "note",
      label: "Pandoc",
      text: status
        ? status.found
          ? `${status.version ?? "Found"} at ${status.path}${
              status.source === "managed" ? " (installed by MDraft)" : ""
            }.${
              status.pdfEngine
                ? ` PDF export will use ${status.pdfEngine}.`
                : " No PDF engine was found. PDF needs Typst — use Help › Install Typst. Every other format works without it."
            }`
          : "Not found. Word, PDF, EPUB and the other formats below need it; HTML does not."
        : "Checking…",
    },
    {
      kind: "button",
      label: "",
      text: status?.found ? "Reinstall or update pandoc" : "Find or install pandoc",
      action: () => host.setupPandoc(),
    },
    {
      kind: "note",
      label: "Typst",
      text: "Typst is what typesets PDFs: a single executable with no dependencies, where the LaTeX route it replaced wanted a TeX distribution of several gigabytes. The same program draws the preview of .typ documents.",
    },
    {
      kind: "button",
      label: "",
      text: "Install or check Typst",
      help: "Downloads the official Typst build into the application's own data folder. Nothing is installed system-wide and no administrator rights are needed.",
      action: () => host.setupTypst(),
    },
    {
      kind: "note",
      label: "HTML and PDF",
      text: "Both are produced by MDraft from the same pipeline that draws the preview, so neither needs pandoc. PDF is printed by your browser, which is why it asks you to choose “Save as PDF”. Everything below this point is a pandoc format and needs pandoc installed; the PDFs it makes are typeset by Typst.",
    },
  ];

  // After-export options are global, not per format.
  //
  // They used to sit inside the format editor, which made a ticked box apply
  // only to that one target: it did nothing when the user exported HTML, the
  // browser-printed PDF, or a different pandoc format. A single block that
  // every export consults is both what Typora calls the General setting and
  // what the user expected when reporting the option as broken.
  const currentSettings = host.settings();
  rows.push(
    { kind: "heading", label: "After Export" },
    {
      kind: "checkbox",
      label: "Open the exported file's folder",
      get: () => host.settings().afterOpenLocation,
      set: (value) => host.update({ afterOpenLocation: value }),
    },
    {
      kind: "checkbox",
      label: "Open the exported file",
      get: () => host.settings().afterOpenFile,
      set: (value) => host.update({ afterOpenFile: value }),
    },
    {
      kind: "checkbox",
      label: "Run a command",
      help: "Runs your own command after a successful export. ${outputPath} is replaced with the file that was written.",
      get: () => host.settings().afterRunCommand,
      set: (value) => host.update({ afterRunCommand: value }),
    },
  );

  if (currentSettings.afterRunCommand) {
    rows.push({
      kind: "text",
      label: "Command",
      placeholder: "xdg-open ${outputPath}",
      get: () => host.settings().afterCommand,
      set: (value) => host.update({ afterCommand: value }),
    });
  }

  rows.push(
    {
      // The browser chooses the PDF's path in its own print dialog, so there is
      // no path for MDraft to reveal or open. Saying so is better than a second
      // pair of checkboxes that could never be honoured.
      kind: "note",
      label: "PDF (Print)",
      text: "PDF (Print) hands the document to your browser, which asks you where to save it. MDraft never learns that path, so these options do not run for it — they do run for HTML, Typst and every pandoc format.",
    },
    { kind: "heading", label: "Formats" },
  );

  if (formats.length === 0) {
    rows.push({
      kind: "note",
      label: "None",
      text: "Every pandoc format has been removed, so File › Export offers HTML only.",
    });
  } else {
    const current = formats.find((f) => f.id === editingExport) ?? formats[0];
    editingExport = current.id;

    rows.push(
      {
        kind: "select",
        label: "Editing",
        options: formats.map((f) => [f.id, f.label] as [string, string]),
        get: () => current.id,
        set: (value) => {
          editingExport = value;
        },
      },
      {
        kind: "text",
        label: "Menu Label",
        get: () => current.label,
        set: (value) => patchFormat(host, current.id, { label: value }),
      },
      {
        kind: "text",
        label: "Extension",
        help: "Without the dot. Pandoc also infers the output format from it, which is why the arguments below mostly do not need a -t.",
        get: () => current.extension,
        set: (value) => patchFormat(host, current.id, { extension: value.replace(/^\./, "") }),
      },
      {
        kind: "text",
        label: "Arguments",
        help: "Passed to pandoc as separate arguments, so a path with spaces needs no quoting. ${inputPath}, ${outputPath}, ${styleReference} and ${pdfEngine} are substituted; a token whose placeholder is empty disappears entirely, which is how --reference-doc=${styleReference} is simply omitted when no style reference is chosen.",
        get: () => current.arguments,
        set: (value) => patchFormat(host, current.id, { arguments: value }),
      },
      {
        kind: "text",
        label: "Extra Arguments",
        help: "Appended after the arguments above, so a switch here overrides one there.",
        placeholder: "--toc --number-sections",
        get: () => current.extraArguments,
        set: (value) => patchFormat(host, current.id, { extraArguments: value }),
      },
      {
        kind: "text",
        label: "Style Reference",
        help: "A reference .docx/.odt for Word and OpenDocument, or a .css for EPUB, depending on what the arguments above expect.",
        get: () => current.styleReference,
        set: (value) => patchFormat(host, current.id, { styleReference: value }),
      },
      {
        kind: "button",
        label: "",
        text: current.styleReference ? "Change style reference…" : "Choose a style reference…",
        action: async () => {
          const chosen = await host.chooseStyleReference(current.styleReference);
          if (chosen) patchFormat(host, current.id, { styleReference: chosen });
        },
      },
    );

    if (current.styleReference) {
      rows.push({
        kind: "button",
        label: "",
        text: "Clear the style reference",
        action: () => patchFormat(host, current.id, { styleReference: "" }),
      });
    }

    rows.push(
      { kind: "heading", label: "Manage" },
      {
        kind: "button",
        label: "",
        text: "Add a format",
        action: () => addFormat(host),
      },
      {
        kind: "button",
        label: "",
        text: `Remove “${current.label}”`,
        action: () => removeFormat(host, current.id),
      },
    );
  }

  return rows;
}

function buildSections(host: PreferencesHost): Section[] {
  const s = () => host.settings();

  return [
    {
      id: "files",
      title: "Files",
      rows: [
        {
          kind: "select",
          label: "On Launch",
          help: "Reopen the last tabs restores every saved document that was open when MDraft last closed, in the same tab order with the same one active. Only paths are remembered: untitled or unsaved content is not restored, and a file that has been deleted is skipped.",
          options: [
            ["welcome", "Show the welcome document"],
            ["new", "Open a new file"],
            ["last", "Reopen the most recent file"],
            ["tabs", "Reopen the last tabs"],
          ],
          get: () => s().onLaunch,
          set: (value) => host.update({ onLaunch: value as api.OnLaunch }),
        },
        {
          kind: "select",
          label: "Default File Extension",
          help: "Used for Save As and for a new document. Typst starts the editor in Typst mode, HTML in HTML mode, AsciiDoc in AsciiDoc mode; the other choices start in Markdown.",
          options: [
            ["md", "Markdown (.md)"],
            ["markdown", "Markdown (.markdown)"],
            ["txt", "Plain text (.txt)"],
            ["typ", "Typst (.typ)"],
            ["html", "HTML (.html)"],
            ["adoc", "AsciiDoc (.adoc)"],
            ["asciidoc", "AsciiDoc (.asciidoc)"],
          ],
          get: () => s().defaultExtension,
          set: (value) => host.update({ defaultExtension: value }),
        },
        {
          kind: "checkbox",
          label: "Auto Save",
          help: "Saves the current file every 20 seconds once it has a path on disk.",
          get: () => s().autoSave,
          set: (value) => host.update({ autoSave: value }),
        },
        { kind: "heading", label: "Recent Locations" },
        {
          kind: "checkbox",
          label: "Record Recent Files",
          get: () => s().recordRecent,
          set: (value) => host.update({ recordRecent: value }),
        },
        {
          kind: "button",
          label: "",
          text: "Clear Recent Files",
          action: () => host.clearRecent(),
        },
        { kind: "heading", label: "File Tree / Library" },
        {
          kind: "checkbox",
          label: "Show Hidden Folders and Files",
          help: "Entries whose name starts with a dot.",
          get: () => s().showHiddenFiles,
          set: (value) => host.update({ showHiddenFiles: value }),
        },
      ],
    },
    {
      id: "editor",
      title: "Editor",
      rows: [
        {
          kind: "checkbox",
          label: "Convert Rich Text on Paste",
          help: "Content copied to clipboard from another application are converted into the document's markup. Untick to always paste the clipboard's in plain text. Ctrl/Cmd+Shift+V bypasses the conversion once.",
          get: () => s().richPaste,
          set: (value) => host.update({ richPaste: value }),
        },
        { kind: "heading", label: "Auto-close" },
        {
          kind: "checkbox",
          label: "Auto-close brackets and quotes",
          help: "Typing ( [ { ' \" or ` inserts the closing character, typing it again steps over it, and Backspace between the pair deletes both. A selection is wrapped instead.",
          get: () => s().autoClosePairs,
          set: (value) => host.update({ autoClosePairs: value }),
        },
        {
          kind: "checkbox",
          label: "Auto-close HTML tags",
          help: "Typing the > of an opening tag in an HTML, Markdown or AsciiDoc document inserts the matching closing tag. Void elements, self-closing tags, autolinks and code are left alone.",
          get: () => s().autoCloseTags,
          set: (value) => host.update({ autoCloseTags: value }),
        },
        {
          kind: "select",
          label: "Content Width",
          options: [
            ["860", "Narrow"],
            ["980", "Comfortable"],
            ["1180", "Wide"],
            ["0", "Full width"],
          ],
          get: () => String(s().editorMaxWidth),
          set: (value) => host.update({ editorMaxWidth: Number(value) }),
        },
        {
          kind: "select",
          label: "Line Height",
          help: "Spacing between lines in the source pane: Compact is 1.3× the font size, Normal 1.5× and Wide 1.8×. The preview keeps its own reading line height.",
          options: [
            ["compact", "Compact"],
            ["normal", "Normal"],
            ["wide", "Wide"],
          ],
          // A hand-edited settings file may contain a name this build does not
          // know; show Normal rather than leaving the control blank.
          get: () =>
            EDITOR_LINE_HEIGHTS[s().editorLineHeight] !== undefined
              ? s().editorLineHeight
              : DEFAULT_EDITOR_LINE_HEIGHT,
          set: (value) => {
            if (value === "compact" || value === "normal" || value === "wide") {
              host.update({ editorLineHeight: value });
            }
          },
        },
        {
          kind: "checkbox",
          label: "Focus Mode",
          help: "Dims every line except the one holding the caret.",
          get: () => s().focusMode,
          set: (value) => host.update({ focusMode: value }),
        },
        {
          kind: "checkbox",
          label: "Typewriter Mode",
          help: "Keeps the caret vertically centred while typing.",
          get: () => s().typewriterMode,
          set: (value) => host.update({ typewriterMode: value }),
        },
        {
          kind: "checkbox",
          label: "Synchronise Scroll",
          help: "Keeps the two panes aligned while you scroll. Clicking in either pane always jumps the other one to the same content, and the block matching the caret is highlighted.",
          get: () => s().syncScroll,
          set: (value) => host.update({ syncScroll: value }),
        },
        {
          kind: "checkbox",
          label: "Show Status Bar",
          get: () => s().showStatusBar,
          set: (value) => host.update({ showStatusBar: value }),
        },
        { kind: "heading", label: "Spelling" },
        {
          kind: "checkbox",
          label: "Check spelling while typing",
          help: "Underlines words the installed dictionary does not recognise. Code, URLs and mathematics are skipped.",
          get: () => s().spellcheck,
          set: (value) => host.update({ spellcheck: value }),
        },
        {
          kind: "select",
          label: "Dictionary",
          help: "Automatic needs a few sentences of prose. Only dictionaries installed on this system are listed.",
          options: dictionaryOptions(s().spellcheckLanguage),
          get: () => s().spellcheckLanguage,
          set: (value) => host.update({ spellcheckLanguage: value }),
        },
        ...(spellcheckAvailabilityNote()
          ? [{ kind: "note" as const, label: "", text: spellcheckAvailabilityNote() ?? "" }]
          : []),
      ],
    },
    {
      id: "image",
      title: "Image",
      rows: [
        {
          kind: "select",
          label: "When Insert…",
          help: "What happens to an image you paste, drop or insert. Applies to clipboard bitmaps, local files and downloaded URLs.",
          options: [
            ["assetsFolder", "Copy image to ./${filename}.assets"],
            ["assetsDir", "Copy image to ./assets"],
            ["custom", "Copy image to a custom folder"],
            ["keepOriginal", "Keep the original location"],
          ],
          get: () => s().imageRule,
          set: (value) => host.update({ imageRule: value as api.ImageRule }),
        },
        {
          kind: "text",
          label: "Custom Folder",
          help: "Used by the custom rule. A relative path is resolved against the document's folder. ${filename} expands to the document name.",
          placeholder: "media  or  D:\\pictures",
          get: () => s().imageCustomDir,
          set: (value) => host.update({ imageCustomDir: value }),
        },
        {
          kind: "checkbox",
          label: "Apply Above Rules to Local Images",
          help: "Untick to link pasted local files in place instead of copying them.",
          get: () => s().imageApplyLocal,
          set: (value) => host.update({ imageApplyLocal: value }),
        },
        {
          kind: "checkbox",
          label: "Apply Above Rules to Online Images",
          help: "When ticked, pasting an image URL on its own downloads it. When unticked, the URL is inserted as-is and nothing is fetched. Images inside pasted rich text have their own option below.",
          get: () => s().imageApplyOnline,
          set: (value) => host.update({ imageApplyOnline: value }),
        },
        {
          kind: "select",
          label: "Remote Images in Pasted Rich Text",
          help: "Applies to remote images inside formatted text pasted from a browser or another editor. Download and save writes them to the document's assets folder and contacts their hosts; Keep the original URL makes no request. A URL you paste on its own still follows the option above.",
          options: [
            ["download", "Download and save"],
            ["url", "Keep the original URL"],
          ],
          get: () => s().richPasteImages,
          set: (value) => host.update({ richPasteImages: value as "download" | "url" }),
        },
        { kind: "heading", label: "Preferred Image Syntax" },
        {
          kind: "checkbox",
          label: "Use Relative Path if Possible",
          help: "Falls back to an absolute path when the image is on another drive.",
          get: () => s().imageUseRelativePath,
          set: (value) => host.update({ imageUseRelativePath: value }),
        },
        {
          kind: "checkbox",
          label: "Add ./ for Relative Path",
          help: "Writes ./notes.assets/a.png rather than notes.assets/a.png.",
          get: () => s().imageAddDotSlash,
          set: (value) => host.update({ imageAddDotSlash: value }),
        },
        {
          kind: "checkbox",
          label: "Auto Escape Image URL When Insert",
          help: "Percent-escapes spaces and brackets so the path cannot break the link syntax.",
          get: () => s().imageAutoEscape,
          set: (value) => host.update({ imageAutoEscape: value }),
        },
      ],
    },
    {
      id: "markdown",
      title: "Markdown",
      rows: [
        {
          kind: "checkbox",
          label: "Enable Math",
          help: "Renders $inline$ and $$display$$ with KaTeX.",
          get: () => s().enableMath,
          set: (value) => host.update({ enableMath: value }),
        },
        {
          kind: "checkbox",
          label: "Enable Diagrams",
          help: "Renders ```mermaid fences as diagrams.",
          get: () => s().enableMermaid,
          set: (value) => host.update({ enableMermaid: value }),
        },
        {
          kind: "note",
          label: "Extensions",
          text: "GitHub alerts (> [!NOTE]), task lists, tables, [TOC] and YAML front matter are always enabled. Math inside code spans and fenced blocks is never transformed.",
        },
      ],
    },
    {
      id: "html",
      title: "HTML",
      rows: [
        {
          kind: "checkbox",
          label: "Run scripts in the HTML preview",
          help: "The preview runs in a sandboxed frame. Turning this off blocks the document's scripts while keeping its CSS, images, scroll sync and the preview itself. The bridge that keeps the panes in sync is trusted application code and still runs.",
          get: () => s().htmlPreviewScripts !== false,
          set: (value) => host.update({ htmlPreviewScripts: value }),
        },
        {
          kind: "note",
          label: "Sandbox",
          text: "An HTML preview behaves like a local page: it may read and run files in its own folder and load the network resources it references. It cannot reach the editor, its files outside that folder, or MDraft's commands. Math and diagram settings above apply to Markdown and Typst; an HTML document uses its own libraries.",
        },
      ],
    },
    {
      id: "export",
      title: "Export",
      rows: [
        {
          kind: "button",
          label: "",
          text: "Export the current document as HTML…",
          action: () => host.exportHtml(),
        },
        {
          kind: "button",
          label: "",
          text: "Export the current document as PDF…",
          help: "Opens the document in your browser and prints it there, so you can choose “Save as PDF”. No LaTeX or other extra software is needed.",
          action: () => host.exportPdf(),
        },
        ...exportRows(host),
      ],
    },
    {
      id: "appearance",
      title: "Appearance",
      rows: [
        {
          kind: "select",
          label: "Theme",
          options: [
            ["system", "Follow system"],
            ["light", "Light"],
            ["dark", "Dark"],
          ],
          get: () => s().theme,
          set: (value) => host.update({ theme: value as api.ThemeMode }),
        },
        {
          kind: "select",
          label: "Editor Syntax Theme",
          help: "Colours the markdown source and any code inside fenced blocks. Each palette also sets the editor's own background, so a light palette stays readable while the application is dark.",
          options: PALETTE_OPTIONS,
          get: () => s().syntaxTheme,
          set: (value) => host.update({ syntaxTheme: value }),
        },
        {
          kind: "checkbox",
          label: "Show Sidebar",
          get: () => s().sidebarVisible,
          set: (value) => host.update({ sidebarVisible: value }),
        },
        {
          kind: "select",
          label: "Default Sidebar Panel",
          options: [
            ["outline", "Outline"],
            ["files", "File list"],
            ["recent", "Recent files"],
          ],
          get: () => s().sidebarTab,
          set: (value) => host.update({ sidebarTab: value as api.SidebarTab }),
        },
      ],
    },
    {
      id: "general",
      title: "General",
      rows: [
        { kind: "note", label: "Version", text: `MDraft ${host.version()}` },
        {
          kind: "note",
          label: "Formatting",
          text: "Format Document uses Prettier (MIT) for Markdown and HTML and Typstyle (Apache-2.0) for Typst. Both are bundled with MDraft and are loaded only the first time this command is used.",
        },
        {
          kind: "button",
          label: "",
          text: "Open the Markdown Reference",
          action: () => host.openDocumentation("reference"),
        },
        {
          kind: "button",
          label: "",
          text: "Open the Keyboard Shortcuts",
          action: () => host.openDocumentation("shortcuts"),
        },
        {
          kind: "button",
          label: "",
          text: "Font licences…",
          help: "The thirteen bundled typefaces are under the SIL Open Font License 1.1, which requires their copyright notices and licence texts to travel with them wherever they are redistributed. All are compiled into the application and shown here.",
          action: () => host.openDocumentation("licences"),
        },
        {
          kind: "note",
          label: "Settings file",
          text: "Preferences are stored as settings.json in the application config directory and are safe to edit by hand.",
        },
      ],
    },
    {
      id: "typography",
      title: "Typography",
      rows: typographyRows(host),
    },
  ];
}

export function createPreferences(host: PreferencesHost): PreferencesHandle {
  const overlay = document.createElement("div");
  overlay.className = "prefs-overlay";
  overlay.hidden = true;
  overlay.innerHTML = `
    <div class="prefs-panel" role="dialog" aria-label="Preferences">
      <header class="prefs-header">
        <h1 class="prefs-title">Preferences</h1>
        <button class="prefs-close" type="button" title="Close (Esc)" aria-label="Close">&#10005;</button>
      </header>
      <div class="prefs-body">
        <nav class="prefs-nav">
          <input class="prefs-search" type="search" placeholder="Search for…" aria-label="Search preferences" />
          <div class="prefs-sections" role="tablist"></div>
        </nav>
        <div class="prefs-content"></div>
      </div>
      <div class="prefs-resize" title="Drag to resize"></div>
    </div>`;

  const panelEl = overlay.querySelector<HTMLDivElement>(".prefs-panel")!;
  const headerEl = overlay.querySelector<HTMLElement>(".prefs-header")!;
  const resizeEl = overlay.querySelector<HTMLElement>(".prefs-resize")!;
  const sectionsEl = overlay.querySelector<HTMLDivElement>(".prefs-sections")!;
  const contentEl = overlay.querySelector<HTMLDivElement>(".prefs-content")!;
  const searchEl = overlay.querySelector<HTMLInputElement>(".prefs-search")!;
  const closeEl = overlay.querySelector<HTMLButtonElement>(".prefs-close")!;

  const PANEL_MARGIN = 8;
  const MIN_PANEL_WIDTH = 480;
  const MIN_PANEL_HEIGHT = 320;

  let activeId = buildSections(host)[0].id;
  let query = "";
  let placed = false;

  function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
  }

  function syncPanelWidth(): void {
    const width = panelEl.offsetWidth;
    panelEl.classList.toggle("is-compact", width < 820);
    panelEl.classList.toggle("is-narrow", width < 640);
  }

  /** Keep the card inside the webview and out from under the document tabs. */
  function layoutPanel(): void {
    const availableWidth = Math.max(1, overlay.clientWidth - PANEL_MARGIN * 2);
    const availableHeight = Math.max(1, overlay.clientHeight - PANEL_MARGIN * 2);

    // Inline sizes exist only after the reader has resized the card; the CSS
    // width/height already follow the viewport until then.
    if (panelEl.style.width) {
      const width = Number.parseFloat(panelEl.style.width);
      panelEl.style.width = `${Math.round(Math.min(width, availableWidth))}px`;
    }
    if (panelEl.style.height) {
      const height = Number.parseFloat(panelEl.style.height);
      panelEl.style.height = `${Math.round(Math.min(height, availableHeight))}px`;
    }

    syncPanelWidth();

    const width = panelEl.offsetWidth;
    const height = panelEl.offsetHeight;
    const maxLeft = Math.max(overlay.clientWidth - width - PANEL_MARGIN, PANEL_MARGIN);
    const maxTop = Math.max(overlay.clientHeight - height - PANEL_MARGIN, PANEL_MARGIN);

    if (!placed) {
      placed = true;
      const centeredTop = (overlay.clientHeight - height) / 2;
      panelEl.style.left = `${Math.round(
        clamp((overlay.clientWidth - width) / 2, PANEL_MARGIN, maxLeft),
      )}px`;
      panelEl.style.top = `${Math.round(clamp(Math.max(56, centeredTop), PANEL_MARGIN, maxTop))}px`;
      return;
    }

    const left = Number.parseFloat(panelEl.style.left) || 0;
    const top = Number.parseFloat(panelEl.style.top) || 0;
    panelEl.style.left = `${Math.round(clamp(left, PANEL_MARGIN, maxLeft))}px`;
    panelEl.style.top = `${Math.round(clamp(top, PANEL_MARGIN, maxTop))}px`;
  }

  let drag: { pointerId: number; x: number; y: number; left: number; top: number } | null = null;

  headerEl.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    if (event.target instanceof Element && event.target.closest("button")) return;
    event.preventDefault();
    drag = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      left: panelEl.offsetLeft,
      top: panelEl.offsetTop,
    };
    headerEl.setPointerCapture(event.pointerId);
    panelEl.classList.add("is-dragging");
  });

  headerEl.addEventListener("pointermove", (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const maxLeft = Math.max(
      overlay.clientWidth - panelEl.offsetWidth - PANEL_MARGIN,
      PANEL_MARGIN,
    );
    const maxTop = Math.max(
      overlay.clientHeight - panelEl.offsetHeight - PANEL_MARGIN,
      PANEL_MARGIN,
    );
    panelEl.style.left = `${Math.round(
      clamp(drag.left + event.clientX - drag.x, PANEL_MARGIN, maxLeft),
    )}px`;
    panelEl.style.top = `${Math.round(
      clamp(drag.top + event.clientY - drag.y, PANEL_MARGIN, maxTop),
    )}px`;
  });

  function endDrag(event: PointerEvent): void {
    if (!drag || event.pointerId !== drag.pointerId) return;
    drag = null;
    panelEl.classList.remove("is-dragging");
    if (headerEl.hasPointerCapture(event.pointerId)) {
      headerEl.releasePointerCapture(event.pointerId);
    }
  }

  headerEl.addEventListener("pointerup", endDrag);
  headerEl.addEventListener("pointercancel", endDrag);
  headerEl.addEventListener("lostpointercapture", endDrag);

  let resize: { pointerId: number; x: number; y: number; width: number; height: number } | null =
    null;

  resizeEl.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    resize = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      width: panelEl.offsetWidth,
      height: panelEl.offsetHeight,
    };
    resizeEl.setPointerCapture(event.pointerId);
    panelEl.classList.add("is-resizing");
  });

  resizeEl.addEventListener("pointermove", (event) => {
    if (!resize || event.pointerId !== resize.pointerId) return;
    const maxWidth = Math.max(overlay.clientWidth - panelEl.offsetLeft - PANEL_MARGIN, 1);
    const maxHeight = Math.max(overlay.clientHeight - panelEl.offsetTop - PANEL_MARGIN, 1);
    const minWidth = Math.min(MIN_PANEL_WIDTH, maxWidth);
    const minHeight = Math.min(MIN_PANEL_HEIGHT, maxHeight);
    panelEl.style.width = `${Math.round(
      clamp(resize.width + event.clientX - resize.x, minWidth, maxWidth),
    )}px`;
    panelEl.style.height = `${Math.round(
      clamp(resize.height + event.clientY - resize.y, minHeight, maxHeight),
    )}px`;
    syncPanelWidth();
  });

  function endResize(event: PointerEvent): void {
    if (!resize || event.pointerId !== resize.pointerId) return;
    resize = null;
    panelEl.classList.remove("is-resizing");
    if (resizeEl.hasPointerCapture(event.pointerId)) {
      resizeEl.releasePointerCapture(event.pointerId);
    }
  }

  resizeEl.addEventListener("pointerup", endResize);
  resizeEl.addEventListener("pointercancel", endResize);
  resizeEl.addEventListener("lostpointercapture", endResize);

  window.addEventListener("resize", () => {
    if (!overlay.hidden) layoutPanel();
  });

  function visibleSections(): Section[] {
    const all = buildSections(host);
    if (query.length === 0) return all;
    const terms = query.split(/\s+/).filter((term) => term.length > 0);
    if (terms.length === 0) return all;
    return all
      .map((section) => filterSection(section, terms))
      .filter((section): section is Section => section !== null);
  }

  function renderNav(sections: Section[]): void {
    sectionsEl.replaceChildren(
      ...sections.map((section) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "prefs-section";
        button.textContent = section.title;
        button.setAttribute("role", "tab");
        button.setAttribute("aria-selected", String(section.id === activeId));
        button.addEventListener("click", () => {
          activeId = section.id;
          render();
        });
        return button;
      }),
    );
  }

  function control(row: Row): HTMLElement | null {
    if (row.kind === "checkbox") {
      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = row.get();
      input.addEventListener("change", () => {
        row.set(input.checked);
        render();
      });
      return input;
    }

    if (row.kind === "choices") {
      const group = document.createElement("div");
      group.className = "prefs-choices";
      const current = row.get();
      for (const [value, label] of row.options) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "prefs-choice" + (value === current ? " active" : "");
        button.textContent = label;
        button.setAttribute("aria-pressed", String(value === current));
        button.addEventListener("click", () => {
          // Re-run even when the choice is already active. The preset picker
          // needs that to restore its remembered sizes after a hand-edited
          // global value; for every other choice the setter is idempotent.
          row.set(value);
          render();
        });
        group.appendChild(button);
      }
      return group;
    }

    if (row.kind === "select") {
      const select = document.createElement("select");
      for (const [value, label] of row.options) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = label;
        select.appendChild(option);
      }
      select.value = row.get();
      select.addEventListener("change", () => {
        row.set(select.value);
        render();
      });
      return select;
    }

    if (row.kind === "number") {
      const wrap = document.createElement("div");
      wrap.className = "prefs-number";
      const input = document.createElement("input");
      input.type = "number";
      input.min = String(row.min);
      input.max = String(row.max);
      input.value = String(row.get());
      input.addEventListener("change", () => {
        const value = Math.min(row.max, Math.max(row.min, Number(input.value) || row.min));
        row.set(value);
        render();
      });
      wrap.appendChild(input);
      if (row.suffix) {
        const suffix = document.createElement("span");
        suffix.textContent = row.suffix;
        wrap.appendChild(suffix);
      }
      return wrap;
    }

    if (row.kind === "text") {
      const input = document.createElement("input");
      input.type = "text";
      input.value = row.get();
      if (row.placeholder) input.placeholder = row.placeholder;
      // Commit on blur/Enter rather than on every keystroke: a change here
      // re-renders the panel and would otherwise fight the caret.
      input.addEventListener("change", () => {
        row.set(input.value);
        render();
      });
      return input;
    }

    if (row.kind === "button") {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "prefs-button";
      button.textContent = row.text;
      // Redraw once the action settles: adding, removing or reconfiguring an
      // export format all change which rows this panel should be showing.
      button.addEventListener("click", () => {
        void Promise.resolve(row.action()).finally(() => render());
      });
      return button;
    }

    return null;
  }

  function renderContent(sections: Section[]): void {
    const section = sections.find((s) => s.id === activeId) ?? sections[0];
    if (!section) {
      contentEl.replaceChildren();
      return;
    }
    activeId = section.id;

    const fragment = document.createDocumentFragment();
    const title = document.createElement("h2");
    title.className = "prefs-section-title";
    title.textContent = section.title;
    fragment.appendChild(title);

    for (const row of section.rows) {
      if (row.kind === "heading") {
        const heading = document.createElement("div");
        heading.className = "prefs-group";
        heading.textContent = row.label;
        fragment.appendChild(heading);
        continue;
      }

      const line = document.createElement("div");
      line.className = `prefs-row prefs-row-${row.kind}`;

      const label = document.createElement("div");
      label.className = "prefs-label";
      label.textContent = row.label;

      if (row.kind === "note") {
        const note = document.createElement("p");
        note.className = "prefs-note";
        note.textContent = row.text;
        line.appendChild(label);
        line.appendChild(note);
        fragment.appendChild(line);
        continue;
      }

      if ("help" in row && row.help) {
        const help = document.createElement("span");
        help.className = "prefs-help";
        help.textContent = "?";
        help.title = row.help;
        label.appendChild(help);
      }

      const cell = document.createElement("div");
      cell.className = "prefs-control";
      const widget = control(row);
      if (widget) cell.appendChild(widget);

      line.appendChild(label);
      line.appendChild(cell);
      fragment.appendChild(line);
    }

    contentEl.replaceChildren(fragment);
  }

  function render(): void {
    const sections = visibleSections();
    if (!sections.some((s) => s.id === activeId) && sections.length > 0) {
      activeId = sections[0].id;
    }
    renderNav(sections);
    renderContent(sections);
  }

  function open(): void {
    overlay.hidden = false;
    query = "";
    searchEl.value = "";
    render();
    layoutPanel();
    searchEl.focus();
  }

  function close(): void {
    overlay.hidden = true;
  }

  searchEl.addEventListener("input", () => {
    query = searchEl.value.trim().toLowerCase();
    render();
  });

  closeEl.addEventListener("click", close);

  overlay.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      close();
    }
  });

  document.body.appendChild(overlay);

  return {
    open,
    close,
    toggle: () => (overlay.hidden ? open() : close()),
    isOpen: () => !overlay.hidden,
    refresh: render,
  };
}
