//! MDraft's PhiTeX frame.
//!
//! The frame hosts PhiTeX's `PreviewSession` and `Panel` on the single-thread
//! `core1.wasm` worker. It speaks MDraft's existing preview protocol, so the
//! host's toolbar, wait surface, source gestures, selection, export and print
//! paths are the same ones TeXpresso uses. The panel's own bar, byline and
//! opening are hidden: MDraft owns the controls.
//!
//! This file is built into `bundles/main.js`; see `scripts/build-phitex-frame.mjs`.

import "./vendor/platform.ts";
import { Panel } from "./vendor/common/viewer/panel.ts";
import type {
  CoreEvent,
  CoreRes,
  CoreTransport,
  EditorHost,
  PageImage,
  PreviewSink,
  Status,
} from "./vendor/common/viewer/session.ts";
import { PreviewSession } from "./vendor/common/viewer/session.ts";
import { charOffset } from "./vendor/common/viewer/edits.ts";
import { nearest } from "./vendor/common/viewer/sync.ts";
import { StripPages } from "./vendor/common/strippages.ts";
import { wordAt } from "../../src/source-map.ts";
import {
  textHash,
  type HostMessage,
  type TexpressoProblem,
  type TexpressoTheme,
} from "../../src/texpresso/protocol.ts";

const V = 1;
const PROTOCOL_HOST = new URLSearchParams(location.search).get("host") ?? window.location.origin;
const post = (message: Record<string, unknown>, transfer: Transferable[] = []) =>
  window.parent.postMessage({ v: V, ...message }, PROTOCOL_HOST);

const trace = (text: string) => post({ type: "trace", text: text.slice(0, 500) });

// A module that fails to evaluate would otherwise leave the host waiting for
// `ready` until its boot timeout; report the failure by the same channel.
window.addEventListener("error", (event) => {
  post({ type: "error", message: `the preview frame failed: ${event.message}` });
});
window.addEventListener("unhandledrejection", (event) => {
  post({ type: "error", message: `the preview frame failed: ${String(event.reason)}` });
});
const log = (text: string) => {
  trace(text);
  console.log("[phitex]", text);
};

class WorkerCore implements CoreTransport {
  private next = 1;
  private waiting = new Map<number, (reply: CoreRes) => void>();
  private events: ((event: CoreEvent) => void)[] = [];
  private worker: Worker;
  gone: string | undefined;

  constructor(project: string) {
    // The worker must be a module: its bundle rejects classic workers, and it
    // reads `import.meta` for its asset root. The absolute path is the origin
    // the Rust backend serves the frame from.
    this.worker = new Worker("/phitex/bundles/engine-worker.js", {
      type: "module",
      name: "phitex-core",
    });
    this.worker.onmessage = (event: MessageEvent<any>) => {
      const data = event.data;
      if (typeof data?.id === "number") {
        this.waiting.get(data.id)?.(data);
        this.waiting.delete(data.id);
      } else if (data) {
        for (const listener of this.events) listener(data);
      }
    };
    this.worker.onerror = (event) => {
      this.gone = `the engine worker failed: ${event.message}`;
      for (const [, resolve] of this.waiting) resolve({ ok: false, error: this.gone });
      this.waiting.clear();
      post({ type: "error", message: this.gone });
    };
    void this.request({ op: "hello", project });
  }

  request(op: { op: string; [key: string]: unknown }): Promise<CoreRes> {
    if (this.gone) return Promise.resolve({ ok: false, error: this.gone });
    const id = this.next++;
    return new Promise((resolve) => {
      this.waiting.set(id, resolve);
      this.worker.postMessage({ ...op, id });
    });
  }

  binary(file: string, bytes: Uint8Array): Promise<CoreRes> {
    return this.request({ op: "binary", file, bytes });
  }

  onEvent(callback: (event: CoreEvent) => void): () => void {
    this.events.push(callback);
    return () => void this.events.splice(this.events.indexOf(callback) >>> 0, 1);
  }

  close(): void {
    this.worker.terminate();
  }
}

const pane = document.getElementById("pane") as HTMLElement;
const texts = new Map<string, string>();
let main = "main.tex";
let lastSeq = 0;
let lastSettledSeq = 0;
let pageCount = 0;
let hasPainted = false;
let disposed = false;

