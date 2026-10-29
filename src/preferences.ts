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
  DEFAULT_CODE_SCALE,
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
import { MAX_RATE, MIN_RATE, voiceAvailabilityNote, type VoiceOption } from "./read-aloud";
import { attachModelCombo, closeModelCombo } from "./model-combo";

export interface PreferencesHost {
  settings(): api.Settings;
  update(patch: Partial<api.Settings>): void;
  clearRecent(): void;
  /** Return the AI Assistant's floating button and panel to their defaults. */
  resetAssistantPosition(): void;
  /** Write the document as a standalone HTML file. */
  exportHtml(): void;
  /** Save the document to PDF through the native writer. */
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
  /** Installed speech-synthesis voices; empty until the list has loaded. */
  readAloudVoices(): VoiceOption[];
}

export interface PreferencesHandle {
  open(): void;
  /** Open on one section, for a menu command that points at it. */
  openAt(sectionId: string): void;
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
      /** Granularity of the spinner; 1 when omitted. */
      step?: number;
      suffix?: string;
      get: () => number;
      set: (value: number) => void;
    }
  | {
      kind: "text";
      label: string;
      help?: string;
      placeholder?: string;
      /** Fetched choices, read when the picker opens rather than at render time. */
      suggestions?: () => readonly string[];
      /** A short explanation printed under the field, e.g. why it was cleared. */
      fieldNote?: string;
      /** Redraw the panel after committing; false keeps a focus-adjacent button clickable. */
      rerender?: boolean;
      get: () => string;
      set: (value: string) => void;
    }
  | {
      kind: "secret";
      label: string;
      help?: string;
      placeholder: string;
      status: () => { hasKey: boolean; source: api.AiKeySource; warning: string | null };
      set: (value: string) => Promise<void>;
      clear: () => Promise<void>;
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

/**
 * Live state of the AI section.
 *
 * The key status is not a setting: it is an answer from the OS credential
 * store, refreshed when the section opens or the endpoint changes. Models come
 * from an explicit Fetch press.
 */
interface AiUiState {
  status: api.AiKeyStatus | null;
  /** `provider|baseUrl` the status belongs to. */
  endpoint: string;
  models: string[];
  /** `provider|baseUrl` that produced `models`, so another endpoint cannot reuse them. */
  modelsEndpoint: string;
  /** The saved id a successful fetch proved absent, for the field note. */
  clearedModel: string | null;
  error: string | null;
  message: string | null;
  loading: boolean;
}

/** Everything a row can be found by, lower-cased once. */
function rowSearchText(row: Row): string {
  const parts: string[] = [row.label];
  if ("help" in row && row.help) parts.push(row.help);
  if (row.kind === "note" || row.kind === "button") parts.push(row.text);
  if (row.kind === "select" || row.kind === "choices") {
    for (const [, label] of row.options) parts.push(label);
  }
  if (row.kind === "text" && row.suggestions) parts.push(...row.suggestions());
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
  const updateSize = (
    key: "editorFontSize" | "bodyFontSize" | "mathFontScale" | "codeFontScale",
    value: number,
  ) => {
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
      help: "Sets the faces and OpenType options below at once. Editor font size, Preview font size, Math scale and Code scale are remembered separately for each preset; switching back restores them. Changing a face leaves the preset — nothing is locked.",
      options: [
        ...TYPOGRAPHY_PRESETS.map((preset) => [preset.id, preset.label] as [string, string]),
        // Always present, so the control is never blank: it is what the picker
        // shows once a field below has been edited away from every preset.
        ["custom", "Custom"],
      ],
      // The preset's identity is detected from its fixed values; the four sizes
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
          if (entry.codeFontScale === undefined) entry.codeFontScale = s().codeFontScale;
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
          codeFontScale:
            remembered.codeFontScale ?? preset.defaults?.codeFontScale ?? DEFAULT_CODE_SCALE,
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
      kind: "number",
      label: "Code scale",
      help: "Scales fenced and inline code in the preview and in exports. 100% keeps the built-in ratio — a block at 86% of the prose and an inline span at 88% — and about 116% makes a block the same nominal size as the prose. A monospaced face still reads larger at that size, so match it by eye. Remembered for the active preset; under Custom it applies to the current setup.",
      min: 70,
      max: 130,
      suffix: "%",
      get: () => s().codeFontScale,
      set: (value) => updateSize("codeFontScale", value),
    },
    {
      kind: "note",
      label: "Bundled faces",
      text: "The bundled families are under the SIL Open Font License, so they look the same on every machine and travel inside exported HTML and PDF.",
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
 * Editor font size, Preview font size, Math scale and Code scale are
 * deliberately absent from `values`: they are reader adjustments in
 * `presetOverrides`, so editing one does not make the active preset look
 * custom.
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
                ? ` PDF (via Typst) will use ${status.pdfEngine}.`
                : " PDF (via Typst) needs Typst — use Tools › Check or Install Typst…. Native PDF and browser printing remain available."
            }`
          : "Not found. Word, EPUB, PDF (via Typst) conversion and the other Pandoc formats need it; native HTML/PDF do not."
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
      text: "Typst is a typesetting program: text and markup go in, a laid-out document comes out. In MDraft it draws both previews of .typ documents and compiles them to PDF; for the other languages, pandoc uses it as the PDF engine.",
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
      text: "Both use the preview pipeline and need no pandoc. PDF saves directly through the system webview. File › Export › PDF (opens browser) keeps browser printing available; PDF (via Typst) uses the compiler, with pandoc for conversion from other languages.",
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
      // pair of checkboxes that could never be honoured. The direct PDF writer
      // does know its path and runs these options normally.
      kind: "note",
      label: "PDF (opens browser)",
      text: "The browser PDF route asks you where to save, so MDraft never learns that path and these options do not run for it. They do run for the direct PDF, HTML, Typst and every pandoc format.",
    },
    { kind: "heading", label: "Formats" },
  );

  if (formats.length === 0) {
    rows.push({
      kind: "note",
      label: "None",
      text: "Every pandoc format has been removed, so File › Export offers HTML, PDF and PDF (opens browser) only.",
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

function aiStatusText(ai: AiUiState): string {
  const lines: string[] = [];
  if (ai.error) lines.push(ai.error);
  if (ai.status) {
    if (ai.status.hasKey) {
      lines.push(
        ai.status.source === "keychain"
          ? "Key: saved in the system credential store."
          : "Key: kept for this session only.",
      );
    } else {
      lines.push("Key: none saved for this endpoint; requests are sent without one.");
    }
    if (ai.status.warning) lines.push(ai.status.warning);
    if (!ai.status.keychainAvailable) {
      lines.push("The system credential store is unavailable on this machine.");
    }
  } else if (!ai.error) {
    lines.push("Key status: not checked yet.");
  }
  if (ai.message) lines.push(ai.message);
  // The success message already names the count. Repeating it as "N models
  // available from the last check" made the same answer read as two facts.
  const counted = ai.message?.includes(`${ai.models.length} models found`) ?? false;
  if (ai.models.length > 0 && !counted) {
    lines.push(`${ai.models.length} models available from the last check.`);
  }
  return lines.join(" ");
}

/**
 * The AI Assistant section.
 *
 * Every row is a real control: Enable, Provider, Base URL, the secret key, the
 * model, Fetch models and a status note. The key never enters settings.json;
 * the status note is the only place that says where it lives.
 */
function aiRows(host: PreferencesHost, ai: AiUiState, refresh: () => void): Row[] {
  const s = () => host.settings();
  const OPENAI = "https://api.openai.com/v1";
  const ANTHROPIC = "https://api.anthropic.com";

  /** The value currently typed in a text row, if that row is on screen. */
  const fieldValue = (label: string): string | null => {
    const row = [...document.querySelectorAll(".prefs-row")].find(
      (candidate) =>
        candidate.querySelector(".prefs-label")?.textContent?.replace(/\?$/, "") === label,
    );
    const input = row?.querySelector<HTMLInputElement>('input[type="text"]');
    return input ? input.value.trim() : null;
  };

  /**
   * The connection the reader sees, not only the one already persisted.
   *
   * A value typed into Base URL or Model is committed on blur, but pressing
   * Fetch (or Save) while the field still has focus used to send the previous
   * endpoint. Read the controls, persist what changed, and use those values.
   */
  const currentConnection = (): {
    provider: api.AiProvider;
    baseUrl: string;
    model: string;
  } => {
    const baseUrl = fieldValue("Base URL") ?? s().aiBaseUrl.trim();
    const model = fieldValue("Model") ?? s().aiModel.trim();
    const patch: Partial<api.Settings> = {};
    if (baseUrl !== s().aiBaseUrl) patch.aiBaseUrl = baseUrl;
    if (model !== s().aiModel) patch.aiModel = model;
    if (Object.keys(patch).length > 0) host.update(patch);
    return { provider: s().aiProvider, baseUrl, model };
  };

  const loadModels = async (
    provider: api.AiProvider,
    baseUrl: string,
    model: string,
    afterSave = false,
  ): Promise<void> => {
    const requested = `${provider}|${baseUrl.trim()}`;
    ai.loading = true;
    ai.error = null;
    ai.message = afterSave ? "Key saved. Fetching the model list…" : "Fetching the model list…";
    // A list belongs to the endpoint that returned it. A Base URL typed and
    // fetched without blurring never ran the row's setter, so drop the old
    // suggestions here as well as on the row.
    if (ai.modelsEndpoint !== requested) {
      ai.models = [];
      ai.modelsEndpoint = requested;
    }
    refresh();
    try {
      const reply = await api.aiFetchModels(provider, baseUrl, model);
      // A reply for an endpoint the reader has already left must not replace
      // the current list or clear the current model.
      if (`${s().aiProvider}|${s().aiBaseUrl.trim()}` !== requested) return;
      ai.models = reply.models;
      ai.modelsEndpoint = requested;
      // A later list that now offers the id the previous check cleared makes
      // that note stale; the field is still empty, so drop the explanation.
      if (ai.clearedModel && reply.models.includes(ai.clearedModel)) {
        ai.clearedModel = null;
      }
      const prefix = afterSave ? "Key saved. " : "";
      if (reply.models.length === 0) {
        ai.message = `${prefix}The endpoint returned no models; type the model id by hand.`;
      } else {
        ai.message = `${prefix}${reply.models.length} models found.`;
        // The field is a combobox, so the list is reachable even with a stale
        // value; clearing is reconciliation, not a workaround for the popup.
        // Only a successful, non-empty answer proves the saved id absent.
        const saved = s().aiModel.trim();
        if (saved && !reply.models.includes(saved)) {
          ai.clearedModel = saved;
          host.update({ aiModel: "" });
        }
      }
    } catch (error) {
      // A failed list request must not read as a failed save: the key is
      // already stored and remains usable. It must not erase a hand-typed id
      // either; an endpoint without a list is a supported configuration.
      ai.error = afterSave
        ? `Key saved, but the model list could not be read: ${String(error)}`
        : String(error);
      ai.message = afterSave ? "Key saved." : null;
    } finally {
      ai.loading = false;
      refresh();
    }
  };

  const saveKey = async (key: string): Promise<void> => {
    const { provider, baseUrl, model } = currentConnection();
    ai.error = null;
    ai.message = "Saving the key…";
    try {
      ai.status = await api.aiSetKey(provider, baseUrl, key);
      ai.endpoint = `${provider}|${baseUrl}`;
      await loadModels(provider, baseUrl, model, true);
    } catch (error) {
      ai.error = String(error);
      ai.message = null;
      refresh();
    }
  };

  const clearKey = async (): Promise<void> => {
    const { provider, baseUrl } = currentConnection();
    ai.error = null;
    ai.message = "Removing the key…";
    try {
      ai.status = await api.aiClearKey(provider, baseUrl);
      ai.endpoint = `${provider}|${baseUrl}`;
      ai.message = "Key removed.";
    } catch (error) {
      ai.error = String(error);
      ai.message = null;
    }
    refresh();
  };

  const fetchModels = async (): Promise<void> => {
    const { provider, baseUrl, model } = currentConnection();
    await loadModels(provider, baseUrl, model);
  };

  const offered =
    ai.models.length > 1 ? `one of the ${ai.models.length} fetched models` : "a fetched model";
  const clearedNote =
    ai.clearedModel && s().aiModel.trim() === ""
      ? `“${ai.clearedModel}” is not offered by this endpoint, so the field was cleared. Choose ${offered}, or type an id.`
      : undefined;

  return [
    {
      kind: "note",
      label: "Privacy",
      text: "The assistant contacts only the endpoint you configure, and only when you press Generate or fetch the model list. The selection and your instruction are the only document text that leaves this machine. The API key is stored safely in the operating system's credential store.",
    },
    {
      kind: "checkbox",
      label: "Enable AI Assistant",
      help: "Shows the floating button in the source pane and makes the Tools item and Ctrl/Cmd+Shift+Space open the action palette. Off by default: no request and no keychain read until you enable it and choose an endpoint and model.",
      get: () => s().aiEnabled,
      set: (value) => host.update({ aiEnabled: value }),
    },
    {
      kind: "button",
      label: "Floating button",
      text: "Reset position",
      help: "Returns the assistant button to the bottom-right corner of the source pane and the assistant panel to its default size. Both last for this session only.",
      action: () => host.resetAssistantPosition(),
    },
    {
      kind: "select",
      label: "Provider",
      help: "OpenAI-compatible covers OpenAI, DeepSeek, Ollama, LM Studio, llama.cpp, vLLM, OpenRouter and your own gateway. Anthropic uses the Messages API.",
      options: [
        ["openai", "OpenAI-compatible"],
        ["anthropic", "Anthropic"],
      ],
      get: () => s().aiProvider,
      set: (value) => {
        const provider = value as api.AiProvider;
        const current = s().aiBaseUrl.trim();
        let baseUrl = current;
        if (provider === "anthropic" && (current === "" || current === OPENAI)) {
          baseUrl = ANTHROPIC;
        }
        if (provider === "openai" && (current === "" || current === ANTHROPIC)) {
          baseUrl = OPENAI;
        }
        ai.endpoint = "";
        ai.status = null;
        ai.models = [];
        ai.modelsEndpoint = "";
        ai.clearedModel = null;
        host.update({ aiProvider: provider, aiBaseUrl: baseUrl });
      },
    },
    {
      kind: "text",
      label: "Base URL",
      help: "Include the version segment; the assistant appends /chat/completions or /v1/messages. A public gateway usually requires https:// — an http:// address outside your machine is unencrypted and may answer an empty 200.",
      placeholder: "https://api.openai.com/v1",
      rerender: false,
      get: () => s().aiBaseUrl,
      set: (value) => {
        ai.endpoint = "";
        ai.status = null;
        ai.models = [];
        ai.modelsEndpoint = "";
        ai.clearedModel = null;
        ai.error = null;
        ai.message = null;
        host.update({ aiBaseUrl: value.trim() });
      },
    },
    {
      kind: "secret",
      label: "API Key",
      help: "Optional. Local inference servers usually need no key; when none is saved the request goes out without an auth header. A hosted endpoint that needs one answers 401, and the error names it. Saving a key also requests the model list and fills the model suggestions. Stored in the OS credential store, keyed by provider and endpoint; after changing the scheme or host, save it again. When the store is unavailable the key is kept for this session only.",
      placeholder: ai.status?.hasKey
        ? "A key is saved — type to replace it"
        : "No key — optional for local servers",
      status: () => ({
        hasKey: ai.status?.hasKey ?? false,
        source: ai.status?.source ?? "none",
        warning: ai.status?.warning ?? null,
      }),
      set: saveKey,
      clear: clearKey,
    },
    {
      kind: "text",
      label: "Model",
      help: "The model id sent verbatim. The arrow lists every model the last Fetch returned and filters as you type; a server without a model list is fine, type the id by hand.",
      placeholder: "gpt-4o-mini, claude-sonnet-4-5, Qwen3.8-27B…",
      suggestions: () => ai.models,
      fieldNote: clearedNote,
      rerender: false,
      get: () => s().aiModel,
      set: (value) => {
        const model = value.trim();
        if (model) ai.clearedModel = null;
        host.update({ aiModel: model });
      },
    },
    {
      kind: "button",
      label: "",
      text: "Fetch model list",
      help: "Refreshes the model list. Saving a key already does this once; use this button after changing the endpoint or to retry.",
      action: fetchModels,
    },
    {
      kind: "note",
      label: "Status",
      text: aiStatusText(ai),
    },
  ];
}

/**
 * The Read Aloud section.
 *
 * Every voice here comes from the operating system, so the section has to say
 * what that means: the application never downloads a voice, and the quality is
 * the system's. The note is built from the list actually installed, because a
 * generic sentence about speech settings would be the same on a machine with
 * three en-US voices and one with none.
 */
function readAloudRows(host: PreferencesHost): Row[] {
  const s = () => host.settings();
  const voices = () => host.readAloudVoices();
  const saved = () => s().readAloudVoice;

  const options: [string, string][] = [["", "Follow the document language"]];
  for (const voice of voices()) options.push([voice.name, `${voice.name} (${voice.lang})`]);
  // A saved voice that has been uninstalled stays visible, so the reader can see
  // what the setting holds instead of finding the picker silently on Automatic.
  if (saved() && !voices().some((voice) => voice.name === saved())) {
    options.push([saved(), `${saved()} (not installed)`]);
  }

  return [
    { kind: "heading", label: "Reading" },
    {
      kind: "select",
      label: "Voice",
      help: "Used by Read Aloud in the editor's right-click menu. Automatic follows a language the document declares (`lang`), then the text itself (English and Portuguese are detected), then the Dictionary language, then the system default. MDraft offers only the voices the operating system already has.",
      options,
      get: () => saved(),
      set: (value) => host.update({ readAloudVoice: value }),
    },
    {
      kind: "number",
      label: "Speed",
      help: "The synthesiser's own rate: 1 is the voice's normal pace, 2 reads twice as fast, 0.5 half as fast.",
      min: MIN_RATE,
      max: MAX_RATE,
      step: 0.1,
      suffix: "×",
      get: () => s().readAloudRate ?? 1,
      set: (value) => host.update({ readAloudRate: value }),
    },
    {
      kind: "note",
      label: "Installed Voices",
      text: voiceAvailabilityNote(voices(), saved(), navigator.userAgent),
    },
  ];
}

function buildSections(host: PreferencesHost, ai: AiUiState, refresh: () => void): Section[] {
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
        { kind: "heading", label: "Favorites" },
        {
          kind: "note",
          label: "Managing Favorites",
          text: "Right-click a document or any tab and choose Add to Favorites. The Favorites panel keeps them in the order you added them; each row's × removes one entry, and opening a favorite never reorders the list.",
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
          help: "Applies to remote images inside formatted text pasted from a browser or another editor. Download and save writes them to the folder chosen above and contacts their hosts; Keep the original URL makes no request. Keep the original location above also keeps every URL. A URL you paste on its own still follows the option above.",
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
          help: "Writes a PDF directly through the system webview. File › Export › PDF (opens browser) provides browser printing and the fallback for scripted HTML. Typst documents use PDF (via Typst).",
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
            ["favorites", "Favorites"],
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
          text: "Format Document uses Prettier (MIT) for Markdown and HTML and Typstyle (Apache-2.0) for Typst.",
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
    {
      id: "ai",
      title: "AI Assistant",
      rows: aiRows(host, ai, refresh),
    },
    {
      id: "reading",
      title: "Read Aloud",
      rows: readAloudRows(host),
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

  const ai: AiUiState = {
    status: null,
    endpoint: "",
    models: [],
    modelsEndpoint: "",
    clearedModel: null,
    error: null,
    message: null,
    loading: false,
  };
  let activeId = buildSections(host, ai, () => render())[0].id;
  let query = "";
  let placed = false;

  /**
   * Ask the OS credential store about this endpoint.
   *
   * Runs only when the AI section is shown and the endpoint changed: opening
   * Preferences on another section never touches the keychain.
   */
  async function refreshAiStatus(): Promise<void> {
    const settings = host.settings();
    const endpoint = `${settings.aiProvider}|${settings.aiBaseUrl}`;
    ai.loading = true;
    try {
      const status = await api.aiStatus(settings.aiProvider, settings.aiBaseUrl);
      ai.status = status;
      ai.endpoint = endpoint;
      ai.error = status.warning;
    } catch (error) {
      ai.error = String(error);
      ai.endpoint = endpoint;
    } finally {
      ai.loading = false;
    }
    if (activeId === "ai" && !overlay.hidden) render();
  }

  function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
  }

  function syncPanelWidth(): void {
    const width = panelEl.offsetWidth;
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
    const all = buildSections(host, ai, () => render());
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
      input.step = String(row.step ?? 1);
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

    if (row.kind === "secret") {
      const wrap = document.createElement("div");
      wrap.className = "prefs-secret";
      const input = document.createElement("input");
      input.type = "password";
      input.autocomplete = "off";
      input.placeholder = row.placeholder;
      const save = document.createElement("button");
      save.type = "button";
      save.className = "prefs-button";
      save.textContent = "Save";
      // Nothing to save until something is typed. Leaving this enabled made an
      // empty click a no-op, which reads as "the key is required" even though
      // the field is optional.
      save.disabled = true;
      const clear = document.createElement("button");
      clear.type = "button";
      clear.className = "prefs-button";
      clear.textContent = "Clear";
      const current = row.status();
      clear.disabled = !current.hasKey;
      const note = document.createElement("span");
      note.className = "prefs-key-state";
      note.textContent = current.hasKey
        ? current.source === "keychain"
          ? "Saved in the system keychain"
          : "Session only"
        : "No key — optional";
      const commit = () => {
        const key = input.value.trim();
        if (!key) return;
        input.value = "";
        save.disabled = true;
        void row.set(key);
      };
      input.addEventListener("input", () => {
        save.disabled = input.value.trim() === "";
      });
      save.addEventListener("click", commit);
      input.addEventListener("keydown", (event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        commit();
      });
      clear.addEventListener("click", () => void row.clear());
      wrap.append(input, save, clear, note);
      return wrap;
    }

    if (row.kind === "text") {
      const input = document.createElement("input");
      input.type = "text";
      input.value = row.get();
      if (row.placeholder) input.placeholder = row.placeholder;
      input.addEventListener("change", () => {
        row.set(input.value);
        if (row.rerender !== false) render();
      });
      if (!row.suggestions) return input;

      // A model list arrives from Fetch and can be longer than a datalist can
      // usefully show; the picker opens it whole even when the field holds an
      // id from another endpoint.
      const field = document.createElement("div");
      field.className = "prefs-field";
      const combo = document.createElement("div");
      combo.className = "prefs-combo";
      combo.append(input);

      const note = row.fieldNote ? document.createElement("p") : null;
      if (note && row.fieldNote) {
        note.className = "prefs-field-note";
        note.id = `prefs-field-note-${row.label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
        note.textContent = row.fieldNote;
        input.setAttribute("aria-describedby", note.id);
        note.hidden = input.value.trim() !== "";
        input.addEventListener("input", () => {
          note.hidden = input.value.trim() !== "";
        });
      }

      const toggle = attachModelCombo({
        input,
        label: row.label,
        models: row.suggestions,
        choose: (model) => {
          if (note) note.hidden = true;
          row.set(model);
        },
      });
      combo.append(toggle);
      field.append(combo);
      if (note) field.append(note);
      return field;
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

    if (section.id === "ai") {
      const settings = host.settings();
      const endpoint = `${settings.aiProvider}|${settings.aiBaseUrl}`;
      if (ai.endpoint !== endpoint && !ai.loading) void refreshAiStatus();
    }

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
    // The rows are about to be replaced; a fixed popup would otherwise keep
    // pointing at an input that no longer exists.
    closeModelCombo();
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

  function openAt(sectionId: string): void {
    const target = buildSections(host, ai, () => render()).find(
      (section) => section.id === sectionId,
    );
    if (target) activeId = target.id;
    open();
  }

  function close(): void {
    closeModelCombo();
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
    openAt,
    close,
    toggle: () => (overlay.hidden ? open() : close()),
    isOpen: () => !overlay.hidden,
    refresh: render,
  };
}
