//! Typed wrappers around the Rust commands.

import { invoke } from "@tauri-apps/api/core";

export interface DocumentPayload {
  path: string;
  name: string;
  directory: string;
  content: string;
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

export interface DirEntry {
  name: string;
  path: string;
  isDir: boolean;
  ext: string;
}

export type ThemeMode = "system" | "light" | "dark";
export type ViewMode = "source" | "split" | "preview";
export type SidebarTab = "outline" | "files" | "recent";
export type OnLaunch = "welcome" | "new" | "last";
export type ImageRule = "assetsFolder" | "assetsDir" | "custom" | "keepOriginal";

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
  afterOpenLocation: boolean;
  afterOpenFile: boolean;
  afterRunCommand: boolean;
  afterCommand: string;
}

export const emptyExportFormat = (): ExportFormat => ({
  id: "",
  label: "",
  extension: "",
  arguments: "-s -o ${outputPath}",
  extraArguments: "",
  styleReference: "",
  afterOpenLocation: false,
  afterOpenFile: false,
  afterRunCommand: false,
  afterCommand: "",
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
}

export interface ExportOutcome {
  outputPath: string;
  bytes: number;
  warnings: string;
  after: string[];
  afterErrors: string[];
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
  /** Programming ligatures in code, both panes. Off by default: `->` is a choice. */
  ligaturesInCode: boolean;
  /** Tabular figures in preview tables, so columns of numbers line up. */
  tabularFigures: boolean;
  /** Oldstyle figures in prose, where they sit better in running text. */
  oldstyleFigures: boolean;
  /** Slashed zero in code, to separate it from capital O. */
  slashedZero: boolean;
  editorMaxWidth: number;
  syntaxTheme: string;
  recentFiles: string[];
  lastDirectory: string | null;

  onLaunch: OnLaunch;
  defaultExtension: string;
  recordRecent: boolean;
  autoSave: boolean;
  showHiddenFiles: boolean;

  enableMath: boolean;
  enableMermaid: boolean;

  imageRule: ImageRule;
  imageCustomDir: string;
  imageApplyLocal: boolean;
  imageApplyOnline: boolean;
  imageUseRelativePath: boolean;
  imageAddDotSlash: boolean;
  imageAutoEscape: boolean;

  exportFormats: ExportFormat[];
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

export const readDocument = (path: string) =>
  invoke<DocumentPayload>("read_document", { path });

export const writeDocument = (
  path: string,
  content: string,
  lineEnding: string,
  hadBom: boolean,
) => invoke<SavedInfo>("write_document", { path, content, lineEnding, hadBom });

export const statDocument = (path: string) =>
  invoke<FileStat>("stat_document", { path });

export const pathExists = (path: string) =>
  invoke<boolean>("path_exists", { path });

export const listDirectory = (path: string, showHidden = false) =>
  invoke<DirEntry[]>("list_directory", { path, showHidden });

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
) => invoke<SavedImage>("download_image", { url, documentPath, options });

export const startupFile = () => invoke<string | null>("startup_file");

export const getSettings = () => invoke<Settings>("get_settings");

export const saveSettings = (settings: Settings) =>
  invoke<Settings>("save_settings", { settings });

export const addRecent = (path: string) =>
  invoke<Settings>("add_recent", { path });

export const clearRecent = () => invoke<Settings>("clear_recent");

export const pandocStatus = () => invoke<PandocStatus>("pandoc_status");

export const runExport = (request: ExportRequest) =>
  invoke<ExportOutcome>("run_export", { request });

export const installPandoc = () => invoke<PandocStatus>("install_pandoc");

/**
 * Write a print-ready document and open it in the system browser.
 *
 * Returns the path written, under the system temporary directory.
 */
export const printDocument = (html: string, name: string) =>
  invoke<string>("print_document", { html, name });