const hostEditor: EditorHost = {
  loadProject: async () => Object.fromEntries(texts),
  mainFile: () => main,
  // The frame acknowledges transactions immediately and syncs their combined text in batches.
  onOpen: () => {},
  onChanges: () => {},
};

const panel = new Panel(
  {
    onPage: (page) => {
      void session.setPage(page);
      scheduleViewport();
    },
    onNeed: (page) => void session?.fetch(page),
    onPdf: () => void exportPdf(),
    onMain: (value) => {
      main = value;
    },
    onReload: () => void runTypeset(() => session.reopen()),
    onClean: () => void runTypeset(() => session.clean(Object.fromEntries(texts), main)),
    onGoto: (file, line) => queueReveal({ file, line, y: reference, seq: null }),
    onSyncSource: (page, x, y) => void clickSource(page, x, y, 2),
    onSelectPage: (selection) => void selectPage(selection),
    onLink: (uri) => post({ type: "link", uri }),
    onSource: async (file) => texts.get(file) ?? null,
    onLog: async () => (await session?.log()) ?? null,
    onFind: async () => [],
  },
  { load: async () => ({}), save: () => {} },
  {
    header: false,
    footer: false,
    tips: false,
    keys: false,
    outline: false,
    opening: false,
    fitWidthPadding: 16,
    words: {
      byline: "",
      badge: "",
      badgeTitle: "",
      about: "LaTeX preview by an incremental engine (PhiTeX, AGPL-3.0-only).",
      preparing: "",
      license: "LICENSE",
      realPdf: "",
      stopped: "",
      notReady: "",
      openFailed: "",
      reading: "",
      keptIn: "this device",
      steps: ["", "", ""],
    },
  },
);

const panelHost = document.querySelector("phitex-preview") as HTMLElement;
const panelStyle = document.createElement("style");
panelStyle.textContent = `
  .win.docked > .bar, .byline, .opening, .strips, .win > header { display: none !important; }
  .win.docked #stage { background: var(--mdraft-pane, #e9edf2); overflow-anchor: none; }
  .viewer { display: flow-root; }
  .slot { margin: 16px auto; }
  .slot .mark.sel,
  .slot .mark.seltext { background: var(--mdraft-sync, rgba(255, 193, 7, 0.3)); box-shadow: none; border-radius: 2px; }
  #viewer[data-blink] .mark.sel { animation: mdraft-pulse 500ms ease-in-out 4; }
  @keyframes mdraft-pulse { 50% { background: var(--mdraft-sync-peak, rgba(255, 167, 0, 0.55)); } }
  @media (prefers-reduced-motion: reduce) {
    #viewer[data-blink] .mark.sel { animation: none; }
  }
`;
panelHost.shadowRoot!.append(panelStyle);
panel.dock(pane);
panel.shown(true);
// MDraft's 100% is the pane's width, as its PDF views fit it; the panel's
// "fit" is the same rule. A docked panel first measures the stage before the
// host's layout settles, so set it after the dock as well.
panel.zoomTo("fit");

const stage = panelHost.shadowRoot!.querySelector<HTMLElement>("#stage")!;
const viewer = panelHost.shadowRoot!.querySelector<HTMLElement>("#viewer")!;

const stripPanel = {
  pixelsPerPoint: () => panel.pixelsPerPoint(),
  pageView: (page: number) => panel.pageView(page),
  painted: (ms: number) => {
    panel.painted(ms);
  },
};

const core = new WorkerCore(`phitex-${Math.random().toString(36).slice(2)}`);
const pages = new StripPages(core, stripPanel, panel.stripsChip());
const sink: PreviewSink = {
  page: (image: PageImage | null, k: number, n: number, hash?: string | null) => {
    panel.page(image, k, n, hash);
    if (image && !hasPainted) {
      hasPainted = true;
      post({ type: "painted", seq: lastSeq, done: false, pages: pageCount });
      updateStatus();
    }
    scheduleViewport();
  },
  layout: (hashes, previews) => {
    panel.layout(hashes, previews);
    if (pageCount === hashes.length) return;
    pageCount = hashes.length;
    post({ type: "pages", pages: pageCount });
    updateStatus();
    scheduleViewport();
  },
  opening: () => panel.opening(),
  status: (status) => {
    lastStatus = status;
    problems = previewProblems(status);
    problemSignature = JSON.stringify(problems);
    updateStatus();
  },
  preparing: (on) => panel.preparing(on),
  warmup: (value) => panel.warmup(value),
  outline: (items) => panel.outline(items),
  citesBy: (ask) => panel.citesBy(ask),
  zoomBy: (ask) => panel.zoomBy(ask),
  streaming: (value) => panel.streaming(value),
  painted: (ms) => panel.painted(ms),
  buildTime: (ms, first) => panel.buildTime(ms, first),
  latency: (summary, details) => panel.latency(summary, details),
  packages: (packages) => panel.packages(packages),
  marks: (marks) => panel.marks(marks, false),
  others: (marks) => panel.others(marks),
  engine: (engine) => panel.engine(engine),
  error: (message) => {
    trace(`preview: ${message}`);
    panel.error(message);
    post({ type: "error", message });
  },
  connection: (up, why) => panel.connection(up, why),
  check: (result) => panel.check(result),
  mains: (names, value) => panel.mains(names, value),
};

