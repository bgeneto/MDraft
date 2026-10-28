//! Application shell: document lifecycle, menu wiring, preview rendering and
//! the sidebar.

import "./styles.css";

import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { ask, message, open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";

import * as api from "./api";
import { renderAsciidocForExport, renderAsciidocPreview } from "./asciidoc-preview";
import {
  ASCIIDOC_REFERENCE,
  FONT_LICENCES,
  REFERENCE,
  SHORTCUTS,
  TYPST_REFERENCE,
  WELCOME,
} from "./content";
import { installEditorContextMenu, titleCase, type ReadingMenuState } from "./context-menu";
import { createReadAloud, type ReadAloudHandle, type ReadingState } from "./read-aloud";
import { readClipboardData } from "./clipboard";
import { createDocumentLifecycle } from "./document-lifecycle";
import { askUnsaved } from "./unsaved-dialog";
import { rewriteExportReferences } from "./export-article";
import { createEditor, type EditorHandle } from "./editor";
import {
  formatDocument,
  formatEditor,
  formatErrorMessage,
  formattedTransaction,
  hasFormatter,
} from "./format/formatters";
import {
  DEFAULT_EDITOR_LINE_HEIGHT,
  EDITOR_LINE_HEIGHTS,
  embeddedFontCss,
  installBundledFonts,
  TYPOGRAPHY_ROLES,
} from "./fonts";
import { applyHighlightTheme, highlightThemeCss } from "./highlight-theme";
import {
  buildHtmlNativePrintDocument,
  buildHtmlPrintDocument,
  createHtmlPreview,
  type HtmlAccelerator,
  type HtmlLayout,
  type HtmlPreviewHandle,
  type HtmlSelection,
} from "./html-preview";
import {
  handleImageDrop,
  handleImagePaste,
  hasImageDestination,
  imageOptions,
  NO_FOLDER_KEPT,
  typstImageProblem,
  type ImageContext,
} from "./images";
import { imageSyntaxFor, needsRelativePath } from "./image-syntax";
import { linkAt, type LinkTarget } from "./links";
import { chooseSource, type ClipboardPayload } from "./paste/detect";
import { resolvePasteDestination, type PasteDestination } from "./paste/detect-document";
import { planPaste, type ImageRequest, type ResolvedImage } from "./paste/index";
import { escapeMarkdownCurrency, markdownProseSelection } from "./math-delimiters";
import {
  ASCIIDOC_CSS,
  GITHUB_ALERT_CSS,
  KATEX_STYLESHEET_URL,
  renderMermaidIn,
  renderPreview,
  wrapNativePrintHtml,
  wrapPrintHtml,
  wrapStandaloneHtml,
} from "./markdown";
import {
  bindWordMap,
  blockRangeForNode,
  fragmentKindFor,
  rangesForSource,
  selectionEndpoints,
  snapToWords,
  sourceRangeFor,
  type BlockRange,
  type Fragment,
  type WordMap,
} from "./source-map";
import { createPreferences, type PreferencesHandle } from "./preferences";
import { createAssistant, type AssistantHandle } from "./ai/assistant";
import { captureContext } from "./ai/context";
import { createRecoveryScheduler } from "./recovery";
import { createSessionStore, pathKey, type Session } from "./sessions";
import { planRestore, rememberTabs, type RememberedTabs } from "./tab-restore";
import { installedLanguages, setInstalledLanguages, setSpellRemember } from "./spellcheck";
import * as sidebarPanel from "./sidebar";
import { resolvePalette } from "./syntax-themes";
import { createTabsUi, type TabsUi } from "./tabs";
import {
  TYPST_DISPLAY_MATH,
  TYPST_OUTLINE,
  TYPST_QUOTE,
  TYPST_RULE,
  TYPST_TABLE,
  typstInline,
  typstUnsupported,
} from "./typst-commands";
import { annotateTypstLines } from "./typst-map";
import { paragraphRangeAt } from "./typst-page-map";
import { TypstPdfPreview, type TypstPageContext } from "./typst-pdf";

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
const statusReading = el<HTMLButtonElement>("status-reading");
const noticeBar = el<HTMLDivElement>("notice-bar");
const noticeText = el<HTMLSpanElement>("notice-text");
const noticeActions = el<HTMLSpanElement>("notice-actions");
const noticeClose = el<HTMLButtonElement>("notice-close");
const toastEl = el<HTMLDivElement>("toast");
const resizer = el<HTMLDivElement>("resizer");
const splitter = el<HTMLDivElement>("splitter");

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let editor: EditorHandle;
let assistant: AssistantHandle | null = null;
let htmlPreview: HtmlPreviewHandle;
let preferences: PreferencesHandle;
let settings: api.Settings;
const sessions = createSessionStore();
/** The session on screen. Inactive tabs keep their own EditorState. */
let doc: Session = sessions.active();
/**
 * The tab strip owns its own DOM and gestures. It is created once the editor
 * exists, so a gesture that arrives before the first document cannot reach an
 * uninitialised shell. The callbacks are the shell's document lifecycle; the
 * strip never reaches into the editor itself.
 */
let tabsUi: TabsUi | null = null;
/**
 * The crash-recovery journal. The scheduler debounces per session and serialises
 * writes per id; the Rust store owns the files.
 */
const recovery = createRecoveryScheduler({
  save: api.writeRecovery,
  remove: api.removeRecovery,
  notify: (message) => toast(message, 6200),
});
let closeCommitFocus: HTMLElement | null = null;
const lifecycle = createDocumentLifecycle({
  sessions,
  text: textOf,
  read: api.readDocument,
  stat: api.statDocument,
  write: api.writeDocumentChecked,
  recovery,
  decide: askUnsaved,
  choosePath: async (session, suggested) => {
    if (
      session.lossy &&
      !(await ask(
        "This recovered text contains characters replaced during decoding. Save the displayed text as a UTF-8 copy? The original file will be kept.",
        { title: "Save recovered text", kind: "warning" },
      ))
    )
      return null;
    const chosen = await saveDialog({
      title: session.lossy ? "Save a UTF-8 copy" : "Save As",
      defaultPath:
        suggested ??
        (session.lossy ? conflictCopyPath(session) : session.path) ??
        (settings.lastDirectory
          ? joinDir(settings.lastDirectory, `untitled.${settings.defaultExtension}`)
          : `untitled.${settings.defaultExtension}`),
      filters: documentFilters(),
    });
    return Array.isArray(chosen) ? (chosen[0] ?? null) : chosen;
  },
  adoptPath: (session, path) => {
    session.path = path;
    session.name = basename(path);
    session.directory = directoryOf(path);
    session.language = languageFor(path);
  },
  replace: (session, payload) => {
    const active = session === doc,
      state = session.editorState;
    const line = active ? editor.cursorInfo().line : 1;
    describe(session, payload);
    if (active) {
      void showInEditor(false, payload.tokens);
      editor.scrollToLine(line);
    } else if (state)
      session.editorState = state.update({
        changes: { from: 0, to: state.doc.length, insert: payload.content },
      }).state;
  },
  changed: (session, pathChanged) => {
    if (session === doc) {
      if (pathChanged) {
        syncGuest(session.language);
        editor.setLanguage(session.language);
        applyLayout();
        scheduleRender(true);
        scheduleOutlineRefresh(editor.getDoc());
      }
      void refreshTitle();
      refreshStatus();
      renderNotice();
    }
    renderDocTabs();
    if (pathChanged && settings.recordRecent && session.path) {
      const path = session.path;
      void queueSettings(async () => {
        const next = await api.addRecent(path);
        settings = {
          ...settings,
          recentFiles: next.recentFiles,
          lastDirectory: next.lastDirectory,
        };
        renderSidebar();
      }).catch(() => {});
    }
  },
  conflict: (session, kind) => (kind ? markConflict(session, kind) : clearConflict(session)),
  notify: (text) => toast(text, 6200),
  committing: (active) => {
    if (active) {
      closeCommitFocus =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
    }
    document.body.inert = active;
    if (!active) {
      if (closeCommitFocus?.isConnected) closeCommitFocus.focus({ preventScroll: true });
      else editor?.focus();
      closeCommitFocus = null;
    }
  },
});

/** An informational recovery notice, cleared by the reader or a tab switch. */
let recoveryNotice: string | null = null;

function installTabs(): void {
  tabsUi = createTabsUi({
    bar: el<HTMLDivElement>("doc-tabs"),
    wrapper: el<HTMLDivElement>("doc-tabs-bar"),
    leftButton: el<HTMLButtonElement>("doc-tabs-left"),
    rightButton: el<HTMLButtonElement>("doc-tabs-right"),
    store: sessions,
    callbacks: {
      activeId: () => doc.id,
      activate: (id) => activateSession(id),
      close: (id) => closeSession(id),
      closeMany: (ids) => closeSessions(ids),
      save: (id) => {
        const session = sessions.byId(id);
        return session ? saveSession(session).then(() => undefined) : undefined;
      },
      saveAs: async (id) => {
        const session = sessions.byId(id);
        if (session) await saveAs(undefined, session);
      },
      reveal: (id) => revealSession(id),
      newTab: () => loadUntitled("", defaultDocumentLanguage()),
      format: (id) => {
        void formatSession(id).catch((error) => {
          toast(`Could not format: ${formatErrorMessage(error)}`, 5200);
        });
      },
      formatBlocked: (id) => {
        const session = sessions.byId(id);
        return session ? formatUnavailableReason(session) : "No such document.";
      },
      isFavorite: (id) => {
        const session = sessions.byId(id);
        return session?.path ? isFavoritePath(session.path) : false;
      },
      favoriteBlocked: (id) => {
        const session = sessions.byId(id);
        if (!session) return "No such document.";
        return session.path ? null : "Save the document first.";
      },
      favorite: (id) => {
        const session = sessions.byId(id);
        if (!session?.path) return;
        return toggleFavoritePath(session.path);
      },
    },
  });
}
/**
 * Boot installs the startup file into the first tab. After that, Open and New
 * add a tab instead of replacing the one the reader is in.
 */
let installingStartup = true;
/** One full-document format at a time, whichever tab it belongs to. */
let formatBusy = false;
let isDark = false;
/** Mirrors the window's fullscreen state, so the menu check can follow it. */
let isFullscreen = false;
let allowClose = false;
let lastTitle = "";
/**
 * Signature of the last remembered tab list that was written (or seeded from
 * the settings loaded at boot). Comparing it is what keeps the tab-memory
 * interval from rewriting `settings.json` when nothing changed.
 */
let lastTabsSignature = "";
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

const DEFAULT_ZOOM = 100;
const MIN_ZOOM = 50;
const MAX_ZOOM = 300;
const ZOOM_STEP = 10;

/** The persisted zoom, clamped for a hand-edited settings file. */
function zoomLevel(): number {
  return Math.min(
    MAX_ZOOM,
    Math.max(MIN_ZOOM, Math.round(settings.zoomLevel / ZOOM_STEP) * ZOOM_STEP),
  );
}

function zoomFactor(): number {
  return zoomLevel() / 100;
}
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
/** How long a preview selection settles before it paints the source. */
const WORD_SYNC_DEBOUNCE_MS = 60;

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

interface NoticeAction {
  label: string;
  run: () => void | Promise<void>;
  primary?: boolean;
}

/**
 * The one notice row under the tabs.
 *
 * Toasts have no actions and a modal blocks typing; both are wrong for a disk
 * conflict, where the reader has to choose without losing the caret. The bar
 * spans the window, collapses when hidden and is reused by recovery.
 */
function showNotice(
  text: string,
  tone: "info" | "warning",
  actions: NoticeAction[] = [],
  closable = true,
): void {
  noticeText.textContent = text;
  noticeBar.dataset.tone = tone;
  noticeBar.setAttribute("role", tone === "warning" ? "alert" : "status");
  noticeBar.setAttribute("aria-live", tone === "warning" ? "assertive" : "polite");
  noticeClose.hidden = !closable;
  noticeActions.replaceChildren();
  for (const action of actions) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `notice-action${action.primary ? " primary" : ""}`;
    button.textContent = action.label;
    button.addEventListener("click", () => {
      try {
        void Promise.resolve(action.run()).catch((error) => toast(String(error), 6200));
      } catch (error) {
        toast(String(error), 6200);
      }
    });
    noticeActions.appendChild(button);
  }
  noticeBar.hidden = false;
}

function hideNotice(): void {
  noticeBar.hidden = true;
  noticeText.textContent = "";
  noticeActions.replaceChildren();
}

function renderNotice(): void {
  if (doc.lossy) {
    const session = doc;
    showNotice(
      "Recovered text was decoded with replaced characters. Auto Save is paused; the original file is protected.",
      "warning",
      [
        {
          label: "Save a UTF-8 copy…",
          run: () => saveAs(conflictCopyPath(session), session).then(() => {}),
        },
      ],
      false,
    );
    return;
  }
  if (doc.conflict === "modified") {
    showNotice(
      `"${doc.name}" changed on disk. Choose what to keep before saving.`,
      "warning",
      [
        { label: "Reload from disk", run: () => reloadConflict(doc) },
        { label: "Keep my version", run: () => keepMine(doc) },
        { label: "Save a copy…", run: () => saveConflictCopy() },
      ],
      false,
    );
    return;
  }
  if (doc.conflict === "deleted") {
    showNotice(
      `"${doc.name}" was deleted on disk. Saving would recreate it.`,
      "warning",
      [
        { label: "Save anyway", run: () => recreateDeleted(doc), primary: true },
        { label: "Save a copy…", run: () => saveConflictCopy() },
      ],
      false,
    );
    return;
  }
  if (recoveryNotice) {
    showNotice(recoveryNotice, "info", [], true);
    return;
  }
  hideNotice();
}

noticeClose.addEventListener("click", () => {
  recoveryNotice = null;
  hideNotice();
});

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

/** Refresh the editor flags from the settings they mirror. */
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
  // HTML source is markup: `applySpellcheck` leaves the dictionary out of it, so
  // the setting stays on but the flag says it is doing nothing here.
  setStatusFlag(
    "flag-spellcheck",
    settings.spellcheck !== false,
    doc.language === "html",
    "Check spelling",
    "",
    doc.language === "html"
      ? "No effect on HTML documents, whose source is markup."
      : "Underlines words the installed dictionary does not recognise.",
  );
}

/**
 * Show the zoom level only while it differs from 100%.
 *
 * The percentage is the unit the menu and the shortcut imply; the editable
 * font sizes remain separate preferences. It is clickable, like every other
 * status-bar indicator.
 */
function updateZoomIndicator(): void {
  const level = zoomLevel();
  const zoomed = level !== DEFAULT_ZOOM;
  statusZoom.hidden = !zoomed;
  statusZoom.textContent = `${level}%`;
  statusZoom.title = `Zoom ${level}% — click to reset to ${DEFAULT_ZOOM}%`;
  statusZoom.setAttribute(
    "aria-label",
    `Document zoom ${level} percent. Click to reset to ${DEFAULT_ZOOM} percent.`,
  );
}

/**
 * Mirror the interface's state onto the native menu.
 *
 * The menu is a native control: it cannot read the DOM, and Rust cannot see
 * whether the window is fullscreen, which document is active, what is selected
 * or which link is under the caret. Sending one snapshot avoids deriving the
 * same booleans in two places and keeps the menu right after every change,
 * including the ones made in Preferences. A failure here is cosmetic — the
 * settings remain the source of truth.
 */
let menuSyncGeneration = 0;

function menuStateSnapshot(): api.MenuState {
  const list = sessions?.list?.() ?? [];
  const index = list.findIndex((session) => session.id === doc?.id);
  const selection = editor ? editor.view.state.selection.main : null;
  const link = editor ? linkUnderCaret() : null;
  const canFormat = doc ? formatUnavailableReason(doc) === null : false;
  const hasCommentSyntax =
    editor && selection
      ? editor.view.state.languageDataAt("commentTokens", selection.from, 1).length > 0
      : false;
  const canFold =
    doc?.language === "markdown" || doc?.language === "html" || doc?.language === "typst";
  const syntaxTheme =
    settings.syntaxTheme === "github-light" ? "catppuccin-latte" : settings.syntaxTheme;

  return {
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
    documentLanguage: doc?.language ?? "markdown",
    readOnly: doc?.readOnly ?? false,
    hasSelection: selection !== null && selection.from !== selection.to,
    hasCommentSyntax,
    linkKind: link?.kind ?? "",
    canFormat,
    tabCount: list.length,
    tabIndex: index < 0 ? 0 : index,
    unchangedOtherTabs: list.filter((session) => session.id !== doc?.id && !session.dirty).length,
    hasPath: Boolean(doc?.path),
    isFavorite: doc?.path ? isFavoritePath(doc.path) : false,
    canFold,
    spellcheck: settings.spellcheck !== false,
    spellcheckAvailable: installedLanguages().length > 0 && doc?.language !== "html",
    syntaxTheme,
    typstView: settings.typstView,
    typstAvailable: typstCache?.found !== false,
  };
}

function syncMenuState(refreshWindow = true): void {
  const generation = ++menuSyncGeneration;
  if (!refreshWindow) {
    // Cursor-driven syncs reuse the window's last known fullscreen state; asking
    // the window on every caret move would turn typing into a stream of IPC.
    void api.setMenuState(menuStateSnapshot()).catch(() => {
      /* cosmetic: the menu is not the source of truth */
    });
    return;
  }
  void (async () => {
    try {
      isFullscreen = await getCurrentWindow().isFullscreen();
    } catch {
      /* the window may be closing; keep the last known value */
    }
    if (generation !== menuSyncGeneration) return;
    try {
      await api.setMenuState(menuStateSnapshot());
    } catch {
      /* cosmetic: the menu is not the source of truth */
    }
  })();
}

/** Coalesce cursor-driven updates; a selection change is not worth one IPC per key. */
let menuSyncTimer = 0;
function scheduleMenuStateSync(): void {
  window.clearTimeout(menuSyncTimer);
  menuSyncTimer = window.setTimeout(() => syncMenuState(false), 80);
}

/**
 * Repopulate Navigate › Open Tabs.
 *
 * Calls are coalesced and serialized: a burst of tab changes must not leave an
 * older list in the native submenu after a newer one.
 */
let openTabsPending: api.OpenTabItem[] | null = null;
let openTabsRunning = false;
let openTabsKey = "";

function openTabItems(): api.OpenTabItem[] {
  const list = sessions.list();
  const nameCounts = new Map<string, number>();
  for (const session of list) {
    nameCounts.set(session.name, (nameCounts.get(session.name) ?? 0) + 1);
  }
  return list.map((session) => {
    const duplicate = (nameCounts.get(session.name) ?? 0) > 1;
    const label =
      duplicate && session.directory ? `${session.name} — ${session.directory}` : session.name;
    return { id: session.id, label, checked: session.id === doc.id };
  });
}

