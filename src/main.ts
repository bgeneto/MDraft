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
import { FONT_LICENCES, REFERENCE, SHORTCUTS, WELCOME } from "./content";
import { createEditor, type EditorHandle } from "./editor";
import {
  embeddedFontCss,
  installBundledFonts,
  TYPOGRAPHY_ROLES,
} from "./fonts";
import { applyHighlightTheme, highlightThemeCss } from "./highlight-theme";
import {
  buildHtmlPrintDocument,
  createHtmlPreview,
  type HtmlAccelerator,
  type HtmlLayout,
  type HtmlPreviewHandle,
} from "./html-preview";
import { handleImageDrop, handleImagePaste, type ImageContext } from "./images";
import {
  KATEX_STYLESHEET_URL,
  renderMermaidIn,
  renderPreview,
  wrapPrintHtml,
  wrapStandaloneHtml,
} from "./markdown";
import { createPreferences, type PreferencesHandle } from "./preferences";
import { setInstalledLanguages, setSpellRemember } from "./spellcheck";
import * as sidebarPanel from "./sidebar";
import { resolvePalette } from "./syntax-themes";
import { annotateTypstLines } from "./typst-map";

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
const statusTokens = el<HTMLSpanElement>("status-tokens");
const statusWords = el<HTMLSpanElement>("status-words");
const statusCursor = el<HTMLSpanElement>("status-cursor");
const statusEncoding = el<HTMLSpanElement>("status-encoding");
const statusZoom = el<HTMLButtonElement>("status-zoom");
const toastEl = el<HTMLDivElement>("toast");
const resizer = el<HTMLDivElement>("resizer");
const splitter = el<HTMLDivElement>("splitter");

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let editor: EditorHandle;
let htmlPreview: HtmlPreviewHandle;
let preferences: PreferencesHandle;
let settings: api.Settings;
let currentDoc: api.DocumentPayload | null = null;
let currentPath: string | null = null;
let savedContent = "";
let dirty = false;
let diskModifiedMs = 0;
let isDark = false;
/** Mirrors the window's fullscreen state, so the menu check can follow it. */
let isFullscreen = false;
let allowClose = false;
let lastTitle = "";
/** Menu accelerators the guest is allowed to ask the parent to run. */
let knownAcceleratorIds = new Set<string>();

/** Debounce for the token estimate; long enough that typing does not queue scans. */
const TOKEN_COUNT_DELAY_MS = 300;
let tokenCountTimer = 0;
/** Drops an estimate that a newer edit has already made stale. */
let tokenCountRequest = 0;

/**
 * Headings cached from the last outline rebuild, with the markup they came from.
 *
 * Cursor movement only moves the active marker. Scanning the document and
 * rebuilding hundreds of buttons on every arrow key was the outline's real cost.
 */
let outlineHeadings: sidebarPanel.Heading[] = [];
let outlineLanguage: api.DocumentLanguage | null = null;
let outlineReady = false;
let outlineTimer = 0;
/** Headings are document-shaped, so they can wait for a typing pause. */
const OUTLINE_REFRESH_DELAY_MS = 250;

const DEFAULT_FONT_SIZE = 16;
const MIN_FONT = 10;
const MAX_FONT = 40;
const AUTO_SAVE_INTERVAL_MS = 20_000;
/** Scroll alignment window, in ms, after a programmatic pane scroll. */
const SYNC_SUPPRESS_MS = 150;
/**
 * How far below the preview pane's top edge scroll sync puts the aligned block.
 *
 * Both directions use the same offset, so mapping forward and back through an
 * anchor returns to the same source position instead of accumulating a drift.
 */
const SYNC_MARGIN = 12;
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

/**
 * The two theme icons. Swapping the markup rather than keeping both SVGs and
 * hiding one keeps the button's children to a single visible icon, which is what
 * the layout and the status-icon test measure.
 */
const SUN_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true">
  <circle cx="12" cy="12" r="4.2" />
  <path d="M12 2.5v2.3M12 19.2v2.3M2.5 12h2.3M19.2 12h2.3M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M18.7 5.3l-1.6 1.6M6.9 17.1l-1.6 1.6" />
</svg>`;
const MOON_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
</svg>`;

/** Draw the icon that names the theme currently in use, not the one a click goes to. */
function applyThemeButton(): void {
  const button = el<HTMLButtonElement>("btn-theme");
  button.innerHTML = isDark ? MOON_ICON : SUN_ICON;
  const label = isDark ? "Switch to light theme" : "Switch to dark theme";
  button.title = label;
  button.setAttribute("aria-label", label);
}

function applyTheme(): void {
  isDark = resolveDark();
  document.documentElement.dataset.theme = isDark ? "dark" : "light";
  applyThemeButton();
  applyHighlightTheme(isDark);
  applySyntaxTheme();
}

/** The editor keeps its own palette, which may differ from the app theme. */
function applySyntaxTheme(): void {
  editor?.setSyntax(resolvePalette(settings.syntaxTheme, isDark));
}

/**
 * Say a mode changed only when the status bar cannot.
 *
 * With the bar visible the flag is the feedback, and a toast on top of it is
 * noise; with the bar hidden the toast is the only confirmation there is.
 */
function announceIfBarHidden(label: string, on: boolean): void {
  if (!settings.showStatusBar) toast(`${label} ${on ? "on" : "off"}`);
}

/**
 * Draw one status flag.
 *
 * `on` is the state, `inactive` says the mode has no effect in this view (Sync
 * Scroll outside Split). Both are written to the DOM rather than kept in a
 * closure: the CSS owns the appearance, and the attribute makes the state
 * inspectable by the tests without reading colours.
 */
function setStatusFlag(
  id: string,
  on: boolean,
  inactive: boolean,
  label: string,
  shortcut = "",
  hint = "",
): void {
  const button = el<HTMLButtonElement>(id);
  button.dataset.on = String(on);
  button.dataset.inactive = String(inactive);
  button.setAttribute("aria-pressed", String(on));
  const value = button.querySelector<HTMLElement>(".flag-state");
  if (value) value.textContent = on ? "on" : "off";

  const title = [`${label}${shortcut ? ` (${shortcut})` : ""} — ${on ? "on" : "off"}`];
  if (hint) title.push(hint);
  title.push(`Click to turn ${on ? "off" : "on"}.`);
  button.title = title.join(" ");
  button.setAttribute("aria-label", `${label}: ${on ? "on" : "off"}`);
}

/** Refresh the four mode flags from the state that also drives the menu. */
function updateStatusFlags(): void {
  setStatusFlag("flag-focus", settings.focusMode, false, "Focus mode", "F8");
  setStatusFlag("flag-typewriter", settings.typewriterMode, false, "Typewriter mode", "F9");
  setStatusFlag(
    "flag-sync",
    settings.syncScroll,
    settings.viewMode !== "split",
    "Sync scroll",
    "",
    "Only applies in Split view.",
  );
  setStatusFlag(
    "flag-auto-save",
    settings.autoSave,
    false,
    "Auto Save",
    "",
    "Saves to disk every 20 seconds while there are unsaved changes.",
  );
}

/**
 * Show the zoom level only while it differs from the default.
 *
 * The menu calls this "Zoom", but what it changes is the editor font size; a
 * percentage is the unit the menu and the shortcut imply, and the title gives
 * the pixel value. It is clickable, like every other status-bar indicator.
 */
function updateZoomIndicator(): void {
  const percent = Math.round((settings.editorFontSize / DEFAULT_FONT_SIZE) * 100);
  const zoomed = settings.editorFontSize !== DEFAULT_FONT_SIZE;
  statusZoom.hidden = !zoomed;
  statusZoom.textContent = `${percent}%`;
  statusZoom.title = `Font size ${settings.editorFontSize}px — click to reset to ${DEFAULT_FONT_SIZE}px`;
  statusZoom.setAttribute(
    "aria-label",
    `Editor font size ${settings.editorFontSize} pixels, ${percent} percent. Click to reset.`,
  );
}

/**
 * Mirror the interface's state onto the native menu's check marks.
 *
 * The menu is a native control: it cannot read the DOM, and Rust cannot see
 * whether the window is fullscreen without asking it. Sending one struct avoids
 * deriving the same booleans in two places and keeps the menu right after every
 * change, including the ones made in Preferences. A failure here is cosmetic —
 * the settings remain the source of truth.
 */
function syncMenuState(): void {
  void (async () => {
    try {
      isFullscreen = await getCurrentWindow().isFullscreen();
    } catch {
      /* the window may be closing; keep the last known value */
    }
    try {
      await api.setMenuState({
        viewMode: settings.viewMode,
        sidebarVisible: settings.sidebarVisible,
        sidebarTab: settings.sidebarTab,
        showStatusBar: settings.showStatusBar,
        focusMode: settings.focusMode,
        typewriterMode: settings.typewriterMode,
        syncScroll: settings.syncScroll,
        theme: settings.theme,
        autoSave: settings.autoSave,
        fullscreen: isFullscreen,
      });
    } catch {
      /* cosmetic: the menu is not the source of truth */
    }
  })();
}