const session = new PreviewSession(hostEditor, pages, sink, {
  checkEveryMs: 0,
  engine: () => "xelatex",
});
(window as any).__phitex = { session, panel, pages, core, texts };
// A short pause keeps isolated edits live. The maximum wait also lets the
// preview advance while a reader keeps typing, with at most one batch in flight.
const EDIT_QUIET_MS = 140;
const EDIT_MAX_WAIT_MS = 450;
const dirtyFiles = new Set<string>();
let firstEditAt = 0;
let lastEditAt = -Infinity;
let batchTimer = 0;
let idleTimer = 0;
let work = Promise.resolve();
let workCount = 0;
let buildMs = 0;
let lastStatus: Status | null = null;
let appliedStatus: Status | null = null;
let problems: TexpressoProblem[] = [];
let problemSignature = "[]";
let sentProblems = "";
let sentBusy = false;

pages.onEvent((event) => {
  switch (event.event) {
    case "settled":
      if (event.settling) return;
      buildMs = event.ms ?? 0;
      break;
    default:
      return;
  }
  updateStatus();
});

function previewProblems(status: Status): TexpressoProblem[] {
  return (status.diagnostics ?? [])
    .filter((item) => item.severity === "error" || item.severity === "warning")
    .map((item) => ({
      file: item.file ?? "",
      line: item.line ?? 0,
      column: 0,
      severity: item.severity === "error" ? "error" : "warning",
      message: item.message,
    }));
}

function hasTypesetWork(): boolean {
  return workCount > 0 || dirtyFiles.size > 0;
}

function updateStatus(): void {
  if (disposed) return;
  window.clearTimeout(idleTimer);
  const remaining = lastEditAt + EDIT_QUIET_MS - performance.now();
  const working = hasTypesetWork();
  const busy = working || remaining > 0;
  if (!working && busy) idleTimer = window.setTimeout(updateStatus, remaining);
  if (!busy && lastStatus && appliedStatus !== lastStatus) {
    panel.status(lastStatus);
    appliedStatus = lastStatus;
  }
  if (busy !== sentBusy || problemSignature !== sentProblems) {
    if (busy !== sentBusy) panel.busy(busy);
    post({ type: "status", busy, problems: problemSignature === sentProblems ? null : problems });
    sentBusy = busy;
    sentProblems = problemSignature;
  }
  if (busy || !hasPainted || !pageCount || lastSeq <= lastSettledSeq) return;
  lastSettledSeq = lastSeq;
  post({ type: "painted", seq: lastSeq, done: true, pages: pageCount });
  log("typeset " + pageCount + " pages in " + Math.round(buildMs) + " ms");
}

function runTypeset(run: () => Promise<void>): Promise<void> {
  workCount += 1;
  updateStatus();
  work = work
    .then(async () => {
      if (!disposed) await run();
    })
    .catch((error: unknown) => sink.error(String(error)))
    .finally(() => {
      workCount -= 1;
      scheduleEdits();
      updateStatus();
    });
  return work;
}

function scheduleEdits(): void {
  window.clearTimeout(batchTimer);
  if (disposed || workCount || !dirtyFiles.size) return;
  const due = Math.min(firstEditAt + EDIT_MAX_WAIT_MS, lastEditAt + EDIT_QUIET_MS);
  batchTimer = window.setTimeout(() => void flushEdits(), Math.max(0, due - performance.now()));
}

