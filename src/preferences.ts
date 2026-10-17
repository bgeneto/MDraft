//! Preferences panel.
//!
//! Follows the layout of Typora's Preferences window: a search box above a
//! vertical list of sections on the left, and the selected section's rows on the
//! right. Every row is backed by a real setting — the panel never shows an
//! option that does nothing.

import * as api from "./api";
import {
  FONT_SUGGESTIONS,
  TYPOGRAPHY_PRESETS,
  TYPOGRAPHY_ROLES,
  type TypographyPreset,
} from "./fonts";
import { PALETTE_OPTIONS } from "./syntax-themes";

export interface PreferencesHost {
  settings(): api.Settings;
  update(patch: Partial<api.Settings>): void;
  clearRecent(): void;
  /** Write the document as a standalone HTML file. */
  exportHtml(): void;
  /** Print the document to PDF through the system browser. */
  exportPdf(): void;
  openDocumentation(which: "reference" | "shortcuts"): void;
  version(): string;
  /** Last known pandoc status, or null before the first check. */
  pandocStatus(): api.PandocStatus | null;
  /** Check for pandoc and offer to install it if it is missing. */
  setupPandoc(): Promise<void>;
  /** Ask the user for a reference/style file. Empty string when cancelled. */
  chooseStyleReference(current: string): Promise<string>;
}

