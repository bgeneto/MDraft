//! Typed wrappers around the Rust commands.

import { Channel, invoke } from "@tauri-apps/api/core";

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
  /** SHA-256 of the raw file bytes (BOM and line endings included). */
  sha256: string;
}

export interface SavedInfo {
  size: number;
  modifiedMs: number;
}

/**
 * A save that may have been refused by the disk guard.
 *
 * `written: false` is not an I/O failure: the caller must ask the reader what
 * to do, exactly as it does for the stat-based preflight.
 */
export interface CheckedWrite {
  written: boolean;
  change: "saved" | "modified" | "deleted";
  size: number;
  modifiedMs: number;
  sha256: string;
}

/** The current stat and raw-byte digest, for "Keep my version". */
export interface DocumentFingerprint {
  exists: boolean;
  size: number;
  modifiedMs: number;
  sha256: string;
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
  /** SHA-256 of the disk revision the buffer was based on, if recorded. */
  baseSha256?: string | null;
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
  /**
   * The LaTeX project as the preview compiled it, unsaved buffers included.
   *
   * A `.tex` conversion reads this instead of the file on disk: the buffer on
   * screen can be newer, and an `\input` chapter may never have been saved.
   * Absent for every other language, and absent keeps the old behaviour.
   */
  snapshot?: ExportSnapshot | null;
}

/** The project files a LaTeX conversion reads, captured before any dialog. */
export interface ExportSnapshot {
  /** The absolute project directory the snapshot came from. */
  root: string;
  /** Project-relative, forward slashes. */
  mainFile: string;
  /** Base64, because an `\includegraphics` target is a PNG or a PDF. */
  files: Array<{ path: string; data: string }>;
}

/** One writer the installed pandoc advertises. */
export interface PandocWriter {
  id: string;
  label: string;
  /** Without the dot, as the save dialog wants it. */
  extension: string;
  /**
   * The writer emits citation data rather than a document.
   *
   * Pandoc's LaTeX reader does not carry the entries a `.bib` file holds, so
   * these produce an empty result for a `.tex` source. The chooser says so.
   */
  bibliographyOnly: boolean;
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

/**
 * The per-preset differences from that preset's built-in typography.
 *
 * Every field is optional: `undefined` means "use the built-in value", not
 * "use the application default". The four sizes keep the older meaning; the
 * four faces and four OpenType switches became editable presets' state in the
 * same map. The top-level settings remain the active values every consumer
 * reads.
 */
export interface PresetOverride {
  sourceFont?: string;
  bodyFont?: string;
  headingFont?: string;
  codeFont?: string;
  editorFontSize?: number;
  bodyFontSize?: number;
  mathFontScale?: number;
  codeFontScale?: number;
  ligaturesInCode?: boolean;
  tabularFigures?: boolean;
  oldstyleFigures?: boolean;
  slashedZero?: boolean;
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
  /** Blink the caret; off leaves a solid caret and saves a continuous repaint. */
  cursorBlink: boolean;
  /** Editor source pane size, in pixels. */
  editorFontSize: number;
  /** View zoom percentage; 100 is the base size. */
  zoomLevel: number;
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
   * Scale applied to fenced and inline code, as a percentage.
   *
   * Code is drawn at 86% of the prose size for a block and 88% for an inline
   * span, because a monospaced face reads larger at the same nominal size. 100
   * keeps those ratios; about 116 makes a block match the prose. The Preferences
   * field limits the range to 70–130.
   */
  codeFontScale: number;
  /**
   * Sizes, faces and OpenType choices remembered per preset id.
   *
   * The top-level fields remain the active values; this map is consulted when
   * a preset is selected. A missing entry means the preset has never been
   * adjusted and starts at its built-in values.
   */
  presetOverrides: Record<string, PresetOverride>;
  /**
   * The preset the reader is working in, or empty for a file written before
   * the field existed.
   *
   * Empty is not "System": the frontend detects a matching built-in from the
   * live values. A stored id wins over detection, which is what keeps editing a
   * face from turning the picker into Custom.
   */
  typographyPreset: string;
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
  typstAutoCompile: boolean;
  /**
   * Whether the reader has enabled the experimental LuaLaTeX engine.
   *
   * Stored in `settings.json` rather than in a marker file beside the cache, so
   * a portable build and a settings backup carry it. Turning it off stops the
   * `mdraft-tex` scheme from serving anything and leaves the cache inert.
   */
  latexEnabled: boolean;
  latexAutoCompile: boolean;
  /** The downloaded TeX package cache ceiling, in MiB. */
  latexCacheLimitMb: number;
  /**
   * Whether the reader chose a TeX installation already on this computer.
   *
   * Separate from `latexEnabled`: the two engines are different trust
   * boundaries, and turning one off must not disturb the other. Off by default;
   * only a validated installation can be switched on.
   */
  latexNativeEnabled: boolean;
  /** The validated engine directory, or null before the first validation. */
  latexNativeRoot: string | null;
  /** TeX Live inside WSL, when that is the native engine. Backend-owned. */
  latexNativeWsl?: LatexWslInstallation | null;
  /** Registered local TEXMF libraries in search order. Backend-owned. */
  latexTexmfRoots?: LatexTexmfRoot[];
  /** `auto`, `lualatex`, `pdflatex` or `xelatex`. */
  latexNativeEngine: string;
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
  /**
   * Whether the welcome document has already been shown once.
   *
   * Only the first launch of a profile shows it. `onLaunch` defaults to
   * `"tabs"`, whose empty-set fallback is a blank tab on purpose so that
   * **Close All Tabs** is not undone; this flag is what tells a brand-new
   * install apart from a session the reader emptied deliberately.
   */
  welcomeSeen: boolean;

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
  /**
   * Offer completions while typing.
   *
   * The popup only opens on a construct — a backslash, a backtick, a brace
   * argument — never on ordinary prose. Turning it off removes the extension and
   * its Tab binding together.
   */
  completion: boolean;
  /**
   * Expand Emmet abbreviations with Tab in HTML and CSS documents.
   *
   * It acts only where an abbreviation is allowed, and Tab still indents
   * everywhere else. Turning it off removes the Tab binding.
   */
  emmet: boolean;