function queueEdit(file: string): void {
  lastEditAt = performance.now();
  if (!dirtyFiles.size) firstEditAt = lastEditAt;
  dirtyFiles.add(file);
  clearMarks();
  scheduleEdits();
  updateStatus();
}

function flushEdits(): Promise<void> {
  window.clearTimeout(batchTimer);
  if (!dirtyFiles.size) return work;
  const files = [...dirtyFiles].map((file) => [file, texts.get(file)] as const);
  dirtyFiles.clear();
  return runTypeset(async () => {
    for (const [file, text] of files) {
      if (text !== undefined) session.sync(file, text);
    }
    await session.flush();
  });
}

function ack(seq: number, file: string, length: number, hash: number): void {
  post({ type: "ack", seq, file, length, hash });
}

function applyEdit(file: string, changes: [number, number, string][]): string {
  let text = texts.get(file) ?? "";
  for (const [from, to, insert] of changes) {
    text = text.slice(0, from) + insert + text.slice(to);
  }
  return text;
}

let projectStarted = false;

function applyProject(message: Extract<HostMessage, { type: "project" }>, seq: number): void {
  if (message.replace) {
    texts.clear();
    lineIndexes.clear();
  }
  const changed: string[] = [];
  for (const file of message.files) {
    if (typeof file.text === "string") {
      texts.set(file.path, file.text);
      changed.push(file.path);
    } else if (file.bytes) {
      void core.binary(file.path, new Uint8Array(file.bytes));
    }
  }
  let removedText = false;
  for (const file of message.remove) {
    if (texts.delete(file)) removedText = true;
    lineIndexes.delete(file);
  }
  const replace = message.replace || removedText || message.main !== main;
  main = message.main;
  session.open = message.active;
  lastSeq = seq;
  if (!projectStarted) {
    projectStarted = true;
    void runTypeset(() => session.start());
  } else if (replace) {
    // A watchdog resync replaces the session's copies, including the open file.
    // Edits arriving during the reopen stay queued against the new snapshot.
    dirtyFiles.clear();
    clearMarks();
    const snapshot = Object.fromEntries(texts);
    const root = main;
    void runTypeset(() => session.clean(snapshot, root));
  } else {
    for (const file of changed) queueEdit(file);
    updateStatus();
  }
  ack(seq, message.active ?? main, -1, 0);
}

window.addEventListener("message", (event) => {
  if (event.source !== window.parent || event.origin !== PROTOCOL_HOST) return;
  const message = event.data as (HostMessage & { v: number; seq: number }) | null;
  if (disposed || !message || message.v !== V) return;
  const { seq } = message;
  switch (message.type) {
    case "init":
      applyTheme(message.theme);
      applyZoom(message.zoom);
      setReference(message.reference);
      break;
    case "project":
      applyProject(message, seq);
      break;
    case "edit":
    case "text": {
      const { file } = message;
      const text = message.type === "text" ? message.text : applyEdit(file, message.changes);
      texts.set(file, text);
      lineIndexes.delete(file);
      lastSeq = seq;
      queueEdit(file);
      ack(seq, file, text.length, textHash(text));
      break;
    }
    case "open":
      session.open = message.file;
      break;
    case "select":
      if (!hasTypesetWork()) selectSource(message.file, message.from, message.to, message.blink);
      break;
    case "clear":
      clearMarks();
      break;
    case "reveal":
      queueReveal({ file: message.file, line: message.line, y: message.y, seq });
      break;
    case "reference":
      setReference(message.y);
      break;
    case "page":
      if (Number.isInteger(message.page) && message.page >= 1) jumpToPage(message.page);
      break;
    case "zoom":
      applyZoom(message.factor);
      break;
    case "theme":
      applyTheme(message.theme);
      break;
    case "export":
      void exportPdf(seq);
      break;
    case "dispose":
      void dispose(seq);
      break;
    default:
      break;
  }
});

async function exportPdf(seq = 0): Promise<void> {
  const started = performance.now();
  await flushEdits();
  if (disposed) return;
  const revision = lastSeq;
  const pdf = await session.pdf();
  if (!pdf) {
    post({ type: "error", seq, message: "the preview has no PDF yet" });
    return;
  }
  const output = await session.log();
  if (output && revision === lastSeq) {
    for (const line of output.split("\n").slice(-80)) if (line.trim()) trace(line);
  }
  const copy = pdf.slice();
  post({ type: "pdf", seq, pdf: copy.buffer, ms: performance.now() - started }, [copy.buffer]);
}