export interface PreferencesHandle {  open(): void;
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
      /**
       * A `font-family` stack, with a specimen underneath.
       *
       * Its own row kind rather than a `text` row because a typeface cannot be
       * judged from its name: the specimen is the control, and it has to repaint
       * on every keystroke — which a `text` row deliberately does not do, since
       * committing per keystroke would redraw the panel and fight the caret.
       */
      kind: "font";
      label: string;
      help?: string;
      /** The CSS variable this role publishes, so typing previews live. */
      variable: string;
      /** Text picked to expose the decisions the face makes. */
      sample: string;
      /**
       * Which OpenType switches the specimen obeys. Without this the sample
       * would show the face's ligatures while the setting has them off, and the
       * reader would conclude the switch does nothing.
       */
      features: "code" | "prose";
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

// ---------------------------------------------------------------------------
// Typography
// ---------------------------------------------------------------------------

/** The shared `<datalist>` every font field points at. */
const FONT_LIST_ID = "mdraft-font-list";

/**
 * Create the font suggestion list once, in the document rather than the panel.
 *
 * A `<datalist>` is referenced by id, and the panel is rebuilt on every redraw —
 * so a list created inside it would be removed and re-added constantly, and the
 * browser drops the association the moment the element carrying it goes away.
 */
function ensureFontList(): void {
  if (document.getElementById(FONT_LIST_ID)) return;
  const list = document.createElement("datalist");
  list.id = FONT_LIST_ID;
  for (const name of FONT_SUGGESTIONS) {
    const option = document.createElement("option");
    // A bare family name is what the datalist matches on; the field itself holds
    // a whole stack, so the value is offered rather than enforced.
    option.value = `"${name}"`;
    list.appendChild(option);
  }
  document.body.appendChild(list);
}

/**
 * The typography section: presets, then one row per role, then the OpenType
 * decisions that a family name alone does not express.
 *
 * The preset picker exists because choosing type is a pairing problem, not a
 * font problem. Each preset is a complete system, and the fields below it are
 * there to be dismantled by someone who already knows what they want.
 */
function typographyRows(host: PreferencesHost): Row[] {
  const s = () => host.settings();

  const rows: Row[] = [
    {
      kind: "select",
      label: "Preset",
      help: "Sets every field below at once. Changing any field afterwards leaves the preset — nothing is locked.",
      options: [
        ...TYPOGRAPHY_PRESETS.map((preset) => [preset.id, preset.label] as [string, string]),
        // Always present, so the control is never blank: it is what the picker
        // shows once a field below has been edited away from every preset.
        ["custom", "Custom (edited by hand)"],
      ],
      // The preset is a starting point rather than stored state, so it is
      // detected from the settings instead of remembered: picking one writes
      // the values, and the picker then reports whichever set is in force.
      get: () => activePreset(host)?.id ?? "custom",
      set: (value) => {
        const preset = TYPOGRAPHY_PRESETS.find((entry) => entry.id === value);
        if (preset) host.update(preset.values as Partial<api.Settings>);
      },
    },
    {
      kind: "note",
      label: "",
      text:
        activePreset(host)?.note ??
        "Edited by hand, so no preset matches exactly. The four faces below are the ones in use.",
    },
    { kind: "heading", label: "Faces" },
  ];

  for (const role of TYPOGRAPHY_ROLES) {
    rows.push({
      kind: "font",
      label: role.label,
      help: role.help,
      variable: role.variable,
      sample: role.sample,
      features: role.features,
      // The resolved stack, so the field always shows what is actually in use
      // rather than an empty box that means "some default somewhere".
      get: () => s()[role.id] || role.fallback,
      set: (value) => {
        // An empty field is read as "go back to the built-in default": the row
        // redraws with the default stack in it, which is what someone who just
        // cleared the box is asking for.
        host.update({ [role.id]: value.trim() } as Partial<api.Settings>);
      },
    });
  }

  rows.push(
    {
      kind: "number",
      label: "Preview text size",
      help: "Prose in the preview and in exports. The source pane has its own size under Editor.",
      min: 11,
      max: 32,
      suffix: "px",
      get: () => s().bodyFontSize,
      set: (value) => host.update({ bodyFontSize: value }),
    },
    {
      kind: "note",
      label: "Bundled faces",
      text:
        "MDraft ships Source Serif 4, Source Sans 3, Inter and JetBrains Mono under the SIL Open Font License, so those four look the same on every machine and travel inside exported HTML and PDF. Any other family comes from your operating system: it renders here, but a reader without it sees a fallback.",
    },
    { kind: "heading", label: "OpenType" },
    {
      kind: "checkbox",
      label: "Ligatures in code",
      help:
        "Turns the programming ligatures of faces that have them — JetBrains Mono draws `->`, `=>` and `!=` as single glyphs. Off by default, because whether a source file should look like that is a real disagreement.",
      get: () => s().ligaturesInCode,
      set: (value) => host.update({ ligaturesInCode: value }),
    },
    {
      kind: "checkbox",
      label: "Tabular figures in tables",
      help:
        "Gives every digit the same width so columns of numbers line up. Worth leaving on: proportional figures in a table are one of the few typographic choices that is simply wrong.",
      get: () => s().tabularFigures,
      set: (value) => host.update({ tabularFigures: value }),
    },
    {
      kind: "checkbox",
      label: "Oldstyle figures in prose",
      help:
        "Figures with ascenders and descenders, so 1,234 sits in running text instead of shouting. Needs a face that has them; Source Serif 4 and Georgia do.",
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
    { kind: "heading", label: "Mathematics" },
    {
      kind: "note",
      label: "",
      text:
        "Mathematics keeps KaTeX's own Computer Modern, which is a Didone — high contrast, vertical stress. It sits naturally beside the transitional serifs (Source Serif 4, Charter, Georgia) and argues with geometric sans faces. This is not a limitation to be worked around: KaTeX draws radicals, integrals and large delimiters with the KaTeX_Size faces, and no font on your system provides those glyphs, so substituting a family breaks the layout rather than changing the style.",
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

function patchFormat(
  host: PreferencesHost,
  id: string,
  patch: Partial<api.ExportFormat>,
): void {
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
                : " No PDF engine was found, so PDF export will fail until a LaTeX engine such as Tectonic, TinyTeX or MiKTeX is installed. Every other format works without one."
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
      label: "HTML and PDF",
      text:
        "Both are produced by MDraft from the same pipeline that draws the preview, so neither needs pandoc or LaTeX. PDF is printed by your browser, which is why it asks you to choose “Save as PDF”. Everything below this point is a pandoc format and needs pandoc installed.",
    },
    { kind: "heading", label: "Formats" },
  ];

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
        help:
          "Without the dot. Pandoc also infers the output format from it, which is why the arguments below mostly do not need a -t.",
        get: () => current.extension,
        set: (value) => patchFormat(host, current.id, { extension: value.replace(/^\./, "") }),
      },
      {
        kind: "text",
        label: "Arguments",
        help:
          "Passed to pandoc as separate arguments, so a path with spaces needs no quoting. ${inputPath}, ${outputPath}, ${styleReference} and ${pdfEngine} are substituted; a token whose placeholder is empty disappears entirely, which is how --reference-doc=${styleReference} is simply omitted when no style reference is chosen.",
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
        help:
          "A reference .docx/.odt for Word and OpenDocument, or a .css for EPUB, depending on what the arguments above expect.",
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
      { kind: "heading", label: "After Export" },
      {
        kind: "checkbox",
        label: "Open the exported file's folder",
        get: () => current.afterOpenLocation,
        set: (value) => patchFormat(host, current.id, { afterOpenLocation: value }),
      },
      {
        kind: "checkbox",
        label: "Open the exported file",
        get: () => current.afterOpenFile,
        set: (value) => patchFormat(host, current.id, { afterOpenFile: value }),
      },
      {
        kind: "checkbox",
        label: "Run a command",
        help:
          "Runs your own command after a successful export. ${outputPath} is replaced with the file that was written.",
        get: () => current.afterRunCommand,
        set: (value) => patchFormat(host, current.id, { afterRunCommand: value }),
      },
    );

    if (current.afterRunCommand) {
      rows.push({
        kind: "text",
        label: "Command",
        placeholder: "xdg-open ${outputPath}",
        get: () => current.afterCommand,
        set: (value) => patchFormat(host, current.id, { afterCommand: value }),
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
          options: [
            ["welcome", "Show the welcome document"],
            ["new", "Open a new file"],
            ["last", "Reopen the most recent file"],
          ],
          get: () => s().onLaunch,
          set: (value) => host.update({ onLaunch: value as api.OnLaunch }),
        },
        {
          kind: "select",
          label: "Default File Extension",
          help: "Used when Save As is given a name without an extension.",
          options: [
            ["md", "Markdown (.md)"],
            ["markdown", "Markdown (.markdown)"],
            ["txt", "Plain text (.txt)"],
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
          kind: "number",
          label: "Font Size",
          min: 10,
          max: 40,
          suffix: "px",
          get: () => s().editorFontSize,
          set: (value) => host.update({ editorFontSize: value }),
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
          help:
            "Keeps the two panes aligned while you scroll. Clicking in either pane always jumps the other one to the same content, and the block matching the caret is highlighted.",
          get: () => s().syncScroll,
          set: (value) => host.update({ syncScroll: value }),
        },
        {
          kind: "checkbox",
          label: "Show Status Bar",
          get: () => s().showStatusBar,
          set: (value) => host.update({ showStatusBar: value }),
        },
      ],
    },
    {
      id: "image",
      title: "Image",
      rows: [
        {
          kind: "select",
          label: "When Insert…",
          help:
            "What happens to an image you paste, drop or insert. Applies to clipboard bitmaps, local files and downloaded URLs.",
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
          help:
            "Used by the custom rule. A relative path is resolved against the document's folder. ${filename} expands to the document name.",
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
          help:
            "When ticked, pasting an image URL downloads it. When unticked, the URL is inserted as-is and nothing is fetched.",
          get: () => s().imageApplyOnline,
          set: (value) => host.update({ imageApplyOnline: value }),
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
        { kind: "heading", label: "Image Upload Setting" },
        {
          kind: "note",
          label: "Image Uploader",
          text:
            "None. Uploading to S3, PicGo, Imgur and similar services is not implemented, and neither is the matching “upload automatically based on YAML settings” option. Images are always written to disk, so a document stays self-contained and nothing leaves the machine except a URL you paste yourself.",
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
          text:
            "GitHub alerts (> [!NOTE]), task lists, tables, [TOC] and YAML front matter are always enabled. Math inside code spans and fenced blocks is never transformed.",
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
          help:
            "Colours the markdown source and any code inside fenced blocks. Each palette also sets the editor's own background, so a light palette stays readable while the application is dark.",
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
          kind: "note",
          label: "Settings file",
          text:
            "Preferences are stored as settings.json in the application config directory and are safe to edit by hand.",
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
  ensureFontList();

  const overlay = document.createElement("div");
  overlay.className = "prefs-overlay";
  overlay.hidden = true;
  overlay.innerHTML = `
    <div class="prefs-panel" role="dialog" aria-modal="true" aria-label="Preferences">
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
    </div>`;

  const sectionsEl = overlay.querySelector<HTMLDivElement>(".prefs-sections")!;
  const contentEl = overlay.querySelector<HTMLDivElement>(".prefs-content")!;
  const searchEl = overlay.querySelector<HTMLInputElement>(".prefs-search")!;
  const closeEl = overlay.querySelector<HTMLButtonElement>(".prefs-close")!;

  let activeId = buildSections(host)[0].id;
  let query = "";

  function matches(row: Row): boolean {
    if (query.length === 0) return true;
    const haystack = `${"label" in row ? row.label : ""} ${
      "help" in row && row.help ? row.help : ""
    } ${row.kind === "note" ? row.text : ""}`.toLowerCase();
    return haystack.includes(query);
  }

  function visibleSections(): Section[] {
    const all = buildSections(host);
    if (query.length === 0) return all;
    return all
      .map((section) => ({
        ...section,
        rows: section.rows.filter((row) => row.kind === "heading" || matches(row)),
      }))
      .filter(
        (section) =>
          section.rows.some((row) => row.kind !== "heading") ||
          section.title.toLowerCase().includes(query),
      );
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

    if (row.kind === "font") {
      const wrap = document.createElement("div");
      wrap.className = "prefs-font";

      const input = document.createElement("input");
      input.type = "text";
      input.className = "prefs-font-input";
      input.value = row.get();
      // The suggestions are the bundled families first, then the faces most
      // likely to exist on the reader's machine. A datalist is a convenience,
      // not a constraint: any `font-family` stack can be typed, which is the
      // only way to express a fallback chain.
      input.setAttribute("list", FONT_LIST_ID);
      input.spellcheck = false;

      const specimen = document.createElement("div");
      specimen.className = "prefs-font-specimen";
      specimen.textContent = row.sample;
      specimen.style.fontFamily = input.value;
      // Show the face as it will actually be used, OpenType switches included.
      specimen.dataset.features = row.features;

      // Repaint on every keystroke, but do not touch settings: the panel is the
      // one place where seeing the face immediately is the whole point, and a
      // write per keystroke would redraw the panel and fight the caret.
      input.addEventListener("input", () => {
        const value = input.value.trim() || "inherit";
        specimen.style.fontFamily = value;
        // Also live, so the setting can be judged in the document itself and
        // not only in the one-line specimen.
        document.documentElement.style.setProperty(row.variable, value);
      });
      // Commit on blur/Enter, as every other field does.
      input.addEventListener("change", () => {
        row.set(input.value);
        render();
      });

      wrap.append(input, specimen);
      return wrap;
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

  overlay.addEventListener("mousedown", (event) => {
    if (event.target === overlay) close();
  });

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
