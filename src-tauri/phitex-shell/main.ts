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
  Options,
  PageImage,
  PreviewSink,
  Status,
} from "./vendor/common/viewer/session.ts";
import { PreviewSession } from "./vendor/common/viewer/session.ts";
import { charOffset, textSum, type Edit } from "./vendor/common/viewer/edits.ts";
import { StripPages } from "./vendor/common/strippages.ts";

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

/** FNV-1a over UTF-16 code units, the hash MDraft's protocol uses. */
function textHash(text: string): number {
  let value = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    value ^= text.charCodeAt(i);
    value = Math.imul(value, 0x01000193);
  }
  return value >>> 0;
}

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
const binaries = new Map<string, Uint8Array>();
let main = "main.tex";
let active: string | null = null;
let openCb: ((file: string, text: string) => void) | undefined;
let changesCb:
  | ((file: string, edits: Edit[], len?: number, sum?: number) => void)
  | undefined;
let projectResolve: () => void = () => {};
const projectReady = new Promise<void>((resolve) => (projectResolve = resolve));
let projectStarted = false;
let lastSeq = 0;
let busy = false;
let pageCount = 0;
let lastStatus: Status | null = null;
let selectionAt = 0;
const pageSizes = new Map<number, { w: number; h: number }>();
let viewportTimer = 0;
let viewportBusy = false;
let pendingKind: "click" | "double" | "select" = "click";
let pendingY: number | null = null;
const startedAt = performance.now();

const hostEditor: EditorHost = {
  loadProject: async () => {
    await projectReady;
    log(`loadProject main=${main} files=${texts.size}`);
    return { ...Object.fromEntries(texts) };
  },
  mainFile: () => main,
  onOpen: (callback) => {
    openCb = callback;
  },
  onChanges: (callback) => {
    changesCb = callback;
  },
  resend: (file) => {
    const text = texts.get(file);
    if (text !== undefined) openCb?.(file, text);
  },
  ready: () => {
    log("editor host ready");
  },
};

