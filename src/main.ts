//! Application shell: document lifecycle, menu wiring, preview rendering and
//! the sidebar.

import "./styles.css";

import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import {
  ask,
  message,
  open as openDialog,
  save as saveDialog,
} from "@tauri-apps/plugin-dialog";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";

import * as api from "./api";
import { REFERENCE, SHORTCUTS, WELCOME } from "./content";
import { createEditor, type EditorHandle } from "./editor";
import {
  embeddedFontCss,
  installBundledFonts,
  TYPOGRAPHY_ROLES,
} from "./fonts";
import { applyHighlightTheme, highlightThemeCss } from "./highlight-theme";
import { handleImageDrop, handleImagePaste, type ImageContext } from "./images";
import {
  KATEX_STYLESHEET_URL,
  renderMermaidIn,
  renderPreview,
  wrapPrintHtml,
  wrapStandaloneHtml,
} from "./markdown";
import { createPreferences, type PreferencesHandle } from "./preferences";
import * as sidebarPanel from "./sidebar";
import { resolvePalette } from "./syntax-themes";

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element #${id}`);
  return node as T;
}

const app = el<HTMLDivElement>("app");
const sidebarBody = el<HTMLDivElement>("sidebar-body");
const editorHost = el<HTMLDivElement>("editor-host");
const editorPane = el<HTMLElement>("editor-pane");
const previewPane = el<HTMLElement>("preview-pane");
const preview = el<HTMLElement>("preview");
const statusFile = el<HTMLSpanElement>("status-file");
const statusWords = el<HTMLSpanElement>("status-words");
const statusCursor = el<HTMLSpanElement>("status-cursor");
const statusEncoding = el<HTMLSpanElement>("status-encoding");
const toastEl = el<HTMLDivElement>("toast");
const resizer = el<HTMLDivElement>("resizer");
const splitter = el<HTMLDivElement>("splitter");

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let editor: EditorHandle;
let preferences: PreferencesHandle;
let settings: api.Settings;
let currentDoc: api.DocumentPayload | null = null;
let currentPath: string | null = null;
let savedContent = "";
let dirty = false;
let diskModifiedMs = 0;
let isDark = false;
let allowClose = false;
let lastTitle = "";

const DEFAULT_FONT_SIZE = 16;
const MIN_FONT = 10;
const MAX_FONT = 40;
const AUTO_SAVE_INTERVAL_MS = 20_000;
/** Scroll alignment window, in ms, after a programmatic pane scroll. */
const SYNC_SUPPRESS_MS = 150;
/** How long the preview block matching the caret stays lit. */
const BLINK_MS = 620;

/**
 * True only while a click in the preview is moving the source caret. Without
 * it the caret change travels back through `onCursor` and scrolls the preview,
 * yanking the clicked block to the top — which also destroys a drag-selection,
 * because the text slides out from under the pointer. Set and cleared
 * synchronously around the dispatch, so no timing window exists.
 */
let caretCameFromPreview = false;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Show a transient message.
 *
 * `ms` of 0 keeps it up until the returned handle is dismissed, which is what
 * the export and download paths use: they know the work has started but not how
 * long it will take.
 */
function toast(text: string, ms = 2600): { dismiss: () => void } {
  toastEl.textContent = text;
  toastEl.hidden = false;
  window.clearTimeout(toastTimer);
  const dismiss = () => {
    window.clearTimeout(toastTimer);
    toastEl.hidden = true;
  };
  if (ms > 0) toastTimer = window.setTimeout(dismiss, ms);
  return { dismiss };
}
let toastTimer = 0;

function joinDir(dir: string, name: string): string {
  const sep = /^[A-Za-z]:/.test(dir) || dir.includes("\\") ? "\\" : "/";
  return dir.replace(/[\\/]+$/, "") + sep + name;
}