async function dispose(seq: number): Promise<void> {
  try {
    disposed = true;
    window.clearTimeout(batchTimer);
    window.clearTimeout(idleTimer);
    window.clearTimeout(blinkTimer);
    window.cancelAnimationFrame(viewportFrame);
    window.cancelAnimationFrame(revealFrame);
    session.stop();
    pages.close();
    core.close();
    panel.shown(false);
    panel.dock(null);
    panelHost.remove();
  } finally {
    post({ type: "disposed", seq });
  }
}

function applyTheme(theme: TexpressoTheme): void {
  panel.theme(theme.dark ? "dark" : "light");
  panel.darkPdf(theme.dark ? "on" : "off");
  panelHost.style.setProperty("--mdraft-pane", theme.pane);
  panelHost.style.setProperty("--mdraft-sync", theme.sync);
  panelHost.style.setProperty("--mdraft-sync-peak", theme.peak);
}

let zoom = 1;
function applyZoom(factor: number): void {
  if (!Number.isFinite(factor) || factor <= 0 || factor === zoom) return;
  zoom = factor;
  clearScrollInput();
  panel.zoomTo("fit", factor);
  scheduleViewport();
}

let marked = false;
let markStamp = 0;
let blinkTimer = 0;

function clearPageSelection(): void {
  const root = panelHost.shadowRoot as (ShadowRoot & { getSelection?: () => Selection | null }) | null;
  const selection = root?.getSelection?.() ?? window.getSelection();
  if (selection && !selection.isCollapsed) selection.removeAllRanges();
  for (const mark of viewer.querySelectorAll(".mark.seltext")) mark.remove();
}

function clearSourceMarks(): void {
  window.clearTimeout(blinkTimer);
  blinkTimer = 0;
  markStamp += 1;
  if (!marked) return;
  marked = false;
  viewer.removeAttribute("data-blink");
  void session.selectBytes("", 0, 0);
}

function selectSource(file: string, from: number, to: number, blink: boolean): void {
  if (!texts.has(file)) return;
  window.clearTimeout(blinkTimer);
  blinkTimer = 0;
  clearPageSelection();
  const stamp = ++markStamp;
  marked = true;
  viewer.toggleAttribute("data-blink", blink);
  void session.selectSource(file, from, to).then(() => {
    if (blink && stamp === markStamp && !disposed) {
      blinkTimer = window.setTimeout(clearSourceMarks, 620);
    }
  });
}

function clearMarks(): void {
  clearPageSelection();
  clearSourceMarks();
}

interface LineIndex {
  text: string;
  starts: number[];
  bytes: number;
}

const lineIndexes = new Map<string, LineIndex>();
function lineIndex(file: string): LineIndex | null {
  const text = texts.get(file);
  if (text === undefined) return null;
  const cached = lineIndexes.get(file);
  if (cached?.text === text) return cached;
  const bytes = new TextEncoder().encode(text);
  const starts = [0];
  for (let i = 0; i < bytes.length; i += 1) if (bytes[i] === 10) starts.push(i + 1);
  const index = { text, starts, bytes: bytes.length };
  lineIndexes.set(file, index);
  return index;
}

/** 1-based source line for an engine byte offset. */
function sourceLine(starts: readonly number[], byte: number): number {
  let lo = 0;
  let hi = starts.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid] <= byte) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

interface SourceAnchor {
  file: string;
  line: number;
  y: number;
}

async function pageAnchors(page: number): Promise<SourceAnchor[]> {
  const glyphs = await session.sourceGlyphs(page);
  const byFile = new Map<string, Map<number, SourceAnchor>>();
  for (const g of glyphs) {
    if (!g.file || g.synth || g.end <= g.start) continue;
    const source = lineIndex(g.file);
    if (!source || g.start < 0 || g.end > source.bytes) continue;
    const line = sourceLine(source.starts, g.start);
    let lines = byFile.get(g.file);
    if (!lines) byFile.set(g.file, (lines = new Map()));
    const y = g.y - 8;
    const previous = lines.get(line);
    if (!previous || y < previous.y) lines.set(line, { file: g.file, line, y });
  }
  return [...byFile.values()].flatMap((lines) => [...lines.values()]);
}

