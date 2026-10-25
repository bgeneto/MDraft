//! Typed wrappers around the Rust commands.

import { invoke } from "@tauri-apps/api/core";

export interface DocumentPayload {
  path: string;
  name: string;
  directory: string;
  content: string;
  /** Approximate token count, computed by the backend while reading the file. */
  tokens: number;
  /** "\n" or "\r\n" */
  lineEnding: string;
  hadBom: boolean;
  lossy: boolean;
  size: number;
  modifiedMs: number;
  readOnly: boolean;
}

export interface SavedInfo {
  size: number;
  modifiedMs: number;
}

export interface FileStat {
  exists: boolean;
  size: number;
  modifiedMs: number;
  readOnly: boolean;
}

/**
 * One unsaved buffer in the crash-recovery journal.
 *
 * `baseModifiedMs`/`baseSize` are the disk revision the buffer was based on,
 * not the file's current state. Restoring them is what lets the external-change
 * guard notice a file that moved while MDraft was closed.
 */
export interface RecoveryEntry {
  id: string;
  path: string | null;
  name: string;
  language: DocumentLanguage;
  content: string;
  lineEnding: string;
  hadBom: boolean;
  lossy: boolean;
  readOnly: boolean;
  baseModifiedMs: number;
  baseSize: number;
  /** Set by Rust on write; the value sent by the frontend is ignored. */
  updatedMs: number;
}

export type ThemeMode = "system" | "light" | "dark";
export type ViewMode = "source" | "split" | "preview";
export type SidebarTab = "outline" | "favorites" | "recent";
export type OnLaunch = "welcome" | "new" | "last" | "tabs";
export type ImageRule = "assetsFolder" | "assetsDir" | "custom" | "keepOriginal";
/** Spacing between source lines, as a named choice rather than a multiplier. */
export type EditorLineHeight = "compact" | "normal" | "wide";

/**
 * One pandoc export target.
 *
 * `arguments` is a token list, not a shell string: it is split on whitespace and
 * handed to pandoc as separate arguments, so a path containing spaces needs no
 * quoting. Four placeholders are substituted — `${inputPath}`, `${outputPath}`,
 * `${styleReference}` and `${pdfEngine}` — and **a token whose placeholder
 * expanded to nothing is dropped**, which is what lets the defaults mention
 * `--reference-doc=${styleReference}` even when no reference file is set.
 */
export interface ExportFormat {
  id: string;
  label: string;
  /** Without the dot, as the save dialog wants it. */
  extension: string;
  arguments: string;
  extraArguments: string;
  styleReference: string;
}

export const emptyExportFormat = (): ExportFormat => ({
  id: "",
  label: "",
  extension: "",
  arguments: "-s -o ${outputPath}",
  extraArguments: "",
  styleReference: "",
});

export interface PandocStatus {
  found: boolean;
  path: string | null;
  version: string | null;
  /** "managed" when this application installed it, "path" when from PATH. */
  source: "managed" | "path" | null;
  pdfEngine: string | null;
}

export interface ExportRequest {
  formatId: string;
  markdown: string;
  outputPath: string;
  inputPath: string | null;
  /**
   * The source language, when it is not Markdown.
   *
   * The backend needs it to choose pandoc's reader: `"typst"` is rendered by
   * Typst itself for PDF, while an AsciiDoc document is rendered by Asciidoctor
   * to HTML in the frontend and therefore arrives here as `"html"`.
   */
  language?: DocumentLanguage;
  /**
   * A custom image folder the Typst compiler must be allowed to read.
   *
   * Typst accepts one `--root`; the backend widens it to the common ancestor of
   * the document's folder and this one. Only a `.typ` export uses it.
   */
  imageRoot?: string | null;
}

export interface ExportOutcome {
  outputPath: string;
  bytes: number;
  warnings: string;
  after: string[];
  afterErrors: string[];
}

/** What the after-export options did, for a file another path wrote. */
export interface AfterExportOutcome {
  after: string[];
  afterErrors: string[];
}

/** Sizes remembered for one typography preset. Any field may be absent. */
export interface PresetOverride {
  editorFontSize?: number;
  bodyFontSize?: number;
  mathFontScale?: number;
}