const panel = new Panel(
  {
    onPage: (page) => {
      pageCount = Math.max(pageCount, page + 1);
      post({
        type: "viewport",
        scrollTop: stage()?.scrollTop ?? 0,
        page: null,
        file: null,
        line: null,
        gesture: false,
      });
    },
    onNeed: (page) => void session?.fetch(page),
    onPdf: () => void exportPdf(),
    onMain: (value) => {
      main = value;
    },
    onReload: () => void session?.reopen(),
    onClean: () => void session?.clean({ ...Object.fromEntries(texts) }),
    onGoto: (file, line) => {
      const text = texts.get(file);
      if (text === undefined) return;
      const at = offsetOfLine(text, line);
      pendingKind = "double";
      void session?.follow(file, at);
    },
    onGotoRange: (file, from, to) => postSource(file, from, to, false, pendingKind, null),
    onSyncSource: (page, x, y) => {
      pendingKind = "double";
      pendingY = null;
      void session?.toSource(page, x, y);
    },
    onSelectPage: (selection) => {
      selectionAt = performance.now();
      if (!selection.length) return;
      pendingKind = "select";
      pendingY = null;
      void session?.selectPage(selection);
    },
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
panelStyle.textContent =
  ".win.docked > .bar{display:none!important}.byline{display:none!important}.opening{display:none!important}.strips{display:none!important}.win > header{display:none!important}";
panelHost.shadowRoot!.append(panelStyle);
panel.dock(pane);
panel.shown(true);
// MDraft's 100% is the pane's width, as its PDF views fit it; the panel's
// "fit" is the same rule. A docked panel first measures the stage before the
// host's layout settles, so set it after the dock as well.
panel.zoomTo("fit");

const stage = (): HTMLElement | null =>
  panelHost.shadowRoot?.querySelector<HTMLElement>("#stage") ?? null;

const stripPanel = {
  pixelsPerPoint: () => panel.pixelsPerPoint(),
  pageView: (page: number) => panel.pageView(page),
  painted: (ms: number) => {
    panel.painted(ms);
    postPainted(false);
  },
};

const core = new WorkerCore(`phitex-${Math.random().toString(36).slice(2)}`);
const pages = new StripPages(core, stripPanel, panel.stripsChip());
let session: PreviewSession | undefined;

const sink: PreviewSink = {
  page: (image: PageImage | null, k: number, n: number, hash?: string | null) => {
    if (image) pageSizes.set(k, { w: image.w, h: image.h });
    panel.page(image, k, n, hash);
  },
  layout: (hashes, previews) => panel.layout(hashes, previews),
  opening: () => panel.opening(),
  status: (status) => {
    lastStatus = status;
    pageCount = Math.max(pageCount, status.pages);
    panel.status(status);
    postStatus();
  },
  busy: (on) => {
    busy = on;
    panel.busy(on);
    postStatus();
  },
  preparing: (on) => panel.preparing(on),
  warmup: (value) => panel.warmup(value),
  outline: (items) => panel.outline(items),
  citesBy: (ask) => panel.citesBy(ask),
  zoomBy: (ask) => panel.zoomBy(ask),
  streaming: (value) => panel.streaming(value),
  painted: (ms) => panel.painted(ms),
  buildTime: (ms, first) => panel.buildTime(ms, first),
  buildParts: (parts, beside) => panel.buildParts(parts, beside),
  joinedLate: (first, builds, last) => panel.joinedLate(first, builds, last),
  latency: (summary, details) => panel.latency(summary, details),
  packages: (packages) => panel.packages(packages),
  files: (names, skipped, took) => panel.files(names, skipped, took),
  docName: (name) => panel.docName(name),
  news: (version, text) => panel.news(version, text),
  goto: (file, from, to, focus) => postSource(file, from, to, focus === true, pendingKind, pendingY),
  marks: (marks) => panel.marks(marks),
  mark: (k, boxes, scroll) => panel.mark(k, boxes, scroll),
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

session = new PreviewSession(hostEditor, pages, sink, {
  checkEveryMs: 0,
  engine: () => "xelatex",
} as Partial<Options>);
(window as any).__phitex = { session, panel, pages, core, texts };
pages.onEvent((event) => {
  switch (event.event) {
    case "settled": {
      busy = false;
      postStatus();
      postPainted(true);
      const ms = Math.round(performance.now() - startedAt);
      const pagesNow = (event as { pages?: number }).pages ?? pageCount;
      log(`typeset ${pagesNow} page${pagesNow === 1 ? "" : "s"} in ${Math.round((event as { ms?: number }).ms ?? 0)} ms`);
      void session?.log().then((line) => {
        if (!line) return;
        for (const text of line.split("\n").slice(-80)) if (text.trim()) trace(text);
      });
      break;
    }
    case "page":
      pageCount = Math.max(pageCount, ((event as { pages?: number }).pages ?? 1));
      postPainted(false);
      break;
    case "building":
      busy = (event as { on?: boolean }).on === true;
      panel.busy(busy);
      postStatus();
      break;
    case "progress":
      if ((event as { phase?: string }).phase === "fetching") {
        const fetched = (event as { done?: number }).done ?? 0;
        trace(`fetching packages (${fetched})`);
      }
      break;
    case "diagnostics":
      postStatus();
      break;
    default:
      break;
  }
});

function postStatus(): void {
  const problems = (lastStatus?.diagnostics ?? [])
    .filter((item) => item.severity === "error" || item.severity === "warning")
    .map((item) => ({
      file: item.file ?? "",
      line: item.line ?? 0,
      column: 0,
      severity: item.severity === "error" ? "error" : "warning",
      message: item.message,
    }));
  post({ type: "status", busy, problems });
}

function postPainted(done: boolean): void {
  post({ type: "painted", seq: lastSeq, done, pages: pageCount });
}

function postSource(
  file: string,
  from: number,
  to: number,
  focus: boolean,
  kind: "click" | "double" | "select",
  y: number | null,
): void {
  const text = texts.get(file);
  if (text === undefined) return;
  const a = charOffset(text, from);
  const b = charOffset(text, to);
  post({
    type: "source",
    file,
    from: a,
    to: b,
    detail: kind === "double" ? 2 : 1,
    y,
    drag: kind === "select",
    precision: "exact",
  });
  if (focus) {
    // The page gesture already moved the host's editor; nothing else here.
  }
}

function offsetOfLine(text: string, line: number): number {
  const target = Math.max(1, Math.round(line));
  let at = 0;
  for (let n = 1; n < target; n += 1) {
    const next = text.indexOf("\n", at);
    if (next < 0) return text.length;
    at = next + 1;
  }
  return at;
}

function ack(seq: number, file: string, length: number, hash: number): void {
  post({ type: "ack", seq, file, length, hash });
}

function applyEdit(file: string, changes: [number, number, string][]): string {
  let text = texts.get(file) ?? "";
  for (const [from, to, insert] of changes) {
    text = text.slice(0, from) + insert + text.slice(to);
  }
  texts.set(file, text);
  return text;
}

function startProject(): void {
  if (projectStarted) return;
  projectStarted = true;
  log(`startProject main=${main} files=${texts.size}`);
  projectResolve();
  session?.start().catch((error) => {
    post({ type: "error", message: `the preview could not start: ${String(error)}` });
  });
}

function applyProject(message: any): void {
  if (message.replace) {
    texts.clear();
    binaries.clear();
  }
  const changed: Record<string, string> = {};
  for (const file of (message.files ?? []) as Array<{
    path: string;
    text?: string;
    bytes?: ArrayBuffer;
  }>) {
    if (typeof file.text === "string") {
      texts.set(file.path, file.text);
      changed[file.path] = file.text;
    } else if (file.bytes) {
      const bytes = new Uint8Array(file.bytes);
      binaries.set(file.path, bytes);
      void core.binary(file.path, bytes);
    }
  }
  for (const name of (message.remove ?? []) as string[]) {
    texts.delete(name);
    binaries.delete(name);
  }
  main = message.main ?? main;
  active = message.active ?? active;
  lastSeq = typeof message.seq === "number" ? message.seq : lastSeq;
  log(`project main=${main} active=${active} files=${texts.size}`);
  ack(lastSeq, active ?? main, -1, 0);
  const first = !projectStarted;
  startProject();
  // The first project is what start() is already loading. A later replace is a
  // fresh document in the same frame; a non-replace sync diffs the changed
  // files. Calling clean() before start() would reopen with no main yet.
  if (!first) {
    if (message.replace) {
      void session?.clean({ ...Object.fromEntries(texts) });
    } else if (Object.keys(changed).length) {
      session?.refresh(changed);
    }
  }
  if (active && texts.has(active)) openCb?.(active, texts.get(active)!);
}

window.addEventListener("message", (event) => {
  if (event.source !== window.parent || event.origin !== PROTOCOL_HOST) return;
  const message = event.data;
  if (!message || message.v !== V || typeof message.type !== "string") return;
  const seq = typeof message.seq === "number" ? message.seq : 0;
  switch (message.type) {
    case "init": {
      const theme = message.theme ?? { dark: false };
      panel.theme(theme.dark ? "dark" : "light");
      panel.darkPdf(theme.dark ? "on" : "off");
      if (typeof message.zoom === "number" && message.zoom > 0)
        panel.zoomTo(message.zoom === 1 ? "fit" : String(message.zoom));
      break;
    }
    case "project":
      applyProject({ ...message, seq });
      break;
    case "edit": {
      const file = String(message.file);
      const changes = message.changes as [number, number, string][];
      const text = applyEdit(file, changes);
      lastSeq = seq;
      ack(seq, file, text.length, textHash(text));
      // The session's `Edit` is an object; the host protocol sends a tuple.
      changesCb?.(
        file,
        changes.map(([from, to, insert]) => ({ from, to, text: insert })),
        text.length,
        textSum(text),
      );
      break;
    }
    case "text": {
      const file = String(message.file);
      const text = String(message.text);
      texts.set(file, text);
      lastSeq = seq;
      ack(seq, file, text.length, textHash(text));
      if (file === active) openCb?.(file, text);
      else session?.refresh({ [file]: text });
      break;
    }
    case "open": {
      active = String(message.file);
      if (texts.has(active)) openCb?.(active, texts.get(active)!);
      break;
    }
    case "select": {
      const file = String(message.file);
      const from = Number(message.from);
      const to = Number(message.to);
      trace(`select ${file} ${from}-${to}`);
      void session?.selectSource(file, from, to);
      break;
    }
    case "clear":
      void session?.selectBytes("", 0, 0);
      break;
    case "reveal": {
      const file = String(message.file);
      const text = texts.get(file);
      if (text === undefined) break;
      pendingKind = "double";
      void session?.follow(file, offsetOfLine(text, Number(message.line)));
      break;
    }
    case "reference":
      break;
    case "page": {
      const target = Math.floor(Number(message.page));
      if (Number.isFinite(target) && target >= 1) {
        jumpToPage(target);
        scheduleViewport();
      }
      break;
    }
    case "zoom":
      if (typeof message.factor === "number" && message.factor > 0)
        panel.zoomTo(message.factor === 1 ? "fit" : String(message.factor));
      break;
    case "theme": {
      const theme = message.theme ?? { dark: false };
      panel.theme(theme.dark ? "dark" : "light");
      panel.darkPdf(theme.dark ? "on" : "off");
      break;
    }
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
  const pdf = await session?.pdf();
  if (!pdf) {
    post({ type: "error", seq, message: "the preview has no PDF yet" });
    return;
  }
  const copy = pdf.slice();
  post(
    { type: "pdf", seq, pdf: copy.buffer, ms: performance.now() - started },
    [copy.buffer],
  );
}

async function dispose(seq: number): Promise<void> {
  try {
    session?.stop();
    pages.close();
    core.close();
    panel.shown(false);
    panel.dock(null);
    panelHost.remove();
  } finally {
    post({ type: "disposed", seq });
  }
}

// The single click TeXpresso's bridge reports: the viewer records the spot for
// every plain click; a drag's selection is reported by onSelectPage instead.
stage()?.addEventListener("pointerdown", () => post({ type: "input" }));
function scheduleViewport(): void {
  if (viewportTimer) return;
  viewportTimer = window.setTimeout(() => {
    viewportTimer = 0;
    void reportViewport();
  }, 120);
}
stage()?.addEventListener("scroll", scheduleViewport, { passive: true });
stage()?.addEventListener("click", (event) => {
  if ((event as MouseEvent).detail !== 1) return;
  if (performance.now() - selectionAt < 250) return;
  const spot = panel.spot();
  if (!spot) return;
  pendingKind = "click";
  pendingY = null;
  void session?.toSource(spot.k, spot.x, spot.y);
});
/**
 * The page at the top of the view and the source line under it: the host's
 * scroll sync (preview → source). Asked a page at a time, after the scroll
 * settles, from the same glyph origins a click uses.
 */
/** The last page jump and where it left the stage, so the report keeps it. */
let jumped: { page: number; top: number } | null = null;

function pageSlots(area: HTMLElement): HTMLElement[] {
  return [...area.querySelectorAll<HTMLElement>(".slot[data-k]")];
}

/**
 * Bring 1-based `page`'s top edge to the stage's top edge. The viewer's own
 * goTo leaves a margin above the page, which reads as landing between pages.
 */
function jumpToPage(page: number): void {
  const area = stage();
  if (!area) return;
  const slots = pageSlots(area);
  if (!slots.length) {
    panel.goPage(page - 1);
    return;
  }
  const wanted = Math.min(slots.length, page);
  const slot = slots[wanted - 1];
  const max = area.scrollHeight - area.clientHeight;
  // Rounded up so no sliver of the previous page shows above it.
  const top =
    wanted === 1
      ? 0
      : Math.ceil(
          slot.getBoundingClientRect().top - area.getBoundingClientRect().top + area.scrollTop,
        );
  area.scrollTop = Math.max(0, Math.min(max, top));
  jumped = { page: wanted, top: area.scrollTop };
}

/** The 1-based page at the stage's top edge, or null before a page is laid out. */
function pageAtTop(area: HTMLElement): number | null {
  const slots = pageSlots(area);
  if (!slots.length) return null;
  const scrollTop = area.scrollTop;
  // A jump that could not bring its page to the top (the last pages) still
  // landed on that page, and so did one the browser rounded a pixel short.
  if (jumped && Math.abs(jumped.top - scrollTop) <= 2 && jumped.page <= slots.length)
    return jumped.page;
  jumped = null;
  const max = area.scrollHeight - area.clientHeight;
  if (max > 0 && scrollTop >= max - 1) return slots.length;
  // Page tops are fractional under display scaling: a few pixels of slack.
  const y = area.getBoundingClientRect().top + 4;
  let lo = 0;
  let hi = slots.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (slots[mid].getBoundingClientRect().top <= y) lo = mid + 1;
    else hi = mid;
  }
  return Math.max(1, lo);
}

async function reportViewport(): Promise<void> {
  const area = stage();
  if (!area || !session) return;
  // A source lookup is still running: report once it is done rather than
  // dropping this one, or the page indicator keeps the old page.
  if (viewportBusy) {
    scheduleViewport();
    return;
  }
  let page = -1;
  let fraction = 0;
  for (let k = 0; k < Math.max(pageCount, pageSizes.size); k += 1) {
    const view = panel.pageView(k);
    if (!view) continue;
    page = k;
    fraction = Math.max(0, view[1]);
    break;
  }
  const current = pageAtTop(area);
  if (page < 0) {
    post({
      type: "viewport",
      scrollTop: area.scrollTop,
      page: current,
      file: null,
      line: null,
      gesture: true,
    });
    return;
  }
  const size = pageSizes.get(page);
  if (!size) return;
  viewportBusy = true;
  try {
    const y = Math.min(size.h - 2, Math.max(2, fraction * size.h + 4));
    const source = await session.sourceOf([
      { k: page, rects: [[0, y, size.w * 0.8, Math.max(24, size.h * 0.08)]] },
    ]);
    if (!source) {
      post({
        type: "viewport",
        scrollTop: area.scrollTop,
        page: current,
        file: null,
        line: null,
        gesture: true,
      });
      return;
    }
    const text = texts.get(source.file);
    if (text === undefined) return;
    const at = charOffset(text, source.start);
    const line = text.slice(0, at).split("\n").length;
    post({
      type: "viewport",
      scrollTop: area.scrollTop,
      page: current,
      file: source.file,
      line,
      gesture: true,
    });
  } catch {
    // A page without origins yet: the next scroll asks again.
  } finally {
    viewportBusy = false;
  }
}

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") post({ type: "key", key: "Escape" });
});

post({ type: "ready", engine: "xetex", jspi: false, backend: "phitex", missing: [] });
log("frame started");