function surrounding(anchors: SourceAnchor[], key: "line" | "y", at: number) {
  let before: SourceAnchor | undefined;
  let after: SourceAnchor | undefined;
  for (const anchor of anchors) {
    const value = anchor[key];
    if (value <= at && (!before || value > before[key])) before = anchor;
    if (value >= at && (!after || value < after[key])) after = anchor;
  }
  return { before, after };
}

function between(a: number, b: number, x: number, start: number, end: number): number {
  return a === b ? start : start + ((x - a) / (b - a)) * (end - start);
}

function pageSlots(): NodeListOf<HTMLElement> {
  return viewer.querySelectorAll<HTMLElement>(".slot[data-k]");
}

/** Index of the last page whose top is at or above this screen height. */
function pageAt(slots: NodeListOf<HTMLElement>, y: number): number {
  let lo = 0;
  let hi = slots.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (slots[mid].getBoundingClientRect().top <= y) lo = mid + 1;
    else hi = mid;
  }
  return Math.max(0, lo - 1);
}

const cssPoints = () => panel.pixelsPerPoint() / window.devicePixelRatio;
const maxScroll = () => Math.max(0, stage.scrollHeight - stage.clientHeight);

let reference = 0;
let inputUntil = 0;
let observedTop = stage.scrollTop;
/** The requested page still counts if the last page could not go to the top. */
let jumped: { page: number; top: number } | null = null;
let viewportFrame = 0;
let viewportBusy = false;
let viewportStamp = 0;
let viewportGesture = false;
let viewportPending = false;

function setReference(y: number): void {
  if (!Number.isFinite(y) || reference === Math.max(0, y)) return;
  reference = Math.max(0, y);
  viewportStamp += 1;
}

function clearScrollInput(): void {
  inputUntil = 0;
  viewportGesture = false;
  viewportStamp += 1;
}

function writeScroll(top: number): number {
  clearScrollInput();
  stage.scrollTop = Math.max(0, Math.min(top, maxScroll()));
  observedTop = stage.scrollTop;
  scheduleViewport();
  return observedTop;
}

function jumpToPage(page: number): void {
  const slots = pageSlots();
  if (!slots.length) return;
  cancelReveal();
  const wanted = Math.min(slots.length, page);
  const top =
    wanted === 1
      ? 0
      : Math.ceil(
          slots[wanted - 1].getBoundingClientRect().top -
            stage.getBoundingClientRect().top +
            stage.scrollTop,
        );
  jumped = { page: wanted, top: writeScroll(top) };
  scheduleViewport(true);
}

function scheduleViewport(gesture = false): void {
  viewportPending = true;
  viewportGesture ||= gesture;
  if (disposed || viewportFrame || viewportBusy) return;
  viewportFrame = window.requestAnimationFrame(() => void reportViewport());
}

async function reportViewport(): Promise<void> {
  viewportFrame = 0;
  viewportPending = false;
  viewportBusy = true;
  const gesture = viewportGesture;
  const stamp = viewportStamp;
  const revision = lastSeq;
  viewportGesture = false;
  try {
    const slots = pageSlots();
    const top = stage.scrollTop;
    const edge = stage.getBoundingClientRect().top;
    const current = !slots.length
      ? null
      : jumped && Math.abs(jumped.top - top) <= 2 && jumped.page <= slots.length
        ? jumped.page
        : maxScroll() > 0 && top >= maxScroll() - 1
          ? slots.length
          : pageAt(slots, edge + 4) + 1;
    let file: string | null = null;
    let line: number | null = null;
    if (current !== null && gesture && !hasTypesetWork()) {
      const height = edge + Math.min(reference, stage.clientHeight);
      let k = pageAt(slots, height);
      // The reference can be in the gap just before the next page.
      if (slots[k].getBoundingClientRect().bottom < height && k + 1 < slots.length) k += 1;
      const y = (height - slots[k].getBoundingClientRect().top) / cssPoints();
      const { before, after } = surrounding(await pageAnchors(k), "y", y);
      const closest = before && (!after || y - before.y <= after.y - y) ? before : after;
      if (closest) {
        file = closest.file;
        line =
          before && after && before.file === after.file && before.line <= after.line
            ? between(before.y, after.y, y, before.line, after.line)
            : closest.line;
      }
    }
    if (!disposed && stamp === viewportStamp && revision === lastSeq) {
      post({ type: "viewport", scrollTop: top, page: current, file, line, gesture });
    }
  } finally {
    viewportBusy = false;
    if (viewportPending) scheduleViewport();
  }
}