  exportFormats: ExportFormat[];

  /**
   * What to do after a successful export, for every format.
   *
   * These used to live on each `ExportFormat`, which made a ticked box apply
   * only to that one target. Global now, so HTML, the direct PDF and every
   * pandoc format run the same three actions. PDF (opens browser) is the
   * exception: the browser chooses the PDF's path, so there is nothing for
   * MDraft to open.
   */
  afterOpenLocation: boolean;
  afterOpenFile: boolean;
  afterRunCommand: boolean;
  afterCommand: string;

  /**
   * Opt-in AI Assistant.
   *
   * Off by default: no request, no keychain read and no floating button until
   * the reader enables it and configures an endpoint and a model. The API key
   * is not here — it lives in the OS credential store, or in memory for one
   * session when the store is unavailable.
   */
  aiEnabled: boolean;
  /** `"openai"` for any OpenAI-compatible server, or `"anthropic"`. */
  aiProvider: AiProvider;
  aiBaseUrl: string;
  aiModel: string;
  /**
   * How much context one request may send, in approximate tokens.
   *
   * The status bar's token count uses the same estimator. The backend clamps
   * this to 1,024–32,768 when loading and saving settings.
   */
  aiContextTokens: number;
  /**
   * Ask the endpoint to answer without reasoning.
   *
   * Sends `reasoning_effort: "none"` to an OpenAI-compatible server and
   * `thinking: { type: "disabled" }` to Anthropic. Off by default: not every
   * model accepts the field, and one that never reasons may refuse the request
   * rather than ignore it. `aiTestReasoning` asks before the box is relied on.
   */
  aiDisableReasoning: boolean;
  /**
   * Let the assistant propose the file name when an untitled document is saved.
   *
   * Off by default. Only consulted while the assistant itself is enabled, and
   * only when the text has no title or heading of its own.
   */
  aiSuggestFilename: boolean;
  /**
   * Per-action usage behind the palette's *Most used* group.
   *
   * Empty on a fresh profile and on a file written before the group was
   * derived from use. `score` is a decaying count and `at` the Unix
   * millisecond timestamp it belongs to; `src/ai/usage.ts` owns both the decay
   * rule and the ranking, and the backend only bounds the list.
   */
  aiActionUsage: AiUsageEntry[];