function syncOpenTabs(): void {
  const tabs = openTabItems();
  const key = tabs
    .map((tab) => `${tab.id}\u0000${tab.label}\u0000${tab.checked ? "1" : "0"}`)
    .join("\u0001");
  if (key === openTabsKey) return;
  openTabsKey = key;
  openTabsPending = tabs;
  if (openTabsRunning) return;
  openTabsRunning = true;
  void (async () => {
    try {
      while (openTabsPending) {
        const next = openTabsPending;
        openTabsPending = null;
        try {
          await api.setOpenTabs(next);
        } catch {
          // Let the next tab render retry rather than leaving the native list
          // empty for the rest of the session.
          openTabsKey = "";
        }
      }
    } finally {
      openTabsRunning = false;
    }
  })();
}

function rememberSpelling(word: string): void {
  const folded = word.replace(/[\u2019\u2018\u02BC]/g, "'").trim();
  if (!folded) return;
  if (settings.spellcheckWords.some((entry) => entry.toLowerCase() === folded.toLowerCase()))
    return;
  // The list is the reader's, and it is stored in settings.json. Cap it so a
  // long session of "add" cannot grow the file without bound.
  const words = [...settings.spellcheckWords, folded].slice(-500);
  applySettingsPatch({ spellcheckWords: words });
}