function rememberSpelling(word: string): void {
  const folded = word.replace(/[\u2019\u2018\u02BC]/g, "'").trim();
  if (!folded) return;
  if (settings.spellcheckWords.some((entry) => entry.toLowerCase() === folded.toLowerCase())) return;
  // The list is the reader's, and it is stored in settings.json. Cap it so a
  // long session of "add" cannot grow the file without bound.
  const words = [...settings.spellcheckWords, folded].slice(-500);
  applySettingsPatch({ spellcheckWords: words });
}

function applySpellcheck(): void {
  editor?.setSpellcheck({
    // HTML source is markup; the dictionary's node names are Markdown-shaped and
    // would underline tags and attribute names.
    enabled: settings.spellcheck !== false && currentLanguage !== "html",
    language: settings.spellcheckLanguage || "auto",
    words: settings.spellcheckWords ?? [],
  });
}

function applyLayout(): void {
  app.classList.toggle("sidebar-hidden", !settings.sidebarVisible);
  app.classList.toggle("statusbar-hidden", !settings.showStatusBar);
  app.classList.remove("mode-source", "mode-split", "mode-preview");
  app.classList.add(`mode-${settings.viewMode}`);
  app.classList.toggle("focus-mode", settings.focusMode);
  // The HTML guest is a sibling of `#preview`; the class makes the pane
  // full-bleed and hides the Markdown article without touching its rules.
  app.classList.toggle("document-html", currentLanguage === "html");

  // 0 means "full width" in the settings model.
  const width = settings.editorMaxWidth;
  document.documentElement.style.setProperty(
    "--editor-max-width",
    width > 0 ? `${width}px` : "none",
  );

  editor?.setFontSize(settings.editorFontSize);
  editor?.setFocusMode(settings.focusMode);
  editor?.setTypewriter(settings.typewriterMode);
  applySpellcheck();
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

  // The button does not get the `.active` surface: an open sidebar is already
  // visible, and a permanently lit button would read as a mode. The attribute
  // is for assistive technology and for the smoke test.
  el<HTMLButtonElement>("btn-sidebar").setAttribute(
    "aria-pressed",
    String(settings.sidebarVisible),
  );

  updateStatusFlags();
  updateZoomIndicator();
  syncMenuState();
}

/**
 * Publish the typography settings as CSS variables.
 *
 * Everything — the two panes and the exported documents — reads the same
 * variables, which is why there is one place that writes them. An empty font
 * string means "the built-in default for that role", so the fallback lives in
 * `src/fonts.ts` beside the reasoning for it rather than being copied into every
 * settings file on disk.
 */
function applyTypography(): void {
  const root = document.documentElement.style;
  for (const role of TYPOGRAPHY_ROLES) {
    root.setProperty(role.variable, settings[role.id] || role.fallback);
  }
  root.setProperty("--body-size", `${settings.bodyFontSize}px`);
  // KaTeX itself draws at 1.21em; this multiplies that ratio. A percentage is
  // what the reader thinks in, a unitless multiplier is what calc() wants.
  root.setProperty("--math-scale", String(settings.mathFontScale / 100));

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
  syncMenuState();
  persist();
  scheduleRender(true);
}