interface Reveal {
  file: string;
  line: number;
  y: number;
  seq: number | null;
}

let pendingReveal: Reveal | null = null;
let revealStamp = 0;
let revealFrame = 0;
let revealBusy = false;

function cancelReveal(): void {
  revealStamp += 1;
  pendingReveal = null;
}

function queueReveal(request: Reveal): void {
  if (!Number.isFinite(request.line) || !Number.isFinite(request.y)) return;
  revealStamp += 1;
  clearScrollInput();
  pendingReveal = request;
  scheduleReveal();
}

function scheduleReveal(): void {
  if (disposed || revealBusy || revealFrame || !pendingReveal) return;
  revealFrame = window.requestAnimationFrame(() => void revealSource());
}

async function revealSource(): Promise<void> {
  revealFrame = 0;
  const request = pendingReveal;
  if (!request) return;
  pendingReveal = null;
  revealBusy = true;
  const stamp = revealStamp;
  const revision = lastSeq;
  const stale = () => disposed || stamp !== revealStamp || revision !== lastSeq || hasTypesetWork();
  try {
    const top = stale() ? null : await locateSource(request, stale);
    if (disposed || stamp !== revealStamp || revision !== lastSeq) return;
    if (top !== null && !stale()) {
      jumped = null;
      const actual = writeScroll(top);
      if (request.seq !== null) post({ type: "scrolled", seq: request.seq, scrollTop: actual });
    } else if (request.seq !== null) {
      post({ type: "scrolled", seq: request.seq, scrollTop: null });
    }
  } finally {
    revealBusy = false;
    scheduleReveal();
  }
}

async function locateSource(
  { file, line, y }: Reveal,
  stale: () => boolean,
): Promise<number | null> {
  const source = lineIndex(file);
  const slots = pageSlots();
  if (!source || !slots.length || line < 1 || Math.floor(line) > source.starts.length) return null;
  if (file === main && line <= 1) return 0;
  const edge = stage.getBoundingClientRect().top;
  const here = pageAt(slots, edge + y);
  const placement = async (page: number) => {
    if (!slots[page] || stale()) return null;
    const anchors = (await pageAnchors(page)).filter((anchor) => anchor.file === file);
    const { before, after } = surrounding(anchors, "line", line);
    if (before && after && before.y <= after.y) {
      return {
        page,
        distance: after.line - before.line,
        point: between(before.line, after.line, line, before.y, after.y),
      };
    }
    const closest = before && (!after || line - before.line <= after.line - line) ? before : after;
    if (!closest || Math.abs(closest.line - line) > 1) return null;
    return { page, distance: 2 + Math.abs(closest.line - line), point: closest.y };
  };

  let best = await placement(here);
  // A generated contents entry can appear far from its source. Prefer a
  // tighter bound on a neighboring page to interpolation across that gap.
  const checked = new Set([here]);
  const tryPages = async (pages: readonly number[]) => {
    for (const page of pages) {
      if (checked.has(page) || stale()) continue;
      checked.add(page);
      const candidate = await placement(page);
      if (candidate && (!best || candidate.distance < best.distance)) best = candidate;
    }
  };
  if (!best || best.distance > 1) await tryPages([here - 1, here + 1]);
  if ((!best || best.distance > 3) && !stale()) {
    const at = source.starts[Math.floor(line) - 1];
    await tryPages(await session.sourcePages(file, at, stale));
  }
  if (!best || stale()) return null;
  const box = slots[best.page].getBoundingClientRect();
  return stage.scrollTop + box.top + best.point * cssPoints() - y;
}

let gestureStamp = 0;
let doubleClickStamp = -1;
let pressed: { x: number; y: number } | null = null;
let pointerDragged = false;

function readerInput(): void {
  cancelReveal();
  gestureStamp += 1;
  clearScrollInput();
  inputUntil = performance.now() + 500;
  jumped = null;
  post({ type: "input" });
}

