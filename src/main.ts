//! Application shell: document lifecycle, menu wiring, preview rendering and
//! the sidebar.

import "./styles.css";

import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { ask, message, open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";

import * as api from "./api";
import {
  invalidateAsciidocIncludeCache,
  renderAsciidocForExport,
  renderAsciidocPreview,
  renderAsciidocPreviewInto,
} from "./asciidoc-preview";
import {
  ASCIIDOC_REFERENCE,
  FONT_LICENCES,
  LATEX_REFERENCE,
  REFERENCE,
  SHORTCUTS,
  TYPST_REFERENCE,
  WELCOME,
} from "./content";
import { installEditorContextMenu, titleCase, type ReadingMenuState } from "./context-menu";
import { createReadAloud, type ReadAloudHandle, type ReadingState } from "./read-aloud";
import { createSystemSpeech, needsSystemSpeech } from "./system-speech";
import { readClipboardData } from "./clipboard";
import { CompiledPreviewUi, type CompiledStatus } from "./compiled-preview-ui";
import { createDocumentLifecycle } from "./document-lifecycle";
import { showDocumentStatistics, type DocumentStatistics } from "./statistics-dialog";
import { showEncodingDialog, type DeclarationEdit } from "./encoding-dialog";
import { displayEncoding } from "./encodings";
import type { SaveFormat } from "./document-lifecycle";
import { askUnsaved } from "./unsaved-dialog";
import { rewriteExportReferences } from "./export-article";
import { showWriterChooser } from "./export-chooser";
import { createEditor, pasteInsertionSpec, type EditorHandle, type PasteInsertion } from "./editor";
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
import {
  LANGUAGE_EXTENSIONS,
  languageForExtension,
  resolvePasteDestination,
  suggestSave,
  type PasteDestination,
} from "./paste/detect-document";
import { planPaste, type ImageRequest, type ResolvedImage } from "./paste/index";
import {
  AI_EXCERPT_CHARS,
  cleanAiSuggestion,
  plainExcerpt,
  suggestFileStem,
  withExtension,
  type FileStem,
} from "./filename";
import { escapeMarkdownCurrency, markdownProseSelection } from "./math-delimiters";
import {
  ASCIIDOC_CSS,
  GITHUB_ALERT_CSS,
  KATEX_STYLESHEET_URL,
  renderMermaidIn,
  renderPreview,
  renderPreviewInto,
  resolveLegacyImagesForExport,
  wrapNativePrintHtml,
  wrapPrintHtml,
  wrapStandaloneHtml,
} from "./markdown";
import { cancelPreviewWorkers } from "./preview-worker-client";
import {
  covers,
  documentOwner,
  ELAPSED_AFTER_MS,
  ELAPSED_AFTER_REDUCED_MS,
  formatElapsed,
  PENDING_GRACE_MS,
  pendingPhase,
  projectOwner,
  type OwnerProbe,
  type PreviewOwner,
} from "./preview-owner";
import { createPreviewStore } from "./preview-store";
import {
  htmlKey,
  latexKey,
  type LatexEngineIdentity,
  proseKey,
  typstKey,
} from "./preview-freshness";
import {
  bindWordMapAsync,
  blockRangeForNode,
  fragmentKindFor,
  rangesForSource,
  selectionEndpoints,
  snapToWords,
  sourceRangeFor,
  scrollSourceRange,
  scrollTextAnchorsAsync,
  type ScrollTextAnchor,
  type BlockRange,
  type Fragment,
  type WordMap,
} from "./source-map";
import { createPreferences, type PreferencesHandle } from "./preferences";
import { createAssistant, type AssistantHandle } from "./ai/assistant";
import { captureContext, resolveAiLanguage } from "./ai/context";
import { recordUsage as recordActionUsage } from "./ai/usage";
import { createRecoveryScheduler } from "./recovery";
import { createSessionStore, pathKey, type Session } from "./sessions";
import { planRestore, rememberTabs, type RememberedTabs } from "./tab-restore";
import { resolveDocumentLanguage as resolveLanguage } from "./language";
import { pathSpellingChoice, rememberPathSpellingChoice } from "./spelling/document-choice";
import {
  installedLanguages,
  setInstalledLanguages,
  setSpellIgnore,
  setSpellRemember,
  setSpellStatus,
  type SpellingStatus,
} from "./spellcheck";
import * as sidebarPanel from "./sidebar";
import { resolvePalette } from "./syntax-themes";
import { createTabsUi, type TabsUi } from "./tabs";
import { invalidateExplorer, openRowMenu, renderExplorer } from "./explorer";
import {
  TYPST_DISPLAY_MATH,
  TYPST_OUTLINE,
  TYPST_QUOTE,
  TYPST_RULE,
  TYPST_TABLE,
  typstInline,
  typstUnsupported,
} from "./typst-commands";
import {
  LATEX_CODE,
  LATEX_DISPLAY_MATH,
  LATEX_QUOTE,
  LATEX_RULE,
  LATEX_TABLE,
  LATEX_TOC,
  latexInline,
  latexUnsupported,
} from "./latex-commands";
import { annotateTypstLines } from "./typst-map";
import { paragraphRangeAt } from "./typst-page-map";
import { pdfPageTexts, TypstPdfPreview, type TypstPageContext } from "./typst-pdf";
import {
  cancelLatex as cancelBundledLatex,
  compileFresh,
  compileLatex,
  distrustWarmEngine,
  interactiveLaneWorthwhile,
  LatexBuildError,
  latexEngineInfo,
  previewLatexPages,
  RECYCLE_AFTER_COMPILES,
  recycleWarmEngine,
  SupersededError,
  type LatexDiagnostic,
  type LatexResult,
} from "./latex";
import { KeyRhythm, LatestWinsGate, adaptiveDelay, staleBeyondCap } from "./latex-scheduler";
import { resolveMainDocument } from "./latex-root";
import {
  ENGINE_LABELS,
  engineMismatch,
  isTexEngine,
  resolveTexEngine,
  type EngineChoice,
  type TexEngine,
} from "./latex-engine-choice";
import { projectLatexOutline, type ProjectHeading } from "./latex-outline";
import { LATEX_ENGINE_YEAR, optionalEngineBytes } from "./latex-engine";
import { nativeSources, nativeToLatex } from "./latex-native";
import {
  latexPreviewBackend,
  setLatexPreviewBackend,
  TEXPRESSO_ENGINE_MIB,
  TEXPRESSO_TEXLIVE_YEAR,
  texpressoEngineFor,
  texpressoFallback,
  texpressoFallbackText,
  type LatexPreviewBackend,
  type TexpressoFallback,
} from "./latex-backend";
import { normaliseText, prepareProject, TexpressoSession } from "./texpresso/session";
import type { FrameMessage, TexpressoTheme } from "./texpresso/protocol";
import { editorLineAt, editorScrollFor, type EditorScrollGeometry } from "./texpresso/scroll";
import { projectRelativePath, rangeForPreviewGesture } from "./texpresso/selection";
import { libraryNames } from "./latex-texmf";
import {
  clearLatexPerf,
  clearProsePerf,
  clearTypstPerf,
  perfMark,
  perfMeasure,
  perfPhase,
  prosePerfMark,
  prosePerfMeasure,
  resetLatexPhase,
  typstPerfMark,
  typstPerfMeasure,
} from "./perf";
import { ProseDelayTracker } from "./prose-scheduler";
import { SupersededError as TypstSupersededError, TypstCompileScheduler } from "./typst-scheduler";
import { setLocalLatexNames } from "./completion/latex-source";
import {
  diagnosticPlace,
  diagnosticRange,
  diagnosticSignature,
  latexProjectMember,
} from "./latex-diagnostics";
import { lineTextOf } from "./latex-references";
import {
  clampScroll,
  mapScrollOffset,
  interpolate,
  rowCentre,
  scrollCorrection,
  ScrollIndex,
  ScrollOwnership,
  type ScrollPair,
  type SyncPane,
} from "./scroll-sync";

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
const previewShell = el<HTMLElement>("preview-shell");
const compiledUi = new CompiledPreviewUi(previewShell, previewPane, el("compiler-logs"), {
  compile: compileCurrentDocument,
  cancel: () => (doc.language === "latex" ? cancelLatexBuild() : cancelTypstBuild()),
  auto: (on) =>
    doc.language === "latex"
      ? setLatexAutoCompile(on)
      : applySettingsPatch({ typstAutoCompile: on }),
  save: () => {
    void (doc.language === "latex" ? latexSavePdf() : saveTypstPagesPdf());
  },
  mode: chooseTypstView,
  copy: (text) => {
    void api.clipboardWriteText(text).then(
      () => toast("Copied compiler output"),
      (error) => toast(String(error)),
    );
  },
});
const statusFile = el<HTMLSpanElement>("status-file");
const statusTokens = el<HTMLButtonElement>("status-tokens");
const statusWords = el<HTMLButtonElement>("status-words");
const statusCursor = el<HTMLSpanElement>("status-cursor");
const statusEngine = el<HTMLButtonElement>("status-latex-engine");
const statusEncoding = el<HTMLButtonElement>("status-encoding");
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
/**
 * Assistant file names, remembered per session revision.
 *
 * A cancelled Save dialog is not a reason to ask the endpoint again: the same
 * text has the same name. Editing increments the revision and discards it.
 */
const suggestedNames = new Map<string, { revision: number; stem: string }>();
let filenameRequestSeq = 0;
const lifecycle = createDocumentLifecycle({
  sessions,
  text: textOf,
  read: api.readDocument,
  stat: api.statDocument,
  write: async (path, content, lineEnding, hadBom, expectedSha256, encoding) => {
    const result = await api.writeDocumentChecked(
      path,
      content,
      lineEnding,
      hadBom,
      expectedSha256,
      encoding,
    );
    invalidateAsciidocIncludeCache(path);
    return result;
  },
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
    // The buffer, not the setting, decides the extension of an untitled file:
    // someone who typed Typst in a fresh tab should not have to switch the
    // dialog away from Markdown. A saved file keeps its own path and language,
    // and a suggested path (a conflict copy) already carries its extension.
    const suggestion = suggestSave({
      path: session.path,
      language: session.language,
      buffer: textOf(session),
      defaultExtension: settings.defaultExtension,
      defaultLanguage: defaultDocumentLanguage(),
    });
    // A suggested path (a conflict copy) and a saved file's own path are already
    // names. Only an untitled buffer is named from its contents.
    let defaultPath =
      suggested ??
      (session.lossy || session.encodingBlocked ? conflictCopyPath(session) : session.path);
    if (!defaultPath) {
      const extension = suggestion.extension ?? settings.defaultExtension;
      const name = await suggestedFileName(
        session,
        textOf(session),
        suggestion.language,
        extension,
      );
      defaultPath = settings.lastDirectory ? joinDir(settings.lastDirectory, name) : name;
    }
    const chosen = await saveDialog({
      title: session.lossy || session.encodingBlocked ? "Save a UTF-8 copy" : "Save As",
      defaultPath,
      filters: documentFilters(suggestion.language),
    });
    return Array.isArray(chosen) ? (chosen[0] ?? null) : chosen;
  },
  adoptPath: (session, path) => {
    const spellingChoice = documentSpellingChoice(session);
    suggestedNames.delete(session.id);
    session.path = path;
    session.name = basename(path);
    session.directory = directoryOf(path);
    session.language = languageFor(path);
    setDocumentSpellingChoice(session, spellingChoice);
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
        invalidatePreview();
        retirePreview();
        syncGuest(session.language);
        editor.setLanguage(editorLanguageFor(session));
        assistant?.sync();
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
        invalidateExplorer();
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
 * The blank tab the window boots with, offered to the startup choice.
 *
 * Boot installs the first startup document into it; after that, Open and New
 * add a tab instead of replacing the one the reader is in. It is a reserved
 * session, not a boolean: two reads that both saw "still starting" must not
 * both fill it, and a tab the reader has typed in, or closed, is no longer
 * blank. `takeStartupSlot` consumes it at most once.
 */
interface StartupSlot {
  session: Session;
  revision: number;
}
let startupSlot: StartupSlot | null = { session: doc, revision: doc.revision };

/** True, once, when the reserved blank tab may still be replaced. */
function takeStartupSlot(): boolean {
  const slot = startupSlot;
  startupSlot = null;
  return Boolean(
    slot &&
    slot.session === doc &&
    sessions.byId(slot.session.id) === slot.session &&
    slot.session.revision === slot.revision &&
    !slot.session.dirty,
  );
}
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
/** How long Save waits for an assistant name before using the first line. */
const AI_FILENAME_TIMEOUT_MS = 4_000;
/** A fast answer should not flash a toast before the dialog opens. */
const AI_FILENAME_NOTICE_DELAY_MS = 300;
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
 *
 * A handle only owns the toast it created. The long-running actions show a
 * progress toast with `0`, then replace it with a result toast and dismiss the
 * progress handle in `finally`; without this guard that dismissal hid the
 * result immediately, so the reader saw the work start and never saw how it
 * ended.
 */
let toastSequence = 0;
function toast(text: string, ms = 2600): { dismiss: () => void } {
  const generation = ++toastSequence;
  toastEl.textContent = text;
  toastEl.hidden = false;
  window.clearTimeout(toastTimer);
  const dismiss = () => {
    if (generation !== toastSequence) return;
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
  if (doc.encodingBlocked) {
    const session = doc;
    showNotice(
      `"${doc.name}" contains characters ${displayEncoding(doc.encoding)} cannot store. The file was not changed; save a UTF-8 copy instead.`,
      "warning",
      [
        {
          label: "Save a UTF-8 copy…",
          run: () => saveAs(conflictCopyPath(session), session, "UTF-8").then(() => {}),
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
  if (texpresso) texpresso.post({ type: "theme", theme: texpressoTheme() });
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

let spellingDiscovery: "pending" | "ready" | "error" = "pending";
let spellingStatus: { key: string; status: SpellingStatus } | null = null;

function spellingSessionKey(session: Session = doc): string {
  return `${session.id}:${session.incarnation}`;
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
  const spellState =
    spellingStatus?.key === spellingSessionKey() ? spellingStatus.status : "pending";
  const spellHint =
    settings.spellcheck === false
      ? "Spelling is off."
      : spellingDiscovery === "error"
        ? "The spelling service is unavailable."
        : spellingDiscovery === "pending"
          ? "Checking installed dictionaries."
          : installedLanguages().length === 0
            ? "No installed spelling dictionary is available."
            : spellState === "pending"
              ? "Preparing the document for spelling."
              : spellState === "missing"
                ? "Some text has no matching installed dictionary."
                : spellState === "error"
                  ? "The spelling service could not check this document."
                  : "Underlines words the installed dictionary does not recognise.";
  setStatusFlag(
    "flag-spellcheck",
    settings.spellcheck !== false,
    settings.spellcheck !== false &&
      (spellingDiscovery !== "ready" ||
        installedLanguages().length === 0 ||
        spellState !== "active"),
    "Check spelling",
    "",
    spellHint,
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
  // `Export › PDF` writes the bytes the preview already holds, so it is available
  // exactly while those bytes are current. A LaTeX preview *is* a compiled PDF,
  // so a successful compile is enough; a Typst document only has PDF bytes in the
  // Pages view, because the Document view compiles HTML. The freshness check is
  // the same token comparison the preview itself uses, so a stale render cannot
  // enable a row that would then write the previous document's pages.
  const pdfPreviewAvailable =
    doc?.language === "latex"
      ? latexCurrent(latexPreview) && latexPreview.token === renderToken
      : doc?.language === "typst"
        ? settings.typstView === "pages" && typstPdfCurrent()
        : false;
  const syntaxTheme =
    settings.syntaxTheme === "github-light" ? "catppuccin-latte" : settings.syntaxTheme;

  return {
    viewMode: settings.viewMode,
    sidebarVisible: settings.sidebarVisible,
    sidebarTab: settings.sidebarTab,
    hasWorkspace: Boolean(settings.workspaceFolder),
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
    spellcheckAvailable: installedLanguages().length > 0,
    aiEnabled: settings.aiEnabled,
    syntaxTheme,
    typstView: settings.typstView,
    typstAvailable: typstCache?.found !== false,
    pdfPreviewAvailable,
    pdfEngine:
      doc?.language === "latex" && pdfPreviewAvailable ? (latexPreview?.result.engine ?? "") : "",
    latexAutoCompile: settings.latexAutoCompile !== false,
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

const ignoredSpelling = new Map<string, { incarnation: number; words: string[] }>();
const documentSpelling = new Map<string, { incarnation: number; choice: string }>();

function documentSpellingChoice(session: Session = doc): string {
  const current = documentSpelling.get(session.id);
  if (current?.incarnation === session.incarnation) return current.choice;
  if (!session.path) return "follow";
  return pathSpellingChoice(settings.spellcheckDocumentLanguages ?? [], session.path);
}

function setDocumentSpellingChoice(session: Session, choice: string): void {
  documentSpelling.delete(session.id);
  documentSpelling.set(session.id, { incarnation: session.incarnation, choice });
  while (documentSpelling.size > 100)
    documentSpelling.delete(documentSpelling.keys().next().value!);
  if (session.path) {
    const entries = rememberPathSpellingChoice(
      settings.spellcheckDocumentLanguages ?? [],
      session.path,
      choice,
    );
    applySettingsPatch({ spellcheckDocumentLanguages: entries });
  } else if (session === doc) applySpellcheck();
  if (session === doc) preferences?.refresh();
}

function effectiveSpellingLanguage(session: Session = doc): string {
  const choice = documentSpellingChoice(session);
  return choice === "follow" ? settings.spellcheckLanguage || "auto" : choice;
}

function ignoredSpellingWords(): string[] {
  const entry = ignoredSpelling.get(doc.id);
  return entry?.incarnation === doc.incarnation ? entry.words : [];
}

function ignoreSpelling(word: string): void {
  const words = ignoredSpellingWords();
  if (!words.some((entry) => entry.toLowerCase() === word.toLowerCase())) words.push(word);
  ignoredSpelling.delete(doc.id);
  ignoredSpelling.set(doc.id, { incarnation: doc.incarnation, words: words.slice(-500) });
  while (ignoredSpelling.size > 100) ignoredSpelling.delete(ignoredSpelling.keys().next().value!);
  applySpellcheck();
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
    enabled: settings.spellcheck !== false,
    language: effectiveSpellingLanguage(),
    documentLanguage: doc.language,
    words: [...(settings.spellcheckWords ?? []), ...ignoredSpellingWords()],
    stringMode: settings.spellcheckStringMode,
    identifiers: settings.spellcheckIdentifiers,
    readOnly: doc.readOnly,
    sessionKey: spellingSessionKey(),
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
  editor?.setCursorBlink(settings.cursorBlink !== false);
  typstPdf?.setZoom(zoom);
  texpresso?.post({ type: "zoom", factor: zoom });
  texpressoFollowTab();
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

  for (const tab of ["outline", "favorites", "recent", "explorer"] as const) {
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
  retheme();
}

/**
 * Bumped by every theme change, so a mermaid pass started under the previous
 * theme stops writing instead of overwriting the re-themed diagrams.
 */
let themeEpoch = 0;

/**
 * Bring the committed preview to the current theme without rebuilding it.
 *
 * The theme is not an input of any compiled output: PDFs go dark through a CSS
 * filter on their canvases, code highlighting is a swapped stylesheet, and the
 * HTML guest draws the document's own styles. Sending a theme change through
 * `scheduleRender` recompiled a whole LaTeX project and restarted an HTML
 * document's scripts for a colour change. Mermaid SVG is the one output that
 * carries theme colours, so only its blocks are redrawn — from the cache when
 * the diagram was already drawn in this theme.
 */
function retheme(): void {
  const epoch = ++themeEpoch;
  if (doc.language !== "markdown" && doc.language !== "asciidoc") return;
  if (!preview.querySelector(".mermaid[data-mermaid]")) return;
  const token = renderToken;
  const cancelled = () => epoch !== themeEpoch || token !== renderToken;
  void renderMermaidIn(preview, isDark, cancelled).then(() => {
    if (cancelled()) return;
    // A diagram's size can differ between themes; rebuild the anchor list so a
    // replaced node is not kept, then realign the panes.
    rebuildAnchors();
    syncPreviewFromSource();
  });
}

/**
 * Apply a patch from the Preferences panel and refresh anything it affects.
 *
 * `effects: false` is for a counter no other surface displays — the AI action
 * usage — so recording a use does not re-apply the theme, re-measure the
 * layout or re-read the assistant's configuration. The write itself still goes
 * through this one function, so `settings` and the queued `persist()` never
 * disagree about what the current values are.
 */
function applySettingsPatch(
  patch: Partial<api.Settings>,
  options: { effects?: boolean } = {},
): void {
  const effects = options.effects !== false;
  const affectsRendering =
    patch.enableMath !== undefined ||
    patch.enableMermaid !== undefined ||
    patch.htmlPreviewScripts !== undefined ||
    // The bundled engine of a project (stage 6.2): another engine, another PDF.
    patch.latexBundledEngine !== undefined ||
    patch.latexProjectEngines !== undefined ||
    patch.typstIncrementalService !== undefined;
  // `syntaxTheme` is the editor's palette and `editorMaxWidth` a CSS length
  // that `applyLayout` below applies, like zoom: neither is an input of any
  // preview. Listing them as rendering inputs recompiled a LaTeX project for a
  // colour or width change. A width change only needs the panes realigned once
  // the new layout has settled.
  const affectsLayoutOnly = patch.editorMaxWidth !== undefined;

  settings = { ...settings, ...patch };
  if (effects) {
    applyTheme();
    applyLayout();
  }
  persist();
  if (!effects) return;
  assistant?.sync();

  if (patch.autoClosePairs !== undefined || patch.autoCloseTags !== undefined) {
    editor.setAutoClose({
      pairs: settings.autoClosePairs,
      tags: settings.autoCloseTags,
    });
  }

  // Completion is switched at runtime rather than at start-up only, so a reader
  // who turns it off does not have to reopen the document.
  if (patch.completion !== undefined) editor.setCompletion(settings.completion !== false);
  if (patch.emmet !== undefined) editor.setEmmet(settings.emmet !== false);

  if (patch.latexAutoCompile !== undefined) {
    // Manual mode holds the edit stream too; Compile sends what was held.
    texpresso?.hold(settings.latexAutoCompile === false);
    syncLatexAutoToggle();
    syncMenuState(false);
  }
  if (patch.latexAutoCompile !== undefined && doc.language === "latex") {
    if (patch.latexAutoCompile && previewStale) scheduleRender(true);
    else if (!patch.latexAutoCompile) {
      window.clearTimeout(renderTimer);
      if (latexInFlight) cancelLatexBuild();
      else if (previewStale) setLatexStatus("Out of date · Select Compile to update the preview.");
    }
  }

  if (patch.typstAutoCompile !== undefined && doc.language === "typst") {
    configureCompiledUi();
    if (patch.typstAutoCompile) scheduleRender(true);
    else {
      window.clearTimeout(renderTimer);
      if (typstInFlight !== null) cancelTypstBuild();
      else setTypstStatus("Out of date · Select Compile to update the preview.");
    }
    preferences?.refresh();
  }
  if (patch.typstIncrementalService !== undefined) {
    typstStore.clear();
    void refreshTypstServiceStatus();
  }
  if (affectsRendering) scheduleRender(true);
  else if (affectsLayoutOnly) requestAnimationFrame(() => syncPreviewFromSource());
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
    "No model vocabulary is loaded. Click for document statistics.";
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
  statusWords.title =
    `${wordsText} words · ${formatCount(chars)} characters · ${formatCount(lines)} lines` +
    " · Click for document statistics";
  // The engine chip belongs to LaTeX documents compiled by the bundled engine.
  if (doc.language !== "latex" || !engineChipChoice) statusEngine.hidden = true;
  statusCursor.textContent = `Ln ${cursor.line}, Col ${cursor.column}${
    cursor.selectionLength > 0
      ? ` (${cursor.selectionLength} selected${
          cursor.selectionLines > 1 ? `, ${cursor.selectionLines} lines` : ""
        })`
      : ""
  }`;

  const eol = doc.lineEnding === "\r\n" ? "CRLF" : "LF";
  const format = `${displayEncoding(doc.encoding)}${doc.hadBom ? " BOM" : ""} · ${eol}`;
  statusEncoding.textContent = doc.path
    ? `${format}${doc.readOnly ? " · read-only" : ""}`
    : `${format} · not saved`;
  statusEncoding.title = `${format} — click to convert or reinterpret`;
}

/**
 * The statistics snapshot for Tools › Document Statistics.
 *
 * Words, lines and characters come from the editor's incremental cache. The
 * byte length is the saved file's exact size while the buffer is clean; a dirty
 * or untitled buffer is measured as UTF-8 with the document's line-ending and
 * BOM overhead added, so the number is what the next save will write. Only the
 * explicit menu action pays for that pass.
 */
const utf8Encoder = new TextEncoder();

function utf8Length(text: string): number {
  return utf8Encoder.encode(text).length;
}

function documentStatistics(text: string): DocumentStatistics {
  const metrics = editor.metrics();
  const bytes =
    doc.path && !doc.dirty
      ? doc.size
      : utf8Length(text) +
        (doc.lineEnding === "\r\n" ? Math.max(0, metrics.lines - 1) : 0) +
        (doc.hadBom ? 3 : 0);
  const ranges = editor.view.state.selection.ranges.filter((range) => !range.empty);
  let selectedCharacters = 0;
  let selectedBytes = 0;
  for (const range of ranges) {
    selectedCharacters += range.to - range.from;
    selectedBytes += utf8Length(text.slice(range.from, range.to));
  }
  return {
    characters: metrics.chars,
    words: metrics.words,
    lines: metrics.lines,
    bytes,
    selection:
      ranges.length > 0
        ? { characters: selectedCharacters, bytes: selectedBytes, ranges: ranges.length }
        : null,
  };
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

let renderTimer = 0;
let renderToken = 0;
/** The preview compile currently owned by the frontend, if any. */
let typstInFlight: number | null = null;

function cancelTypstRender(): void {
  typstScheduler.dropWaiting(new TypstSupersededError(typstEditSeq, renderToken));
  if (typstInFlight === null) return;
  typstInFlight = null;
  void api.cancelTypstPreview(renderToken).catch((error) => {
    console.warn("[preview] could not cancel Typst:", error);
  });
}
/**
 * True when the preview does not describe the current buffer. Source mode sets
 * it without rendering; switching to a visible mode renders before it is used.
 */
let previewStale = true;
/**
 * True when the last render produced the map Split view needs. A render made in
 * Preview Only has no word map, so entering Split has to rebuild it.
 */
let previewSyncReady = false;
/**
 * What the pane's content was built from, or null before a commit and after a
 * retirement. A rebuild of the same owner keeps the content; a change to another
 * owner removes it.
 */
let previewOwner: PreviewOwner | null = null;
/**
 * The freshness key of what the pane shows (`src/preview-freshness.ts`), or
 * null when the content cannot vouch for itself: before a commit, after a
 * retirement or a guest reset, and after any commit that was not a successful
 * build — a failure note, a partial PDF, the "not enabled" note. A render whose
 * wanted key equals this one has nothing to build.
 */
let committedKey: string | null = null;
/**
 * The word-map inputs of the last Markdown/AsciiDoc build, kept with its key.
 * An edit drops the bound map; when the edit is undone before the render runs,
 * the DOM is still stamped for this source and the map is rebound from these
 * instead of converting the document again.
 */
interface ProseMap {
  key: string;
  fragments: Parameters<typeof bindPreviewWords>[1];
  blocks: Parameters<typeof bindPreviewWords>[2];
  blockFragmentCounts?: number[];
  linesMapped: boolean;
}
let proseMap: ProseMap | null = null;
/**
 * Compiled output kept across tab switches, under freshness keys, so a return to
 * an unchanged document draws its output instead of building it. In memory
 * only; see `src/preview-store.ts` for the budget and eviction.
 */
interface CachedTypstDep {
  path: string;
  modifiedMs: number;
  size: number;
  sha256: string | null;
}

interface CachedTypstEntry {
  rendered: api.RenderedTypst;
  pdfBytes?: Uint8Array;
  deps: CachedTypstDep[];
}

const latexStore = createPreviewStore<LatexResult>();
const typstStore = createPreviewStore<CachedTypstEntry>();

/** What a stored LaTeX result costs: the PDF, plus the log and sources as UTF-16. */
function latexResultBytes(result: LatexResult): number {
  let bytes = result.pdf.byteLength + result.log.length * 2;
  for (const file of result.sources) bytes += file.source.length * 2;
  return bytes;
}

/**
 * Set by Compile and consumed by the next LaTeX or Typst render: that render
 * builds, whatever the freshness key, the store or a parked preview say.
 */
let forceNextBuild = false;

/** Starts of the compilers, for the freshness suite. Never read by the shell. */
let compileCount = 0;
function countCompile(): void {
  compileCount += 1;
  preview.dataset.compileCount = String(compileCount);
}

/** The active document as ownership sees it. */
function probeOf(session: Session): OwnerProbe {
  return {
    id: session.id,
    incarnation: session.incarnation,
    path: session.path,
    language: session.language,
  };
}

/**
 * Record that the pane now describes `owner`.
 *
 * Every renderer swaps its result in and then calls this, after its token and
 * document guards. The pending surface belongs to the wait, not to the result,
 * so it is cleared here rather than by each renderer.
 */
function commitPreview(owner: PreviewOwner, key: string | null = null): void {
  previewStale = false;
  previewOwner = owner;
  committedKey = key;
  committedDoc = { id: doc.id, incarnation: doc.incarnation };
  clearPending();
}

/**
 * The document that was active at the last commit. A LaTeX project owner names
 * its root, not the chapter on screen, so this is how a retirement knows which
 * tab the parked preview belongs to.
 */
let committedDoc: { id: string; incarnation: number } | null = null;

/**
 * A preview taken off screen with its tab, so a return shows it again without
 * rebuilding anything: the article DOM, or the PDF view with its parsed
 * document, plus the state that makes it rebindable. It is restored as if it
 * had never left; the render that follows checks the freshness key and only
 * rebinds — or, when an input changed meanwhile, rebuilds over it, which is the
 * same stale-while-revalidate a single document already gets.
 */
interface PreviewSlot {
  sessionId: string;
  incarnation: number;
  language: api.DocumentLanguage;
  owner: PreviewOwner;
  key: string;
  holder: HTMLElement;
  pdf: TypstPdfPreview | null;
  pdfToken: number;
  pdfBytes: Uint8Array | null;
  proseMap: ProseMap | null;
  typst: TypstRenderKey | null;
  linesMapped: boolean;
  scrollTop: number;
  scrollLeft: number;
  latex: LatexPreview | null;
}
/** How many hidden tabs keep their preview. A PDF view is the costly one. */
const PREVIEW_SLOTS = 3;
const previewSlots = new Map<string, PreviewSlot>();

function disposeSlot(slot: PreviewSlot): void {
  slot.pdf?.dispose();
  slot.holder.replaceChildren();
}

/**
 * Move the committed preview into a slot for the tab it belongs to, before a
 * retirement would destroy it. Only output that vouches for itself (a
 * committed freshness key) is kept; HTML is not, because moving an iframe
 * reloads it and a hidden live guest would keep running its scripts.
 */
function parkPreview(): void {
  for (const [id, slot] of previewSlots) {
    if (!sessions.byId(id)) {
      previewSlots.delete(id);
      disposeSlot(slot);
    }
  }
  const owner = previewOwner;
  const key = committedKey;
  const from = committedDoc;
  if (!owner || !key || !from) return;
  const session = sessions.byId(from.id);
  if (!session || session.incarnation !== from.incarnation || session.language === "html") return;
  if (!preview.firstChild) return;
  const latex =
    owner.kind === "latex-project" && latexPreview && latexPreview.token === typstPdfToken
      ? latexPreview
      : null;
  if (session.language === "latex" && !latex) return;
  const holder = document.createElement("div");
  holder.append(...preview.childNodes);
  const view = typstPdf;
  view?.park();
  const slot: PreviewSlot = {
    sessionId: from.id,
    incarnation: from.incarnation,
    language: session.language,
    owner,
    key,
    holder,
    pdf: view,
    pdfToken: typstPdfToken,
    pdfBytes: typstPdfBytes,
    proseMap,
    typst: lastTypstRender,
    linesMapped: previewLinesMapped,
    scrollTop: previewPane.scrollTop,
    scrollLeft: previewPane.scrollLeft,
    latex,
  };
  // The retirement that follows must not dispose what the slot now owns.
  typstPdf = null;
  typstPdfBytes = null;
  const previous = previewSlots.get(from.id);
  if (previous) {
    previewSlots.delete(from.id);
    disposeSlot(previous);
  }
  previewSlots.set(from.id, slot);
  while (previewSlots.size > PREVIEW_SLOTS) {
    const [oldest, evicted] = previewSlots.entries().next().value as [string, PreviewSlot];
    previewSlots.delete(oldest);
    disposeSlot(evicted);
  }
}

/**
 * Put the active tab's parked preview back, when it has one for this exact
 * incarnation. Returns true when the pane now shows it; the caller's render
 * then decides, by key, whether anything needs building.
 */
function restorePreview(): boolean {
  const slot = previewSlots.get(doc.id);
  if (!slot) return false;
  previewSlots.delete(doc.id);
  if (
    previewOwner !== null ||
    slot.incarnation !== doc.incarnation ||
    slot.language !== doc.language
  ) {
    disposeSlot(slot);
    return false;
  }
  clearPending();
  preview.replaceChildren(...slot.holder.childNodes);
  if (slot.pdf) {
    typstPdf = slot.pdf;
    typstPdfToken = slot.pdfToken;
    typstPdfBytes = slot.pdfBytes;
    slot.pdf.setZoom(zoomFactor());
    slot.pdf.activate();
  }
  proseMap = slot.proseMap;
  lastTypstRender = slot.typst;
  previewLinesMapped = slot.linesMapped;
  if (slot.latex) {
    // The project this tab belongs to, as of its own last build. Another
    // project compiled meanwhile moved both; the tab's own root comes back.
    latexPreview = slot.latex;
    latexProject = latexProjectOf(slot.latex);
    latexNavigationRoot = slot.latex.rootId;
  }
  previewOwner = slot.owner;
  committedKey = slot.key;
  committedDoc = { id: slot.sessionId, incarnation: slot.incarnation };
  suppressPreviewScrollUntil = performance.now() + SYNC_SUPPRESS_MS;
  previewPane.scrollTop = pendingPreviewScroll ?? slot.scrollTop;
  previewPane.scrollLeft = slot.scrollLeft;
  rebuildAnchors();
  preview.dataset.restored = String((Number(preview.dataset.restored ?? 0) || 0) + 1);
  return true;
}

/**
 * The waiting surface shown while the pane has no content for this document.
 *
 * It is a child of `.preview-pane`, never of `#preview`: Document Zoom scales
 * the article, and a status surface that scaled with it would be the wrong size
 * for the pane it fills.
 */
let pending: {
  sessionId: string;
  incarnation: number;
  startedAt: number;
  graceTimer: number;
  tick: number;
  node: HTMLElement | null;
} | null = null;

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function pendingIdle(): boolean {
  return (
    (doc.language === "latex" && settings.latexAutoCompile === false && !latexInFlight) ||
    (doc.language === "typst" && settings.typstAutoCompile === false && typstInFlight === null)
  );
}

/** The strip's current sentence, so the surface does not contradict it. */
function currentLatexPhase(): string {
  return compiledUi.phase;
}

function updatePendingElapsed(entry: NonNullable<typeof pending>): void {
  if (pending !== entry || !entry.node) return;
  const label = entry.node.querySelector<HTMLElement>(".preview-pending-elapsed");
  if (!label) return;
  const elapsed = performance.now() - entry.startedAt;
  const threshold = prefersReducedMotion() ? ELAPSED_AFTER_REDUCED_MS : ELAPSED_AFTER_MS;
  label.textContent = elapsed >= threshold ? formatElapsed(elapsed) : "";
}

function showPending(entry: NonNullable<typeof pending>): void {
  if (pending !== entry) return;
  if (previewOwner !== null || settings.viewMode === "source") {
    clearPending();
    return;
  }
  if (doc.id !== entry.sessionId || doc.incarnation !== entry.incarnation) {
    clearPending();
    return;
  }
  const idle = pendingIdle();
  const node = document.createElement("div");
  node.className = "preview-pending";
  node.dataset.state = idle ? "idle" : "pending";
  const spinner = document.createElement("div");
  spinner.className = "preview-pending-spinner";
  spinner.setAttribute("aria-hidden", "true");
  const title = document.createElement("div");
  title.className = "preview-pending-title";
  title.textContent = doc.name;
  const phase = document.createElement("div");
  phase.className = "preview-pending-phase";
  // Only the phase is a live region: the elapsed counter changes every second
  // and must not interrupt a screen reader that often.
  phase.setAttribute("role", "status");
  phase.setAttribute("aria-live", "polite");
  phase.textContent = idle
    ? "Not compiled yet — select Compile."
    : doc.language === "latex"
      ? currentLatexPhase() || pendingPhase(doc.language)
      : pendingPhase(doc.language);
  const elapsed = document.createElement("div");
  elapsed.className = "preview-pending-elapsed";
  elapsed.setAttribute("aria-hidden", "true");
  node.append(spinner, title, phase, elapsed);
  previewPane.appendChild(node);
  entry.node = node;
  if (!idle) entry.tick = window.setInterval(() => updatePendingElapsed(entry), 1000);
}

function clearPending(): void {
  if (!pending) return;
  window.clearTimeout(pending.graceTimer);
  window.clearInterval(pending.tick);
  pending.node?.remove();
  pending = null;
}

/** Turn a visible surface idle without starting a new wait. */
function showPendingIdle(message: string): void {
  const entry = pending;
  if (!entry) return;
  if (!entry.node) showPending(entry);
  if (!entry.node) return;
  window.clearInterval(entry.tick);
  entry.tick = 0;
  entry.node.dataset.state = "idle";
  const phase = entry.node.querySelector<HTMLElement>(".preview-pending-phase");
  if (phase) phase.textContent = message;
  const elapsed = entry.node.querySelector<HTMLElement>(".preview-pending-elapsed");
  if (elapsed) elapsed.textContent = "";
}

/**
 * Start waiting for `doc`, unless its content is already on screen.
 *
 * The grace timer keeps an ordinary rebuild invisible; `startedAt` survives a
 * repeated call for the same document, so several renders of one wait do not
 * each restart the counter.
 */
function armPending(opts: { immediate?: boolean } = {}): void {
  if (doc.language === "html" || previewOwner !== null) return;
  if (settings.viewMode === "source") return;
  if (pending && pending.sessionId === doc.id && pending.incarnation === doc.incarnation) return;
  clearPending();
  const entry = {
    sessionId: doc.id,
    incarnation: doc.incarnation,
    startedAt: performance.now(),
    graceTimer: 0,
    tick: 0,
    node: null,
  };
  pending = entry;
  entry.graceTimer = window.setTimeout(
    () => showPending(entry),
    opts.immediate ? 0 : PENDING_GRACE_MS,
  );
}

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

/**
 * Rebuild the preview after a quiet period.
 *
 * The conversion runs in a worker; only the batched insertion touches the main
 * thread, so the pre-worker quiet period is enough to coalesce a burst. Typst
 * keeps a longer one because it starts a compiler process.
 */
function scheduleRender(immediate = false): void {
  window.clearTimeout(renderTimer);
  configureCompiledUi();
  if (doc.language === "typst" && settings.typstAutoCompile === false) {
    if (previewStale) setTypstStatus("Out of date · Select Compile to update the preview.");
    armPending({ immediate: true });
    // Manual mode never compiles on its own, but output already built from
    // exactly this text is current, not stale: show it.
    if (immediate && previewOwner === null && settings.viewMode !== "source" && typstStoreHit()) {
      renderTimer = window.setTimeout(() => void doRender(), 0);
    }
    return;
  }
  if (doc.language === "latex" && settings.latexAutoCompile === false) {
    if (previewStale) setLatexStatus("Out of date · Select Compile to update the preview.");
    // Nothing will render here until the reader presses Compile. If the pane
    // has no content for this file, say so at once instead of leaving an empty
    // pane or, worse, another tab's preview.
    armPending({ immediate: true });
    // A PDF the store holds for exactly these inputs is current, so a return to
    // a manual tab may show it. Only a snapshot can tell, and the probe never
    // compiles or reports a failure.
    if (immediate && previewOwner === null && settings.viewMode !== "source") {
      const token = ++renderToken;
      const source = editor.getDoc();
      renderTimer = window.setTimeout(
        () => void renderLatexPreview(source, token, { storeOnly: true }),
        0,
      );
    }
    return;
  }
  if (settings.viewMode === "source") {
    // The pane is not on screen. A queued or in-flight render would only take
    // the main thread away from typing, and its answer must not claim the
    // buffer is current when the reader asks for the preview again.
    // The warm LaTeX engine survives Source mode; its in-flight result is
    // dropped by the token, and returning to Split compiles the newest text.
    renderToken += 1;
    proseScheduledAt = null;
    previewStale = true;
    previewSyncReady = false;
    clearPending();
    return;
  }
  const delayMs = immediate ? 0 : renderDelay();
  if (doc.language === "markdown" || doc.language === "asciidoc") {
    proseScheduledAt = immediate ? null : performance.now();
  } else {
    proseScheduledAt = null;
  }
  renderTimer = window.setTimeout(() => void doRender(), delayMs);
}

/** How long the preview may lag behind the buffer before it is rebuilt. */
/** The reader's recent typing rhythm, for the LaTeX interactive delay. */
const latexRhythm = new KeyRhythm();
/** Adaptive quiet delays for Markdown and AsciiDoc previews. */
const proseDelays = new ProseDelayTracker();
let proseScheduledAt: number | null = null;
/** Adaptive scheduler and latest-wins gate for Typst previews. */
const typstScheduler = new TypstCompileScheduler();
let typstLastCompileMs: number | null = null;
let typstEditSeq = 0;
let typstGateSeq = 0;
/** When the first edit not yet covered by a started LaTeX compile happened. */
let latexUnrenderedSince: number | null = null;
/** When the last LaTeX compile started. */
let latexLastStart: number | null = null;

/** How long the buffer stays quiet before the shadow compile starts. */
const LATEX_SHADOW_IDLE_MS = 1200;

function renderDelay(): number {
  // LaTeX used a fixed 800 ms before the engine was kept warm and compiles
  // stopped being cancelled by typing. Now the compile starts on the first
  // pause longer than this reader's rhythm (60-200 ms), and continuous typing
  // still compiles once every 1.5 s (docs/plans/2026-11-12-latex-compile-cost.md,
  // stage 1.5). Latest-wins keeps at most one compile running.
  // The frame follows every keystroke; the shadow compile waits for a pause.
  if (doc.language === "latex" && texpressoShowing()) return LATEX_SHADOW_IDLE_MS;
  if (doc.language === "latex") {
    const now = performance.now();
    if (staleBeyondCap(latexLastStart, latexUnrenderedSince, now)) return 0;
    return adaptiveDelay(latexRhythm.intervals());
  }
  if (doc.language === "html") return 300;
  if (doc.language === "asciidoc" || doc.language === "markdown") {
    return proseDelays.delay(doc.language);
  }
  if (doc.language === "typst") {
    return typstScheduler.delayFor(performance.now(), typstLastCompileMs);
  }
  return 200;
}

// The PDF.js page view currently on screen, if any. It owns the PDF document,
// its worker connection and the page canvases; replacing the preview must
// destroy it or a long session keeps every page it ever drew alive.
let typstPdf: TypstPdfPreview | null = null;
let typstPdfToken = -1;
let typstPdfBytes: Uint8Array | null = null;
/**
 * What the last successful Typst compile was for. A mode switch or a view
 * switch must reuse it instead of starting another compiler process. `key` is
 * its freshness key (`typstKey`); a match also needs `committedKey` to agree,
 * which a failure, a retirement or Compile clears.
 */
interface TypstRenderKey {
  key: string;
  docId: string;
  revision: number;
  mode: string;
  syncReady: boolean;
  /** The compile's result, so a restored preview can redraw its toolbar. */
  rendered: api.RenderedTypst;
  /** How long the compile took, as the toolbar shows it. */
  seconds: string;
  /** Source ranges already annotated on the cached Document DOM. */
  blocks?: BlockRange[];
}
let lastTypstRender: TypstRenderKey | null = null;

function disposeTypstPdf(): void {
  typstPdf?.dispose();
  typstPdf = null;
  typstPdfBytes = null;
}

function encodePdfBase64(bytes: Uint8Array): string {
  const chunk = 0x8000;
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += chunk) {
    parts.push(String.fromCharCode(...bytes.subarray(i, i + chunk)));
  }
  return btoa(parts.join(""));
}

let stagedPdf: { view: TypstPdfPreview; host: HTMLElement } | null = null;
let pendingPdfBookmark: {
  view: TypstPdfPreview;
  from: number;
  screenY: number;
  top: number;
  epoch: number;
} | null = null;
function discardStagedPdf(): void {
  stagedPdf?.view.dispose();
  stagedPdf?.host.remove();
  stagedPdf = null;
  pendingPdfBookmark = null;
}
function pdfMapReady(view: TypstPdfPreview, token: number): void {
  if (typstPdf !== view || typstPdfToken !== token || renderToken !== token) return;
  const bookmark = pendingPdfBookmark;
  if (bookmark?.view === view) {
    pendingPdfBookmark = null;
    if (
      bookmark.epoch === scrollOwnership.epoch &&
      Math.abs(previewPane.scrollTop - bookmark.top) < 1
    ) {
      suppressPreviewScrollUntil = performance.now() + SYNC_SUPPRESS_MS;
      view.restoreScroll({ from: bookmark.from, screenY: bookmark.screenY });
    }
  }
  syncPreviewFromSource();
}

/** Build a replacement without removing the PDF the reader is using. */
function stagedPdfHost(): HTMLDivElement {
  discardStagedPdf();
  const host = document.createElement("div");
  host.className = "typst-preview";
  // A fixed, hidden host has layout for PDF.js but cannot extend the pane's
  // scrollable overflow while the reader is still viewing the previous PDF.
  host.style.position = "fixed";
  host.style.visibility = "hidden";
  host.style.top = "0";
  host.style.left = "0";
  host.style.width = `${preview.clientWidth}px`;
  preview.style.position = "relative";
  preview.appendChild(host);
  return host;
}

/** Commit without allowing an empty host to clamp the pane to the first page. */
function commitPdfHost(host: HTMLElement, view: TypstPdfPreview, token: number): void {
  const old = typstPdf;
  const position = old?.topPosition() ?? null;
  const bookmark = old?.scrollBookmark() ?? null;
  const mapped = bookmark && old ? mapScrollOffset(old.source, view.source, bookmark.from) : null;
  const top = previewPane.scrollTop;
  const left = previewPane.scrollLeft;
  const atEnd = old?.atEnd() ?? false;
  const cursor = editor.cursorInfo();
  const nearSourceEnd = cursor.line >= editor.view.state.doc.lines - 12;
  const followTail = Boolean(
    old && atEnd && settings.syncScroll && settings.viewMode === "split" && nearSourceEnd,
  );
  const hadPendingScroll = pendingPreviewScroll !== null;
  // The decision is recorded rather than only applied: a viewport that does not
  // survive a rebuild is otherwise indistinguishable from one that was never
  // asked to, and the four inputs are cheap to keep.
  preview.dataset.pdfCommit = JSON.stringify({
    atEnd,
    syncScroll: settings.syncScroll,
    split: settings.viewMode === "split",
    nearSourceEnd,
    followTail,
    hadPendingScroll,
    hadPosition: position !== null,
    hadBookmark: bookmark !== null,
    mapped: mapped !== null,
    top,
    scrollHeight: previewPane.scrollHeight,
  });
  preview.style.minHeight = `${preview.getBoundingClientRect().height}px`;
  old?.dispose();
  preview.replaceChildren(host);
  host.style.position = "";
  host.style.visibility = "";
  host.style.top = "";
  host.style.left = "";
  host.style.width = "";
  stagedPdf = null;
  typstPdf = view;
  latexLastSourceScroll = null;
  typstPdfToken = token;
  view.activate();
  suppressPreviewScrollUntil = performance.now() + SYNC_SUPPRESS_MS;
  if (pendingPreviewScroll !== null) applyPendingPreviewScroll();
  else if (followTail) previewPane.scrollTop = previewPane.scrollHeight;
  else if (position)
    view.scrollToPagePosition(Math.min(position.page, view.pageCount()), position.y);
  else previewPane.scrollTop = top;
  preview.style.minHeight = "";
  previewPane.scrollLeft = left;
  if (!hadPendingScroll && !followTail && bookmark && mapped !== null) {
    pendingPdfBookmark = {
      view,
      from: mapped,
      screenY: bookmark.screenY,
      top: previewPane.scrollTop,
      epoch: scrollOwnership.epoch,
    };
    if (view.mapReady()) pdfMapReady(view, token);
  }
}

interface LatexPreview {
  result: LatexResult;
  rootId: string;
  rootDirectory: string;
  activeId: string;
  token: number;
  revisions: Array<{ id: string; revision: number; path: string | null }>;
}
let latexPreview: LatexPreview | null = null;

/**
 * The project the LaTeX preview is showing: its main document and the files
 * the last build read, relative to its directory.
 *
 * Both preview backends write it. WasmTex writes it with every result it puts on
 * screen; TeXpresso writes it from the snapshot it syncs, before any PDF exists.
 * The navigation pin reads it, so a chapter tab finds its main document under
 * either backend without waiting for a compile.
 */
interface LatexProjectRecord {
  rootId: string;
  rootDirectory: string;
  files: ReadonlySet<string>;
}
let latexProject: LatexProjectRecord | null = null;

function latexProjectOf(value: LatexPreview): LatexProjectRecord {
  return { rootId: value.rootId, rootDirectory: value.rootDirectory, files: value.result.files };
}

/** `path` relative to the project, or null when the project did not read it. */
function latexProjectFile(record: LatexProjectRecord, path: string | null): string | null {
  if (!path) return null;
  for (const file of record.files) {
    if (pathKey(joinDir(record.rootDirectory, file)) === pathKey(path)) return file;
  }
  return null;
}
/** The last measured LaTeX package cache, or null before the first read. */
let latexCacheInfo: api.LatexCacheInfo | null = null;
let latexCacheError: string | null = null;

/**
 * Re-read whether the bundled engine is installed and how big its cache is.
 *
 * Preferences fetches this only while the cached answer is empty, so every
 * action that changes either fact has to call this before it redraws. Without
 * it the panel kept the first answer ("Not installed") after a successful
 * download until the app restarted.
 */
async function refreshLatexCacheInfo(): Promise<void> {
  try {
    latexCacheInfo = await api.latexCacheInfo();
    latexCacheError = null;
  } catch (error) {
    latexCacheInfo = null;
    latexCacheError = String(error);
  }
}
/** What validation proved in this session, for the Preferences note. */
let latexNativeCaps: api.LatexNativeCapabilities | null = null;
/** Metadata-only candidates from the last Find, or null before one. */
let latexNativeCandidates: api.LatexNativeCandidate[] | null = null;
/** Registered WSL distributions from the last Find (registry only). */
let latexWslDistributions: api.LatexWslDistribution[] | null = null;
/** Engines found by an explicit look inside a WSL distribution. */
let latexWslCandidates: api.LatexWslCandidate[] | null = null;
/**
 * One look per distribution at a time.
 *
 * A click starts the distribution, probes it and then validates what it found.
 * Before this guard every impatient repeat click queued another WSL session —
 * the launches contend, each one looks slower, and the reader clicks again.
 * Sharing the outstanding promise makes the extra clicks harmless.
 */
const wslLooks = new Map<string, Promise<void>>();
/** One validation per distribution and engine directory at a time. */
const wslValidations = new Map<string, Promise<void>>();
/** The registered local libraries, or null before Preferences asked. */
let texmfConfig: api.LatexTexmfConfig | null = null;
/** The latest inspection per library id. */
const texmfReports = new Map<string, api.LatexTexmfReport>();
/** The library id or operation currently reading/changing local packages. */
let texmfBusyId: string | null = null;
let texmfError: string | null = null;
/** When the library list and reports were last read. */
let texmfLoadedAt = 0;
/** The library revision the current LaTeX preview was compiled from. */
let latexLibraryRevision: string | null = null;

let latexNavigationRoot: string | null = null;
/**
 * The main file of the last failed render.
 *
 * A failed compile leaves `latexPreview` null, and the old root rule then
 * treated the active tab as the project root. Clicking a problem in an included
 * chapter silently retargeted the project at that chapter; this keeps the main
 * file until a render succeeds or the reader opens another project.
 */
let latexProblemRoot: { path: string; directory: string } | null = null;
/**
 * The absolute keys of every file the failed snapshot contained.
 *
 * The root alone cannot answer "is this tab part of the project that failed?".
 * Two unrelated documents in one folder share a directory, so a pin that only
 * compared directories matched both: switching to a valid `.tex` file beside a
 * broken one kept compiling the broken one and showed its problems forever.
 * Membership in the failed snapshot is the question the pin means to ask.
 */
let latexProblemFiles: ReadonlySet<string> = new Set();
/** The problems of the last failed compile, for the marks and the list. */
let latexProblems: readonly LatexDiagnostic[] = [];
let selectedLatexProblem: { path: string; signature: string } | null = null;
/** The signature of the last auto-jumped list, so a re-render does not jump. */

let latexInFlight = false;
/** The owner token of the native job on screen, for Cancel. */
let latexJob: string | null = null;
/** The last engine status, so Preferences and the enable note agree. */
let latexEngine: api.LatexEngineStatus | null = null;

/**
 * Stop whichever backend is running.
 *
 * The bundled SDK is disposed synchronously; the native backend is a Rust
 * process tree, so its cancel command is asynchronous and the owner token is
 * cleared first. A late native result is dropped by the render token, not by
 * this function — cancelling must not wait for the process to die.
 */
function cancelLatex(): void {
  cancelBundledLatex();
  const job = latexJob;
  latexJob = null;
  if (job) void api.latexNativeCancel(job);
}

async function installLatexProgressListener(): Promise<void> {
  await listen<api.LatexNativeProgress>("latex-native-progress", (event) => {
    const progress = event.payload;
    if (!latexJob || progress.job !== latexJob || !latexInFlight) return;
    setLatexStatus(
      progress.phase === "bibliography"
        ? `Running ${progress.detail ?? "the bibliography tool"}…`
        : `Compiling with ${progress.detail ?? "the installed engine"}…`,
    );
  });
}

function configureCompiledUi(): void {
  const fileName = doc.path ? basename(doc.path) : "Untitled";
  if (doc.language === "latex")
    compiledUi.configure("latex", settings.latexAutoCompile !== false, "pages", fileName);
  else if (doc.language === "typst")
    compiledUi.configure(
      "typst",
      settings.typstAutoCompile !== false,
      settings.typstView,
      fileName,
    );
  else compiledUi.reset();
}

function compileCurrentDocument(): void {
  if (doc.language === "latex") return compileCurrentLatex();
  if (doc.language !== "typst") return;
  cancelTypstRender();
  renderToken += 1;
  discardStagedPdf();
  lastTypstRender = null;
  committedKey = null;
  forceNextBuild = true;
  if (previewOwner === null) {
    clearPending();
    armPending();
  }
  if (settings.viewMode === "source") setViewMode("split");
  window.clearTimeout(renderTimer);
  void doRender();
}

function cancelTypstBuild(): void {
  window.clearTimeout(renderTimer);
  cancelTypstRender();
  renderToken += 1;
  discardStagedPdf();
  previewStale = true;
  setTypstStatus("Compilation cancelled · Select Compile to update the preview.");
  if (previewOwner === null) showPendingIdle("Compilation cancelled.");
}

function setTypstStatus(message: string, saveable = false, state?: CompiledStatus): void {
  configureCompiledUi();
  compiledUi.status(message, typstInFlight !== null, saveable && !previewStale, state);
  syncMenuState(false);
  const phase = pending?.node?.querySelector<HTMLElement>(".preview-pending-phase");
  if (phase) phase.textContent = message;
  if (
    pending?.node &&
    (latexInFlight || typstInFlight !== null) &&
    pending.node.dataset.state === "idle"
  ) {
    pending.node.dataset.state = "pending";
    pending.startedAt = performance.now();
    const entry = pending;
    entry.tick = window.setInterval(() => updatePendingElapsed(entry), 1000);
  }
}

function compileCurrentLatex(): void {
  if (doc.language !== "latex") return;
  texpresso?.flush();
  // Compile is also the reader's retry after a frame failure.
  texpressoFailed.clear();
  // Compile always builds: the reader may be retrying a flaky engine or a
  // package fetch, and an unchanged key must not turn the button into a no-op.
  committedKey = null;
  forceNextBuild = true;
  if (previewOwner === null) {
    clearPending();
    armPending();
  }
  window.clearTimeout(renderTimer);
  renderToken += 1;
  // Not cancelLatex(): disposing would cold-boot the engine on every manual
  // Compile. `forceNextBuild` bypasses the result store; a crashed or hung
  // engine is replaced by the watchdog and the circuit breaker in latex.ts.
  discardStagedPdf();
  if (settings.viewMode === "source") setViewMode("split");
  window.clearTimeout(renderTimer);
  void doRender();
}

/**
 * The compile backend or engine changed: no PDF built before this moment is
 * current any more, and no build started before it may finish as current.
 *
 * The render token is the build owner, so bumping it invalidates both. In
 * manual mode nothing is compiled; the last PDF stays readable and the status
 * says it is out of date. With auto-compile on, the caller's `scheduleRender`
 * starts the new build.
 */
function invalidateLatexBuild(
  reason = "The engine changed; select Compile to update the preview.",
): void {
  // Kept PDFs were built by the previous engine or libraries. Their keys would
  // no longer match, but they would still hold memory.
  latexStore.clear();
  if (doc.language !== "latex") return;
  // The engine or a library is part of the key, but a library edit can keep a
  // revision string while its files change; the next build must not be skipped.
  committedKey = null;
  window.clearTimeout(renderTimer);
  renderToken += 1;
  cancelLatex();
  discardStagedPdf();
  delete preview.dataset.latexCurrent;
  latexInFlight = false;
  previewStale = true;
  if (settings.latexAutoCompile === false) {
    setLatexStatus(`Out of date · ${reason}`);
  }
  syncMenuState(false);
}

function cancelLatexBuild(): void {
  window.clearTimeout(renderTimer);
  renderToken += 1;
  cancelLatex();
  discardStagedPdf();
  latexInFlight = false;
  previewStale = true;
  setLatexStatus("Out of date · Compilation cancelled; an outstanding package request may finish.");
  // With no committed content the pane has only the wait to show. Leaving the
  // spinner turning after Cancel would say work is still happening.
  if (previewOwner === null) showPendingIdle("Compilation cancelled.");
}

/**
 * Turn automatic LaTeX compilation on or off.
 *
 * One setting with three visible controls — Preferences › LaTeX, Tools › Compile
 * LaTeX Automatically, and the toggle in the preview's status bar — so all
 * three are refreshed from here. `applySettingsPatch` owns what the change does
 * to a build in progress.
 */
function setLatexAutoCompile(on: boolean): void {
  if ((settings.latexAutoCompile !== false) === on) return;
  applySettingsPatch({ latexAutoCompile: on });
  preferences?.refresh();
  toast(
    on
      ? "LaTeX compiles automatically after edits."
      : "LaTeX compiles only when you select Compile.",
    3200,
  );
}

/** Reflect the setting in the preview's own toggle, wherever it changed. */
function syncLatexAutoToggle(): void {
  if (doc.language === "latex") configureCompiledUi();
}

function setLatexStatus(message: string, state?: CompiledStatus): void {
  if (doc.language !== "latex") return;
  if (latexInFlight) perfPhase(message);
  latexStatusLast = { message, state };
  configureCompiledUi();
  // With TeXpresso drawing, the line says both halves: the live preview, then
  // the PDF the shadow compile keeps for export.
  const live = texpressoShowing() ? texpressoLiveStatus() : "";
  compiledUi.status(
    live ? `${live} · ${message}` : message,
    latexInFlight,
    latexCurrent(latexPreview) || latexPartialCurrent(),
    state,
  );
  const phase = pending?.node?.querySelector<HTMLElement>(".preview-pending-phase");
  if (phase) phase.textContent = message;
  if (
    pending?.node &&
    (latexInFlight || typstInFlight !== null) &&
    pending.node.dataset.state === "idle"
  ) {
    pending.node.dataset.state = "pending";
    pending.startedAt = performance.now();
    const entry = pending;
    entry.tick = window.setInterval(() => updatePendingElapsed(entry), 1000);
  }
}

function showLatexWarnings(result: LatexResult, root: { path: string; directory: string }): void {
  const panel = latexProblemPanel(new LatexBuildError("", result.warnings), root, [
    ...result.files,
  ]);
  panel.querySelector(".latex-log")?.remove();
  compiledUi.details(panel, result.log, result.warnings.length, false);
  compiledUi.outputReady();
}

/**
 * The caret as a project-relative path and UTF-16 offset, for checkpoint
 * placement; undefined when the active file is not a .tex inside the project.
 */
function latexEditPoint(directory: string): { path: string; offset: number } | undefined {
  if (!doc.path || !/\.tex$/i.test(doc.path)) return undefined;
  const prefix = pathKey(directory) + "/";
  if (!pathKey(doc.path).startsWith(prefix)) return undefined;
  const path = doc.path.slice(directory.length + 1).replace(/\\/g, "/");
  return { path, offset: editor.view.state.selection.main.head };
}

/** Every open project text file, so a compile sees unsaved edits. */
function latexOverlays(directory: string): Parameters<typeof api.latexProjectSnapshot>[1] {
  const rootPrefix = pathKey(directory) + "/";
  return sessions
    .list()
    .filter(
      (session): session is Session & { path: string } =>
        session.path !== null &&
        pathKey(session.path).startsWith(rootPrefix) &&
        /\.(?:tex|bib|sty|cls|bst)$/i.test(session.path),
    )
    .map((session) => ({
      path: session.path,
      text: textOf(session),
      encoding: session.encoding,
      hadBom: session.hadBom,
      lineEnding: session.lineEnding,
    }));
}

/** The warm engine's identity: the project, the engine year and its local libraries. */
function latexProjectKey(
  rootPath: string,
  snapshot: api.LatexProjectSnapshot,
  engine: TexEngine = "lualatex",
): string {
  return JSON.stringify([
    pathKey(rootPath),
    LATEX_ENGINE_YEAR,
    snapshot.texmf?.revision ?? null,
    engine,
  ]);
}

/* ---------- Per-project TeX engine (stage 6.2) ---------- */

/** The engine the chip shows, for the main document it was resolved for. */
let engineChipChoice: (EngineChoice & { main: string }) | null = null;

/** The project's own engine choice, by main document. */
function projectEngine(mainPath: string | null): TexEngine | null {
  if (!mainPath) return null;
  const key = pathKey(mainPath);
  const entry = settings.latexProjectEngines?.find((item) => pathKey(item.main) === key);
  return entry && isTexEngine(entry.engine) ? entry.engine : null;
}

/** Magic comment, then the project's choice, then the Preferences default. */
function latexEngineChoice(root: Session): EngineChoice {
  return resolveTexEngine(textOf(root), projectEngine(root.path), settings.latexBundledEngine);
}

function showEngineChip(choice: EngineChoice, main: string): void {
  engineChipChoice = { ...choice, main };
  const label = ENGINE_LABELS[choice.engine];
  statusEngine.textContent = label;
  statusEngine.title =
    choice.source === "magic"
      ? `TeX engine: ${label} (${choice.reason}). Set by % !TeX program in the main file.`
      : `TeX engine: ${label} (${choice.reason}). Click to choose this project's engine.`;
  statusEngine.setAttribute("aria-label", `TeX engine: ${label}, ${choice.reason}`);
  statusEngine.hidden = doc.language !== "latex";
}

/**
 * Whether the current backend can typeset with `engine`. The production
 * preview ships LuaTeX and XeTeX together; the hidden WasmTex backend still
 * downloads its optional engines on first use.
 */
async function engineAvailable(engine: TexEngine): Promise<boolean> {
  if (latexPreviewBackend() === "texpresso") return engine === "lualatex" || engine === "xelatex";
  return engine === "lualatex" || (await api.latexEngineAvailable(engine));
}

/** Remember (or forget, with null) the project's engine and compile again. */
/** Download an optional engine the reader asked for; false when it failed. */
async function ensureEngine(engine: TexEngine): Promise<boolean> {
  if (await engineAvailable(engine)) return true;
  const label = ENGINE_LABELS[engine];
  setLatexStatus(`Downloading ${label}…`);
  try {
    await api.installLatexEngine(engine);
    return true;
  } catch (error) {
    setLatexStatus(`${label} could not be downloaded.`);
    toast(`${label} could not be downloaded: ${String(error)}`, 6000);
    return false;
  }
}

async function setProjectEngine(main: string, engine: TexEngine | null): Promise<void> {
  if (engine && !(await ensureEngine(engine))) return;
  const key = pathKey(main);
  const others = (settings.latexProjectEngines ?? []).filter((item) => pathKey(item.main) !== key);
  const next = engine ? [{ main, engine }, ...others].slice(0, 50) : others;
  // A rendering input: the patch compiles the project again.
  await applySettingsPatch({ latexProjectEngines: next });
}

/** The chip's menu: the three engines, with the download size of a missing one. */
async function openEngineMenu(): Promise<void> {
  const choice = engineChipChoice;
  if (!choice) return;
  const entries: Array<[string, () => void]> = [];
  if (choice.source === "magic") {
    // The magic comment decides, so there is nothing to choose; but an engine
    // it names that is not downloaded yet must be obtainable from here, or the
    // preview's "download it from the chip" would point at a dead control.
    const label = ENGINE_LABELS[choice.engine];
    const available = await engineAvailable(choice.engine);
    const size = (optionalEngineBytes(choice.engine) / 1048576).toFixed(1);
    const why = choice.reason === "magic comment" ? "" : `; ${choice.reason}`;
    entries.push(
      available
        ? [`Set by % !TeX program in the main file (${label}${why})`, () => {}]
        : [
            `Download ${label} (${size} MB), named by % !TeX program`,
            () =>
              void ensureEngine(choice.engine).then((ok) => {
                if (ok && doc.language === "latex") scheduleRender(true);
              }),
          ],
    );
  } else {
    for (const engine of ["lualatex", "xelatex"] as const) {
      const mark = engine === choice.engine ? "✓ " : "";
      const available = await engineAvailable(engine);
      const size = optionalEngineBytes(engine);
      const note = available || !size ? "" : ` — download ${(size / 1048576).toFixed(1)} MB`;
      entries.push([
        `${mark}${ENGINE_LABELS[engine]}${note}`,
        () => void setProjectEngine(choice.main, engine),
      ]);
    }
    if (projectEngine(choice.main))
      entries.push(["Use the Preferences default", () => void setProjectEngine(choice.main, null)]);
  }
  const bounds = statusEngine.getBoundingClientRect();
  openRowMenu(entries, bounds.left, bounds.top - 4 - entries.length * 30, statusEngine);
}

/** Current bundled compiles since the last re-anchoring compare. */
let commitsSinceAnchor = 0;
let reanchorTimer = 0;
let reanchoring = false;
/** Compare after this many compiles, once the reader has been idle for a moment. */
const REANCHOR_EVERY = 25;
const REANCHOR_IDLE_MS = 3000;

let recycleTimer = 0;
const RECYCLE_IDLE_MS = 5000;

/** Recycle the warm engine at idle once it has done enough compiles (Phase 4.1). */
function scheduleRecycle(): void {
  if (latexEngineInfo().compiles < RECYCLE_AFTER_COMPILES) return;
  window.clearTimeout(recycleTimer);
  recycleTimer = window.setTimeout(() => void recycleLatexEngine(), RECYCLE_IDLE_MS);
}

async function recycleLatexEngine(): Promise<void> {
  const value = latexPreview;
  if (doc.language !== "latex" || !value || !latexCurrent(value)) return;
  const root = sessions.byId(value.rootId);
  if (!root?.path || !root.directory) return;
  try {
    const snapshot = await api.latexProjectSnapshot(root.path, latexOverlays(root.directory));
    if (!latexCurrent(value)) return;
    await recycleWarmEngine(
      snapshot,
      latexProjectKey(root.path, snapshot, latexEngineInfo().engine ?? "lualatex"),
      renderToken,
    );
  } catch {
    // The old engine keeps working; the next idle moment tries again.
  }
}

function scheduleReanchor(): void {
  commitsSinceAnchor += 1;
  if (commitsSinceAnchor < REANCHOR_EVERY) return;
  window.clearTimeout(reanchorTimer);
  reanchorTimer = window.setTimeout(() => void reanchorLatex("idle"), REANCHOR_IDLE_MS);
}

/**
 * Re-anchoring (stage 3.4 of docs/plans/2026-11-12-latex-compile-cost.md).
 *
 * The warm engine resumes from heap checkpoints and keeps auxiliary files, so
 * its output is periodically compared, page text by page text, with a fresh
 * full compile of the same inputs. A difference stops incremental builds for
 * the project (the circuit breaker) and recompiles from scratch: speed never
 * buys a wrong preview. Runs at idle, or on the hidden `view.latexReanchor`
 * command the differential test uses; the outcome is a `reanchor` measure.
 */
async function reanchorLatex(reason: "idle" | "command"): Promise<void> {
  window.clearTimeout(reanchorTimer);
  const value = latexPreview;
  if (reanchoring || doc.language !== "latex" || !value || !latexCurrent(value)) {
    perfMark("reanchor-skipped", { reason, why: reanchoring ? "busy" : "no current result" });
    return;
  }
  if (latexEngine?.backend !== "bundled") {
    perfMark("reanchor-skipped", { reason, why: "not the bundled engine" });
    return;
  }
  const root = sessions.byId(value.rootId);
  if (!root?.path || !root.directory) return;
  reanchoring = true;
  const started = perfMark("reanchor-start", { reason });
  try {
    const snapshot = await api.latexProjectSnapshot(root.path, latexOverlays(root.directory));
    const fresh = latexCurrent(value)
      ? await compileFresh(snapshot, renderToken, latexEngineInfo().engine ?? "lualatex")
      : null;
    if (!fresh || !latexCurrent(value)) {
      perfMark("reanchor-skipped", {
        reason,
        why: fresh ? "edited meanwhile" : "fresh build failed",
      });
      return;
    }
    const [warmText, freshText] = await Promise.all([
      pdfPageTexts(value.result.pdf),
      pdfPageTexts(fresh),
    ]);
    const firstDifference = freshText.findIndex((text, index) => text !== warmText[index]);
    const equal = warmText.length === freshText.length && firstDifference < 0;
    perfMeasure("reanchor", started, {
      reason,
      equal,
      pages: [warmText.length, freshText.length],
      firstDifferentPage: equal
        ? null
        : firstDifference < 0
          ? freshText.length + 1
          : firstDifference + 1,
    });
    commitsSinceAnchor = 0;
    if (!equal) {
      distrustWarmEngine(
        latexProjectKey(root.path, snapshot, latexEngineInfo().engine ?? "lualatex"),
      );
      toast(
        "An incremental LaTeX build differed from a full build. This project now compiles from scratch.",
        6500,
      );
      forceNextBuild = true;
      scheduleRender(true);
    }
  } catch (error) {
    perfMark("reanchor-skipped", { reason, why: String(error) });
  } finally {
    reanchoring = false;
  }
}

/** The render token of the LaTeX PDF on screen, current or out of date. */
let latexShownToken = 0;
/** One installed-TeX process at a time; the newest waiting revision runs next. */
const nativeGate = new LatestWinsGate();

/** True while a LaTeX compile holds the engine (bundled or installed). */
function latexBusy(): boolean {
  return latexEngineInfo().busy || nativeGate.holder !== null;
}

/**
 * Whether a finished result may be put on screen: it is current, or it is
 * newer than what is shown and still describes this document's project
 * (the same tab, an open root, no session rewound or renamed). See the result
 * router in docs/plans/2026-11-12-latex-compile-cost.md.
 */
function latexDisplayable(value: LatexPreview): boolean {
  // Through a plain boolean: the type guard would narrow `value` to never below.
  const current: boolean = latexCurrent(value);
  if (current) return true;
  return (
    settings.viewMode !== "source" &&
    value.activeId === doc.id &&
    value.token > latexShownToken &&
    sessions.byId(value.rootId) !== undefined &&
    value.revisions.every((item) => {
      const session = sessions.byId(item.id);
      return !session || (session.path === item.path && session.revision >= item.revision);
    })
  );
}

function latexCurrent(value: LatexPreview | null): value is LatexPreview {
  return Boolean(
    value &&
    value.token === renderToken &&
    value.activeId === doc.id &&
    value.revisions.every((item) => {
      const session = sessions.byId(item.id);
      return session?.revision === item.revision && session.path === item.path;
    }),
  );
}

/** The parts of the engine status that decide which compiler builds the PDF. */
function latexEngineIdentity(status: api.LatexEngineStatus): LatexEngineIdentity {
  return {
    backend: status.backend,
    nativeRoot: status.nativeRoot,
    nativeDistribution: status.nativeDistribution,
    nativeEngine: status.nativeEngine,
    nativeWsl: status.nativeWsl ? `${status.nativeWsl.distro}:${status.nativeWsl.bin}` : null,
  };
}

/**
 * Hand the PDF on screen to this render when it was built from exactly these
 * inputs, instead of compiling again.
 *
 * `key` is built from the snapshot's content digest, so it matches only when
 * every file the compile would read is byte-identical to the last successful
 * build's, under the same root and engine: a save of a buffer the preview
 * already showed, an edit that was undone, a move to another chapter of the same
 * project. The render token, the active document and the revisions are then
 * rebound the way a chapter handoff rebinds them, and the success state —
 * warnings, status, Export › PDF — is restored, because an edit cleared it.
 *
 * Returns false, changing nothing, when anything does not line up.
 */
function rebindLatexPreview(
  key: string,
  root: Session,
  source: string,
  token: number,
  activeId: string,
  revisions: LatexPreview["revisions"],
): boolean {
  const value = latexPreview;
  const view = typstPdf;
  if (
    key !== committedKey ||
    !value ||
    !view ||
    typstPdfToken !== value.token ||
    value.rootId !== root.id ||
    !root.path ||
    !root.directory ||
    !covers(previewOwner, probeOf(doc))
  )
    return false;
  const file = latexRelative(value, doc.path);
  if (file === null) return false;

  value.token = token;
  value.activeId = activeId;
  value.revisions = revisions;
  typstPdfToken = token;
  // The map follows one file of the project. Another chapter, or the same file
  // with a different text (an edit and its undo produce the same digest only
  // when the text is identical, so this is the chapter case), needs it rebuilt.
  if (view.currentFile !== file || view.source !== source) view.setActiveFile(file, source);
  else if (settings.viewMode === "split") view.ensureMap();
  if (pendingPreviewScroll !== null) applyPendingPreviewScroll();
  if (view.mapReady()) pdfMapReady(view, token);
  latexPartial = null;
  delete preview.dataset.latexPartial;
  preview.dataset.latexCurrent = String(token);
  commitPreview(previewOwner!, key);
  previewSyncReady = true;
  latexInFlight = false;

  const result = value.result;
  const rootRef = { path: root.path, directory: root.directory };
  latexProblems = result.warnings;
  latexProblemRoot = null;
  latexProblemFiles = new Set();
  editor.clearDiagnostics();
  // As after a compile: a warning the reader selected stays marked while the
  // same warning still exists. Entering Split from a warning click lands here,
  // and dropping the mark would undo the click that asked for it.
  const selected =
    selectedLatexProblem?.path === pathKey(doc.path ?? "")
      ? result.warnings.find(
          (problem) => diagnosticSignature(problem) === selectedLatexProblem?.signature,
        )
      : null;
  if (selected) applyLatexMarks([selected], rootRef, doc.path, false);
  else selectedLatexProblem = null;
  showLatexWarnings(result, rootRef);
  const seconds = ((result.elapsedMs ?? 0) / 1000).toFixed(1);
  const warnings = result.warnings.length
    ? ` · ${result.warnings.length}${result.warningsTruncated ? "+" : ""} warning${result.warnings.length === 1 && !result.warningsTruncated ? "" : "s"}`
    : "";
  setLatexStatus(`Up to date · ${result.engine ?? "LaTeX"}${warnings}`, {
    label: "PDF ready",
    severity: result.warnings.length ? "warning" : "success",
    detail: compiledUi.issueSummary,
    engine: `${result.engine ?? "LaTeX"} · ${seconds} s`,
  });
  syncMenuState(false);
  return true;
}

function latexRelative(value: LatexPreview, path: string | null): string | null {
  return latexProjectFile(latexProjectOf(value), path);
}

/**
 * The problem list a failed LaTeX build shows in the pane.
 *
 * Each row is a button: the place, the message, and the **line the compiler
 * read**. The last part is what ends the "I commented it and the error stays"
 * loop — if the row still contains the command, the compile used different
 * text, and the reader can see which file and line it did use.
 */
function latexProblemPanel(
  error: unknown,
  root: { path: string; directory: string } | null,
  files: readonly string[],
): HTMLElement {
  const problems = error instanceof LatexBuildError ? error.diagnostics : [];
  const wrap = document.createElement("div");
  wrap.className = "latex-problems";
  if (problems.length) {
    const head = document.createElement("div");
    head.className = "latex-problems-head";
    head.textContent =
      problems.length === 1 ? "1 LaTeX problem" : `${problems.length} LaTeX problems`;
    wrap.append(head);

    const list = document.createElement("ol");
    list.className = "latex-problems-list";
    for (const problem of problems) {
      const item = document.createElement("li");
      const actionable = Boolean(
        root &&
        problem.line > 0 &&
        problem.lineText &&
        projectRelative(problem.file) &&
        files.includes(problem.file),
      );
      const button = document.createElement(actionable ? "button" : "div");
      if (button instanceof HTMLButtonElement) button.type = "button";
      button.className = "latex-problem";
      button.dataset.severity = problem.severity;
      const place = document.createElement("span");
      place.className = "latex-problem-place";
      place.textContent = diagnosticPlace(problem);
      const message = document.createElement("span");
      message.className = "latex-problem-message";
      message.textContent = problem.message;
      const severity = document.createElement("span");
      severity.className = "latex-problem-severity";
      severity.textContent = problem.severity === "warning" ? "Warning" : "Error";
      button.append(place, severity, message);
      if (problem.lineText) {
        const source = document.createElement("code");
        source.className = "latex-problem-source";
        source.textContent = problem.lineText;
        source.title = "The line the compiler read";
        button.append(source);
      }
      if (problem.searched.length > 1) {
        button.title = `Looked for: ${problem.searched.join(", ")}`;
      }
      if (actionable)
        button.addEventListener("click", () => void revealLatexProblem(problem, root, true));
      else if (!button.title)
        button.title =
          problem.file && !projectRelative(problem.file)
            ? "Reported inside a compiler package; no matching source line in this project."
            : "The compiler did not provide a matching project source line.";
      item.append(button);
      list.append(item);
    }
    wrap.append(list);

    if (error instanceof LatexBuildError && error.truncated) {
      const more = document.createElement("p");
      more.className = "latex-problems-more";
      more.textContent = "More problems were omitted; see the compiler output.";
      wrap.append(more);
    }
  }

  // The raw log stays one click away, and `.typst-error` stays the element the
  // existing preview suites read, so a failed chip or compile is still visible
  // to them.
  const details = document.createElement("details");
  details.className = "latex-log";
  if (!problems.length) details.open = true;
  const summary = document.createElement("summary");
  summary.textContent = problems.length ? "Compiler output" : "Details";
  const box = document.createElement("pre");
  box.className = "typst-error";
  const log = error instanceof LatexBuildError ? error.log : "";
  box.textContent = log ? `${String(error)}\n\n${log}` : String(error);
  details.append(summary, box);
  wrap.append(details);
  return wrap;
}

/**
 * Whether a diagnostic names a file inside the project.
 *
 * The compiler occasionally reports an absolute path or a temporary file. Those
 * are still shown, but they must not be joined to the project root and opened.
 */
function projectRelative(file: string): boolean {
  return (
    Boolean(file) &&
    !/^[A-Za-z]:/.test(file) &&
    !file.startsWith("/") &&
    !file.startsWith("\\") &&
    !file.split("/").includes("..")
  );
}

/** The problems this project file owns, keyed by absolute path. */
function latexProblemsForPath(
  problems: readonly LatexDiagnostic[],
  root: { path: string; directory: string } | null,
  path: string | null,
): LatexDiagnostic[] {
  if (!path || !root) return [];
  const key = pathKey(path);
  return problems.filter((problem) => {
    if (!problem.file || problem.line < 1 || !projectRelative(problem.file)) return false;
    return pathKey(joinDir(root.directory, problem.file)) === key;
  });
}

/** Paint the marks for one document, from the last compile's problem list. */
function applyLatexMarks(
  problems: readonly LatexDiagnostic[],
  root: { path: string; directory: string } | null,
  path: string | null,
  pulse: boolean,
): void {
  if (!path || !root) {
    editor.clearDiagnostics();
    return;
  }
  const text = editor.getDoc();
  const ranges = latexProblemsForPath(problems, root, path)
    .filter(latexProblemMatchesLine)
    .map((problem) => {
      const mapped = diagnosticRange(text, problem);
      return mapped ? { from: mapped.from, to: mapped.to, lineFrom: mapped.lineFrom } : null;
    })
    .filter((range): range is { from: number; to: number; lineFrom: number } => range !== null);
  editor.setDiagnostics(ranges, pulse);
}

function latexProblemMatchesLine(problem: LatexDiagnostic): boolean {
  return Boolean(
    problem.lineText &&
    problem.line > 0 &&
    problem.line <= editor.view.state.doc.lines &&
    lineTextOf(editor.view.state.doc.line(problem.line).text) === problem.lineText,
  );
}

/**
 * Activate a problem's file and reveal its line.
 *
 * `focus` is true only for a click: an automatic jump after a failed compile
 * must not move the caret while the reader is still working.
 */
async function revealLatexProblem(
  problem: LatexDiagnostic,
  root: { path: string; directory: string } | null,
  focus: boolean,
): Promise<void> {
  if (!root || !problem.file || !projectRelative(problem.file)) return;
  const path = joinDir(root.directory, problem.file);
  const belongsToFailure = latexProblemFiles.has(pathKey(path));
  const belongsToPreview = latexPreview?.result.sources.some(
    (source) => source.path === problem.file,
  );
  if (!belongsToFailure && !belongsToPreview) return;
  const existing = sessions.findByPath(path);
  if (existing) {
    if (existing.id !== doc.id) await activateSession(existing.id);
  } else {
    await openPath(path, { silent: true, rememberRecent: false });
  }
  if (!doc.path || pathKey(doc.path) !== pathKey(path)) return;
  if (!latexProblemMatchesLine(problem)) {
    toast("The source line changed; compile again to update this location.");
    return;
  }
  if (focus && settings.viewMode === "preview") setViewMode("split");
  selectedLatexProblem = { path: pathKey(path), signature: diagnosticSignature(problem) };
  applyLatexMarks([problem], root, doc.path, true);
  const mapped = diagnosticRange(editor.getDoc(), problem);
  if (!mapped) return;
  editor.revealOffset(mapped.from);
  if (focus) {
    editor.view.dispatch({ selection: { anchor: mapped.from } });
    editor.focus();
  }
}

/**
 * Whether `path` is one of the files the failed compile actually read.
 *
 * This is the question the root pin has to ask. Comparing directories instead
 * was the bug: `main.tex` and an unrelated `notes.tex` beside it share a folder,
 * so every tab switch in that folder looked like "still inside the failed
 * project" and recompiled the broken main file forever.
 */
function inLatexProblemProject(path: string | null): boolean {
  return latexProjectMember(path, latexProblemRoot?.path ?? null, [...latexProblemFiles], pathKey);
}

let latexPartial: {
  pdf: Uint8Array;
  token: number;
  activeId: string;
  rootPath: string;
  revision: number;
  revisions: LatexPreview["revisions"];
} | null = null;

function latexPartialCurrent(): boolean {
  const value = latexPartial;
  return Boolean(
    value &&
    value.token === renderToken &&
    value.activeId === doc.id &&
    value.revision === doc.revision &&
    preview.dataset.latexPartial === String(value.token) &&
    value.revisions.every((item) => {
      const current = sessions.byId(item.id);
      return current?.revision === item.revision && current.path === item.path;
    }),
  );
}

async function latexFailure(
  error: unknown,
  root: { path: string; directory: string } | null = null,
  files: readonly string[] = [],
  attempt?: Omit<LatexPreview, "result">,
  build?: { engine: string; elapsedMs: number },
): Promise<void> {
  // Whatever stays on screen — the last good PDF, a partial one or a note — no
  // longer vouches for the inputs; the next render must build.
  committedKey = null;
  delete preview.dataset.latexCurrent;
  delete preview.dataset.latexPartial;
  latexPartial = null;
  const panel = latexProblemPanel(error, root, files);
  panel.querySelector(".latex-log")?.remove();
  const issues = error instanceof LatexBuildError ? error.diagnostics : [];
  const output =
    error instanceof LatexBuildError ? `${String(error)}\n\n${error.log}` : String(error);
  compiledUi.details(panel, output, issues.length, true);
  // A missing class or package is often one that lives in a local library the
  // reader has not registered (or turned off). The action sits in the Logs
  // problem panel, never over the PDF.
  if (/File `[^`']+\.(?:cls|sty)' not found|local library/i.test(output)) {
    const manage = document.createElement("button");
    manage.type = "button";
    manage.className = "typst-notebutton latex-manage-libraries";
    manage.textContent = "Manage local packages…";
    manage.addEventListener("click", () => focusLocalLibraries());
    panel.prepend(manage);
  }
  const partial = error instanceof LatexBuildError ? error.partialPdf : null;
  const token = renderToken;
  const activeId = doc.id;
  const revision = doc.revision;
  const revisions =
    attempt?.revisions ?? sessions.list().map(({ id, revision, path }) => ({ id, revision, path }));
  let shownPartial = false;
  const live = texpressoShowing();
  if (!live && partial && new TextDecoder().decode(partial.subarray(0, 5)) === "%PDF-") {
    latexInFlight = true;
    setLatexStatus("Rendering PDF with errors…");
    const host = stagedPdfHost();
    const view = new TypstPdfPreview(
      host,
      previewPane,
      syncSourceFromPageSelection,
      editor.getDoc(),
      {
        language: "latex",
        files: [],
        activeFile: "",
        enabled: false,
        detached: true,
      },
    );
    stagedPdf = { view, host };
    view.setZoom(zoomFactor());
    try {
      await view.render(partial.slice(), { focusPage: typstPdf?.topPosition()?.page });
      if (token !== renderToken || activeId !== doc.id) {
        view.dispose();
        host.remove();
        return;
      }
      commitPdfHost(host, view, token);
      latexPartial = {
        pdf: partial.slice(),
        token,
        activeId,
        revision,
        revisions,
        rootPath: root?.path ?? doc.path ?? "document.tex",
      };
      preview.dataset.latexPartial = String(token);
      shownPartial = true;
    } catch (failure) {
      if (token !== renderToken || activeId !== doc.id) return;
      discardStagedPdf();
      compiledUi.details(
        panel,
        `${output}\n\nCould not render partial PDF: ${String(failure)}`,
        issues.length,
        true,
      );
    }
  }
  if (token !== renderToken || activeId !== doc.id) return;
  latexInFlight = false;
  if (live) {
    // The frame keeps drawing what TeXpresso typesets; only the export PDF
    // failed, and Logs says why without covering the preview.
    compiledUi.outputReady();
  } else if (!typstPdf) {
    preview.replaceChildren();
    const empty = document.createElement("div");
    empty.className = "compiled-empty";
    empty.textContent = "No PDF produced. Open Logs for the compilation problems.";
    preview.append(empty);
    compiledUi.showLogs(true, false);
  } else compiledUi.outputReady();
  previewSyncReady = false;
  const problems = error instanceof LatexBuildError ? error.diagnostics : [];
  latexProblems = problems;
  latexProblemRoot = root ? { ...root } : null;
  // Record the project's actual file set, so a later tab switch can tell "inside
  // the failed project" from "merely in the same folder".
  latexProblemFiles = new Set(
    files.map((file) => pathKey(root ? joinDir(root.directory, file) : file)),
  );
  // A failure panel belongs to the project too: moving to a chapter of the
  // failed project may keep the problems visible while the next build runs.
  // The owner uses the set this failure records, not the previous failure's.
  const failureRoot = root ? sessions.findByPath(root.path) : undefined;
  const failureRootPath = failureRoot?.path ?? null;
  commitPreview(
    failureRoot && failureRootPath
      ? projectOwner(failureRoot, [...latexProblemFiles, pathKey(failureRootPath)])
      : documentOwner(doc),
  );
  if (root) {
    applyLatexMarks(problems, root, doc.path, true);
  } else {
    latexProblemRoot = null;
    latexProblemFiles = new Set();

    editor.clearDiagnostics();
  }
  setLatexStatus(
    live
      ? "PDF for export failed · See Logs."
      : shownPartial
        ? "PDF with errors · Compilation reported problems; see Logs."
        : typstPdf
          ? "Build failed · Showing previous PDF; see Logs."
          : "No PDF produced · See Logs.",
    {
      label: shownPartial ? "PDF with errors" : typstPdf ? "Build failed" : "No PDF produced",
      severity: "error",
      detail: [
        typstPdf && !shownPartial ? "Showing previous PDF" : "",
        compiledUi.issueSummary || "See Logs",
      ]
        .filter(Boolean)
        .join(" · "),
      engine: build ? `${build.engine} · ${(build.elapsedMs / 1000).toFixed(1)} s` : undefined,
    },
  );
  syncMenuState(false);
}

function showLatexLicenses(): void {
  void import("./latex-licenses").then(({ LATEX_LICENSES }) => showBuiltin(LATEX_LICENSES));
}

/**
 * Probe and commit an installed distribution.
 *
 * Validation is the explicit action that executes external code: it reads each
 * tool's version and compiles a one-page document. Nothing is saved unless the
 * probe produces a readable PDF.
 */
/**
 * A library was added, removed, reordered, switched or edited: any running
 * compile is superseded (its token can no longer publish) and the preview is
 * stale. Auto-compile rebuilds; manual mode stays manual.
 */
function latexLibrariesChanged(reason: string): void {
  latexStore.clear();
  latexLibraryRevision = null;
  if (doc.language !== "latex") return;
  invalidateLatexBuild(`${reason}; select Compile to update the preview.`);
  if (settings.latexAutoCompile !== false) scheduleRender(true);
}

/** Open Preferences › LaTeX on the local library group, focused for the keyboard. */
function focusLocalLibraries(): void {
  preferences.openAt("latex");
  window.setTimeout(() => {
    const heading = [...document.querySelectorAll<HTMLElement>(".prefs-panel *")].find(
      (element) =>
        element.children.length === 0 && element.textContent?.trim() === "Local packages",
    );
    if (!heading) return;
    heading.scrollIntoView({ block: "start" });
    const rows = [
      ...document.querySelectorAll<HTMLElement>(".prefs-panel button, .prefs-panel input"),
    ];
    const first = rows.find(
      (control) =>
        heading.compareDocumentPosition(control) & Node.DOCUMENT_POSITION_FOLLOWING &&
        !(control as HTMLButtonElement).disabled,
    );
    first?.focus();
  }, 120);
}

async function refreshTexmf(ids?: string[]): Promise<void> {
  texmfBusyId = ids?.[0] ?? "all";
  texmfError = null;
  texmfLoadedAt = Date.now();
  try {
    texmfConfig = await api.latexTexmfList();
    texmfLoadedAt = Date.now();
    if (!ids) texmfReports.clear();
    for (const report of await api.latexTexmfInspect({ ids })) {
      if (report.id) texmfReports.set(report.id, report);
    }
  } catch (error) {
    texmfError = `Could not check the folder: ${String(error)}`;
  } finally {
    texmfLoadedAt = Date.now();
    texmfBusyId = null;
  }
}

async function texmfConfigure(action: api.LatexTexmfAction): Promise<boolean> {
  if (texmfBusyId !== null) return false;
  texmfBusyId = "configure";
  preferences.refresh();
  try {
    texmfConfig = await api.latexTexmfConfigure(action);
    settings.latexTexmfRoots = texmfConfig.roots.map(({ id, kind, path, layout, enabled }) => ({
      id,
      kind,
      path,
      layout,
      enabled,
    }));
    latexLibrariesChanged("The local libraries changed");
    await refreshTexmf();
    return true;
  } catch (error) {
    await message(String(error), {
      title: "Could not change the local packages folder",
      kind: "error",
    });
    return false;
  } finally {
    texmfBusyId = null;
    preferences.refresh();
  }
}

let texmfFocusCheck = false;
/**
 * On focus, a library file may have changed in another program. Compare the
 * enabled libraries' revision with the one the preview was built from; reading
 * is bounded and coalesced, and nothing runs while typing or for other files.
 */
async function checkLibrariesOnFocus(): Promise<void> {
  if (texmfFocusCheck || doc.language !== "latex" || !latexPreview) return;
  if (!settings.latexTexmfRoots?.some((root) => root.enabled) && latexLibraryRevision === null)
    return;
  texmfFocusCheck = true;
  const before = latexLibraryRevision;
  try {
    const current = await api.latexTexmfRevision().catch(() => "unavailable");
    if (current !== before && latexLibraryRevision === before) {
      latexLibrariesChanged("A local library changed");
    }
  } finally {
    texmfFocusCheck = false;
  }
}
window.addEventListener("focus", () => {
  void checkLibrariesOnFocus();
  if (
    preferences.isOpen() &&
    document.querySelector(".prefs-local-packages") &&
    texmfBusyId === null &&
    Date.now() - texmfLoadedAt > 2000
  ) {
    void refreshTexmf().then(() => preferences.refresh());
  }
});

/** The one message a finished validation shows, on either backend. */
function validatedEngineMessage(distribution: string): string {
  return settings.latexNativeEnabled
    ? `${distribution} validated and in use.`
    : `${distribution} validated. Turn on "Use my installed TeX distribution" in Preferences › LaTeX to compile with it.`;
}

function validateWslInstallation(distro: string, bin: string): Promise<void> {
  const key = `${distro}\u0000${bin}`;
  const running = wslValidations.get(key);
  if (running) return running;
  const work = (async () => {
    const notice = toast(`Validating ${bin} in ${distro}…`, 0);
    try {
      const capabilities = await api.latexNativeWslValidate(distro, bin);
      latexNativeCaps = capabilities;
      latexEngine = await api.latexEngineStatus();
      // The backend cleared the host path; keep the in-memory copy in step so a
      // later whole-settings save does not write it back.
      settings.latexNativeRoot = null;
      settings.latexNativeWsl = latexEngine.nativeWsl;
      persist();
      toast(validatedEngineMessage(capabilities.distribution), 8200);
    } catch (error) {
      await message(String(error), {
        title: "Could not validate TeX in WSL",
        kind: "error",
      });
    } finally {
      notice.dismiss();
      preferences.refresh();
    }
  })();
  wslValidations.set(key, work);
  const clear = () => wslValidations.delete(key);
  void work.then(clear, clear);
  return work;
}

async function validateNativeDirectory(directory: string): Promise<void> {
  const notice = toast(`Validating ${directory}…`, 0);
  try {
    const capabilities = await api.latexNativeValidate(directory);
    latexNativeCaps = capabilities;
    settings.latexNativeRoot = capabilities.bin;
    settings.latexNativeWsl = null;
    latexEngine = await api.latexEngineStatus();
    persist();
    toast(validatedEngineMessage(capabilities.distribution), 8200);
  } catch (error) {
    await message(String(error), {
      title: "Could not validate this TeX installation",
      kind: "error",
    });
  } finally {
    notice.dismiss();
    preferences.refresh();
  }
}

function latexEnableNote(status?: api.LatexEngineStatus | null): void {
  preview.replaceChildren();
  const note = document.createElement("div");
  note.className = "typst-note";
  const text = document.createElement("span");
  text.className = "typst-note-text";
  text.textContent = status?.bundledEnabled
    ? `Bundled TeX is on, but its preview files are missing or out of date. Press Retry setup to download the TeX Live ${TEXPRESSO_TEXLIVE_YEAR} preview engine (about ${TEXPRESSO_ENGINE_MIB} MiB); packages and fonts follow on demand.`
    : "LaTeX compiles .tex documents locally. Enable bundled TeX, or choose a TeX distribution already on this computer in Preferences › LaTeX. Your document stays on this device.";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "typst-notebutton";
  button.textContent = status?.bundledEnabled ? "Retry setup" : "Enable bundled TeX…";
  button.addEventListener("click", () => {
    button.disabled = true;
    button.textContent = "Downloading…";
    void api
      .installTexpresso()
      .then(() => {
        // The switch is settings-backed, so the in-memory copy has to follow it
        // before the next render; otherwise the note would come back.
        settings.latexEnabled = true;
        persist();
        void refreshLatexCacheInfo().then(() => preferences?.refresh());
        scheduleRender(true);
      })
      .catch((error: unknown) => {
        button.disabled = false;
        button.textContent = "Retry setup";
        toast(`Could not enable bundled TeX: ${String(error)}`, 6200);
      });
  });
  const installed = document.createElement("button");
  installed.type = "button";
  installed.className = "typst-notebutton";
  installed.textContent = "LaTeX Preferences…";
  installed.addEventListener("click", () => preferences.openAt("latex"));
  const licenses = document.createElement("button");
  licenses.type = "button";
  licenses.className = "typst-notebutton";
  licenses.textContent = "Licences and source";
  licenses.addEventListener("click", showLatexLicenses);
  note.append(text, button, installed, licenses);
  preview.appendChild(note);
}

async function latexSavePdf(): Promise<void> {
  if (latexPartialCurrent() && latexPartial) {
    const value = latexPartial;
    await saveCompiledPdf({
      data: bytesToBase64(value.pdf),
      token: value.token,
      sessionId: value.activeId,
      revision: value.revision,
      revisions: value.revisions,
      engine: "LaTeX",
      title: "Save PDF with compilation errors",
      defaultPath: value.rootPath.replace(/\.tex$/i, "-partial.pdf"),
    });
    return;
  }
  const value = latexPreview;
  if (!latexCurrent(value)) {
    toast("Wait for the current LaTeX compilation before saving.");
    return;
  }
  const root = sessions.byId(value.rootId);
  await saveCompiledPdf({
    data: bytesToBase64(value.result.pdf),
    token: value.token,
    sessionId: doc.id,
    revision: doc.revision,
    engine: value.result.engine ?? "LaTeX",
    defaultPath: (root?.path ?? "document.tex").replace(/\.tex$/i, ".pdf"),
    revisions: value.revisions,
  });
}

/**
 * Build, rebind or restore the LaTeX preview.
 *
 * `storeOnly` is manual-compile mode returning to a tab: it may show a PDF the
 * store already holds for exactly these inputs — that PDF is current, not
 * stale — but it never compiles and never reports a failure, so a project that
 * was never compiled keeps its idle "select Compile" surface.
 */
async function renderLatexPreview(
  source: string,
  token: number,
  options: { storeOnly?: boolean } = {},
): Promise<void> {
  const storeOnly = options.storeOnly === true;
  const force = !storeOnly && forceNextBuild;
  if (!storeOnly) forceNextBuild = false;
  const started = performance.now();
  if (!storeOnly) {
    latexLastStart = started;
    latexUnrenderedSince = null;
  }
  clearLatexPerf();
  resetLatexPhase();
  perfMark("render-start", {
    token,
    path: doc.path ?? null,
    storeOnly,
    force,
    viewMode: settings.viewMode,
  });
  const activeId = doc.id;
  if (!storeOnly) {
    latexInFlight = true;
    setLatexStatus("Preparing LaTeX compilation…");
  }
  previewPane.querySelector(":scope > .typst-viewbar")?.remove();
  const build = await resolveLatexBuild(source, token, activeId, storeOnly);
  if (!build) return;
  const { engineStatus, root, revisions, overlays, engineChoice } = build;
  // TeXpresso is the only bundled preview. WasmTex is disabled: its code and
  // hidden test backend remain, but no build falls back to it.
  const shadow = texpressoPrepare(build, storeOnly);
  if (latexPreviewBackend() === "texpresso" && engineStatus.backend === "bundled" && !shadow) {
    if (storeOnly) latexInFlight = false;
    return;
  }
  const owner = { rootId: root.id, rootDirectory: root.directory, activeId, token, revisions };
  // The snapshot's own file list is the definition of "this project", used when a
  // failure has to decide whether a later tab switch is still inside it.
  let snapshotFiles: string[] = [];
  let buildEngine =
    engineStatus.backend === "native"
      ? engineStatus.nativeEngine === "auto"
        ? "Installed TeX"
        : engineStatus.nativeEngine
      : ENGINE_LABELS[engineChoice?.engine ?? "lualatex"];
  try {
    const snapshotStarted = perfMark("snapshot-ipc-start", {
      path: root.path,
      overlays: overlays.length,
    });
    const snapshot = await api.latexProjectSnapshot(root.path, overlays);
    perfMeasure("snapshot-ipc", snapshotStarted, {
      files: snapshot.files.length,
      libraries: snapshot.texmf?.files.length ?? 0,
    });
    if (token !== renderToken || doc.id !== activeId) return;
    snapshotFiles = snapshot.files.map((file) => file.path);
    // The library revision is part of what this compile read. A later focus
    // check compares against it; completion follows the latest capture.
    latexLibraryRevision = snapshot.texmf?.revision ?? null;
    // Completion follows the latest capture, in this editor state only.
    editor.view.dispatch({ effects: setLocalLatexNames.of(libraryNames(snapshot.texmf)) });
    // The live preview takes the same capture: its project follows every
    // render, so a file added to the project reaches it without an edit.
    if (shadow && !texpressoSyncSnapshot(build, snapshot)) {
      if (!storeOnly) latexInFlight = false;
      return;
    }
    const key = latexKey(root, snapshot.generation, {
      ...latexEngineIdentity(engineStatus),
      bundledEngine: engineChoice?.engine ?? null,
    });
    if (shadow) {
      // The frame's own exporter is the authority for export, print, the menu
      // state and the Problems list; nothing is drawn from it.
      if (storeOnly) return;
      if (!force && rebindLatexShadow(key, root, token, activeId, revisions)) return;
      const cached = force ? undefined : latexStore.get(key);
      if (cached) {
        commitLatexShadow({ ...owner, result: cached }, key, {
          stored: true,
          started,
        });
        return;
      }
      await texpressoExportPdf(build, snapshot, owner, key, started);
      return;
    }
    if (!force && rebindLatexPreview(key, root, source, token, activeId, revisions)) return;
    // A PDF already built from exactly these inputs — typically the one this
    // tab showed before the reader switched away — is drawn instead of compiled.
    const stored = force ? undefined : latexStore.get(key);
    if (storeOnly && !stored) return;
    if (stored) latexInFlight = true;
    // A symlink the snapshot refused is reported before the compile, so a
    // "File not found" from the engine is explained rather than mysterious. The
    // project still compiles: one odd entry must not make a document unusable.
    if (!stored && snapshot.skipped.length > 0) {
      toast(
        `Skipped ${snapshot.skipped.length} symlink${snapshot.skipped.length === 1 ? "" : "s"} in the project: ${snapshot.skipped.join(", ")}`,
        6200,
      );
    }
    let result: LatexResult;
    const compileCallStarted = perfMark("compile-call-start", {
      engine: engineStatus.backend,
      mainFile: snapshot.mainFile,
    });
    if (stored) {
      result = stored;
    } else if (engineStatus.backend === "native") {
      const label =
        engineStatus.nativeEngine === "auto" ? "the installed engine" : engineStatus.nativeEngine;
      // One installed-TeX process at a time, newest waiting revision first: an
      // edit no longer kills the running process (that starved the preview
      // exactly as it did the bundled engine). A Cancel still does.
      const release = await nativeGate.acquire(token);
      try {
        setLatexStatus(`Compiling with ${label}…`);
        if (doc.id !== activeId) return;
        // The preview's render token is the native job's owner too, so a Cancel
        // can reach the process tree before its result arrives.
        const job = `job-${token}-${Date.now()}`;
        latexJob = job;
        countCompile();
        try {
          const native = await api.latexNativeCompile({
            job,
            mainFile: snapshot.mainFile,
            files: snapshot.files,
            texmf: snapshot.texmf,
          });
          if (doc.id !== activeId) return;
          buildEngine = native.engine;
          result = nativeToLatex(native, snapshot);
        } finally {
          if (latexJob === job) latexJob = null;
        }
      } finally {
        release();
      }
    } else {
      // The project, not the revision: the warm engine is reused across edits
      // and chapter tabs and replaced when the project or the engine's inputs
      // (year, local libraries) change.
      const texEngine = engineChoice?.engine ?? "lualatex";
      const projectKey = latexProjectKey(root.path, snapshot, texEngine);
      // A missing optional engine is never replaced by another one silently:
      // the reader is told how to get it, or to pick another.
      if (texEngine !== "lualatex" && !(await api.latexEngineAvailable(texEngine))) {
        if (token !== renderToken || doc.id !== activeId) return;
        const label = ENGINE_LABELS[texEngine];
        const megabytes = (optionalEngineBytes(texEngine) / 1048576).toFixed(1);
        latexInFlight = false;
        await latexFailure(
          `${label} is chosen for this project (${engineChoice?.reason}) but is not downloaded yet. Click the ${label} engine chip in the status bar to download it (${megabytes} MB), or choose another engine there.`,
        );
        if (token === renderToken && doc.id === activeId)
          setLatexStatus(`${label} is not downloaded yet.`);
        return;
      }
      const mismatch = engineMismatch(textOf(root), texEngine);
      // The interactive lane (stage 2.2): when a full result of this project is
      // on screen, typeset only up to the last visible page first and splice it
      // in, then run the exact compile. Display only; skipped when previews have
      // not been clearly cheaper than full compiles for this project.
      const shown = typstPdf;
      if (
        !force &&
        !shadow &&
        shown &&
        // A reader following the end of the document gets new pages, which a
        // splice into existing slots cannot show; the exact result follows the tail.
        !shown.atEnd() &&
        latexPreview?.rootId === root.id &&
        latexPreview.activeId === activeId &&
        interactiveLaneWorthwhile(projectKey)
      ) {
        const pageLimit = shown.lastVisiblePage() + 1;
        const span =
          pageLimit > 1
            ? await previewLatexPages(snapshot, { key: projectKey, token, pageLimit })
            : null;
        if (span && typstPdf === shown && doc.id === activeId && token > latexShownToken) {
          const replaced = await shown.splice(span.pdf, span.firstPage);
          if (replaced > 0) {
            perfMark("interactive", { firstPage: span.firstPage, pages: replaced, token });
            if (token === renderToken)
              setLatexStatus("Preview updated · finishing the exact build…");
          }
        }
      }
      setLatexStatus(
        latexBusy()
          ? "Waiting for the previous LaTeX compile…"
          : mismatch
            ? `Compiling with ${ENGINE_LABELS[texEngine]} · ${mismatch}`
            : "Compiling LaTeX…",
      );
      countCompile();
      result = await compileLatex(
        snapshot,
        (phase, count) => {
          if (token === renderToken && doc.id === activeId) {
            setLatexStatus(
              phase === "downloading"
                ? `Downloading LaTeX packages${count ? ` (${count})` : ""}…`
                : phase === "loading"
                  ? "Loading the TeX engine…"
                  : "Compiling LaTeX…",
            );
          }
        },
        {
          // The project, not the revision: the warm engine is reused across
          // edits and chapter tabs and replaced when the project or the
          // engine's inputs (year, local libraries) change.
          key: projectKey,
          token,
          // Where the reader is working, project-relative: the engine places a
          // heap checkpoint before that paragraph during this pass (stage 3.3).
          edit: latexEditPoint(root.directory),
          engine: texEngine,
        },
      );
    }
    perfMeasure("compile-call", compileCallStarted, {
      stored: Boolean(stored),
      engine: buildEngine,
      warnings: result.warnings.length,
    });
    const postStarted = perfMark("post-start");
    const value = { ...owner, result };
    // Display versus authority: a result newer than the one on screen is shown
    // even when the reader has typed since, labelled out of date. Only a
    // result whose revisions match the buffer is authoritative for export,
    // print and SyncTeX (`latexCurrent`). Dropping every stale result is what
    // made continuous typing show nothing at all.
    if (!latexDisplayable(value)) return;
    if (!stored) latexStore.set(key, result, latexResultBytes(result));
    if (shadow) {
      perfMeasure("post", postStarted, { sources: result.sources.length });
      commitLatexShadow(value, key, { stored: Boolean(stored), started, backend: engineStatus });
      return;
    }
    // Narrowed once for the closure: the map callback is not where a mutable
    // `let root` keeps its non-null narrowing.
    const rootDirectory = root.directory;
    wordMap = null;
    clearPreviewWords();

    const host = stagedPdfHost();
    const view = new TypstPdfPreview(host, previewPane, syncSourceFromPageSelection, source, {
      language: "latex",
      files: result.sources,
      activeFile: latexRelative(value, doc.path) ?? "",
      enabled: settings.viewMode === "split",
      detached: true,
      // The committed token, not this build's: a freshness rebind hands the view
      // to a newer render, and its map may finish after that.
      onReady: () => pdfMapReady(view, typstPdfToken),
    });
    stagedPdf = { view, host };
    view.setZoom(zoomFactor());
    setLatexStatus("Rendering PDF…");
    perfMeasure("post", postStarted, { sources: result.sources.length });
    const pdfStarted = perfMark("pdf-start");
    // The reading position of the view being replaced: its pages get their
    // text first, so selection and the first paint do not wait for the rest.
    await view.render(result.pdf.slice(), { focusPage: typstPdf?.topPosition()?.page });
    perfMeasure("pdf", pdfStarted, { pdfBytes: result.pdf.length });
    if (stagedPdf?.view !== view || !latexDisplayable(value)) {
      // Discarded (tab switch, view mode, a newer staged build) or overtaken.
      if (stagedPdf?.view === view) stagedPdf = null;
      view.dispose();
      host.remove();
      return;
    }
    const authoritative = latexCurrent(value);
    latexPartial = null;
    delete preview.dataset.latexPartial;
    latexPreview = value;
    latexProject = latexProjectOf(value);
    latexShownToken = token;
    commitPdfHost(host, view, token);
    // Only a current result follows the editor: an out-of-date one describes
    // older text, its map is not built yet, and scrolling it from the caret
    // moved a reader who was following the end of the document away from it
    // before the current result arrived.
    if (authoritative) syncPreviewFromSource();
    preview.dataset.latexShown = String(token);
    if (authoritative) preview.dataset.latexCurrent = String(token);
    preview.dataset.latexMs = String(Math.round(performance.now() - started));
    perfMeasure("render", started, {
      token,
      files: result.files.size,
      warnings: result.warnings.length,
      stored: Boolean(stored),
    });
    perfMark("commit", {
      token,
      ms: Math.round(performance.now() - started),
      files: result.files.size,
      warnings: result.warnings.length,
    });
    previewLinesMapped = false;
    commitPreview(
      projectOwner(
        root,
        [...result.files].map((file) => pathKey(joinDir(rootDirectory, file))),
      ),
      key,
    );
    previewSyncReady = true;
    // A successful compile is the only authority that clears a problem list.
    latexProblems = result.warnings;

    latexProblemRoot = null;
    latexProblemFiles = new Set();
    editor.clearDiagnostics();
    const selected =
      selectedLatexProblem?.path === pathKey(doc.path ?? "")
        ? result.warnings.find(
            (problem) => diagnosticSignature(problem) === selectedLatexProblem?.signature,
          )
        : null;
    if (selected)
      applyLatexMarks([selected], { path: root.path, directory: root.directory }, doc.path, false);
    else selectedLatexProblem = null;
    showLatexWarnings(result, { path: root.path, directory: root.directory });
    if (stored) preview.dataset.latexFromStore = String(token);
    else delete preview.dataset.latexFromStore;
    if (!authoritative) {
      // Shown, but the buffer has moved on: the newest revision is compiling
      // or about to. Export, print and SyncTeX still wait for that result.
      previewStale = true;
      previewSyncReady = false;
      setLatexStatus(
        latexBusy() || renderToken !== token
          ? "Out of date · Updating…"
          : "Out of date · Waiting to compile…",
      );
      syncMenuState(false);
      return;
    }
    latexInFlight = false;
    if (!stored && engineStatus.backend === "bundled") {
      scheduleReanchor();
      scheduleRecycle();
    }
    // A project outline is built from this result's sources.
    if (outlineScope === "project" && settings.sidebarTab === "outline") refreshOutline();
    setLatexStatus(
      `${stored ? "Up to date" : `Compiled in ${((result.elapsedMs ?? performance.now() - started) / 1000).toFixed(1)} s`} · ${result.engine ?? "LaTeX"}${result.warnings.length ? ` · ${result.warnings.length}${result.warningsTruncated ? "+" : ""} warning${result.warnings.length === 1 && !result.warningsTruncated ? "" : "s"}` : ""}`,
      {
        label: "PDF ready",
        severity: result.warnings.length ? "warning" : "success",
        detail: compiledUi.issueSummary,
        engine: `${result.engine ?? "LaTeX"} · ${((result.elapsedMs ?? performance.now() - started) / 1000).toFixed(1)} s`,
      },
    );
    // Export › PDF and Print are enabled by this commit and name its engine.
    // Nothing else re-sends the menu state here, so without this the rows kept
    // "available after the preview compiles" until the next caret move.
    syncMenuState(false);
  } catch (error) {
    // A newer revision took this one's place in the engine queue; it will
    // report for itself.
    if (error instanceof SupersededError) return;
    if (storeOnly) {
      // A probe that could not read the project leaves manual mode as it was.
      if (token === renderToken && doc.id === activeId) {
        latexInFlight = false;
        discardStagedPdf();
      }
      return;
    }
    if (token === renderToken && doc.id === activeId) {
      latexInFlight = false;
      discardStagedPdf();
      setLatexStatus("LaTeX compilation failed.");
      await latexFailure(
        error,
        { path: root.path, directory: root.directory },
        snapshotFiles,
        owner,
        { engine: buildEngine, elapsedMs: performance.now() - started },
      );
    }
  }
}

/** What a LaTeX build compiles, decided before any backend runs. */
interface LatexBuildRequest {
  engineStatus: api.LatexEngineStatus;
  root: Session & { path: string; directory: string };
  activeId: string;
  revisions: LatexPreview["revisions"];
  overlays: Parameters<typeof api.latexProjectSnapshot>[1];
  /** The bundled engine and why; null for an installed distribution. */
  engineChoice: EngineChoice | null;
}

/**
 * The shared prefix of every LaTeX build: engine status, main-document rules
 * 1–5 with the navigation pin, and the engine choice (docs/plans/
 * 2026-11-13-texpresso-backend.md, step 5). Both preview backends start here,
 * so a chapter tab resolves to the same main document whichever one draws it.
 *
 * Returns null when the build ends here: a failure this function reported, or
 * a store-only probe with nothing to show.
 */
async function resolveLatexBuild(
  source: string,
  token: number,
  activeId: string,
  storeOnly: boolean,
): Promise<LatexBuildRequest | null> {
  if (storeOnly && !doc.path) return null;
  if (!doc.path) {
    latexInFlight = false;
    setLatexStatus("Save the document before compiling.");
    latexFailure("Save this .tex file before compiling.");
    return null;
  }
  let engineStatus: api.LatexEngineStatus;
  const engineStatusStarted = perfMark("engine-status-start");
  try {
    engineStatus = await api.latexEngineStatus();
  } catch (error) {
    if (storeOnly) return null;
    if (token === renderToken && doc.id === activeId) {
      latexInFlight = false;
      setLatexStatus("Could not check the LaTeX engine.");
      latexFailure(error);
    }
    return null;
  }
  perfMeasure("engine-status", engineStatusStarted);
  latexEngine = engineStatus;
  if (token !== renderToken || doc.id !== activeId) return null;
  // Bundled TeX switched on is not bundled TeX ready: a manifest that adds a core
  // file (the LuaLaTeX checkpoint build) under an unchanged release id leaves an
  // older install incomplete. Compiling anyway fails inside the worker as "this
  // document requires LuaLaTeX", and every optional engine reads as "not
  // downloaded yet" because they all require the core set. The setup note's
  // Retry downloads only the missing or mismatched files.
  const bundledMissing =
    engineStatus.backend === "bundled" &&
    !(latexPreviewBackend() === "texpresso"
      ? engineStatus.previewInstalled
      : engineStatus.bundledInstalled);
  if (storeOnly && (engineStatus.backend === "none" || bundledMissing || engineStatus.problem))
    return null;
  if (engineStatus.backend === "none" || bundledMissing) {
    latexInFlight = false;
    setLatexStatus(
      bundledMissing ? "The bundled TeX engine needs setup." : "LaTeX is not enabled.",
    );
    delete preview.dataset.latexCurrent;
    disposeTypstPdf();
    latexEnableNote(engineStatus);
    commitPreview(documentOwner(doc));
    latexProblems = [];
    latexProblemRoot = null;
    latexProblemFiles = new Set();

    editor.clearDiagnostics();
    return null;
  }
  if (engineStatus.problem) {
    latexInFlight = false;
    setLatexStatus("The installed TeX distribution is unavailable.");
    latexFailure(new Error(engineStatus.problem));
    return null;
  }

  let root = latexNavigationRoot ? sessions.byId(latexNavigationRoot) : undefined;
  const pinnedContains = Boolean(
    root?.path && root.directory && latexProject && latexProjectFile(latexProject, doc.path),
  );
  if (!pinnedContains) {
    // A failed compile has no preview to ask, so the previous root is kept while
    // the reader is looking at a file inside it. Without this, opening a problem
    // in an included chapter silently compiled that chapter as the main file.
    //
    // "Inside it" means the failed snapshot contained the file — not that the
    // file sits in the same folder. A directory test pinned every unrelated .tex
    // tab beside a broken project to that project, so switching to a valid
    // document recompiled the broken one and its problems never changed.
    const pinned = inLatexProblemProject(doc.path)
      ? sessions.findByPath(latexProblemRoot!.path)
      : undefined;
    root = pinned?.path ? pinned : undefined;
  }
  // The main document (GAP-034): a `% !TeX root` comment wins, then a file with
  // its own \documentclass, then the pinned project; a lone chapter is told how
  // to name its main file instead of failing deep inside the engine.
  const main = resolveMainDocument({
    directory: doc.directory ?? "",
    source,
    pinnedContains: Boolean(root),
  });
  // Rule 2: the reader's explicit choice for this workspace wins over the pin;
  // rule 4: a chapter with no project yet asks the include graph.
  if (main.kind === "pinned" || main.kind === "missing") {
    const inWorkspace =
      settings.workspaceFolder &&
      doc.path &&
      pathKey(doc.path).startsWith(pathKey(settings.workspaceFolder) + "/");
    const chosen = inWorkspace ? workspaceMainDocument() : null;
    let target: string | null =
      chosen && pathKey(chosen) !== pathKey(doc.path ?? "") ? chosen : null;
    if (!target && main.kind === "missing" && inWorkspace && doc.path) {
      const candidates = await workspaceMainCandidates(doc.path);
      if (token !== renderToken || doc.id !== activeId) return null;
      if (candidates.length === 1) target = candidates[0];
      else if (candidates.length > 1) {
        if (storeOnly) return null;
        latexInFlight = false;
        await latexFailure(
          `Several main documents include this file: ${candidates.map((c) => c.split(/[\\/]/).pop()).join(", ")}. Right-click the one to use in the Explorer and choose Set as Main Document, or add \`% !TeX root = …\` to this file.`,
        );
        if (token === renderToken && doc.id === activeId)
          setLatexStatus("Choose this file's main document.");
        return null;
      }
    }
    if (target) {
      const named = await backgroundSession(target);
      if (token !== renderToken || doc.id !== activeId) return null;
      if (named?.path) {
        root = named;
        latexNavigationRoot = root.id;
      }
    }
  }
  if (main.kind === "comment") {
    const named = await backgroundSession(main.path);
    if (token !== renderToken || doc.id !== activeId) return null;
    if (!named?.path) {
      if (storeOnly) return null;
      latexInFlight = false;
      setLatexStatus("The main document named by % !TeX root was not found.");
      latexFailure(`% !TeX root names ${main.path}, which could not be opened.`);
      return null;
    }
    root = named;
  } else if (main.kind === "self" || (main.kind === "pinned" && !root)) {
    root = doc;
  } else if (main.kind === "missing" && (!root || root.id === doc.id)) {
    if (storeOnly) return null;
    latexInFlight = false;
    await latexFailure(
      "This file has no \\documentclass, so it is not a main document. Add a line such as `% !TeX root = ../main.tex` at the top, or open the main file and compile from there.",
    );
    // After the failure panel: it writes a generic status of its own, and this
    // one says what to do.
    if (token === renderToken && doc.id === activeId)
      setLatexStatus("No main document for this file.");
    return null;
  }
  root ??= doc;
  latexNavigationRoot = root.id;
  if (storeOnly && (!root.path || !root.directory)) return null;
  if (!root.path || !root.directory) {
    latexInFlight = false;
    setLatexStatus("Save the main document before compiling.");
    latexFailure("Save the main .tex file first.");
    return null;
  }
  // The bundled engine for this project (stage 6.2): magic comment, then the
  // project's choice, then the Preferences default. The chip always says which.
  const engineChoice = engineStatus.backend === "native" ? null : latexEngineChoice(root);
  if (engineChoice) showEngineChip(engineChoice, root.path);
  else statusEngine.hidden = true;
  return {
    engineStatus,
    root: root as Session & { path: string; directory: string },
    activeId,
    revisions: sessions.list().map(({ id, revision, path }) => ({ id, revision, path })),
    overlays: latexOverlays(root.directory),
    engineChoice,
  };
}

/* ---------- Incremental preview (docs/plans/2026-11-13-texpresso-backend.md) ---------- */
//
// The frame draws the document and its own `xdvipdfmx` export produces the PDF
// that export, print, the menu state and the authoritative Problems list read.
// Everything protocol-level lives in src/texpresso/; this block only connects
// it to the shell's own state.

/** The live preview; another project or engine replaces it. */
let texpresso: TexpressoSession | null = null;
/** Main documents whose frame failed twice: Compile retries them. */
const texpressoFailed = new Set<string>();
/** Why the last build did not draw, for the chip. */
let texpressoFallbackReason: { reason: TexpressoFallback; file?: string | null } | null = null;
/** The frame is on screen for the active tab. */
let texpressoShown = false;
/** The frame's own scroll offset, as it last reported it. */
let texpressoScrollTop = 0;
/** The key of the exported result, which never commits to the pane. */
let latexShadowKey: string | null = null;
/** The last status the preview wrote, so a live update can redraw it. */
let latexStatusLast: { message: string; state?: CompiledStatus } | null = null;
let texpressoHost: HTMLElement | null = null;

function texpressoHostElement(): HTMLElement {
  if (!texpressoHost) {
    // A sibling of #preview, like the HTML guest: never inside a preview slot,
    // because moving an iframe in the DOM reloads it and restarts the engine.
    texpressoHost = document.createElement("div");
    texpressoHost.className = "texpresso-host";
    texpressoHost.hidden = true;
    previewPane.append(texpressoHost);
  }
  return texpressoHost;
}

/** True while the frame is what the reader sees for this LaTeX tab. */
function texpressoShowing(): boolean {
  return texpressoShown && texpresso !== null && doc.language === "latex";
}

function texpressoShow(visible: boolean): void {
  texpressoShown = visible;
  texpressoHostElement().hidden = !visible;
  app.classList.toggle("latex-texpresso", visible);
  if (visible) preview.dataset.latexBackend = "texpresso";
  else delete preview.dataset.latexBackend;
}

/** Show the frame again for a tab of its project, or hide it for any other. */
function texpressoFollowTab(): void {
  const session = texpresso;
  const member =
    session !== null &&
    doc.language === "latex" &&
    latexPreviewBackend() === "texpresso" &&
    projectRelativePath(session.rootDirectory, doc.path, pathKey) !== null;
  texpressoShow(member && settings.viewMode !== "source");
}

function texpressoRelease(): void {
  if (!texpresso) return;
  void texpresso.dispose();
  texpresso = null;
  texpressoShow(false);
}

/**
 * Stop the frame and say why. There is no second bundled engine: the pane keeps
 * the reader's document and the status line names the reason.
 */
function texpressoFallbackTo(reason: TexpressoFallback, file: string | null = null): void {
  texpressoRelease();
  texpressoFallbackReason = { reason, file };
  texpressoChip();
  latexInFlight = false;
  const why = texpressoFallbackText(reason, { file });
  setLatexStatus(`Preview unavailable: ${why}`, { label: "Preview", severity: "warning" });
  syncMenuState(false);
  perfMark("texpresso-fallback", { reason, file });
}

/** The chip names the engine, never the backend's product name. */
function texpressoChip(): void {
  if (latexPreviewBackend() !== "texpresso" || !engineChipChoice) {
    delete statusEngine.dataset.previewBackend;
    return;
  }
  const label = ENGINE_LABELS[engineChipChoice.engine];
  const fallback = texpressoFallbackReason;
  const base = statusEngine.dataset.baseTitle ?? statusEngine.title;
  statusEngine.dataset.baseTitle = base;
  if (fallback) {
    const why = texpressoFallbackText(fallback.reason, fallback);
    statusEngine.textContent = label;
    statusEngine.title = `${base} Preview unavailable: ${why}.`;
    statusEngine.dataset.previewBackend = `texpresso:${fallback.reason}`;
  } else {
    statusEngine.textContent = label;
    statusEngine.title = `${base} Preview: typeset as you type; export uses the same PDF.`;
    statusEngine.dataset.previewBackend = "texpresso";
  }
}

/**
 * Decide, before the snapshot, whether the frame draws this build, and mount
 * or reuse it. Returns true when it does: the build is then the frame's own
 * export for the PDF, print and Problems.
 */
function texpressoPrepare(build: LatexBuildRequest, storeOnly: boolean): boolean {
  texpressoFallbackReason = null;
  delete statusEngine.dataset.baseTitle;
  if (latexPreviewBackend() !== "texpresso") {
    texpressoRelease();
    texpressoChip();
    return false;
  }
  const engine = build.engineChoice?.engine ?? "lualatex";
  const rootKey = pathKey(build.root.path);
  const reason = texpressoFallback({
    backend: build.engineStatus.backend,
    engine,
    year: TEXPRESSO_TEXLIVE_YEAR,
    jspi: typeof (WebAssembly as { Suspending?: unknown }).Suspending === "function",
    nonUtf8: null,
    libraryConflict: null,
    failed: texpressoFailed.has(rootKey),
  });
  const frameEngine = texpressoEngineFor(engine);
  if (reason || !frameEngine) {
    texpressoFallbackTo(reason ?? "failed");
    return false;
  }
  const session = texpresso;
  if (!session || pathKey(session.key.rootPath) !== rootKey || session.key.engine !== frameEngine) {
    // Manual mode returning to a tab never starts a frame: that is a compile.
    if (storeOnly) {
      texpressoShow(false);
      return false;
    }
    // Another project or engine: XeLaTeX and LuaLaTeX are different workers,
    // formats and font caches, so an engine change is a new frame.
    texpressoRelease();
    texpresso = new TexpressoSession(
      texpressoHostElement(),
      { rootPath: build.root.path, engine: frameEngine },
      build.root.directory,
      texpressoHandlers,
    );
    texpresso.hold(settings.latexAutoCompile === false);
    perfMark("texpresso-mount", { engine: frameEngine });
  }
  texpresso!.open(projectRelativePath(build.root.directory, doc.path, pathKey));
  texpressoShow(settings.viewMode !== "source");
  texpressoChip();
  return true;
}

/** An open tab's text for a project file, LF-normalised, or null. */
function texpressoLiveText(directory: string, path: string): string | null {
  const session = sessions.findByPath(joinDir(directory, path));
  return session ? normaliseText(textOf(session)) : null;
}

/**
 * Send the build's snapshot to the frame (only what changed). Returns false
 * when the project cannot be typeset there; the status line then names why.
 */
function texpressoSyncSnapshot(
  build: LatexBuildRequest,
  snapshot: api.LatexProjectSnapshot,
): boolean {
  const session = texpresso;
  if (!session) return false;
  const directory = build.root.directory;
  const prepared = prepareProject(snapshot, (path) => texpressoLiveText(directory, path));
  if (prepared.nonUtf8) {
    texpressoFallbackTo("encoding", prepared.nonUtf8);
    return false;
  }
  if (prepared.libraryConflict) {
    texpressoFallbackTo("library", prepared.libraryConflict);
    return false;
  }
  session.sync(prepared, projectRelativePath(directory, doc.path, pathKey));
  // The project record, before any PDF exists: chapter tabs find their main
  // document from it (step 5).
  latexProject = {
    rootId: build.root.id,
    rootDirectory: directory,
    files: new Set(snapshot.files.map((file) => file.path)),
  };
  // The frame is this project's content: the pane is owned, the wait is over.
  commitPreview(
    projectOwner(
      build.root,
      snapshot.files.map((file) => pathKey(joinDir(directory, file.path))),
    ),
    null,
  );
  previewSyncReady = true;
  return true;
}

/**
 * The frame's own `xdvipdfmx` conversion, stored as the PDF that Export,
 * Save PDF, Print, the menu state and the Problems list read. Nothing is
 * drawn from it: the frame is already the preview.
 */
async function texpressoExportPdf(
  build: LatexBuildRequest,
  snapshot: api.LatexProjectSnapshot,
  owner: {
    rootId: string;
    rootDirectory: string;
    activeId: string;
    token: number;
    revisions: LatexPreview["revisions"];
  },
  key: string,
  started: number,
): Promise<void> {
  const session = texpresso;
  if (!session) return;
  const mark = perfMark("typeset-start", {
    token: owner.token,
    files: snapshot.files.length,
  });
  setLatexStatus("Typesetting the PDF…");
  const reply = await session.exportPdf();
  if (owner.token !== renderToken || doc.id !== owner.activeId || session !== texpresso) return;
  if (!reply) {
    latexInFlight = false;
    setLatexStatus("The PDF for export could not be produced.");
    toast("The preview could not produce a PDF. Compile again to retry.", 6200);
    syncMenuState(false);
    return;
  }
  const warnings = texpressoDiagnostics(session, build.root.directory);
  const result: LatexResult = {
    pdf: reply.pdf,
    sources: nativeSources(snapshot),
    files: new Set(snapshot.files.map((file) => file.path)),
    mainFile: snapshot.mainFile,
    log: "",
    warnings,
    warningsTruncated: false,
    engine: ENGINE_LABELS[build.engineChoice?.engine ?? "lualatex"],
    elapsedMs: reply.ms,
  };
  perfMeasure("typeset", mark, {
    bytes: reply.pdf.length,
    ms: Math.round(reply.ms),
    warnings: warnings.length,
  });
  latexStore.set(key, result, latexResultBytes(result));
  commitLatexShadow({ ...owner, result }, key, {
    stored: false,
    started,
    backend: build.engineStatus,
  });
}

/** Hand the exported result on screen to this render when its inputs are unchanged. */
function rebindLatexShadow(
  key: string,
  root: Session,
  token: number,
  activeId: string,
  revisions: LatexPreview["revisions"],
): boolean {
  const value = latexPreview;
  if (key !== latexShadowKey || !value || value.rootId !== root.id) return false;
  value.token = token;
  value.activeId = activeId;
  value.revisions = revisions;
  commitLatexShadow(value, key, { stored: true, started: performance.now() });
  return true;
}

/**
 * The exported result is ready: the authority for export, print, the menu
 * state, the project outline and the Problems list, exactly as a drawn result
 * is, without PDF.js.
 */
function commitLatexShadow(
  value: LatexPreview,
  key: string,
  build: { stored: boolean; started: number; backend?: api.LatexEngineStatus },
): void {
  const result = value.result;
  const root = sessions.byId(value.rootId);
  latexPreview = value;
  latexProject = latexProjectOf(value);
  latexShownToken = value.token;
  latexShadowKey = key;
  latexPartial = null;
  // Through a plain boolean: the type guard would narrow `value` to never below.
  const authoritative: boolean = latexCurrent(value);
  preview.dataset.latexShadow = String(value.token);
  if (authoritative) preview.dataset.latexCurrent = String(value.token);
  perfMeasure("shadow", build.started, {
    token: value.token,
    stored: build.stored,
    warnings: result.warnings.length,
  });
  // A finished export replaces the frame's interim list.
  latexProblems = result.warnings;
  latexProblemRoot = null;
  latexProblemFiles = new Set();
  editor.clearDiagnostics();
  if (root?.path && root.directory) {
    const rootRef = { path: root.path, directory: root.directory };
    const selected =
      selectedLatexProblem?.path === pathKey(doc.path ?? "")
        ? result.warnings.find(
            (problem) => diagnosticSignature(problem) === selectedLatexProblem?.signature,
          )
        : null;
    if (selected) applyLatexMarks([selected], rootRef, doc.path, false);
    else selectedLatexProblem = null;
    showLatexWarnings(result, rootRef);
  }
  if (!authoritative) {
    previewStale = true;
    setLatexStatus(
      latexBusy() || renderToken !== value.token
        ? "PDF for export: updating…"
        : "PDF for export: waiting for a pause in typing",
    );
    syncMenuState(false);
    return;
  }
  previewStale = false;
  latexInFlight = false;
  // The warm-engine checks compare WasmTex builds; TeXpresso has no such engine.
  if (
    !build.stored &&
    build.backend?.backend === "bundled" &&
    latexPreviewBackend() === "wasmtex"
  ) {
    scheduleReanchor();
    scheduleRecycle();
  }
  if (outlineScope === "project" && settings.sidebarTab === "outline") refreshOutline();
  const seconds = ((result.elapsedMs ?? performance.now() - build.started) / 1000).toFixed(1);
  const warnings = result.warnings.length
    ? ` · ${result.warnings.length}${result.warningsTruncated ? "+" : ""} warning${result.warnings.length === 1 && !result.warningsTruncated ? "" : "s"}`
    : "";
  setLatexStatus(`PDF for export up to date · ${result.engine ?? "LaTeX"}${warnings}`, {
    label: "PDF ready",
    severity: result.warnings.length ? "warning" : "success",
    detail: compiledUi.issueSummary,
    engine: `${result.engine ?? "LaTeX"} · ${seconds} s`,
  });
  syncMenuState(false);
}

/** The live half of the status line while the frame draws. */
function texpressoLiveStatus(): string {
  const session = texpresso;
  if (!session) return "";
  if (!session.ready) return "Preview starting…";
  const errors = session.problems.filter((p) => p.severity === "error").length;
  const state = session.held ? "Preview paused" : session.busy ? "Typesetting…" : "Preview live";
  return errors ? `${state} · ${errors} error${errors === 1 ? "" : "s"}` : state;
}

/** Redraw the status line with the frame's latest state. */
function texpressoRefreshStatus(): void {
  if (!texpressoShowing() || !latexStatusLast) return;
  setLatexStatus(latexStatusLast.message, latexStatusLast.state);
}

/** The frame's problem list in the shape the editor and the panel use. */
function texpressoDiagnostics(session: TexpressoSession, directory: string): LatexDiagnostic[] {
  return session.problems.map((problem) => {
    const text = texpressoLiveText(directory, problem.file);
    const lineText =
      text !== null && problem.line > 0 ? (text.split("\n")[problem.line - 1] ?? "") : "";
    return {
      file: problem.file,
      line: problem.line,
      column: problem.column,
      endColumn: 0,
      severity: problem.severity,
      code: "typeset",
      message: problem.message,
      text: "",
      lineText: lineTextOf(lineText),
      searched: [],
    };
  });
}

/**
 * The frame's problems, while typing: marks in the editor and the Problems
 * panel in the same shape as a compiled result. A finished export replaces
 * them with the authoritative list.
 */
function texpressoProblems(session: TexpressoSession): void {
  if (session !== texpresso || !texpressoShowing()) return;
  const root = sessions.findByPath(session.key.rootPath);
  if (!root?.path || !root.directory) return;
  const rootRef = { path: root.path, directory: root.directory };
  const diagnostics = texpressoDiagnostics(session, root.directory);
  // Only while the exported result is out of date: a current one is the authority.
  if (latexCurrent(latexPreview)) return;
  latexProblems = diagnostics;
  applyLatexMarks(diagnostics, rootRef, doc.path, false);
  if (diagnostics.length) {
    const panel = latexProblemPanel(new LatexBuildError("", diagnostics), rootRef, [
      ...(latexProject?.files ?? []),
    ]);
    panel.querySelector(".latex-log")?.remove();
    compiledUi.details(panel, "", diagnostics.length, false);
  }
}

const texpressoHandlers = {
  onReady(session: TexpressoSession, info: { missing: string[]; jspi: boolean }): void {
    if (session !== texpresso) return;
    if (info.missing.length) {
      // A member the bridge needs is gone: the pinned app changed. Its feature
      // is off, and the reader is told rather than left with dead gestures.
      toast(`The preview lacks ${info.missing.join(", ")}; those features are off.`, 6200);
    }
    if (!info.jspi) {
      texpressoFallbackTo("jspi");
      scheduleRender(true);
      return;
    }
    perfMark("texpresso-ready", { missing: info.missing });
    preview.dataset.texpressoReady = "1";
    texpressoRefreshStatus();
  },
  onMessage(session: TexpressoSession, message: FrameMessage): void {
    if (session !== texpresso) return;
    texpressoMessage(session, message);
  },
  onBroken(session: TexpressoSession, reason: string): void {
    texpressoFailed.add(pathKey(session.key.rootPath));
    if (session !== texpresso) return;
    toast(`${reason} Compile again to retry.`, 6200);
    texpressoFallbackTo("failed");
  },
  onRecovery(session: TexpressoSession, step: "resync" | "restart"): void {
    perfMark("texpresso-recovery", { step });
    if (step === "restart" && session === texpresso)
      toast("The preview stopped answering; restarting it.", 4200);
  },
  currentText: texpressoLiveText,
  theme: texpressoTheme,
  zoom: () => zoomFactor(),
  reference: () => texpressoReference(),
};

function texpressoMessage(session: TexpressoSession, message: FrameMessage): void {
  switch (message.type) {
    case "status":
      if (message.problems) texpressoProblems(session);
      texpressoRefreshStatus();
      break;
    case "painted": {
      const sent = session.sentAt.get(message.seq);
      for (const seq of session.sentAt.keys()) if (seq <= message.seq) session.sentAt.delete(seq);
      if (sent !== undefined) {
        const ms = performance.now() - sent;
        perfMark("texpresso-painted", { seq: message.seq, ms, done: message.done });
        preview.dataset.texpressoE2p = String(Math.round(ms));
      }
      preview.dataset.texpressoPainted = String(message.seq);
      preview.dataset.texpressoPages = String(message.pages);
      if (message.done) syncPreviewFromSource();
      break;
    }
    case "viewport":
      texpressoScrollTop = message.scrollTop;
      if (message.gesture) texpressoAlignSource(message.line, message.file);
      break;
    case "scrolled":
      if (message.scrollTop !== null) {
        texpressoScrollTop = message.scrollTop;
        scrollOwnership.wrote("preview", message.scrollTop, performance.now());
      }
      break;
    case "input":
      scrollOwnership.input();
      suppressPreviewScrollUntil = 0;
      suppressEditorScrollUntil = 0;
      break;
    case "source":
      void texpressoSourceGesture(session, message.file, message.from, message.to, message.detail);
      break;
    case "key":
      clearCorrespondence();
      break;
    case "zoom-wheel":
      setZoom(zoomLevel() + (message.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP));
      break;
    case "error":
      perfMark("texpresso-error", { message: message.message });
      console.warn(`[latex] ${message.message}`);
      break;
    default:
      break;
  }
}

/** The editor's transactions, straight to the frame: no debounce, no snapshot. */
function texpressoEdit(changes: Array<[number, number, string]>, base: number, text: string): void {
  const session = texpresso;
  if (!session || doc.language !== "latex" || latexPreviewBackend() !== "texpresso") {
    delete preview.dataset.texpressoEdit;
    return;
  }
  const file = projectRelativePath(session.rootDirectory, doc.path, pathKey);
  if (file === null) {
    preview.dataset.texpressoEdit = "outside-project";
    return;
  }
  preview.dataset.texpressoEdit = session.edit(file, base, changes, text);
  if (texpressoShowing()) texpressoRefreshStatus();
}

/** Source selection → preview boxes, in the frame. False when the frame is not on screen. */
function texpressoSyncSelection(): boolean {
  const session = texpresso;
  if (!session || !texpressoShowing()) return false;
  const file = projectRelativePath(session.rootDirectory, doc.path, pathKey);
  if (file === null) return true;
  const info = editor.cursorInfo();
  const range =
    !wordSyncDismissed && info.selectionLength && settings.viewMode === "split"
      ? snapToWords(editor.getDoc(), info.from, info.to)
      : null;
  if (range) session.post({ type: "select", file, from: range.from, to: range.to, blink: false });
  else session.post({ type: "clear" });
  return true;
}

/** A click in the source: its paragraph blinks in the frame and nothing moves. */
function texpressoBlinkSource(): boolean {
  const session = texpresso;
  if (!session || !texpressoShowing()) return false;
  const file = projectRelativePath(session.rootDirectory, doc.path, pathKey);
  if (file === null || settings.viewMode !== "split" || editor.cursorInfo().selectionLength)
    return true;
  const range = paragraphRangeAt(editor.getDoc(), editor.cursorInfo().from);
  if (range.to > range.from)
    session.post({ type: "select", file, from: range.from, to: range.to, blink: true });
  return true;
}

/**
 * A click or double-click in the frame: the word or paragraph is marked in the
 * source, the caret does not move, and focus comes back to the editor. A
 * double-click reveals it, opening its chapter when needed.
 */
async function texpressoSourceGesture(
  session: TexpressoSession,
  file: string | null,
  from: number,
  to: number,
  detail: number,
): Promise<void> {
  // Evidence for the CDP layer and for a bug report: what the engine answered
  // and what this side decided, without the document's text.
  const record = (range: { from: number; to: number } | null) => {
    preview.dataset.texpressoSource = JSON.stringify({ file, from, to, detail, range });
  };
  if (!file || settings.viewMode === "source") return record(null);
  const path = joinDir(session.rootDirectory, file);
  let reveal = detail >= 2;
  if (!doc.path || pathKey(doc.path) !== pathKey(path)) {
    // A single click marks inside the document already on screen; only a
    // double-click is a "show me this" that may switch tabs. Opening a file on
    // one click moved the caret to the top of another document.
    if (detail < 2) return;
    const existing = sessions.findByPath(path);
    if (existing) await activateSession(existing.id);
    else await openPath(path, { silent: true, rememberRecent: false });
    if (!doc.path || pathKey(doc.path) !== pathKey(path) || session !== texpresso) return;
    reveal = true;
  }
  const range = rangeForPreviewGesture(editor.getDoc(), from, to, detail);
  record(range);
  if (!range) return;
  // `setSyncRange` blurs the editor so the PDF selection survives the
  // decoration repaint, and `focus()` then re-reads a DOM selection that the
  // blur cleared. Keep the caret the reader had: a click in the preview must
  // mark, never move it.
  const caret = editor.view.state.selection.main;
  wordSyncDismissed = false;
  syncedSource = range;
  editor.setSyncRange(range.from, range.to);
  if (reveal) {
    suppressEditorScrollUntil = performance.now() + SYNC_SUPPRESS_MS;
    editor.revealOffset(range.from);
  }
  editor.focus();
  editor.view.dispatch({ selection: { anchor: caret.anchor, head: caret.head } });
}

/** Escape, from either pane: both marks go, nothing else changes. */
function clearCorrespondence(): void {
  window.clearTimeout(selectionTimer);
  syncedSource = null;
  editor.clearSyncRange();
  clearPreviewWords();
  texpresso?.post({ type: "clear" });
}

function texpressoGeometry(): EditorScrollGeometry {
  const view = editor.view;
  return {
    offsetAtScreenY: (y) => editor.offsetAtScreenY(y),
    lineOfOffset: (offset) => view.state.doc.lineAt(offset).number,
    lineCount: () => view.state.doc.lines,
    lineScrollTop: (line) => editor.lineScrollTop(line),
    scrollTop: () => view.scrollDOM.scrollTop,
    scrollerTop: () => view.scrollDOM.getBoundingClientRect().top,
  };
}

/** The sync line in the frame's own coordinates. */
function texpressoReference(): number {
  const top = texpressoHostElement().getBoundingClientRect().top;
  return Math.max(0, scrollReference() - top);
}

/** Source scrolled: bring the same line to the sync line in the frame. */
function texpressoAlignPreview(): void {
  const session = texpresso;
  if (!session || !texpressoShowing() || !settings.syncScroll || settings.viewMode !== "split")
    return;
  const file = projectRelativePath(session.rootDirectory, doc.path, pathKey);
  if (file === null) return;
  const line = editorLineAt(texpressoGeometry(), scrollReference());
  session.post({ type: "reveal", file, line, y: texpressoReference() });
}

/** The frame scrolled by a gesture: bring the same line to the sync line here. */
function texpressoAlignSource(line: number | null, file: string | null): void {
  const session = texpresso;
  if (!session || !texpressoShowing() || line === null || !settings.syncScroll) return;
  if (settings.viewMode !== "split" || syncDragging) return;
  if (file !== projectRelativePath(session.rootDirectory, doc.path, pathKey)) return;
  if (scrollOwnership.reflected("preview", texpressoScrollTop, performance.now())) return;
  scrollOwnership.input();
  const target = clampScroll(
    editorScrollFor(texpressoGeometry(), line, scrollReference()),
    editor.scrollMax(),
  );
  if (Math.abs(target - editor.view.scrollDOM.scrollTop) < 0.5) return;
  suppressEditorScrollUntil = performance.now() + SYNC_SUPPRESS_MS;
  editor.scrollToOffset(target);
  scrollOwnership.wrote("source", editor.view.scrollDOM.scrollTop, performance.now());
}

function texpressoTheme(): TexpressoTheme {
  const root = getComputedStyle(document.documentElement);
  const value = (name: string, fallback: string): string =>
    root.getPropertyValue(name).trim() || fallback;
  const paper = value("--bg", isDark ? "#1e1e1e" : "#ffffff");
  const pane = getComputedStyle(previewPane).backgroundColor;
  return {
    dark: isDark,
    sync: value("--word-sync", "rgba(255, 193, 7, 0.3)"),
    peak: value("--word-sync-peak", "rgba(255, 167, 0, 0.55)"),
    paper,
    pane: pane && pane !== "rgba(0, 0, 0, 0)" && pane !== "transparent" ? pane : paper,
  };
}

/**
 * The frame's export (`xdvipdfmx`) against the authoritative PDF, page count
 * and page text. Hidden command `view.latexTexpressoExport`; the result is a
 * perf mark and `#preview[data-texpresso-export]`. Export, Save PDF and Print
 * write the same path's bytes.
 */
async function measureTexpressoExport(): Promise<void> {
  const session = texpresso;
  if (!session || !texpressoShowing()) return;
  const reply = await session.request({ type: "export" }, 120_000);
  if (!reply || reply.type !== "pdf") {
    perfMark("texpresso-export", { ok: false });
    preview.dataset.texpressoExport = JSON.stringify({ ok: false });
    return;
  }
  const pdf = new Uint8Array(reply.pdf);
  const reference = latexCurrent(latexPreview) ? latexPreview.result.pdf : null;
  const [mine, theirs] = await Promise.all([
    pdfPageTexts(pdf),
    reference ? pdfPageTexts(reference) : Promise.resolve([] as string[]),
  ]);
  const first = theirs.findIndex((text, index) => text !== mine[index]);
  const outcome = {
    ok: true,
    ms: Math.round(reply.ms),
    bytes: pdf.length,
    pages: [mine.length, theirs.length],
    compared: reference !== null,
    identicalText: reference !== null && mine.length === theirs.length && first < 0,
    firstDifferentPage: first < 0 ? null : first + 1,
  };
  perfMark("texpresso-export", outcome);
  preview.dataset.texpressoExport = JSON.stringify(outcome);
}

/**
 * The hidden backend switch. Not a Preference: tests and the comparison use it
 * (`view.latexBackend.texpresso`, `view.latexBackend.wasmtex`).
 */
function switchLatexBackend(next: LatexPreviewBackend): void {
  if (!setLatexPreviewBackend(next)) return;
  texpressoFailed.clear();
  texpressoFallbackReason = null;
  latexShadowKey = null;
  texpressoRelease();
  toast(next === "texpresso" ? "LaTeX preview: incremental" : "LaTeX preview: PDF", 2600);
  if (doc.language !== "latex") return;
  // The pane's content belongs to the other backend: a PDF view, or nothing.
  retirePreview();
  invalidateLatexBuild("The preview backend changed; select Compile to update the preview.");
  scheduleRender(true);
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
  typstInFlight = null;
  const hadOutput =
    covers(previewOwner, probeOf(doc)) &&
    Boolean(preview.querySelector(".typst-preview,.typst-document"));
  const text = String(error);
  commitPreview(documentOwner(doc));
  previewSyncReady = false;
  const panel = document.createElement("div");
  panel.className = "compiled-problems";
  const headlines = text.split("\n").filter((line) => /^\s*(error|warning):/.test(line));
  for (const headline of headlines.length ? headlines : [text]) {
    const row = document.createElement("div");
    row.className = "compiled-issue";
    row.textContent = headline;
    panel.append(row);
  }
  compiledUi.details(panel, text, headlines.length || 1, true);
  if (!hadOutput) {
    disposeTypstPdf();
    preview.replaceChildren();
    if (text.includes(TYPST_MISSING)) {
      preview.append(typstMissingNote(text));
      compiledUi.showLogs(false, false);
    } else {
      const empty = document.createElement("div");
      empty.className = "compiled-empty";
      empty.textContent = "No preview produced. Open Logs for the compilation problems.";
      preview.append(empty);
      compiledUi.showLogs(true, false);
    }
  }
  configureCompiledUi();
  setTypstStatus(
    hadOutput
      ? "Build failed · Showing previous output; see Logs."
      : "No preview produced · See Logs.",
    false,
    {
      label: hadOutput ? "Build failed" : "No output produced",
      severity: "error",
      detail: [hadOutput ? "Showing previous output" : "", compiledUi.issueSummary]
        .filter(Boolean)
        .join(" · "),
      engine: "Typst",
    },
  );
  void wanted;
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
async function fingerprintTypstDeps(
  deps: readonly api.TypstDependency[],
): Promise<CachedTypstDep[]> {
  const checked = await Promise.all(
    deps.map(async (dep): Promise<CachedTypstDep | null> => {
      try {
        const stat = await api.fingerprintDocument(dep.path);
        if (!stat.exists) return null;
        return {
          path: dep.path,
          modifiedMs: stat.modifiedMs,
          size: stat.size,
          sha256: stat.sha256,
        };
      } catch {
        return null;
      }
    }),
  );
  return checked.filter((item): item is CachedTypstDep => item !== null);
}

async function typstDepsCurrent(deps: readonly CachedTypstDep[]): Promise<boolean> {
  if (deps.length === 0) return true;
  const stats = await Promise.all(
    deps.map(async (dep) => {
      try {
        const current = await api.fingerprintDocument(dep.path);
        return (
          current.exists &&
          current.modifiedMs === dep.modifiedMs &&
          current.size === dep.size &&
          current.sha256 === dep.sha256
        );
      } catch {
        return false;
      }
    }),
  );
  return stats.every(Boolean);
}

function typstEntryBytes(entry: CachedTypstEntry): number {
  return (
    (entry.pdfBytes?.byteLength ?? 0) +
    ((entry.rendered.pdf?.length ?? 0) +
      (entry.rendered.html?.length ?? 0) +
      (entry.rendered.css?.length ?? 0) +
      entry.rendered.compilerOutput.length) *
      2
  );
}

function typstCompiledBytes(
  rendered: api.RenderedTypst,
  binaryPdf?: Uint8Array,
): Uint8Array | null {
  if (binaryPdf && binaryPdf.byteLength > 0) return binaryPdf;
  if (rendered.pdf) return decodePdf(rendered.pdf);
  return null;
}

async function renderTypstPreview(source: string, token: number): Promise<void> {
  clearTypstPerf();
  const started = performance.now();
  const wanted = settings.typstView === "pages" ? "pages" : "document";
  // The compile is awaited; a mode switch during it must not make this render
  // claim a word map it never built.
  const wantsMap = settings.viewMode === "split";
  const imageRoot = typstExtraRoot();
  const key = typstKey(doc, source, { mode: wanted, imageRoot });
  const force = forceNextBuild;
  forceNextBuild = false;

  // A Typst compile is a whole process. A view switch or a repeated render of
  // the same inputs has nothing new to compile.
  if (
    !force &&
    lastTypstRender &&
    lastTypstRender.key === key &&
    committedKey === key &&
    // Document ranges survive a mode change and can be rebound without another
    // compiler process, even when a pending map build was invalidated.
    (lastTypstRender.syncReady || !wantsMap || (wanted === "document" && lastTypstRender.blocks))
  ) {
    commitPreview(documentOwner(doc), key);
    // A preview restored from its slot lost the toolbar with the retirement;
    // redrawing it from the kept result is idempotent for one that did not.
    showTypstChrome(lastTypstRender.rendered, lastTypstRender.seconds);
    if (pendingPreviewScroll !== null) applyPendingPreviewScroll();
    if (wanted === "document" && wantsMap && !wordMap && lastTypstRender.blocks) {
      bindPreviewWords(source, undefined, lastTypstRender.blocks, true);
      lastTypstRender.syncReady = true;
    }
    previewSyncReady = lastTypstRender.syncReady;
    // The existing PDF still belongs to this document, but doRender assigned a
    // new generation to the cache hit. Keep Pages sync owned by that generation.
    if (wanted === "pages" && typstPdf) {
      typstPdfToken = token;
      if (wantsMap) typstPdf.ensureMap();
    }
    return;
  }

  // A result kept from before a tab switch, reusing `--deps` fingerprints so
  // multi-file Typst documents remain cached when none of their inputs changed.
  const storableWithoutDeps = typstStorable(source);
  const candidate = !force ? typstStore.get(key) : undefined;
  let stored: CachedTypstEntry | undefined;
  if (
    candidate &&
    (candidate.deps.length > 0 ? await typstDepsCurrent(candidate.deps) : storableWithoutDeps)
  ) {
    if (token !== renderToken) return;
    stored = candidate;
  }

  let rendered: api.RenderedTypst;
  let pdfBytes: Uint8Array | null;
  if (stored) {
    rendered = stored.rendered;
    pdfBytes = typstCompiledBytes(rendered, stored.pdfBytes);
  } else {
    const editRev = typstEditSeq;
    const gateSeq = ++typstGateSeq;
    let releaseGate: () => void;
    try {
      releaseGate = await typstScheduler.acquire(gateSeq);
    } catch (error) {
      if (error instanceof TypstSupersededError || token !== renderToken) return;
      throw error;
    }
    if (token !== renderToken) {
      releaseGate();
      return;
    }

    typstInFlight = token;
    countCompile();
    setTypstStatus("Compiling Typst…");
    const compileStarted = performance.now();
    typstPerfMark("rpc:start");
    typstPerfMark("compile:start");
    try {
      const binary = await api.renderTypstBinary(doc.path, source, wanted, imageRoot, token);
      const rpcElapsedMs = performance.now() - compileStarted;
      rendered = binary.meta;
      const timings = rendered.timings;
      typstLastCompileMs = timings?.totalMs ?? rpcElapsedMs;
      const perfDetail = {
        spawnOrRpcMs: timings ? Math.max(0, rpcElapsedMs - timings.totalMs) : undefined,
        vfsSyncMs: timings?.vfsSyncMs ?? undefined,
        typstCompileMs: timings?.typstCompileMs ?? undefined,
        pdfEncodeMs: timings?.exportMs ?? undefined,
        pageHashMs: timings?.pageHashMs ?? undefined,
        backendKind: rendered.backendKind ?? "cli",
      };
      typstPerfMeasure("compile", compileStarted, perfDetail);
      typstPerfMark("compile:end", perfDetail);
      typstPerfMark("rpc:end");
      typstPerfMark("decode:start");
      pdfBytes = typstCompiledBytes(rendered, binary.pdfBytes);
      typstPerfMark("decode:end");
      typstScheduler.markCompiled(editRev);
    } catch (error) {
      typstScheduler.markCompiled(editRev);
      if (token !== renderToken) return;
      // Shown in place of the preview, not as a toast: a Typst error is about a
      // line of this document, and the pane is where the document is looked at.
      showTypstFailure(error, wanted);
      return;
    } finally {
      if (typstInFlight === token) typstInFlight = null;
      releaseGate();
    }
    if (token !== renderToken) return;
    const rawDeps = rendered.deps ?? [];
    if (rawDeps.length > 0 || storableWithoutDeps) {
      const fingerprintedDeps = rawDeps.length > 0 ? await fingerprintTypstDeps(rawDeps) : [];
      if (token !== renderToken) return;
      if (
        rawDeps.length === fingerprintedDeps.length &&
        (rawDeps.length > 0 || storableWithoutDeps)
      ) {
        const entry: CachedTypstEntry = {
          rendered,
          pdfBytes: pdfBytes ?? undefined,
          deps: fingerprintedDeps,
        };
        typstStore.set(key, entry, typstEntryBytes(entry));
      }
    }
  }

  // A cache hit above keeps the current controls and word map intact. Only a
  // result that will replace or patch the DOM may discard stale overlays.
  previewPane.querySelector(":scope > .typst-viewbar")?.remove();
  wordMap = null;
  clearPreviewWords();
  if (rendered.kind === "document") {
    disposeTypstPdf();
    preview.innerHTML = "";
  }
  // A word decoration belongs to the view that produced it. Switching to Pages,
  // or re-rendering the document, must not leave a mark that cannot be cleared.
  syncedSource = null;
  editor.clearSyncRange();
  showTypstIssues(rendered);

  if (rendered.kind === "document") {
    const host = document.createElement("div");
    // The same class the Markdown preview uses, so every rule that shapes prose,
    // headings, code, tables and quotes applies to this document too.
    host.className = "markdown-body typst-document";
    host.innerHTML = rendered.html ?? "";
    preview.appendChild(host);
    // Feed compiler AST spans when available so text-normalized fallback keeps
    // blocks aligned when dynamic content diverges from literal source text.
    const mapped = annotateTypstLines(host, source, rendered.spanMap);
    previewLinesMapped = mapped.mapped >= 2;
    bindPreviewWords(source, undefined, mapped.blocks, wantsMap);
    rebuildAnchors();
    if (pendingPreviewScroll === null) revealCursorInPreview();
    else applyPendingPreviewScroll();
    updateActiveOutline();
    syncPreviewFromSource();
    commitPreview(documentOwner(doc), key);
    previewSyncReady = wantsMap;
    lastTypstRender = {
      key,
      docId: doc.id,
      revision: doc.revision,
      mode: wanted,
      syncReady: wantsMap,
      rendered,
      seconds: ((performance.now() - started) / 1000).toFixed(1),
      blocks: mapped.blocks,
    };
    setTypstStatus(
      `Compiled with Typst${rendered.warnings.length ? ` · ${rendered.warnings.length} warnings` : ""}`,
      false,
      {
        label: "Document ready",
        severity: rendered.warnings.length ? "warning" : "success",
        detail: compiledUi.issueSummary,
        engine: `Typst · ${((performance.now() - started) / 1000).toFixed(1)} s`,
      },
    );
    return;
  }

  if (!pdfBytes || pdfBytes.byteLength === 0) {
    showTypstFailure("The page render produced no PDF.", rendered.kind);
    return;
  }

  typstPerfMark("paint:start");
  if (typstPdf && !typstPdf.isDisposed && rendered.pageHashes && rendered.pageHashes.length > 0) {
    const targetView = typstPdf;
    discardStagedPdf();
    targetView.setZoom(zoomFactor());
    try {
      await targetView.updateWithPageHashes(pdfBytes, rendered.pageHashes, {
        focusPage: targetView.topPosition()?.page,
        source,
        files: [{ path: "", source }],
        activeFile: "",
        spanMap: rendered.spanMap,
        onReady: () => pdfMapReady(targetView, token),
      });
    } catch (error) {
      if (token !== renderToken) return;
      showTypstFailure(error, rendered.kind);
      return;
    }
    if (token !== renderToken) return;
    typstPdfToken = token;
    latexLastSourceScroll = null;
    typstPdfBytes = pdfBytes;
    if (targetView.mapReady()) pdfMapReady(targetView, token);
  } else {
    const host = stagedPdfHost();
    const view = new TypstPdfPreview(host, previewPane, syncSourceFromPageSelection, source, {
      language: "typst",
      files: [{ path: "", source }],
      activeFile: "",
      enabled: wantsMap,
      detached: true,
      spanMap: rendered.spanMap,
      onReady: () => pdfMapReady(view, token),
    });
    stagedPdf = { view, host };
    view.setZoom(zoomFactor());
    try {
      await view.render(pdfBytes, {
        focusPage: typstPdf?.topPosition()?.page,
        pageHashes: rendered.pageHashes,
      });
    } catch (error) {
      if (token !== renderToken) return;
      discardStagedPdf();
      showTypstFailure(error, rendered.kind);
      return;
    }
    if (token !== renderToken) {
      view.dispose();
      host.remove();
      return;
    }
    commitPdfHost(host, view, token);
    typstPdfBytes = pdfBytes;
  }
  typstPerfMark("paint:end");
  // PDF correspondence has its own region adapter, not DOM block anchors.
  previewLinesMapped = false;
  syncPreviewFromSource();
  commitPreview(documentOwner(doc), key);
  // The page view's own map is ready; switching to Split must not reload it.
  previewSyncReady = true;
  lastTypstRender = {
    key,
    docId: doc.id,
    revision: doc.revision,
    mode: wanted,
    syncReady: true,
    rendered,
    seconds: ((performance.now() - started) / 1000).toFixed(1),
  };
  setTypstStatus(
    `Compiled with Typst${rendered.warnings.length ? ` · ${rendered.warnings.length} warnings` : ""}`,
    true,
    {
      label: "PDF ready",
      severity: rendered.warnings.length ? "warning" : "success",
      detail: compiledUi.issueSummary,
      engine: `Typst · ${((performance.now() - started) / 1000).toFixed(1)} s`,
    },
  );
}

/**
 * True when a Typst document's output depends on its own text alone.
 *
 * Deliberately broad: any import, include, or function that reads a file
 * (images, data files, bibliographies, plugins) makes the document ineligible
 * for synchronous store hits without verified `--deps` fingerprints.
 */
const TYPST_READS_FILES =
  /#\s*(?:import|include)\b|\b(?:image|read|json|csv|yaml|toml|xml|cbor|plugin|bibliography)\s*\(/;

/** True when the Typst store holds output for the active document as it is now. */
function typstStoreHit(): boolean {
  const source = editor.getDoc();
  if (!typstStorable(source)) return false;
  const mode = settings.typstView === "pages" ? "pages" : "document";
  const entry = typstStore.get(typstKey(doc, source, { mode, imageRoot: typstExtraRoot() }));
  return Boolean(entry && entry.deps.length === 0);
}

function typstStorable(source: string): boolean {
  return !TYPST_READS_FILES.test(source);
}

function typstPdfCurrent(): boolean {
  return Boolean(
    typstPdfBytes &&
    typstPdfToken === renderToken &&
    lastTypstRender &&
    lastTypstRender.docId === doc.id &&
    lastTypstRender.revision === doc.revision &&
    lastTypstRender.mode === "pages" &&
    !previewStale,
  );
}

async function saveTypstPagesPdf(): Promise<void> {
  const bytes = typstPdfBytes;
  if (!bytes || !typstPdfCurrent()) {
    toast("Wait for the current Typst page preview before saving.");
    return;
  }
  await saveCompiledPdf({
    data: encodePdfBase64(bytes),
    token: typstPdfToken,
    sessionId: doc.id,
    revision: doc.revision,
    engine: "Typst",
    defaultPath: (doc.path ?? doc.name).replace(/\.typ$/i, ".pdf"),
  });
}

/** Switch the preview view and redraw it. */
function chooseTypstView(view: api.TypstView): void {
  if (settings.typstView === view) return;
  settings.typstView = view;
  syncMenuState();
  persist();
  compileCurrentDocument();
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
/**
 * The Typst toolbar's problems, Logs text and Document note, plus the export
 * stylesheet a Document view needs. One function for a fresh compile and for a
 * preview that comes back from its slot, so the two cannot drift.
 */
function showTypstIssues(rendered: api.RenderedTypst): void {
  const issues = document.createElement("div");
  issues.className = "compiled-problems";
  for (const warning of rendered.warnings) {
    const row = document.createElement("div");
    row.className = "compiled-issue compiled-warning";
    row.textContent = warning;
    issues.append(row);
  }
  compiledUi.details(
    issues,
    rendered.compilerOutput ?? rendered.warnings.join("\n"),
    rendered.warnings.length,
    false,
  );
  compiledUi.outputReady();
  compiledUi.note(rendered.kind === "document" ? typstDroppedNote(rendered) : null);
  if (rendered.kind === "document" && rendered.css) {
    // The export's stylesheet is mostly MathML alignment inside tables, which
    // no browser resolves unaided. Kept in one element so it is replaced rather
    // than accumulated across renders — and re-applied when another file's
    // Document preview comes back from its slot.
    let style = document.getElementById("typst-export-css") as HTMLStyleElement | null;
    if (!style) {
      style = document.createElement("style");
      style.id = "typst-export-css";
      document.head.appendChild(style);
    }
    style.textContent = rendered.css;
  }
}

/** The toolbar of a Typst preview that is current without a compile. */
function showTypstChrome(rendered: api.RenderedTypst, seconds: string): void {
  configureCompiledUi();
  showTypstIssues(rendered);
  const pages = rendered.kind === "pages";
  setTypstStatus(
    `Compiled with Typst${rendered.warnings.length ? ` · ${rendered.warnings.length} warnings` : ""}`,
    pages,
    {
      label: pages ? "PDF ready" : "Document ready",
      severity: rendered.warnings.length ? "warning" : "success",
      detail: compiledUi.issueSummary,
      engine: `Typst · ${seconds} s`,
    },
  );
}

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

/**
 * Delegate an HTML document to the sandboxed guest.
 *
 * True only when the frame built for `source` was promoted. A failed build or
 * load, a timeout, a newer render and Source-only mode all leave the preview
 * stale, so a later switch to Split rebuilds it instead of trusting an older
 * frame — or no frame at all.
 */
async function renderHtmlPreview(source: string, token: number): Promise<boolean> {
  if (!htmlPreview) return false;
  // In Source-only mode there is nothing to draw, and rebuilding the guest
  // would only restart its scripts.
  if (settings.viewMode === "source") return false;
  htmlRestoreLine = htmlPreview.layout()?.line ?? editor.topVisibleLine();
  const inputs = htmlInputs();
  const outcome = await htmlPreview.render(source, inputs.baseDir, inputs.name, inputs.scripts, [
    ...inputs.roots,
  ]);
  return outcome === "current" && token === renderToken;
}

/**
 * What the HTML guest is built from besides the text. One function feeds both
 * the build and its freshness key, so the two cannot disagree.
 */
function htmlInputs(): { baseDir: string | null; name: string; scripts: boolean; roots: string[] } {
  return {
    baseDir: doc.directory ?? null,
    name: doc.name ?? "index.html",
    scripts: settings.htmlPreviewScripts !== false,
    // Only a saved document has a root the guest can resolve against; a custom
    // folder is the one extra folder the reader allowed.
    roots: doc.path ? [customImageFolder()].filter((dir): dir is string => dir !== null) : [],
  };
}

async function doRender(force = false): Promise<void> {
  const token = ++renderToken;
  if (!force && settings.viewMode === "source") {
    previewStale = true;
    previewSyncReady = false;
    return;
  }
  if (api.isWebSource(doc.language)) {
    clearPending();
    preview.replaceChildren();
    previewPane.querySelector(":scope > .source-preview-warning")?.remove();
    const warning = document.createElement("div");
    warning.className = "preview-pending source-preview-warning";
    warning.setAttribute("role", "status");
    const icon = document.createElement("div");
    icon.className = "source-preview-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = "⚠️";
    const title = document.createElement("div");
    title.className = "preview-pending-title";
    title.textContent = "Preview unavailable";
    const message = document.createElement("div");
    message.className = "preview-pending-phase";
    message.textContent = "This file can be edited in the source pane.";
    warning.append(icon, title, message);
    previewPane.append(warning);
    previewStale = false;
    previewSyncReady = false;
    return;
  }
  // A render is now on its way for whatever document is active. If no content
  // has committed for it, the pane shows the wait rather than a foreign tab's
  // output. Repeated calls for the same wait are ignored by `armPending`.
  if (previewOwner === null) armPending();
  const source = editor.getDoc();
  // Capture the mode once: a mermaid/Asciidoctor await may span a mode switch,
  // and the map the render produced must match the map the split pane expects.
  const wantsMap = settings.viewMode === "split";

  if (doc.language === "latex") {
    await renderLatexPreview(source, token);
    return;
  }

  if (doc.language === "typst") {
    await renderTypstPreview(source, token);
    return;
  }

  // Typst controls live outside #preview and belong only to a Typst result.
  previewPane.querySelector(":scope > .typst-viewbar")?.remove();

  if (doc.language === "html") {
    const key = htmlKey(doc, source, htmlInputs());
    // The guest keeps the copy it built, stamped for this exact source; an
    // edit only cleared the highlight. Rebuilding would restart its scripts.
    if (!force && key === committedKey && covers(previewOwner, probeOf(doc))) {
      commitPreview(documentOwner(doc), key);
      previewSyncReady = true;
      return;
    }
    wordMap = null;
    clearPreviewWords();
    const current = await renderHtmlPreview(source, token);
    if (token !== renderToken || !current) return;
    // The guest stamps its word nodes while building the copy, so Split can use
    // the same iframe without a second render.
    commitPreview(documentOwner(doc), key);
    previewSyncReady = true;
    return;
  }

  const language = doc.language === "asciidoc" ? "asciidoc" : "markdown";
  const scheduledAt = proseScheduledAt;
  proseScheduledAt = null;
  if (scheduledAt !== null) prosePerfMeasure("quietWait", scheduledAt, { language });
  const key = proseKey(language, doc, source, {
    baseDir: doc.directory ?? null,
    documentPath: language === "markdown" ? doc.path : null,
    math: settings.enableMath,
    mermaid: settings.enableMermaid,
  });
  if (
    key === committedKey &&
    proseMap?.key === key &&
    covers(previewOwner, probeOf(doc)) &&
    (!wantsMap || proseMap.fragments !== undefined || proseMap.blocks !== undefined)
  ) {
    // The DOM on screen was built from this exact text and these options —
    // typically an edit undone before the debounce ran. Rebind what the edit
    // dropped instead of converting the document again.
    if (!wordMap)
      bindPreviewWords(
        source,
        proseMap.fragments,
        proseMap.blocks,
        wantsMap,
        false,
        proseMap.blockFragmentCounts,
      );
    previewLinesMapped = proseMap.linesMapped;
    drawDiagrams(token);
    rebuildAnchors();
    if (pendingPreviewScroll !== null) applyPendingPreviewScroll();
    syncPreviewFromSource();
    commitPreview(documentOwner(doc), key);
    previewSyncReady = wantsMap;
    return;
  }
  wordMap = null;
  clearPreviewWords();
  clearProsePerf();

  const proseRenderStart = performance.now();
  if (doc.language === "asciidoc") {
    const epoch = themeEpoch;
    const workerStart = prosePerfMark("workerRoundTrip:start");
    const result = await renderAsciidocPreviewInto(
      preview,
      source,
      {
        baseDir: doc.directory ?? null,
        math: settings.enableMath,
        mermaid: settings.enableMermaid,
        isDark,
        onMermaidSettled: () => {
          if (token !== renderToken || epoch !== themeEpoch) return;
          prosePerfMark("mermaid:end");
          rebuildAnchors();
          if (pendingPreviewScroll === null && !caretByPointer) revealCursorInPreview();
        },
      },
      () => token !== renderToken,
    );
    if (!result) return;
    const incrementalApplied = Boolean(result.incremental?.applied);
    prosePerfMeasure("workerRoundTrip", workerStart, {
      language: "asciidoc",
      incrementalApplied,
      dirtyBlocks: result.incremental?.dirtyBlocks ?? 0,
      totalBlocks: result.incremental?.totalBlocks ?? 0,
    });
    const finishStart = performance.now();
    previewLinesMapped = result.linesMapped;
    bindPreviewWords(source, undefined, result.blocks, wantsMap, incrementalApplied);
    rebuildAnchors();
    if (pendingPreviewScroll === null) revealCursorInPreview();
    else applyPendingPreviewScroll();
    updateActiveOutline();
    syncPreviewFromSource();
    commitPreview(documentOwner(doc), key);
    proseMap = {
      key,
      fragments: undefined,
      blocks: wantsMap ? result.blocks : undefined,
      linesMapped: result.linesMapped,
    };
    previewSyncReady = wantsMap;
    prosePerfMeasure("finish", finishStart, { language: "asciidoc", incrementalApplied });
    proseDelays.record("asciidoc", performance.now() - proseRenderStart);
    if (epoch !== themeEpoch) retheme();
    return;
  }

  // Word-level correspondence is only consumed in Split; building it for a
  // hidden or single-pane preview is a second pass over the whole document.
  const workerStart = prosePerfMark("workerRoundTrip:start");
  const result = await renderPreviewInto(
    preview,
    source,
    {
      baseDir: doc.directory ?? null,
      documentPath: doc.path,
      math: settings.enableMath,
      mermaid: settings.enableMermaid,
      map: wantsMap,
    },
    () => token !== renderToken,
  );
  if (!result) return;
  const incrementalApplied = Boolean(result.incremental?.applied);
  prosePerfMeasure("workerRoundTrip", workerStart, {
    language: "markdown",
    incrementalApplied,
    dirtyBlocks: result.incremental?.dirtyBlocks ?? 0,
    totalBlocks: result.incremental?.totalBlocks ?? 0,
  });
  const finishStart = performance.now();
  previewLinesMapped = result.linesMapped;
  bindPreviewWords(
    source,
    result.fragments,
    undefined,
    wantsMap,
    incrementalApplied,
    result.blockFragmentCounts,
  );

  if (result.linesMapped !== lastMappedState) {
    lastMappedState = result.linesMapped;
    if (!result.linesMapped) {
      console.info(
        "[sync] positional pane sync is unavailable for this document; scrolling stays independent",
      );
    }
  }

  drawDiagrams(token);

  // Diagram sizes only settle after mermaid runs, so anchor once it is done.
  rebuildAnchors();
  if (pendingPreviewScroll === null) revealCursorInPreview();
  else applyPendingPreviewScroll();
  updateActiveOutline();
  syncPreviewFromSource();
  commitPreview(documentOwner(doc), key);
  proseMap = {
    key,
    fragments: wantsMap ? result.fragments : undefined,
    blocks: undefined,
    blockFragmentCounts: wantsMap ? result.blockFragmentCounts : undefined,
    linesMapped: result.linesMapped,
  };
  previewSyncReady = wantsMap;
  prosePerfMeasure("finish", finishStart, { language: "markdown", incrementalApplied });
  proseDelays.record("markdown", performance.now() - proseRenderStart);
}

/**
 * Draw the Markdown preview's diagrams after the first paint.
 *
 * Their SVGs are large and mermaid renders sequentially, so the reader sees the
 * text first and the anchors are rebuilt once the sizes settle. A newer render
 * or a theme change cancels the pass. A freshness match calls this too: an
 * edit that was undone may have cancelled the previous pass halfway, and a
 * diagram already drawn comes from the cache.
 */
function drawDiagrams(token: number): void {
  if (!preview.querySelector(".mermaid[data-mermaid]")) return;
  const epoch = themeEpoch;
  const cancelled = () => token !== renderToken || epoch !== themeEpoch;
  const mermaidStart = prosePerfMark("mermaid:start");
  void renderMermaidIn(preview, isDark, cancelled).then(() => {
    if (cancelled()) return;
    prosePerfMeasure("mermaid", mermaidStart);
    rebuildAnchors();
    if (pendingPreviewScroll === null && !caretByPointer) revealCursorInPreview();
  });
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

/**
 * Choose the Explorer's folder (File › Open Folder…).
 *
 * The folder is checked in Rust (a folder, not a drive root or the home
 * folder) and remembered in settings; the sidebar switches to the Explorer.
 */
/** Main-document rule 2: the explicit choice for the open workspace folder. */
function workspaceMainDocument(): string | null {
  const folder = settings.workspaceFolder;
  if (!folder) return null;
  const key = pathKey(folder);
  return settings.latexMainDocuments?.find((entry) => pathKey(entry.folder) === key)?.path ?? null;
}

function setWorkspaceMainDocument(path: string | null): void {
  const folder = settings.workspaceFolder;
  if (!folder) return;
  const key = pathKey(folder);
  const others = (settings.latexMainDocuments ?? []).filter(
    (entry) => pathKey(entry.folder) !== key,
  );
  // Newest first; the cap mirrors MAX_MAIN_DOCUMENTS in settings.rs.
  settings.latexMainDocuments = path ? [{ folder, path }, ...others].slice(0, 50) : others;
  mainCandidateCache.clear();
  persist();
  renderSidebar();
  toast(path ? `Main document: ${path.split(/[\\/]/).pop()}` : "Main document cleared");
  if (doc.language === "latex") scheduleRender(true);
}

/** Rule 4 answers per file, so a compile does not re-read the workspace each time. */
const mainCandidateCache = new Map<string, string[]>();

async function workspaceMainCandidates(path: string): Promise<string[]> {
  const folder = settings.workspaceFolder;
  if (!folder || !pathKey(path).startsWith(pathKey(folder) + "/")) return [];
  const key = `${pathKey(folder)}\u0000${pathKey(path)}`;
  const cached = mainCandidateCache.get(key);
  if (cached) return cached;
  const found = await api.workspaceMainCandidates(folder, path).catch(() => [] as string[]);
  mainCandidateCache.set(key, found);
  return found;
}

async function chooseWorkspaceFolder(): Promise<void> {
  const picked = await openDialog({ directory: true, multiple: false, title: "Open Folder" });
  if (typeof picked !== "string") return;
  await openWorkspaceFolder(picked);
}

async function openWorkspaceFolder(path: string): Promise<void> {
  try {
    const info = await api.workspaceOpen(path);
    settings.workspaceFolder = info.root;
    settings.sidebarTab = "explorer";
    settings.sidebarVisible = true;
    invalidateExplorer();
    applyLayout();
    persist();
    renderSidebar();
    syncMenuState(false);
  } catch (error) {
    toast(String(error).replace(/^Error: /, ""), 6000);
  }
}

function closeWorkspaceFolder(): void {
  settings.workspaceFolder = null;
  invalidateExplorer();
  persist();
  renderSidebar();
  syncMenuState(false);
}

function renderSidebar(): void {
  if (!settings.sidebarVisible) return;

  if (settings.sidebarTab === "outline") {
    refreshOutline();
    return;
  }

  if (settings.sidebarTab === "explorer") {
    void renderExplorer(
      sidebarBody,
      settings.workspaceFolder ?? null,
      {
        showAll: settings.explorerShowAll === true,
        activePath: doc.path,
        pathKey,
        mainDocument: workspaceMainDocument(),
      },
      {
        openFile: (path) => void openPath(path),
        openExternal: (path) =>
          void api.openExternal(path).catch((error: unknown) => toast(String(error))),
        chooseFolder: () => void chooseWorkspaceFolder(),
        closeFolder: closeWorkspaceFolder,
        setShowAll: (on) => {
          settings.explorerShowAll = on;
          persist();
          renderSidebar();
        },
        setMainDocument: setWorkspaceMainDocument,
        reveal: (path) =>
          void revealItemInDir(path).catch((error: unknown) => toast(String(error))),
      },
    );
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
/** "file": this document's headings; "project": the whole LaTeX project's (Track W2). */
let outlineScope: "file" | "project" = "file";
/** The project headings on screen, for the click handler. */
let projectHeadings: ProjectHeading[] = [];

/** The current LaTeX result covers more than one file: a project outline exists. */
function latexProjectOutlineAvailable(): boolean {
  return (
    doc.language === "latex" &&
    latexPreview !== null &&
    latexPreview.activeId === doc.id &&
    latexPreview.result.sources.length > 1
  );
}

/** Jump to a project heading: scroll here, or open its file first. */
async function pickProjectHeading(heading: ProjectHeading): Promise<void> {
  const value = latexPreview;
  if (!value) return;
  const path = joinDir(value.rootDirectory, heading.file);
  if (doc.path && pathKey(doc.path) !== pathKey(path)) await openPath(path);
  if (doc.path && pathKey(doc.path) === pathKey(path)) editor.scrollToLine(heading.line);
}

function refreshOutline(text = editor.getDoc()): void {
  if (settings.sidebarTab !== "outline" || !settings.sidebarVisible) return;
  // A document load schedules a refresh and then calls renderSidebar(); this
  // cancels the duplicate that would otherwise rescan 250 ms later.
  window.clearTimeout(outlineTimer);

  const language = doc.language;
  outlineHeadings = api.isWebSource(language)
    ? []
    : language === "typst"
      ? sidebarPanel.extractTypstHeadings(text)
      : language === "html"
        ? sidebarPanel.extractHtmlHeadings(text)
        : language === "asciidoc"
          ? sidebarPanel.extractAsciidocHeadings(text)
          : language === "latex"
            ? sidebarPanel.extractLatexHeadings(text)
            : sidebarPanel.extractHeadings(text);
  outlineLanguage = language;
  outlineReady = true;

  const project = latexProjectOutlineAvailable() && outlineScope === "project";
  if (project && latexPreview) {
    projectHeadings = projectLatexOutline(
      latexPreview.result.mainFile,
      new Map(latexPreview.result.sources.map((file) => [file.path, file.source])),
    );
    sidebarPanel.renderOutline(
      sidebarBody,
      projectHeadings,
      -1,
      (_line, index) => void pickProjectHeading(projectHeadings[index]),
      language,
    );
    // Each row names its file when it is not the one on screen.
    const current = latexPreview ? latexRelative(latexPreview, doc.path) : null;
    sidebarBody.querySelectorAll<HTMLElement>(".outline-item").forEach((button, index) => {
      const file = projectHeadings[index]?.file;
      if (file && file !== current) button.title = file;
      if (file === current) button.classList.add("outline-current-file");
    });
  } else {
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
  if (latexProjectOutlineAvailable()) {
    const scope = document.createElement("div");
    scope.className = "outline-scope";
    scope.setAttribute("role", "group");
    scope.setAttribute("aria-label", "Outline scope");
    for (const [value, label] of [
      ["file", "This file"],
      ["project", "Whole project"],
    ] as const) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.setAttribute("aria-pressed", String(outlineScope === value));
      button.addEventListener("click", () => {
        outlineScope = value;
        refreshOutline();
      });
      scope.append(button);
    }
    sidebarBody.prepend(scope);
  }
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
  // The project scope marks rows by file, not by this document's line numbers.
  if (outlineScope === "project" && latexProjectOutlineAvailable()) return;
  sidebarPanel.highlightOutline(sidebarBody, outlineHeadings, editor.cursorInfo().line);
}

// ---------------------------------------------------------------------------
// Document lifecycle
// ---------------------------------------------------------------------------

/**
 * Which markup a path holds.
 *
 * By extension, because a saved file's suffix is authoritative: a Typst document
 * and a Markdown document are both text, and re-reading the contents on every
 * open would flip the parser under edits that have not been saved yet. The one
 * place contents decide is Save As on an untitled buffer (`suggestSave`), where
 * the reader is choosing the extension anyway.
 */
function languageFor(path: string | null): api.DocumentLanguage {
  return languageForExtension(path);
}

/** Packages and classes use LaTeX syntax, but are not standalone .tex documents. */
function editorLanguageFor(session: Pick<Session, "path" | "language">): api.DocumentLanguage {
  return session.path && /\.(?:sty|cls)$/i.test(session.path) ? "latex" : session.language;
}

/**
 * The markup a new document starts in.
 *
 * The default extension is what a new document starts as, and opening a `.typ`
 * file switches the parser to Typst. Starting the document the other way would
 * make the first save change how the text that was already typed is read; Save
 * As is the deliberate exception, where `suggestSave` reads the buffer and may
 * recommend another extension.
 */
function defaultDocumentLanguage(): api.DocumentLanguage {
  return languageForExtension(settings.defaultExtension);
}

/**
 * The file dialog filters: the markup being saved first, the rest alphabetical,
 * or All files first for Open.
 *
 * The native dialog selects the first entry and offers no way to select another
 * (rfd declares `SetFileTypeIndex` but never calls it), so that first filter is
 * also what supplies the extension when the reader types a bare name. Save As
 * passes the language the buffer was detected as, because the extension in
 * `defaultPath` stops counting the moment the name is edited. Open puts All
 * files first instead: keyed to the default extension, the dialog would hide
 * every `.tex`, `.typ` or `.html` file behind a filter change. The remaining
 * entries keep name order — All files, AsciiDoc, HTML, Markdown, Typst — so the
 * list reads the same in every dialog rather than in the order the markup types
 * happened to be introduced.
 */
function documentFilters(
  language: api.DocumentLanguage = defaultDocumentLanguage(),
  allFilesFirst = false,
): { name: string; extensions: string[] }[] {
  // The extension lists come from `LANGUAGE_EXTENSIONS`, the same table
  // `languageForExtension` classifies with, so a filter can never offer a name
  // the opener would then read as Markdown.
  const filter = (name: string, kind: api.DocumentLanguage) => ({
    name,
    extensions: [...LANGUAGE_EXTENSIONS[kind]],
  });
  const markdown = filter("Markdown", "markdown");
  const typst = filter("Typst", "typst");
  const html = filter("HTML", "html");
  const latex = filter("LaTeX", "latex");
  const asciidoc = filter("AsciiDoc", "asciidoc");
  const javascript = filter("JavaScript", "javascript");
  const css = filter("CSS", "css");
  const json = filter("JSON", "json");
  const all = { name: "All files", extensions: ["*"] };
  const alphabetical = [all, asciidoc, css, html, javascript, json, latex, markdown, typst];
  const preferred = {
    markdown,
    typst,
    html,
    asciidoc,
    latex,
    javascript,
    css,
    json,
  } satisfies Record<api.DocumentLanguage, { name: string; extensions: string[] }>;
  const first = preferred[language];
  const ordered = [first, ...alphabetical.filter((entry) => entry !== first)];
  return allFilesFirst ? [all, ...ordered.filter((entry) => entry !== all)] : ordered;
}

/**
 * The file name Save As pre-fills for an untitled buffer.
 *
 * The deterministic name is always ready; the assistant can only improve the
 * one case the text itself cannot name — the first line is prose rather than a
 * title — and a slow or failed request falls back to it. The extension still
 * comes from `suggestSave`, because the buffer's markup decides the filter.
 */
async function suggestedFileName(
  session: Session,
  text: string,
  language: api.DocumentLanguage,
  extension: string,
): Promise<string> {
  const deterministic = suggestFileStem({ text, language });
  const assisted = await assistantFileName(session, text, deterministic, extension);
  return withExtension(assisted ?? deterministic.stem, extension);
}

/**
 * Ask the configured endpoint for a better name, or `null` to keep the
 * document's own.
 *
 * Every gate here is deliberate. An explicit title or heading is the author's
 * own name and is authoritative; asking a model to rename it spends a request
 * to make it worse. The same name for the same revision is reused, so
 * cancelling the dialog does not ask twice. The race is the promise the dialog
 * waits on: `ai_cancel` asks the backend to stop, but a connection that has not
 * answered yet cannot see the cancellation channel, so the frontend must stop
 * waiting on its own.
 */
async function assistantFileName(
  session: Session,
  text: string,
  deterministic: FileStem,
  extension: string,
): Promise<string | null> {
  if (!settings.aiEnabled || !settings.aiSuggestFilename || !settings.aiModel.trim()) return null;
  if (deterministic.source !== "line") return null;

  const cached = suggestedNames.get(session.id);
  if (cached && cached.revision === session.revision) return cached.stem;

  const excerpt = plainExcerpt(text, AI_EXCERPT_CHARS);
  if (excerpt.split(/\s+/).filter(Boolean).length < 3) return null;

  const id = `filename-${Date.now()}-${++filenameRequestSeq}`;
  const notice: { current: { dismiss: () => void } | null } = { current: null };
  const noticeTimer = window.setTimeout(() => {
    notice.current = toast("Asking the assistant for a file name…", 0);
  }, AI_FILENAME_NOTICE_DELAY_MS);
  let stopTimer = 0;
  try {
    const answer = await Promise.race([
      api.aiSuggestFilename(id, excerpt),
      new Promise<null>((resolve) => {
        stopTimer = window.setTimeout(() => {
          void api.aiCancel(id).catch(() => undefined);
          resolve(null);
        }, AI_FILENAME_TIMEOUT_MS);
      }),
    ]);
    if (answer === null) return null;
    const stem = cleanAiSuggestion(answer, extension);
    if (stem) suggestedNames.set(session.id, { revision: session.revision, stem });
    return stem;
  } catch {
    return null;
  } finally {
    window.clearTimeout(noticeTimer);
    window.clearTimeout(stopTimer);
    notice.current?.dismiss();
  }
}

/** Drop the guest when the editor leaves HTML; start a fresh nonce when it enters. */
function syncGuest(next: api.DocumentLanguage): void {
  if (!htmlPreview) return;
  // A reset guest is blank, whatever key the last build left behind.
  if (next === "html") committedKey = null;
  if (next === "html") htmlPreview.reset();
  else htmlPreview.dispose();
}

/** Copy a file read onto a session. The EditorState is left for the caller. */
function describe(session: Session, payload: api.DocumentPayload): void {
  session.revision += 1;
  session.incarnation += 1;
  session.path = payload.path;
  session.name = payload.name;
  session.directory = payload.directory || null;
  session.language = languageFor(payload.path);
  session.savedContent = payload.content;
  session.dirty = false;
  session.lineEnding = payload.lineEnding;
  session.hadBom = payload.hadBom;
  session.encoding = payload.encoding;
  session.encodingBlocked = false;
  session.lossy = payload.lossy;
  session.size = payload.size;
  session.modifiedMs = payload.modifiedMs;
  session.sha256 = payload.sha256;
  session.readOnly = payload.readOnly;
  session.draft = null;
  session.conflict = null;
}

/** Text of a session: the live view when it is on screen, otherwise its snapshot. */
/**
 * Open `path` as a tab without switching to it.
 *
 * For a main document named by `% !TeX root`: the project root must be a
 * session (export, print and SyncTeX resolve it by id), but the reader asked
 * to stay in the chapter they are editing.
 */
async function backgroundSession(path: string): Promise<Session | null> {
  const existing = sessions.findByPath(path);
  if (existing) return existing;
  try {
    return await lifecycle.exclusivePath(path, async () => {
      const raced = sessions.findByPath(path);
      if (raced) return raced;
      const payload = await api.readDocument(path);
      const session = sessions.create();
      describe(session, payload);
      sessions.add(session);
      // The store does not redraw the strip; without this the main file was
      // open but invisible until the next tab change.
      renderDocTabs();
      return session;
    });
  } catch {
    return null;
  }
}

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

/**
 * Remove preview content that does not belong to the active document.
 *
 * This is the one place foreign content is taken off screen. The pane's view
 * objects go with it: a PDF view still owns page canvases and a map worker, and
 * a Typst host still holds its export stylesheet. `latexPreview` deliberately
 * stays — it is also the project-root memory that decides which file a chapter
 * compiles against.
 */
function retirePreview(): void {
  previewPane.querySelector(":scope > .source-preview-warning")?.remove();
  selectedLatexProblem = null;
  compiledUi.reset();
  latexPartial = null;
  delete preview.dataset.latexPartial;
  previewPane.querySelector(":scope > .typst-viewbar")?.remove();
  previewPane.querySelector(":scope > .latex-warnings")?.remove();
  previewPane.querySelector(":scope > .latex-build-status")?.remove();
  preview.replaceChildren();
  preview.style.minHeight = "";
  delete preview.dataset.latexCurrent;
  delete preview.dataset.latexMs;
  delete preview.dataset.pdfCommit;
  disposeTypstPdf();
  typstPdfToken = -1;
  latexLastSourceScroll = null;
  previewLinesMapped = false;
  previewOwner = null;
  committedKey = null;
  proseMap = null;
  clearPending();
}

/** A render that started for the previous tab must not paint this one. */
function invalidatePreview(): void {
  // Keep the outgoing tab's preview for its return instead of destroying it.
  if (!covers(previewOwner, probeOf(doc))) parkPreview();
  latexInFlight = false;
  latexPartial = null;
  delete preview.dataset.latexPartial;
  previewPane.querySelector(":scope > .latex-build-status")?.remove();
  previewPane.querySelector(":scope > .latex-warnings")?.remove();
  delete preview.dataset.latexCurrent;
  renderToken += 1;
  wordMapGeneration += 1;
  discardStagedPdf();
  cancelPreviewWorkers();
  typstPdf?.cancelMap();
  typstScheduler.reset();
  cancelTypstRender();
  // The warm LaTeX engine is kept across tab switches: a chapter of the same
  // project reuses it, and another project's first compile replaces it. The
  // outgoing render's result is dropped by its token and activeId.
  window.clearTimeout(renderTimer);
  window.clearTimeout(selectionTimer);
  wordMap = null;
  syncedSource = null;
  wordSyncDismissed = false;
  dismissedWordSelection = null;
  clearPreviewWords();
  editor?.clearSyncRange();
  // The DOM still describes the tab that was on screen a moment ago.
  previewStale = true;
  previewSyncReady = false;
  lastTypstRender = null;
  // A rebuild for the same owner keeps the last readable output; another
  // document's content is removed before the new render can be slow. The
  // pending surface is re-armed for whichever document is now active.
  if (!covers(previewOwner, probeOf(doc))) {
    retirePreview();
    armPending();
  }
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
  editor.setLanguage(editorLanguageFor(doc));
  assistant?.sync();
  // The backend counted while reading the file, so opening does not send the
  // document back over IPC. This also cancels the debounced scan that the
  // `setDoc` update just scheduled. A buffer with no count of its own is scanned.
  if (tokens !== null) setTokenCount(tokens);
  else scheduleTokenCount(content, true);

  applyLayout();
  await refreshTitle();
  refreshStatus();
  renderDocTabs();
  if (preferences?.isOpen()) preferences.refresh();
  renderSidebar();
  renderNotice();
  scheduleRender(true);
}

/**
 * Show the session that is already `doc`, from the state captured when it was
 * hidden. Global chrome is reapplied afterwards: a restored EditorState still
 * carries the font size and palette from the moment it was snapshotted.
 */
let preservingLatexHandoff = false;
async function displayDoc(preservePdf = false): Promise<void> {
  // A different document means the answer no longer belongs to the range it
  // was requested for. Closing here covers tab switches, new documents and
  // closing the active tab, not only `activateSession`.
  assistant?.close();
  // The reading belongs to the document that was on screen; a tab switch, a
  // reload or a closed tab must not leave a voice talking about another file.
  stopReadAloud();
  if (!preservePdf) invalidatePreview();
  pendingPreviewScroll = preservePdf ? null : doc.previewScroll;
  // A kept preview comes back at the tab's remembered offset. The offset also
  // stays pending: the render that follows applies it right before it syncs
  // the panes, in the same order a full rebuild does, so the sync cannot move
  // the preview away from where the reader left it.
  if (!preservePdf) restorePreview();
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
  editor.setLanguage(editorLanguageFor(doc));
  assistant?.sync();
  // A captured EditorState keeps the marks it had; a tab that was hidden before
  // the failure has none, so paint the last compile's list for it. No pulse: the
  // beat belongs to the failure, not to every tab switch.
  applyLatexMarks(latexProblems, latexProblemRoot, doc.path, false);
  syncGuest(doc.language);
  resetOutline();
  applyLayout();
  editor.setSpellcheck(
    {
      enabled: settings.spellcheck !== false,
      language: effectiveSpellingLanguage(),
      documentLanguage: doc.language,
      words: [...(settings.spellcheckWords ?? []), ...ignoredSpellingWords()],
      stringMode: settings.spellcheckStringMode,
      identifiers: settings.spellcheckIdentifiers,
      readOnly: doc.readOnly,
      sessionKey: spellingSessionKey(),
    },
    true,
  );
  resetTokenCount();
  scheduleTokenCount(editor.getDoc(), true);
  await refreshTitle();
  refreshStatus();
  renderDocTabs();
  if (preferences?.isOpen()) preferences.refresh();
  renderSidebar();
  renderNotice();
  scheduleOutlineRefresh(editor.getDoc());
  if (!preservePdf) {
    scheduleRender(true);
    editor.focus();
  }
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

/**
 * Open `path`, or focus the tab that already holds it.
 *
 * Resolves to the session that now shows the file, or null when it could not
 * be read; a caller that acts afterwards acts on that session, not on whatever
 * `doc` is by then. The read and the adoption into the store run under the
 * lifecycle's per-path key, and the store is checked again after the read: a
 * second open of the same path, or a Save As to it, finishes first or waits.
 */
async function openPath(path: string, options: OpenOptions = {}): Promise<Session | null> {
  const { silent = false, rememberRecent = true } = options;
  const existing = sessions.findByPath(path);
  if (existing) {
    await activateSession(existing.id);
    return existing;
  }

  try {
    const adopted = await lifecycle.exclusivePath(path, async () => {
      const payload = await api.readDocument(path);
      const raced = sessions.findByPath(path);
      if (raced) return { session: raced, payload, showing: null };
      if (takeStartupSlot()) {
        describe(doc, payload);
      } else {
        snapshotDoc();
        const session = sessions.create();
        describe(session, payload);
        sessions.add(session);
        doc = session;
      }
      // Installed in the same turn as the adoption, so no other open sees the
      // new tab in the store with the previous document still in the editor.
      return { session: doc, payload, showing: showInEditor(true, payload.tokens) };
    });
    if (!adopted.showing) {
      await activateSession(adopted.session.id);
      return adopted.session;
    }
    const payload = adopted.payload;
    await adopted.showing;

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
    return adopted.session;
  } catch (error) {
    if (!silent) {
      await message(String(error), { title: "Could not open file", kind: "error" });
    } else {
      toast(String(error));
    }
    return null;
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
  const fill = replace || takeStartupSlot();
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
    doc.incarnation += 1;
    doc.path = null;
    doc.name = "Untitled";
    doc.directory = null;
    doc.language = language;
    doc.savedContent = content;
    doc.dirty = false;
    doc.lineEnding = "\n";
    doc.hadBom = false;
    doc.encoding = "UTF-8";
    doc.encodingBlocked = false;
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

/**
 * Open an AI answer as its own untitled tab.
 *
 * `loadUntitled` records the content as the saved baseline, because a bundled
 * document is reproduced from the bundle and closing it loses nothing. An answer
 * is not reproducible, so the baseline is cleared and the tab starts dirty: the
 * tab strip shows its dot, Ctrl+W asks before discarding it, and the recovery
 * journal holds the text until it is saved or discarded.
 */
async function openAiDocument(text: string, language: api.DocumentLanguage): Promise<void> {
  try {
    await loadUntitled(text, language);
  } catch (error) {
    toast(`Could not open a new tab: ${String(error)}`);
    return;
  }
  doc.savedContent = "";
  setDirty(true);
  recovery.schedule(doc, text);
  toast("Opened the answer in a new tab — use Save As to keep a copy.");
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

/**
 * Tools › Encoding and Line Endings, for the active document.
 *
 * The dialog is modal and receives one text snapshot; the actions re-check that
 * the same session is still active and its text unchanged before applying an
 * in-document declaration edit, because a Save As or reload prompt can sit
 * between the dialog closing and the action running.
 */
function openEncodingDialog(
  extra: { tab?: "convert" | "reinterpret"; notice?: string } = {},
): void {
  const session = doc;
  const text = editor.getDoc();
  showEncodingDialog(
    {
      name: session.name ?? "Untitled",
      path: session.path,
      readOnly: session.readOnly,
      dirty: session.dirty,
      language: session.language,
      encoding: session.encoding,
      hadBom: session.hadBom,
      lineEnding: session.lineEnding === "\r\n" ? "\r\n" : "\n",
      text,
      ...extra,
    },
    {
      inspect: () => (session.path ? api.inspectDocumentEncoding(session.path) : null),
      fit: (encoding) => api.checkEncodingFit(text, encoding),
      reopen: (encoding) => void reopenWithEncoding(session, encoding),
      convert: (format, copy, edits) => void convertDocument(session, format, copy, edits, text),
      apply: (format, edits) => {
        applyDeclarationEdits(session, edits, text);
        session.encoding = format.encoding;
        session.hadBom = format.hadBom;
        session.lineEnding = format.lineEnding;
        if (session === doc) refreshStatus();
        toast(`The first save will write ${formatLabel(format)}`);
      },
      goTo: (offset) => {
        if (session !== doc) return;
        const code = editor.getDoc().codePointAt(offset) ?? 0;
        editor.view.dispatch({
          selection: { anchor: offset, head: offset + (code > 0xffff ? 2 : 1) },
          scrollIntoView: true,
        });
        editor.focus();
      },
      focusEditor: () => editor.focus(),
    },
  );
}

function formatLabel(format: SaveFormat): string {
  const bom = format.hadBom && format.encoding === "UTF-8" ? " with BOM" : "";
  return `${displayEncoding(format.encoding)}${bom} · ${format.lineEnding === "\r\n" ? "CRLF" : "LF"}`;
}

/** One undoable transaction, only on the text the dialog measured. */
function applyDeclarationEdits(session: Session, edits: DeclarationEdit[], snapshot: string): void {
  if (!edits.length) return;
  if (session !== doc || editor.getDoc() !== snapshot) {
    toast("The text changed, so its encoding declaration was not updated.", 4200);
    return;
  }
  editor.view.dispatch({ changes: edits, userEvent: "input" });
}

async function convertDocument(
  session: Session,
  format: SaveFormat,
  copy: boolean,
  edits: DeclarationEdit[],
  snapshot: string,
): Promise<void> {
  applyDeclarationEdits(session, edits, snapshot);
  try {
    if (await lifecycle.convert(session, format, copy)) toast(`Saved as ${formatLabel(format)}`);
  } catch (error) {
    await message(String(error), { title: "Could not convert", kind: "error" });
  }
  if (session === doc) refreshStatus();
}

/** Reinterpret: replace the buffer with a strict decode in a chosen encoding. */
async function reopenWithEncoding(session: Session, encoding: string): Promise<void> {
  try {
    if (!(await lifecycle.reload(session, (path) => api.readDocumentAs(path, encoding)))) return;
  } catch (error) {
    await message(String(error), { title: "Could not reopen", kind: "error" });
    return;
  }
  if (session !== doc) return;
  refreshStatus();
  // The reading lasts while the tab is open; detection runs again on the next
  // open. Offer the conversion that makes it permanent straight away.
  openEncodingDialog({
    tab: "convert",
    notice:
      `Reopened as ${displayEncoding(encoding)}. MDraft detects the encoding again the next time ` +
      "it opens this file, so convert it to keep this reading.",
  });
}

/** Replace a conflicted buffer with the file, keeping one undo step. */
async function reloadConflict(session: Session): Promise<void> {
  try {
    invalidateAsciidocIncludeCache(session.path ?? undefined);
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
async function saveAs(
  suggestedPath?: string,
  session: Session = doc,
  encoding?: string,
): Promise<boolean> {
  try {
    const ok = await lifecycle.saveAs(session, suggestedPath, encoding);
    if (ok) toast("Saved");
    return ok;
  } catch (error) {
    await message(String(error), { title: "Could not save", kind: "error" });
    return false;
  }
}
async function saveSession(session: Session): Promise<boolean> {
  const saved = await writeSession(session);
  if (
    saved &&
    session === doc &&
    doc.language === "latex" &&
    settings.latexAutoCompile !== false &&
    previewStale &&
    !latexInFlight
  )
    scheduleRender(true);
  return saved;
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
      else if (activeRemoved) {
        // `next` is null only if the store disagreed about the active tab; the
        // removed `doc` must not stay on screen either way.
        doc = next ?? sessions.setActive(sessions.list()[0].id);
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
    imageRoot: doc.language === "typst" ? typstExtraRoot() : customImageFolder(),
  };
}

/**
 * The LaTeX project a conversion reads, or a reason it cannot be read.
 *
 * Captured **before** any dialog opens, for the same reason `exportSource` is:
 * the reader can switch tabs or edit while the save dialog is up, and a
 * conversion must export the project it was started for. The snapshot is the
 * same bounded, project-confined one the compiler receives, so an unsaved
 * `\input` chapter reaches the export and a file outside the root is refused
 * rather than silently read.
 *
 * A conversion needs no compile — pandoc reads the sources — so this asks only
 * for a saved root. The compiled-PDF route is the one that requires a current
 * compile, and it checks that separately.
 */
async function latexExportSnapshot(): Promise<
  { snapshot: api.ExportSnapshot; root: Session } | { error: string }
> {
  // The preview's root wins when it is for this document, because that is the
  // project the reader is looking at; otherwise the active tab is the root.
  const preview = latexPreview;
  const root =
    (preview && preview.activeId === doc.id ? sessions.byId(preview.rootId) : undefined) ?? doc;
  if (doc.language !== "latex") {
    return { error: "This document is not LaTeX." };
  }
  if (!root.path || !root.directory) {
    return { error: "Save the main .tex file before exporting." };
  }
  const rootPrefix = pathKey(root.directory) + "/";
  const overlays = sessions
    .list()
    .filter(
      (session): session is Session & { path: string } =>
        session.path !== null &&
        pathKey(session.path).startsWith(rootPrefix) &&
        /\.(?:tex|bib|sty|cls|bst)$/i.test(session.path),
    )
    .map((session) => ({
      path: session.path,
      text: textOf(session),
      encoding: session.encoding,
      hadBom: session.hadBom,
      lineEnding: session.lineEnding,
    }));
  try {
    // Conversions keep their project-only snapshot: a registered library is
    // never injected into Pandoc, and a broken one does not block an export.
    const captured = await api.latexProjectSnapshot(root.path, overlays, false);
    return {
      snapshot: {
        root: root.directory,
        mainFile: captured.mainFile,
        files: captured.files,
      },
      root,
    };
  } catch (error) {
    return { error: String(error) };
  }
}

/**
 * The request a LaTeX conversion sends, or `null` after explaining why not.
 *
 * Every non-PDF route shares it so the reader cannot get a conversion of a
 * different project than the one the preview is showing.
 */
function latexExportRequest(
  snapshot: api.ExportSnapshot,
  source: ReturnType<typeof exportSource>,
  formatId: string,
  outputPath: string,
  inputPath: string | null,
): api.ExportRequest {
  return {
    formatId,
    markdown: source.text,
    outputPath,
    inputPath,
    language: "latex",
    imageRoot: source.imageRoot,
    snapshot,
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
    const rendered = renderPreview(source.text, {
      baseDir: source.directory ?? null,
      documentPath: source.path,
      math: settings.enableMath,
      mermaid: settings.enableMermaid,
    });
    holder.innerHTML = rendered.html;
    await resolveLegacyImagesForExport(holder, rendered.legacyImages, source.path);
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
  // A `.tex` document is HTML only through pandoc's LaTeX reader: the Markdown
  // preview renderer would treat `\section` as literal text. The snapshot is
  // captured before the dialog, so an unsaved chapter reaches the export.
  if (source.language === "latex") {
    await exportLatexWithWriter("html", "HTML", "html", source);
    return;
  }
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

/**
 * The one toast an export or a printout ends on.
 *
 * The file was written, so a resource the print surface could not fetch, or a
 * warning pandoc emitted, leaves nothing for the reader to decide: it belongs in
 * the same transient line as the success rather than a dialog that has to be
 * dismissed. The toast's own rule keeps one entry per line (`pre-line`), so a
 * list of resources stays a list. Only a failure that stops the export is still
 * a dialog.
 */
function toastReport(success: string | null, details: readonly string[]): void {
  const lines = details.filter((line) => line.length > 0);
  if (success === null && lines.length === 0) return;
  const text = success === null ? lines.join("\n") : [success, ...lines].join("\n");
  toast(text, lines.length > 0 ? 8200 : 2600);
}

/** The resources the print surface could not fetch, as report lines. */
function missingResources(failed: readonly string[]): string[] {
  if (failed.length === 0) return [];
  return ["These resources did not load and may be missing from the printout:", ...failed];
}

/**
 * Export PDF through the platform webview.
 *
 * The article and the page CSS are the same ones the preview uses; only the
 * output path changes. Windows writes through WebView2's `PrintToPdf`, Linux
 * through WebKitGTK print settings. A host without either API gets the browser
 * handoff instead of a silent no-op.
 */
/** Base64 for a byte array, chunked so a large PDF cannot blow the argument stack. */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

/**
 * Save the PDF the preview currently holds, for a PDF-rendered language.
 *
 * One implementation for Typst Pages and LaTeX: both hand over the bytes their
 * own compiler emitted, so the only differences are the dialog title, the
 * suggested name and the engine's name. The freshness check is repeated after
 * the dialog closes, because a compile can finish — or a tab can switch — while
 * the reader is choosing a path, and writing the previous document's pages would
 * be worse than refusing.
 */
async function saveCompiledPdf(options: {
  /** The PDF bytes, base64 as the command expects them. */
  data: string;
  /** The render token the bytes belong to. */
  token: number;
  /** The session whose document was compiled; may differ from the active tab. */
  sessionId: string;
  revision: number;
  engine: string;
  defaultPath: string;
  /**
   * Every project file the compile read, for a multi-file document.
   *
   * A LaTeX project's PDF becomes stale when any chapter changes, not only the
   * file the tab happened to be showing, so the check after the dialog compares
   * the whole set. Absent for a single-document engine, where `revision` is the
   * whole story.
   */
  revisions?: Array<{ id: string; revision: number; path: string | null }>;
  /**
   * Run the global after-export options on success.
   *
   * Set by File › Export › PDF, which is an export; the preview's own Save PDF
   * button is a save, and running a configured "open the file" action there
   * would be a surprise.
   */
  afterExport?: boolean;
  title?: string;
}): Promise<boolean> {
  const chosen = await saveDialog({
    title: options.title ?? `Save PDF compiled by ${options.engine}`,
    defaultPath: options.defaultPath,
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  });
  if (!chosen) return false;
  const session = sessions.byId(options.sessionId);
  const projectChanged =
    options.revisions?.some((item) => {
      const current = sessions.byId(item.id);
      return current?.revision !== item.revision || current.path !== item.path;
    }) ?? false;
  if (
    options.token !== renderToken ||
    !session ||
    session.revision !== options.revision ||
    projectChanged
  ) {
    toast("The document changed; compile again before saving.", 5200);
    return false;
  }
  try {
    await api.saveCompiledPdf(chosen, options.data);
    toast(`Saved ${basename(chosen)}`);
    // File › Export › PDF runs the global after-export actions on success only;
    // the preview button is a save, not an export, and stays silent.
    if (options.afterExport) {
      const after = await api.runAfterExport(chosen);
      if (after.afterErrors.length > 0) {
        await message(after.afterErrors.join("\n\n"), {
          title: "Saved, with a problem",
          kind: "warning",
        });
      }
    }
    return true;
  } catch (error) {
    await message(String(error), { title: "Could not save PDF", kind: "error" });
    return false;
  }
}

/**
 * Save the LaTeX preview's compiled PDF, from File › Export › PDF.
 *
 * The same bytes, root and freshness rule as the preview's own Save PDF button:
 * the file is named after the project root even when a chapter is the active
 * tab, and the whole compile snapshot is checked again after the dialog closes,
 * because a compile can finish or a tab can switch while the reader is choosing
 * a path. It never starts a compile.
 */
async function exportCompiledLatexPdf(): Promise<void> {
  const value = latexPreview;
  if (!latexCurrent(value) || value.token !== renderToken) {
    toast("Wait for the current LaTeX compilation before exporting the PDF.");
    return;
  }
  const root = sessions.byId(value.rootId);
  await saveCompiledPdf({
    data: bytesToBase64(value.result.pdf),
    token: value.token,
    sessionId: doc.id,
    revision: doc.revision,
    engine: value.result.engine ?? "LaTeX",
    defaultPath: (root?.path ?? "document.tex").replace(/\.tex$/i, ".pdf"),
    // The full snapshot, not just the active tab: a chapter edit invalidates the
    // PDF even though the root file's own revision did not move.
    revisions: value.revisions,
    afterExport: true,
  });
}

/**
 * Export PDF.
 *
 * For Typst and LaTeX this writes the PDF their own compiler produced — the same
 * bytes the preview is drawing — because a second, differently-laid-out PDF
 * behind the same document would contradict what the reader sees. Every other
 * language keeps the native print surface, which is the article the preview
 * builds. A missing or stale PDF is refused with a reason: a multi-second engine
 * run behind a menu item is indistinguishable from a hang.
 */
async function exportPdf(): Promise<void> {
  const source = exportSource();
  if (source.language === "latex") {
    await exportCompiledLatexPdf();
    return;
  }
  if (source.language === "typst") {
    if (settings.typstView !== "pages" || !typstPdfBytes || !typstPdfCurrent()) {
      toast("Switch to the Pages view and wait for the compile before exporting the PDF.");
      return;
    }
    await saveCompiledPdf({
      data: encodePdfBase64(typstPdfBytes),
      token: typstPdfToken,
      sessionId: doc.id,
      revision: doc.revision,
      engine: "Typst",
      defaultPath: (doc.path ?? doc.name).replace(/\.typ$/i, ".pdf"),
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
    toastReport("Exported PDF", missingResources(result.failedResources));
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

  // LaTeX prints the PDF its own compiler produced, never a re-render: a second
  // layout of the same document would contradict the preview beside it. See
  // `docs/adr/2026-11-06-print-the-compiled-pdf.md`.
  //
  // A stale preview is refused for the same reason `Export › PDF` refuses it, and
  // Print never starts a compile of its own — a multi-second LuaLaTeX run behind
  // a Print row would be a surprise.
  if (source.language === "latex") {
    const value = latexPreview;
    if (!latexCurrent(value)) {
      toast("Wait for the current LaTeX compilation before printing.", 5200);
      return;
    }
    const notice = toast("Preparing to print…", 0);
    try {
      const written = await api.printCompiledPdf(
        bytesToBase64(value.result.pdf),
        source.name ?? "document",
      );
      notice.dismiss();
      console.info(`[print] compiled PDF written to ${written}`);
    } catch (error) {
      notice.dismiss();
      await message(String(error), { title: "Could not print the LaTeX PDF", kind: "error" });
    }
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
    if (result.status !== "cancelled") toastReport(null, missingResources(result.failedResources));
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
/** Optional companion Typst incremental service status, cached for Preferences. */
let typstServiceCache: api.TypstServiceStatus | null = null;

async function refreshTypstServiceStatus(): Promise<void> {
  try {
    typstServiceCache = await api.typstServiceStatus();
  } catch {
    return;
  }
  preferences?.refresh();
}

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
  // A `.tex` file is handed to pandoc's own LaTeX reader, which is why the
  // language travels with the request. It used to be refused here, on the belief
  // that pandoc would parse it with the Markdown reader; that was true only
  // because the backend had no `latex` arm. DOCX, ODT and EPUB are formats LaTeX
  // cannot write itself, so refusing them cost the reader real output.
  // The menu disables formats whose tool is missing, but a stale menu, a
  // keyboard route or a settings file edited elsewhere must not open a save
  // dialog for an export that cannot run. Ask before choosing a path.
  //
  // The built-in pandoc PDF converts to Typst and needs that engine. For LaTeX
  // the row is disabled with its own reason, and a stale menu must not reach
  // here: the compiled PDF is the only PDF route a `.tex` document has.
  if (format.id === "pdf" && snapshot.language === "latex") {
    toast("Use Export › PDF, which writes the PDF this document's engine compiled.");
    return;
  }
  // A `.tex` project converts from a snapshot of the project this export was
  // started for. It is captured before the first await — the tool lookup
  // included — so a tab switch cannot pair this source with another project.
  const latexCapture = snapshot.language === "latex" ? latexExportSnapshot() : null;
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

  let latexProject: { snapshot: api.ExportSnapshot; root: Session } | null = null;
  if (latexCapture) {
    const captured = await latexCapture;
    if ("error" in captured) {
      await message(captured.error, {
        title: "Could not read the LaTeX project",
        kind: "error",
      });
      return;
    }
    latexProject = captured;
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
    const request: api.ExportRequest = {
      formatId: format.id,
      markdown: source,
      outputPath,
      inputPath: snapshot.path,
      // Tells the backend which reader to use, and that a Typst document exported
      // to PDF is rendered by Typst itself rather than translated through pandoc.
      language,
      imageRoot: snapshot.imageRoot,
      // A configured format keeps its own id, arguments and style reference, so
      // it goes through `run_export`; only the chooser's ad-hoc writer uses
      // `run_pandoc_writer`. Both share the same staging and conversion helper.
      snapshot: latexProject?.snapshot ?? null,
    };
    const outcome = await api.runExport(request);
    notice.dismiss();
    toastReport(
      `Exported ${basename(outcome.outputPath)}`,
      outcome.warnings ? [outcome.warnings] : [],
    );

    // Pandoc can warn and still write the file, and an after-export step can
    // fail without the file being wrong. The warnings ride in the success
    // toast; a step that failed is a failure the reader should see, so it keeps
    // its dialog.
    if (outcome.afterErrors.length > 0) {
      await message(outcome.afterErrors.join("\n\n"), {
        title: "Exported, with a problem",
        kind: "warning",
      });
    }
  } catch (error) {
    notice.dismiss();
    await message(String(error), { title: "Could not export", kind: "error" });
  }
}

/**
 * Convert a `.tex` project with one pandoc writer.
 *
 * Shared by the direct HTML and Markdown rows and by the chooser, so the
 * snapshot capture, the tool check, the save dialog and the warning report
 * cannot differ between two routes that produce the same kind of file. A caller
 * that already captured the project passes it in; otherwise it is captured here,
 * before the dialog, because the reader can switch tabs while choosing a path.
 */
async function exportLatexWithWriter(
  writer: string,
  label: string,
  extension: string,
  source: ReturnType<typeof exportSource>,
  capturedProject?: { snapshot: api.ExportSnapshot; root: Session },
): Promise<void> {
  // Started before the tool lookup can yield: the project is the one this
  // export was started for, whatever tab is active when the lookup returns.
  const capture = capturedProject ?? latexExportSnapshot();
  if (!pandocCache) await refreshPandocStatus();
  if (pandocCache && !pandocCache.found) {
    toast("Pandoc is not installed — install it before exporting.");
    await pandocSetup();
    return;
  }
  const captured = await capture;
  if ("error" in captured) {
    await message(captured.error, { title: "Could not read the LaTeX project", kind: "error" });
    return;
  }

  const base = documentStem(captured.root.name);
  const suggested = settings.lastDirectory
    ? joinDir(settings.lastDirectory, `${base}.${extension}`)
    : `${base}.${extension}`;
  const chosen = await saveDialog({
    title: `Export as ${label}`,
    defaultPath: suggested,
    filters: [
      { name: label, extensions: [extension] },
      { name: "All files", extensions: ["*"] },
    ],
  });
  if (!chosen) return;
  const outputPath = Array.isArray(chosen) ? chosen[0] : chosen;

  const notice = toast(`Exporting with pandoc…`, 0);
  try {
    const outcome = await api.runPandocWriter(
      latexExportRequest(captured.snapshot, source, writer, outputPath, captured.root.path),
      writer,
    );
    notice.dismiss();
    toastReport(
      `Exported ${basename(outcome.outputPath)}`,
      outcome.warnings ? [outcome.warnings] : [],
    );

    // Pandoc can warn and still write the file, and an after-export step can
    // fail without the file being wrong. The warnings ride in the success
    // toast; a step that failed is a failure the reader should see, so it keeps
    // its dialog.
    if (outcome.afterErrors.length > 0) {
      await message(outcome.afterErrors.join("\n\n"), {
        title: "Exported, with a problem",
        kind: "warning",
      });
    }
  } catch (error) {
    notice.dismiss();
    await message(String(error), { title: "Could not export", kind: "error" });
  }
}

/**
 * Export › Markdown for a non-Markdown document.
 *
 * Markdown is the editor's own dialect, so writing it back through pandoc would
 * be a round trip for a Markdown document. The direct row exists for LaTeX,
 * which the plan names explicitly: a `.tex` author should not need a custom
 * format recipe to reach Markdown.
 */
async function exportMarkdown(): Promise<void> {
  const source = exportSource();
  if (source.language !== "latex") {
    toast("This document is already Markdown, or has its own Markdown target.");
    return;
  }
  await exportLatexWithWriter("markdown", "Markdown", "md", source);
}

/**
 * File › Export › More Pandoc Formats….
 *
 * The writer list comes from the installed pandoc, so a pandoc update adds rows
 * without a settings migration. `pdf` becomes the compiled-PDF route rather than
 * a conversion, and a bibliography-only writer is labelled as such instead of
 * producing an empty file that looks like a success.
 */
async function openWriterChooser(): Promise<void> {
  const source = exportSource();
  if (source.language !== "latex") {
    // The chooser is the LaTeX route: every other language already has its own
    // configured rows, and offering the raw writer list there would duplicate
    // them with different arguments.
    toast("More Pandoc formats are available for LaTeX documents.");
    return;
  }
  // The source and project are captured before the tool lookup and before the
  // list is fetched, so a tab switch meanwhile cannot change what is exported.
  const capture = latexExportSnapshot();
  if (!pandocCache) await refreshPandocStatus();
  if (pandocCache && !pandocCache.found) {
    toast("Pandoc is not installed — install it before exporting.");
    await pandocSetup();
    return;
  }
  const captured = await capture;
  if ("error" in captured) {
    await message(captured.error, { title: "Could not read the LaTeX project", kind: "error" });
    return;
  }

  let writers: api.PandocWriter[];
  try {
    writers = await api.pandocListWriters();
  } catch (error) {
    await message(String(error), { title: "Could not list Pandoc formats", kind: "error" });
    return;
  }

  const choice = await showWriterChooser(
    {
      writers,
      documentName: captured.root.name,
      pdfLabel: `PDF (compiled by ${latexPreview?.result.engine ?? "LaTeX"})`,
    },
    () => editor.focus(),
  );
  if (!choice) return;
  if (choice.kind === "compiled-pdf") {
    await exportCompiledLatexPdf();
    return;
  }
  const writer = choice.writer;

  const base = documentStem(captured.root.name);
  const suggested = settings.lastDirectory
    ? joinDir(settings.lastDirectory, `${base}.${writer.extension}`)
    : `${base}.${writer.extension}`;
  const chosen = await saveDialog({
    title: `Export as ${writer.label}`,
    defaultPath: suggested,
    filters: [
      { name: writer.label, extensions: [writer.extension] },
      { name: "All files", extensions: ["*"] },
    ],
  });
  if (!chosen) return;
  const outputPath = Array.isArray(chosen) ? chosen[0] : chosen;

  const notice = toast("Exporting with pandoc…", 0);
  try {
    const outcome = await api.runPandocWriter(
      latexExportRequest(captured.snapshot, source, writer.id, outputPath, captured.root.path),
      writer.id,
    );
    notice.dismiss();
    toastReport(
      `Exported ${basename(outcome.outputPath)}`,
      outcome.warnings ? [outcome.warnings] : [],
    );

    // Pandoc can warn and still write the file, and an after-export step can
    // fail without the file being wrong. The warnings ride in the success
    // toast; a step that failed is a failure the reader should see, so it keeps
    // its dialog.
    if (outcome.afterErrors.length > 0) {
      await message(outcome.afterErrors.join("\n\n"), {
        title: "Exported, with a problem",
        kind: "warning",
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
/**
 * Tools › Check or Install LaTeX…
 *
 * The same three-state dialog Pandoc and Typst use. The engine is a single
 * boolean to the frontend — it is either enabled and verified, or it is not —
 * so this reports which, and offers the download when it is missing.
 *
 * The switch lives in `settings.json` (decision D2), so enabling writes it and
 * the next render picks it up without reopening the document.
 */
async function latexSetup(): Promise<void> {
  let enabled: boolean;
  try {
    enabled = await api.texpressoStatus();
  } catch (error) {
    await message(String(error), { title: "Could not look for bundled TeX", kind: "error" });
    return;
  }

  if (enabled) {
    let cache: api.LatexCacheInfo | null = null;
    try {
      cache = await api.latexCacheInfo();
    } catch {
      // A cache that cannot be measured is reported as absent rather than as an
      // error dialog: the engine itself is working, which is the answer here.
    }
    const size =
      cache && cache.bytes > 0
        ? `\nDownloaded packages and fonts: ${(cache.bytes / 1048576).toFixed(1)} MiB, under a ${cache.limitMb} MiB ceiling.`
        : "\nNo TeX packages have been downloaded yet; they arrive on demand.";
    await message(
      "Bundled TeX is ready.\n\n" +
        "It compiles .tex documents locally. Your document never leaves this device." +
        size +
        "\n\nExport › PDF writes the PDF the preview is showing.",
      { title: "Bundled TeX", kind: "info" },
    );
    return;
  }

  const agreed = await ask(
    "Bundled TeX is not installed, so .tex documents have no preview.\n\n" +
      `MDraft can download the verified TeX Live ${TEXPRESSO_TEXLIVE_YEAR} preview engine — about ${TEXPRESSO_ENGINE_MIB} MiB — into its own data folder. ` +
      "TeX packages and fonts are fetched on demand and cached locally. " +
      "Nothing is installed system-wide, no administrator rights are needed, and turning it off " +
      "in Preferences leaves the downloaded files on disk.\n\n" +
      "Your document stays on this device.",
    { title: "Install bundled TeX", kind: "info", okLabel: "Download", cancelLabel: "Cancel" },
  );
  if (!agreed) return;

  const notice = toast("Downloading bundled TeX…", 0);
  try {
    await api.installTexpresso();
    settings.latexEnabled = true;
    persist();
    notice.dismiss();
    await refreshLatexCacheInfo();
    preferences?.refresh();
    scheduleRender(true);
    await message(
      "Bundled TeX is ready.\n\nOpen or save a .tex file and its preview will appear beside it.",
      { title: "Bundled TeX installed", kind: "info" },
    );
  } catch (error) {
    notice.dismiss();
    await message(String(error), { title: "Could not install bundled TeX", kind: "error" });
  }
}

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
  // A new compiler may render the same source differently.
  typstStore.clear();
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
  if (doc.language === "latex") {
    editor.setLatexHeading(level);
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
  if (doc.language === "latex") {
    editor.setLatexHeading(0);
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
  if (doc.language === "latex") {
    editor.shiftLatexHeading(delta);
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
  if (doc.language === "latex") {
    editor.insertBlockWithCaret(LATEX_QUOTE.text, LATEX_QUOTE.caret);
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
  if (doc.language === "latex") {
    editor.insertBlockWithCaret(LATEX_CODE.text, LATEX_CODE.caret);
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
  if (doc.language === "latex") {
    // A LaTeX list is an environment, not a line prefix: `\item` alone outside
    // one is a compile error, so the block is inserted whole.
    const environment = kind === "ul" ? "itemize" : "enumerate";
    const text = `\\begin{${environment}}\n  \\item \n\\end{${environment}}`;
    editor.insertBlockWithCaret(text, text.indexOf("\\item ") + "\\item ".length);
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
  if (doc.language === "latex") {
    toast(latexUnsupported("task"), 5200);
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
  if (doc.language === "latex") {
    editor.insertBlockWithCaret(LATEX_TABLE.text, LATEX_TABLE.caret);
    return;
  }
  editor.insertBlock("| Column | Column |\n| --- | --- |\n| Cell | Cell |");
}

function ruleCommand(): void {
  if (doc.language === "html") editor.insertBlock("<hr>");
  else if (doc.language === "asciidoc") editor.insertBlock("'''");
  else if (doc.language === "typst") editor.insertBlock(TYPST_RULE);
  else if (doc.language === "latex") editor.insertBlock(LATEX_RULE);
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
  if (doc.language === "latex") {
    editor.insertBlock(LATEX_TOC);
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
  if (doc.language === "latex") {
    toast(latexUnsupported("frontMatter"), 5600);
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
  if (doc.language === "latex") {
    toast(latexUnsupported("alert"), 5600);
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
  if (doc.language === "latex") {
    const inline = latexInline(kind);
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
  if (doc.language === "latex") {
    // `\includegraphics` takes a path and no alt text; the placeholder path is
    // selected so the reader can type over it.
    editor.wrapSelection("\\includegraphics{", "}", "./image.png");
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
  if (doc.language === "latex") {
    // `\[ … \]` is the display form that needs no environment and no package,
    // which is why it is the menu's default rather than `equation`.
    if (editor.cursorInfo().selectionLength > 0) {
      editor.wrapSelection("\\[\n", "\n\\]", "");
    } else {
      editor.insertBlockWithCaret(LATEX_DISPLAY_MATH, 3);
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
  // The target is the field or document focused when the command ran. The
  // clipboard keeps its data, so a target that changed during the read is a
  // cancelled paste the reader can repeat, never a paste into another place.
  const target = document.activeElement;
  const owner = capturePasteOwner();
  const data = await readClipboardData();
  if (!data) {
    toast("Could not read the clipboard.", 4200);
    return;
  }
  if (document.activeElement !== target || pasteOwnerState(owner) !== "live") {
    toast("The document changed before the clipboard was read — paste again.", 4200);
    return;
  }
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

/** Apply one of the editor palettes from View › Code Themes. */
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
      // All files leads, so a document of any markup type is visible without
      // first switching the filter away from the default extension.
      filters: documentFilters(defaultDocumentLanguage(), true),
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
  "view.latexCompile": compileCurrentLatex,
  // No menu item: the differential test triggers a re-anchoring compare.
  "view.latexReanchor": () => reanchorLatex("command"),
  // No menu item either: tests force a blue/green engine swap.
  "view.latexRecycle": () => recycleLatexEngine(),
  // No menu items: the preview backend switch for tests and the comparison.
  "view.latexBackend.texpresso": () => switchLatexBackend("texpresso"),
  "view.latexBackend.wasmtex": () => switchLatexBackend("wasmtex"),
  "view.latexTexpressoExport": () => measureTexpressoExport(),
  "view.preview": () => setViewMode("preview"),
  "view.sidebar": () => setSidebarVisible(!settings.sidebarVisible),
  "view.outline": () => setSidebarTab("outline"),
  "view.favorites": () => setSidebarTab("favorites"),
  "view.recent": () => setSidebarTab("recent"),
  "view.explorer": () => setSidebarTab("explorer"),
  "file.openFolder": () => chooseWorkspaceFolder(),
  "file.closeFolder": closeWorkspaceFolder,
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
  "view.latexAutoCompile": () => setLatexAutoCompile(settings.latexAutoCompile === false),
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
  "tools.statistics": () => {
    const text = editor.getDoc();
    showDocumentStatistics(
      documentStatistics(text),
      api.countTokens(text).catch(() => null),
      () => editor.focus(),
    );
  },
  "tools.encoding": () => openEncodingDialog(),
  "tools.exportConfig": () => preferences.openAt("export"),
  "tools.pandoc": () => void pandocSetup(),
  "tools.typst": () => void typstSetup(),
  "tools.latex": () => void latexSetup(),
  "tools.ai": () => applySettingsPatch({ aiEnabled: settings.aiEnabled === false }),

  "file.preferences": () => preferences.open(),

  "help.reference": () => void showBuiltin(REFERENCE),
  "help.asciidocReference": () => void showBuiltin(ASCIIDOC_REFERENCE, "asciidoc"),
  "help.typstReference": () => void showBuiltin(TYPST_REFERENCE, "typst"),
  "help.latexReference": () => void showBuiltin(LATEX_REFERENCE, "latex"),
  "help.shortcuts": () => void showBuiltin(SHORTCUTS),
  "help.licences": () => void showBuiltin(FONT_LICENCES),
  "help.latexLicenses": showLatexLicenses,
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
  const previousMode = settings.viewMode;
  if (mode !== previousMode) {
    // A worker or delayed word map belongs to the mode in which it started.
    renderToken += 1;
    wordMapGeneration += 1;
    discardStagedPdf();
    cancelPreviewWorkers();
    typstPdf?.cancelMap();
    cancelTypstRender();
    // A view-mode change makes the in-flight LaTeX result stale (token), not
    // the engine: disposing it would cold-boot the next compile.
    latexInFlight = false;
    if (!wordMap) previewSyncReady = false;
  }
  settings.viewMode = mode;
  applyLayout();
  persist();
  if (mode === "source") {
    // Drop a queued rebuild: the pane is hidden, and the next edit should not
    // spend the main thread on it. A current preview stays valid for the switch
    // back; an edit marks it stale as usual. A waiting surface has no pane to
    // fill while hidden, so it goes with the queued render.
    window.clearTimeout(renderTimer);
    clearPending();
    return;
  }
  // Preview Only can reuse a Split render, but Split needs the word map, which
  // Preview Only deliberately does not build. If the preview is stale, the new
  // mode needs the render whichever one it is.
  if (previewStale || (mode === "split" && !previewSyncReady)) scheduleRender(true);
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
  const editor0 = Math.max(0, editor.lineScrollTop(anchor.line) - SYNC_MARGIN);
  const preview0 = previewScrollFor(anchor.el);

  if (index + 1 < previewAnchors.length) {
    const next = previewAnchors[index + 1];
    return {
      editor0,
      preview0,
      editor1: Math.max(editor0, editor.lineScrollTop(next.line) - SYNC_MARGIN),
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
  if (alignDomTextScroll("source")) return;
  const reference = scrollReference("source");
  const delta = blockCorrection(
    domBlockTops("source", reference),
    reference,
    scrollReference("preview"),
  );
  if (delta === null) return;
  suppressPreviewScrollUntil = performance.now() + SYNC_SUPPRESS_MS;
  previewPane.scrollTop = clampScroll(
    previewPane.scrollTop + delta,
    previewPane.scrollHeight - previewPane.clientHeight,
  );
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
  if (alignDomTextScroll("preview")) return;
  const reference = scrollReference("preview");
  const delta = blockCorrection(
    domBlockTops("preview", reference),
    reference,
    scrollReference("source"),
  );
  if (delta === null) return;
  suppressEditorScrollUntil = performance.now() + SYNC_SUPPRESS_MS;
  editor.scrollToOffset(clampScroll(editor.view.scrollDOM.scrollTop + delta, editor.scrollMax()));
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
/** Escape dismisses the current selection even if its map is still pending. */
let wordSyncDismissed = false;
let dismissedWordSelection: {
  anchorNode: Node | null;
  anchorOffset: number;
  focusNode: Node | null;
  focusOffset: number;
} | null = null;

function currentSelectionWasDismissed(): boolean {
  const selection = window.getSelection();
  return (
    wordSyncDismissed &&
    dismissedWordSelection !== null &&
    selection !== null &&
    selection.anchorNode === dismissedWordSelection.anchorNode &&
    selection.anchorOffset === dismissedWordSelection.anchorOffset &&
    selection.focusNode === dismissedWordSelection.focusNode &&
    selection.focusOffset === dismissedWordSelection.focusOffset
  );
}
let selectionTimer = 0;
/** Cancels a word-map build that belongs to an older render. */
let wordMapGeneration = 0;
/** Last document edit, used to keep the word-map build out of an active burst. */
let lastEditAt = 0;
const WORD_MAP_QUIET_MS = 400;
const WORD_MAP_RETRY_MS = 200;
const WORD_MAP_DELAY_MS = 600;
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

/** Run `task` when the main thread is idle, with a timer fallback. */
function scheduleIdle(task: () => void): void {
  const idle = (
    window as unknown as { requestIdleCallback?: (cb: () => void, o?: object) => number }
  ).requestIdleCallback;
  if (typeof idle === "function") idle(task, { timeout: 800 });
  else window.setTimeout(task, 0);
}

interface ProseDebugWindow {
  __mdraftDebug?: {
    wordMapReadyMs?: number | null;
    wordMapDoneAt?: number | null;
  };
}

function resetWordMapDebugTiming(): void {
  const dbg = (window as unknown as ProseDebugWindow).__mdraftDebug;
  if (!dbg) return;
  dbg.wordMapReadyMs = null;
  dbg.wordMapDoneAt = null;
}

/** Rebuild the map against the DOM a render just produced. */
function bindPreviewWords(
  source: string,
  fragments?: Fragment[],
  blocks?: BlockRange[],
  wantsMap = settings.viewMode === "split",
  incrementalApplied = false,
  blockFragmentCounts?: number[],
): void {
  // A render replaces the nodes the old Range pointed at, so drop both the
  // highlight and the pulse before binding the new map.
  clearPreviewWords();
  resetWordMapDebugTiming();
  const generation = ++wordMapGeneration;
  // Word correspondence is only read in Split. A hidden or single-pane preview
  // must not pay for walking every word and measuring nothing.
  const hasFragments = fragments && fragments.length > 0;
  const hasBlocks = blocks && blocks.length > 0;
  wordMap = null;
  domScrollIndex = new ScrollIndex([]);
  domScrollSource = source;
  syncedSource = null;
  if (!wantsMap || (!hasFragments && !hasBlocks)) return;

  // The walk is O(every word). Full rebuilds defer until typing pauses;
  // incremental DOM patches shift retained entries and touch only the dirty
  // subtree, so they run right after paint without waiting 600 ms.
  const build = async (): Promise<void> => {
    if (generation !== wordMapGeneration) return;
    if (!incrementalApplied && performance.now() - lastEditAt < WORD_MAP_QUIET_MS) {
      window.setTimeout(build, WORD_MAP_RETRY_MS);
      return;
    }
    const mapStart = prosePerfMark("wordMap:start");
    const cancelled = () => generation !== wordMapGeneration;
    const map = await bindWordMapAsync(
      preview,
      { source, fragments, blocks, blockFragmentCounts },
      cancelled,
    );
    if (!map || cancelled()) return;
    const index = await scrollTextAnchorsAsync(map, cancelled);
    if (!index || cancelled()) return;
    wordMap = map;
    domScrollIndex = new ScrollIndex(index.anchors, index.sorted);
    prosePerfMeasure("wordMap", mapStart, { incrementalApplied });
    const doneAt = performance.now();
    const debugWindow = window as unknown as ProseDebugWindow;
    debugWindow.__mdraftDebug ??= {};
    debugWindow.__mdraftDebug.wordMapDoneAt = doneAt;
    debugWindow.__mdraftDebug.wordMapReadyMs =
      lastEditAt > 0 ? Math.max(0, doneAt - lastEditAt) : null;
    if (currentSelectionWasDismissed()) return;
    wordSyncDismissed = false;
    dismissedWordSelection = null;
    // A selection can be made while the deferred map is still being built.
    // Reconcile it once the current generation is ready, without moving focus.
    const selection = window.getSelection();
    if (
      selection &&
      !selection.isCollapsed &&
      selection.rangeCount > 0 &&
      preview.contains(selection.getRangeAt(0).commonAncestorContainer)
    ) {
      syncSourceFromPreview(false);
    } else {
      syncPreviewFromSource();
    }
  };
  if (incrementalApplied) {
    queueMicrotask(() => {
      if (generation === wordMapGeneration) void build();
    });
    return;
  }
  // Do not build immediately after a full rebuild: the reader often resumes typing,
  // and the walk can take ~100 ms on a megabyte. A newer edit cancels it.
  window.setTimeout(() => scheduleIdle(() => void build()), WORD_MAP_DELAY_MS);
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
  if (compiledUi.logsOpen) return;
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
let latexGesture = 0;
async function handoffLatexSelection(
  value: LatexPreview,
  context: TypstPageContext,
  reveal: boolean,
  gesture: number,
): Promise<void> {
  const match = context.sourceRange;
  const view = typstPdf;
  if (!match?.file || !view) return;
  const selection = window.getSelection();
  const anchor = selection?.anchorNode,
    anchorOffset = selection?.anchorOffset;
  const focus = selection?.focusNode,
    focusOffset = selection?.focusOffset;
  const sameSelection = (): boolean => {
    const current = window.getSelection();
    return (
      current?.anchorNode === anchor &&
      current?.anchorOffset === anchorOffset &&
      current?.focusNode === focus &&
      current?.focusOffset === focusOffset
    );
  };
  const input = value.result.sources.find((file) => file.path === match.file);
  if (!input) return;
  const path = joinDir(value.rootDirectory, match.file);
  let target = sessions.findByPath(path);
  if (!target) {
    let payload: api.DocumentPayload;
    try {
      payload = await api.readDocument(path);
    } catch {
      return;
    }
    if (!latexCurrent(value) || typstPdf !== view || gesture !== latexGesture || !sameSelection())
      return;
    if (payload.content.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n") !== input.source) return;
    target = sessions.create();
    describe(target, payload);
    sessions.add(target);
  }
  if (
    !latexCurrent(value) ||
    typstPdf !== view ||
    gesture !== latexGesture ||
    !sameSelection() ||
    textOf(target)
      .replace(/^\uFEFF/, "")
      .replace(/\r\n?/g, "\n") !== input.source
  )
    return;
  snapshotDoc();
  doc = sessions.setActive(target.id);
  value.activeId = target.id;
  value.revisions = sessions.list().map(({ id, revision, path }) => ({ id, revision, path }));
  preservingLatexHandoff = true;
  const showing = displayDoc(true);
  preservingLatexHandoff = false;
  view.setActiveFile(match.file, input.source);
  await showing;
  if (!latexCurrent(value) || typstPdf !== view || gesture !== latexGesture) return;
  syncSourceFromPageSelection(context, reveal);
}

function syncSourceFromPageSelection(context: TypstPageContext | null, reveal: boolean): void {
  if (compiledUi.logsOpen) return;
  const gesture = ++latexGesture;
  if (
    doc.language === "latex" &&
    context?.sourceRange?.file &&
    latexCurrent(latexPreview) &&
    context.sourceRange.file !== latexRelative(latexPreview, doc.path)
  ) {
    void handoffLatexSelection(latexPreview, context, reveal, gesture);
    return;
  }
  if (
    (doc.language !== "typst" && doc.language !== "latex") ||
    (doc.language === "latex" &&
      (!latexCurrent(latexPreview) ||
        (context?.sourceRange?.file !== undefined &&
          context.sourceRange.file !== latexRelative(latexPreview, doc.path)))) ||
    settings.viewMode !== "split" ||
    typstPdfToken !== renderToken ||
    typstPdf?.source !== editor.getDoc()
  )
    return;
  clearPreviewWords();
  if (reveal) suppressEditorScrollUntil = performance.now() + SYNC_SUPPRESS_MS;
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
    if (doc.language === "latex" && !context?.paragraph && context?.sourceRange?.segments?.length)
      editor.setSyncRanges(context.sourceRange.segments);
    else editor.setSyncRange(range.from, range.to);
    if (reveal) editor.revealOffset(range.from);
    editor.pulseSyncRange();
    return;
  }
  syncedSource = range;
  if (doc.language === "latex" && !context?.paragraph && context?.sourceRange?.segments?.length)
    editor.setSyncRanges(context.sourceRange.segments);
  else editor.setSyncRange(range.from, range.to);
  if (reveal) editor.revealOffset(range.from);
}

/**
 * Source selection -> preview highlight.
 *
 * Only a real selection counts: expanding a collapsed caret would repaint a word
 * on every arrow key, which reads as markup the document does not have.
 */
function syncPreviewFromSource(): void {
  if (compiledUi.logsOpen) return;
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
  if (doc.language === "latex" && texpressoSyncSelection()) return;
  if ((doc.language === "typst" && settings.typstView === "pages") || doc.language === "latex") {
    if (wordSyncDismissed) {
      clearPreviewWords();
      return;
    }
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
  if (compiledUi.logsOpen) return;
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
  const editor0 = Math.max(0, editor.lineScrollTop(anchor.line) - SYNC_MARGIN);
  const preview0 = Math.max(0, anchor.top - SYNC_MARGIN);

  if (index + 1 < layout.anchors.length) {
    const next = layout.anchors[index + 1];
    return {
      editor0,
      preview0,
      editor1: Math.max(editor0, editor.lineScrollTop(next.line) - SYNC_MARGIN),
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
  void alignHtmlTextScroll("source").then((handled) => {
    if (!handled) syncEditorToHtmlCoarse();
  });
}

function syncEditorToHtmlCoarse(): void {
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
    segment.preview0 * (layout.scale > 0 ? layout.scale : 1),
    segment.preview1 * (layout.scale > 0 ? layout.scale : 1),
  );
  const max = Math.max(0, layout.height - layout.client);
  const scale = layout.scale > 0 ? layout.scale : 1;
  suppressPreviewScrollUntil = performance.now() + SYNC_SUPPRESS_MS;
  htmlPreview.scrollTo(Math.min(max, Math.max(0, target / scale)));
}

function syncHtmlToEditor(layout: HtmlLayout): void {
  void alignHtmlTextScroll("preview", layout).then((handled) => {
    if (!handled) syncHtmlToEditorCoarse(layout);
  });
}

function syncHtmlToEditorCoarse(layout: HtmlLayout): void {
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

const scrollOwnership = new ScrollOwnership();
let domScrollIndex = new ScrollIndex<ScrollTextAnchor>([]);
let domScrollSource = "";
let paneSyncFrame = 0;
let syncDragging = false;
let htmlScrollDragging = false;

async function alignHtmlTextScroll(
  direction: SyncPane,
  layout = htmlPreview.layout(),
  refined = false,
): Promise<boolean> {
  if (
    !settings.syncScroll ||
    settings.viewMode !== "split" ||
    syncDragging ||
    htmlScrollDragging ||
    doc.language !== "html" ||
    htmlPreview.source() !== editor.getDoc()
  )
    return true;
  if (!layout) return false;
  const reference = scrollReference();
  const offset = direction === "source" ? editor.offsetAtScreenY(reference) : layout.probe?.from;
  if (offset === undefined) return false;
  const near = htmlPreview.scrollAnchorsNear(offset);
  if (!near.length) return false;
  const region = near.reduce((a, b) =>
    Math.abs(a.from - offset) <= Math.abs(b.from - offset) ? a : b,
  ).region;
  const anchors = near.filter((a) => a.region === region);
  const token = renderToken,
    epoch = scrollOwnership.epoch;
  const origin = direction === "source" ? editor.view.scrollDOM.scrollTop : layout.top;
  const geometry = await htmlPreview.measureScroll(editor.getDoc(), anchors);
  if (
    token !== renderToken ||
    epoch !== scrollOwnership.epoch ||
    syncDragging ||
    htmlScrollDragging ||
    !settings.syncScroll ||
    settings.viewMode !== "split" ||
    doc.language !== "html"
  )
    return true;
  const now = direction === "source" ? editor.view.scrollDOM.scrollTop : htmlPreview.layout()?.top;
  if (now === undefined || Math.abs(now - origin) > 1) return true;
  if (!geometry) return false;
  const scale = geometry.scale > 0 ? geometry.scale : 1;
  const pairs: ScrollPair[] = [];
  let estimated = false;
  for (const point of geometry.points) {
    const anchor = anchors[point.at],
      source = editor.scrollPoint(anchor.from);
    if (direction === "source" && !source.exact) continue;
    estimated ||= !source.exact;
    // Guest CSS pixels are scaled by the iframe's own document zoom.
    const previewY = geometry.frameTop + (point.top + point.height / 2 - geometry.top) * scale;
    const sourceY = rowCentre(source);
    pairs.push({
      from: anchor.from,
      region,
      origin: direction === "source" ? sourceY : previewY,
      target: direction === "source" ? previewY : sourceY,
    });
  }
  const delta = scrollCorrection(pairs, reference);
  if (delta === null) return false;
  if (Math.abs(delta) < 0.5) return true;
  if (direction === "source") {
    const target = clampScroll(geometry.top + delta / scale, layout.height - layout.client);
    suppressPreviewScrollUntil = performance.now() + SYNC_SUPPRESS_MS;
    scrollOwnership.wrote("preview", target, performance.now());
    htmlPreview.scrollTo(target, geometry.input);
  } else {
    suppressEditorScrollUntil = performance.now() + SYNC_SUPPRESS_MS;
    editor.scrollToOffset(clampScroll(editor.view.scrollDOM.scrollTop + delta, editor.scrollMax()));
    scrollOwnership.wrote("source", editor.view.scrollDOM.scrollTop, performance.now());
    if (estimated && !refined)
      editor.view.requestMeasure({
        read: () => null,
        write: () =>
          requestAnimationFrame(() => {
            if (token === renderToken && epoch === scrollOwnership.epoch)
              void alignHtmlTextScroll(direction, htmlPreview.layout(), true);
          }),
      });
  }
  return true;
}

function previewScrollOffset(reference: number): number | null {
  if (!wordMap || wordMap.source !== editor.getDoc()) return null;
  const pane = previewPane.getBoundingClientRect();
  const dom = document as Document & {
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  for (const y of [reference + 2, reference + 14, reference + 28]) {
    for (const x of [pane.left + 32, pane.left + pane.width * 0.4, pane.left + pane.width * 0.7]) {
      const point = dom.caretRangeFromPoint?.(x, y);
      if (
        !point ||
        point.startContainer.nodeType !== Node.TEXT_NODE ||
        !preview.contains(point.startContainer)
      )
        continue;
      const node = point.startContainer as Text;
      const offset = Math.min(point.startOffset, node.length - 1);
      const range = scrollSourceRange(wordMap, node, offset, offset + 1);
      if (range) return range.from;
    }
  }
  return null;
}

function alignDomTextScroll(direction: SyncPane, refined = false): boolean {
  if (compiledUi.logsOpen) return true;
  if (syncDragging || !wordMap || wordMap.source !== editor.getDoc()) return false;
  const reference = scrollReference();
  const offset =
    direction === "source" ? editor.offsetAtScreenY(reference) : previewScrollOffset(reference);
  if (offset === null) return false;
  const near = domScrollIndex.near(offset);
  if (!near.length) return false;
  const region = near.reduce((a, b) =>
    Math.abs(a.from - offset) <= Math.abs(b.from - offset) ? a : b,
  ).region;
  const pairs: ScrollPair[] = [];
  let estimated = false;
  for (const anchor of near) {
    if (anchor.region !== region || !anchor.node.isConnected) continue;
    const source = editor.scrollPoint(anchor.from);
    if (direction === "source" && !source.exact) continue;
    const range = document.createRange();
    range.setStart(anchor.node, anchor.start);
    range.setEnd(anchor.node, anchor.end);
    const rect = range.getBoundingClientRect();
    if (!rect.width || !rect.height) continue;
    estimated ||= !source.exact;
    const sourceY = rowCentre(source),
      previewY = rowCentre(rect);
    pairs.push({
      from: anchor.from,
      region,
      origin: direction === "source" ? sourceY : previewY,
      target: direction === "source" ? previewY : sourceY,
    });
  }
  const delta = scrollCorrection(pairs, reference);
  if (delta === null) return false;
  if (Math.abs(delta) < 0.5) return true;
  if (direction === "source") {
    suppressPreviewScrollUntil = performance.now() + SYNC_SUPPRESS_MS;
    previewPane.scrollTop = clampScroll(
      previewPane.scrollTop + delta,
      previewPane.scrollHeight - previewPane.clientHeight,
    );
    scrollOwnership.wrote("preview", previewPane.scrollTop, performance.now());
  } else {
    suppressEditorScrollUntil = performance.now() + SYNC_SUPPRESS_MS;
    editor.scrollToOffset(clampScroll(editor.view.scrollDOM.scrollTop + delta, editor.scrollMax()));
    scrollOwnership.wrote("source", editor.view.scrollDOM.scrollTop, performance.now());
    if (estimated && !refined) {
      const token = renderToken,
        epoch = scrollOwnership.epoch,
        top = previewPane.scrollTop;
      editor.view.requestMeasure({
        read: () => null,
        write: () =>
          requestAnimationFrame(() => {
            if (
              token === renderToken &&
              epoch === scrollOwnership.epoch &&
              Math.abs(top - previewPane.scrollTop) < 1
            )
              alignDomTextScroll(direction, true);
          }),
      });
    }
  }
  return true;
}

function pagesScrollAvailable(): boolean {
  return (
    !compiledUi.logsOpen &&
    settings.syncScroll &&
    settings.viewMode === "split" &&
    ((doc.language === "typst" && settings.typstView === "pages") ||
      (doc.language === "latex" && latexCurrent(latexPreview))) &&
    typstPdf !== null &&
    typstPdfToken === renderToken &&
    typstPdf.source === editor.getDoc()
  );
}

/**
 * The sync line as a pair of heights: content at `source` in the editor
 * corresponds to content at `preview` in the preview. Level at SYNC_MARGIN until
 * a pointer gesture calibrates it; see
 * docs/adr/2026-11-13-pointer-gesture-alignment.md. Any code that needs "the
 * sync height" reads it through scrollReference(), never SYNC_MARGIN: a fixed
 * margin in the sync path is what makes the panes jump after a click.
 */
const syncReference = new SyncReference(SYNC_MARGIN);

function scrollCommonTop(): number {
  return Math.max(
    editor.view.scrollDOM.getBoundingClientRect().top,
    previewPane.getBoundingClientRect().top,
  );
}

/** One pane's sync height in screen pixels. */
function scrollReference(pane: SyncPane = "source"): number {
  return scrollCommonTop() + syncReference[pane];
}

const otherPane = (pane: SyncPane): SyncPane => (pane === "source" ? "preview" : "source");

/**
 * Block boundaries around a height, measured in both panes, for
 * blockCorrection(). This is the fallback where no verified word answers: code,
 * tables, formulas, diagrams, or a word map that has not arrived.
 *
 * The last block ends where the editor's scroll range ends, paired with the
 * bottom of the block in the preview, so a long final block keeps following
 * instead of pinning at its first line.
 */
function domBlockTops(direction: SyncPane, reference: number): BlockTop[] {
  const scroller = editor.view.scrollDOM;
  const sourceTop = scroller.getBoundingClientRect().top - scroller.scrollTop;
  const sourceY = (anchor: Anchor): number => sourceTop + editor.lineScrollTop(anchor.line);
  const previewY = (anchor: Anchor): number => anchor.el.getBoundingClientRect().top;
  const originY = direction === "source" ? sourceY : previewY;
  let lo = 0,
    hi = previewAnchors.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (originY(previewAnchors[mid]) <= reference) lo = mid + 1;
    else hi = mid;
  }
  // `lo - 1` is the block holding the reference; its neighbours bound it.
  const last = Math.min(previewAnchors.length, lo + 1);
  const tops: BlockTop[] = [];
  for (let i = Math.max(0, lo - 2); i < last; i++) {
    const source = sourceY(previewAnchors[i]),
      rendered = previewY(previewAnchors[i]);
    tops.push(
      direction === "source"
        ? { origin: source, target: rendered }
        : { origin: rendered, target: source },
    );
  }
  if (last === previewAnchors.length && tops.length) {
    const el = previewAnchors[last - 1].el;
    const common = scrollCommonTop() + SYNC_MARGIN;
    const source = common + editor.scrollMax() - scroller.scrollTop;
    const rendered = common + previewEndFor(el) - previewPane.scrollTop;
    const end =
      direction === "source"
        ? { origin: source, target: rendered }
        : { origin: rendered, target: source };
    const tail = tops[tops.length - 1];
    // A document shorter than the pane has no scroll range to pair.
    if (end.origin > tail.origin && end.target >= tail.target) tops.push(end);
  }
  return tops;
}

let latexLastSourceScroll: number | null = null;
function alignPagesScroll(direction: SyncPane, refined = false): void {
  if (!pagesScrollAvailable() || syncDragging) return;
  const sourceScroll = editor.view.scrollDOM.scrollTop;
  const sourceDirection =
    latexLastSourceScroll === null ? 0 : Math.sign(sourceScroll - latexLastSourceScroll);
  if (direction === "source" && doc.language === "latex") latexLastSourceScroll = sourceScroll;
  const pdf = typstPdf!;
  const reference = scrollReference();
  const anchors =
    direction === "source"
      ? pdf.scrollAnchorsNear(editor.offsetAtScreenY(reference))
      : pdf.scrollAnchorsAt(reference, !refined);
  let estimated = false;
  const pairs: ScrollPair[] = [];
  for (const anchor of anchors) {
    const row = pdf.scrollRowFor(anchor);
    const source = editor.scrollPoint(anchor.from);
    if (row === null || (direction === "source" && !source.exact)) continue;
    estimated ||= !source.exact;
    const sourceY = rowCentre(source),
      previewY = rowCentre(row);
    pairs.push({
      from: anchor.from,
      region: anchor.region,
      origin: direction === "source" ? sourceY : previewY,
      target: direction === "source" ? previewY : sourceY,
    });
  }
  const delta = scrollCorrection(pairs, reference);
  if (delta === null || Math.abs(delta) < 0.5) return;
  if (
    direction === "source" &&
    doc.language === "latex" &&
    sourceDirection &&
    Math.sign(delta) !== sourceDirection
  )
    return;
  if (direction === "source") {
    suppressPreviewScrollUntil = performance.now() + SYNC_SUPPRESS_MS;
    previewPane.scrollTop = clampScroll(
      previewPane.scrollTop + delta,
      previewPane.scrollHeight - previewPane.clientHeight,
    );
    scrollOwnership.wrote("preview", previewPane.scrollTop, performance.now());
  } else {
    suppressEditorScrollUntil = performance.now() + SYNC_SUPPRESS_MS;
    editor.scrollToOffset(clampScroll(editor.view.scrollDOM.scrollTop + delta, editor.scrollMax()));
    scrollOwnership.wrote("source", editor.view.scrollDOM.scrollTop, performance.now());
    if (estimated && !refined) {
      const token = renderToken,
        epoch = scrollOwnership.epoch,
        top = previewPane.scrollTop;
      editor.view.requestMeasure({
        read: () => null,
        write: () =>
          requestAnimationFrame(() => {
            if (
              token === renderToken &&
              epoch === scrollOwnership.epoch &&
              Math.abs(top - previewPane.scrollTop) < 1
            )
              alignPagesScroll(direction, true);
          }),
      });
    }
  }
}

function queuePaneScroll(direction: SyncPane): void {
  if (compiledUi.logsOpen) return;
  if (!settings.syncScroll || settings.viewMode !== "split" || syncDragging || htmlScrollDragging)
    return;
  const top =
    direction === "source"
      ? editor.view.scrollDOM.scrollTop
      : doc.language === "html"
        ? (htmlPreview.layout()?.top ?? 0)
        : texpressoShowing()
          ? texpressoScrollTop
          : previewPane.scrollTop;
  if (scrollOwnership.reflected(direction, top, performance.now())) return;
  scrollOwnership.input();
  cancelAnimationFrame(paneSyncFrame);
  const token = renderToken;
  const epoch = scrollOwnership.epoch;
  paneSyncFrame = requestAnimationFrame(() => {
    paneSyncFrame = 0;
    // A new gesture owns the panes immediately; a correction queued before it
    // must not scroll the source out from under the pointer or a fresh reveal.
    if (token !== renderToken || epoch !== scrollOwnership.epoch || compiledUi.logsOpen) return;
    if (syncDragging || htmlScrollDragging) return;
    // A selection reveal owns the source for its short hand-off window; a
    // preview-scroll correction queued before the gesture must not move it away.
    if (direction === "preview" && performance.now() < suppressEditorScrollUntil) return;
    // The frame reports its own scrolling (`viewport`); only the source
    // direction is queued here.
    if (doc.language === "latex" && texpressoShowing()) {
      if (direction === "source") texpressoAlignPreview();
    } else if (
      (doc.language === "typst" && settings.typstView === "pages") ||
      doc.language === "latex"
    )
      alignPagesScroll(direction);
    else if (doc.language === "html") {
      if (direction === "source") syncEditorToHtml();
      else {
        const layout = htmlPreview.layout();
        if (layout) syncHtmlToEditor(layout);
      }
    } else if (previewLinesMapped && domScrollSource === editor.getDoc()) {
      if (direction === "source") alignPreviewToScroll();
      else alignEditorToScroll();
    }
  });
}

function installPaneSync(): void {
  for (const [pane, direction] of [
    [editorPane, "source"],
    [previewPane, "preview"],
  ] as const) {
    const input = (event: Event): void => {
      scrollOwnership.input();
      typstPdf?.cancelScrollRestore();
      if (direction === "source") suppressEditorScrollUntil = 0;
      else {
        suppressPreviewScrollUntil = 0;
        suppressEditorScrollUntil = 0;
        if (event instanceof WheelEvent) {
          typstPdf?.scrollInput(event.clientX, event.clientY);
          // A wheel over a body column selects that column even when the pane
          // is already at the top of the page and no scroll event follows.
          queuePaneScroll("preview");
        }
      }
    };
    for (const type of ["wheel", "touchstart", "keydown", "pointerdown"])
      pane.addEventListener(type, input, { passive: true, capture: true });
  }
  document.addEventListener(
    "pointerdown",
    (event) => {
      if (
        event.button === 0 &&
        event.target instanceof Element &&
        event.target.closest(".cm-content,.textLayer,#preview p")
      )
        syncDragging = true;
    },
    true,
  );
  const release = (): void => {
    syncDragging = false;
  };
  document.addEventListener("pointerup", release, true);
  document.addEventListener("pointercancel", release, true);
  window.addEventListener("blur", release);
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
    wordSyncDismissed = false;
    dismissedWordSelection = null;
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
    if (doc.language === "latex") {
      if (texpressoBlinkSource()) return;
      if (
        settings.viewMode !== "split" ||
        editor.cursorInfo().selectionLength ||
        !latexCurrent(latexPreview)
      )
        return;
      const source = editor.getDoc();
      const offset = editor.cursorInfo().from;
      const range =
        typstPdf?.atomicRangeAtSource(source, offset) ?? paragraphRangeAt(source, offset);
      const ranges = typstPdf?.rangesForSource(source, range.from, range.to) ?? [];
      if (ranges.length) {
        const key = `click:${range.from}:${range.to}`;
        paintPreviewWords(ranges, key);
        window.setTimeout(() => {
          if (previewSyncKey === key) clearPreviewWords();
        }, BLINK_MS);
      }
      return;
    }
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
    if (doc.language === "typst" && settings.typstView === "pages") {
      if (performance.now() >= suppressEditorScrollUntil) queuePaneScroll("source");
      return;
    }
    if (doc.language === "latex") {
      if (performance.now() >= suppressEditorScrollUntil) queuePaneScroll("source");
      return;
    }
    if (doc.language === "html") {
      if (performance.now() >= suppressEditorScrollUntil) queuePaneScroll("source");
      return;
    }
    if (!settings.syncScroll || settings.viewMode !== "split" || !previewLinesMapped) return;
    if (performance.now() < suppressEditorScrollUntil) return;
    queuePaneScroll("source");
  });

  // Click in the preview -> the source reveals that line, and the preview stays
  // exactly where it is so text selection keeps working.
  preview.addEventListener("mousedown", (event) => {
    if (doc.language === "latex") latexGesture += 1;
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
    wordSyncDismissed = false;
    dismissedWordSelection = null;
    window.clearTimeout(selectionTimer);
    syncSourceFromPreview(true);
  });

  // A drag inside the preview paints the source once it settles.
  document.addEventListener("selectionchange", () => {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return;
    if (!preview.contains(selection.anchorNode)) return;
    if (currentSelectionWasDismissed()) return;
    wordSyncDismissed = false;
    dismissedWordSelection = null;
    window.clearTimeout(selectionTimer);
    selectionTimer = window.setTimeout(() => syncSourceFromPreview(false), WORD_SYNC_DEBOUNCE_MS);
  });

  // Escape clears both surfaces. It neither collapses the selection nor moves
  // anything else: the highlight is the only thing the reader is dismissing.
  document.addEventListener(
    "keydown",
    (event) => {
      if (event.key !== "Escape") return;
      latexGesture += 1;
      const target = event.target;
      const selection = window.getSelection();
      const pendingPreviewSelection =
        !!selection && !selection.isCollapsed && preview.contains(selection.anchorNode);
      const dismissing =
        syncedSource !== null ||
        previewPulseRanges.length > 0 ||
        htmlWordsActive ||
        pendingPreviewSelection;
      if (
        (target instanceof Node && (editorPane.contains(target) || previewPane.contains(target))) ||
        pendingPreviewSelection
      ) {
        wordSyncDismissed = true;
        dismissedWordSelection = selection
          ? {
              anchorNode: selection.anchorNode,
              anchorOffset: selection.anchorOffset,
              focusNode: selection.focusNode,
              focusOffset: selection.focusOffset,
            }
          : null;
      }
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
      clearCorrespondence();
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
    if (doc.language === "latex") {
      if (typstPdf?.isLayoutScroll()) return;
      queuePaneScroll("preview");
      return;
    }
    if (doc.language === "typst" && settings.typstView === "pages") {
      if (typstPdf?.isLayoutScroll()) return;
      queuePaneScroll("preview");
      return;
    }
    queuePaneScroll("preview");
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
  // A hidden pane cannot show the target, and Source mode does not render it.
  if (settings.viewMode === "source") return;
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
    void openPath(path).then((opened) => {
      // The fragment belongs to the opened document; after a failed open or a
      // tab switch it must not scroll whatever is on screen.
      if (!fragment || !opened || opened !== doc) return;
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
    previewShell.style.flex = "1 1 auto";
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

/**
 * A menu command that has no implementation for the document on screen.
 *
 * The list is empty now, and it is kept as the one place a future unimplemented
 * command is named rather than as a language-wide gate. The gate that used to
 * live here refused every `export.*` for LaTeX long after the backend had grown
 * a LaTeX reader, and the reader saw a sentence describing a state that no
 * longer existed.
 */
function commandRefusedReason(_id: string): string | null {
  if (
    api.isWebSource(doc.language) &&
    (_id.startsWith("format.") ||
      _id.startsWith("para.") ||
      _id.startsWith("insert.") ||
      _id.startsWith("export.") ||
      _id === "file.print")
  ) {
    return "This command is not available for source files.";
  }
  return null;
}

function runMenuAction(id: string): void {
  if (
    lifecycle.committing ||
    document.querySelector(".unsaved-dialog[open]") ||
    document.querySelector(".stats-dialog[open]") ||
    document.querySelector(".encoding-dialog[open]") ||
    document.querySelector(".export-dialog[open]")
  )
    return;
  const refused = commandRefusedReason(id);
  if (refused) {
    toast(refused, 4200);
    return;
  }
  const now = performance.now();
  const previous = lastActionAt.get(id) ?? 0;
  if (now - previous < 250) return;
  lastActionAt.set(id, now);

  // The chooser and the direct Markdown row are not stored formats: one comes
  // from the installed pandoc, the other is the editor's own dialect, so neither
  // can be a key in `handlers`.
  if (id === "export.pandoc.more") {
    void openWriterChooser().catch((error) => toast(String(error)));
    return;
  }
  if (id === "export.markdown") {
    void exportMarkdown().catch((error) => toast(String(error)));
    return;
  }

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
  if (!handler) {
    // A menu id with no handler is the dead UI this project forbids, and the
    // `Record<string, …>` type cannot catch it: every string is a valid key. The
    // console line is what makes a typo in an id visible instead of silent, and
    // the test below reads the same table.
    console.warn(`[menu] no handler for ${id}`);
    return;
  }
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
  if (selection.reveal) suppressEditorScrollUntil = performance.now() + SYNC_SUPPRESS_MS;
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
  queuePaneScroll("preview");
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
    retheme();
  });
}

// ---------------------------------------------------------------------------
// Read aloud
// ---------------------------------------------------------------------------

let readAloud: ReadAloudHandle | null = null;
let readAloudPending = false;

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
  if (api.isWebSource(doc.language)) return "Source files have no preview to read aloud.";
  if (!readAloud) return "The editor is still loading.";
  // The HTML tab renders into an opaque-origin iframe: its text is not the
  // parent document's to read, so there is nothing to speak.
  if (doc.language === "html") return "The HTML preview cannot be read aloud.";
  // A LaTeX preview is a PDF canvas: the words exist in the text layer, but not
  // as the paragraph elements this reader walks, so there is nothing to speak
  // until a source-derived prose extractor exists.
  if (doc.language === "latex") return "The LaTeX preview cannot be read aloud.";
  const reason = readAloud.availableReason();
  if (reason) return reason;
  // Source mode defers the render; starting a reading forces it, so an empty
  // hidden pane is not a reason to disable the command. An empty buffer still is.
  if (previewStale && settings.viewMode === "source")
    return editor.metrics().chars === 0 ? "There is nothing to read." : null;
  if ((preview.textContent ?? "").trim() === "") return "There is nothing to read.";
  return null;
}

/** Source positions exist only in the renderers that emit `data-line`. */
function readAloudFromHereBlockedReason(): string | null {
  // The deferred render is about to happen in `startReadAloud`.
  if (previewStale && settings.viewMode === "source") return null;
  return previewAnchors.length === 0 ? "This preview has no source positions." : null;
}

/**
 * Make sure the pane describes the buffer before something reads from it.
 *
 * Source mode skips the render on purpose, but Read Aloud speaks the rendered
 * prose. This is the one action that pays for a render while the pane is hidden.
 */
async function ensurePreviewRendered(): Promise<void> {
  if (!previewStale) return;
  window.clearTimeout(renderTimer);
  await doRender(true);
}

function readingMenuState(): ReadingMenuState {
  const blocked = readAloudBlockedReason();
  return {
    blocked,
    fromHereBlocked: blocked ? null : readAloudFromHereBlockedReason(),
    active: readAloudPending || (readAloud?.isActive() ?? false),
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

/** The document's language, resolved from the live buffer and the current settings. */
async function resolveDocumentLanguage(spokenText: string): Promise<string> {
  return resolveLanguage({
    source: textOf(doc).slice(0, 8_000),
    markup: api.isWebSource(doc.language)
      ? "markdown"
      : (doc.language as Exclude<api.DocumentLanguage, "javascript" | "css" | "json">),
    spokenText,
    pinned: settings.spellcheckLanguage,
    candidates: installedLanguages(),
    check: (language, words) => api.spellcheckCheck(language, words),
  });
}

let languageProbe: { key: string; tag: string } | null = null;

/** Cache the probe until the buffer, the Dictionary or the dictionary list changes. */
async function documentLanguage(spokenText: string): Promise<string> {
  const key = [
    doc.id,
    String(doc.revision),
    settings.spellcheckLanguage,
    installedLanguages().join(","),
  ].join(":");
  if (languageProbe?.key === key) return languageProbe.tag;
  const tag = await resolveDocumentLanguage(spokenText);
  const after = [
    doc.id,
    String(doc.revision),
    settings.spellcheckLanguage,
    installedLanguages().join(","),
  ].join(":");
  // A tab switch or an edit landed while the dictionaries were voting: the
  // answer belongs to the old buffer and must not seed the next one.
  if (after === key) languageProbe = { key, tag };
  return tag;
}

/** Bumped by every start and stop, so a slow language probe cannot speak late. */
let readAloudRequest = 0;

async function startReadAloud(fromStart: boolean): Promise<void> {
  const request = ++readAloudRequest;
  const documentId = doc.id;
  const revision = doc.revision;
  // Stop immediately: a pending preview or language probe must not outlive Stop
  // or start speaking for a different document.
  readAloud?.stop();
  readAloudPending = true;
  try {
    // Source mode may have skipped the render; speaking needs the rendered prose,
    // and this is the one command that may rebuild it while the pane is hidden.
    await ensurePreviewRendered();
    if (
      request !== readAloudRequest ||
      doc.id !== documentId ||
      doc.revision !== revision ||
      previewStale
    )
      return;
    const reason = readAloudBlockedReason();
    if (reason) {
      toast(reason, 4200);
      return;
    }
    if (!fromStart) {
      // The menu was built while the render was deferred; the anchors only exist
      // once it has run, so re-check before reading from the caret.
      const fromHere = readAloudFromHereBlockedReason();
      if (fromHere) {
        toast(fromHere, 4200);
        return;
      }
    }
    // The whole preview is the sample: a voice belongs to the document, not to
    // the paragraph the reader happened to right-click. The cap keeps a very
    // large document from being scanned twice.
    const sample = previewReadAloudText(true).slice(0, 20_000);
    let language = "";
    try {
      language = await documentLanguage(sample);
    } catch {
      // A detection failure is not a reading failure: the platform default is
      // still a correct, if less specific, answer.
    }
    if (
      request !== readAloudRequest ||
      doc.id !== documentId ||
      doc.revision !== revision ||
      !readAloud
    )
      return;
    if (!readAloud.start(previewReadAloudText(fromStart), language)) {
      toast("There is nothing to read.", 4200);
    }
  } finally {
    if (request === readAloudRequest) readAloudPending = false;
  }
}

function stopReadAloud(): void {
  readAloudRequest += 1;
  readAloudPending = false;
  readAloud?.stop();
  if (settings.viewMode === "source" && previewStale) {
    renderToken += 1;
    cancelPreviewWorkers();
    typstPdf?.cancelMap();
    cancelTypstRender();
  }
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

/**
 * The document a paste or drop was made in, captured before its first await.
 *
 * Image downloads and imports take seconds, and the reader can switch tabs,
 * save elsewhere or close the tab meanwhile. The paste belongs to this owner,
 * never to whichever tab is on screen when the work finishes. Typing does not
 * invalidate it (insertion follows the caret), and neither does a save in
 * place; a replaced buffer, another folder or another language does.
 */
interface PasteOwner {
  session: Session;
  incarnation: number;
  path: string | null;
  directory: string | null;
  language: api.DocumentLanguage;
}

function capturePasteOwner(): PasteOwner {
  return {
    session: doc,
    incarnation: doc.incarnation,
    path: doc.path,
    directory: doc.directory,
    language: doc.language,
  };
}

/** Where a delayed paste may still land: on screen, in its hidden tab, or nowhere. */
function pasteOwnerState(owner: PasteOwner): "live" | "hidden" | null {
  const session = owner.session;
  if (sessions.byId(session.id) !== session || session.incarnation !== owner.incarnation)
    return null;
  // A relative reference and the markup syntax were resolved for this folder
  // and language; after Save As elsewhere or to another format they are wrong.
  if (session.directory !== owner.directory || session.language !== owner.language) return null;
  if (session === doc) return "live";
  // A hidden tab that has never been shown has no state to edit yet.
  return session.editorState && session.draft === null ? "hidden" : null;
}

/**
 * Commit a delayed paste to its owner.
 *
 * On screen it goes to the live caret, as an immediate paste would. In a hidden
 * tab it is applied to that tab's stored state at its saved selection, as one
 * undo step — the same in-place edit `formatSession` makes — so it lands where
 * the reader pasted. Otherwise nothing is inserted and the reader is told where
 * any saved image went: it is on disk, so nothing is lost.
 */
function insertForOwner(
  owner: PasteOwner,
  insertion: PasteInsertion,
  assets: readonly string[] = [],
): boolean {
  const where = pasteOwnerState(owner);
  if (where === "live") {
    if (insertion.kind === "block") editor.insertBlock(insertion.text);
    else if (insertion.kind === "native") editor.insertNativeText(insertion.text);
    else editor.insertPasted(insertion.text, insertion.block);
    return true;
  }
  const session = owner.session;
  if (where === "hidden" && session.editorState) {
    const spec = pasteInsertionSpec(session.editorState, insertion);
    if (!spec) return true;
    session.editorState = session.editorState.update(spec).state;
    session.revision += 1;
    const text = session.editorState.doc.toString();
    session.dirty = text !== session.savedContent;
    if (session.dirty) recovery.schedule(session, text);
    else void recovery.forget(session);
    renderDocTabs();
    toast(`Pasted into “${session.name}”.`, 3200);
    return true;
  }
  const saved =
    assets.length === 0
      ? ""
      : ` ${assets.length === 1 ? "The image was" : "The images were"} saved to ${assets.join(", ")}.`;
  toast(
    `The paste was not inserted: its document was closed, reloaded or saved elsewhere meanwhile.${saved}`,
    7200,
  );
  return false;
}

function imageContext(hasSelection = false): ImageContext {
  const language = doc.language;
  const owner = capturePasteOwner();
  return {
    // A relative image path is the only kind the HTML guest and the Typst
    // compiler can reach from the document's own folder.
    settings: needsRelativePath(language) ? { ...settings, imageUseRelativePath: true } : settings,
    language,
    documentPath: doc.path,
    hasSelection,
    insert: (text, assets = []) => insertForOwner(owner, { kind: "block", text }, assets),
    imageSyntax: (alt, src) => imageSyntaxFor(language, alt, src),
    // The "saved to" notice follows the insert and replaces its toast, so a
    // paste that landed in a tab the reader has left must name that tab here.
    notify: (text, isError = false) =>
      toast(
        !isError && pasteOwnerState(owner) === "hidden"
          ? `Pasted into “${owner.session.name}”. ${text}`
          : text,
        isError ? 5200 : 3200,
      ),
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
/**
 * The extra folder Typst's `--root` must reach: the custom image folder when
 * one is set, otherwise the open workspace when the document is inside it, so
 * a chapter can `#import "../template.typ"` (Track W2). Rust widens the root to
 * the common ancestor of the document's folder and this one.
 */
function typstExtraRoot(path: string | null = doc.path): string | null {
  const custom = customImageFolder();
  if (custom) return custom;
  const folder = settings.workspaceFolder;
  return folder && path && pathKey(path).startsWith(pathKey(folder) + "/") ? folder : null;
}

function customImageFolder(directory: string | null = doc.directory): string | null {
  if (settings.imageRule !== "custom") return null;
  const dir = settings.imageCustomDir?.trim();
  if (!dir) return null;
  if (/^[A-Za-z]:[\\/]/.test(dir) || dir.startsWith("\\\\") || dir.startsWith("/")) return dir;
  return directory ? joinDir(directory, dir) : null;
}

/**
 * Resolve one image of a rich paste against the document the paste was made
 * in. `owner.path` is read, never the live `doc.path`: a tab switch during an
 * earlier download must not send a later image to another document's folder.
 * Every file written is added to `assets`, so a paste that cannot be inserted
 * can still say where its images went.
 */
async function resolveRichImage(
  image: ImageRequest,
  language: api.DocumentLanguage,
  report: (note: string) => void,
  owner: PasteOwner,
  assets: string[],
): Promise<ResolvedImage | null> {
  const path = owner.path;
  const remote = /^https?:/i.test(image.src);
  if (remote && settings.richPasteImages === "url") return null;
  const options = richImageOptions(language);
  const destination = hasImageDestination(language, path, options.rule, settings.imageCustomDir);
  const keeping = options.rule === "keepOriginal";

  /** Keep the address as it is, saying why when it cannot render. */
  const keep = (why: string): null => {
    report(typstImageProblem(language, image.src, path) ?? why);
    return null;
  };
  /** The reference to a file written for this paste, or null with a reason. */
  const use = (saved: api.SavedImage, copied = true): ResolvedImage | null => {
    if (copied) assets.push(saved.absolutePath);
    const problem = typstImageProblem(language, saved.markdownPath, path);
    if (problem) {
      report(copied ? `${problem} Saved to ${saved.markdownPath}.` : problem);
      return null;
    }
    return { src: saved.markdownPath, alt: image.alt || altFromPath(saved.markdownPath) };
  };

  if (/^data:/i.test(image.src)) {
    if (keeping) return keep(KEEP_ORIGINAL_RICH);
    if (!destination) return keep(NO_FOLDER_KEPT);
    return use(await api.saveClipboardImage(image.src, null, path, options));
  }

  if (remote) {
    if (keeping) return keep(KEEP_ORIGINAL_RICH);
    if (!destination) return keep(NO_FOLDER_KEPT);
    return use(await api.downloadImage(image.src, path, options, 8000));
  }

  if (!settings.imageApplyLocal) return null;
  if (!/^(?:[A-Za-z]:[\\/]|\/|file:)/i.test(image.src)) return null;
  const local = image.src.replace(/^file:\/\//i, "");
  const exists = await api.pathExists(local, path).catch(() => false);
  if (!exists) return null;

  if (keeping) {
    // No copy, but the backend may turn an absolute path inside the document's
    // folder into the relative form Typst can read.
    return use(await api.importImage(local, path, options), false);
  }
  if (!destination) return keep(NO_FOLDER_KEPT);
  return use(await api.importImage(local, path, options));
}

function languageLabel(language: api.DocumentLanguage): string {
  return language === "latex"
    ? "LaTeX"
    : language === "typst"
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
  owner: PasteOwner,
): Promise<void> {
  const assets: string[] = [];
  const result = await planPaste(payload, destination.language, {
    resolveImage: (image, report) =>
      resolveRichImage(image, destination.language, report, owner, assets),
  });
  if (!result) return;
  const insertion: PasteInsertion =
    destination.language === "markdown" &&
    (result.source === "markdown" || result.source === "plain")
      ? { kind: "native", text: result.text }
      : { kind: "pasted", text: result.text, block: result.block };
  if (!insertForOwner(owner, insertion, assets)) return;

  if (destination.detected && result.converted) {
    const key = `${owner.session.id}:${destination.language}`;
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
    if (api.isWebSource(doc.language)) return;
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
    void applyRichPaste(payload, destination, capturePasteOwner()).catch((error) => {
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
  el<HTMLButtonElement>("tab-explorer").addEventListener("click", () => setSidebarTab("explorer"));
  // Files change outside MDraft; returning to the window re-reads the
  // expanded folders (there is no file watcher in this slice).
  window.addEventListener("focus", () => {
    if (settings.sidebarTab !== "explorer" || !settings.workspaceFolder) return;
    invalidateExplorer();
    mainCandidateCache.clear();
    renderSidebar();
  });
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
  // The counts are the visible summary of the document; either one opens the
  // same dialog as Tools › Document Statistics, through the same guard.
  statusWords.addEventListener("click", () => runMenuAction("tools.statistics"));
  statusTokens.addEventListener("click", () => runMenuAction("tools.statistics"));
  statusEncoding.addEventListener("click", () => runMenuAction("tools.encoding"));
  statusEngine.addEventListener("click", () => void openEngineMenu());

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
    case "latex":
    case "javascript":
    case "css":
    case "json":
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
      existing.encoding = entry.encoding ?? existing.encoding;
      existing.encodingBlocked = false;
      existing.lossy = existing.lossy || entry.lossy;
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
      if (existing === doc) {
        // The tab on screen takes the draft now, before the next await. A
        // pending `draft` on the displayed session is invisible to `textOf`,
        // and switching tabs would snapshot the disk text over it.
        existing.draft = null;
        editor.setDoc(entry.content, false);
      } else {
        existing.draft = entry.content;
      }
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
    session.encoding = entry.encoding ?? base?.encoding ?? "UTF-8";
    session.encodingBlocked = false;
    session.lossy = (base?.lossy ?? false) || entry.lossy;
    session.readOnly = base?.readOnly ?? entry.readOnly;
    // The journal's base, not the file's current stat: the disk poll compares
    // against it and raises the conflict before an overwrite.
    session.modifiedMs = entry.baseModifiedMs;
    session.size = entry.baseSize;
    session.sha256 = entry.baseSha256 ?? null;
    session.conflict = null;
    // Recovered tabs belong at the end so a remembered set keeps its order, and
    // they do not become active here: `doc` and the store must agree across
    // the reads still to come.
    sessions.append(session);
    recovered.push(session);
  }

  if (recovered.length === 0) return;
  const first = recovered[0];
  // A recovered `doc` already shows its draft; only another tab is activated.
  if (first.id === doc.id) renderDocTabs();
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
 * first survivor that is actually read fills the initial blank tab (the startup
 * slot); the rest become tabs. Recents are deliberately not written: restoring
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
    // "Reopen the last tabs" reproduces the previous session, not the welcome
    // document. A session with no saved documents — first run with the
    // preference, or Close All Tabs, which leaves one blank tab on screen —
    // therefore comes back as that blank tab. Welcome keeps its own On Launch
    // mode and its Help entry; falling back to it here made the mode look
    // ignored exactly when the reader had closed every document deliberately.
    if (plan.missing > 0) {
      const subject = plan.missing === 1 ? "1 document" : `${plan.missing} documents`;
      toast(`${subject} from the last session could not be found.`, 4000);
    }
    await loadUntitled("", defaultDocumentLanguage());
    return;
  }

  // The first document that is read fills the blank session the window booted
  // with and consumes the slot; every later one becomes a tab of its own. A path
  // that fails to read leaves the slot for the next one rather than stranding
  // an empty tab beside the restored set.
  for (const path of plan.tabs) {
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
    completion: settings.completion !== false,
    emmet: settings.emmet !== false,
    cursorBlink: settings.cursorBlink,
    linkAt: (pos) => linkAt(editor.getDoc(), pos, doc.language),
    linkClick: openLinkTarget,
  });
  // The TeXpresso edit stream: each transaction's own changes, before the
  // render debounce and without a snapshot.
  editor.onChanges((changes, base, text) => {
    if (!preservingLatexHandoff) texpressoEdit(changes, base, text);
  });
  editor.onDocChanged((text) => {
    if (preservingLatexHandoff) return;
    delete preview.dataset.latexCurrent;
    doc.revision += 1;
    if (doc.language === "latex") {
      latexInFlight = false;
      setLatexStatus(
        settings.latexAutoCompile === false
          ? "Out of date · Select Compile to update the preview."
          : "Out of date · Waiting to compile…",
      );
      previewPane.querySelector(":scope > .latex-warnings")?.remove();
      // Unchanged compiled lines remain useful after an edit elsewhere. The
      // click revalidates the target line before navigating or painting it.
      selectedLatexProblem = null;
      editor.clearDiagnostics();
    }
    // Invalidate before the debounce: the visible DOM still describes old text.
    renderToken += 1;
    wordMapGeneration += 1;
    // A LaTeX PDF being staged belongs to a compile that is no longer
    // cancelled by typing: it is committed as out of date when it is newer than
    // what is on screen, so its view must survive the keystroke.
    if (doc.language !== "latex") discardStagedPdf();
    cancelPreviewWorkers();
    typstPdf?.cancelMap();
    if (doc.language !== "typst") cancelTypstRender();
    // A LaTeX or Typst compile in flight is NOT cancelled on typing: killing the
    // warm compiler on every keystroke starves typing bursts; LatestWinsGate lets
    // the active compile finish and runs the newest revision next.
    lastEditAt = performance.now();
    resetWordMapDebugTiming();
    if (doc.language === "typst") {
      typstEditSeq = typstScheduler.recordEdit(lastEditAt);
    }
    if (doc.language === "latex") {
      window.clearTimeout(reanchorTimer);
      window.clearTimeout(recycleTimer);
      latexRhythm.record(lastEditAt);
      latexUnrenderedSince ??= lastEditAt;
    }
    wordMap = null;
    previewStale = true;
    previewSyncReady = false;
    if (doc.language === "typst")
      setTypstStatus(
        settings.typstAutoCompile === false
          ? "Out of date · Select Compile to update the preview."
          : "Out of date · Waiting to compile…",
      );
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
  // Ubuntu's WebKitGTK has no `speechSynthesis` at all. When the webview
  // cannot speak, use speech-dispatcher through Rust; Windows and macOS keep
  // the platform catalogue the webview exposes.
  const systemSpeech = needsSystemSpeech(navigator.userAgent) ? createSystemSpeech() : null;
  readAloud = createReadAloud({
    rate: () => settings.readAloudRate ?? 1,
    voiceName: () => settings.readAloudVoice ?? "",
    // The shell resolves the document's language before every start, so this
    // is only the fallback for a caller that passes no tag: the pinned
    // Dictionary, or nothing when it is Automatic.
    languageTag: () => (settings.spellcheckLanguage === "auto" ? "" : settings.spellcheckLanguage),
    onChange: renderReadingChip,
    onError: (message) => toast(message, 5200),
    backend: systemSpeech?.backend,
    voiceSource: systemSpeech?.voiceSource,
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
    pasteTarget: () => {
      const owner = capturePasteOwner();
      return () => pasteOwnerState(owner) === "live";
    },
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
    onScrollInput: (dragging) => {
      htmlScrollDragging = dragging;
      scrollOwnership.input();
      suppressPreviewScrollUntil = 0;
    },
    onReady: handleHtmlReady,
    onError: (message) => toast(message, 6200),
  });

  // After the editor exists: a tab gesture that arrives during the first paint
  // must not reach a shell whose editor is still undefined.
  installTabs();

  preferences = createPreferences({
    settings: () => settings,
    update: applySettingsPatch,
    documentSpellLanguage: () => documentSpellingChoice(),
    setDocumentSpellLanguage: (value) => setDocumentSpellingChoice(doc, value),
    clearRecent: clearRecentFiles,
    readAloudVoices: () => readAloud?.voices() ?? [],
    refreshReadAloudVoices: async () => {
      await readAloud?.refreshVoices();
    },
    resetAssistantPosition: () => {
      assistant?.resetPosition();
      toast("Assistant layout reset.");
    },
    exportHtml: () => void exportHtml(),
    exportPdf: () => void exportPdf(),
    setupTypst: () => typstSetup(),
    typstServiceStatus: () => typstServiceCache,
    setupTypstService: async () => {
      const current = await api.typstServiceStatus();
      if (current.installed) {
        typstServiceCache = current;
      } else if (current.canInstall) {
        typstServiceCache = await api.installTypstService();
        if (doc.language === "typst") {
          typstStore.clear();
          scheduleRender(true);
        }
      } else {
        typstServiceCache = current;
      }
      preferences?.refresh();
    },
    clearTypstCache: async () => {
      await api.typstClearCache();
      typstStore.clear();
      await refreshTypstServiceStatus();
      if (doc.language === "typst") scheduleRender(true);
    },
    latexCache: () => latexCacheInfo,
    latexCacheError: () => latexCacheError,
    refreshLatexCache: refreshLatexCacheInfo,
    installLatex: async () => {
      const notice = toast("Downloading bundled TeX…", 0);
      try {
        await api.installTexpresso();
        settings.latexEnabled = true;
        persist();
        notice.dismiss();
        toast("Bundled TeX is enabled.");
      } catch (error) {
        notice.dismiss();
        await message(String(error), { title: "Could not enable bundled TeX", kind: "error" });
      }
      await refreshLatexCacheInfo();
      preferences.refresh();
    },
    disableLatex: async () => {
      try {
        await api.latexDisable();
        settings.latexEnabled = false;
        persist();
        toast("Bundled TeX is off. The downloaded files stay on disk.");
      } catch (error) {
        await message(String(error), { title: "Could not turn bundled TeX off", kind: "error" });
      }
      await refreshLatexCacheInfo();
      preferences.refresh();
    },
    clearLatexCache: async () => {
      const confirmed = await ask(
        "Delete the downloaded TeX packages and fonts?\n\n" +
          "The engine itself is kept, so the next compile re-downloads only what it needs. " +
          "Your documents are not touched.",
        { title: "Clear the LaTeX package cache?", kind: "warning" },
      );
      if (!confirmed) return;
      try {
        const freed = await api.latexClearCache();
        // The reader asked for a clean slate; kept PDFs go with the packages.
        latexStore.clear();
        toast(`Cleared ${(freed / (1024 * 1024)).toFixed(1)} MiB of cached TeX packages.`);
      } catch (error) {
        await message(String(error), { title: "Could not clear the cache", kind: "error" });
      }
      await refreshLatexCacheInfo();
      preferences.refresh();
    },
    nativeStatus: () => latexEngine,
    nativeCapabilities: () => latexNativeCaps,
    nativeCandidates: () => latexNativeCandidates,
    refreshNativeStatus: async () => {
      try {
        latexEngine = await api.latexEngineStatus();
      } catch {
        latexEngine = null;
      }
    },
    findNative: async () => {
      try {
        const found = await api.latexNativeDiscover();
        latexNativeCandidates = found;
        latexWslDistributions = await api.latexNativeWslDistributions().catch(() => []);
        if (found.length === 0 && latexWslDistributions.length > 0) {
          toast(
            "No TeX installation was found on Windows. Look inside a WSL distribution below, or use Browse… to choose an engine folder.",
            7200,
          );
        } else if (found.length === 0) {
          toast(
            "No TeX installation was found in PATH or the standard locations. Use Browse… to choose its engine folder.",
            7200,
          );
        } else if (found.length === 1) {
          await validateNativeDirectory(found[0].directory);
        }
      } catch (error) {
        await message(String(error), { title: "Could not look for TeX", kind: "error" });
      }
      preferences.refresh();
    },
    browseNative: async () => {
      const picked = await openDialog({
        directory: true,
        multiple: false,
        title: "Choose the folder that holds lualatex, pdflatex or xelatex",
      });
      if (typeof picked === "string" && picked) await validateNativeDirectory(picked);
    },
    validateNative: async (directory) => validateNativeDirectory(directory),
    nativeWslDistributions: () => latexWslDistributions,
    nativeWslCandidates: () => latexWslCandidates,
    lookInsideWsl: (distro) => {
      const running = wslLooks.get(distro);
      if (running) return running;
      const work = (async () => {
        const notice = toast(`Looking for TeX in ${distro} (starting it if needed)…`, 0);
        try {
          const found = await api.latexNativeWslLook(distro);
          latexWslCandidates = [
            ...(latexWslCandidates ?? []).filter((candidate) => candidate.distro !== distro),
            ...found,
          ];
          if (found.length === 0) {
            toast(`No lualatex, pdflatex or xelatex was found in ${distro}.`, 7200);
          } else if (found.length === 1) {
            notice.dismiss();
            await validateWslInstallation(found[0].distro, found[0].bin);
          } else {
            toast(
              `Found ${found.length} TeX installations in ${distro}. Choose one under “Found in WSL”.`,
              8200,
            );
          }
        } catch (error) {
          await message(String(error), { title: `Could not look inside ${distro}`, kind: "error" });
        } finally {
          notice.dismiss();
          preferences.refresh();
        }
      })();
      wslLooks.set(distro, work);
      const clear = () => wslLooks.delete(distro);
      void work.then(clear, clear);
      return work;
    },
    validateWsl: async (distro, bin) => validateWslInstallation(distro, bin),
    texmfConfig: () => texmfConfig,
    texmfStale: () => Date.now() - texmfLoadedAt > 2000,
    texmfReport: (id) => texmfReports.get(id),
    texmfBusy: () => texmfBusyId,
    texmfError: () => texmfError,
    refreshTexmf: async (ids) => {
      await refreshTexmf(ids);
      preferences.refresh();
    },
    texmfAction: async (action) => {
      await texmfConfigure(action);
    },
    texmfChooseFolder: async () => {
      if (texmfBusyId !== null) return;
      texmfBusyId = "choose";
      preferences.refresh();
      try {
        const picked = await openDialog({
          directory: true,
          multiple: false,
          title: "Choose local packages folder",
        });
        if (typeof picked !== "string" || !picked) return;
        const [report] = await api.latexTexmfInspect({ candidate: picked });
        if (!report || !["ok", "empty"].includes(report.status)) {
          await message(report?.message ?? "This folder cannot be used.", {
            title: "Could not use the folder",
            kind: "error",
          });
          return;
        }
        texmfBusyId = null;
        await texmfConfigure({ type: "setPrimary", path: picked, layout: report.layout });
      } catch (error) {
        await message(String(error), { title: "Could not choose the folder", kind: "error" });
      } finally {
        texmfBusyId = null;
        preferences.refresh();
      }
    },
    texmfOpen: async (id) => {
      try {
        await api.latexTexmfOpen(id);
      } catch (error) {
        await message(String(error), { title: "Could not open the folder", kind: "error" });
      }
    },
    setNativeEnabled: async (value) => {
      try {
        latexEngine = await api.latexNativeSetEnabled(value);
        settings.latexNativeEnabled = latexEngine.nativeEnabled;
        persist();
        invalidateLatexBuild();
        toast(
          value
            ? `Using ${latexEngine.nativeDistribution ?? "the installed TeX distribution"}.`
            : "The installed TeX distribution is off. The bundled engine keeps its own setting.",
        );
        scheduleRender(true);
      } catch (error) {
        await message(String(error), {
          title: value ? "Could not use the installed TeX distribution" : "Could not turn it off",
          kind: "error",
        });
      }
      preferences.refresh();
    },
    setNativeEngine: async (value) => {
      try {
        latexEngine = await api.latexNativeSetEngine(value);
        settings.latexNativeEngine = value;
        persist();
        invalidateLatexBuild();
        scheduleRender(true);
      } catch (error) {
        await message(String(error), { title: "Could not change the engine", kind: "error" });
      }
      preferences.refresh();
    },
    // The prompt file is not a document the reader opened, so it stays out of
    // Recents; one press focuses the tab if it is already there.
    openAiPrompts: async () => {
      const status = await api.aiPromptsStatus();
      const path = status.exists ? status.path : await api.aiExportPrompts();
      await openPath(path, { rememberRecent: false });
    },
    resetAiPrompts: async () => {
      const status = await api.aiPromptsStatus();
      const open = sessions.findByPath(status.path);
      // Rewriting a dirty buffer would discard an edit the reader has not saved.
      // That is the one way this button could lose work, so it refuses instead.
      if (open?.dirty) {
        throw new Error(
          "Save or discard the changes in ai-prompts.md before resetting the prompts.",
        );
      }
      await api.aiExportPrompts();
      // Rewriting the file behind an open tab would leave the editor showing the
      // text that was just replaced, so reload it when it is clean.
      if (open) await lifecycle.reload(open);
    },
    aiPromptsDirty: (path) => Boolean(sessions.findByPath(path)?.dirty),
    openAppFolder: async (folder) => {
      try {
        await api.openAppFolder(folder);
      } catch (error) {
        toast(String(error), 5200);
      }
    },
    pandocStatus: () => pandocCache,
    typstStatus: () => typstCache,
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

  // A saved document's extension is authoritative. An unsaved buffer follows
  // the same classifier the paste path uses, because its default extension is
  // only a suggestion until Save As chooses one. The editor's parser is never
  // changed here: `doc.language` still drives highlighting and preview.
  const assistantLanguage = (text: string): api.DocumentLanguage =>
    resolveAiLanguage(doc.path !== null, doc.language, text);

  assistant = createAssistant(editorPane, {
    config: () => ({
      enabled: settings.aiEnabled && !api.isWebSource(doc.language),
      provider: settings.aiProvider,
      baseUrl: settings.aiBaseUrl,
      model: settings.aiModel,
      contextTokens: settings.aiContextTokens ?? 8_192,
    }),
    language: () => assistantLanguage(editor.getDoc()),
    capture: () => {
      const info = editor.cursorInfo();
      const text = editor.getDoc();
      return captureContext({
        text,
        from: info.from,
        to: info.to,
        caret: info.to,
        language: assistantLanguage(text),
      });
    },
    sessionId: () => doc.id,
    revision: () => doc.revision,
    canWrite: () => !doc.readOnly,
    apply: (plan) =>
      plan.kind === "replace"
        ? editor.replaceRange(plan.from, plan.to, plan.text)
        : editor.insertText(plan.from, plan.text),
    openInNewTab: (text, language) => openAiDocument(text, language),
    focusEditor: () => editor.focus(),
    toast,
    openSettings: () => preferences.openAt("ai"),
    setEnabled: (enabled) => applySettingsPatch({ aiEnabled: enabled }),
    documentName: () => doc.name,
    usage: () => settings.aiActionUsage ?? [],
    // A completed request is the only thing that moves *Most used*. The quiet
    // patch skips the layout/theme work that a preference change needs, because
    // no surface but the palette reads this counter.
    recordUsage: (action) =>
      applySettingsPatch(
        {
          aiActionUsage: recordActionUsage(settings.aiActionUsage ?? [], action),
        },
        { effects: false },
      ),
    estimateTokens: (text) => api.countTokens(text),
    track: (positions) => editor.trackPositions(positions),
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
  setSpellIgnore(ignoreSpelling);
  setSpellStatus((key, status) => {
    if (key !== spellingSessionKey()) return;
    spellingStatus = { key, status };
    updateStatusFlags();
  });
  applyLayout();
  // The language list is a local COM/hunspell query, not a download. It still
  // waits until after the first paint: start-up does not block on it, and the
  // underlines appear once the answer is in.
  void api
    .spellcheckLanguages()
    .then((languages) => {
      spellingDiscovery = "ready";
      setInstalledLanguages(languages);
      applySpellcheck();
      updateStatusFlags();
      syncMenuState();
      preferences?.refresh();
    })
    .catch(() => {
      spellingDiscovery = "error";
      setInstalledLanguages([], true);
      updateStatusFlags();
      syncMenuState();
      preferences?.refresh();
    });

  await installMenuListener();
  await installLatexProgressListener();
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
  void refreshTypstServiceStatus();
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
    // The first path that is read fills the window's blank session; the slot is
    // consumed once, so every later path becomes a tab.
    await openPaths(startup);
  } else if (settings.onLaunch === "tabs") {
    // A brand-new profile shows the welcome document once, then behaves like
    // "tabs" from the second launch on. The empty-set fallback inside
    // `restoreLastTabs` stays a blank tab on purpose, so that Close All Tabs is
    // not undone at the next start; `welcomeSeen` is what tells the two apart.
    if (settings.welcomeSeen) await restoreLastTabs();
    else await loadUntitled(WELCOME);
  } else if (settings.onLaunch === "new") {
    await loadUntitled("", defaultDocumentLanguage());
  } else if (settings.onLaunch === "last" && settings.recentFiles.length > 0) {
    await openPath(settings.recentFiles[0], { silent: true });
  } else {
    await loadUntitled(WELCOME);
  }
  startupSlot = null;
  // The profile has now been introduced, however that happened: the welcome
  // document was shown, or the reader launched straight into their own file.
  // Recording it here rather than in the branch above means a first launch by
  // double-clicking a document also counts, so the next start restores the
  // remembered tabs instead of showing the welcome document a second time.
  if (!settings.welcomeSeen) {
    settings.welcomeSeen = true;
    persist();
  }
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
  window.setInterval(() => void autoSaveTick(), AUTO_SAVE_INTERVAL_MS);
}

let autoSaveRunning = false;

/**
 * One Auto Save pass.
 *
 * Skipped while a close is deciding: a background save changes the snapshot
 * the close compares after the reader answers, and the close would then drop
 * the reader's Save or Discard without a word. The tab is saved on the next
 * tick if the close is cancelled. A pass still running also skips the next
 * one, so a slow volume does not queue saves behind saves.
 */
async function autoSaveTick(): Promise<void> {
  if (!settings.autoSave || autoSaveRunning || lifecycle.closing) return;
  const pending = sessions
    .list()
    .filter((session) => session.dirty && session.path && !session.readOnly && !session.conflict);
  if (pending.length === 0) return;
  autoSaveRunning = true;
  try {
    let saved = 0;
    for (const session of pending) {
      if (lifecycle.closing) break;
      if (await writeSession(session, true)) saved += 1;
    }
    if (saved === 1) toast("Auto saved", 1400);
    else if (saved > 1) toast(`Auto saved ${saved} files`, 1400);
  } finally {
    autoSaveRunning = false;
  }
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