export interface Settings {
  theme: ThemeMode;
  viewMode: ViewMode;
  sidebarTab: SidebarTab;
  sidebarVisible: boolean;
  syncScroll: boolean;
  showStatusBar: boolean;
  focusMode: boolean;
  typewriterMode: boolean;
  /** Editor source pane size, in pixels. */
  editorFontSize: number;
  /**
   * Font stacks per role, as complete CSS `font-family` values.
   *
   * An empty string means "the built-in default for that role", which lives in
   * `src/fonts.ts`. Storing a stack rather than a family name lets a reader write
   * `"Source Serif 4", Charter, Georgia, serif` and be understood, and means the
   * application never has to parse what it publishes.
   */
  sourceFont: string;
  bodyFont: string;
  headingFont: string;
  codeFont: string;
  /** Prose size in the preview, in pixels. The editor has `editorFontSize`. */
  bodyFontSize: number;
  /**
   * Scale applied to KaTeX's mathematics, as a percentage.
   *
   * KaTeX sets formulas at 1.21em of the surrounding text, so 100 leaves them a
   * fifth larger and about 83 makes them match the prose. The Preferences field
   * limits the range to 70–130.
   */
  mathFontScale: number;
  /**
   * Sizes remembered per preset id.
   *
   * Editor font size, Preview font size and Math scale are reader adjustments,
   * not part of what identifies a preset. The top-level fields remain the
   * active values; this map is consulted when a preset is chosen.
   */
  presetOverrides: Record<string, PresetOverride>;
  /** Programming ligatures in code, both panes. Off by default: `->` is a choice. */
  ligaturesInCode: boolean;
  /** Tabular figures in preview tables, so columns of numbers line up. */
  tabularFigures: boolean;
  /** Oldstyle figures in prose, where they sit better in running text. */
  oldstyleFigures: boolean;
  /** Slashed zero in code, to separate it from capital O. */
  slashedZero: boolean;
  /**
   * How a `.typ` document is drawn: flowing HTML, or the rendered pages.
   *
   * Neither is enough alone — the document view cannot express layout, and the
   * page view cannot reflow or be read as text.
   */
  typstView: TypstView;
  editorMaxWidth: number;
  /** Line spacing in the source pane. The preview keeps its own reading height. */
  editorLineHeight: EditorLineHeight;
  syntaxTheme: string;
  recentFiles: string[];
  /**
   * Paths marked with **Add to Favorites**, in the order they were added.
   *
   * Unlike `recentFiles`, opening one never moves it. The list is capped at 50
   * by the backend, which refuses a new entry rather than evicting an old one.
   */
  favorites: string[];
  lastDirectory: string | null;
  /**
   * Paths of the tabs that were open when the window last closed, in order.
   *
   * Only saved documents: an untitled buffer has nothing to remember. Consulted
   * at boot when `onLaunch` is `"tabs"`; missing files are skipped there.
   */
  lastTabs: string[];
  /** The path of the tab to reactivate, or null to fall back to the first. */
  lastActiveTab: string | null;

  onLaunch: OnLaunch;
  defaultExtension: string;
  recordRecent: boolean;
  autoSave: boolean;

  enableMath: boolean;
  enableMermaid: boolean;

  /**
   * Run the document's own scripts in the sandboxed HTML preview.
   *
   * On by default. Off keeps the preview bridge (scroll sync, blink and
   * shortcuts) but blocks the document's scripts with a nonce-only CSP.
   */
  htmlPreviewScripts: boolean;

  /** Underline misspellings while typing. On unless the reader turns it off. */
  spellcheck: boolean;
  /** `"auto"`, or a tag from `spellcheckLanguages` (`en`, `en-GB`, `pt-BR`). */
  spellcheckLanguage: string;
  /** Words ignored or added. Not written into the operating system's dictionary. */
  spellcheckWords: string[];

  imageRule: ImageRule;
  imageCustomDir: string;
  imageApplyLocal: boolean;
  imageApplyOnline: boolean;
  imageUseRelativePath: boolean;
  imageAddDotSlash: boolean;
  imageAutoEscape: boolean;

  /** Convert copied rich text into the document's syntax. */
  richPaste: boolean;
  /** What to do with remote images inside a pasted fragment. */
  richPasteImages: "download" | "url";

  /** Insert the closing half of a bracket or quote while typing. */
  autoClosePairs: boolean;
  /** Close an HTML tag when its opening `>` is typed. */
  autoCloseTags: boolean;

  exportFormats: ExportFormat[];

  /**
   * What to do after a successful export, for every format.
   *
   * These used to live on each `ExportFormat`, which made a ticked box apply
   * only to that one target. Global now, so HTML and every pandoc format run
   * the same three actions. PDF (Print) is the exception: the browser chooses
   * the PDF's path, so there is nothing for MDraft to open.
   */
  afterOpenLocation: boolean;
  afterOpenFile: boolean;
  afterRunCommand: boolean;
  afterCommand: string;
}

export interface ImageOptions {
  rule: ImageRule;
  customDir: string | null;
  relative: boolean;
  dotSlash: boolean;
  escape: boolean;
}