async function clickSource(k: number, x: number, y: number, detail: 1 | 2): Promise<void> {
  if (hasTypesetWork()) return;
  const slot = pageSlots()[k];
  if (!slot) return;
  const height = slot.getBoundingClientRect().top + y * cssPoints();
  const revision = lastSeq;
  const gesture = ++gestureStamp;
  if (detail === 2) doubleClickStamp = gesture;
  const glyphs = (await session.sourceGlyphs(k)).filter((g) => g.file && !g.synth);
  if (disposed || gesture !== gestureStamp || revision !== lastSeq || hasTypesetWork()) return;
  const glyph = nearest(glyphs, x, y);
  if (!glyph?.file) return;
  const offsets = glyphOffsets(glyph.file, glyph.start, glyph.end);
  if (!offsets) return;
  const onGlyph = Math.abs(glyph.y - 3 - y) <= 7 && Math.abs(glyph.x + 2.5 - x) <= 8;
  if (detail === 2 && !onGlyph) return;
  const word = detail === 2 ? wordAt(texts.get(glyph.file)!, offsets.from) : null;
  const range = word && word.from <= offsets.from && word.to >= offsets.to ? word : offsets;
  post({
    type: "source",
    file: glyph.file,
    from: range.from,
    to: detail === 2 ? range.to : range.from,
    detail,
    y: onGlyph ? height : null,
    drag: false,
    // Several printed glyphs can carry the same source range. Only a
    // single-character origin can place the exact caret on a plain click.
    precision: !onGlyph
      ? "none"
      : detail === 2 || offsets.to - offsets.from === 1
        ? "exact"
        : "line",
  });
}

function glyphOffsets(file: string, start: number, end: number) {
  const source = lineIndex(file);
  if (!source || start < 0 || end <= start || end > source.bytes) return null;
  return { from: charOffset(source.text, start), to: charOffset(source.text, end) };
}

async function selectPage(selection: Parameters<PreviewSession["sourceOf"]>[0]): Promise<void> {
  // The browser also selects text on double-click. The click report owns
  // that gesture and carries its reveal height to the host.
  if (!selection.length || hasTypesetWork() || doubleClickStamp === gestureStamp) return;
  const revision = lastSeq;
  const gesture = ++gestureStamp;
  const found = await session.sourceOf(selection);
  if (!found || disposed || gesture !== gestureStamp || revision !== lastSeq || hasTypesetWork())
    return;
  const offsets = glyphOffsets(found.file, found.start, found.end);
  if (!offsets) return;
  post({
    type: "source",
    file: found.file,
    ...offsets,
    detail: 1,
    y: null,
    drag: true,
    precision: "exact",
  });
}

stage.addEventListener("pointerdown", (event) => {
  pressed = { x: event.clientX, y: event.clientY };
  pointerDragged = false;
  clearSourceMarks();
  readerInput();
});
window.addEventListener(
  "pointermove",
  (event) => {
    if (pressed && Math.hypot(pressed.x - event.clientX, pressed.y - event.clientY) > 4)
      pointerDragged = true;
  },
  { passive: true },
);
window.addEventListener("pointerup", () => (pressed = null));
window.addEventListener("pointercancel", () => (pressed = null));
stage.addEventListener(
  "wheel",
  (event) => {
    readerInput();
    if ((event.ctrlKey || event.metaKey) && !(event.target as Element).closest(".peek")) {
      event.preventDefault();
      event.stopImmediatePropagation();
      const unit = event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? stage.clientHeight : 1;
      post({ type: "zoom-wheel", deltaY: event.deltaY * unit });
    }
  },
  { capture: true, passive: false },
);
stage.addEventListener("touchstart", readerInput, { passive: true });
stage.addEventListener("keydown", readerInput);
stage.addEventListener(
  "scroll",
  () => {
    const top = stage.scrollTop;
    if (observedTop === top) return;
    observedTop = top;
    viewportStamp += 1;
    const gesture = !!pressed || performance.now() < inputUntil;
    if (gesture) inputUntil = performance.now() + 500;
    scheduleViewport(gesture);
  },
  { passive: true },
);
stage.addEventListener("click", (event) => {
  if (event.detail !== 1 || pointerDragged || event.defaultPrevented) return;
  if (!(event.target as Element).closest(".slot")) return;
  const spot = panel.spot();
  if (spot) void clickSource(spot.k, spot.x, spot.y, 1);
});

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") post({ type: "key", key: "Escape" });
});

post({ type: "ready", engine: "xetex", jspi: false, backend: "phitex", missing: [] });
log("frame started");