/** Apply a patch from the Preferences panel and refresh anything it affects. */
function applySettingsPatch(patch: Partial<api.Settings>): void {
  const affectsRendering =
    patch.enableMath !== undefined ||
    patch.enableMermaid !== undefined ||
    patch.htmlPreviewScripts !== undefined ||
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

/**
 * One formatter for the counts in the status bar.
 *
 * Digit grouping follows the webview's locale; this WebView2 reports en-US, so
 * the numbers read `148,540`. Built once because `refreshStatus` runs on every
 * caret move.
 */
const countFormat = new Intl.NumberFormat();

function formatCount(value: number): string {
  return countFormat.format(value);
}

function showTokenCount(tokens: number): void {
  statusTokens.textContent = `${formatCount(tokens)} ${tokens === 1 ? "token" : "tokens"}`;
  statusTokens.title =
    `Estimated ${formatCount(tokens)} tokens — within about 10% of cl100k and o200k. ` +
    "No model vocabulary is loaded.";
  statusTokens.hidden = false;
}

function clearTokenCount(): void {
  statusTokens.hidden = true;
  statusTokens.textContent = "";
  statusTokens.title = "";
}

/** Drop a count that belongs to the previous document before loading a new one. */
function resetTokenCount(): void {
  window.clearTimeout(tokenCountTimer);
  tokenCountRequest++;
  clearTokenCount();
}

/** Drop headings that belong to the previous document before loading a new one. */
function resetOutline(): void {
  window.clearTimeout(outlineTimer);
  outlineHeadings = [];
  outlineLanguage = null;
  outlineReady = false;
}

/** Install the count that arrived with the document, cancelling a pending scan. */
function setTokenCount(tokens: number): void {
  window.clearTimeout(tokenCountTimer);
  tokenCountRequest++;
  showTokenCount(tokens);
}

/**
 * Ask Rust for an approximate token count, on a debounce.
 *
 * A whole-document count is cheap enough to run in the background (4.6 ms per
 * megabyte), but not free enough to run per keystroke — and sending the buffer
 * across the IPC boundary has its own cost. Typing a paragraph therefore
 * produces one scan when the typing pauses, not one per character. The request
 * counter makes an answer that arrives after a newer edit irrelevant.
 */
function scheduleTokenCount(text: string, immediate = false): void {
  window.clearTimeout(tokenCountTimer);
  const request = ++tokenCountRequest;

  if (text.length === 0) {
    showTokenCount(0);
    return;
  }

  const run = () => {
    void api
      .countTokens(text)
      .then((tokens) => {
        if (request === tokenCountRequest) showTokenCount(tokens);
      })
      .catch((error) => {
        if (request !== tokenCountRequest) return;
        clearTokenCount();
        console.warn(`[tokens] estimate failed: ${error}`);
      });
  };

  tokenCountTimer = window.setTimeout(run, immediate ? 0 : TOKEN_COUNT_DELAY_MS);
}

function refreshStatus(): void {
  const cursor = editor.cursorInfo();
  const { words, lines, chars } = editor.metrics();

  const wordsText = formatCount(words);
  statusFile.textContent = `${dirty ? "• " : ""}${currentDoc?.name ?? "Untitled"}`;
  statusWords.textContent = `${wordsText} ${words === 1 ? "word" : "words"}`;
  statusWords.title = `${wordsText} words · ${formatCount(chars)} characters · ${formatCount(lines)} lines`;
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
/** Source line the guest should restore after the next re-render. */
let htmlRestoreLine: number | null = null;

function scheduleRender(immediate = false): void {
  window.clearTimeout(renderTimer);
  const delay = currentLanguage === "html" ? 300 : 200;
  renderTimer = window.setTimeout(() => void doRender(), immediate ? 0 : delay);
}

// Object URLs handed to the preview, kept so they can be revoked. A long session
// that edits a Typst document hundreds of times would otherwise hold every page
// it ever drew in memory.
let typstObjectUrls: string[] = [];

/**
 * Draw a Typst document by compiling it and showing the pages.
 *
 * The pages are the compiler's own output rather than an interpretation of it, so
 * what is on screen is what the PDF will contain. `currentPath` is passed only as
 * the project root, so `#image("img/plot.png")` resolves as it will on export; the
 * text itself is sent, so unsaved edits appear.
 */
/**
 * The preview of a Typst document.
 *
 * Two views, and the reason there are two is worth stating plainly. Typst's HTML
 * export yields plain semantic HTML — the same `h2`, `p`, `code`, `ol`, `table`
 * and MathML that the Markdown preview already renders — so the pane's type,
 * colours and width apply to it and the text flows and can be selected. What it
 * cannot do is layout: page size, `#align`, boxes and page breaks are dropped.
 * The page view is the compiler's real output and always faithful, but its text is
 * drawn as outlines, so it neither reflows nor can be read as text.
 *
 * The default is the document view: a preview is for reading. The page view is one
 * click away, and the pane says so when the document view had to drop something.
 */
async function renderTypstPreview(source: string, token: number): Promise<void> {
  const wanted = settings.typstView === "pages" ? "pages" : "document";

  let rendered: api.RenderedTypst;
  try {
    rendered = await api.renderTypst(currentPath, source, wanted);
  } catch (error) {
    if (token !== renderToken) return;
    // Shown in place of the preview, not as a toast: a Typst error is about a
    // line of this document, and the pane is where the document is looked at.
    for (const url of typstObjectUrls) URL.revokeObjectURL(url);
    typstObjectUrls = [];
    preview.innerHTML = "";
    preview.appendChild(typstViewBar(wanted));
    const box = document.createElement("pre");
    box.className = "typst-error";
    box.textContent = String(error);
    preview.appendChild(box);
    previewLinesMapped = false;
    return;
  }
  if (token !== renderToken) return;

  for (const url of typstObjectUrls) URL.revokeObjectURL(url);
  typstObjectUrls = [];
  preview.innerHTML = "";
  preview.appendChild(typstViewBar(rendered.kind));

  if (rendered.kind === "document") {
    const host = document.createElement("div");
    // The same class the Markdown preview uses, so every rule that shapes prose,
    // headings, code, tables and quotes applies to this document too.
    host.className = "markdown-body typst-document";
    host.innerHTML = rendered.html ?? "";
    preview.appendChild(host);

    if (rendered.css) {
      // The export's stylesheet is mostly MathML alignment inside tables, which
      // no browser resolves unaided. Kept in one element so it is replaced rather
      // than accumulated across renders.
      let style = document.getElementById("typst-export-css") as HTMLStyleElement | null;
      if (!style) {
        style = document.createElement("style");
        style.id = "typst-export-css";
        document.head.appendChild(style);
      }
      style.textContent = rendered.css;
    }
    // Typst's HTML export carries no source positions, so the blocks are matched
    // back to the source by their text — see typst-map.ts. Two anchors are enough
    // to scroll against, and requiring all of them would disable sync for any
    // document holding a figure.
    const mapped = annotateTypstLines(host, source);
    previewLinesMapped = mapped.mapped >= 2;
    rebuildAnchors();
    revealCursorInPreview();
    updateActiveOutline();
    return;
  }

  const host = document.createElement("div");
  host.className = "typst-preview";
  rendered.pages.forEach((svg, index) => {
    const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    typstObjectUrls.push(url);
    const page = document.createElement("img");
    page.className = "typst-page";
    page.alt = `Page ${index + 1}`;
    page.src = url;
    host.appendChild(page);
  });
  preview.appendChild(host);
  // Pages are pictures of pages: there is nothing to map a line onto.
  previewLinesMapped = false;
}

/** The Document / Pages switch shown above a Typst preview. */
function typstViewBar(active: string): HTMLElement {
  const bar = document.createElement("div");
  bar.className = "typst-viewbar";
  const choices: Array<[string, string, string]> = [
    ["document", "Document", "Flowing text, styled like the Markdown preview"],
    ["pages", "Pages", "The pages as they will print"],
  ];
  for (const [id, label, title] of choices) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "typst-viewbutton" + (id === active ? " active" : "");
    button.textContent = label;
    button.title = title;
    button.addEventListener("click", () => {
      if (settings.typstView === id) return;
      settings.typstView = id as api.TypstView;
      persist();
      scheduleRender(true);
    });
    bar.appendChild(button);
  }
  return bar;
}

/** Delegate an HTML document to the sandboxed guest. */
async function renderHtmlPreview(source: string, token: number): Promise<void> {
  if (!htmlPreview) return;
  // In Source-only mode there is nothing to draw, and rebuilding the guest
  // would only restart its scripts.
  if (settings.viewMode === "source") return;
  htmlRestoreLine = htmlPreview.layout()?.line ?? editor.topVisibleLine();
  await htmlPreview.render(
    source,
    currentDoc?.directory ?? null,
    currentDoc?.name ?? "index.html",
    settings.htmlPreviewScripts !== false,
  );
  if (token !== renderToken) return;
}

async function doRender(): Promise<void> {
  const token = ++renderToken;
  const source = editor.getDoc();

  if (currentLanguage === "html") {
    await renderHtmlPreview(source, token);
    return;
  }

  if (currentLanguage === "typst") {
    await renderTypstPreview(source, token);
    return;
  }

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
    refreshOutline();
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

/** Rebuild the outline list from the current buffer. */
function refreshOutline(text = editor.getDoc()): void {
  if (settings.sidebarTab !== "outline" || !settings.sidebarVisible) return;
  // A document load schedules a refresh and then calls renderSidebar(); this
  // cancels the duplicate that would otherwise rescan 250 ms later.
  window.clearTimeout(outlineTimer);

  const language = languageFor(currentPath);
  outlineHeadings =
    language === "typst"
      ? sidebarPanel.extractTypstHeadings(text)
      : language === "html"
        ? sidebarPanel.extractHtmlHeadings(text)
        : sidebarPanel.extractHeadings(text);
  outlineLanguage = language;
  outlineReady = true;

  sidebarPanel.renderOutline(
    sidebarBody,
    outlineHeadings,
    editor.cursorInfo().line,
    (line) => {
      editor.scrollToLine(line);
    },
    language,
  );
}

/** Headings change with the document, not with every keystroke. */
function scheduleOutlineRefresh(text: string): void {
  window.clearTimeout(outlineTimer);
  outlineTimer = window.setTimeout(() => {
    if (settings.sidebarTab !== "outline" || !settings.sidebarVisible) {
      // The cache is for another document state; rebuild when the tab returns.
      outlineReady = false;
      return;
    }
    refreshOutline(text);
  }, OUTLINE_REFRESH_DELAY_MS);
}

function updateActiveOutline(): void {
  if (settings.sidebarTab !== "outline" || !settings.sidebarVisible) return;
  if (!outlineReady || outlineLanguage !== languageFor(currentPath)) {
    refreshOutline();
    return;
  }
  sidebarPanel.highlightOutline(sidebarBody, outlineHeadings, editor.cursorInfo().line);
}

// ---------------------------------------------------------------------------
// Document lifecycle
// ---------------------------------------------------------------------------

/**
 * Which markup a path holds.
 *
 * By extension, because that is the only signal there is: a Typst document and a
 * Markdown document are both text, and guessing from the contents would flip the
 * parser under a user who had just typed the first `=`.
 */
function languageFor(path: string | null): api.DocumentLanguage {
  if (path === null) return "markdown";
  if (/\.typ$/i.test(path)) return "typst";
  if (/\.html?$/i.test(path)) return "html";
  return "markdown";
}

/**
 * The markup a new document starts in.
 *
 * The default extension is what Save As will suggest, and opening a `.typ` file
 * switches the parser to Typst. Starting the document the other way would make
 * the first save change how the text that was already typed is read.
 */
function defaultDocumentLanguage(): api.DocumentLanguage {
  if (settings.defaultExtension === "typ") return "typst";
  if (settings.defaultExtension === "html" || settings.defaultExtension === "htm") return "html";
  return "markdown";
}

/**
 * The file dialog filters, with the default markup's filter first.
 *
 * The native dialog selects the first entry, so a reader who chose Typst as the
 * default should not have to switch away from "Markdown" every time.
 */
function documentFilters(): { name: string; extensions: string[] }[] {
  const markdown = {
    name: "Markdown",
    extensions: ["md", "markdown", "mdown", "mkd", "txt"],
  };
  const typst = { name: "Typst", extensions: ["typ"] };
  const html = { name: "HTML", extensions: ["html", "htm"] };
  const all = { name: "All files", extensions: ["*"] };
  switch (defaultDocumentLanguage()) {
    case "typst":
      return [typst, markdown, html, all];
    case "html":
      return [html, markdown, typst, all];
    default:
      return [markdown, typst, html, all];
  }
}

/** The markup of the document currently in the editor. */
let currentLanguage: api.DocumentLanguage = "markdown";

/** Drop the guest when the editor leaves HTML; start a fresh nonce when it enters. */
function prepareHtmlPreview(next: api.DocumentLanguage): void {
  if (!htmlPreview) return;
  if (next === "html") htmlPreview.reset();
  else htmlPreview.dispose();
}

async function adoptDocument(payload: api.DocumentPayload, resetHistory: boolean): Promise<void> {
  currentDoc = payload;
  currentPath = payload.path;
  savedContent = payload.content;
  diskModifiedMs = payload.modifiedMs;
  dirty = false;

  resetTokenCount();
  resetOutline();
  editor.setDoc(payload.content, resetHistory);
  const nextLanguage = languageFor(payload.path);
  prepareHtmlPreview(nextLanguage);
  currentLanguage = nextLanguage;
  editor.setLanguage(currentLanguage);
  sidebarPanel.resetDirectory(payload.directory || null);
  // The backend counted while reading the file, so opening does not send the
  // document back over IPC. This also cancels the debounced scan that the
  // `setDoc` update just scheduled.
  setTokenCount(payload.tokens);

  applyLayout();
  await refreshTitle();
  refreshStatus();
  renderSidebar();
  scheduleRender(true);
}

async function loadUntitled(
  content: string,
  language: api.DocumentLanguage = "markdown",
): Promise<void> {
  currentDoc = null;
  currentPath = null;
  savedContent = content;
  diskModifiedMs = 0;
  dirty = false;

  resetTokenCount();
  resetOutline();
  editor.setDoc(content, true);
  // The caller decides: a built-in document is Markdown, a new document follows
  // the default extension so its first Save As does not change its meaning.
  prepareHtmlPreview(language);
  currentLanguage = language;
  editor.setLanguage(language);
  sidebarPanel.resetDirectory(null);

  applyLayout();
  await refreshTitle();
  refreshStatus();
  scheduleTokenCount(content, true);
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
    filters: documentFilters(),
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
  declarations.push(`--math-scale:${settings.mathFontScale / 100}`);
  declarations.push(
    `--prose-figures:${settings.oldstyleFigures ? "oldstyle-nums" : "normal"}`,
    `--table-figures:${settings.tabularFigures ? "tabular-nums" : "normal"}`,
    `--code-figures:${settings.slashedZero ? "slashed-zero tabular-nums" : "normal"}`,
    `--code-ligatures:${settings.ligaturesInCode ? "contextual common-ligatures" : "none"}`,
    // The export is a separate document and never loads styles.css, so the
    // Semibold rule has to travel with the settings it belongs to.
    "--weight-strong:600",
  );
  const emphasis =
    ".markdown-body h1,.markdown-body h2,.markdown-body h3,.markdown-body h4," +
    ".markdown-body h5,.markdown-body h6,.markdown-body th," +
    ".markdown-body strong,.markdown-body b{font-weight:var(--weight-strong)}";
  // The same scaling rule styles.css carries. An exported document has no
  // stylesheet of its own, and without this the formula in a printed PDF would
  // stay at KaTeX's 1.21em while the preview showed the reader's scale.
  const mathScale =
    ".math-inline,.math-display{font-size:calc(1em * var(--math-scale))}";
  return `:root{${declarations.join(";")}}\n${emphasis}\n${mathScale}`;
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
    if (currentLanguage === "html") {
      // An HTML document is already HTML. Exporting a copy is useful; passing
      // it through the Markdown renderer would produce a different document.
      await api.writeDocument(
        target,
        editor.getDoc(),
        currentDoc?.lineEnding ?? "\n",
        currentDoc?.hadBom ?? false,
      );
      toast("Exported HTML");
      const after = await api.runAfterExport(target);
      if (after.afterErrors.length > 0) {
        await message(after.afterErrors.join("\n\n"), {
          title: "Exported, with a problem",
          kind: "warning",
        });
      }
      return;
    }

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

    // HTML never passes through `run_export`, so it asks for the global
    // after-export options itself. Without this the boxes did nothing for the
    // one native format that writes a real file.
    const after = await api.runAfterExport(target);
    if (after.afterErrors.length > 0) {
      await message(after.afterErrors.join("\n\n"), {
        title: "Exported, with a problem",
        kind: "warning",
      });
    }
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
    if (currentLanguage === "html") {
      // The system browser cannot reach the preview scheme, but it can read a
      // local file base. The document's own CSS and scripts stay in charge.
      const html = await buildHtmlPrintDocument(
        editor.getDoc(),
        currentDoc?.directory ?? null,
      );
      const written = await api.printDocument(html, documentStem());
      notice.dismiss();
      toast("Choose “Save as PDF” in the print dialog");
      console.info(`[export] print document written to ${written}`);
      return;
    }
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

/** Typst is needed by the PDF target and by `.typ` previews; PDF is the only export. */
let typstCache: api.TypstStatus | null = null;

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

async function refreshTypstStatus(): Promise<void> {
  try {
    typstCache = await api.typstStatus();
  } catch {
    return;
  }
  preferences?.refresh();
}

/**
 * Tell the native Export menu which external tools are present.
 *
 * A disabled item cannot explain itself after a click, so the Rust side also
 * annotates its label ("— needs Pandoc"). The answer is stored there too: a
 * menu rebuild after editing the export formats must not lose it.
 */
async function syncExportAvailability(): Promise<void> {
  if (!pandocCache || !typstCache) return;
  try {
    await api.setExportAvailability(pandocCache.found, typstCache.found);
  } catch {
    /* cosmetic: the guard before the save dialog still checks the caches */
  }
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
  // The menu disables formats whose tool is missing, but a stale menu, a
  // keyboard route or a settings file edited elsewhere must not open a save
  // dialog for an export that cannot run. Ask before choosing a path.
  if (!pandocCache) await refreshPandocStatus();
  if (pandocCache && !pandocCache.found) {
    toast("Pandoc is not installed — install it before exporting.");
    await pandocSetup();
    return;
  }
  if (format.id === "pdf") {
    if (!typstCache) await refreshTypstStatus();
    if (typstCache && !typstCache.found) {
      toast("PDF export needs Typst — install it first.");
      await typstSetup();
      return;
    }
  }

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
      // Tells the backend which reader to use, and that a Typst document exported
      // to PDF is rendered by Typst itself rather than translated through pandoc.
      language: currentLanguage,
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
    : "\nPDF engine: none — Typst is not installed, so PDF export is unavailable. Use Help › Install Typst. Every other format works without it.";

  pandocCache = status;
  preferences?.refresh();

  if (status.found) {
    await refreshTypstStatus();
    await syncExportAvailability();
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
    pandocCache = installed;
    await refreshTypstStatus();
    await syncExportAvailability();
    await message(
      `Pandoc ${installed.version ?? ""} is ready.\n\n${installed.path ?? ""}\n\n` +
        (installed.pdfEngine
          ? `PDF export will use ${basename(installed.pdfEngine)}.`
          : "PDF export still needs Typst — use Help › Install Typst. Every other format works now."),
      { title: "Pandoc installed", kind: "info" },
    );
  } catch (error) {
    notice.dismiss();
    await message(String(error), { title: "Could not install pandoc", kind: "error" });
  }
}

/**
 * Look for Typst, and offer to fetch it when it is missing.
 *
 * Typst is what turns Markdown into PDF, so this is the one extra program the
 * application really wants. It is a single executable — no TeX distribution, no
 * package manager, no administrator rights — which is why downloading it is a
 * reasonable offer rather than an imposition.
 */
async function typstSetup(): Promise<void> {
  let status: api.TypstStatus;
  try {
    status = await api.typstStatus();
  } catch (error) {
    await message(String(error), { title: "Could not look for Typst", kind: "error" });
    return;
  }

  if (status.found) {
    typstCache = status;
    preferences?.refresh();
    await refreshPandocStatus();
    await syncExportAvailability();
    await message(
      `Typst ${status.version ?? "(unknown version)"} is ready.\n\n` +
        `Location: ${status.path}\n` +
        `Installed by: ${status.source === "managed" ? "MDraft" : "you (found on PATH)"}\n\n` +
        "PDF export uses it, and .typ documents are previewed with it.",
      { title: "Typst", kind: "info" },
    );
    return;
  }

  if (!status.canInstall) {
    const open = await ask(
      `Typst was not found.\n\n${status.hint}\n\n` +
        "Open the official download page?",
      { title: "Install Typst", kind: "info", okLabel: "Open page", cancelLabel: "Cancel" },
    );
    if (open) {
      try {
        await api.openTypstDownloadPage();
      } catch (error) {
        await message(String(error), { title: "Could not open the browser", kind: "error" });
      }
    }
    return;
  }

  const agreed = await ask(
    "Typst was not found, so PDF export is unavailable.\n\n" +
      "MDraft can download the official Typst build and put it in its own data folder. " +
      "Nothing is installed system-wide, no administrator rights are needed, and removing the " +
      "folder undoes it.\n\n" +
      "The download is about 21 MB and unpacks to a single executable.",
    { title: "Install Typst", kind: "info", okLabel: "Download", cancelLabel: "Cancel" },
  );
  if (!agreed) return;

  const notice = toast("Downloading Typst…", 0);
  try {
    const installed = await api.installTypst();
    notice.dismiss();
    typstCache = installed;
    await refreshPandocStatus();
    await syncExportAvailability();
    await message(
      `Typst ${installed.version ?? ""} is ready.\n\n${installed.path ?? ""}\n\n` +
        "PDF export will use it, and .typ documents can now be previewed.",
      { title: "Typst installed", kind: "info" },
    );
  } catch (error) {
    notice.dismiss();
    await message(String(error), { title: "Could not install Typst", kind: "error" });
  }
}

// ---------------------------------------------------------------------------
// Menu
// ---------------------------------------------------------------------------

/** One explanation for the commands that only make sense in Markdown/Typst. */
function htmlCommandNote(): void {
  toast("That command is Markdown-only. In HTML, type the tag in the source.", 4200);
}

const handlers: Record<string, () => void | Promise<void>> = {
  "file.new": async () => {
    if (!(await confirmDiscard())) return;
    await loadUntitled("", defaultDocumentLanguage());
  },
  "file.open": async () => {
    if (!(await confirmDiscard())) return;
    const chosen = await openDialog({
      title: "Open Document",
      multiple: false,
      directory: false,
      defaultPath: settings.lastDirectory ?? undefined,
      filters: documentFilters(),
    });
    if (!chosen) return;
    const path = Array.isArray(chosen) ? chosen[0] : chosen;
    await openPath(path, { confirm: false });
  },
  "file.save": () => void save(),
  "file.saveAs": () => void saveAs(),
  "file.autoSave": () => {
    settings.autoSave = !settings.autoSave;
    applyLayout();
    persist();
    announceIfBarHidden("Auto save", settings.autoSave);
  },
  "file.reload": () => void reloadFromDisk(),
  "export.html": () => void exportHtml(),
  "export.pdf": () => void exportPdf(),
  "export.installPandoc": () => void pandocSetup(),
  "export.installTypst": () => void typstSetup(),
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

  "para.h1": () =>
    currentLanguage === "html"
      ? editor.wrapSelection("<h1>", "</h1>", "Heading")
      : editor.setHeading(1),
  "para.h2": () =>
    currentLanguage === "html"
      ? editor.wrapSelection("<h2>", "</h2>", "Heading")
      : editor.setHeading(2),
  "para.h3": () =>
    currentLanguage === "html"
      ? editor.wrapSelection("<h3>", "</h3>", "Heading")
      : editor.setHeading(3),
  "para.h4": () =>
    currentLanguage === "html"
      ? editor.wrapSelection("<h4>", "</h4>", "Heading")
      : editor.setHeading(4),
  "para.h5": () =>
    currentLanguage === "html"
      ? editor.wrapSelection("<h5>", "</h5>", "Heading")
      : editor.setHeading(5),
  "para.h6": () =>
    currentLanguage === "html"
      ? editor.wrapSelection("<h6>", "</h6>", "Heading")
      : editor.setHeading(6),
  "para.paragraph": () =>
    currentLanguage === "html"
      ? editor.wrapSelection("<p>", "</p>", "Paragraph")
      : editor.setHeading(0),
  "para.increaseHeading": () =>
    currentLanguage === "html" ? htmlCommandNote() : editor.shiftHeading(-1),
  "para.decreaseHeading": () =>
    currentLanguage === "html" ? htmlCommandNote() : editor.shiftHeading(1),
  "para.quote": () =>
    currentLanguage === "html"
      ? editor.insertBlock("<blockquote>\n\n</blockquote>")
      : editor.toggleLinePrefix("> "),
  "para.codeBlock": () =>
    currentLanguage === "html"
      ? editor.insertBlockWithCaret("<pre><code></code></pre>", 11)
      : editor.insertBlockWithCaret("```\n\n```", 4),
  "para.mathBlock": () =>
    currentLanguage === "html" ? htmlCommandNote() : editor.insertBlockWithCaret("$$\n\n$$\n", 3),
  "para.ul": () =>
    currentLanguage === "html"
      ? editor.insertBlock("<ul>\n  <li></li>\n</ul>")
      : editor.toggleLinePrefix("- "),
  "para.ol": () =>
    currentLanguage === "html"
      ? editor.insertBlock("<ol>\n  <li></li>\n</ol>")
      : editor.toggleLinePrefix("1. "),
  "para.task": () =>
    currentLanguage === "html" ? htmlCommandNote() : editor.toggleLinePrefix("- [ ] "),
  "para.taskDone": () =>
    currentLanguage === "html" ? htmlCommandNote() : editor.setTaskState("done"),
  "para.taskTodo": () =>
    currentLanguage === "html" ? htmlCommandNote() : editor.setTaskState("todo"),
  "para.taskPlain": () =>
    currentLanguage === "html" ? htmlCommandNote() : editor.setTaskState("plain"),
  "para.indent": () => editor.indentLines(1),
  "para.outdent": () => editor.indentLines(-1),
  "para.insertBefore": () => editor.insertParagraphBefore(),
  "para.insertAfter": () => editor.insertParagraphAfter(),
  "para.table": () =>
    currentLanguage === "html"
      ? editor.insertBlock(
          "<table>\n  <thead>\n    <tr><th>Column</th><th>Column</th></tr>\n  </thead>\n  <tbody>\n    <tr><td>Cell</td><td>Cell</td></tr>\n  </tbody>\n</table>",
        )
      : editor.insertBlock("| Column | Column |\n| --- | --- |\n| Cell | Cell |"),
  "para.hr": () => (currentLanguage === "html" ? editor.insertBlock("<hr>") : editor.insertBlock("---")),
  "para.toc": () => (currentLanguage === "html" ? htmlCommandNote() : editor.insertToc()),
  "para.yaml": () => (currentLanguage === "html" ? htmlCommandNote() : editor.insertYamlFrontMatter()),
  "para.alertNote": () =>
    currentLanguage === "html" ? htmlCommandNote() : editor.insertBlock("> [!NOTE]\n> "),
  "para.alertTip": () =>
    currentLanguage === "html" ? htmlCommandNote() : editor.insertBlock("> [!TIP]\n> "),
  "para.alertImportant": () =>
    currentLanguage === "html" ? htmlCommandNote() : editor.insertBlock("> [!IMPORTANT]\n> "),
  "para.alertWarning": () =>
    currentLanguage === "html" ? htmlCommandNote() : editor.insertBlock("> [!WARNING]\n> "),
  "para.alertCaution": () =>
    currentLanguage === "html" ? htmlCommandNote() : editor.insertBlock("> [!CAUTION]\n> "),

  "format.bold": () =>
    currentLanguage === "html"
      ? editor.wrapSelection("<strong>", "</strong>", "strong text")
      : editor.wrapSelection("**", "**", "strong text"),
  "format.italic": () =>
    currentLanguage === "html"
      ? editor.wrapSelection("<em>", "</em>", "emphasis")
      : editor.wrapSelection("*", "*", "emphasis"),
  "format.strike": () =>
    currentLanguage === "html"
      ? editor.wrapSelection("<s>", "</s>", "strikethrough")
      : editor.wrapSelection("~~", "~~", "strikethrough"),
  "format.code": () =>
    currentLanguage === "html"
      ? editor.wrapSelection("<code>", "</code>", "code")
      : editor.wrapSelection("`", "`", "code"),
  "format.link": () =>
    currentLanguage === "html"
      ? editor.wrapSelection('<a href="https://">', "</a>", "link text")
      : editor.wrapSelection("[", "](https://)", "link text"),
  "format.image": () =>
    currentLanguage === "html"
      ? editor.insertBlock('<img src="./image.png" alt="alt text">')
      : editor.wrapSelection("![", "](./image.png)", "alt text"),
  "format.math": () =>
    currentLanguage === "html"
      ? htmlCommandNote()
      : editor.wrapSelection("$", "$", "e^{i\\pi}+1=0"),
  "format.displayMath": () => {
    if (currentLanguage === "html") {
      htmlCommandNote();
      return;
    }
    // A selected expression becomes a display equation in place. With nothing
    // selected, insert the block a bare caret is asking for; `wrapSelection`
    // would otherwise put the placeholder in a display box mid-sentence.
    if (editor.cursorInfo().selectionLength > 0) {
      editor.wrapSelection("$$", "$$", "");
    } else {
      editor.insertBlockWithCaret("$$\n\n$$\n", 3);
    }
  },

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
    announceIfBarHidden("Focus mode", settings.focusMode);
  },
  "view.typewriter": () => {
    settings.typewriterMode = !settings.typewriterMode;
    applyLayout();
    persist();
    announceIfBarHidden("Typewriter mode", settings.typewriterMode);
  },
  "view.syncScroll": () => {
    settings.syncScroll = !settings.syncScroll;
    applyLayout();
    persist();
    announceIfBarHidden("Sync scroll", settings.syncScroll);
  },
  "view.fullscreen": async () => {
    const window = getCurrentWindow();
    const next = !(await window.isFullscreen());
    await window.setFullscreen(next);
    isFullscreen = next;
    syncMenuState();
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
  "help.licences": () => void showBuiltin(FONT_LICENCES),
  "help.installTypst": () => void typstSetup(),
  "help.pandoc": () => void pandocSetup(),
  "help.about": async () => {
    await message(
      [
        "MDraft",
        `Version ${APP_VERSION}`,
        "",
        "A Markdown, Typst and HTML editor in the spirit of Typora.",
        "",
        "Conceived by Bernhard Enders.",
        "Coded by DeepSeek",
        "https://github.com/bgeneto/MDraft",
        "",
        "Editor: CodeMirror 6",
        "Markdown: marked + DOMPurify",
        "Math: KaTeX",
        "Diagrams: Mermaid",
        "Highlighting: highlight.js",
        "PDF: Typst",
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
  if (settings.focusMode) {
    toast("Focus mode hides the sidebar — press F8 to leave it.");
    return;
  }
  settings.sidebarVisible = visible;
  applyLayout();
  persist();
  if (visible) renderSidebar();
}

function setSidebarTab(tab: api.SidebarTab): void {
  if (settings.focusMode) {
    toast("Focus mode hides the sidebar — press F8 to leave it.");
    return;
  }
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

/** Index of the last block that starts at or before `line`, or -1. */
function anchorIndexForLine(line: number): number {
  let index = -1;
  for (let i = 0; i < previewAnchors.length; i++) {
    if (previewAnchors[i].line <= line) index = i;
    else break;
  }
  return index;
}

/** Last block that starts at or before `line`. */
function anchorForLine(line: number): HTMLElement | null {
  const index = anchorIndexForLine(line);
  return index >= 0 ? previewAnchors[index].el : previewAnchors[0]?.el ?? null;
}

/** Preview block top in scroll-content coordinates, padding included. */
function previewTop(el: HTMLElement): number {
  return (
    previewPane.scrollTop +
    el.getBoundingClientRect().top -
    previewPane.getBoundingClientRect().top
  );
}

/** The preview scroll offset that puts a block on the sync line. */
function previewScrollFor(el: HTMLElement): number {
  return Math.max(0, previewTop(el) - SYNC_MARGIN);
}

/** One pair of corresponding positions: a block top in both panes. */
interface SyncSegment {
  editor0: number;
  preview0: number;
  editor1: number;
  preview1: number;
}

/** Map `value` from one interval to the other, clamped to its ends. */
function interpolate(
  value: number,
  from0: number,
  from1: number,
  to0: number,
  to1: number,
): number {
  if (from1 <= from0) return to0;
  const t = Math.min(1, Math.max(0, (value - from0) / (from1 - from0)));
  return to0 + t * (to1 - to0);
}

/** Where the preview should stop once the last block has been read through. */
function previewEndFor(el: HTMLElement): number {
  const pane = previewPane.getBoundingClientRect();
  const blockBottom =
    previewPane.scrollTop + el.getBoundingClientRect().bottom - pane.top;
  const max = Math.max(0, previewPane.scrollHeight - previewPane.clientHeight);
  // The 45vh bottom padding is for reading the last block at the top, not part
  // of the document. Mapping into it would scroll the text off screen.
  return Math.max(
    previewScrollFor(el),
    Math.min(max, blockBottom - previewPane.clientHeight),
  );
}

/**
 * The two adjacent sync positions around an anchor index.
 *
 * The last anchor uses the editor's scroll end and the bottom of its block as
 * the second position, so a long final block keeps following instead of
 * pinning at its first line.
 */
function syncSegmentFor(index: number): SyncSegment | null {
  if (index < 0 || index >= previewAnchors.length) return null;
  const anchor = previewAnchors[index];
  const editor0 = editor.lineTop(anchor.line);
  const preview0 = previewScrollFor(anchor.el);

  if (index + 1 < previewAnchors.length) {
    const next = previewAnchors[index + 1];
    return {
      editor0,
      preview0,
      editor1: Math.max(editor0, editor.lineTop(next.line)),
      preview1: Math.max(preview0, previewScrollFor(next.el)),
    };
  }

  return {
    editor0,
    preview0,
    editor1: Math.max(editor0, editor.scrollMax()),
    preview1: previewEndFor(anchor.el),
  };
}

/** Source line of the block at the preview's sync line. */
function lineAtPreviewTop(): number | null {
  if (previewAnchors.length === 0) return null;
  const top = previewPane.getBoundingClientRect().top + SYNC_MARGIN;
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
  previewPane.scrollTop += delta - SYNC_MARGIN;
}

/**
 * Follow the source between anchors instead of jumping from block to block.
 *
 * The old mapping pinned the preview inside every block and jumped at each
 * boundary. Those steps are the reason a large preview font feels worse: the
 * step is the whole rendered block. Interpolating between the measured anchor
 * positions makes the motion continuous, and its slope is the local
 * `Δpreview / Δeditor` — which already contains both font sizes, wrapped lines
 * and every image or table between the anchors. No font-size heuristic is
 * involved, so it stays correct at 11px and at 32px alike.
 */
function alignPreviewToScroll(): void {
  const line = editor.topVisibleLine();
  const index = Math.max(0, anchorIndexForLine(line));
  const segment = syncSegmentFor(index);
  if (!segment) return;

  const target = interpolate(
    editor.view.scrollDOM.scrollTop,
    segment.editor0,
    segment.editor1,
    segment.preview0,
    segment.preview1,
  );
  const max = Math.max(0, previewPane.scrollHeight - previewPane.clientHeight);
  suppressPreviewScrollUntil = performance.now() + SYNC_SUPPRESS_MS;
  previewPane.scrollTop = Math.min(max, Math.max(0, target));
}

/**
 * The same map in reverse, for a reader scrolling the preview.
 *
 * It sets only the scroll offset: the caret belongs to the reader, and moving
 * it here would turn a scroll into a selection. Using the same anchors and the
 * same margin as `alignPreviewToScroll` makes the two directions inverses, so
 * a round trip cannot accumulate drift.
 */
function alignEditorToScroll(): void {
  const line = lineAtPreviewTop();
  if (line === null) return;
  const index = Math.max(0, anchorIndexForLine(line));
  const segment = syncSegmentFor(index);
  if (!segment) return;

  const target = interpolate(
    previewPane.scrollTop,
    segment.preview0,
    segment.preview1,
    segment.editor0,
    segment.editor1,
  );
  suppressEditorScrollUntil = performance.now() + SYNC_SUPPRESS_MS;
  editor.scrollToOffset(target);
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

/** The guest's anchors are layout positions, not DOM elements in this frame. */
interface HtmlSyncSegment {
  editor0: number;
  editor1: number;
  preview0: number;
  preview1: number;
}

function htmlIndexForLine(anchors: HtmlLayout["anchors"], line: number): number {
  let index = -1;
  for (let i = 0; i < anchors.length; i += 1) {
    if (anchors[i].line <= line) index = i;
    else break;
  }
  return index;
}

function htmlSegmentFor(layout: HtmlLayout, index: number): HtmlSyncSegment | null {
  if (index < 0 || index >= layout.anchors.length) return null;
  const anchor = layout.anchors[index];
  const editor0 = editor.lineTop(anchor.line);
  const preview0 = Math.max(0, anchor.top - SYNC_MARGIN);

  if (index + 1 < layout.anchors.length) {
    const next = layout.anchors[index + 1];
    return {
      editor0,
      preview0,
      editor1: Math.max(editor0, editor.lineTop(next.line)),
      preview1: Math.max(preview0, next.top - SYNC_MARGIN),
    };
  }
  return {
    editor0,
    preview0,
    editor1: Math.max(editor0, editor.scrollMax()),
    preview1: Math.max(preview0, layout.height - layout.client),
  };
}

function htmlLineAtTop(layout: HtmlLayout): number {
  if (layout.anchors.length === 0) return 1;
  const y = layout.top + SYNC_MARGIN;
  let line = layout.anchors[0].line;
  for (const anchor of layout.anchors) {
    if (anchor.top <= y) line = anchor.line;
    else break;
  }
  return line;
}

function syncEditorToHtml(): void {
  if (!settings.syncScroll || settings.viewMode !== "split") return;
  const layout = htmlPreview.layout();
  if (!layout || layout.anchors.length < 2) return;
  const index = Math.max(0, htmlIndexForLine(layout.anchors, editor.topVisibleLine()));
  const segment = htmlSegmentFor(layout, index);
  if (!segment) return;

  const target = interpolate(
    editor.view.scrollDOM.scrollTop,
    segment.editor0,
    segment.editor1,
    segment.preview0,
    segment.preview1,
  );
  const max = Math.max(0, layout.height - layout.client);
  suppressPreviewScrollUntil = performance.now() + SYNC_SUPPRESS_MS;
  htmlPreview.scrollTo(Math.min(max, Math.max(0, target)));
}

function syncHtmlToEditor(layout: HtmlLayout): void {
  if (!settings.syncScroll || settings.viewMode !== "split") return;
  if (layout.anchors.length < 2) return;
  if (performance.now() < suppressPreviewScrollUntil) return;

  const index = Math.max(0, htmlIndexForLine(layout.anchors, htmlLineAtTop(layout)));
  const segment = htmlSegmentFor(layout, index);
  if (!segment) return;

  const target = interpolate(
    layout.top,
    segment.preview0,
    segment.preview1,
    segment.editor0,
    segment.editor1,
  );
  suppressEditorScrollUntil = performance.now() + SYNC_SUPPRESS_MS;
  editor.scrollToOffset(target);
}

/** Reveal the caret's block only when it is not already in the guest viewport. */
function revealHtmlCursor(line: number): void {
  if (settings.viewMode !== "split" || caretByPointer) return;
  const layout = htmlPreview.layout();
  if (!layout || layout.anchors.length < 2) return;
  const index = htmlIndexForLine(layout.anchors, line);
  if (index < 0) return;
  const top = layout.anchors[index].top;
  const viewTop = layout.top;
  const viewBottom = layout.top + layout.client;
  if (top >= viewTop && top <= viewBottom - 40) return;
  suppressPreviewScrollUntil = performance.now() + SYNC_SUPPRESS_MS;
  htmlPreview.scrollToLine(line);
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
    if (currentLanguage === "html") {
      revealHtmlCursor(info.line);
      return;
    }
    if (settings.viewMode !== "split" || !previewLinesMapped) return;
    if (caretByPointer) return;
    suppressEditorScrollUntil = performance.now() + SYNC_SUPPRESS_MS;
    revealPreviewLine(info.line);
  });

  // A click points at the matching preview block with a blink that fades by
  // itself, and moves nothing. No strobe risk: the caret moves on every
  // keystroke, but a click is one discrete action.
  editorPane.addEventListener("click", () => {
    if (currentLanguage === "html") {
      if (settings.viewMode === "split") htmlPreview.blink(editor.cursorInfo().line);
      return;
    }
    if (settings.viewMode !== "split" || !previewLinesMapped) return;
    blinkAnchor(editor.cursorInfo().line);
  });

  // Scrolling the source -> the preview follows the same fraction of the block
  // under the top of the pane. This one follows unconditionally, because that
  // is what keeps the two panes together while the reader scrolls.
  editor.onScroll(() => {
    if (currentLanguage === "html") {
      if (performance.now() >= suppressEditorScrollUntil) syncEditorToHtml();
      return;
    }
    if (!settings.syncScroll || settings.viewMode !== "split" || !previewLinesMapped) return;
    if (performance.now() < suppressEditorScrollUntil) return;
    alignPreviewToScroll();
  });

  // Click in the preview -> the source reveals that line, and the preview stays
  // exactly where it is so text selection keeps working.
  preview.addEventListener("mousedown", (event) => {
    if (currentLanguage === "html") return;
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

  // Scrolling the preview -> the source follows the same fraction of the block
  // under the sync line. The scrolling element is the pane, not the rendered
  // document inside it. The HTML guest scrolls internally and reports through
  // the bridge instead.
  previewPane.addEventListener("scroll", () => {
    if (currentLanguage === "html") return;
    if (!settings.syncScroll || settings.viewMode !== "split") return;
    if (performance.now() < suppressPreviewScrollUntil) return;
    alignEditorToScroll();
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

/**
 * Run the action for a menu id, whichever route asked for it.
 *
 * Both routes end here on purpose. The native menu fires on platforms whose
 * message loop translates accelerators — GTK does, Windows does not — and the
 * keydown handler fires everywhere. On a platform where both work, the same
 * keystroke would otherwise run the command twice: two tables inserted for one
 * Ctrl+T, two links for one Ctrl+K. Suppressing a repeat *of the same id* within
 * 250 ms is enough, because no one presses the same shortcut twice that fast.
 */
const lastActionAt = new Map<string, number>();

function runMenuAction(id: string): void {
  const now = performance.now();
  const previous = lastActionAt.get(id) ?? 0;
  if (now - previous < 250) return;
  lastActionAt.set(id, now);

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
}

async function installMenuListener(): Promise<void> {
  await listen<string>("menu", (event) => runMenuAction(event.payload));
}

/** `event.code` for the punctuation an accelerator can name. */
const SYMBOL_CODES: Record<string, string> = {
  Equal: "=",
  Minus: "-",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Backslash: "\\",
  BracketLeft: "[",
  BracketRight: "]",
  Backquote: "`",
  Semicolon: ";",
  Quote: "'",
};

/**
 * The names a keystroke can be matched under.
 *
 * Two sources, because one is not enough. `event.key` is what the character is,
 * which changes under Shift: `Shift+=` reports `"+"`, and `Shift+1` reports
 * `"!"`. `event.code` is the physical key, unaffected by Shift, so `Equal`
 * still names the key that was pressed. An accelerator says `CmdOrCtrl+Shift+=`,
 * so the code is the one that matches it.
 */
function keyNames(event: KeyboardEvent): Set<string> {
  const names = new Set<string>();
  if (event.key && event.key !== "Unidentified") names.add(event.key.toUpperCase());
  const code = event.code;
  if (code.startsWith("Key")) names.add(code.slice(3));
  else if (code.startsWith("Digit")) names.add(code.slice(5));
  else if (SYMBOL_CODES[code]) names.add(SYMBOL_CODES[code]);
  return names;
}

interface ParsedAccelerator {
  id: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
  key: string;
}

const IS_MAC = /Mac|iPhone|iPad/.test(navigator.userAgent);

/**
 * Parse an accelerator into what a keystroke has to look like.
 *
 * The strings are muda's, which the menu already accepts — this reads the same
 * syntax rather than introducing a second one.
 */
function parseAccelerator(id: string, accelerator: string): ParsedAccelerator | null {
  const parts = accelerator.split("+");
  const key = parts.pop();
  if (!key) return null;
  const parsed: ParsedAccelerator = {
    id,
    ctrl: false,
    alt: false,
    shift: false,
    meta: false,
    key: key.toUpperCase(),
  };
  for (const part of parts) {
    switch (part.toLowerCase()) {
      case "cmdorctrl":
      case "cmdorcontrol":
      case "commandorctrl":
      case "commandorcontrol":
        if (IS_MAC) parsed.meta = true;
        else parsed.ctrl = true;
        break;
      case "ctrl":
      case "control":
        parsed.ctrl = true;
        break;
      case "shift":
        parsed.shift = true;
        break;
      case "alt":
      case "option":
        parsed.alt = true;
        break;
      case "cmd":
      case "command":
      case "super":
        parsed.meta = true;
        break;
      default:
        // An unknown modifier means the shortcut cannot be reproduced faithfully;
        // better to leave it to the platform than to guess.
        return null;
    }
  }
  return parsed;
}

function matchesAccelerator(parsed: ParsedAccelerator, event: KeyboardEvent): boolean {
  // Exact modifier matching. Without it Ctrl+Shift+S would also satisfy Ctrl+S,
  // and Save As would save the current file instead.
  if (
    event.ctrlKey !== parsed.ctrl ||
    event.altKey !== parsed.alt ||
    event.shiftKey !== parsed.shift ||
    event.metaKey !== parsed.meta
  ) {
    return false;
  }
  return keyNames(event).has(parsed.key);
}

/**
 * Bind the menu accelerators to the keyboard.
 *
 * Tauri 2 never calls `TranslateAcceleratorW` on Windows, so the menu draws
 * "Ctrl+N" next to *New* and pressing it does nothing at all. The handful of
 * shortcuts that seem to work there — Ctrl+Z, Ctrl+X, Ctrl+C, Ctrl+V, Ctrl+A —
 * are Chromium's, handled inside the webview, which is what makes the failure
 * look like a bug in some menu entries rather than in the whole accelerator
 * mechanism.
 *
 * The list comes from the menu that was actually built, so the two cannot drift.
 * Capture phase, so the editor's own keymap does not consume the keystroke first.
 */
function installShortcuts(shortcuts: api.Shortcut[]): void {
  const parsed = shortcuts
    .map((entry) => parseAccelerator(entry.id, entry.accelerator))
    .filter((entry): entry is ParsedAccelerator => entry !== null);

  for (const unparsed of shortcuts.filter(
    (entry) => !parsed.some((candidate) => candidate.id === entry.id),
  )) {
    console.warn(`[shortcuts] could not reproduce ${unparsed.accelerator} for ${unparsed.id}`);
  }

  knownAcceleratorIds = new Set(shortcuts.map((entry) => entry.id));
  const guestTable: HtmlAccelerator[] = parsed.map((entry) => ({
    id: entry.id,
    ctrl: entry.ctrl,
    alt: entry.alt,
    shift: entry.shift,
    meta: entry.meta,
    keys: [entry.key],
  }));
  htmlPreview?.setAccelerators(guestTable);

  window.addEventListener(
    "keydown",
    (event) => {
      // An input method composing text owns the keyboard until it finishes.
      if (event.isComposing || event.keyCode === 229) return;
      const hit = parsed.find((candidate) => matchesAccelerator(candidate, event));
      if (!hit) return;
      event.preventDefault();
      runMenuAction(hit.id);
    },
    true,
  );
}

function handleHtmlLine(line: number): void {
  if (currentLanguage !== "html" || !Number.isFinite(line)) return;
  suppressEditorScrollUntil = performance.now() + SYNC_SUPPRESS_MS;
  caretCameFromPreview = true;
  try {
    editor.revealLine(line, true, false);
  } finally {
    caretCameFromPreview = false;
  }
  htmlPreview.blink(line);
}

/** Map a resolved guest URL back to the document folder, or null. */
function guestLinkToPath(href: string): string | null {
  const base = htmlPreview.baseUrl();
  if (!base || !href.startsWith(base)) return null;
  let path = href.slice(base.length).split("#")[0].split("?")[0];
  try {
    path = decodeURIComponent(path);
  } catch {
    return null;
  }
  path = path.replace(/^\/+/, "");
  if (!path || path.split("/").some((part) => part === ".." || part === ".")) return null;
  const directory = currentDoc?.directory;
  if (!directory) return null;
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  if (!["html", "htm", "md", "markdown", "mkd", "typ"].includes(extension)) return null;
  return joinDir(directory, path);
}

function handleHtmlLink(href: string): void {
  if (/^(https?:|mailto:)/i.test(href)) {
    void openUrl(href).catch((error) => toast(String(error)));
    return;
  }
  if (/^file:\/\//i.test(href)) {
    try {
      const url = new URL(href);
      let path = decodeURIComponent(url.pathname);
      if (/^\/[A-Za-z]:/.test(path)) path = path.slice(1);
      if (path.startsWith("//")) path = path.slice(2);
      void openPath(path);
    } catch {
      toast("That local link could not be opened.");
    }
    return;
  }
  if (/^(javascript|data|blob):/i.test(href)) return;

  const path = guestLinkToPath(href);
  if (path) {
    void openPath(path);
    return;
  }
  if (htmlPreview.baseUrl() && href.startsWith(htmlPreview.baseUrl()!)) {
    toast("Only documents open in the editor from the preview.");
  }
}

function handleHtmlAction(id: string): void {
  if (!knownAcceleratorIds.has(id)) return;
  runMenuAction(id);
}

function handleHtmlReady(layout: HtmlLayout): void {
  if (currentLanguage !== "html") return;
  const line = htmlRestoreLine ?? editor.cursorInfo().line;
  htmlRestoreLine = null;
  if (layout.anchors.length >= 2) {
    suppressPreviewScrollUntil = performance.now() + SYNC_SUPPRESS_MS;
    htmlPreview.scrollToLine(line);
  }
  updateActiveOutline();
}

function handleHtmlScroll(layout: HtmlLayout): void {
  if (currentLanguage !== "html") return;
  if (performance.now() < suppressPreviewScrollUntil) return;
  syncHtmlToEditor(layout);
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

function htmlImageTag(alt: string, src: string): string {
  const escape = (value: string) =>
    value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  return `<img src="${escape(src)}" alt="${escape(alt)}">`;
}

function imageContext(hasSelection = false): ImageContext {
  const html = currentLanguage === "html";
  return {
    // A relative image path is the only kind the preview scheme can reach
    // without turning an absolute filesystem path into a broken URL.
    settings: html ? { ...settings, imageUseRelativePath: true } : settings,
    documentPath: currentPath,
    hasSelection,
    insert: (markdown) => editor.insertBlock(markdown),
    imageSyntax: html ? htmlImageTag : undefined,
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
    const target = event.target as Node | null;
    const element = target as HTMLElement | null;
    const anchor = element?.closest?.<HTMLElement>("[data-line]");
    if (anchor) {
      const line = Number(anchor.dataset.line);
      if (Number.isFinite(line)) editor.revealLine(line, true, false);
    }

    // Only an editor selection is a text selection. A paste over the preview
    // has already moved the caret to the block under the pointer.
    const inEditor = target !== null && editorPane.contains(target);
    const hasSelection = inEditor && editor.cursorInfo().selectionLength > 0;

    // The decision and preventDefault must happen in this same turn; deferring
    // them to a promise lets the browser insert the pasted text as well.
    if (handleImagePaste(event, imageContext(hasSelection))) {
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
  statusZoom.addEventListener("click", () => setFontSize(DEFAULT_FONT_SIZE));

  // The flags take the same route as the native menu items, so the two can never
  // disagree and the 250 ms double-run guard lives in one place.
  for (const [button, id] of [
    ["flag-focus", "view.focus"],
    ["flag-typewriter", "view.typewriter"],
    ["flag-sync", "view.syncScroll"],
    ["flag-auto-save", "file.autoSave"],
  ] as const) {
    el<HTMLButtonElement>(button).addEventListener("click", () => runMenuAction(id));
  }
}

/**
 * Carry a reader who chose the old "System only" preset onto the new "System".
 *
 * A preset is written into settings when it is picked, so the old values survive
 * in `settings.json`. The preset used to name Georgia for prose; it is now the
 * system stack, and without this pass the reader would open the new version on
 * "Custom (user)" showing the very face the rename was meant to remove.
 *
 * The whole font signature is required, not just the body stack: a reader who
 * typed one of these strings by hand, or mixed it with another stack, has a
 * custom setting and it is left alone.
 */
function migrateLegacySystemPreset(): void {
  const legacy: Record<(typeof TYPOGRAPHY_ROLES)[number]["id"], string> = {
    sourceFont: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
    bodyFont: 'Georgia, "Iowan Old Style", "Times New Roman", serif',
    headingFont: 'system-ui, "Segoe UI", -apple-system, Roboto, sans-serif',
    codeFont: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
  };
  if (!TYPOGRAPHY_ROLES.every((role) => settings[role.id] === legacy[role.id])) return;

  // Empty means "the built-in default for this role", which is now System.
  settings = { ...settings, sourceFont: "", bodyFont: "", headingFont: "", codeFont: "" };
  persist();
}

async function boot(): Promise<void> {
  // Before the first paint, so the preview is never drawn in a fallback and then
  // corrected. The faces are local files, so this costs a millisecond.
  installBundledFonts();

  settings = await api.getSettings();
  migrateLegacySystemPreset();
  applyTheme();

  editor = createEditor(editorHost);
  editor.onDocChanged((text) => {
    setDirty(text !== savedContent);
    refreshStatus();
    scheduleTokenCount(text);
    scheduleRender();
    scheduleOutlineRefresh(text);
  });
  editor.onCursor(() => {
    refreshStatus();
    updateActiveOutline();
  });

  htmlPreview = createHtmlPreview(previewPane, {
    onLine: handleHtmlLine,
    onLink: (href) => handleHtmlLink(href),
    onAction: handleHtmlAction,
    onScroll: handleHtmlScroll,
    onReady: handleHtmlReady,
    onError: (message) => toast(message, 6200),
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
    setupTypst: () => typstSetup(),
    openDocumentation: (which) =>
      void showBuiltin(
        which === "reference" ? REFERENCE : which === "shortcuts" ? SHORTCUTS : FONT_LICENCES,
      ),
    version: () => APP_VERSION,
    pandocStatus: () => pandocCache,
    setupPandoc: async () => {
      await pandocSetup();
      await refreshPandocStatus();
      await syncExportAvailability();
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

  setSpellRemember(rememberSpelling);
  applyLayout();
  // The language list is a local COM/hunspell query, not a download. It still
  // waits until after the first paint: start-up does not block on it, and the
  // underlines appear once the answer is in.
  void api.spellcheckLanguages().then((languages) => {
    setInstalledLanguages(languages);
    applySpellcheck();
    preferences?.refresh();
  }).catch(() => {
    setInstalledLanguages([]);
    preferences?.refresh();
  });

  await installMenuListener();
  // The accelerators the menu registered, bound to the keyboard. Tauri 2 never
  // translates them on Windows, so without this the menu advertises shortcuts
  // that do nothing — see installShortcuts for the whole story.
  installShortcuts(await api.shortcuts());
  await installDragDrop();
  await installCloseGuard();
  // Look for pandoc and Typst in the background: nothing at start-up depends on
  // them, and the answers only matter once the Export menu or a `.typ` document
  // is used. The menu labels follow as soon as both answers are in.
  void refreshPandocStatus().then(syncExportAvailability);
  void refreshTypstStatus().then(syncExportAvailability);
  await listen<string[]>("open-files", (event) => {
    const first = event.payload[0];
    if (first) void openPath(first);
  });

  const startup = await api.startupFile().catch(() => null);
  if (startup) {
    await openPath(startup, { confirm: false, silent: true });
  } else if (settings.onLaunch === "new") {
    await loadUntitled("", defaultDocumentLanguage());
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