export interface SavedImage {
  absolutePath: string;
  markdownPath: string;
  bytes: number;
  source: "clipboard" | "local" | "remote";
}

export const readDocument = (path: string) => invoke<DocumentPayload>("read_document", { path });

/**
 * Approximate token count for a buffer.
 *
 * Deliberately not a model-specific tokenizer: the number is an estimate that
 * lands within about 10% of both cl100k and o200k, with no vocabulary to ship.
 */
export const countTokens = (text: string) => invoke<number>("count_tokens", { text });

/** Languages the operating system can spell, as `en`, `en-GB`, `pt-BR`, `pt-PT`. */
export const spellcheckLanguages = () => invoke<string[]>("spellcheck_languages");

/**
 * Indices of `words` the dictionary rejects.
 *
 * Tokens the backend declines to check — capitals, digits, CamelCase — are
 * never included. An unknown language returns an empty list.
 */
export const spellcheckCheck = (language: string, words: readonly string[]) =>
  invoke<number[]>("spellcheck_check", { language, words });

/** Up to eight suggestions for one word. Empty when the language is not installed. */
export const spellcheckSuggest = (language: string, word: string) =>
  invoke<string[]>("spellcheck_suggest", { language, word });

export const writeDocument = (path: string, content: string, lineEnding: string, hadBom: boolean) =>
  invoke<SavedInfo>("write_document", { path, content, lineEnding, hadBom });

export const statDocument = (path: string) => invoke<FileStat>("stat_document", { path });

/** Journal entries left by a previous run, newest first. */
export const listRecovery = () => invoke<RecoveryEntry[]>("list_recovery");

/** Write or replace one journal entry. The host sets `updatedMs`. */
export const writeRecovery = (entry: RecoveryEntry) => invoke<void>("write_recovery", { entry });

/** Remove one journal entry. A missing file is success. */
export const removeRecovery = (id: string) => invoke<void>("remove_recovery", { id });

export const pathExists = (path: string, documentPath: string | null = null) =>
  invoke<boolean>("path_exists", { path, documentPath });

export const saveClipboardImage = (
  data: string,
  nameHint: string | null,
  documentPath: string | null,
  options: ImageOptions,
) => invoke<SavedImage>("save_clipboard_image", { data, nameHint, documentPath, options });

export const importImage = (
  sourcePath: string,
  documentPath: string | null,
  options: ImageOptions,
) => invoke<SavedImage>("import_image", { sourcePath, documentPath, options });

export const downloadImage = (
  url: string,
  documentPath: string | null,
  options: ImageOptions,
  timeoutMs?: number,
) => invoke<SavedImage>("download_image", { url, documentPath, options, timeoutMs });

export const startupFile = () => invoke<string | null>("startup_file");

export const getSettings = () => invoke<Settings>("get_settings");

export const saveSettings = (settings: Settings) => invoke<Settings>("save_settings", { settings });

/**
 * Record a path as most recent.
 *
 * Rust also rebuilds the native **Open Recent** submenu before this resolves, so
 * the returned settings are the list both views now show.
 */
export const addRecent = (path: string) => invoke<Settings>("add_recent", { path });

/** Clear the persisted list; Rust also refreshes the native Open Recent menu. */
export const clearRecent = () => invoke<Settings>("clear_recent");

/**
 * Append a path to Favorites and return the saved settings.
 *
 * A path already in the list is a no-op. At the 50-entry cap Rust rejects the
 * add with a message, so the caller can explain the limit instead of silently
 * dropping the oldest favorite.
 */
export const addFavorite = (path: string) => invoke<Settings>("add_favorite", { path });

/** Remove exactly one path from Favorites and return the saved settings. */
export const removeFavorite = (path: string) => invoke<Settings>("remove_favorite", { path });

export const pandocStatus = () => invoke<PandocStatus>("pandoc_status");

/**
 * Open a local file or folder with its default application.
 *
 * The frontend resolves the document's relative path first; Rust refuses a
 * missing path and an executable extension.
 */
export const openExternal = (path: string) => invoke<void>("open_external", { path });

export const runExport = (request: ExportRequest) =>
  invoke<ExportOutcome>("run_export", { request });

/**
 * Run the global after-export options for a file the frontend wrote.
 *
 * HTML is assembled in TypeScript, so it does not pass through `run_export`.
 * This is the same Rust helper the pandoc and Typst paths use.
 */
export const runAfterExport = (path: string) =>
  invoke<AfterExportOutcome>("run_after_export", { path });

export const installPandoc = () => invoke<PandocStatus>("install_pandoc");

/** Which markup the buffer holds. */
export type DocumentLanguage = "markdown" | "typst" | "html" | "asciidoc";