  /**
   * Read Aloud.
   *
   * The empty voice name follows the document's language and then the system
   * default. The rate is the synthesiser's own 0.5–2.0 scale.
   */
  readAloudVoice: string;
  readAloudRate: number;
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

// ---------------------------------------------------------------------------
// Clipboard
// ---------------------------------------------------------------------------

/**
 * Plain-text clipboard, the fallback behind the webview's Clipboard API.
 *
 * WebView2 gates `navigator.clipboard.readText()` behind a permission the
 * application has no UI to request, so the menu's paste path needs a backend
 * that is not subject to it. Images never travel through here: they arrive as
 * `ClipboardEvent` data and go to `saveImage`, which is why the backend links
 * no image decoder.
 */
export const clipboardReadText = () => invoke<string>("clipboard_read_text");

/** Write `text`; fails only when the operating system clipboard cannot open. */
export const clipboardWriteText = (text: string) => invoke<void>("clipboard_write_text", { text });

/**
 * Bytes of tex-fmt's WebAssembly module, downloaded and verified on first use.
 *
 * The module is too large to embed for a formatter most sessions never touch;
 * the backend caches it after the first Format Document of a `.tex` file.
 */
export const texFmtWasm = () => invoke<ArrayBuffer>("tex_fmt_wasm");

// ---------------------------------------------------------------------------
// Read Aloud's Linux speech service
// ---------------------------------------------------------------------------

/** One voice the system speech service can use. */
export interface SpeechVoice {
  name: string;
  lang: string;
  local: boolean;
  isDefault: boolean;
}

/** The speech service's answer, including why it cannot speak when it cannot. */
export interface SpeechStatus {
  available: boolean;
  reason: string | null;
  voices: SpeechVoice[];
}

/** Ask speech-dispatcher for its default voice per language. Cached in Rust. */
export const speechStatus = () => invoke<SpeechStatus>("speech_status");

/** Speak one sentence and resolve when it has been spoken. */
export const speechSpeak = (text: string, lang: string, voice: string, rate: number) =>
  invoke<void>("speech_speak", { text, lang, voice, rate });

/** Stop the current sentence and clear anything already queued. */
export const speechStop = () => invoke<void>("speech_stop");

export const writeDocument = (path: string, content: string, lineEnding: string, hadBom: boolean) =>
  invoke<SavedInfo>("write_document", { path, content, lineEnding, hadBom });

/**
 * Save only if the raw bytes on disk still match the revision the buffer was
 * based on. `expectedSha256` is null for an untitled buffer or a new path.
 */
export const writeDocumentChecked = (
  path: string,
  content: string,
  lineEnding: string,
  hadBom: boolean,
  expectedSha256: string | null,
) =>
  invoke<CheckedWrite>("write_document_checked", {
    path,
    content,
    lineEnding,
    hadBom,
    expectedSha256,
  });

/** Read the current raw-byte digest without decoding the document. */
export const fingerprintDocument = (path: string) =>
  invoke<DocumentFingerprint>("fingerprint_document", { path });

export const statDocument = (path: string) => invoke<FileStat>("stat_document", { path });

/** Journal entries left by a previous run, newest first. */
export const listRecovery = () => invoke<RecoveryEntry[]>("list_recovery");

/** Write or replace one journal entry. The host sets `updatedMs`. */
export const writeRecovery = (entry: RecoveryEntry) => invoke<void>("write_recovery", { entry });

/** Remove one journal entry. A missing file is success. */
export const removeRecovery = (id: string) => invoke<void>("remove_recovery", { id });

export const pathExists = (path: string, documentPath: string | null = null) =>
  invoke<boolean>("path_exists", { path, documentPath });

export const resolveLegacyLocalImage = (
  primary: string,
  candidate: string,
  documentPath: string | null = null,
) => invoke<string | null>("resolve_legacy_local_image", { primary, candidate, documentPath });

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

/** Every document path the initial launch was given, missing ones included. */
export const startupFiles = () => invoke<string[]>("startup_files");

/** Paths a second launch forwarded before the webview installed its listener. */
export const takeForwardedPaths = () => invoke<string[]>("take_forwarded_paths");

export const getSettings = () => invoke<Settings>("get_settings");

export const saveSettings = (settings: Settings) => invoke<Settings>("save_settings", { settings });

/**
 * Families the operating system's text engine exposes, alphabetically.
 *
 * Names only: the webview already renders an installed family by name, so no
 * font file is read or served. The Rust side caches a successful scan for the
 * session; the frontend calls this only when Typography is first shown.
 */
export const systemFonts = () => invoke<string[]>("system_fonts");

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

/**
 * Open one of the application's own tool folders in the OS file manager.
 *
 * Preferences offers a button instead of printing the install path. The name is
 * a whitelist entry (`"pandoc"`, `"typst"`, `"latex"`), never a path: Rust
 * resolves it under the application data directory and creates it if needed.
 */
export type AppFolder = "pandoc" | "typst" | "latex";
export const openAppFolder = (folder: AppFolder) => invoke<void>("open_app_folder", { folder });

export const runExport = (request: ExportRequest) =>
  invoke<ExportOutcome>("run_export", { request });

/**
 * Every writer the installed pandoc advertises.
 *
 * Read-only, cached in Rust against the resolved binary and version. `pdf` is
 * included: the chooser turns it into the compiled-PDF route rather than a
 * conversion.
 */
export const pandocListWriters = () => invoke<PandocWriter[]>("pandoc_list_writers");

/**
 * Convert a LaTeX project with one writer the chooser picked.
 *
 * The writer is validated in Rust against the installed binary's own list, so a
 * stale chooser or a writer a pandoc update removed fails with a named error.
 */
export const runPandocWriter = (request: ExportRequest, writer: string) =>
  invoke<ExportOutcome>("run_pandoc_writer", { request, writer });

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
export type DocumentLanguage =
  "markdown" | "typst" | "html" | "asciidoc" | "latex" | "javascript" | "css" | "json";

export const isWebSource = (language: DocumentLanguage): boolean =>
  language === "javascript" || language === "css" || language === "json";

export interface LatexProjectSnapshot {
  mainFile: string;
  files: Array<{ path: string; data: string }>;
  /**
   * Project-relative paths skipped because they are symlinks.
   *
   * The snapshot follows the references a document declares rather than walking
   * the directory, so a symlink it would have read is reported here instead of
   * aborting the project. The preview surfaces them so a later "File not found"
   * from the compiler is explained rather than mysterious.
   */
  skipped: string[];
  /**
   * A key over the main file and the referenced set.
   *
   * An edit that does not change which files are read leaves it alone, so a
   * finished PDF stays current; adding an `\input` changes it. It also covers
   * the local library revision.
   */
  generation: string;
  /**
   * Enabled local libraries, captured apart from the project. Library files
   * never become chapters, source-map candidates or project members.
   */
  texmf?: LatexTexmfSnapshot;
}

export type LatexTexmfLayout = "tds" | "packages";

export interface LatexTexmfRoot {
  id: string;
  kind: "personal" | "folder";
  path?: string;
  layout: LatexTexmfLayout;
  enabled: boolean;
}

export interface LatexTexmfRootView extends LatexTexmfRoot {
  resolved: string;
  label: string;
}

export interface LatexTexmfConfig {
  roots: LatexTexmfRootView[];
  personalPath: string;
}

export interface LatexTexmfIssue {
  severity: "error" | "warning" | "info";
  code: string;
  message: string;
  paths: string[];
}

export interface LatexTexmfReport {
  id: string | null;
  path: string;
  label: string;
  layout: LatexTexmfLayout;
  detectedLayout: LatexTexmfLayout;
  enabled: boolean;
  status: "ok" | "empty" | "missing" | "unreadable" | "oversized" | "conflicting";
  message: string | null;
  files: number;
  bytes: number;
  issues: LatexTexmfIssue[];
  names: { classes: string[]; packages: string[] };
}

export interface LatexTexmfSnapshot {
  revision: string;
  roots: Array<{ id: string; label: string; layout: LatexTexmfLayout; path: string }>;
  /** `path` is TDS-relative; `origin` is the reader's own file, for messages. */
  files: Array<{ root: number; path: string; origin: string; data: string }>;
}

export type LatexTexmfAction =
  | { type: "addFolder"; path: string; layout?: LatexTexmfLayout }
  | { type: "usePersonal" }
  | { type: "setPrimary"; path?: string; layout?: LatexTexmfLayout }
  | { type: "setEnabled"; id: string; enabled: boolean }
  | { type: "setLayout"; id: string; layout: LatexTexmfLayout }
  | { type: "move"; id: string; offset: -1 | 1 }
  | { type: "remove"; id: string };

export const latexTexmfList = () => invoke<LatexTexmfConfig>("latex_texmf_list");
/** Remove only unregisters a folder; it never deletes files. */
export const latexTexmfConfigure = (action: LatexTexmfAction) =>
  invoke<LatexTexmfConfig>("latex_texmf_configure", { action });
/** Reads files only; never compiles or downloads. */
export const latexTexmfInspect = (options: {
  ids?: string[];
  candidate?: string;
  layout?: LatexTexmfLayout;
}) =>
  invoke<LatexTexmfReport[]>("latex_texmf_inspect", {
    ids: options.ids ?? null,
    candidate: options.candidate ?? null,
    layout: options.layout ?? null,
  });
export const latexTexmfOpen = (id: string) => invoke<void>("latex_texmf_open", { id });
/** The enabled libraries' current revision, or null when none is enabled. */
export const latexTexmfRevision = () => invoke<string | null>("latex_texmf_revision");

export interface LatexWslInstallation {
  distro: string;
  bin: string;
  engines: string[];
  tools: string[];
}

export interface LatexWslDistribution {
  name: string;
  version: number;
}

export interface LatexWslCandidate {
  distro: string;
  bin: string;
  engines: string[];
}

/** Registered WSL distributions, read from the registry; nothing starts. */
export const latexNativeWslDistributions = () =>
  invoke<LatexWslDistribution[]>("latex_native_wsl_distributions");
/** Look inside one distribution for TeX. This starts its VM. */
export const latexNativeWslLook = (distro: string) =>
  invoke<LatexWslCandidate[]>("latex_native_wsl_look", { distro });
/** Probe and commit a TeX Live inside WSL. */
export const latexNativeWslValidate = (distro: string, bin: string) =>
  invoke<LatexNativeCapabilities>("latex_native_wsl_validate", { distro, bin });

export const latexStatus = () => invoke<boolean>("latex_status");
export const installLatex = () => invoke<void>("install_latex");
export const latexProjectSnapshot = (
  path: string,
  overlays: Array<{ path: string; text: string }>,
  includeLibraries = true,
) => invoke<LatexProjectSnapshot>("latex_project_snapshot", { path, overlays, includeLibraries });

/** What Preferences reports about the downloaded TeX package cache. */
export interface LatexCacheInfo {
  bytes: number;
  limitMb: number;
  enabled: boolean;
  installed: boolean;
}

export const latexCacheInfo = () => invoke<LatexCacheInfo>("latex_cache_info");
/** Turn the engine off. Deletes nothing; Clear cache is the destructive action. */
export const latexDisable = () => invoke<void>("latex_disable");
/** Delete the downloaded package cache; returns the bytes freed. */
export const latexClearCache = () => invoke<number>("latex_clear_cache");

/** Which backend the preview must use for the open document. */
export interface LatexEngineStatus {
  backend: "native" | "bundled" | "none";
  bundledEnabled: boolean;
  bundledInstalled: boolean;
  nativeEnabled: boolean;
  nativeRoot: string | null;
  nativeDistribution: string | null;
  nativeEngine: string;
  nativeEngines: string[];
  /** The selected TeX Live inside WSL, when that is the native engine. */
  nativeWsl: LatexWslInstallation | null;
  /** Why the configured native installation cannot run, when it cannot. */
  problem: string | null;
}

export interface LatexNativeCandidate {
  directory: string;
  root: string | null;
  source: "path" | "standard";
  /** A readable name: MiKTeX, TeX Live, MacTeX, TinyTeX. */
  distribution: string;
  engines: string[];
}

export interface LatexNativeTool {
  id: string;
  path: string;
  version: string;
}

export interface LatexNativeCapabilities {
  root: string;
  bin: string;
  distribution: string;
  engines: LatexNativeTool[];
  tools: LatexNativeTool[];
}

export interface LatexNativeDiagnostic {
  file: string;
  line: number;
  severity: "error" | "warning";
  message: string;
  code: string;
}

/** The outcome of one native build. */
export interface LatexNativeResult {
  pdf: string | null;
  partialPdf: string | null;
  success: boolean;
  cancelled: boolean;
  timedOut: boolean;
  engine: string;
  distribution: string;
  passes: number;
  log: string;
  logTruncated: boolean;
  diagnostics: LatexNativeDiagnostic[];
  warningsTruncated: boolean;
  error: string | null;
  elapsedMs: number;
}

export interface LatexNativeProgress {
  job: string;
  phase: "compiling" | "bibliography" | "starting-wsl";
  detail: string | null;
}

export const latexEngineStatus = () => invoke<LatexEngineStatus>("latex_engine_status");
/** Metadata-only discovery; it launches nothing. */
export const latexNativeDiscover = () => invoke<LatexNativeCandidate[]>("latex_native_discover");
/**
 * Probe an installation and commit the directory.
 *
 * This is the only discovery call that executes external code.
 */
export const latexNativeValidate = (directory: string) =>
  invoke<LatexNativeCapabilities>("latex_native_validate", { directory });
export const latexNativeSetEnabled = (enabled: boolean) =>
  invoke<LatexEngineStatus>("latex_native_set_enabled", { enabled });
export const latexNativeSetEngine = (engine: string) =>
  invoke<LatexEngineStatus>("latex_native_set_engine", { engine });
export const latexNativeCompile = (request: {
  job: string;
  mainFile: string;
  files: Array<{ path: string; data: string }>;
  texmf?: LatexTexmfSnapshot;
}) => invoke<LatexNativeResult>("latex_native_compile", { request });
export const latexNativeCancel = (job: string) => invoke<void>("latex_native_cancel", { job });
/**
 * Write the PDF a document's own compiler produced.
 *
 * Shared by Typst's Pages view and a LaTeX project: both hand over the bytes
 * their engine emitted, so the command is named for what it does rather than for
 * the engine that happened to make them.
 */
export const saveCompiledPdf = (outputPath: string, data: string) =>
  invoke<void>("save_compiled_pdf", { outputPath, data });
/**
 * Write the compiled PDF to a temporary file and open it to be printed.
 *
 * Prints the compiler's own bytes, never a re-render — see
 * `docs/adr/2026-11-06-print-the-compiled-pdf.md`. Returns the path written.
 */
export const printCompiledPdf = (data: string, name: string) =>
  invoke<string>("print_compiled_pdf", { data, name });

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
  compilerOutput: string;
  compilerOutputTruncated: boolean;
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
  token?: number,
) => invoke<RenderedTypst>("render_typst", { path, source, mode, imageRoot, token: token ?? null });

/** Stop Typst preview jobs through this generation; exports remain independent. */
export const cancelTypstPreview = (token: number) =>
  invoke<void>("cancel_typst_preview", { token });

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
 * The state the native menu's check marks, labels and availability mirror.
 *
 * `fullscreen` is not a setting: only the window knows it, so the frontend sends
 * it along with the settings-backed flags instead of letting Rust guess. The
 * document fields have the same reason: Rust cannot see the active session, its
 * selection or the link under the caret.
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
  documentLanguage: DocumentLanguage;
  readOnly: boolean;
  hasSelection: boolean;
  hasCommentSyntax: boolean;
  linkKind: "" | "external" | "anchor" | "file" | "image";
  canFormat: boolean;
  tabCount: number;
  tabIndex: number;
  unchangedOtherTabs: number;
  hasPath: boolean;
  isFavorite: boolean;
  canFold: boolean;
  spellcheck: boolean;
  spellcheckAvailable: boolean;
  aiEnabled: boolean;
  syntaxTheme: string;
  typstView: TypstView;
  typstAvailable: boolean;
  /**
   * Whether the preview currently holds a PDF the document's own compiler
   * produced, so `Export › PDF` can write those exact bytes.
   *
   * Always true for a LaTeX document whose last compile succeeded; true for a
   * Typst document only in the Pages view, because the Document view compiles
   * HTML and holds no PDF at all. One flag rather than one per language, so the
   * payload does not grow a field every time a PDF-rendered markup is added.
   */
  pdfPreviewAvailable: boolean;
  /**
   * The engine that produced the PDF the export row writes (`LuaLaTeX`,
   * `pdfLaTeX`, `XeLaTeX`), or empty when there is none or it is unknown.
   */
  pdfEngine: string;
  /** Whether a `.tex` preview recompiles after edits; drives a View check item. */
  latexAutoCompile: boolean;
}