/** The final component of a path, for a message that has no room for the rest. */
function basename(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

// ---------------------------------------------------------------------------
// Theme & layout
// ---------------------------------------------------------------------------

function resolveDark(): boolean {
  if (settings.theme === "dark") return true;
  if (settings.theme === "light") return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function applyTheme(): void {
  isDark = resolveDark();
  document.documentElement.dataset.theme = isDark ? "dark" : "light";
  applyHighlightTheme(isDark);
  applySyntaxTheme();
}

/** The editor keeps its own palette, which may differ from the app theme. */
function applySyntaxTheme(): void {
  editor?.setSyntax(resolvePalette(settings.syntaxTheme, isDark));
}

function applyLayout(): void {
  app.classList.toggle("sidebar-hidden", !settings.sidebarVisible);
  app.classList.toggle("statusbar-hidden", !settings.showStatusBar);
  app.classList.remove("mode-source", "mode-split", "mode-preview");
  app.classList.add(`mode-${settings.viewMode}`);
  app.classList.toggle("focus-mode", settings.focusMode);

  // 0 means "full width" in the settings model.
  const width = settings.editorMaxWidth;
  document.documentElement.style.setProperty(
    "--editor-max-width",
    width > 0 ? `${width}px` : "none",
  );

  editor?.setFontSize(settings.editorFontSize);
  editor?.setFocusMode(settings.focusMode);
  editor?.setTypewriter(settings.typewriterMode);
  applySyntaxTheme();
  applyTypography();

  el<HTMLButtonElement>("mode-source").classList.toggle("active", settings.viewMode === "source");
  el<HTMLButtonElement>("mode-split").classList.toggle("active", settings.viewMode === "split");
  el<HTMLButtonElement>("mode-preview").classList.toggle("active", settings.viewMode === "preview");
  for (const button of ["mode-source", "mode-split", "mode-preview"]) {
    el<HTMLButtonElement>(button).setAttribute(
      "aria-pressed",
      String(button === `mode-${settings.viewMode}`),
    );
  }

  for (const tab of ["outline", "files", "recent"] as const) {
    el<HTMLButtonElement>(`tab-${tab}`).setAttribute(
      "aria-selected",
      String(settings.sidebarTab === tab),
    );
  }
}

/**
 * Publish the typography settings as CSS variables.
 *
 * Everything — the two panes, the exported documents and the panel's own
 * specimen — reads the same variables, which is why there is one place that
 * writes them. An empty font string means "the built-in default for that role",
 * so the fallback lives in `src/fonts.ts` beside the reasoning for it rather
 * than being copied into every settings file on disk.
 */
function applyTypography(): void {
  const root = document.documentElement.style;
  for (const role of TYPOGRAPHY_ROLES) {
    root.setProperty(role.variable, settings[role.id] || role.fallback);
  }
  root.setProperty("--body-size", `${settings.bodyFontSize}px`);

  // Whole property values rather than composed keywords: `font-variant-numeric`
  // takes a list, and building one from separate booleans is where a stray space
  // turns a valid declaration into an ignored one.
  root.setProperty("--prose-figures", settings.oldstyleFigures ? "oldstyle-nums" : "normal");
  root.setProperty("--table-figures", settings.tabularFigures ? "tabular-nums" : "normal");
  root.setProperty("--code-figures", settings.slashedZero ? "slashed-zero tabular-nums" : "normal");
  root.setProperty(
    "--code-ligatures",
    settings.ligaturesInCode ? "contextual common-ligatures" : "none",
  );

  // CodeMirror wraps lines by measuring text, so a new face invalidates what it
  // measured. Nothing else needs telling: the preview is ordinary CSS.
  editor?.requestMeasure();
}

function persist(): void {
  void api.saveSettings(settings).catch(() => {
    /* settings are best-effort */
  });
}

function setTheme(mode: api.ThemeMode): void {
  settings.theme = mode;
  applyTheme();
  persist();
  scheduleRender(true);
}

/** Apply a patch from the Preferences panel and refresh anything it affects. */
function applySettingsPatch(patch: Partial<api.Settings>): void {
  const affectsRendering =
    patch.enableMath !== undefined ||
    patch.enableMermaid !== undefined ||
    patch.editorMaxWidth !== undefined ||
    patch.syntaxTheme !== undefined;

  settings = { ...settings, ...patch };
  applyTheme();
  applyLayout();
  persist();

  if (affectsRendering) scheduleRender(true);
  if (patch.showHiddenFiles !== undefined && settings.sidebarTab === "files") {
    renderSidebar();
  }
}

// ---------------------------------------------------------------------------
// Title & status bar
// ---------------------------------------------------------------------------

async function refreshTitle(): Promise<void> {
  const name = currentDoc?.name ?? "Untitled";
  const title = `${dirty ? "• " : ""}${name} — MDraft`;
  if (title === lastTitle) return;
  lastTitle = title;
  document.title = title;
  try {
    await getCurrentWindow().setTitle(title);
  } catch {
    /* window title is cosmetic */
  }
}

function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;
}

function refreshStatus(): void {
  const text = editor.getDoc();
  const cursor = editor.cursorInfo();
  const words = countWords(text);
  const lines = text.length === 0 ? 0 : text.split("\n").length;

  statusFile.textContent = `${dirty ? "• " : ""}${currentDoc?.name ?? "Untitled"}`;
  statusWords.textContent = `${words} ${words === 1 ? "word" : "words"}`;
  statusWords.title = `${words} words · ${text.length} characters · ${lines} lines`;
  statusCursor.textContent = `Ln ${cursor.line}, Col ${cursor.column}${
    cursor.selectionLength > 0
      ? ` (${cursor.selectionLength} selected${
          cursor.selectionLines > 1 ? `, ${cursor.selectionLines} lines` : ""
        })`
      : ""
  }`;

  if (!currentDoc) {
    statusEncoding.textContent = "UTF-8 · not saved";
  } else {
    const eol = currentDoc.lineEnding === "\r\n" ? "CRLF" : "LF";
    statusEncoding.textContent = `UTF-8${currentDoc.hadBom ? " BOM" : ""} · ${eol}${
      currentDoc.readOnly ? " · read-only" : ""
    }`;
  }
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

let renderTimer = 0;
let renderToken = 0;
let lastMappedState: boolean | null = null;

function scheduleRender(immediate = false): void {
  window.clearTimeout(renderTimer);
  renderTimer = window.setTimeout(() => void doRender(), immediate ? 0 : 200);
}

async function doRender(): Promise<void> {
  const token = ++renderToken;
  const source = editor.getDoc();

  const result = renderPreview(source, {
    baseDir: currentDoc?.directory ?? null,
    math: settings.enableMath,
    mermaid: settings.enableMermaid,
  });
  if (token !== renderToken) return;
  preview.innerHTML = result.html;
  previewLinesMapped = result.linesMapped;

  if (result.linesMapped !== lastMappedState) {
    lastMappedState = result.linesMapped;
    if (!result.linesMapped) {
      console.info(
        "[sync] positional pane sync is unavailable for this document; scrolling stays independent",
      );
    }
  }

  await renderMermaidIn(preview, isDark);
  if (token !== renderToken) return;

  // Diagram sizes only settle after mermaid runs, so anchor once it is done.
  rebuildAnchors();
  revealCursorInPreview();
  updateActiveOutline();
}

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

function renderSidebar(): void {
  if (!settings.sidebarVisible) return;

  if (settings.sidebarTab === "outline") {
    const headings = sidebarPanel.extractHeadings(editor.getDoc());
    sidebarPanel.renderOutline(sidebarBody, headings, editor.cursorInfo().line, (line) => {
      editor.scrollToLine(line);
    });
    return;
  }

  if (settings.sidebarTab === "files") {
    if (!sidebarPanel.currentDirectory() && currentDoc?.directory) {
      sidebarPanel.resetDirectory(currentDoc.directory);
    }
    const dir = sidebarPanel.currentDirectory();
    if (!dir) {
      sidebarBody.replaceChildren(
        Object.assign(document.createElement("div"), {
          className: "sidebar-empty",
          textContent: "Open a document to browse its folder.",
        }),
      );
      return;
    }
    void sidebarPanel.showDirectory(sidebarBody, dir, {
      onOpenFile: (path) => void openPath(path),
      onError: toast,
      showHidden: () => settings.showHiddenFiles,
    });
    return;
  }

  sidebarPanel.renderRecent(sidebarBody, settings.recentFiles, {
    onOpenFile: (path) => void openPath(path),
    onClear: () => {
      void api.clearRecent().then((next) => {
        settings = next;
        renderSidebar();
      });
    },
    onError: toast,
  });
}

function updateActiveOutline(): void {
  if (settings.sidebarTab !== "outline" || !settings.sidebarVisible) return;
  const headings = sidebarPanel.extractHeadings(editor.getDoc());
  sidebarPanel.renderOutline(sidebarBody, headings, editor.cursorInfo().line, (line) => {
    editor.scrollToLine(line);
  });
}

// ---------------------------------------------------------------------------
// Document lifecycle
// ---------------------------------------------------------------------------

async function adoptDocument(payload: api.DocumentPayload, resetHistory: boolean): Promise<void> {
  currentDoc = payload;
  currentPath = payload.path;
  savedContent = payload.content;
  diskModifiedMs = payload.modifiedMs;
  dirty = false;

  editor.setDoc(payload.content, resetHistory);
  sidebarPanel.resetDirectory(payload.directory || null);

  applyLayout();
  await refreshTitle();
  refreshStatus();
  renderSidebar();
  scheduleRender(true);
}

async function loadUntitled(content: string): Promise<void> {
  currentDoc = null;
  currentPath = null;
  savedContent = content;
  diskModifiedMs = 0;
  dirty = false;

  editor.setDoc(content, true);
  sidebarPanel.resetDirectory(null);

  applyLayout();
  await refreshTitle();
  refreshStatus();
  renderSidebar();
  scheduleRender(true);
}

function setDirty(next: boolean): void {
  if (dirty === next) return;
  dirty = next;
  void refreshTitle();
  refreshStatus();
}

interface OpenOptions {
  confirm?: boolean;
  silent?: boolean;
}

async function openPath(path: string, options: OpenOptions = {}): Promise<void> {
  const { confirm = true, silent = false } = options;
  if (confirm && !(await confirmDiscard())) return;

  try {
    const payload = await api.readDocument(path);
    await adoptDocument(payload, true);

    if (settings.recordRecent) {
      settings = await api.addRecent(path).catch(() => settings);
    }
    if (settings.sidebarTab === "recent") renderSidebar();

    if (payload.lossy) {
      toast("This file is not valid UTF-8. It was opened lossily; saving will rewrite its bytes.");
    }
    if (payload.readOnly) toast("This file is read-only.");
  } catch (error) {
    if (!silent) {
      await message(String(error), { title: "Could not open file", kind: "error" });
    } else {
      toast(String(error));
    }
  }
}

/** Returns true when it is safe to lose the current buffer. */
async function confirmDiscard(): Promise<boolean> {
  if (!dirty) return true;
  const shouldSave = await ask("This document has unsaved changes. Save them first?", {
    title: "Unsaved changes",
    kind: "warning",
  });
  if (!shouldSave) return true;
  return save();
}

async function save(): Promise<boolean> {
  if (!currentPath) return saveAs();
  const content = editor.getDoc();
  try {
    const info = await api.writeDocument(
      currentPath,
      content,
      currentDoc?.lineEnding ?? "\n",
      currentDoc?.hadBom ?? false,
    );
    savedContent = content;
    diskModifiedMs = info.modifiedMs;
    if (currentDoc) {
      currentDoc.size = info.size;
      currentDoc.modifiedMs = info.modifiedMs;
    }
    setDirty(false);
    toast("Saved");
    return true;
  } catch (error) {
    await message(String(error), { title: "Could not save", kind: "error" });
    return false;
  }
}

async function saveAs(): Promise<boolean> {
  const suggested =
    currentPath ??
    (settings.lastDirectory
      ? joinDir(settings.lastDirectory, `untitled.${settings.defaultExtension}`)
      : `untitled.${settings.defaultExtension}`);

  const chosen = await saveDialog({
    title: "Save As",
    defaultPath: suggested,
    filters: [
      { name: "Markdown", extensions: ["md", "markdown", "mdown", "txt"] },
      { name: "All files", extensions: ["*"] },
    ],
  });
  if (!chosen) return false;

  const target = Array.isArray(chosen) ? chosen[0] : chosen;
  const content = editor.getDoc();

  try {
    await api.writeDocument(
      target,
      content,
      currentDoc?.lineEnding ?? "\n",
      currentDoc?.hadBom ?? false,
    );
    const payload = await api.readDocument(target);
    await adoptDocument(payload, false);
    if (settings.recordRecent) {
      settings = await api.addRecent(target).catch(() => settings);
    }
    toast("Saved");
    return true;
  } catch (error) {
    await message(String(error), { title: "Could not save", kind: "error" });
    return false;
  }
}

async function reloadFromDisk(): Promise<void> {
  if (!currentPath) {
    toast("This document has no file on disk yet.");
    return;
  }
  if (dirty && !(await confirmDiscard())) return;
  try {
    const payload = await api.readDocument(currentPath);
    await adoptDocument(payload, false);
    toast("Reloaded from disk");
  } catch (error) {
    toast(String(error));
  }
}

/**
 * Build the article the exports write: the preview pipeline's HTML, with Mermaid
 * drawn and the article wrapped so the stylesheet applies.
 *
 * Shared by the HTML and PDF exports so the two can never drift apart.
 */
async function buildExportArticle(): Promise<string> {
  const holder = document.createElement("div");
  holder.innerHTML = renderPreview(editor.getDoc(), {
    baseDir: currentDoc?.directory ?? null,
    math: settings.enableMath,
    mermaid: settings.enableMermaid,
  }).html;
  await renderMermaidIn(holder, isDark);
  return `<article class="markdown-body">${holder.innerHTML}</article>`;
}

/**
 * The `@font-face` rules an exported document needs, as data URLs.
 *
 * Only the families the reader's own stacks name are embedded, so a document
 * written in one face does not carry four. An empty string means every role is
 * using a system font, in which case there is nothing to embed and the reader's
 * machine supplies the face — which is the honest outcome, not a failure.
 */
function exportFontCss(): Promise<string> {
  const stacks = TYPOGRAPHY_ROLES.map((role) => settings[role.id] || role.fallback);
  return embeddedFontCss(stacks);
}

/** The typography declarations an exported document must carry. */
function exportTypographyCss(): string {
  const declarations = TYPOGRAPHY_ROLES.map(
    (role) => `${role.variable}:${settings[role.id] || role.fallback}`,
  );
  declarations.push(`--body-size:${settings.bodyFontSize}px`);
  declarations.push(
    `--prose-figures:${settings.oldstyleFigures ? "oldstyle-nums" : "normal"}`,
    `--table-figures:${settings.tabularFigures ? "tabular-nums" : "normal"}`,
    `--code-figures:${settings.slashedZero ? "slashed-zero tabular-nums" : "normal"}`,
    `--code-ligatures:${settings.ligaturesInCode ? "contextual common-ligatures" : "none"}`,
  );
  return `:root{${declarations.join(";")}}`;
}

/** Basename of the open document, without its extension. */
function documentStem(): string {
  return currentDoc?.name.replace(/\.[^.]+$/, "") ?? "untitled";
}

async function exportHtml(): Promise<void> {
  const base = documentStem();
  const suggested = settings.lastDirectory
    ? joinDir(settings.lastDirectory, `${base}.html`)
    : `${base}.html`;

  const chosen = await saveDialog({
    title: "Export as HTML",
    defaultPath: suggested,
    filters: [{ name: "HTML", extensions: ["html", "htm"] }],
  });
  if (!chosen) return;
  const target = Array.isArray(chosen) ? chosen[0] : chosen;

  try {
    const article = await buildExportArticle();
    const highlightStyle = document.getElementById("hljs-theme")?.textContent ?? "";
    const fontCss = await exportFontCss();
    const headExtra = [
      `<style>${fontCss}</style>`,
      `<style>${exportTypographyCss()}</style>`,
      "<style>",
      highlightStyle,
      ".markdown-body{max-width:none}",
      "</style>",
      `<link rel="stylesheet" href="${KATEX_STYLESHEET_URL}">`,
    ].join("\n");

    const html = wrapStandaloneHtml(
      currentDoc?.name ?? "Untitled",
      article,
      isDark,
      headExtra,
    );
    await api.writeDocument(target, html, "\n", false);
    toast("Exported HTML");
  } catch (error) {
    await message(String(error), { title: "Could not export", kind: "error" });
  }
}

/**
 * Export PDF through the system's own print-to-PDF.
 *
 * Deliberately not pandoc: that route needs a LaTeX engine of several hundred
 * megabytes, and the document would lose the parts of the preview pandoc has no
 * equivalent for (the `[TOC]` marker, GitHub alert callouts). Rendering the same
 * HTML the preview uses means the PDF matches what is on screen, with nothing
 * installed.
 *
 * The printing itself happens in the system browser rather than in this window:
 * WebView2 provides no print interface of its own, so `window.print()` here
 * fires no dialog and produces nothing. The document carries a `window.print()`
 * of its own, so the browser opens straight onto its print preview and the user
 * only has to choose "Save as PDF".
 */
async function exportPdf(): Promise<void> {
  const notice = toast("Preparing the PDF…", 0);
  try {
    const article = await buildExportArticle();
    // The print document is always light, whatever the editor is showing: dark
    // token colours would print as pale text on white paper. Its typefaces,
    // however, are the reader's — embedded, because a browser reading a file in
    // the temporary directory cannot reach the application's assets.
    const html = wrapPrintHtml(
      currentDoc?.name ?? "Untitled",
      article,
      highlightThemeCss(false),
      exportTypographyCss(),
      await exportFontCss(),
    );
    const written = await api.printDocument(html, documentStem());
    notice.dismiss();
    toast("Choose “Save as PDF” in the print dialog");
    console.info(`[export] print document written to ${written}`);
  } catch (error) {
    notice.dismiss();
    await message(String(error), { title: "Could not prepare the PDF", kind: "error" });
  }
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/** Menu ids for configured pandoc formats; must match `menu::EXPORT_PREFIX`. */
const EXPORT_MENU_PREFIX = "export.pandoc.";

/**
 * The last pandoc status we looked up.
 *
 * The Preferences panel builds its rows synchronously, so it cannot await a
 * check itself. This caches the answer; the panel redraws when a check lands.
 */
let pandocCache: api.PandocStatus | null = null;

async function refreshPandocStatus(): Promise<void> {
  try {
    pandocCache = await api.pandocStatus();
  } catch {
    // A failed lookup leaves the cache alone: the Export panel will keep saying
    // whatever it last knew rather than claiming pandoc disappeared.
    return;
  }
  preferences?.refresh();
}

/** A sensible default filename for an export of the current document. */
function exportSuggestion(format: api.ExportFormat): string {
  const base = currentDoc?.name.replace(/\.[^.]+$/, "") ?? "untitled";
  const name = `${base}.${format.extension}`;
  return settings.lastDirectory ? joinDir(settings.lastDirectory, name) : name;
}

/**
 * Export the document with pandoc.
 *
 * The document text is sent as it stands in the editor rather than read back
 * from disk, so unsaved edits are included and an untitled document can be
 * exported at all. The after-export options run on the Rust side, where the
 * output path is known to be the file that was just written.
 */
async function exportWithPandoc(format: api.ExportFormat): Promise<void> {
  const chosen = await saveDialog({
    title: `Export as ${format.label}`,
    defaultPath: exportSuggestion(format),
    filters: [
      { name: format.label, extensions: [format.extension] },
      { name: "All files", extensions: ["*"] },
    ],
  });
  if (!chosen) return;
  const outputPath = Array.isArray(chosen) ? chosen[0] : chosen;

  const notice = toast(`Exporting with pandoc…`, 0);
  try {
    const outcome = await api.runExport({
      formatId: format.id,
      markdown: editor.getDoc(),
      outputPath,
      inputPath: currentPath,
    });
    notice.dismiss();
    toast(`Exported ${basename(outcome.outputPath)}`);

    // Pandoc can succeed and still warn, and an after-export step can fail
    // without the file being wrong. Both are worth showing, neither is an error.
    const notes = [...outcome.afterErrors];
    if (outcome.warnings) notes.push(outcome.warnings);
    if (notes.length > 0) {
      await message(notes.join("\n\n"), {
        title: outcome.afterErrors.length > 0 ? "Exported, with a problem" : "Exported with warnings",
        kind: outcome.afterErrors.length > 0 ? "warning" : "info",
      });
    }
  } catch (error) {
    notice.dismiss();
    await message(String(error), { title: "Could not export", kind: "error" });
  }
}

/**
 * Help › Install Pandoc.
 *
 * Reports what was found before offering to download anything, so a user who
 * already has pandoc on PATH is told that rather than being pushed into a 40 MB
 * download. Nothing is installed without an explicit confirmation.
 */
async function pandocSetup(): Promise<void> {
  let status: api.PandocStatus;
  try {
    status = await api.pandocStatus();
  } catch (error) {
    await message(String(error), { title: "Could not look for pandoc", kind: "error" });
    return;
  }

  const engine = status.pdfEngine
    ? `\nPDF engine: ${basename(status.pdfEngine)}`
    : "\nPDF engine: none found — PDF export needs a LaTeX engine such as Tectonic, TinyTeX or MiKTeX. Every other format works without one.";

  if (status.found) {
    await message(
      `Pandoc ${status.version ?? "(unknown version)"} is ready.\n\n` +
        `Location: ${status.path}\n` +
        `Installed by: ${status.source === "managed" ? "MDraft" : "you (found on PATH)"}` +
        engine +
        `\n\nExporting again will download and replace MDraft's own copy.`,
      { title: "Pandoc", kind: "info" },
    );
    return;
  }

  const agreed = await ask(
    "Pandoc was not found, so Word, PDF, EPUB and the other export formats are unavailable.\n\n" +
      "MDraft can download the official pandoc build and unpack it into its own data folder. " +
      "Nothing is installed system-wide, no administrator rights are needed, and removing the " +
      "folder undoes it.\n\n" +
      "The download is about 40 MB and is verified against the checksum GitHub publishes." +
      engine,
    { title: "Install Pandoc", kind: "info", okLabel: "Download", cancelLabel: "Cancel" },
  );
  if (!agreed) return;

  const notice = toast("Downloading pandoc…", 0);
  try {
    const installed = await api.installPandoc();
    notice.dismiss();
    await message(
      `Pandoc ${installed.version ?? ""} is ready.\n\n${installed.path ?? ""}\n\n` +
        (installed.pdfEngine
          ? `PDF export will use ${basename(installed.pdfEngine)}.`
          : "PDF export still needs a LaTeX engine; every other format works now."),
      { title: "Pandoc installed", kind: "info" },
    );
  } catch (error) {
    notice.dismiss();
    await message(String(error), { title: "Could not install pandoc", kind: "error" });
  }
}

// ---------------------------------------------------------------------------
// Menu
// ---------------------------------------------------------------------------

const handlers: Record<string, () => void | Promise<void>> = {
  "file.new": async () => {
    if (!(await confirmDiscard())) return;
    await loadUntitled("");
  },
  "file.open": async () => {
    if (!(await confirmDiscard())) return;
    const chosen = await openDialog({
      title: "Open Markdown File",
      multiple: false,
      directory: false,
      defaultPath: settings.lastDirectory ?? undefined,
      filters: [
        { name: "Markdown", extensions: ["md", "markdown", "mdown", "mkd", "txt"] },
        { name: "All files", extensions: ["*"] },
      ],
    });
    if (!chosen) return;
    const path = Array.isArray(chosen) ? chosen[0] : chosen;
    await openPath(path, { confirm: false });
  },
  "file.save": () => void save(),
  "file.saveAs": () => void saveAs(),
  "file.reload": () => void reloadFromDisk(),
  "export.html": () => void exportHtml(),
  "export.pdf": () => void exportPdf(),
  "file.reveal": async () => {
    if (!currentPath) {
      toast("Save the document first.");
      return;
    }
    try {
      await revealItemInDir(currentPath);
    } catch (error) {
      toast(String(error));
    }
  },

  "edit.find": () => editor.openSearch(false),
  "edit.replace": () => editor.openSearch(true),

  "para.h1": () => editor.setHeading(1),
  "para.h2": () => editor.setHeading(2),
  "para.h3": () => editor.setHeading(3),
  "para.h4": () => editor.setHeading(4),
  "para.h5": () => editor.setHeading(5),
  "para.h6": () => editor.setHeading(6),
  "para.paragraph": () => editor.setHeading(0),
  "para.increaseHeading": () => editor.shiftHeading(-1),
  "para.decreaseHeading": () => editor.shiftHeading(1),
  "para.quote": () => editor.toggleLinePrefix("> "),
  "para.codeBlock": () => editor.insertBlockWithCaret("```\n\n```", 4),
  "para.mathBlock": () => editor.insertBlockWithCaret("$$\n\n$$\n", 3),
  "para.ul": () => editor.toggleLinePrefix("- "),
  "para.ol": () => editor.toggleLinePrefix("1. "),
  "para.task": () => editor.toggleLinePrefix("- [ ] "),
  "para.taskDone": () => editor.setTaskState("done"),
  "para.taskTodo": () => editor.setTaskState("todo"),
  "para.taskPlain": () => editor.setTaskState("plain"),
  "para.indent": () => editor.indentLines(1),
  "para.outdent": () => editor.indentLines(-1),
  "para.insertBefore": () => editor.insertParagraphBefore(),
  "para.insertAfter": () => editor.insertParagraphAfter(),
  "para.table": () =>
    editor.insertBlock("| Column | Column |\n| --- | --- |\n| Cell | Cell |"),
  "para.hr": () => editor.insertBlock("---"),
  "para.toc": () => editor.insertToc(),
  "para.yaml": () => editor.insertYamlFrontMatter(),
  "para.alertNote": () => editor.insertBlock("> [!NOTE]\n> "),
  "para.alertTip": () => editor.insertBlock("> [!TIP]\n> "),
  "para.alertImportant": () => editor.insertBlock("> [!IMPORTANT]\n> "),
  "para.alertWarning": () => editor.insertBlock("> [!WARNING]\n> "),
  "para.alertCaution": () => editor.insertBlock("> [!CAUTION]\n> "),

  "format.bold": () => editor.wrapSelection("**", "**", "strong text"),
  "format.italic": () => editor.wrapSelection("*", "*", "emphasis"),
  "format.strike": () => editor.wrapSelection("~~", "~~", "strikethrough"),
  "format.code": () => editor.wrapSelection("`", "`", "code"),
  "format.link": () => editor.wrapSelection("[", "](https://)", "link text"),
  "format.image": () => editor.wrapSelection("![", "](./image.png)", "alt text"),
  "format.math": () => editor.wrapSelection("$", "$", "e^{i\\pi}+1=0"),

  "themes.system": () => setTheme("system"),
  "themes.light": () => setTheme("light"),
  "themes.dark": () => setTheme("dark"),

  "view.source": () => setViewMode("source"),
  "view.split": () => setViewMode("split"),
  "view.preview": () => setViewMode("preview"),
  "view.sidebar": () => setSidebarVisible(!settings.sidebarVisible),
  "view.outline": () => setSidebarTab("outline"),
  "view.files": () => setSidebarTab("files"),
  "view.recent": () => setSidebarTab("recent"),
  "view.statusBar": () => {
    settings.showStatusBar = !settings.showStatusBar;
    applyLayout();
    persist();
  },
  "view.focus": () => {
    settings.focusMode = !settings.focusMode;
    applyLayout();
    persist();
  },
  "view.typewriter": () => {
    settings.typewriterMode = !settings.typewriterMode;
    applyLayout();
    persist();
    toast(`Typewriter mode ${settings.typewriterMode ? "on" : "off"}`);
  },
  "view.syncScroll": () => {
    settings.syncScroll = !settings.syncScroll;
    persist();
    toast(`Sync scroll ${settings.syncScroll ? "on" : "off"}`);
  },
  "view.zoomIn": () => setFontSize(settings.editorFontSize + 1),
  "view.zoomOut": () => setFontSize(settings.editorFontSize - 1),
  "view.zoomReset": () => {
    settings.editorFontSize = DEFAULT_FONT_SIZE;
    settings.editorMaxWidth = 980;
    applyLayout();
    persist();
  },

  "file.preferences": () => preferences.toggle(),

  "help.reference": () => void showBuiltin(REFERENCE),
  "help.shortcuts": () => void showBuiltin(SHORTCUTS),
  "help.pandoc": () => void pandocSetup(),
  "help.about": async () => {
    await message(
      [
        "MDraft",
        "",
        "A Tauri 2 markdown editor in the spirit of Typora.",
        "",
        "Editor: CodeMirror 6",
        "Markdown: marked + DOMPurify",
        "Math: KaTeX",
        "Diagrams: Mermaid",
        "Highlighting: highlight.js",
      ].join("\n"),
      { title: "About MDraft", kind: "info" },
    );
  },
};

async function showBuiltin(content: string): Promise<void> {
  if (!(await confirmDiscard())) return;
  await loadUntitled(content);
  toast("Built-in document — use Save As to keep a copy");
}

function setViewMode(mode: api.ViewMode): void {
  settings.viewMode = mode;
  applyLayout();
  persist();
  if (mode !== "source") {
    scheduleRender(true);
  }
}

function setSidebarVisible(visible: boolean): void {
  settings.sidebarVisible = visible;
  applyLayout();
  persist();
  if (visible) renderSidebar();
}

function setSidebarTab(tab: api.SidebarTab): void {
  settings.sidebarTab = tab;
  if (!settings.sidebarVisible) settings.sidebarVisible = true;
  applyLayout();
  persist();
  renderSidebar();
}

function setFontSize(size: number): void {
  settings.editorFontSize = Math.min(MAX_FONT, Math.max(MIN_FONT, size));
  applyLayout();
  persist();
  toast(`Font size ${settings.editorFontSize}px`);
}

// ---------------------------------------------------------------------------
// Source <-> preview position sync
//
// The preview carries a `data-line` attribute on every top-level block, so the
// two panes can be aligned by content instead of by scroll ratio. Programmatic
// scrolling is wrapped in a short suppression window because assigning
// scrollTop fires the same scroll event a user gesture would.
// ---------------------------------------------------------------------------

interface Anchor {
  line: number;
  el: HTMLElement;
}

let previewAnchors: Anchor[] = [];
let previewLinesMapped = false;
let blinkingAnchor: HTMLElement | null = null;
let blinkTimer = 0;
/** True while the caret is being placed with the pointer rather than the keyboard. */
let caretByPointer = false;
let suppressPreviewScrollUntil = 0;
let suppressEditorScrollUntil = 0;

function rebuildAnchors(): void {
  previewAnchors = Array.from(preview.querySelectorAll<HTMLElement>("[data-line]"))
    .map((el) => ({ line: Number(el.dataset.line), el }))
    .filter((anchor) => Number.isFinite(anchor.line))
    .sort((a, b) => a.line - b.line);
  blinkingAnchor = null;
  window.clearTimeout(blinkTimer);
}

/** Last block that starts at or before `line`. */
function anchorForLine(line: number): HTMLElement | null {
  let found: HTMLElement | null = null;
  for (const anchor of previewAnchors) {
    if (anchor.line <= line) found = anchor.el;
    else break;
  }
  return found ?? previewAnchors[0]?.el ?? null;
}

/** Source line of the block currently sitting at the top of the preview. */
function lineAtPreviewTop(): number | null {
  if (previewAnchors.length === 0) return null;
  const top = previewPane.getBoundingClientRect().top + 1;
  let current: number | null = null;
  for (const anchor of previewAnchors) {
    if (anchor.el.getBoundingClientRect().top <= top) current = anchor.line;
    else break;
  }
  return current ?? previewAnchors[0].line;
}

/** Move the preview so a block sits just under its top edge. */
function alignPreviewToLine(line: number): void {
  const el = anchorForLine(line);
  if (!el) return;
  const delta = el.getBoundingClientRect().top - previewPane.getBoundingClientRect().top;
  suppressPreviewScrollUntil = performance.now() + SYNC_SUPPRESS_MS;
  previewPane.scrollTop += delta - 12;
}

/**
 * Bring a block into view, but only when it is not already there.
 *
 * This is deliberately not `alignPreviewToLine`. Yanking a block to the top when
 * the reader could already see it throws away an alignment they had: click a
 * heading near the bottom of the source, and the preview jumps so that heading
 * leads the pane while the source has not moved at all. The panes are then
 * showing different parts of the document, which is worse than not following.
 *
 * Any part of the block being on screen counts as visible, so the ordinary case
 * does nothing and only the blink is seen. Revealing still happens when the
 * caret genuinely leaves the view — arrowing past the fold, Go to Line, a search
 * hit — because then the block really is off screen.
 */
function revealPreviewLine(line: number): void {
  const el = anchorForLine(line);
  if (!el) return;
  const pane = previewPane.getBoundingClientRect();
  const box = el.getBoundingClientRect();
  if (box.bottom > pane.top && box.top < pane.bottom) return;
  alignPreviewToLine(line);
}

/**
 * Flash the preview block that matches a line, then let it fade.
 *
 * A persistent highlight was wrong here: it stays on screen and reads as markup
 * applied to the document, which is confusing in a preview. The two panes are
 * already side by side, so a brief blink is enough to point at the block and
 * then get out of the way.
 */
function blinkAnchor(line: number): void {
  const el = anchorForLine(line);
  if (!el) return;
  if (blinkingAnchor && blinkingAnchor !== el) {
    blinkingAnchor.classList.remove("sync-blink");
  }
  window.clearTimeout(blinkTimer);
  // Remove and re-add so clicking the same block twice replays the animation.
  el.classList.remove("sync-blink");
  void el.offsetWidth;
  el.classList.add("sync-blink");
  blinkingAnchor = el;
  blinkTimer = window.setTimeout(() => {
    el.classList.remove("sync-blink");
    blinkingAnchor = null;
  }, BLINK_MS);
}

/** Keep the caret's block in the preview across a re-render, without jumping. */
function revealCursorInPreview(): void {
  if (settings.viewMode !== "split" || !previewLinesMapped) return;
  // A re-render can land just after a click (a pending mermaid pass, a debounced
  // render). Revealing then would move the preview for a caret the reader placed
  // with the pointer, reintroducing the jump through the back door.
  if (caretByPointer) return;
  revealPreviewLine(editor.cursorInfo().line);
}

function installPaneSync(): void {
  // Caret in the source -> the preview follows the keyboard, never the pointer.
  //
  // A click is aimed at something the reader can already see in the source, and
  // the rendered preview is much taller than its markdown, so the matching block
  // is often off screen even when the line is not. Revealing it then would drag
  // the preview somewhere else and the panes would stop showing the same part of
  // the document — which is exactly the jump that made clicking feel broken.
  // The keyboard is the opposite case: arrowing past the fold leaves the caret's
  // block genuinely invisible, and there the preview should follow.
  editorPane.addEventListener("mousedown", () => {
    caretByPointer = true;
  });
  editorPane.addEventListener("keydown", () => {
    caretByPointer = false;
  });

  editor.onCursor((info) => {
    refreshStatus();
    updateActiveOutline();
    // A caret we just moved from the preview must not move the preview.
    if (caretCameFromPreview) return;
    if (settings.viewMode !== "split" || !previewLinesMapped) return;
    if (caretByPointer) return;
    suppressEditorScrollUntil = performance.now() + SYNC_SUPPRESS_MS;
    revealPreviewLine(info.line);
  });

  // A click points at the matching preview block with a blink that fades by
  // itself, and moves nothing. No strobe risk: the caret moves on every
  // keystroke, but a click is one discrete action.
  editorPane.addEventListener("click", () => {
    if (settings.viewMode !== "split" || !previewLinesMapped) return;
    blinkAnchor(editor.cursorInfo().line);
  });

  // Scrolling the source -> the preview follows the top visible block. This one
  // aligns unconditionally, because that is what keeps the two panes together
  // while the reader scrolls.
  editor.onScroll(() => {
    if (!settings.syncScroll || settings.viewMode !== "split" || !previewLinesMapped) return;
    if (performance.now() < suppressEditorScrollUntil) return;
    alignPreviewToLine(editor.topVisibleLine());
  });

  // Click in the preview -> the source reveals that line, and the preview stays
  // exactly where it is so text selection keeps working.
  preview.addEventListener("mousedown", (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-line]");
    if (!target) return;
    const line = Number(target.dataset.line);
    if (!Number.isFinite(line)) return;
    suppressEditorScrollUntil = performance.now() + SYNC_SUPPRESS_MS;
    caretCameFromPreview = true;
    try {
      editor.revealLine(line, true, false);
    } finally {
      caretCameFromPreview = false;
    }
    blinkAnchor(line);
  });

  // Scrolling the preview -> the source follows the top visible block.
  // The scrolling element is the pane, not the rendered document inside it.
  previewPane.addEventListener("scroll", () => {
    if (!settings.syncScroll || settings.viewMode !== "split") return;
    if (performance.now() < suppressPreviewScrollUntil) return;
    const line = lineAtPreviewTop();
    if (line === null) return;
    suppressEditorScrollUntil = performance.now() + SYNC_SUPPRESS_MS;
    editor.revealLine(line, false, false);
  });
}

// ---------------------------------------------------------------------------
// Preview link handling
// ---------------------------------------------------------------------------

function installPreviewClicks(): void {
  preview.addEventListener("click", (event) => {
    const target = (event.target as HTMLElement).closest("a, .local-link, .external-link");
    if (!target) return;
    const href = target.getAttribute("data-href") ?? "";
    if (!href) return;

    event.preventDefault();
    event.stopPropagation();

    if (href.startsWith("#")) {
      const id = href.slice(1);
      const heading = preview.querySelector(`[id="${CSS.escape(id)}"]`);
      heading?.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    if (/^https?:/i.test(href)) {
      void openUrl(href).catch((error) => toast(String(error)));
      return;
    }
    if (href.startsWith("mailto:")) {
      void openUrl(href).catch((error) => toast(String(error)));
      return;
    }

    // Relative or absolute filesystem path: resolve against the document.
    const dir = currentDoc?.directory ?? null;
    let path = href;
    try {
      path = decodeURI(href);
    } catch {
      /* keep raw */
    }
    if (!/^[A-Za-z]:[\\/]/.test(path) && !path.startsWith("/") && dir) {
      path = joinDir(dir, path);
    }
    void openPath(path);
  });
}

// ---------------------------------------------------------------------------
// Resizers
// ---------------------------------------------------------------------------

function installResizers(): void {
  let mode: "sidebar" | "split" | null = null;

  const begin = (next: "sidebar" | "split") => (event: MouseEvent) => {
    mode = next;
    event.preventDefault();
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };

  resizer.addEventListener("mousedown", begin("sidebar"));
  splitter.addEventListener("mousedown", begin("split"));

  window.addEventListener("mousemove", (event) => {
    if (!mode) return;

    if (mode === "sidebar") {
      const width = Math.min(520, Math.max(140, event.clientX));
      document.documentElement.style.setProperty("--sidebar-w", `${width}px`);
      return;
    }

    const workspace = editorPane.parentElement;
    if (!workspace) return;
    const rect = workspace.getBoundingClientRect();
    if (rect.width < 360) return;
    const offset = Math.min(Math.max(event.clientX - rect.left, 180), rect.width - 180);
    editorPane.style.flex = `0 0 ${offset}px`;
    previewPane.style.flex = "1 1 auto";
  });

  window.addEventListener("mouseup", () => {
    mode = null;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  });
}

// ---------------------------------------------------------------------------
// Native integrations
// ---------------------------------------------------------------------------

async function installMenuListener(): Promise<void> {
  await listen<string>("menu", (event) => {
    const id = event.payload;
    // The pandoc entries are generated from the user's own format list, so they
    // cannot be keys in `handlers`. The menu builds them as "export.pandoc.<id>".
    if (id.startsWith(EXPORT_MENU_PREFIX)) {
      const formatId = id.slice(EXPORT_MENU_PREFIX.length);
      const format = settings.exportFormats.find((f) => f.id === formatId);
      if (!format) {
        toast("That export format no longer exists.");
        return;
      }
      void exportWithPandoc(format).catch((error) => toast(String(error)));
      return;
    }
    const handler = handlers[id];
    if (!handler) return;
    void Promise.resolve(handler()).catch((error) => toast(String(error)));
  });
}

async function installDragDrop(): Promise<void> {
  const win = getCurrentWindow();
  await win.onDragDropEvent(async (event) => {
    if (event.payload.type !== "drop" || event.payload.paths.length === 0) return;
    // Images are imported; anything else is opened as a document.
    const remaining = await handleImageDrop(event.payload.paths, imageContext());
    if (remaining.length > 0) void openPath(remaining[0]);
  });
}

async function installCloseGuard(): Promise<void> {
  const win = getCurrentWindow();
  await win.onCloseRequested(async (event) => {
    if (allowClose || !dirty) return;
    event.preventDefault();
    const shouldSave = await ask("You have unsaved changes. Save them before closing?", {
      title: "Unsaved changes",
      kind: "warning",
    });
    if (shouldSave && !(await save())) return;
    allowClose = true;
    await win.close();
  });
}

function installDiskWatcher(): void {
  window.setInterval(async () => {
    if (!currentPath || dirty) return;
    try {
      const stat = await api.statDocument(currentPath);
      if (!stat.exists || stat.modifiedMs === diskModifiedMs) return;
      const payload = await api.readDocument(currentPath);
      if (payload.content === savedContent) {
        diskModifiedMs = payload.modifiedMs;
        return;
      }
      const cursor = editor.cursorInfo();
      await adoptDocument(payload, false);
      editor.scrollToLine(cursor.line);
      toast("The file changed on disk — reloaded");
    } catch {
      /* the file may have vanished; leave the buffer alone */
    }
  }, 2500);
}

function installSystemThemeWatcher(): void {
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  media.addEventListener("change", () => {
    if (settings.theme !== "system") return;
    applyTheme();
    scheduleRender(true);
  });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Image paste and drop
// ---------------------------------------------------------------------------

function imageContext(): ImageContext {
  return {
    settings,
    documentPath: currentPath,
    insert: (markdown) => editor.insertBlock(markdown),
    notify: (text, isError = false) => toast(text, isError ? 5200 : 3200),
  };
}

/**
 * Paste listeners run in the capture phase so the event can be consumed before
 * CodeMirror or the browser turns it into text.
 */
function installImagePaste(): void {
  const handler = (event: ClipboardEvent) => {
    // A paste over the preview targets the block under the pointer: move the
    // caret there first so the image lands where the user aimed.
    const target = event.target as HTMLElement | null;
    const anchor = target?.closest?.<HTMLElement>("[data-line]");
    if (anchor) {
      const line = Number(anchor.dataset.line);
      if (Number.isFinite(line)) editor.revealLine(line, true, false);
    }

    // The decision and preventDefault must happen in this same turn; deferring
    // them to a promise lets the browser insert the pasted text as well.
    if (handleImagePaste(event, imageContext())) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  editorPane.addEventListener("paste", handler, { capture: true });
  previewPane.addEventListener("paste", handler, { capture: true });
}

function installChrome(): void {
  el<HTMLButtonElement>("tab-outline").addEventListener("click", () => setSidebarTab("outline"));
  el<HTMLButtonElement>("tab-files").addEventListener("click", () => setSidebarTab("files"));
  el<HTMLButtonElement>("tab-recent").addEventListener("click", () => setSidebarTab("recent"));
  el<HTMLButtonElement>("btn-sidebar").addEventListener("click", () =>
    setSidebarVisible(!settings.sidebarVisible),
  );
  el<HTMLButtonElement>("btn-prefs").addEventListener("click", () => preferences.toggle());
  el<HTMLButtonElement>("mode-source").addEventListener("click", () => setViewMode("source"));
  el<HTMLButtonElement>("mode-split").addEventListener("click", () => setViewMode("split"));
  el<HTMLButtonElement>("mode-preview").addEventListener("click", () => setViewMode("preview"));
  el<HTMLButtonElement>("btn-theme").addEventListener("click", () =>
    setTheme(isDark ? "light" : "dark"),
  );
}

async function boot(): Promise<void> {
  // Before the first paint, so the preview is never drawn in a fallback and then
  // corrected. The faces are local files, so this costs a millisecond.
  installBundledFonts();

  settings = await api.getSettings();
  applyTheme();

  editor = createEditor(editorHost);
  editor.onDocChanged((text) => {
    setDirty(text !== savedContent);
    refreshStatus();
    scheduleRender();
    updateActiveOutline();
  });
  editor.onCursor(() => {
    refreshStatus();
    updateActiveOutline();
  });

  preferences = createPreferences({
    settings: () => settings,
    update: applySettingsPatch,
    clearRecent: () => {
      void api.clearRecent().then((next) => {
        settings = next;
        renderSidebar();
        toast("Recent files cleared");
      });
    },
    exportHtml: () => void exportHtml(),
    exportPdf: () => void exportPdf(),
    openDocumentation: (which) => void showBuiltin(which === "reference" ? REFERENCE : SHORTCUTS),
    version: () => APP_VERSION,
    pandocStatus: () => pandocCache,
    setupPandoc: async () => {
      await pandocSetup();
      await refreshPandocStatus();
    },
    chooseStyleReference: async (current) => {
      const chosen = await openDialog({
        title: "Choose a Style Reference",
        multiple: false,
        directory: false,
        defaultPath: current || undefined,
        filters: [
          { name: "Reference documents", extensions: ["docx", "odt", "css"] },
          { name: "All files", extensions: ["*"] },
        ],
      });
      if (!chosen) return "";
      return Array.isArray(chosen) ? chosen[0] : chosen;
    },
  });

  installChrome();
  installPaneSync();
  installImagePaste();
  installPreviewClicks();
  installResizers();
  installSystemThemeWatcher();

  applyLayout();

  await installMenuListener();
  await installDragDrop();
  await installCloseGuard();
  // Look for pandoc in the background: nothing at start-up depends on it, and
  // the answer only matters once the Export menu or panel is used.
  void refreshPandocStatus();
  await listen<string[]>("open-files", (event) => {
    const first = event.payload[0];
    if (first) void openPath(first);
  });

  const startup = await api.startupFile().catch(() => null);
  if (startup) {
    await openPath(startup, { confirm: false, silent: true });
  } else if (settings.onLaunch === "new") {
    await loadUntitled("");
  } else if (settings.onLaunch === "last" && settings.recentFiles.length > 0) {
    await openPath(settings.recentFiles[0], { confirm: false, silent: true });
  } else {
    await loadUntitled(WELCOME);
  }

  installDiskWatcher();
  installAutoSave();
  editor.focus();
}

/** Save in place on a timer when Auto Save is enabled in Preferences. */
function installAutoSave(): void {
  window.setInterval(() => {
    if (!settings.autoSave || !dirty || !currentPath) return;
    if (currentDoc?.readOnly) return;
    void save().then((ok) => {
      if (ok) toast("Auto saved", 1400);
    });
  }, AUTO_SAVE_INTERVAL_MS);
}

void boot().catch(async (error) => {
  // Surface a failed boot instead of leaving a blank window.
  const text = error instanceof Error ? error.message : String(error);
  document.body.innerHTML = `<pre style="padding:24px;font:13px/1.6 monospace;white-space:pre-wrap">Failed to start MDraft:\n\n${text.replace(
    /</g,
    "&lt;",
  )}</pre>`;
  try {
    await message(text, { title: "MDraft failed to start", kind: "error" });
  } catch {
    /* the dialog plugin may itself be unavailable */
  }
});