/** One Typst installation, as the backend sees it. */
export interface TypstStatus {
  found: boolean;
  version: string | null;
  path: string | null;
  /** "managed" when the application installed it, "path" when it came from PATH. */
  source: string | null;
  /** Whether the Install button can do the work here, or only explain. */
  canInstall: boolean;
  hint: string;
  downloadPage: string;
}

export const typstStatus = () => invoke<TypstStatus>("typst_status");
export const installTypst = () => invoke<TypstStatus>("install_typst");
export const openTypstDownloadPage = () => invoke<void>("typst_download_page");

/** How a Typst document is drawn in the preview. */
export type TypstView = "document" | "pages";

/**
 * A compiled Typst document.
 *
 * `kind` says which shape arrived: `document` carries flowing HTML in `html`,
 * `pages` carries the compiler's PDF in `pdf`, base64-encoded. Both can carry
 * warnings, and `ignored` names the constructs the document view had to drop.
 */
export interface RenderedTypst {
  kind: TypstView;
  html: string | null;
  css: string | null;
  /** Base64 PDF, when `kind` is `"pages"`. */
  pdf: string | null;
  warnings: string[];
  ignored: string[];
}

/**
 * Compile a Typst document for the preview.
 *
 * The source is sent rather than the path, so unsaved edits show up. `path` only
 * tells the compiler which directory to treat as the project root, so that
 * `#image("img/plot.png")` resolves the way it will on export.
 */
export const renderTypst = (
  path: string | null,
  source: string,
  mode: TypstView = "document",
  imageRoot: string | null = null,
) => invoke<RenderedTypst>("render_typst", { path, source, mode, imageRoot });

/** One menu accelerator, as the native menu registered it. */
export interface Shortcut {
  id: string;
  accelerator: string;
}

/**
 * Every accelerator the menu registered, for the frontend's key handler.
 *
 * Read from the menu that was actually built rather than duplicated here, so the
 * two cannot disagree.
 */
export const shortcuts = () => invoke<Shortcut[]>("accelerators");

/**
 * The state the native menu's check marks mirror.
 *
 * `fullscreen` is not a setting: only the window knows it, so the frontend sends
 * it along with the settings-backed flags instead of letting Rust guess.
 */
export interface MenuState {
  viewMode: ViewMode;
  sidebarVisible: boolean;
  sidebarTab: SidebarTab;
  showStatusBar: boolean;
  focusMode: boolean;
  typewriterMode: boolean;
  syncScroll: boolean;
  theme: ThemeMode;
  autoSave: boolean;
  fullscreen: boolean;
}

/** One checkable menu item, as the native menu reports it. */
export interface MenuCheck {
  id: string;
  checked: boolean;
  enabled: boolean;
}

/**
 * Mirror the UI state onto the native menu.
 *
 * The menu is a native control, not part of the DOM, so the frontend cannot
 * read its check marks and must tell Rust what they should be.
 */
export const setMenuState = (state: MenuState) => invoke<void>("set_menu_state", { state });

/**
 * Read the menu's check marks back.
 *
 * This exists for the test suites: `Page.captureScreenshot` only captures the
 * webview, so the native menu is invisible to every DOM probe.
 */
export const menuState = () => invoke<MenuCheck[]>("menu_state");

/**
 * Tell the native Export menu which external tools are installed.
 *
 * Formats that cannot run are disabled and annotated instead of failing after
 * the save dialog; the answer is cached in Rust so a menu rebuild caused by an
 * export-format edit keeps it.
 */
export const setExportAvailability = (pandoc: boolean, typst: boolean) =>
  invoke<void>("set_export_availability", { pandoc, typst });

/**
 * Write a print-ready document and open it in the system browser.
 *
 * Returns the path written, under the system temporary directory.
 */
export const printDocument = (html: string, name: string) =>
  invoke<string>("print_document", { html, name });

/**
 * Prepare the sandboxed HTML preview and get the URL the iframe should load.
 *
 * The source is the preview copy (line attributes and bridge already spliced
 * in), not necessarily the editor buffer. The backend holds it only until the
 * next render or `clearHtmlPreview`.
 */
export interface HtmlPreviewRequest {
  nonce: string;
  bridgeNonce: string;
  source: string;
  root: string | null;
  /**
   * Extra folders the guest may load images from. The reader's custom image
   * folder is the only one passed here; the document's own folder is `root`.
   */
  imageRoots?: string[];
  filename: string;
  scripts: boolean;
}

export interface HtmlPreviewUrl {
  url: string;
}

export const setHtmlPreview = (request: HtmlPreviewRequest) =>
  invoke<HtmlPreviewUrl>("set_html_preview", { request });

export const clearHtmlPreview = () => invoke<void>("clear_html_preview");