/** One row of Navigate › Open Tabs. */
export interface OpenTabItem {
  id: string;
  label: string;
  checked: boolean;
}

/** One native menu item, including ordinary items and submenus. */
export interface MenuItemInfo {
  id: string;
  text: string;
  enabled: boolean;
  checked: boolean | null;
  kind: "item" | "check" | "submenu" | "predefined";
  /** Label of the containing submenu; empty for a top-level item. */
  parent: string;
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
 * Repopulate Navigate › Open Tabs.
 *
 * The native submenu is edited in place instead of rebuilding the whole menu;
 * see the Rust command for why that matters to accelerators and check state.
 */
export const setOpenTabs = (tabs: OpenTabItem[]) => invoke<void>("set_open_tabs", { tabs });

/**
 * Read every native menu item, including ordinary items and submenus.
 *
 * `menuState` answers only check items; availability and conditional labels live
 * on ordinary items, so the suites need this second probe to see them.
 */
export const menuItems = () => invoke<MenuItemInfo[]>("menu_items");

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

/** The result of a native print or direct PDF operation. */
export interface NativePrintOutcome {
  /** The PDF written by a direct export; `null` for a print dialog. */
  path: string | null;
  bytes: number | null;
  status: "written" | "dialog" | "cancelled";
  /** Images that did not load before the print surface's deadline. */
  failedResources: string[];
}

/** Open the platform print dialog for the prepared article. */
export const printNative = (html: string, name: string) =>
  invoke<NativePrintOutcome>("print_native", { html, name });

/** Write a PDF through the platform webview. */
export const printNativePdf = (html: string, name: string, target: string) =>
  invoke<NativePrintOutcome>("print_native_pdf", { html, name, target });

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

// ---------------------------------------------------------------------------
// AI Assistant
// ---------------------------------------------------------------------------

export type AiProvider = "openai" | "anthropic";

/** Where the key for an endpoint comes from. */
export type AiKeySource = "keychain" | "file" | "session" | "none";

/** The ids the Rust prompt builder knows; `src/ai/actions.ts` owns the labels. */
export type AiActionId =
  | "continue"
  | "improve"
  | "ask"
  | "expand"
  | "shorten"
  | "simplify"
  | "tone"
  | "translate"
  | "summarize"
  | "explain"
  | "keyPoints"
  | "critique"
  | "table"
  | "convert";

/**
 * One palette action's usage weight, as persisted in `aiActionUsage`.
 *
 * `score` is a decaying use count and `at` the Unix millisecond timestamp it
 * belongs to, so an entry can be aged without another write. `src/ai/usage.ts`
 * owns the half-life and the ranking; Rust only bounds the list.
 */
export interface AiUsageEntry {
  /** A catalog id. One this build does not know is ignored, not an error. */
  id: AiActionId;
  score: number;
  at: number;
}

export interface AiTurn {
  role: "user" | "assistant";
  content: string;
}

/**
 * One request to the assistant.
 *
 * `selection` is the selected passage, or the current paragraph when nothing is
 * selected. `preceding` is the text immediately before the insertion point and
 * is only used by Continue. `instruction` is Ask's question. The backend
 * validates every field again and owns the caps.
 */
export interface AiRequest {
  id: string;
  action: AiActionId;
  /** Tone for `tone`, language for `translate`, target markup for `convert`. */
  parameter: string | null;
  language: DocumentLanguage;
  selection: string;
  preceding: string;
  instruction: string;
  history: AiTurn[];
}

/**
 * What the panel receives while a request runs.
 *
 * `started` reports the endpoint and model the backend actually used, and
 * whether a long context was trimmed. `done` is authoritative: the panel
 * replaces whatever it streamed with `text`, because the final pass strips an
 * outer code fence and trailing whitespace.
 */
export type AiEvent =
  | {
      kind: "started";
      model: string;
      host: string;
      contextTokens: number;
      contextTruncated: boolean;
    }
  | { kind: "delta"; text: string }
  | { kind: "done"; text: string; notes: string; truncated: boolean; stopped: boolean }
  | { kind: "error"; message: string };

export interface AiKeyStatus {
  source: AiKeySource;
  hasKey: boolean;
  endpoint: string;
  keychainAvailable: boolean;
  warning: string | null;
}

export interface AiModelsReply {
  models: string[];
}

export const aiStatus = (provider: AiProvider, baseUrl: string) =>
  invoke<AiKeyStatus>("ai_status", { provider, baseUrl });

/**
 * Store a key in the OS credential store.
 *
 * A store that is unavailable is not an error: the key is kept for this session
 * and `source` reports `"session"` with a warning, so the reader knows it will
 * not survive a restart.
 */
export const aiSetKey = (provider: AiProvider, baseUrl: string, key: string) =>
  invoke<AiKeyStatus>("ai_set_key", { provider, baseUrl, key });

export const aiClearKey = (provider: AiProvider, baseUrl: string) =>
  invoke<AiKeyStatus>("ai_clear_key", { provider, baseUrl });

/** Ask the endpoint for its model list. Nothing is requested until this runs. */
export const aiFetchModels = (provider: AiProvider, baseUrl: string, model: string) =>
  invoke<AiModelsReply>("ai_fetch_models", { provider, baseUrl, model });

/** What one short request found about the endpoint's reasoning-off field. */
export interface AiReasoningProbe {
  accepted: boolean;
  message: string;
}

/**
 * Send one short request that asks for no reasoning.
 *
 * Independent of the checkbox and of `aiEnabled`: the question is what the
 * model accepts, and a reader may be configuring the assistant for the first
 * time. A model that refuses the field is an answer, not an error; a transport
 * or authentication failure is still an error.
 */
export const aiTestReasoning = (provider: AiProvider, baseUrl: string, model: string) =>
  invoke<AiReasoningProbe>("ai_test_reasoning", { provider, baseUrl, model });

export const aiCancel = (id: string) => invoke<void>("ai_cancel", { id });

export const aiCancelAll = () => invoke<void>("ai_cancel_all");

/** What the AI Assistant's prompt file currently holds. */
export interface AiPromptsStatus {
  path: string;
  exists: boolean;
  /** Sections that differ from the built-in prompt. */
  custom: number;
  /** Sections the file can carry: the preamble, every action and the name prompt. */
  total: number;
  /** Why the file could not be used, when it could not. */
  error: string | null;
}

/**
 * Whether the reader has edited any prompt, and where the file is.
 *
 * Read-only: opening Preferences must not create `ai-prompts.md`.
 */
export const aiPromptsStatus = () => invoke<AiPromptsStatus>("ai_prompts_status");

/**
 * Write every built-in prompt to `ai-prompts.md`, replacing what is there.
 *
 * This is both "open the file for the first time" and **Reset prompts to
 * defaults**. It writes from the Rust constants and never parses the old file,
 * so it is the way back from an edit that no longer parses.
 */
export const aiExportPrompts = () => invoke<string>("ai_export_prompts");

/**
 * Ask the configured endpoint for a file-name stem.
 *
 * The opening text is the only document text this request carries. The answer
 * is raw; the caller runs it through the same sanitiser a heading goes through,
 * because a model cannot be trusted to obey a filename contract. `id` is the
 * cancellation key, registered by the backend like any other AI request.
 */
export const aiSuggestFilename = (id: string, text: string) =>
  invoke<string>("ai_suggest_filename", { id, text });

/**
 * Start one action.
 *
 * The `Channel` must be kept alive by the caller until the promise settles;
 * dropping it stops the events but not the backend task, which is why the
 * assistant stores it and calls `aiCancel` explicitly.
 */
export function aiComplete(
  request: AiRequest,
  onEvent: (event: AiEvent) => void,
): { promise: Promise<void>; channel: Channel<AiEvent> } {
  const channel = new Channel<AiEvent>();
  channel.onmessage = onEvent;
  return {
    promise: invoke<void>("ai_complete", { request, onEvent: channel }),
    channel,
  };
}