function applySpellcheck(): void {
  editor?.setSpellcheck({
    // HTML source is markup; the dictionary's node names are Markdown-shaped and
    // would underline tags and attribute names.
    enabled: settings.spellcheck !== false && doc.language !== "html",
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
  app.classList.toggle("document-html", doc.language === "html");

  // 0 means "full width" in the settings model.
  const width = settings.editorMaxWidth;
  document.documentElement.style.setProperty(
    "--editor-max-width",
    width > 0 ? `${width}px` : "none",
  );

  const zoom = zoomFactor();
  document.documentElement.style.setProperty("--preview-zoom", String(zoom));
  // CSS zoom scales the rendered box. A max-width is a layout length, so the
  // preview's cap is divided by the zoom; `width: 100%` already resolves to the
  // narrower layout box and fills the pane after scaling.
  document.documentElement.style.setProperty(
    "--preview-max-width",
    width > 0 ? `${width / zoom}px` : "none",
  );

  // The setting stores a name, not a multiplier. An older or hand-edited file
  // may carry a name this build does not know; Normal is the fallback.
  const lineHeight =
    EDITOR_LINE_HEIGHTS[settings.editorLineHeight] ??
    EDITOR_LINE_HEIGHTS[DEFAULT_EDITOR_LINE_HEIGHT];
  document.documentElement.style.setProperty("--editor-line-height", String(lineHeight));

  editor?.setFontSize(settings.editorFontSize * zoom);
  editor?.setFocusMode(settings.focusMode);
  editor?.setTypewriter(settings.typewriterMode);
  typstPdf?.setZoom(zoom);
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

  for (const tab of ["outline", "favorites", "recent"] as const) {
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
  assistant?.onViewMode(settings.viewMode);
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
  // Code is drawn at 86% of the prose for a block and 88% inline, because a
  // monospaced face reads larger at the same nominal size. This multiplies that
  // ratio; 100 leaves it alone and about 116 makes a block match the prose.
  root.setProperty("--code-scale", String(settings.codeFontScale / 100));

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

/**
 * Every settings mutation and write runs in one queue.
 *
 * The whole `Settings` object is written back on many gestures, while the
 * favorite and recent commands return a whole snapshot of their own. Two of
 * those in flight together can land out of order: a save built before an
 * Add to Favorites reaches Rust after it and overwrites the list with the copy
 * that predates it, on disk as well as in memory. Queueing the commands in call
 * order — and reading `settings` only when a queued write actually runs — makes
 * that stale snapshot impossible.
 *
 * A failed task must not poison the chain, so the queue itself swallows the
 * rejection; the caller still receives it from the returned promise.
 */
let settingsQueue: Promise<unknown> = Promise.resolve();

function queueSettings<T>(task: () => Promise<T>): Promise<T> {
  const result = settingsQueue.then(task);
  settingsQueue = result.catch(() => undefined);
  return result;
}

function persist(): void {
  // Deliberately reads `settings` inside the task: a save scheduled while a
  // favorite command is still in flight must send what that command returns.
  void queueSettings(() => api.saveSettings(settings).catch(() => settings));
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
  assistant?.sync();

  if (patch.autoClosePairs !== undefined || patch.autoCloseTags !== undefined) {
    editor.setAutoClose({
      pairs: settings.autoClosePairs,
      tags: settings.autoCloseTags,
    });
  }

  if (affectsRendering) scheduleRender(true);
}

// ---------------------------------------------------------------------------
// Title & status bar
// ---------------------------------------------------------------------------

async function refreshTitle(): Promise<void> {
  const name = doc.name ?? "Untitled";
  const title = `${doc.dirty ? "• " : ""}${name} — MDraft`;
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
  statusFile.textContent = `${doc.dirty ? "• " : ""}${doc.name ?? "Untitled"}`;
  statusWords.textContent = `${wordsText} ${words === 1 ? "word" : "words"}`;
  statusWords.title = `${wordsText} words · ${formatCount(chars)} characters · ${formatCount(lines)} lines`;
  statusCursor.textContent = `Ln ${cursor.line}, Col ${cursor.column}${
    cursor.selectionLength > 0
      ? ` (${cursor.selectionLength} selected${
          cursor.selectionLines > 1 ? `, ${cursor.selectionLines} lines` : ""
        })`
      : ""
  }`;

  if (!doc.path) {
    statusEncoding.textContent = "UTF-8 · not saved";
  } else {
    const eol = doc.lineEnding === "\r\n" ? "CRLF" : "LF";
    statusEncoding.textContent = `UTF-8${doc.hadBom ? " BOM" : ""} · ${eol}${
      doc.readOnly ? " · read-only" : ""
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
/** Last scroll offset reported by the HTML guest. The preview pane does not scroll. */
let htmlScrollTop = 0;
/**
 * Scroll to restore after the next preview rebuild. Null means the render may
 * align the preview to the caret, which is what a keystroke wants and a tab
 * switch must not do.
 */
let pendingPreviewScroll: number | null = null;

function scheduleRender(immediate = false): void {
  window.clearTimeout(renderTimer);
  const delay = doc.language === "html" ? 300 : doc.language === "asciidoc" ? 250 : 200;
  renderTimer = window.setTimeout(() => void doRender(), immediate ? 0 : delay);
}

// The PDF.js page view currently on screen, if any. It owns the PDF document,
// its worker connection and the page canvases; replacing the preview must
// destroy it or a long session keeps every page it ever drew alive.
let typstPdf: TypstPdfPreview | null = null;
let typstPdfToken = -1;

function disposeTypstPdf(): void {
  typstPdf?.dispose();
  typstPdf = null;
}

/** Decode the base64 PDF the Rust command returns. */
function decodePdf(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * The sentence `render` in `src-tauri/src/typst.rs` returns when no Typst
 * executable could be found. The command reports failures as plain strings, so
 * there is no error code to test; keep this and the Rust wording in step.
 */
const TYPST_MISSING = "Typst is not installed, so .typ documents cannot be previewed.";

/** The pane's note when Typst is absent, with the one action that fixes it. */
function typstMissingNote(message: string): HTMLElement {
  const note = document.createElement("div");
  note.className = "typst-note";
  const text = document.createElement("span");
  text.className = "typst-note-text";
  text.textContent = message;
  const install = document.createElement("button");
  install.type = "button";
  install.className = "typst-notebutton";
  install.textContent = "Install Typst…";
  install.title = "Download the official Typst build into MDraft's own folder";
  install.addEventListener("click", () => {
    // Installing from this note should revive the pane without an edit.
    void typstSetup().then(() => scheduleRender(true));
  });
  note.append(text, install);
  return note;
}

/** Replace the pane with a Typst error, keeping the view switch available. */
function showTypstFailure(error: unknown, wanted: string): void {
  disposeTypstPdf();
  preview.innerHTML = "";
  previewLinesMapped = false;
  const message = String(error);
  if (message.includes(TYPST_MISSING)) {
    // Neither view can render without the compiler, so a Document/Pages switch
    // would be a dead control. The note offers the fix instead.
    preview.appendChild(typstMissingNote(message));
    applyPendingPreviewScroll();
    return;
  }
  preview.appendChild(typstViewBar(wanted));
  const box = document.createElement("pre");
  box.className = "typst-error";
  box.textContent = message;
  preview.appendChild(box);
  applyPendingPreviewScroll();
}

/**
 * The preview of a Typst document.
 *
 * Two views, and the reason there are two is worth stating plainly. Typst's HTML
 * export yields plain semantic HTML — the same `h2`, `p`, `code`, `ol`, `table`
 * and MathML that the Markdown preview already renders — so the pane's type,
 * colours and width apply to it and the text flows and can be selected. What it
 * cannot do is layout: page size, `#align`, boxes and page breaks are dropped.
 *
 * The page view is the compiler's PDF drawn by PDF.js. It is always faithful,
 * its text layer can be selected and clicked, and it is the only view that shows
 * the page layout Typst will print.
 *
 * The default is the document view: a preview is for reading. The page view is one
 * click away, and the pane says so when the document view had to drop something.
 */
async function renderTypstPreview(source: string, token: number): Promise<void> {
  const wanted = settings.typstView === "pages" ? "pages" : "document";

  let rendered: api.RenderedTypst;
  try {
    rendered = await api.renderTypst(doc.path, source, wanted, customImageFolder());
  } catch (error) {
    if (token !== renderToken) return;
    // Shown in place of the preview, not as a toast: a Typst error is about a
    // line of this document, and the pane is where the document is looked at.
    showTypstFailure(error, wanted);
    return;
  }
  if (token !== renderToken) return;

  disposeTypstPdf();
  // A word decoration belongs to the view that produced it. Switching to Pages,
  // or re-rendering the document, must not leave a mark that cannot be cleared.
  syncedSource = null;
  editor.clearSyncRange();
  preview.innerHTML = "";
  preview.before(typstViewBar(rendered.kind));

  if (rendered.kind === "document") {
    const dropped = typstDroppedNote(rendered);
    if (dropped) preview.appendChild(dropped);
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
    // back to the source by their text — see typst-map.ts. The returned ranges
    // feed the same block-record word map AsciiDoc uses; generated text simply
    // does not map, and the block click remains.
    const mapped = annotateTypstLines(host, source);
    previewLinesMapped = mapped.mapped >= 2;
    bindPreviewWords(source, undefined, mapped.blocks);
    rebuildAnchors();
    if (pendingPreviewScroll === null) revealCursorInPreview();
    else applyPendingPreviewScroll();
    updateActiveOutline();
    syncPreviewFromSource();
    return;
  }

  if (!rendered.pdf) {
    showTypstFailure("The page render produced no PDF.", rendered.kind);
    return;
  }

  const host = document.createElement("div");
  host.className = "typst-preview";
  preview.appendChild(host);
  const view = new TypstPdfPreview(host, previewPane, syncSourceFromPageSelection, source);
  typstPdf = view;
  typstPdfToken = token;
  view.setZoom(zoomFactor());
  try {
    await view.render(decodePdf(rendered.pdf));
  } catch (error) {
    if (token !== renderToken) return;
    showTypstFailure(error, rendered.kind);
    return;
  }
  if (token !== renderToken) {
    view.dispose();
    if (typstPdf === view) typstPdf = null;
    return;
  }
  // Pages are a rendered layout, not a source-anchored document; the text layer
  // supplies click sync separately.
  previewLinesMapped = false;
  applyPendingPreviewScroll();
  syncPreviewFromSource();
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
    button.addEventListener("click", () => chooseTypstView(id as api.TypstView));
    bar.appendChild(button);
  }
  return bar;
}

/** Switch the preview view and redraw it. */
function chooseTypstView(view: api.TypstView): void {
  if (settings.typstView === view) return;
  settings.typstView = view;
  syncMenuState();
  persist();
  scheduleRender(true);
}

/**
 * The constructs Typst's HTML export drops *together with their contents*.
 *
 * Every construct it cannot express produces a warning, but the warnings are not
 * equivalent: `#v`, `#h` and `#pagebreak` only lose spacing, while `#columns`,
 * `#grid` and `#align` take everything inside them. A paper whose body is one
 * `#columns` call therefore previews as a couple of stray paragraphs, which looks
 * like a broken renderer rather than a limitation of the export.
 */
const TYPST_CONTENT_LOSS = new Set(["align", "columns", "grid", "pad", "place", "rect", "stack"]);

/**
 * A note naming what the document view could not show, or null when it is whole.
 *
 * Typst reports the dropped constructs on stderr and the Rust side collects them
 * into `ignored`. Without this note the pane silently shows less than the
 * document contains — the one failure mode a preview must not have.
 */
function typstDroppedNote(rendered: api.RenderedTypst): HTMLElement | null {
  const lost = rendered.ignored.filter((name) => TYPST_CONTENT_LOSS.has(name));
  if (lost.length === 0) return null;

  const note = document.createElement("div");
  note.className = "typst-note";
  const text = document.createElement("span");
  text.className = "typst-note-text";
  const names = lost.map((name) => `#${name}`);
  const listed =
    names.length === 1
      ? names[0]
      : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  text.textContent =
    `Typst's HTML export cannot represent ${listed} and drops everything inside ` +
    `${names.length === 1 ? "it" : "them"}, so this view shows less than the document.`;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "typst-notebutton";
  button.textContent = "Show pages";
  button.title = "The compiler's own page layout, where nothing is dropped";
  button.addEventListener("click", () => chooseTypstView("pages"));
  note.append(text, button);
  return note;
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
    doc.directory ?? null,
    doc.name ?? "index.html",
    settings.htmlPreviewScripts !== false,
    // Only a saved document has a root the guest can resolve against; a custom
    // folder is the one extra folder the reader allowed.
    doc.path ? [customImageFolder()].filter((dir): dir is string => dir !== null) : [],
  );
  if (token !== renderToken) return;
}

async function doRender(): Promise<void> {
  const token = ++renderToken;
  const source = editor.getDoc();

  // The Typst view bar lives outside `#preview` so document zoom does not scale
  // its buttons. Every render begins by removing the previous one.
  previewPane.querySelector(":scope > .typst-viewbar")?.remove();

  // The DOM the old map described is about to be replaced.
  wordMap = null;
  clearPreviewWords();

  if (doc.language === "html") {
    await renderHtmlPreview(source, token);
    return;
  }

  if (doc.language === "typst") {
    await renderTypstPreview(source, token);
    return;
  }

  if (doc.language === "asciidoc") {
    const result = await renderAsciidocPreview(source, {
      baseDir: doc.directory ?? null,
      math: settings.enableMath,
      mermaid: settings.enableMermaid,
      isDark,
    });
    if (token !== renderToken) return;
    preview.innerHTML = result.html;
    previewLinesMapped = result.linesMapped;
    bindPreviewWords(source, undefined, result.blocks);
    rebuildAnchors();
    if (pendingPreviewScroll === null) revealCursorInPreview();
    else applyPendingPreviewScroll();
    updateActiveOutline();
    syncPreviewFromSource();
    return;
  }

  const result = renderPreview(source, {
    baseDir: doc.directory ?? null,
    math: settings.enableMath,
    mermaid: settings.enableMermaid,
    map: true,
  });
  if (token !== renderToken) return;
  preview.innerHTML = result.html;
  previewLinesMapped = result.linesMapped;
  bindPreviewWords(source, result.fragments);

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
  if (pendingPreviewScroll === null) revealCursorInPreview();
  else applyPendingPreviewScroll();
  updateActiveOutline();
  syncPreviewFromSource();
}

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

/** Draw the document tabs. One document still gets a tab: New and Close need a target. */
function renderDocTabs(): void {
  tabsUi?.render();
  syncOpenTabs();
  scheduleMenuStateSync();
}

function renderSidebar(): void {
  if (!settings.sidebarVisible) return;

  if (settings.sidebarTab === "outline") {
    refreshOutline();
    return;
  }

  if (settings.sidebarTab === "favorites") {
    sidebarPanel.renderFavorites(sidebarBody, settings.favorites ?? [], {
      onOpenFile: openFavorite,
      onRemove: (path) => void removeFavoritePath(path),
    });
    return;
  }

  sidebarPanel.renderRecent(sidebarBody, settings.recentFiles, {
    onOpenFile: (path) => void openPath(path),
    onClear: clearRecentFiles,
    onError: toast,
  });
}

/**
 * Clear the persisted recents from whichever control asked.
 *
 * The native menu, the sidebar footer and Preferences all mean the same thing,
 * and Rust refreshes the menu itself. Doing it in one place keeps the toast and
 * the sidebar redraw from existing on only one of the three routes.
 */
function clearRecentFiles(): void {
  void queueSettings(async () => {
    const next = await api.clearRecent();
    settings = { ...settings, recentFiles: next.recentFiles };
  })
    .then(() => {
      renderSidebar();
      toast("Recent files cleared");
    })
    .catch((error) => toast(String(error)));
}

/** The platform's path identity, the same rule the session store uses. */
function isFavoritePath(path: string): boolean {
  const key = pathKey(path);
  return (settings.favorites ?? []).some((entry) => pathKey(entry) === key);
}

function favoriteName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/**
 * Add or remove one path, then redraw only when Favorites is the panel on
 * screen. The command returns the settings it wrote, so the row list and the
 * menu toggle never disagree about what is stored.
 */
async function toggleFavoritePath(path: string): Promise<void> {
  try {
    // The decision is taken inside the queue as well: two quick clicks on the
    // same row must see each other's result, not the same stale list.
    const removing = await queueSettings(async () => {
      const remove = isFavoritePath(path);
      const next = remove ? await api.removeFavorite(path) : await api.addFavorite(path);
      // Merge only the field this command owns. A preference patch applied
      // while it was in flight must not be thrown away by the whole reply.
      settings = { ...settings, favorites: next.favorites };
      return remove;
    });
    if (settings.sidebarTab === "favorites") renderSidebar();
    syncMenuState();
    toast(
      removing
        ? `Removed ${favoriteName(path)} from Favorites`
        : `Added ${favoriteName(path)} to Favorites`,
    );
  } catch (error) {
    toast(String(error), 5200);
  }
}

/** A row's `×` or its context menu: remove exactly this entry. */
async function removeFavoritePath(path: string): Promise<void> {
  try {
    await queueSettings(async () => {
      const next = await api.removeFavorite(path);
      settings = { ...settings, favorites: next.favorites };
    });
    if (settings.sidebarTab === "favorites") renderSidebar();
    syncMenuState();
    toast(`Removed ${favoriteName(path)} from Favorites`);
  } catch (error) {
    toast(String(error), 5200);
  }
}

/**
 * Open a favorite. Silent means a missing file becomes a toast naming the
 * failure rather than a modal dialog, which would be too heavy for a sidebar
 * row — and impossible to dismiss from a test.
 */
function openFavorite(path: string): void {
  void openPath(path, { silent: true });
}

/** Rebuild the outline list from the current buffer. */
function refreshOutline(text = editor.getDoc()): void {
  if (settings.sidebarTab !== "outline" || !settings.sidebarVisible) return;
  // A document load schedules a refresh and then calls renderSidebar(); this
  // cancels the duplicate that would otherwise rescan 250 ms later.
  window.clearTimeout(outlineTimer);

  const language = doc.language;
  outlineHeadings =
    language === "typst"
      ? sidebarPanel.extractTypstHeadings(text)
      : language === "html"
        ? sidebarPanel.extractHtmlHeadings(text)
        : language === "asciidoc"
          ? sidebarPanel.extractAsciidocHeadings(text)
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
  if (!outlineReady || outlineLanguage !== doc.language) {
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
  if (/\.(?:adoc|asciidoc)$/i.test(path)) return "asciidoc";
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
  if (settings.defaultExtension === "adoc" || settings.defaultExtension === "asciidoc") {
    return "asciidoc";
  }
  return "markdown";
}

/**
 * The file dialog filters: the default markup's filter first, the rest
 * alphabetical.
 *
 * The native dialog selects the first entry and offers no way to select another
 * (rfd declares `SetFileTypeIndex` but never calls it), so a reader who chose
 * Typst as the default should not have to switch away from "Markdown" every
 * time. The remaining entries are ordered by name — All files, AsciiDoc, HTML,
 * Markdown, Typst — so the list reads the same in every dialog rather than in
 * the order the markup types happened to be introduced.
 */
function documentFilters(): { name: string; extensions: string[] }[] {
  const markdown = {
    name: "Markdown",
    extensions: ["md", "markdown", "mdown", "mkd", "txt"],
  };
  const typst = { name: "Typst", extensions: ["typ"] };
  const html = { name: "HTML", extensions: ["html", "htm"] };
  const asciidoc = { name: "AsciiDoc", extensions: ["adoc", "asciidoc"] };
  const all = { name: "All files", extensions: ["*"] };
  const alphabetical = [all, asciidoc, html, markdown, typst];
  const preferred = {
    markdown,
    typst,
    html,
    asciidoc,
  } satisfies Record<api.DocumentLanguage, { name: string; extensions: string[] }>;
  const first = preferred[defaultDocumentLanguage()];
  return [first, ...alphabetical.filter((filter) => filter !== first)];
}

/** Drop the guest when the editor leaves HTML; start a fresh nonce when it enters. */
function syncGuest(next: api.DocumentLanguage): void {
  if (!htmlPreview) return;
  if (next === "html") htmlPreview.reset();
  else htmlPreview.dispose();
}

/** Copy a file read onto a session. The EditorState is left for the caller. */
function describe(session: Session, payload: api.DocumentPayload): void {
  session.revision += 1;
  session.path = payload.path;
  session.name = payload.name;
  session.directory = payload.directory || null;
  session.language = languageFor(payload.path);
  session.savedContent = payload.content;
  session.dirty = false;
  session.lineEnding = payload.lineEnding;
  session.hadBom = payload.hadBom;
  session.lossy = payload.lossy;
  session.size = payload.size;
  session.modifiedMs = payload.modifiedMs;
  session.sha256 = payload.sha256;
  session.readOnly = payload.readOnly;
  session.draft = null;
  session.conflict = null;
}

/** Text of a session: the live view when it is on screen, otherwise its snapshot. */
function textOf(session: Session): string {
  if (session.id === doc.id && editor) return editor.getDoc();
  return session.draft ?? session.editorState?.doc.toString() ?? session.savedContent;
}

/**
 * Remember the on-screen session before another one takes the view.
 *
 * EditorState holds the text, the caret and the undo history. Scroll is not in
 * that state, so it is stored beside it. The preview is rebuilt on the way back
 * and only its scroll offset is worth keeping.
 */
function snapshotDoc(): void {
  if (!editor) return;
  doc.editorState = editor.captureState();
  doc.draft = null;
  doc.editorScroll = editor.view.scrollDOM.scrollTop;
  doc.previewScroll = doc.language === "html" ? htmlScrollTop : previewPane.scrollTop;
}

/** A render that started for the previous tab must not paint this one. */
function invalidatePreview(): void {
  renderToken += 1;
  window.clearTimeout(renderTimer);
  window.clearTimeout(selectionTimer);
  wordMap = null;
  syncedSource = null;
  clearPreviewWords();
  editor?.clearSyncRange();
}

/**
 * Put `doc` into the single editor. `resetHistory` is true for an open or a new
 * buffer and false for a reload or Save As, which should stay undoable.
 */
async function showInEditor(resetHistory: boolean, tokens: number | null = null): Promise<void> {
  // A new document replaces the buffer the answer was captured from.
  assistant?.close();
  invalidatePreview();
  pendingPreviewScroll = null;
  doc.editorState = null;
  doc.editorScroll = 0;
  doc.previewScroll = 0;
  resetTokenCount();
  resetOutline();
  const content = doc.draft ?? doc.savedContent;
  editor.setDoc(content, resetHistory);
  // The live view is now the authority; a recovered draft must not shadow it.
  doc.draft = null;
  syncGuest(doc.language);
  editor.setLanguage(doc.language);
  // The backend counted while reading the file, so opening does not send the
  // document back over IPC. This also cancels the debounced scan that the
  // `setDoc` update just scheduled. A buffer with no count of its own is scanned.
  if (tokens !== null) setTokenCount(tokens);
  else scheduleTokenCount(content, true);

  applyLayout();
  await refreshTitle();
  refreshStatus();
  renderDocTabs();
  renderSidebar();
  renderNotice();
  scheduleRender(true);
}

/**
 * Show the session that is already `doc`, from the state captured when it was
 * hidden. Global chrome is reapplied afterwards: a restored EditorState still
 * carries the font size and palette from the moment it was snapshotted.
 */
async function displayDoc(): Promise<void> {
  // A different document means the answer no longer belongs to the range it
  // was requested for. Closing here covers tab switches, new documents and
  // closing the active tab, not only `activateSession`.
  assistant?.close();
  // The reading belongs to the document that was on screen; a tab switch, a
  // reload or a closed tab must not leave a voice talking about another file.
  stopReadAloud();
  invalidatePreview();
  pendingPreviewScroll = doc.previewScroll;
  suppressEditorScrollUntil = performance.now() + SYNC_SUPPRESS_MS;
  suppressPreviewScrollUntil = performance.now() + SYNC_SUPPRESS_MS;
  if (doc.editorState) {
    editor.restoreState(doc.editorState, doc.editorScroll);
    doc.draft = null;
  } else {
    editor.setDoc(doc.draft ?? doc.savedContent, false);
    doc.draft = null;
  }
  // The snapshot may have been taken before an async grammar arrived. Installing
  // the session's language again is a no-op once that grammar is already in the
  // state, and it repairs the case where it is not.
  editor.setLanguage(doc.language);
  syncGuest(doc.language);
  resetOutline();
  applyLayout();
  editor.setSpellcheck(
    {
      enabled: settings.spellcheck !== false && doc.language !== "html",
      language: settings.spellcheckLanguage || "auto",
      words: settings.spellcheckWords ?? [],
    },
    true,
  );
  resetTokenCount();
  scheduleTokenCount(editor.getDoc(), true);
  await refreshTitle();
  refreshStatus();
  renderDocTabs();
  renderSidebar();
  renderNotice();
  scheduleOutlineRefresh(editor.getDoc());
  scheduleRender(true);
  editor.focus();
}

async function activateSession(id: string): Promise<void> {
  if (id === doc.id) {
    renderDocTabs();
    renderNotice();
    return;
  }
  if (!sessions.byId(id)) return;
  assistant?.close();
  snapshotDoc();
  doc = sessions.setActive(id);
  await displayDoc();
}

function setDirty(next: boolean): void {
  if (doc.dirty === next) return;
  doc.dirty = next;
  void refreshTitle();
  refreshStatus();
  renderDocTabs();
}

/** Why Format Document cannot run for `session`, or null when it can. */
function formatUnavailableReason(session: Session): string | null {
  if (session.readOnly) return "This document is read-only.";
  if (!hasFormatter(session.language)) return "AsciiDoc documents have no formatter.";
  if (formatBusy) return "Formatting is already running.";
  if (session.id !== doc.id && !session.editorState) {
    return "This document is not ready to be formatted yet.";
  }
  return null;
}

/**
 * Format one document, active or in the background.
 *
 * The active tab uses the live view. An inactive tab has no view; its stored
 * `EditorState` is formatted and replaced in place, which keeps the caret and
 * undo history for the moment it comes back. Both paths discard a result whose
 * snapshot changed while the formatter was running.
 */
async function formatSession(id: string): Promise<void> {
  const session = sessions.byId(id);
  if (!session) return;
  const reason = formatUnavailableReason(session);
  if (reason) {
    toast(reason);
    return;
  }

  const active = session.id === doc.id;
  const state = active ? editor.view.state : session.editorState;
  if (!state) {
    toast("This document is not ready to be formatted yet.");
    return;
  }

  formatBusy = true;
  syncMenuState();
  const pending = toast(active ? "Formatting…" : `Formatting ${session.name}…`, 0);
  try {
    if (active) {
      const outcome = await formatEditor(editor.view, session.language);
      pending.dismiss();
      if (outcome === "changed") toast("Formatted");
      else if (outcome === "unchanged") toast("Already formatted");
      else {
        toast("The document changed while it was being formatted — nothing was applied.", 4200);
      }
      return;
    }

    const before = state.doc;
    const source = before.toString();
    const formatted = await formatDocument(source, session.language);
    pending.dismiss();
    if (sessions.byId(id) !== session || session.editorState !== state || session.id === doc.id) {
      toast("The document changed while it was being formatted — nothing was applied.", 4200);
      return;
    }
    if (formatted === null || formatted === source) {
      toast(`${session.name} is already formatted`);
      return;
    }
    session.editorState = state.update(formattedTransaction(state, formatted)).state;
    session.revision += 1;
    session.dirty = formatted !== session.savedContent;
    if (session.dirty) recovery.schedule(session, session.editorState.doc.toString());
    else void recovery.forget(session);
    renderDocTabs();
    toast(`Formatted ${session.name}`);
  } catch (error) {
    pending.dismiss();
    toast(`Could not format: ${formatErrorMessage(error)}`, 6200);
  } finally {
    formatBusy = false;
    syncMenuState();
  }
}

interface OpenOptions {
  silent?: boolean;
  /**
   * Record the file in Recents. Restoring a remembered tab set passes false:
   * those documents were not opened in this session, and ten restored tabs
   * would push the reader's actual history off the sidebar.
   */
  rememberRecent?: boolean;
}

async function openPath(path: string, options: OpenOptions = {}): Promise<void> {
  const { silent = false, rememberRecent = true } = options;
  const existing = sessions.findByPath(path);
  if (existing) {
    await activateSession(existing.id);
    return;
  }

  try {
    const payload = await api.readDocument(path);
    if (installingStartup) {
      describe(doc, payload);
    } else {
      snapshotDoc();
      const session = sessions.create();
      describe(session, payload);
      sessions.add(session);
      doc = session;
    }
    await showInEditor(true, payload.tokens);

    if (rememberRecent && settings.recordRecent) {
      // Queued: the reply must not replace a favorite that was added while the
      // document was loading. Only this command's own fields are adopted.
      await queueSettings(async () => {
        try {
          const next = await api.addRecent(path);
          settings = {
            ...settings,
            recentFiles: next.recentFiles,
            lastDirectory: next.lastDirectory,
          };
        } catch {
          /* recents are best-effort */
        }
      });
    }
    if (settings.sidebarTab === "recent") renderSidebar();

    if (payload.lossy) {
      toast(
        "This text contains replaced characters. Save a UTF-8 copy; the original is protected.",
      );
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

/**
 * Open several paths in order, keeping the last successful one active.
 *
 * Startup and second-launch handoff report a bad path as a toast and continue;
 * a native modal per path would block the window and lose the good documents
 * behind it. The chain also prevents two handoffs from racing the same path
 * through "not open yet" before either has created its tab.
 */
let openPathChain: Promise<void> = Promise.resolve();
function openPaths(paths: readonly string[]): Promise<void> {
  openPathChain = openPathChain.then(async () => {
    for (const path of paths) await openPath(path, { silent: true });
  });
  return openPathChain;
}

async function loadUntitled(
  content: string,
  language: api.DocumentLanguage = "markdown",
  replace = false,
): Promise<void> {
  // CodeMirror uses LF internally; raw bundled documents can contain CRLF.
  // Their baseline must match the editor so opening Help is not an unsaved edit.
  content = content.replace(/\r\n?/g, "\n");
  const fill = replace || installingStartup;
  if (!fill) {
    snapshotDoc();
    const session = sessions.create();
    session.language = language;
    session.name = sessions.untitledName();
    session.savedContent = content;
    session.size = content.length;
    sessions.add(session);
    doc = session;
  } else {
    doc.revision += 1;
    doc.path = null;
    doc.name = "Untitled";
    doc.directory = null;
    doc.language = language;
    doc.savedContent = content;
    doc.dirty = false;
    doc.lineEnding = "\n";
    doc.hadBom = false;
    doc.lossy = false;
    doc.size = content.length;
    doc.modifiedMs = 0;
    doc.sha256 = null;
    doc.readOnly = false;
    doc.recoveryId = null;
    doc.draft = null;
    doc.conflict = null;
    doc.previewScroll = 0;
    doc.editorScroll = 0;
  }
  // The caller decides the language: a built-in document is Markdown, a new
  // document follows the default extension so its first Save As does not change
  // its meaning.
  await showInEditor(true);
}

/** Save only this session; the controller protects newer edits and recovery. */
async function writeSession(session: Session, automatic = false): Promise<boolean> {
  try {
    return await lifecycle.save(session, automatic);
  } catch (error) {
    await message(String(error), { title: "Could not save", kind: "error" });
    return false;
  }
}

function markConflict(session: Session, kind: "modified" | "deleted"): void {
  const changed = session.conflict !== kind;
  session.conflict = kind;
  if (!changed) return;
  // A conflict is more urgent than the recovery summary; do not restore the
  // old "Recovered N documents" line once it is resolved.
  recoveryNotice = null;
  if (session.id === doc.id) {
    renderNotice();
  } else {
    toast(
      `"${session.name}" ${kind === "deleted" ? "was deleted" : "changed"} on disk. Open its tab to choose.`,
      5200,
    );
  }
}

function clearConflict(session: Session): void {
  if (!session.conflict) return;
  session.conflict = null;
  if (session.id === doc.id) renderNotice();
}

/** Replace a conflicted buffer with the file, keeping one undo step. */
async function reloadConflict(session: Session): Promise<void> {
  try {
    if (await lifecycle.reload(session)) toast("Reloaded from disk");
  } catch (error) {
    await message(String(error), { title: "Could not reload", kind: "error" });
  }
}

/** Accept the current disk revision as the base for the reader's dirty text. */
async function keepMine(session: Session): Promise<void> {
  if (!session.path) return;
  try {
    await lifecycle.idle(session);
    const before = lifecycle.snapshot(session);
    const stat = await api.fingerprintDocument(session.path);
    if (!lifecycle.current(before)) return;
    if (!stat.exists) {
      markConflict(session, "deleted");
      return;
    }
    session.modifiedMs = stat.modifiedMs;
    session.size = stat.size;
    session.sha256 = stat.sha256;
    session.conflict = null;
    // The journal's base must move with the choice, or a second crash would
    // restore the old conflict and ask again.
    if (session.dirty) recovery.schedule(session, textOf(session));
    else void recovery.forget(session);
    renderNotice();
    toast("Kept your version; the next save will write it.", 4200);
  } catch (error) {
    toast(`Could not check ${session.name}: ${String(error)}`, 6200);
  }
}

/** Explicitly recreate a file the reader deleted outside MDraft. */
async function recreateDeleted(session: Session): Promise<void> {
  session.conflict = null;
  session.modifiedMs = 0;
  session.size = 0;
  session.sha256 = null;
  renderNotice();
  await saveSession(session);
}

/** Suggested sibling name for "Save a copy…" on a conflicted document. */
function conflictCopyPath(session: Session): string {
  const name = session.name;
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : "";
  const copy = `${stem} (copy)${extension}`;
  return session.directory ? joinDir(session.directory, copy) : copy;
}

async function saveConflictCopy(): Promise<void> {
  const session = doc;
  if (session.conflict) await saveAs(conflictCopyPath(session), session);
}
async function save(): Promise<boolean> {
  const ok = await saveSession(doc);
  if (ok) toast("Saved");
  return ok;
}
async function saveAs(suggestedPath?: string, session: Session = doc): Promise<boolean> {
  try {
    const ok = await lifecycle.saveAs(session, suggestedPath);
    if (ok) toast("Saved");
    return ok;
  } catch (error) {
    await message(String(error), { title: "Could not save", kind: "error" });
    return false;
  }
}
async function saveSession(session: Session): Promise<boolean> {
  return writeSession(session);
}
async function closeSession(id: string): Promise<void> {
  await closeSessions([id]);
}
async function closeSessions(ids: readonly string[]): Promise<void> {
  const wanted = new Set(ids),
    targets = sessions.list().filter((session) => wanted.has(session.id));
  if (!targets.length) return;
  try {
    await lifecycle.close(targets, async (ready) => {
      if (!ready()) return false;
      const activeRemoved = targets.some((session) => session === doc);
      const next = sessions.removeMany(targets.map((session) => session.id));
      if (!sessions.list().length) await loadUntitled("", defaultDocumentLanguage());
      else if (activeRemoved && next) {
        doc = next;
        await displayDoc();
      } else renderDocTabs();
      return true;
    });
  } catch (error) {
    await message(String(error), { title: "Could not close", kind: "error" });
  }
}

/** Reveal the file behind a tab, whether or not that tab is on screen. */
async function revealSession(id: string): Promise<void> {
  const session = sessions.byId(id);
  if (!session?.path) {
    toast("Save the document first.");
    return;
  }
  try {
    await revealItemInDir(session.path);
  } catch (error) {
    toast(String(error));
  }
}

async function reloadFromDisk(): Promise<void> {
  const session = doc;
  if (!session.path) {
    toast("This document has no file on disk yet.");
    return;
  }
  await reloadConflict(session);
}

/** Capture before any picker, tool lookup or rendering can yield to another tab. */
function exportSource() {
  return {
    text: textOf(doc),
    name: doc.name,
    path: doc.path,
    directory: doc.directory,
    language: doc.language,
    lineEnding: doc.lineEnding,
    hadBom: doc.hadBom,
    imageRoot: customImageFolder(),
  };
}

/**
 * The article the exports write, and the stylesheet it depends on.
 *
 * Each markup uses its preview pipeline: Markdown through the preview renderer,
 * AsciiDoc through Asciidoctor, Typst through its own HTML export. Typst's MathML
 * stylesheet must travel with its markup. Shared by HTML and Print exports.
 */
interface ExportArticleOptions {
  /** Folder of the file being written; null for a print document in the temp folder. */
  outputDir: string | null;
  /** Absolute file URLs and eager images, for the print copy. */
  print: boolean;
  /** The article's own theme, independent of the editor when printing. */
  theme: "light" | "dark";
}

async function buildExportArticle(
  source: ReturnType<typeof exportSource>,
  options: ExportArticleOptions,
): Promise<{ html: string; css: string }> {
  const holder = document.createElement("div");
  const themeIsDark = options.theme === "dark";
  let css = "";
  if (source.language === "asciidoc") {
    const result = await renderAsciidocPreview(source.text, {
      baseDir: source.directory ?? null,
      math: settings.enableMath,
      mermaid: settings.enableMermaid,
      isDark: themeIsDark,
    });
    holder.innerHTML = result.html;
  } else if (source.language === "typst") {
    const rendered = await api.renderTypst(source.path, source.text, "document", source.imageRoot);
    holder.innerHTML = rendered.html ?? "";
    css = rendered.css ?? "";
  } else {
    holder.innerHTML = renderPreview(source.text, {
      baseDir: source.directory ?? null,
      math: settings.enableMath,
      mermaid: settings.enableMermaid,
    }).html;
  }
  await renderMermaidIn(holder, themeIsDark);
  // Restore the destinations the preview deliberately decorated for its own
  // protocol, then make them meaningful to a browser outside the application.
  rewriteExportReferences(holder, {
    documentDir: source.directory,
    outputDir: options.outputDir,
    absolute: options.print,
  });
  // The same class the preview's Typst view uses, so the rules written for it
  // apply to the export too.
  const classes = source.language === "typst" ? "markdown-body typst-document" : "markdown-body";
  if (options.print) keepHeadingsWithNext(holder);
  return { html: `<article class="${classes}">${holder.innerHTML}</article>`, css };
}

/**
 * Group a heading with the block it introduces, so a print engine cannot leave
 * the heading alone at the foot of a page.
 *
 * `break-after: avoid` is not reliable in WebKitGTK's paged media: the heading
 * stays behind while its paragraph or diagram moves to the next page. A wrapper
 * with `break-inside: avoid` makes the pair one unbreakable block. Tables and
 * code blocks are excluded because they can legitimately be taller than a page;
 * forcing them to stay with the heading would clip them instead.
 */
function keepHeadingsWithNext(host: HTMLElement): void {
  for (const heading of Array.from(host.querySelectorAll("h1,h2,h3,h4,h5,h6"))) {
    const next = heading.nextElementSibling;
    if (!next || next.matches("h1,h2,h3,h4,h5,h6,table,pre")) continue;
    if (next.matches("ul,ol") && next.querySelectorAll("li").length > 12) continue;
    const wrapper = document.createElement("div");
    wrapper.className = "print-keep";
    heading.before(wrapper);
    wrapper.append(heading, next);
  }
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

/** The typography and shared structure an exported document must carry. */
function exportTypographyCss(): string {
  const declarations = TYPOGRAPHY_ROLES.map(
    (role) => `${role.variable}:${settings[role.id] || role.fallback}`,
  );
  declarations.push(`--body-size:${settings.bodyFontSize}px`);
  declarations.push(`--math-scale:${settings.mathFontScale / 100}`);
  // The export wrappers repeat the preview's ratios and read this variable, so
  // one stored percentage means the same size in every output. A missing
  // variable in an older export falls back to 1, its size before the setting.
  declarations.push(`--code-scale:${settings.codeFontScale / 100}`);
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
  const mathScale = ".math-inline,.math-display{font-size:calc(1em * var(--math-scale))}";
  return `:root{${declarations.join(";")}}\n${emphasis}\n${mathScale}\n${ASCIIDOC_CSS}\n${GITHUB_ALERT_CSS}`;
}

/** Basename of the open document, without its extension. */
function documentStem(name: string): string {
  return name.replace(/\.[^.]+$/, "") ?? "untitled";
}

async function exportHtml(): Promise<void> {
  const source = exportSource();
  const base = documentStem(source.name);
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
  const outputDir = directoryOf(target);

  try {
    if (source.language === "html") {
      // An HTML document is already HTML. Exporting a copy is useful; passing
      // it through the Markdown renderer would produce a different document.
      await api.writeDocument(
        target,
        source.text,
        source.lineEnding ?? "\n",
        source.hadBom ?? false,
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

    const article = await buildExportArticle(source, {
      outputDir,
      print: false,
      theme: isDark ? "dark" : "light",
    });
    const highlightStyle = document.getElementById("hljs-theme")?.textContent ?? "";
    const fontCss = await exportFontCss();
    const headExtra = [
      `<style>${fontCss}</style>`,
      `<style>${exportTypographyCss()}</style>`,
      article.css ? `<style>${article.css}</style>` : "",
      "<style>",
      highlightStyle,
      ".markdown-body{max-width:none}",
      "</style>",
      `<link rel="stylesheet" href="${KATEX_STYLESHEET_URL}">`,
    ].join("\n");

    const html = wrapStandaloneHtml(source.name ?? "Untitled", article.html, isDark, headExtra);
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
 * The article used by the native print surface, or `null` when the document
 * needs scripts the surface deliberately does not run.
 *
 * Markdown and AsciiDoc come from the same preview pipeline as the browser
 * export, with absolute image URLs because the temporary print file has a file
 * base, not the application's asset protocol. Static HTML keeps its own markup
 * and gains a base, a default A4 page rule and the readiness marker.
 */
async function nativePrintArticle(source: ReturnType<typeof exportSource>): Promise<string | null> {
  if (source.language === "html") {
    const built = await buildHtmlNativePrintDocument(source.text, source.directory ?? null);
    return built.html;
  }
  const article = await buildExportArticle(source, {
    outputDir: null,
    print: true,
    theme: "light",
  });
  const typography = article.css
    ? `${exportTypographyCss()}\n${article.css}`
    : exportTypographyCss();
  return wrapNativePrintHtml(
    source.name ?? "Untitled",
    article.html,
    highlightThemeCss(false),
    typography,
    await exportFontCss(),
  );
}

async function reportPrintWarnings(failed: string[]): Promise<void> {
  if (failed.length === 0) return;
  await message(
    `These resources did not load and may be missing from the printout:\n\n${failed.join("\n")}`,
    { title: "Printed with missing resources", kind: "warning" },
  );
}

/**
 * Export PDF through the platform webview.
 *
 * The article and the page CSS are the same ones the preview uses; only the
 * output path changes. Windows writes through WebView2's `PrintToPdf`, Linux
 * through WebKitGTK print settings. A host without either API gets the browser
 * handoff instead of a silent no-op.
 */
async function exportPdf(): Promise<void> {
  const source = exportSource();
  if (source.language === "typst") {
    await message("Typst documents write their PDF through Export › PDF (via Typst)…", {
      title: "Use the Typst PDF route",
      kind: "info",
    });
    return;
  }

  const base = documentStem(source.name);
  const suggested = settings.lastDirectory
    ? joinDir(settings.lastDirectory, `${base}.pdf`)
    : `${base}.pdf`;
  const chosen = await saveDialog({
    title: "Export as PDF",
    defaultPath: suggested,
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  });
  if (!chosen) return;
  const target = Array.isArray(chosen) ? chosen[0] : chosen;

  const notice = toast("Writing the PDF…", 0);
  try {
    const html = await nativePrintArticle(source);
    if (!html) {
      notice.dismiss();
      const useBrowser = await ask(
        "This HTML document contains scripts, so its printed result may depend on them. " +
          "The native print surface does not run document scripts.\n\n" +
          "Open the print-ready document in your browser instead?",
        { title: "Print in the browser?", kind: "warning" },
      );
      if (useBrowser) await exportPdfBrowser(source);
      return;
    }
    const result = await api.printNativePdf(html, source.name ?? "Untitled", target);
    notice.dismiss();
    toast("Exported PDF");
    await reportPrintWarnings(result.failedResources);
    const after = await api.runAfterExport(result.path ?? target);
    if (after.afterErrors.length > 0) {
      await message(after.afterErrors.join("\n\n"), {
        title: "Exported, with a problem",
        kind: "warning",
      });
    }
  } catch (error) {
    notice.dismiss();
    const useBrowser = await ask(
      `Could not write the PDF natively.\n\n${String(error)}\n\n` +
        "Open the print-ready document in your browser instead?",
      { title: "Could not export PDF", kind: "error" },
    );
    if (useBrowser) await exportPdfBrowser(source);
  }
}

/** Print the current document through the platform's native dialog. */
async function printCurrentDocument(): Promise<void> {
  const source = exportSource();
  if (source.language === "typst") {
    await message("Typst documents write their PDF through Export › PDF (via Typst)…", {
      title: "Use the Typst PDF route",
      kind: "info",
    });
    return;
  }

  const notice = toast("Preparing to print…", 0);
  try {
    const html = await nativePrintArticle(source);
    if (!html) {
      notice.dismiss();
      const useBrowser = await ask(
        "This HTML document contains scripts, so its printed result may depend on them. " +
          "The native print surface does not run document scripts.\n\n" +
          "Open the print-ready document in your browser instead?",
        { title: "Print in the browser?", kind: "warning" },
      );
      if (useBrowser) await exportPdfBrowser(source);
      return;
    }
    const result = await api.printNative(html, source.name ?? "Untitled");
    notice.dismiss();
    // The dialog is its own feedback. A cancelled dialog stays silent; loaded
    // resource failures are reported after it closes, never over it.
    if (result.status !== "cancelled" && result.failedResources.length > 0) {
      await reportPrintWarnings(result.failedResources);
    }
  } catch (error) {
    notice.dismiss();
    const useBrowser = await ask(
      `Could not open the native print dialog.\n\n${String(error)}\n\n` +
        "Open the print-ready document in your browser instead?",
      { title: "Could not print", kind: "error" },
    );
    if (useBrowser) await exportPdfBrowser(source);
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
 * This embedding's JavaScript `window.print()` does not open usable UI, so it
 * fires no dialog and produces nothing. The document carries a `window.print()`
 * of its own, so the browser opens straight onto its print preview and the user
 * only has to choose "Save as PDF".
 */
async function exportPdfBrowser(source = exportSource()): Promise<void> {
  const notice = toast("Preparing the PDF…", 0);
  try {
    if (source.language === "html") {
      // The system browser cannot reach the preview scheme, but it can read a
      // local file base. The document's own CSS and scripts stay in charge.
      const html = await buildHtmlPrintDocument(source.text, source.directory ?? null);
      const written = await api.printDocument(html, documentStem(source.name));
      notice.dismiss();
      toast("Choose “Save as PDF” in the print dialog");
      console.info(`[export] print document written to ${written}`);
      return;
    }
    const article = await buildExportArticle(source, {
      outputDir: null,
      print: true,
      theme: "light",
    });
    // The print document is always light, whatever the editor is showing: dark
    // token colours would print as pale text on white paper. Its typefaces,
    // however, are the reader's — embedded, because a browser reading a file in
    // the temporary directory cannot reach the application's assets.
    const typography = article.css
      ? `${exportTypographyCss()}\n${article.css}`
      : exportTypographyCss();
    const html = wrapPrintHtml(
      source.name ?? "Untitled",
      article.html,
      highlightThemeCss(false),
      typography,
      await exportFontCss(),
    );
    const written = await api.printDocument(html, documentStem(source.name));
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

/** Menu ids for open-tab rows; must match `menu::OPEN_TAB_PREFIX`. */
const OPEN_TAB_MENU_PREFIX = "navigate.tab:";

/** Menu ids for recent files; must match `menu::RECENT_PREFIX`. */
const RECENT_MENU_PREFIX = "recent.file:";

/**
 * The last pandoc status we looked up.
 *
 * The Preferences panel builds its rows synchronously, so it cannot await a
 * check itself. This caches the answer; the panel redraws when a check lands.
 */
let pandocCache: api.PandocStatus | null = null;

/** Typst is needed by the typeset PDF target and by `.typ` previews. */
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
  syncMenuState();
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
function exportSuggestion(format: api.ExportFormat, name: string): string {
  const base = documentStem(name);
  const filename = `${base}.${format.extension}`;
  return settings.lastDirectory ? joinDir(settings.lastDirectory, filename) : filename;
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
  const snapshot = exportSource();
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
      toast("PDF (via Typst) needs Typst — install it first.");
      await typstSetup();
      return;
    }
  }

  const chosen = await saveDialog({
    title: `Export as ${format.label}`,
    defaultPath: exportSuggestion(format, snapshot.name),
    filters: [
      { name: format.label, extensions: [format.extension] },
      { name: "All files", extensions: ["*"] },
    ],
  });
  if (!chosen) return;
  const outputPath = Array.isArray(chosen) ? chosen[0] : chosen;

  const notice = toast(`Exporting with pandoc…`, 0);
  try {
    let source = snapshot.text;
    let language: api.DocumentLanguage = snapshot.language;
    // Pandoc's AsciiDoc reader prints an unset attribute (`:toc!:`) and every
    // attribute line below it as prose, ignores `ifdef::backend-pdf[]` and does
    // not resolve `{attributes}`. Asciidoctor already resolved all of that for
    // the preview, so hand pandoc its HTML instead. An AsciiDoc target keeps
    // the original source: writing it back as AsciiDoc should not pass through
    // HTML first.
    const asciidocTarget = format.id === "asciidoc" || format.extension.toLowerCase() === "adoc";
    if (snapshot.language === "asciidoc" && !asciidocTarget) {
      source = await renderAsciidocForExport(source, {
        baseDir: snapshot.directory ?? null,
      });
      language = "html";
    }
    const outcome = await api.runExport({
      formatId: format.id,
      markdown: source,
      outputPath,
      inputPath: snapshot.path,
      // Tells the backend which reader to use, and that a Typst document exported
      // to PDF is rendered by Typst itself rather than translated through pandoc.
      language,
      imageRoot: snapshot.imageRoot,
    });
    notice.dismiss();
    toast(`Exported ${basename(outcome.outputPath)}`);

    // Pandoc can succeed and still warn, and an after-export step can fail
    // without the file being wrong. Both are worth showing, neither is an error.
    const notes = [...outcome.afterErrors];
    if (outcome.warnings) notes.push(outcome.warnings);
    if (notes.length > 0) {
      await message(notes.join("\n\n"), {
        title:
          outcome.afterErrors.length > 0 ? "Exported, with a problem" : "Exported with warnings",
        kind: outcome.afterErrors.length > 0 ? "warning" : "info",
      });
    }
  } catch (error) {
    notice.dismiss();
    await message(String(error), { title: "Could not export", kind: "error" });
  }
}

/**
 * Tools › Check or Install Pandoc….
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
    : "\nPDF engine: none — PDF (via Typst) needs Typst. Native PDF and browser printing remain available. Use Tools › Check or Install Typst….";

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
    "Pandoc was not found, so Word, EPUB, PDF (via Typst) conversion and the other Pandoc formats are unavailable. Native PDF and browser printing remain available.\n\n" +
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
          ? `PDF (via Typst) will use ${basename(installed.pdfEngine)}.`
          : "PDF (via Typst) still needs Typst — use Tools › Check or Install Typst…. Native PDF and browser printing remain available."),
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
 * Typst supplies .typ preview/compilation and the typeset PDF conversion. It is
 * a single executable — no TeX distribution, no
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
    syncMenuState();
    preferences?.refresh();
    await refreshPandocStatus();
    await syncExportAvailability();
    await message(
      `Typst ${status.version ?? "(unknown version)"} is ready.\n\n` +
        `Location: ${status.path}\n` +
        `Installed by: ${status.source === "managed" ? "MDraft" : "you (found on PATH)"}\n\n` +
        "PDF (via Typst) uses it, and .typ documents are previewed with it.",
      { title: "Typst", kind: "info" },
    );
    return;
  }

  if (!status.canInstall) {
    const open = await ask(
      `Typst was not found.\n\n${status.hint}\n\n` + "Open the official download page?",
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
    "Typst was not found, so .typ preview and PDF (via Typst) are unavailable. Native PDF and browser printing remain available for other documents.\n\n" +
      "MDraft can download the official Typst build and put it in its own data folder. " +
      "Nothing is installed system-wide, no administrator rights are needed, and removing the " +
      "folder undoes it.\n\n" +
      "The download is about 20 MB and unpacks to a single executable.",
    { title: "Install Typst", kind: "info", okLabel: "Download", cancelLabel: "Cancel" },
  );
  if (!agreed) return;

  const notice = toast("Downloading Typst…", 0);
  try {
    const installed = await api.installTypst();
    notice.dismiss();
    typstCache = installed;
    syncMenuState();
    await refreshPandocStatus();
    await syncExportAvailability();
    await message(
      `Typst ${installed.version ?? ""} is ready.\n\n${installed.path ?? ""}\n\n` +
        "PDF (via Typst) will use it, and .typ documents can now be previewed.",
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

function setHeadingCommand(level: number): void {
  if (doc.language === "html") {
    editor.wrapSelection(`<h${level}>`, `</h${level}>`, "Heading");
    return;
  }
  if (doc.language === "asciidoc") {
    editor.setAsciiDocHeading(level);
    return;
  }
  if (doc.language === "typst") {
    editor.setTypstHeading(level);
    return;
  }
  editor.setHeading(level);
}

function setParagraphCommand(): void {
  if (doc.language === "html") {
    editor.wrapSelection("<p>", "</p>", "Paragraph");
    return;
  }
  if (doc.language === "asciidoc") {
    editor.setAsciiDocHeading(0);
    return;
  }
  if (doc.language === "typst") {
    editor.setTypstHeading(0);
    return;
  }
  editor.setHeading(0);
}

function shiftHeadingCommand(delta: number): void {
  if (doc.language === "html") {
    htmlCommandNote();
    return;
  }
  if (doc.language === "asciidoc") {
    editor.shiftAsciiDocHeading(delta);
    return;
  }
  if (doc.language === "typst") {
    editor.shiftTypstHeading(delta);
    return;
  }
  editor.shiftHeading(delta);
}

function quoteCommand(): void {
  if (doc.language === "html") {
    editor.insertBlock("<blockquote>\n\n</blockquote>");
    return;
  }
  if (doc.language === "asciidoc") {
    editor.insertBlockWithCaret("____\n\n____", 5);
    return;
  }
  if (doc.language === "typst") {
    editor.insertBlockWithCaret(TYPST_QUOTE.text, TYPST_QUOTE.caret);
    return;
  }
  editor.toggleLinePrefix("> ");
}

function codeBlockCommand(): void {
  if (doc.language === "html") {
    editor.insertBlockWithCaret("<pre><code></code></pre>", 11);
    return;
  }
  if (doc.language === "asciidoc") {
    editor.insertBlockWithCaret("----\n\n----", 5);
    return;
  }
  editor.insertBlockWithCaret("```\n\n```", 4);
}

function listCommand(kind: "ul" | "ol"): void {
  if (doc.language === "html") {
    editor.insertBlock(kind === "ul" ? "<ul>\n  <li></li>\n</ul>" : "<ol>\n  <li></li>\n</ol>");
    return;
  }
  if (doc.language === "asciidoc") {
    editor.toggleLinePrefix(kind === "ul" ? "* " : ". ");
    return;
  }
  // Typst uses `+` for an ordered list, not `1.`.
  if (doc.language === "typst") {
    editor.toggleLinePrefix(kind === "ul" ? "- " : "+ ");
    return;
  }
  editor.toggleLinePrefix(kind === "ul" ? "- " : "1. ");
}

function taskCommand(state: "insert" | "done" | "todo" | "plain"): void {
  if (doc.language === "html") {
    htmlCommandNote();
    return;
  }
  if (doc.language === "asciidoc") {
    if (state === "insert") editor.toggleLinePrefix("* [ ] ");
    else editor.setAsciiDocTaskState(state);
    return;
  }
  if (doc.language === "typst") {
    toast(typstUnsupported("task"), 5200);
    return;
  }
  if (state === "insert") editor.toggleLinePrefix("- [ ] ");
  else editor.setTaskState(state);
}

function tableCommand(): void {
  if (doc.language === "html") {
    editor.insertBlock(
      "<table>\n  <thead>\n    <tr><th>Column</th><th>Column</th></tr>\n  </thead>\n  <tbody>\n    <tr><td>Cell</td><td>Cell</td></tr>\n  </tbody>\n</table>",
    );
    return;
  }
  if (doc.language === "asciidoc") {
    editor.insertBlock('[options="header"]\n|===\n| Column | Column\n\n| Cell | Cell\n|===');
    return;
  }
  if (doc.language === "typst") {
    editor.insertBlockWithCaret(TYPST_TABLE.text, TYPST_TABLE.caret);
    return;
  }
  editor.insertBlock("| Column | Column |\n| --- | --- |\n| Cell | Cell |");
}

function ruleCommand(): void {
  if (doc.language === "html") editor.insertBlock("<hr>");
  else if (doc.language === "asciidoc") editor.insertBlock("'''");
  else if (doc.language === "typst") editor.insertBlock(TYPST_RULE);
  else editor.insertBlock("---");
}

function tocCommand(): void {
  if (doc.language === "html") {
    htmlCommandNote();
    return;
  }
  if (doc.language === "asciidoc") {
    editor.insertAsciiDocToc();
    return;
  }
  if (doc.language === "typst") {
    editor.insertBlock(TYPST_OUTLINE);
    return;
  }
  editor.insertToc();
}

function frontMatterCommand(): void {
  if (doc.language === "html") {
    htmlCommandNote();
    return;
  }
  if (doc.language === "asciidoc") {
    editor.insertAsciiDocAttributes();
    toast("AsciiDoc stores the title and author as document attributes.");
    return;
  }
  if (doc.language === "typst") {
    toast(typstUnsupported("frontMatter"), 5200);
    return;
  }
  editor.insertYamlFrontMatter();
}

function alertCommand(label: string): void {
  if (doc.language === "html") {
    htmlCommandNote();
    return;
  }
  if (doc.language === "asciidoc") {
    // A titled block admonition. The paragraph form (`NOTE: …`) is valid
    // AsciiDoc, but a block renders in its own frame with a heading. The body
    // line is part of the template on purpose: a title with no content below it
    // renders as nothing at all, so the block would vanish from the preview
    // until the user typed into it.
    editor.insertBlock(`[${label}]\n.Title\nText`);
    return;
  }
  if (doc.language === "typst") {
    toast(typstUnsupported("alert"), 5200);
    return;
  }
  editor.insertBlock(`> [!${label}]\n> `);
}

function inlineCommand(kind: "bold" | "italic" | "strike" | "code" | "link" | "math"): void {
  if (doc.language === "typst") {
    const typstKind = kind === "bold" ? "strong" : kind === "italic" ? "emphasis" : kind;
    const inline = typstInline(typstKind);
    editor.wrapSelection(inline.before, inline.after, inline.placeholder);
    return;
  }
  if (doc.language === "html") {
    switch (kind) {
      case "bold":
        editor.wrapSelection("<strong>", "</strong>", "strong text");
        return;
      case "italic":
        editor.wrapSelection("<em>", "</em>", "emphasis");
        return;
      case "strike":
        editor.wrapSelection("<s>", "</s>", "strikethrough");
        return;
      case "code":
        editor.wrapSelection("<code>", "</code>", "code");
        return;
      case "link":
        editor.wrapSelection('<a href="https://">', "</a>", "link text");
        return;
      default:
        htmlCommandNote();
        return;
    }
  }
  if (doc.language === "asciidoc") {
    switch (kind) {
      case "bold":
        editor.wrapSelection("*", "*", "strong text");
        return;
      case "italic":
        editor.wrapSelection("_", "_", "emphasis");
        return;
      case "strike":
        editor.wrapSelection("[.line-through]#", "#", "strikethrough");
        return;
      case "code":
        editor.wrapSelection("`", "`", "code");
        return;
      case "link":
        editor.wrapSelection("https://[", "]", "link text");
        return;
      default:
        editor.wrapSelection("latexmath:[", "]", "e^{i\\pi}+1=0");
        return;
    }
  }
  switch (kind) {
    case "bold":
      editor.wrapSelection("**", "**", "strong text");
      return;
    case "italic":
      editor.wrapSelection("*", "*", "emphasis");
      return;
    case "strike":
      editor.wrapSelection("~~", "~~", "strikethrough");
      return;
    case "code":
      editor.wrapSelection("`", "`", "code");
      return;
    case "link":
      editor.wrapSelection("[", "](https://)", "link text");
      return;
    default:
      editor.wrapSelection("$", "$", "e^{i\\pi}+1=0");
  }
}

function imageCommand(): void {
  if (doc.language === "html") {
    editor.insertBlock('<img src="./image.png" alt="alt text">');
    return;
  }
  if (doc.language === "asciidoc") {
    editor.insertBlock("image::./image.png[alt text]");
    return;
  }
  if (doc.language === "typst") {
    editor.wrapSelection('#image("./image.png", alt: "', '")', "alt text");
    return;
  }
  editor.wrapSelection("![", "](./image.png)", "alt text");
}

function displayMathCommand(): void {
  if (doc.language === "html") {
    htmlCommandNote();
    return;
  }
  if (doc.language === "asciidoc") {
    if (editor.cursorInfo().selectionLength > 0) {
      editor.wrapSelection("[latexmath]\n++++\n", "\n++++\n", "");
    } else {
      const block = "[latexmath]\n++++\n\n++++\n";
      editor.insertBlockWithCaret(block, block.indexOf("\n\n") + 1);
    }
    return;
  }
  if (doc.language === "typst") {
    if (editor.cursorInfo().selectionLength > 0) {
      editor.wrapSelection("$ ", " $", "");
    } else {
      editor.insertBlockWithCaret(TYPST_DISPLAY_MATH.text, TYPST_DISPLAY_MATH.caret);
    }
    return;
  }
  if (editor.cursorInfo().selectionLength > 0) {
    editor.wrapSelection("$$", "$$", "");
  } else {
    editor.insertBlockWithCaret("$$\n\n$$\n", 3);
  }
}

/** Close the tabs relative to the active one, resolving the set at click time. */
function closeRelative(kind: "others" | "left" | "right" | "unchanged"): void {
  const list = sessions.list();
  const index = list.findIndex((session) => session.id === doc.id);
  if (index < 0) return;
  let ids: string[];
  if (kind === "others") {
    ids = list.filter((session) => session.id !== doc.id).map((session) => session.id);
  } else if (kind === "left") {
    ids = list.slice(0, index).map((session) => session.id);
  } else if (kind === "right") {
    ids = list.slice(index + 1).map((session) => session.id);
  } else {
    ids = list
      .filter((session) => session.id !== doc.id && !session.dirty)
      .map((session) => session.id);
  }
  if (ids.length > 0) void closeSessions(ids);
}

/** Reorder the active tab by one place, without changing which tab is active. */
function moveActiveTab(delta: number): void {
  const list = sessions.list();
  const index = list.findIndex((session) => session.id === doc.id);
  const target = index + delta;
  if (index < 0 || target < 0 || target >= list.length) return;
  sessions.move(doc.id, target);
  renderDocTabs();
}

/** The link target under the caret, falling back to the start of a selection. */
function linkUnderCaret(): LinkTarget | null {
  const selection = editor.view.state.selection.main;
  const atHead = linkAt(editor.getDoc(), selection.head, doc.language);
  if (atHead || selection.empty) return atHead;
  return linkAt(editor.getDoc(), selection.from, doc.language);
}

/** Follow the link, file, image or heading under the caret, if there is one. */
function openLinkUnderCursor(): void {
  const target = linkUnderCaret();
  if (!target) {
    toast("No link or file under the cursor.");
    return;
  }
  openLinkTarget(target);
}

/**
 * Edit › Paste without Formatting.
 *
 * The keyboard route is Chromium's own native paste, consumed by the existing
 * capture handler. A menu click has no native paste event, so this reads the
 * clipboard through the same DataTransfer the handler already understands and
 * dispatches a synthetic event. Text fields outside the editor keep their own
 * selection and receive plain text directly; a field paste must not move the
 * document caret.
 */
async function pastePlain(): Promise<void> {
  const data = await readClipboardData();
  if (!data) {
    toast("Could not read the clipboard.", 4200);
    return;
  }
  const target = document.activeElement;
  const text = data.getData("text/plain");
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    if (!text) return;
    const start = target.selectionStart ?? target.value.length;
    const end = target.selectionEnd ?? start;
    target.setRangeText(text, start, end, "end");
    target.dispatchEvent(new Event("input", { bubbles: true }));
    return;
  }
  if (target instanceof HTMLElement && target.isContentEditable) {
    if (!text) return;
    document.execCommand("insertText", false, text);
    return;
  }

  plainPastePending = true;
  editor.view.contentDOM.dispatchEvent(
    new ClipboardEvent("paste", {
      clipboardData: data,
      bubbles: true,
      cancelable: true,
    }),
  );
  window.setTimeout(() => {
    plainPastePending = false;
  }, 2000);
}

/** Apply one of the editor palettes from View › Code Colors. */
function setSyntaxTheme(id: string): void {
  applySettingsPatch({ syntaxTheme: id });
}

const handlers: Record<string, () => void | Promise<void>> = {
  "file.new": async () => {
    await loadUntitled("", defaultDocumentLanguage());
  },
  "file.open": async () => {
    const chosen = await openDialog({
      title: "Open Document",
      multiple: true,
      directory: false,
      defaultPath: settings.lastDirectory ?? undefined,
      filters: documentFilters(),
    });
    if (!chosen) return;
    const paths = Array.isArray(chosen) ? chosen : [chosen];
    for (const path of paths) await openPath(path);
  },
  "file.save": () => void save(),
  "file.saveAs": () => void saveAs(),
  "file.close": () => void closeSession(doc.id),
  "file.closeAll": () => void closeSessions(sessions.list().map((session) => session.id)),
  "file.closeOthers": () => closeRelative("others"),
  "file.closeLeft": () => closeRelative("left"),
  "file.closeRight": () => closeRelative("right"),
  "file.closeUnchanged": () => closeRelative("unchanged"),
  "file.nextTab": () => void activateSession(sessions.next().id),
  "file.prevTab": () => void activateSession(sessions.previous().id),
  "file.autoSave": () => {
    settings.autoSave = !settings.autoSave;
    applyLayout();
    persist();
    announceIfBarHidden("Auto save", settings.autoSave);
  },
  "file.reload": () => void reloadFromDisk(),
  "file.print": () => void printCurrentDocument(),
  "export.html": () => void exportHtml(),
  "export.pdf": () => void exportPdf(),
  "export.pdf.browser": () => void exportPdfBrowser(),
  "export.installPandoc": () => void pandocSetup(),
  "export.installTypst": () => void typstSetup(),
  "file.reveal": () => revealSession(doc.id),
  "file.favorite": () => {
    if (doc.path) void toggleFavoritePath(doc.path);
    else toast("Save the document first.");
  },

  "edit.find": () => editor.openSearch(false),
  "edit.replace": () => editor.openSearch(true),
  "edit.findNext": () => editor.findNext(),
  "edit.findPrevious": () => editor.findPrevious(),
  "edit.selectNext": () => editor.selectNextOccurrence(),
  "edit.selectAllOccurrences": () => editor.selectAllOccurrences(),
  "edit.pastePlain": () => void pastePlain(),
  "edit.delete": () => editor.deleteSelection(),
  "edit.uppercase": () => editor.transformSelection((text) => text.toUpperCase()),
  "edit.lowercase": () => editor.transformSelection((text) => text.toLowerCase()),
  "edit.titleCase": () => editor.transformSelection(titleCase),
  "edit.duplicateLine": () => editor.duplicateLine(),
  "edit.moveLineUp": () => editor.moveLineUp(),
  "edit.moveLineDown": () => editor.moveLineDown(),
  "edit.comment": () => editor.toggleComment(),

  "para.h1": () => setHeadingCommand(1),
  "para.h2": () => setHeadingCommand(2),
  "para.h3": () => setHeadingCommand(3),
  "para.h4": () => setHeadingCommand(4),
  "para.h5": () => setHeadingCommand(5),
  "para.h6": () => setHeadingCommand(6),
  "para.paragraph": () => setParagraphCommand(),
  "para.increaseHeading": () => shiftHeadingCommand(-1),
  "para.decreaseHeading": () => shiftHeadingCommand(1),
  "para.quote": () => quoteCommand(),
  "para.codeBlock": () => codeBlockCommand(),
  "para.mathBlock": () => displayMathCommand(),
  "para.ul": () => listCommand("ul"),
  "para.ol": () => listCommand("ol"),
  "para.task": () => taskCommand("insert"),
  "para.taskDone": () => taskCommand("done"),
  "para.taskTodo": () => taskCommand("todo"),
  "para.taskPlain": () => taskCommand("plain"),
  "para.indent": () => editor.indentLines(1),
  "para.outdent": () => editor.indentLines(-1),
  "para.insertBefore": () => editor.insertParagraphBefore(),
  "para.insertAfter": () => editor.insertParagraphAfter(),
  "para.table": () => tableCommand(),
  "para.hr": () => ruleCommand(),
  "para.toc": () => tocCommand(),
  "para.yaml": () => frontMatterCommand(),
  "para.alertNote": () => alertCommand("NOTE"),
  "para.alertTip": () => alertCommand("TIP"),
  "para.alertImportant": () => alertCommand("IMPORTANT"),
  "para.alertWarning": () => alertCommand("WARNING"),
  "para.alertCaution": () => alertCommand("CAUTION"),

  "format.bold": () => inlineCommand("bold"),
  "format.italic": () => inlineCommand("italic"),
  "format.strike": () => inlineCommand("strike"),
  "format.code": () => inlineCommand("code"),
  "format.link": () => inlineCommand("link"),
  "format.image": () => imageCommand(),
  "format.math": () => inlineCommand("math"),
  "format.displayMath": () => displayMathCommand(),
  "format.document": () => void formatSession(doc.id),

  "themes.system": () => setTheme("system"),
  "themes.light": () => setTheme("light"),
  "themes.dark": () => setTheme("dark"),
  "view.syntax.auto": () => setSyntaxTheme("auto"),
  "view.syntax.paper": () => setSyntaxTheme("paper"),
  "view.syntax.ink": () => setSyntaxTheme("ink"),
  "view.syntax.catppuccin-latte": () => setSyntaxTheme("catppuccin-latte"),
  "view.syntax.github-dark": () => setSyntaxTheme("github-dark"),
  "view.syntax.one-dark": () => setSyntaxTheme("one-dark"),
  "view.syntax.solarized-light": () => setSyntaxTheme("solarized-light"),
  "view.syntax.solarized-dark": () => setSyntaxTheme("solarized-dark"),
  "view.syntax.nord": () => setSyntaxTheme("nord"),

  "view.source": () => setViewMode("source"),
  "view.split": () => setViewMode("split"),
  "view.preview": () => setViewMode("preview"),
  "view.sidebar": () => setSidebarVisible(!settings.sidebarVisible),
  "view.outline": () => setSidebarTab("outline"),
  "view.favorites": () => setSidebarTab("favorites"),
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
  "view.typstDocument": () => chooseTypstView("document"),
  "view.typstPages": () => chooseTypstView("pages"),
  "view.foldCurrent": () => editor.foldCurrent(),
  "view.unfoldCurrent": () => editor.unfoldCurrent(),
  "view.foldAll": () => editor.foldAll(),
  "view.unfoldAll": () => editor.unfoldAll(),
  "view.typography": () => preferences.openAt("typography"),
  "view.fullscreen": async () => {
    const window = getCurrentWindow();
    const next = !(await window.isFullscreen());
    await window.setFullscreen(next);
    isFullscreen = next;
    syncMenuState();
  },
  "view.zoomIn": () => setZoom(zoomLevel() + ZOOM_STEP),
  "view.zoomOut": () => setZoom(zoomLevel() - ZOOM_STEP),
  "view.zoomReset": () => setZoom(DEFAULT_ZOOM),

  "navigate.gotoLine": () => editor.gotoLine(),
  "navigate.moveTabLeft": () => moveActiveTab(-1),
  "navigate.moveTabRight": () => moveActiveTab(1),
  "navigate.openTarget": () => openLinkUnderCursor(),

  "tools.spellcheck": () => applySettingsPatch({ spellcheck: settings.spellcheck === false }),
  "tools.spellLanguage": () => preferences.openAt("editor"),
  "tools.exportConfig": () => preferences.openAt("export"),
  "tools.pandoc": () => void pandocSetup(),
  "tools.typst": () => void typstSetup(),
  "tools.ai": () => assistant?.open(),

  "file.preferences": () => preferences.open(),

  "help.reference": () => void showBuiltin(REFERENCE),
  "help.asciidocReference": () => void showBuiltin(ASCIIDOC_REFERENCE, "asciidoc"),
  "help.typstReference": () => void showBuiltin(TYPST_REFERENCE, "typst"),
  "help.shortcuts": () => void showBuiltin(SHORTCUTS),
  "help.licences": () => void showBuiltin(FONT_LICENCES),
  "help.welcome": () => void showBuiltin(WELCOME),
  "help.installTypst": () => void typstSetup(),
  "help.pandoc": () => void pandocSetup(),
  "help.about": async () => {
    await message(
      [
        "MDraft",
        `Version ${APP_VERSION}`,
        "",
        "Live-preview editor for Markdown,\nAsciidoc, Typst and HTML",
        "",
        "Conceived by Bernhard Enders",
        "Coded by DeepSeek Flash v4.1",
        "https://github.com/bgeneto/MDraft",
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

async function showBuiltin(
  content: string,
  language: api.DocumentLanguage = "markdown",
): Promise<void> {
  await loadUntitled(content, language);
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

function setZoom(level: number): void {
  settings.zoomLevel = Math.min(
    MAX_ZOOM,
    Math.max(MIN_ZOOM, Math.round(level / ZOOM_STEP) * ZOOM_STEP),
  );
  applyLayout();
  persist();
  toast(`Zoom ${settings.zoomLevel}%`);
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
  return index >= 0 ? previewAnchors[index].el : (previewAnchors[0]?.el ?? null);
}

/** Preview block top in scroll-content coordinates, padding included. */
function previewTop(el: HTMLElement): number {
  return (
    previewPane.scrollTop + el.getBoundingClientRect().top - previewPane.getBoundingClientRect().top
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
  const blockBottom = previewPane.scrollTop + el.getBoundingClientRect().bottom - pane.top;
  const max = Math.max(0, previewPane.scrollHeight - previewPane.clientHeight);
  // The 45vh bottom padding is for reading the last block at the top, not part
  // of the document. Mapping into it would scroll the text off screen.
  return Math.max(previewScrollFor(el), Math.min(max, blockBottom - previewPane.clientHeight));
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

// ---------------------------------------------------------------------------
// Word-level sync
//
// The block anchors say *which block*; this says which characters. The map is
// built by the renderer and bound after every render, so it always describes the
// DOM that is on screen. Painting never mutates the DOM and never takes the
// selection — see docs/adr/2026-10-18-word-level-sync.md.
// ---------------------------------------------------------------------------

interface HighlightRegistryLike {
  set(name: string, highlight: unknown): void;
  delete(name: string): void;
}

let wordMap: WordMap | null = null;
let syncedSource: { from: number; to: number } | null = null;
let selectionTimer = 0;
/** The source range currently painted in the preview, and its pulse state. */
let previewSyncKey = "";
let previewPulseRanges: Range[] = [];
let previewPulseTimer = 0;
let previewPulseStep = 0;
let htmlWordsActive = false;
const PREVIEW_PULSE_BEATS = 8;
const PREVIEW_PULSE_STEP_MS = 250;
const wordMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
wordMotion.addEventListener("change", () => {
  if (wordMotion.matches && previewPulseRanges.length)
    paintPreviewWords(previewPulseRanges, previewSyncKey);
});

/** `CSS.highlights` and `Highlight`, when this webview has them. */
function highlightApi(): {
  registry: HighlightRegistryLike;
  create: new (...ranges: Range[]) => unknown;
} | null {
  const registry = (CSS as unknown as { highlights?: HighlightRegistryLike }).highlights;
  const create = (window as unknown as { Highlight?: new (...ranges: Range[]) => unknown })
    .Highlight;
  return registry && create ? { registry, create } : null;
}

function clearPreviewWords(): void {
  const api = highlightApi();
  api?.registry.delete("mdraft-sync");
  api?.registry.delete("mdraft-sync-peak");
  window.clearTimeout(previewPulseTimer);
  previewPulseTimer = 0;
  previewPulseStep = 0;
  previewPulseRanges = [];
  previewSyncKey = "";
  htmlWordsActive = false;
  htmlPreview?.clearWords();
}

/**
 * Paint the preview word, then alternate the two registered highlight names.
 *
 * The Custom Highlight API cannot be animated portably, so the pulse is a name
 * swap: eight 250 ms steps are four 500 ms beats. It ends with `mdraft-sync`
 * registered, which is the resting wash; the range itself is never removed by
 * the pulse.
 */
function paintPreviewWords(ranges: Range[], key: string): void {
  const api = highlightApi();
  if (!api) return;
  // A new range must not race the previous pulse: its closure holds the old
  // Range and would repaint it under the new name.
  window.clearTimeout(previewPulseTimer);
  previewPulseTimer = 0;
  const rest = new api.create(...ranges);
  const peak = new api.create(...ranges);
  let atPeak = false;
  previewPulseRanges = ranges;
  previewSyncKey = key;
  previewPulseStep = 0;
  api.registry.set("mdraft-sync", rest);
  api.registry.delete("mdraft-sync-peak");

  if (wordMotion.matches) return;

  const step = (): void => {
    if (previewPulseRanges.length === 0) return;
    if (wordMotion.matches) {
      api.registry.set("mdraft-sync", rest);
      api.registry.delete("mdraft-sync-peak");
      previewPulseTimer = 0;
      return;
    }
    atPeak = !atPeak;
    if (atPeak) {
      api.registry.set("mdraft-sync-peak", peak);
      api.registry.delete("mdraft-sync");
    } else {
      api.registry.set("mdraft-sync", rest);
      api.registry.delete("mdraft-sync-peak");
    }
    previewPulseStep += 1;
    if (previewPulseStep < PREVIEW_PULSE_BEATS) {
      previewPulseTimer = window.setTimeout(step, PREVIEW_PULSE_STEP_MS);
    } else {
      // End on the resting name even when the last beat was the peak.
      api.registry.set("mdraft-sync", rest);
      api.registry.delete("mdraft-sync-peak");
      previewPulseTimer = 0;
    }
  };
  previewPulseTimer = window.setTimeout(step, PREVIEW_PULSE_STEP_MS);
}

/** Rebuild the map against the DOM a render just produced. */
function bindPreviewWords(source: string, fragments?: Fragment[], blocks?: BlockRange[]): void {
  // A render replaces the nodes the old Range pointed at, so drop both the
  // highlight and the pulse before binding the new map.
  clearPreviewWords();
  const hasFragments = fragments && fragments.length > 0;
  const hasBlocks = blocks && blocks.length > 0;
  wordMap = hasFragments || hasBlocks ? bindWordMap(preview, { source, fragments, blocks }) : null;
  syncedSource = null;
}

/** Word sync needs a map, a split view and a format that can produce one. */
function wordSyncAvailable(): boolean {
  return (
    settings.viewMode === "split" &&
    (doc.language === "markdown" || doc.language === "asciidoc" || doc.language === "typst") &&
    wordMap !== null &&
    wordMap.source === editor.getDoc()
  );
}

/** The source range the current preview selection points at. */
function sourceFromPreviewSelection(): { from: number; to: number } | null {
  const map = wordMap;
  if (!map) return null;
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!preview.contains(range.commonAncestorContainer)) return null;

  const endpoints = selectionEndpoints(range);
  if (!endpoints) return null;
  const { node: startNode, offset: startOffset } = endpoints.start;
  const { node: endNode, offset: endOffset } = endpoints.end;
  const atomic = (kind: ReturnType<typeof fragmentKindFor>) => kind !== null && kind !== "text";
  const startKind = fragmentKindFor(map, startNode);
  const endKind = fragmentKindFor(map, endNode);
  const blockFallback = (node: Text): { from: number; to: number } | null => {
    const block = blockRangeForNode(map, node);
    if (!block) return null;
    return (
      snapToWords(map.source, block.src0, block.src1) ?? {
        from: block.src0,
        to: block.src1,
      }
    );
  };

  if (startNode === endNode) {
    const exact = sourceRangeFor(map, startNode, startOffset, endOffset);
    if (!exact) return blockFallback(startNode);
    // A code span or a formula is one unit; a text run is widened to words.
    if (atomic(startKind)) return exact;
    return snapToWords(map.source, exact.from, exact.to) ?? exact;
  }

  // A selection can span several nodes: a formula is several text nodes inside
  // one atomic fragment, and prose can cross inline elements.
  const startExact =
    sourceRangeFor(map, startNode, startOffset, startNode.data.length) ?? blockFallback(startNode);
  const endExact = sourceRangeFor(map, endNode, 0, endOffset) ?? blockFallback(endNode);
  if (!startExact || !endExact) return null;
  if (atomic(startKind) || atomic(endKind)) {
    return {
      from: Math.min(startExact.from, endExact.from),
      to: Math.max(startExact.to, endExact.to),
    };
  }
  const from = Math.min(startExact.from, endExact.from);
  const to = Math.max(startExact.to, endExact.to);
  return snapToWords(map.source, from, to) ?? { from, to };
}

/**
 * Preview selection -> source decoration.
 *
 * `reveal` is true only for a double-click: a drag updates continuously and must
 * never move the pane out from under the pointer.
 */
function syncSourceFromPreview(reveal: boolean): void {
  if (!wordSyncAvailable()) return;
  clearPreviewWords();
  const range = sourceFromPreviewSelection();
  if (!range) {
    syncedSource = null;
    editor.clearSyncRange();
    return;
  }
  if (syncedSource && syncedSource.from === range.from && syncedSource.to === range.to) {
    editor.setSyncRange(range.from, range.to);
    if (reveal) editor.revealOffset(range.from);
    editor.pulseSyncRange();
    return;
  }
  syncedSource = range;
  editor.setSyncRange(range.from, range.to);
  if (reveal) editor.revealOffset(range.from);
}

/**
 * Pages click/selection -> source range.
 *
 * A word-only search cannot distinguish repeated words or two columns: it finds
 * the first occurrence near the caret. The PDF line around the selection is a
 * stronger key, so the line's word sequence is mapped to its actual source
 * occurrence, and the clicked word/paragraph is then selected inside that
 * occurrence. A generated line has no match and paints nothing.
 */
function syncSourceFromPageSelection(context: TypstPageContext | null, reveal: boolean): void {
  if (
    doc.language !== "typst" ||
    settings.viewMode !== "split" ||
    typstPdfToken !== renderToken ||
    typstPdf?.source !== editor.getDoc()
  )
    return;
  clearPreviewWords();
  const source = editor.getDoc();
  const range =
    context?.sourceRange && context.paragraph
      ? paragraphRangeAt(source, context.sourceRange.from)
      : context?.sourceRange;

  if (!range || range.to <= range.from) {
    syncedSource = null;
    editor.clearSyncRange();
    return;
  }
  if (syncedSource && syncedSource.from === range.from && syncedSource.to === range.to) {
    editor.setSyncRange(range.from, range.to);
    if (reveal) editor.revealOffset(range.from);
    editor.pulseSyncRange();
    return;
  }
  syncedSource = range;
  editor.setSyncRange(range.from, range.to);
  if (reveal) editor.revealOffset(range.from);
}

/**
 * Source selection -> preview highlight.
 *
 * Only a real selection counts: expanding a collapsed caret would repaint a word
 * on every arrow key, which reads as markup the document does not have.
 */
function syncPreviewFromSource(): void {
  if (doc.language === "html") {
    const info = editor.cursorInfo();
    if (settings.viewMode === "split" && info.selectionLength > 0) {
      htmlWordsActive = htmlPreview?.highlightWords(editor.getDoc(), info.from, info.to) ?? false;
    } else {
      htmlWordsActive = false;
      htmlPreview?.clearWords();
    }
    return;
  }
  if (doc.language === "typst" && settings.typstView === "pages") {
    const info = editor.cursorInfo();
    const range = info.selectionLength ? snapToWords(editor.getDoc(), info.from, info.to) : null;
    const ranges =
      range && settings.viewMode === "split" && typstPdfToken === renderToken
        ? (typstPdf?.rangesForSource(editor.getDoc(), range.from, range.to) ?? [])
        : [];
    if (ranges.length && range) paintPreviewWords(ranges, `${range.from}:${range.to}`);
    else clearPreviewWords();
    return;
  }
  const map = wordMap;
  if (!map || !wordSyncAvailable()) {
    clearPreviewWords();
    return;
  }
  const info = editor.cursorInfo();
  if (info.selectionLength === 0) {
    clearPreviewWords();
    return;
  }
  const range = snapToWords(map.source, info.from, info.to);
  if (!range) {
    clearPreviewWords();
    return;
  }
  const api = highlightApi();
  if (!api) return;
  const key = `${range.from}:${range.to}`;
  if (key === previewSyncKey && previewPulseRanges.length > 0) {
    // A second selection of the same word replays the pulse, but a cursor
    // movement during the pulse must not restart it on every key.
    if (previewPulseTimer === 0) paintPreviewWords(previewPulseRanges, key);
    return;
  }
  const domRanges = rangesForSource(map, range.from, range.to);
  if (domRanges.length === 0) {
    clearPreviewWords();
    return;
  }
  paintPreviewWords(domRanges, key);
}

/** Restore the scroll a tab switch saved, and keep pane sync from fighting it. */
function applyPendingPreviewScroll(): void {
  if (pendingPreviewScroll === null) return;
  const top = pendingPreviewScroll;
  pendingPreviewScroll = null;
  suppressPreviewScrollUntil = performance.now() + SYNC_SUPPRESS_MS;
  if (doc.language === "html") htmlPreview.scrollTo(top);
  else previewPane.scrollTop = top;
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

// ---------------------------------------------------------------------------
// The webview's own reload keys
//
// WebView2 keeps its browser accelerator keys enabled, and F5 / Ctrl+R reload
// the page. A reload is not a window close: it throws away every open tab and
// every unsaved buffer with no prompt, because the dirty guard only runs on
// `onCloseRequested`. This application has no reload — File › Reload From Disk
// is the explicit command — so the reload family is swallowed here, before
// CodeMirror sees it. Measured: without this, F5 reset the window to the last
// saved file and the in-memory tabs were gone.
//
// The HTML guest is a separate document. A key pressed while its iframe has
// focus never reaches this listener, so `html-bridge.js` installs the same
// guard inside the guest.
// ---------------------------------------------------------------------------
function installReloadGuard(): void {
  document.addEventListener(
    "keydown",
    (event) => {
      const reload =
        event.key === "F5" ||
        ((event.ctrlKey || event.metaKey) &&
          (event.code === "KeyR" || event.key.toLowerCase() === "r"));
      if (!reload) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      toast("F5 and Ctrl+R are disabled: reloading would discard unsaved tabs.");
    },
    true,
  );
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
    syncPreviewFromSource();
    scheduleMenuStateSync();
    // A caret we just moved from the preview must not move the preview.
    if (caretCameFromPreview) return;
    if (doc.language === "html") {
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
    if (doc.language === "html") {
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
    if (doc.language === "html") {
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
    if (doc.language === "html") return;
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

  // A double-click selects a word and is a deliberate "show me this" gesture, so
  // it may reveal the source. A drag only paints: moving the pane under the
  // pointer is the bug this rule exists to prevent.
  preview.addEventListener("dblclick", () => {
    window.clearTimeout(selectionTimer);
    syncSourceFromPreview(true);
  });

  // A drag inside the preview paints the source once it settles.
  document.addEventListener("selectionchange", () => {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return;
    if (!preview.contains(selection.anchorNode)) return;
    window.clearTimeout(selectionTimer);
    selectionTimer = window.setTimeout(() => syncSourceFromPreview(false), WORD_SYNC_DEBOUNCE_MS);
  });

  // Escape clears both surfaces. It neither collapses the selection nor moves
  // anything else: the highlight is the only thing the reader is dismissing.
  document.addEventListener(
    "keydown",
    (event) => {
      if (event.key !== "Escape") return;
      const dismissing = syncedSource !== null || previewPulseRanges.length > 0 || htmlWordsActive;
      const target = event.target;
      // CodeMirror's Escape keymap simplifies a selection and consumes the key.
      // Dismiss correspondence first while preserving the user's selection;
      // dialogs and unrelated Escape gestures keep their normal handlers.
      if (
        dismissing &&
        target instanceof Node &&
        (editorPane.contains(target) || previewPane.contains(target))
      ) {
        event.preventDefault();
      }
      window.clearTimeout(selectionTimer);
      syncedSource = null;
      editor.clearSyncRange();
      clearPreviewWords();
    },
    true,
  );

  // Scrolling the preview -> the source follows the same fraction of the block
  // under the sync line. The scrolling element is the pane, not the rendered
  // document inside it. The HTML guest scrolls internally and reports through
  // the bridge instead.
  previewPane.addEventListener("scroll", () => {
    if (doc.language === "html") return;
    if (!settings.syncScroll || settings.viewMode !== "split") return;
    if (performance.now() < suppressPreviewScrollUntil) return;
    alignEditorToScroll();
  });
}

// ---------------------------------------------------------------------------
// Preview link handling
// ---------------------------------------------------------------------------

/**
 * Copy the source of the AsciiDoc blocks a preview selection touches.
 *
 * A prose destination receives AsciiDoc (`image::` macros included); a word
 * processor still receives the selection's HTML. `data-line` / `data-line-end`
 * are what make the source range known; without them the browser's own copy is
 * left alone.
 */
function installPreviewCopy(): void {
  preview.addEventListener("copy", (event) => {
    if (doc.language !== "asciidoc") return;
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return;
    const range = selection.getRangeAt(0);
    if (!preview.contains(range.commonAncestorContainer)) return;

    const elements = Array.from(preview.querySelectorAll<HTMLElement>("[data-line]"));
    const intersecting = elements.filter((element) => range.intersectsNode(element));
    if (intersecting.length === 0) return;

    // A section and its paragraph both carry a line. When both are selected,
    // the paragraph is what the reader pointed at; keeping the section too
    // would copy the whole chapter for a sentence.
    const selected = new Set(intersecting);
    const blocks = intersecting.filter(
      (element) =>
        !Array.from(element.querySelectorAll<HTMLElement>("[data-line]")).some((child) =>
          selected.has(child),
        ),
    );

    const ranges: Array<[number, number]> = [];
    for (const element of blocks) {
      const start = Number(element.dataset.line);
      const end = Number(element.dataset.lineEnd ?? element.dataset.line);
      if (!Number.isFinite(start)) continue;
      ranges.push([Math.min(start, end), Math.max(start, end)]);
    }
    if (ranges.length === 0) return;
    ranges.sort((a, b) => a[0] - b[0]);
    const merged: Array<[number, number]> = [];
    for (const rangeLines of ranges) {
      const last = merged[merged.length - 1];
      if (last && rangeLines[0] <= last[1] + 1) last[1] = Math.max(last[1], rangeLines[1]);
      else merged.push([...rangeLines]);
    }

    const source = editor.getDoc().split("\n");
    const text = merged
      .map(([start, end]) =>
        source.slice(Math.max(0, start - 1), Math.min(source.length, end)).join("\n"),
      )
      .join("\n\n");
    if (!text.trim()) return;
    const clipboard = event.clipboardData;
    if (!clipboard) return;

    const holder = document.createElement("div");
    holder.appendChild(range.cloneContents());
    clipboard.setData("text/plain", text);
    clipboard.setData("text/html", holder.innerHTML);
    event.preventDefault();
  });
}

/** Decode a document reference into a filesystem path. */
function decodeLinkPath(href: string): string {
  let value = href;
  try {
    value = decodeURI(value);
  } catch {
    /* keep the raw value */
  }
  if (/^file:\/\//i.test(href)) {
    try {
      const url = new URL(href);
      const path = decodeURIComponent(url.pathname);
      value = url.host ? `//${url.host}${path}` : path;
    } catch {
      value = href.replace(/^file:\/\//i, "");
    }
  }
  if (/^\/[A-Za-z]:/.test(value)) value = value.slice(1);
  return value;
}

function isAbsoluteLinkPath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\") || value.startsWith("/");
}

/** Extensions this editor opens in a tab; everything else goes to the OS. */
function editableDocument(path: string): boolean {
  return /\.(?:md|markdown|mkd|typ|adoc|asciidoc|html?)$/i.test(path.split(/[?#]/)[0]);
}

/** Scroll the preview to an id, waiting briefly for a fresh render. */
function revealPreviewId(id: string, attempt = 0): void {
  const node = preview.querySelector(`[id="${CSS.escape(id)}"]`);
  if (node) {
    node.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }
  if (attempt < 20) window.setTimeout(() => revealPreviewId(id, attempt + 1), 50);
}

/**
 * Follow one link or image reference.
 *
 * URLs go to the browser, `#id` scrolls the view, an editable document opens in
 * a tab, and anything else is handed to the OS. A relative path needs a saved
 * document; an untitled buffer says so instead of guessing a directory.
 */
function openLinkTarget(target: LinkTarget): void {
  const href = target.href;
  if (target.kind === "external") {
    if (/^(?:javascript|data|blob):/i.test(href)) return;
    void openUrl(href).catch((error) => toast(String(error)));
    return;
  }
  if (target.kind === "anchor") {
    const id = href.replace(/^#/, "");
    if (!id) return;
    if (doc.language === "html" && htmlPreview) htmlPreview.scrollToId(id);
    else revealPreviewId(id);
    return;
  }

  const hash = href.indexOf("#");
  const fragment = hash >= 0 ? href.slice(hash + 1) : "";
  const clean = (hash >= 0 ? href.slice(0, hash) : href).split("?")[0];
  let path = decodeLinkPath(clean);
  if (!path) return;
  if (!isAbsoluteLinkPath(path)) {
    if (!doc.directory) {
      toast("Save this document first so a relative link can be resolved.", 5200);
      return;
    }
    path = joinDir(doc.directory, path);
  }

  if (editableDocument(path)) {
    void openPath(path).then(() => {
      if (!fragment) return;
      if (doc.language === "html" && htmlPreview) htmlPreview.scrollToId(fragment);
      else revealPreviewId(fragment);
    });
    return;
  }
  void api.openExternal(path).catch((error) => toast(String(error), 5200));
}

function installPreviewClicks(): void {
  preview.addEventListener("click", (event) => {
    const element = event.target as HTMLElement;
    const image = element.closest("img");
    if (image && (event.ctrlKey || event.metaKey)) {
      const raw = image.getAttribute("data-src") ?? "";
      if (!raw) return;
      event.preventDefault();
      event.stopPropagation();
      openLinkTarget({
        href: raw,
        kind: /^(?:https?|mailto|tel):/i.test(raw) ? "external" : "image",
      });
      return;
    }

    const target = element.closest("a, .local-link, .external-link");
    if (!target) return;
    const href = target.getAttribute("data-href") ?? "";
    if (!href) return;

    event.preventDefault();
    event.stopPropagation();
    openLinkTarget({
      href,
      kind: href.startsWith("#")
        ? "anchor"
        : /^(?:https?|mailto|tel):/i.test(href)
          ? "external"
          : "file",
    });
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
  if (lifecycle.committing || document.querySelector(".unsaved-dialog[open]")) return;
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

  // The Open Tabs rows carry the session id rather than a position: the list
  // can change while the menu is open, and the click must focus the document it
  // named, not whichever tab now occupies that place.
  if (id.startsWith(OPEN_TAB_MENU_PREFIX)) {
    const sessionId = id.slice(OPEN_TAB_MENU_PREFIX.length);
    if (sessionId && sessions.byId(sessionId)) void activateSession(sessionId);
    return;
  }

  // The Open Recent rows are generated from the persisted list, so their ids
  // carry the path rather than an index: a list change between the menu being
  // built and the row being clicked cannot open the wrong document.
  if (id.startsWith(RECENT_MENU_PREFIX)) {
    const path = id.slice(RECENT_MENU_PREFIX.length);
    if (path) void openPath(path);
    return;
  }
  if (id === "recent.clear") {
    clearRecentFiles();
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
  // `event.key` for the space bar is a single space; accelerators spell it
  // "Space", so the literal would never match.
  if (event.key === " ") names.add("SPACE");
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

  // Windows can consume Ctrl+Shift+0 as an input-language shortcut before the
  // webview sees it. Advertise Ctrl+Alt+0 (Ctrl+0 is Normal Paragraph), while
  // accepting the old chord on systems that still deliver it.
  if (shortcuts.some((entry) => entry.id === "view.zoomReset")) {
    const legacy = parseAccelerator("view.zoomReset", "CmdOrCtrl+Shift+0");
    if (legacy) parsed.push(legacy);
  }

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
  if (doc.language !== "html" || !Number.isFinite(line)) return;
  suppressEditorScrollUntil = performance.now() + SYNC_SUPPRESS_MS;
  caretCameFromPreview = true;
  try {
    editor.revealLine(line, true, false);
  } finally {
    caretCameFromPreview = false;
  }
  htmlPreview.blink(line);
}

/**
 * A guest double-click or drag -> the source mark.
 *
 * The guest reports a text-node index, never a source offset. The host checks
 * the selected sample against the table built with the preview and paints
 * nothing when it has drifted; the line reveal already happened on mousedown.
 */
function handleHtmlSelection(selection: HtmlSelection): void {
  if (doc.language !== "html" || !htmlPreview) return;
  if (settings.viewMode !== "split" || htmlPreview.source() !== editor.getDoc()) return;
  clearPreviewWords();
  const range = htmlPreview.wordRange(selection);
  if (!range) {
    syncedSource = null;
    editor.clearSyncRange();
    return;
  }
  if (syncedSource && syncedSource.from === range.from && syncedSource.to === range.to) {
    editor.setSyncRange(range.from, range.to);
    editor.pulseSyncRange();
    if (selection.reveal) editor.revealOffset(range.from);
    return;
  }
  syncedSource = range;
  editor.setSyncRange(range.from, range.to);
  if (selection.reveal) editor.revealOffset(range.from);
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
  const directory = doc.directory;
  if (!directory) return null;
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  if (!["html", "htm", "md", "markdown", "mkd", "typ"].includes(extension)) return null;
  return joinDir(directory, path);
}

function handleHtmlLink(href: string, raw?: string): void {
  if (/^(https?:|mailto:|tel:)/i.test(href)) {
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

  // Prefer the document's own attribute. The guest's resolved URL has already
  // collapsed `../` into its own root, so `../other.md` would point at the wrong
  // file; the raw value is what the author wrote.
  if (raw && doc.directory && !/^[a-z][a-z0-9+.-]*:/i.test(raw)) {
    const clean = raw.split("#")[0].split("?")[0];
    let path = decodeLinkPath(clean);
    if (!isAbsoluteLinkPath(path)) path = joinDir(doc.directory, path);
    if (editableDocument(path)) {
      void openPath(path);
      return;
    }
    void api.openExternal(path).catch((error) => toast(String(error), 5200));
    return;
  }

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
  if (doc.language !== "html") return;
  syncedSource = null;
  editor.clearSyncRange();
  syncPreviewFromSource();
  if (pendingPreviewScroll !== null) {
    htmlRestoreLine = null;
    applyPendingPreviewScroll();
    updateActiveOutline();
    return;
  }
  const line = htmlRestoreLine ?? editor.cursorInfo().line;
  htmlRestoreLine = null;
  if (layout.anchors.length >= 2) {
    suppressPreviewScrollUntil = performance.now() + SYNC_SUPPRESS_MS;
    htmlPreview.scrollToLine(line);
  }
  updateActiveOutline();
}

function handleHtmlScroll(layout: HtmlLayout): void {
  htmlScrollTop = layout.top;
  if (doc.language !== "html") return;
  if (performance.now() < suppressPreviewScrollUntil) return;
  syncHtmlToEditor(layout);
}

async function installDragDrop(): Promise<void> {
  const win = getCurrentWindow();
  await win.onDragDropEvent(async (event) => {
    if (event.payload.type !== "drop" || event.payload.paths.length === 0) return;
    // Images are imported; anything else is opened as a document.
    const remaining = await handleImageDrop(event.payload.paths, imageContext());
    for (const path of remaining) await openPath(path);
  });
}

/** How often the open tabs are checked against what was last written. */
const TAB_MEMORY_INTERVAL_MS = 1500;

/** The remembered-tab payload for the sessions that are open now. */
function rememberedTabsNow(): RememberedTabs {
  return rememberTabs(sessions.list(), doc.id);
}

/**
 * Keep `lastTabs`/`lastActiveTab` in sync with the open tabs.
 *
 * A 1.5 s check rather than a hook on every tab gesture: the set changes rarely,
 * and the signature compare means the settings file is rewritten only when it
 * actually differs — not on every caret move, and not on every auto-save tick.
 * The close handler flushes the same signature, so a tab touched inside the
 * last interval still survives the exit.
 */
function installTabMemory(): void {
  lastTabsSignature = JSON.stringify(rememberedTabsNow());
  window.setInterval(() => {
    const remembered = rememberedTabsNow();
    const signature = JSON.stringify(remembered);
    if (signature === lastTabsSignature) return;
    lastTabsSignature = signature;
    settings = { ...settings, lastTabs: remembered.tabs, lastActiveTab: remembered.active };
    persist();
  }, TAB_MEMORY_INTERVAL_MS);
}

/**
 * Write the remembered tab list before the window goes.
 *
 * The wait is bounded: a wedged IPC or a full disk must not keep the window
 * open. When the write does not fit in the budget the interval has already
 * written the previous state, which is a stale tab list rather than a hung
 * close.
 */
async function flushRememberedTabs(): Promise<void> {
  const remembered = rememberedTabsNow();
  const signature = JSON.stringify(remembered);
  if (signature !== lastTabsSignature) {
    lastTabsSignature = signature;
    void queueSettings(async () => {
      settings = { ...settings, lastTabs: remembered.tabs, lastActiveTab: remembered.active };
      await api.saveSettings(settings);
    }).catch(() => undefined);
  }
  // A barrier, not a write: every queued save — including a favorite command
  // still in flight — has to settle before the window goes. The wait is
  // bounded, as the write itself was: a wedged IPC must not hang the close.
  await Promise.race([settingsQueue, new Promise((resolve) => window.setTimeout(resolve, 750))]);
}

async function installCloseGuard(): Promise<void> {
  const win = getCurrentWindow();
  await win.onCloseRequested(async (event) => {
    if (allowClose) return;
    event.preventDefault();
    const pendingDialog = document.querySelector<HTMLDialogElement>(".unsaved-dialog[open]");
    if (pendingDialog) {
      pendingDialog.close();
      return;
    }
    try {
      stopReadAloud();
      await lifecycle.close(
        [...sessions.list()],
        async (ready) => {
          await flushRememberedTabs();
          if (!ready()) return false;
          allowClose = true;
          try {
            void api.aiCancelAll().catch(() => undefined);
            await win.close();
          } catch (error) {
            allowClose = false;
            throw error;
          }
          return true;
        },
        true,
      );
    } catch (error) {
      await message(String(error), { title: "Could not close", kind: "error" });
    }
  });
}
function installDiskWatcher(): void {
  window.setInterval(() => {
    void reloadChangedSessions();
  }, 2500);
}
async function reloadChangedSessions(): Promise<void> {
  await lifecycle.poll();
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
// Read aloud
// ---------------------------------------------------------------------------

let readAloud: ReadAloudHandle | null = null;

/**
 * Blocks that are not prose.
 *
 * KaTeX draws a hidden MathML copy beside the visual one, so a formula would be
 * spoken twice and as symbols; a Mermaid block would read its node labels; and a
 * code fence read character by character is noise, not a sentence.
 */
const SILENT_IN_PREVIEW = ".katex, .mermaid, pre";

function blockText(block: HTMLElement): string {
  const clone = block.cloneNode(true) as HTMLElement;
  for (const node of clone.querySelectorAll(SILENT_IN_PREVIEW)) node.remove();
  return (clone.textContent ?? "").replace(/\s+/g, " ").trim();
}

/** Why no reading can start for the document on screen, or null. */
function readAloudBlockedReason(): string | null {
  if (!readAloud) return "The editor is still loading.";
  // The HTML tab renders into an opaque-origin iframe: its text is not the
  // parent document's to read, so there is nothing to speak.
  if (doc.language === "html") return "The HTML preview cannot be read aloud.";
  const reason = readAloud.availableReason();
  if (reason) return reason;
  if ((preview.textContent ?? "").trim() === "") return "There is nothing to read.";
  return null;
}

/** Source positions exist only in the renderers that emit `data-line`. */
function readAloudFromHereBlockedReason(): string | null {
  return previewAnchors.length === 0 ? "This preview has no source positions." : null;
}

function readingMenuState(): ReadingMenuState {
  const blocked = readAloudBlockedReason();
  return {
    blocked,
    fromHereBlocked: blocked ? null : readAloudFromHereBlockedReason(),
    active: readAloud?.isActive() ?? false,
  };
}

/** The text to speak: the preview's prose, block by block. */
function previewReadAloudText(fromStart: boolean): string {
  if (previewAnchors.length === 0) return blockText(preview);
  const start = fromStart ? 0 : Math.max(0, anchorIndexForLine(editor.cursorInfo().line));
  return previewAnchors
    .slice(start)
    .map((anchor) => blockText(anchor.el))
    .filter(Boolean)
    .join("\n\n");
}

function startReadAloud(fromStart: boolean): void {
  const reason = readAloudBlockedReason();
  if (reason) {
    toast(reason, 4200);
    return;
  }
  if (!readAloud?.start(previewReadAloudText(fromStart))) {
    toast("There is nothing to read.", 4200);
  }
}

function stopReadAloud(): void {
  readAloud?.stop();
}

function renderReadingChip(state: ReadingState): void {
  statusReading.hidden = !state.active;
  if (!state.active) {
    statusReading.textContent = "";
    statusReading.title = "";
    return;
  }
  statusReading.textContent = `Reading ${Math.min(state.index + 1, state.total)}/${state.total}`;
  statusReading.title = `Reading aloud with ${state.voice || "the system voice"} — click to stop.`;
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Image paste and drop
// ---------------------------------------------------------------------------

function imageContext(hasSelection = false): ImageContext {
  const language = doc.language;
  return {
    // A relative image path is the only kind the HTML guest and the Typst
    // compiler can reach from the document's own folder.
    settings: needsRelativePath(language) ? { ...settings, imageUseRelativePath: true } : settings,
    language,
    documentPath: doc.path,
    hasSelection,
    insert: (text) => editor.insertBlock(text),
    imageSyntax: (alt, src) => imageSyntaxFor(language, alt, src),
    notify: (text, isError = false) => toast(text, isError ? 5200 : 3200),
  };
}

let plainPastePending = false;
let pasteNoticeKey = "";

function altFromPath(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? "image";
  return name.replace(/\.[^.]+$/, "");
}

/** The options for an image found inside a pasted fragment. */
function richImageOptions(language: api.DocumentLanguage): api.ImageOptions {
  const options = imageOptions(settings);
  if (needsRelativePath(language)) options.relative = true;
  return options;
}

const KEEP_ORIGINAL_RICH = "The image keeps its original address (Preferences › Image).";

/** The configured custom image folder, made absolute, or null. */
function customImageFolder(): string | null {
  if (settings.imageRule !== "custom") return null;
  const dir = settings.imageCustomDir?.trim();
  if (!dir) return null;
  if (/^[A-Za-z]:[\\/]/.test(dir) || dir.startsWith("\\\\") || dir.startsWith("/")) return dir;
  return doc.directory ? joinDir(doc.directory, dir) : null;
}

async function resolveRichImage(
  image: ImageRequest,
  language: api.DocumentLanguage,
  report: (note: string) => void,
): Promise<ResolvedImage | null> {
  const remote = /^https?:/i.test(image.src);
  if (remote && settings.richPasteImages === "url") return null;
  const options = richImageOptions(language);
  const destination = hasImageDestination(
    language,
    doc.path,
    options.rule,
    settings.imageCustomDir,
  );
  const keeping = options.rule === "keepOriginal";

  /** Keep the address as it is, saying why when it cannot render. */
  const keep = (why: string): null => {
    report(typstImageProblem(language, image.src, doc.path) ?? why);
    return null;
  };

  if (/^data:/i.test(image.src)) {
    if (keeping) return keep(KEEP_ORIGINAL_RICH);
    if (!destination) return keep(NO_FOLDER_KEPT);
    const saved = await api.saveClipboardImage(image.src, null, doc.path, options);
    const problem = typstImageProblem(language, saved.markdownPath, doc.path);
    if (problem) {
      report(`${problem} Saved to ${saved.markdownPath}.`);
      return null;
    }
    return { src: saved.markdownPath, alt: image.alt || altFromPath(saved.markdownPath) };
  }

  if (remote) {
    if (keeping) return keep(KEEP_ORIGINAL_RICH);
    if (!destination) return keep(NO_FOLDER_KEPT);
    const saved = await api.downloadImage(image.src, doc.path, options, 8000);
    const problem = typstImageProblem(language, saved.markdownPath, doc.path);
    if (problem) {
      report(`${problem} Saved to ${saved.markdownPath}.`);
      return null;
    }
    return { src: saved.markdownPath, alt: image.alt || altFromPath(saved.markdownPath) };
  }

  if (!settings.imageApplyLocal) return null;
  if (!/^(?:[A-Za-z]:[\\/]|\/|file:)/i.test(image.src)) return null;
  const local = image.src.replace(/^file:\/\//i, "");
  const exists = await api.pathExists(local, doc.path).catch(() => false);
  if (!exists) return null;

  if (keeping) {
    // No copy, but the backend may turn an absolute path inside the document's
    // folder into the relative form Typst can read.
    const saved = await api.importImage(local, doc.path, options);
    const problem = typstImageProblem(language, saved.markdownPath, doc.path);
    if (problem) {
      report(problem);
      return null;
    }
    return { src: saved.markdownPath, alt: image.alt || altFromPath(saved.markdownPath) };
  }
  if (!destination) return keep(NO_FOLDER_KEPT);

  const saved = await api.importImage(local, doc.path, options);
  const problem = typstImageProblem(language, saved.markdownPath, doc.path);
  if (problem) {
    report(`${problem} Saved to ${saved.markdownPath}.`);
    return null;
  }
  return { src: saved.markdownPath, alt: image.alt || altFromPath(saved.markdownPath) };
}

function languageLabel(language: api.DocumentLanguage): string {
  return language === "typst"
    ? "Typst"
    : language === "html"
      ? "HTML"
      : language === "asciidoc"
        ? "AsciiDoc"
        : "Markdown";
}

async function applyRichPaste(
  payload: ClipboardPayload,
  destination: PasteDestination,
): Promise<void> {
  const result = await planPaste(payload, destination.language, {
    resolveImage: (image, report) => resolveRichImage(image, destination.language, report),
  });
  if (!result) return;
  if (
    destination.language === "markdown" &&
    (result.source === "markdown" || result.source === "plain")
  )
    editor.insertNativeText(result.text);
  else editor.insertPasted(result.text, result.block);

  if (destination.detected && result.converted) {
    const key = `${doc.id}:${destination.language}`;
    if (key !== pasteNoticeKey) {
      pasteNoticeKey = key;
      const extension =
        destination.language === "typst"
          ? "typ"
          : destination.language === "html"
            ? "html"
            : destination.language === "asciidoc"
              ? "adoc"
              : "md";
      toast(
        `Pasted as ${languageLabel(destination.language)}. Save this document as .${extension} to switch the editor.`,
        6200,
      );
      return;
    }
  }
  if (result.notices.length > 0) toast(result.notices[0], 5200);
}

/**
 * Paste listeners run in the capture phase so the event can be consumed before
 * CodeMirror or the browser turns it into text.
 */
function installPasteHandlers(): void {
  // Ctrl/Cmd+Shift+V asks the platform for a plain paste. Do not prevent the
  // keydown: Chromium handles it and starts its own paste event, which the
  // handler below lets through untouched.
  window.addEventListener(
    "keydown",
    (event) => {
      if (!(event.ctrlKey || event.metaKey) || !event.shiftKey || event.altKey) return;
      if (event.code !== "KeyV") return;
      const target = event.target as Node | null;
      if (!target || (!editor.view.contentDOM.contains(target) && !previewPane.contains(target)))
        return;
      plainPastePending = true;
      window.setTimeout(() => {
        plainPastePending = false;
      }, 2000);
    },
    true,
  );

  const handler = (event: ClipboardEvent) => {
    const plainPaste = plainPastePending;
    plainPastePending = false;
    // A paste over the preview targets the block under the pointer: move the
    // caret there first so the content lands where the user aimed.
    const target = event.target as Node | null;
    const element = target as HTMLElement | null;
    const anchor = element?.closest?.<HTMLElement>("[data-line]");
    if (anchor) {
      const line = Number(anchor.dataset.line);
      if (Number.isFinite(line)) editor.revealLine(line, true, false);
    }

    // Only an editor selection is a text selection. A paste over the preview
    // has already moved the caret to the block under the pointer.
    const inEditor = target !== null && editor.view.contentDOM.contains(target);
    const hasSelection = inEditor && editor.cursorInfo().selectionLength > 0;

    // The decision and preventDefault must happen in this same turn; deferring
    // them to a promise lets the browser insert the pasted text as well.
    if (handleImagePaste(event, imageContext(hasSelection))) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (plainPaste) return;
    if (!settings.richPaste) return;
    if (editor.inCodeContext()) return;

    const clipboard = event.clipboardData;
    if (!clipboard) return;
    const payload: ClipboardPayload = {
      html: clipboard.getData("text/html") || null,
      markdown: clipboard.getData("text/markdown") || clipboard.getData("text/x-markdown") || null,
      text: clipboard.getData("text/plain") || null,
    };
    if (!payload.html && !payload.markdown && !payload.text) return;

    const destination = resolvePasteDestination({
      saved: doc.path !== null,
      language: doc.language,
      buffer: editor.getDoc(),
    });
    const choice = chooseSource(payload, destination.language);
    // Plain text, or text already in the destination's own syntax, is exactly
    // what CodeMirror's own paste does; do not interfere with it.
    if (choice.native || choice.source === "plain") {
      if (destination.language === "markdown" && payload.text?.includes("$"))
        editor.prepareNativePaste(escapeMarkdownCurrency);
      return;
    }
    if (
      destination.language === "markdown" &&
      !markdownProseSelection(editor.getDoc(), editor.view.state.selection.ranges)
    )
      return;

    event.preventDefault();
    event.stopPropagation();
    void applyRichPaste(payload, destination).catch((error) => {
      console.warn(`[paste] ${String(error)}`);
      toast(`Paste failed: ${String(error)}`, 5200);
    });
  };

  // Find/Replace and other editor panels own their native paste. Only document
  // content may reach rich-text conversion or image import and change the file.
  editor.view.contentDOM.addEventListener("paste", handler, { capture: true });
  previewPane.addEventListener("paste", handler, { capture: true });
}

function installChrome(): void {
  el<HTMLButtonElement>("tab-outline").addEventListener("click", () => setSidebarTab("outline"));
  el<HTMLButtonElement>("tab-favorites").addEventListener("click", () =>
    setSidebarTab("favorites"),
  );
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
  statusZoom.addEventListener("click", () => setZoom(DEFAULT_ZOOM));
  statusReading.addEventListener("click", stopReadAloud);

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

  // Spelling has no menu item to route through, so the flag writes the setting
  // directly; `applyLayout` is what redraws it and reinstalls the extension.
  el<HTMLButtonElement>("flag-spellcheck").addEventListener("click", () =>
    applySettingsPatch({ spellcheck: settings.spellcheck === false }),
  );
}

/**
 * Carry a reader who chose the old "System only" preset onto the new "System".
 *
 * A preset is written into settings when it is picked, so the old values survive
 * in `settings.json`. The preset used to name Georgia for prose; it is now the
 * system stack, and without this pass the reader would open the new version on
 * "Custom" showing the very face the rename was meant to remove.
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

function recoveryLanguage(value: string): api.DocumentLanguage {
  switch (value) {
    case "typst":
    case "html":
    case "asciidoc":
      return value;
    default:
      return "markdown";
  }
}

function directoryOf(path: string): string {
  const cut = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return cut > 0 ? path.slice(0, cut) : "";
}

/**
 * Bring back the buffers the journal holds after a crash or a forced kill.
 *
 * Runs after the normal startup choice, so a remembered tab set is already on
 * screen and a recovered path can overlay its draft instead of being opened
 * twice. A journal entry is removed only when its content is already on disk,
 * or when the reader saves/discards the restored tab; a failed restore keeps
 * the entry for the next launch.
 */
async function restoreRecovery(): Promise<void> {
  let entries: api.RecoveryEntry[];
  try {
    entries = await api.listRecovery();
  } catch (error) {
    console.warn(`[recovery] could not read the journal: ${error}`);
    return;
  }
  if (entries.length === 0) return;
  entries.sort((a, b) => b.updatedMs - a.updatedMs);

  const recovered: Session[] = [];
  for (const entry of entries) {
    const existing = entry.path ? sessions.findByPath(entry.path) : undefined;
    if (existing) {
      if (existing.dirty) continue;
      if (existing.savedContent === entry.content) {
        void api.removeRecovery(entry.id).catch(() => {});
        continue;
      }
      existing.revision += 1;
      existing.lossy = existing.lossy || entry.lossy;
      existing.draft = entry.content;
      existing.editorState = null;
      existing.recoveryId = entry.id;
      // Keep the base the journal recorded: if the file moved while MDraft was
      // closed, the conflict guard must notice before the first save.
      existing.modifiedMs = entry.baseModifiedMs;
      existing.size = entry.baseSize;
      // Older journals have no hash. Keep null rather than adopting the
      // current disk revision: the stat guard must still see a file that
      // moved while MDraft was closed.
      existing.sha256 = entry.baseSha256 ?? null;
      existing.dirty = true;
      existing.conflict = null;
      recovered.push(existing);
      continue;
    }

    let base: api.DocumentPayload | null = null;
    if (entry.path) {
      base = await api.readDocument(entry.path).catch(() => null);
    }
    if (base && base.content === entry.content) {
      // The file was written before the crash; nothing is unsaved.
      void api.removeRecovery(entry.id).catch(() => {});
      continue;
    }

    const session = sessions.create();
    session.recoveryId = entry.id;
    session.path = entry.path;
    session.name =
      base?.name ?? (entry.path ? entry.name || basename(entry.path) : sessions.untitledName());
    session.directory = base?.directory ?? (entry.path ? directoryOf(entry.path) : null);
    session.language = base ? languageFor(base.path) : recoveryLanguage(entry.language);
    session.savedContent = base?.content ?? "";
    session.draft = entry.content;
    session.dirty = entry.content !== session.savedContent;
    session.lineEnding = base?.lineEnding ?? (entry.lineEnding === "\r\n" ? "\r\n" : "\n");
    session.hadBom = base?.hadBom ?? entry.hadBom;
    session.lossy = (base?.lossy ?? false) || entry.lossy;
    session.readOnly = base?.readOnly ?? entry.readOnly;
    // The journal's base, not the file's current stat: the disk poll compares
    // against it and raises the conflict before an overwrite.
    session.modifiedMs = entry.baseModifiedMs;
    session.size = entry.baseSize;
    session.sha256 = entry.baseSha256 ?? null;
    session.conflict = null;
    sessions.add(session);
    // `add` inserts after the active tab. Recovered tabs belong at the end so
    // a remembered set keeps its order and the recovery does not land in the
    // middle of it.
    sessions.move(session.id, sessions.list().length - 1);
    recovered.push(session);
  }

  if (recovered.length === 0) return;
  const first = recovered[0];
  if (first.id === doc.id) await displayDoc();
  else await activateSession(first.id);
  recoveryNotice = `Recovered ${recovered.length} unsaved ${
    recovered.length === 1 ? "document" : "documents"
  } from the previous session.`;
  renderNotice();
}

/**
 * Reopen the remembered tab set at boot.
 *
 * Every path is checked before anything is opened, so a vanished file is
 * skipped and counted in one toast instead of producing one error per file. The
 * first survivor fills the initial blank tab (`installingStartup` is still
 * true); the rest become tabs. Recents are deliberately not written: restoring
 * is not the reader opening ten documents.
 */
async function restoreLastTabs(): Promise<void> {
  const saved = settings.lastTabs;
  const exists = new Map<string, boolean>();
  await Promise.all(
    saved.map(async (path) => {
      exists.set(path, await api.pathExists(path).catch(() => false));
    }),
  );

  const plan = planRestore(saved, settings.lastActiveTab, (path) => exists.get(path) === true);
  if (plan.tabs.length === 0) {
    // First run with the preference set, or every remembered file is gone.
    await loadUntitled(WELCOME);
    return;
  }

  // The first survivor fills the blank session the window booted with; once it
  // is installed, `installingStartup` has to be off or every later file would
  // replace it in the same tab instead of becoming a tab of its own.
  for (const [index, path] of plan.tabs.entries()) {
    if (index === 1) installingStartup = false;
    await openPath(path, { silent: true, rememberRecent: false });
  }

  if (plan.active !== null) {
    const session = sessions.findByPath(plan.active);
    if (session) await activateSession(session.id);
  }

  if (plan.missing > 0) {
    const subject = plan.missing === 1 ? "1 document" : `${plan.missing} documents`;
    toast(`${subject} from the last session could not be found — the rest were reopened.`, 4000);
  }
}

async function boot(): Promise<void> {
  // Before the first paint, so the preview is never drawn in a fallback and then
  // corrected. The faces are local files, so this costs a millisecond.
  installBundledFonts();

  settings = await queueSettings(() => api.getSettings());
  migrateLegacySystemPreset();
  applyTheme();

  editor = createEditor(editorHost, {
    autoClosePairs: settings.autoClosePairs,
    autoCloseTags: settings.autoCloseTags,
    linkAt: (pos) => linkAt(editor.getDoc(), pos, doc.language),
    linkClick: openLinkTarget,
  });
  editor.onDocChanged((text) => {
    doc.revision += 1;
    // Invalidate before the debounce: the visible DOM still describes old text.
    renderToken += 1;
    wordMap = null;
    syncedSource = null;
    window.clearTimeout(selectionTimer);
    editor.clearSyncRange();
    setDirty(text !== doc.savedContent);
    if (text === doc.savedContent) void recovery.forget(doc);
    else recovery.schedule(doc, text);
    refreshStatus();
    scheduleTokenCount(text);
    scheduleRender();
    scheduleOutlineRefresh(text);
    clearPreviewWords();
  });
  editor.onCursor(() => {
    refreshStatus();
    updateActiveOutline();
  });
  readAloud = createReadAloud({
    rate: () => settings.readAloudRate ?? 1,
    voiceName: () => settings.readAloudVoice ?? "",
    // The spelling language is the application's only statement about the
    // document's natural language; "auto" leaves the voice to the platform.
    languageTag: () => (settings.spellcheckLanguage === "auto" ? "" : settings.spellcheckLanguage),
    onChange: renderReadingChip,
    onError: (message) => toast(message, 5200),
  });
  // Measured: `getVoices()` is empty on the first read, so the list is fetched in
  // the background and only that first moment reports "looking for voices".
  void readAloud.refreshVoices();
  // The editor's whole right-click menu lives outside the spelling plugin: that
  // plugin owns `contextmenu` when a misspelled word is under the pointer and
  // stops the event, so the two menus never compete for the same click.
  // Formatting needs the session lifecycle, so it is the one shell callback.
  installEditorContextMenu({
    view: editor.view,
    readOnly: () => doc.readOnly,
    format: () => formatSession(doc.id),
    formatBlocked: () => formatUnavailableReason(doc),
    favoriteBlocked: () => (doc.path ? null : "Save the document first."),
    isFavorite: () => doc.path !== null && isFavoritePath(doc.path),
    favorite: () => {
      if (doc.path) return toggleFavoritePath(doc.path);
    },
    linkAt: (pos) => linkAt(editor.getDoc(), pos, doc.language),
    openLink: openLinkTarget,
    reading: readingMenuState,
    readAloud: startReadAloud,
    stopReading: stopReadAloud,
    toast,
  });

  htmlPreview = createHtmlPreview(previewPane, {
    onLine: handleHtmlLine,
    onSelection: handleHtmlSelection,
    onClear: () => {
      syncedSource = null;
      editor.clearSyncRange();
      clearPreviewWords();
    },
    onLink: (href, raw) => handleHtmlLink(href, raw),
    onAction: handleHtmlAction,
    onScroll: handleHtmlScroll,
    onReady: handleHtmlReady,
    onError: (message) => toast(message, 6200),
  });

  // After the editor exists: a tab gesture that arrives during the first paint
  // must not reach a shell whose editor is still undefined.
  installTabs();

  preferences = createPreferences({
    settings: () => settings,
    update: applySettingsPatch,
    clearRecent: clearRecentFiles,
    readAloudVoices: () => readAloud?.voices() ?? [],
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

  assistant = createAssistant(editorPane, {
    config: () => ({
      enabled: settings.aiEnabled,
      provider: settings.aiProvider,
      baseUrl: settings.aiBaseUrl,
      model: settings.aiModel,
    }),
    language: () => doc.language,
    capture: () => {
      const info = editor.cursorInfo();
      return captureContext({
        text: editor.getDoc(),
        from: info.from,
        to: info.to,
        caret: info.to,
        language: doc.language,
      });
    },
    sessionId: () => doc.id,
    revision: () => doc.revision,
    canWrite: () => !doc.readOnly,
    apply: (plan) =>
      plan.kind === "replace"
        ? editor.replaceRange(plan.from, plan.to, plan.text)
        : editor.insertText(plan.from, plan.text),
    focusEditor: () => editor.focus(),
    toast,
    openSettings: () => preferences.openAt("ai"),
  });

  installChrome();
  installReloadGuard();
  installPaneSync();
  installPasteHandlers();
  installPreviewClicks();
  installPreviewCopy();
  installResizers();
  installSystemThemeWatcher();

  setSpellRemember(rememberSpelling);
  applyLayout();
  // The language list is a local COM/hunspell query, not a download. It still
  // waits until after the first paint: start-up does not block on it, and the
  // underlines appear once the answer is in.
  void api
    .spellcheckLanguages()
    .then((languages) => {
      setInstalledLanguages(languages);
      applySpellcheck();
      syncMenuState();
      preferences?.refresh();
    })
    .catch(() => {
      setInstalledLanguages([]);
      syncMenuState();
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
  // A second launch may arrive before the startup choice has finished. Hold
  // those paths here; the Rust queue covers the window before this listener
  // exists, and `openPath` makes a duplicate delivery focus the same tab.
  const pendingOpenFiles: string[] = [];
  let readyForPaths = false;
  await listen<string[]>("open-files", (event) => {
    if (!readyForPaths) {
      pendingOpenFiles.push(...event.payload);
      return;
    }
    void openPaths(event.payload);
  });

  const startup = await api.startupFiles().catch(() => [] as string[]);
  if (startup.length > 0) {
    const [first, ...rest] = startup;
    // The first path fills the window's blank session. Every later path must
    // be a tab, or each one would replace the same session.
    await openPath(first, { silent: true });
    installingStartup = false;
    if (rest.length > 0) await openPaths(rest);
  } else if (settings.onLaunch === "tabs") {
    await restoreLastTabs();
  } else if (settings.onLaunch === "new") {
    await loadUntitled("", defaultDocumentLanguage());
  } else if (settings.onLaunch === "last" && settings.recentFiles.length > 0) {
    await openPath(settings.recentFiles[0], { silent: true });
  } else {
    await loadUntitled(WELCOME);
  }
  installingStartup = false;
  await restoreRecovery();

  readyForPaths = true;
  const forwarded = [
    ...pendingOpenFiles,
    ...(await api.takeForwardedPaths().catch(() => [] as string[])),
  ];
  if (forwarded.length > 0) await openPaths(forwarded);

  installTabMemory();
  installDiskWatcher();
  installAutoSave();
  editor.focus();
}

/** Save in place on a timer when Auto Save is enabled in Preferences. */
function installAutoSave(): void {
  window.setInterval(() => {
    if (!settings.autoSave) return;
    const pending = sessions
      .list()
      .filter((session) => session.dirty && session.path && !session.readOnly && !session.conflict);
    if (pending.length === 0) return;
    void (async () => {
      let saved = 0;
      for (const session of pending) {
        if (await writeSession(session, true)) saved += 1;
      }
      if (saved === 1) toast("Auto saved", 1400);
      else if (saved > 1) toast(`Auto saved ${saved} files`, 1400);
    })();
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
