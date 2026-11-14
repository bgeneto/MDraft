// The frame side of MDraft's TeXpresso preview, protocol 1.
//
// MDraft owns the editor, the project and every decision; this frame owns the
// engine, its page canvases and the hidden TeXpresso editor that holds the
// engine's source map. The host side and the message types are
// src/texpresso/protocol.ts; the plan is docs/architecture.md.
//
// Only members of `window.texpresso` are used, never a minified name. The one
// exception the page itself offers is the DOM the app renders into: `#pages`,
// its `.page` children and the `.cursor-mark` boxes the source map paints.
(() => {
  const PROTOCOL = 1;
  // The host passes its origin; it is checked against the browser's own record
  // where one exists, and every message from anywhere else is ignored.
  const params = new URLSearchParams(location.search);
  const HOST = (() => {
    const named = params.get("host") ?? "";
    const known = location.ancestorOrigins?.[0];
    return known && known !== named ? null : named || null;
  })();
  const REQUIRED = [
    "project",
    "openFile",
    "compile",
    "setText",
    "editor",
    "preview",
    "dvi",
    "problems",
    "worker",
    "goToSource",
    "exportPdf",
  ];

  const post = (message, transfer = []) => {
    if (!HOST) return;
    try {
      parent.postMessage({ v: PROTOCOL, ...message }, HOST, transfer);
    } catch {
      /* the frame is being torn down */
    }
  };
  const api = () => globalThis.texpresso;
  const pagesBox = () => document.getElementById("pages");
  // A tiny in-page trace the CDP layer can read at any time: console output
  // emitted before a test attaches is lost, and a paint that never arrives has
  // no other evidence. Bounded, and it names no document content.
  const trace = [];
  const note = (what) => {
    trace.push(`${Math.round(performance.now())} ${what}`);
    if (trace.length > 40) trace.shift();
    document.documentElement.dataset.mdraftTrace = trace.join(" | ");
  };

  // FNV-1a over UTF-16 code units; src/texpresso/protocol.ts computes the same.
  const hash = (text) => {
    let value = 0x811c9dc5;
    for (let i = 0; i < text.length; i += 1) {
      value ^= text.charCodeAt(i);
      value = Math.imul(value, 0x01000193);
    }
    return value >>> 0;
  };

  // ---------------------------------------------------------------------
  // Dispatches this bridge makes are not reader gestures. Anything else that
  // moves the hidden editor's selection is the app's own preview click.
  let internal = 0;
  const quietly = (work) => {
    internal += 1;
    try {
      return work();
    } finally {
      internal -= 1;
    }
  };
  const openName = () => document.getElementById("file-title")?.textContent?.trim() || null;
  const ensureOpen = (file) => {
    if (!file || openName() === file) return true;
    if (!api().project.paths().includes(file)) return false;
    quietly(() => api().openFile(file, 0, 0));
    positions.clear();
    return openName() === file;
  };

  // ---------------------------------------------------------------------
  // Scrolling. The app follows its caret by writing `#pages.scrollTop`; MDraft's
  // rule is that a caret or a selection never moves the preview, so those
  // writes are dropped. The bridge's own writes go through the prototype.
  const scrollTopOf = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
  let ownScroll = null;
  const writeScroll = (top) => {
    const box = pagesBox();
    if (!box) return 0;
    scrollTopOf.set.call(box, Math.max(0, top));
    const now = scrollTopOf.get.call(box);
    ownScroll = { top: now, until: performance.now() + 200 };
    return now;
  };
  const guardScroll = (box) => {
    if (box.__mdraftGuarded) return;
    box.__mdraftGuarded = true;
    Object.defineProperty(box, "scrollTop", {
      configurable: true,
      get() {
        return scrollTopOf.get.call(this);
      },
      set() {
        /* the app's caret-follow; see above */
      },
    });
  };

  // ---------------------------------------------------------------------
  // Source positions on the page. A caret in the hidden editor makes the app
  // paint one `.cursor-mark.caret` box at the matching glyph, synchronously,
  // from the engine's own source map. Probing a line is therefore exact and
  // costs about half a millisecond; the boxes are hidden by the stylesheet and
  // the reader's own selection is put back after every probe.
  const positions = new Map();
  const pageTopInBox = (page, box) =>
    page.getBoundingClientRect().top - box.getBoundingClientRect().top + scrollTopOf.get.call(box);
  const probe = (line) => {
    if (positions.has(line)) return positions.get(line);
    const view = api().editor;
    const doc = view.state.doc;
    let y = null;
    if (line >= 1 && line <= doc.lines) {
      quietly(() => view.dispatch({ selection: { anchor: doc.line(line).from } }));
      const mark = document.querySelector("#pages .cursor-mark.caret");
      const page = mark?.closest(".page");
      const box = pagesBox();
      if (page && box) {
        const top = Number.parseFloat(mark.style.top);
        if (Number.isFinite(top)) y = pageTopInBox(page, box) + (top / 100) * page.offsetHeight;
      }
    }
    positions.set(line, y);
    return y;
  };
  /** The nearest typeset line from `line` towards `step`, within [lo, hi]. */
  const typeset = (line, step, lo, hi, budget = 60) => {
    for (let l = line, n = 0; l >= lo && l <= hi && n < budget; l += step, n += 1) {
      const y = probe(l);
      if (y !== null) return { line: l, y };
    }
    return null;
  };
  /** The y of a fractional source line, interpolated between typeset lines. */
  const yOfLine = (value) => {
    const lines = api().editor.state.doc.lines;
    const base = Math.max(1, Math.min(lines, Math.floor(value)));
    const before = typeset(base, -1, 1, lines) ?? typeset(base, 1, 1, lines);
    if (!before) return null;
    const after = typeset(before.line + 1, 1, before.line + 1, lines);
    if (!after || after.y < before.y) return before.y;
    const t = (value - before.line) / (after.line - before.line);
    return before.y + Math.max(0, Math.min(1, t)) * (after.y - before.y);
  };
  /** The fractional source line at `y`, by binary search over typeset lines. */
  let lastSelectionLine = null;
  const lineAtY = (y) => {
    const lines = api().editor.state.doc.lines;
    let lo = 1;
    let hi = lines;
    let below = null;
    let above = null;
    for (let guard = 0; lo <= hi && guard < 40; guard += 1) {
      const mid = (lo + hi) >> 1;
      const hit = typeset(mid, 1, mid, hi) ?? typeset(mid - 1, -1, lo, mid - 1);
      if (!hit) break;
      if (hit.y <= y) {
        below = hit;
        lo = Math.max(hit.line, mid) + 1;
      } else {
        above = hit;
        hi = Math.min(hit.line, mid) - 1;
      }
    }
    if (!below) return above ? above.line : lastSelectionLine;
    if (!above || above.y <= below.y) return below.line;
    return below.line + ((y - below.y) / (above.y - below.y)) * (above.line - below.line);
  };
  /** Run probes, then put back exactly the selection the reader's marks show. */
  const withProbes = (work) => {
    const view = api().editor;
    const { anchor, head } = view.state.selection.main;
    try {
      return work();
    } finally {
      const length = view.state.doc.length;
      quietly(() =>
        view.dispatch({
          selection: { anchor: Math.min(anchor, length), head: Math.min(head, length) },
        }),
      );
    }
  };

  // ---------------------------------------------------------------------
  // Marks: MDraft's selection and click conventions, in MDraft's colours (the
  // stylesheet restyles `.cursor-mark.selection` with the colours sent below).
  let blinkTimer = 0;
  const select = (file, from, to, blink) => {
    if (!ensureOpen(file)) {
      note(`select failed to open ${file}`);
      return;
    }
    // The app paints selection boxes only while its own `cursor` setting is on.
    // `init` sets it too, but this message can arrive before the setting sticks;
    // repeating it here costs nothing and keeps the marks from disappearing.
    try {
      api().settings.cursor = true;
    } catch {
      /* the app is being torn down */
    }
    const view = api().editor;
    const length = view.state.doc.length;
    // The reader's selection is on screen by definition; when the binary search
    // over typeset lines finds nothing in a sparse viewport, this is the line
    // the viewport is looking at.
    try {
      lastSelectionLine = view.state.doc.lineAt(Math.min(from, length)).number;
    } catch {
      lastSelectionLine = null;
    }
    quietly(() =>
      view.dispatch({ selection: { anchor: Math.min(from, length), head: Math.min(to, length) } }),
    );
    clearTimeout(blinkTimer);
    document.documentElement.toggleAttribute("data-mdraft-blink", blink);
    if (blink) blinkTimer = setTimeout(clearMarks, 620);
    // The app paints from the engine's source map on its own tick.
    setTimeout(
      () =>
        note(
          `select marks=${document.querySelectorAll("#pages .cursor-mark.selection").length} of=${document.querySelectorAll("#pages .cursor-mark").length}`,
        ),
      250,
    );
  };
  const clearMarks = () => {
    clearTimeout(blinkTimer);
    document.documentElement.removeAttribute("data-mdraft-blink");
    const view = api()?.editor;
    if (!view) return;
    quietly(() => view.dispatch({ selection: { anchor: view.state.selection.main.head } }));
  };

  // ---------------------------------------------------------------------
  // Project, edits and text. Every change is acknowledged with the length and
  // hash of what the frame now holds, so the host can see a divergence and
  // resend the whole file instead of trusting fixed waits.
  let editSeq = 0;
  // Typesetting one edit at a time. A dispatch into the hidden editor does not
  // make the app compile on its own, so the bridge asks; a request that arrives
  // during a compile is remembered and issued when that one finishes, which is
  // the latest-wins rule the host already applies per keystroke. The app also
  // compiles its own example project while the reader's project is arriving,
  // and refuses a second run with "Engine is already running": that answer
  // queues the request instead of losing it.
  let compileToken = 0;
  /**
   * Typeset now and report the paint once the pages are really there.
   *
   * `compile()` only accepts the run. The app's `idle()` returns at once rather
   * than waiting, and the worker's own `done` is not delivered to a listener
   * attached from outside the bundle in every run, so the paint is judged from
   * what the reader would see: the page canvases of `#pages`, stable for a
   * moment. A compile that draws nothing still reports, after its budget.
   */
  const requestCompile = () => {
    if (!api()?.compile) {
      note("compile unavailable");
      return;
    }
    note("compile asked");
    const token = ++compileToken;
    let tries = 0;
    const attempt = () => {
      if (token !== compileToken) return;
      tries += 1;
      Promise.resolve()
        .then(() => api().compile())
        .then(
          () => note(`compile accepted try=${tries}`),
          (error) => note(`compile refused: ${error?.message ?? error}`),
        );
      // The app refuses a run while it typesets its own example project, so a
      // request is retried until the first canvas appears; the watchdog gives
      // up after its budget and reports, so the host can fall back.
      const started = performance.now();
      const watch = () => {
        if (token !== compileToken) return;
        const canvases = document.querySelectorAll("#pages canvas").length;
        if (canvases > 0) {
          awaitStable(token, started);
          return;
        }
        if (performance.now() - started > 4000) {
          // The first run on a fresh profile rebuilds the engine's font cache
          // from the bundle; that is minutes, not milliseconds, so the budget
          // is generous and the host's own watchdog is the outer bound.
          if (tries < 75) {
            attempt();
            return;
          }
          note("paint timeout");
          painted(true);
          return;
        }
        setTimeout(watch, 100);
      };
      setTimeout(watch, 100);
    };
    attempt();
  };
  const scheduleCompile = () => requestCompile();
  /**
   * The first run after a project sync waits for the app to draw something.
   *
   * The app typesets an example project on start; asking for a compile during
   * that run merges into it and leaves the reader's project untypeset — and once
   * wedged, later requests are accepted and produce nothing. So the first
   * request waits for the frame's first canvas (bounded), which is the proof
   * that the engine's loop is alive.
   */
  let firstCompile = true;
  const scheduleFirstCompile = () => {
    if (!firstCompile) {
      requestCompile();
      return;
    }
    firstCompile = false;
    const started = performance.now();
    const tick = () => {
      if (document.querySelectorAll("#pages canvas").length > 0) {
        note("engine alive");
        requestCompile();
        return;
      }
      if (performance.now() - started > 15_000) {
        note("engine alive timeout");
        requestCompile();
        return;
      }
      setTimeout(tick, 250);
    };
    setTimeout(tick, 250);
  };
  /** Post the paint when `#pages` stops changing its canvas count. */
  const awaitStable = (token, started) => {
    let lastCount = -1;
    let stableSince = 0;
    const tick = () => {
      if (token !== compileToken) return;
      const pages = document.querySelectorAll("#pages .page").length;
      const canvases = document.querySelectorAll("#pages canvas").length;
      const now = performance.now();
      if (canvases === lastCount && canvases > 0) {
        if (now - stableSince >= 250) {
          note(`paint pages=${pages} canvases=${canvases} after=${Math.round(now - started)}`);
          painted(true);
          return;
        }
      } else {
        lastCount = canvases;
        stableSince = now;
      }
      setTimeout(tick, 100);
    };
    setTimeout(tick, 100);
  };
  const textNow = (file) => {
    const t = api();
    if (openName() === file) return t.editor.state.doc.toString();
    return null;
  };
  const acknowledge = (seq, file) => {
    const text = textNow(file);
    post({
      type: "ack",
      seq,
      file,
      length: text === null ? -1 : text.length,
      hash: text === null ? 0 : hash(text),
    });
  };
  const applyProject = async (message) => {
    const t = api();
    const known = new Set(t.project.paths());
    // The first sync replaces everything, including the example the app
    // creates for a new project.
    const keep = new Set(message.files.map((file) => file.path));
    const gone = message.replace ? [...known].filter((path) => !keep.has(path)) : message.remove;
    for (const path of gone) if (known.has(path)) t.project.remove(path);
    for (const file of message.files) {
      t.project.put(file.path, file.bytes ? new Uint8Array(file.bytes) : file.text);
    }
    if (message.main) t.project.setMain(message.main);
    t.project.flush?.();
    if (message.active) ensureOpen(message.active);
    positions.clear();
    if (message.files.length || gone.length || message.compile) {
      note(`project files=${message.files.length} compile=${message.compile} replace=${message.replace}`);
      editSeq = message.seq;
      busy(true);
      scheduleFirstCompile();
    } else {
      note("project no compile");
      editSeq = message.seq;
    }
    acknowledge(message.seq, message.active ?? message.main);
  };
  const applyEdit = (message) => {
    if (!ensureOpen(message.file)) return acknowledge(message.seq, message.file);
    const view = api().editor;
    if (view.state.doc.length !== message.base) return acknowledge(message.seq, message.file);
    const length = view.state.doc.length;
    const changes = [];
    for (const [from, to, insert] of message.changes) {
      if (from < 0 || to < from || to > length) return acknowledge(message.seq, message.file);
      changes.push({ from, to, insert });
    }
    quietly(() => view.dispatch({ changes }));
    positions.clear();
    editSeq = message.seq;
    busy(true);
    acknowledge(message.seq, message.file);
    scheduleCompile();
  };
  const applyText = (message) => {
    const t = api();
    if (openName() === message.file) quietly(() => t.setText(message.text));
    else t.project.put(message.file, message.text);
    positions.clear();
    editSeq = message.seq;
    busy(true);
    acknowledge(message.seq, message.file);
    scheduleCompile();
  };

  // ---------------------------------------------------------------------
  // Engine state. The paint is judged from `#pages` (see `awaitPages`); the
  // reading state only records what the status line says.
  let isBusy = false;
  const busy = (value) => {
    if (isBusy === value) return;
    isBusy = value;
    post({ type: "status", busy: value, problems: value ? null : problems() });
  };
  const problems = () => {
    try {
      return (api().problems() ?? []).slice(0, 200).map((p) => ({
        file: String(p.file ?? ""),
        line: Number(p.line) || 0,
        column: Number(p.column) || 0,
        severity: p.severity === "warning" ? "warning" : "error",
        message: String(p.message ?? ""),
      }));
    } catch {
      return [];
    }
  };
  const painted = (done) => {
    const seq = editSeq;
    positions.clear();
    note(`painted done=${done} seq=${seq} pages=${document.querySelectorAll("#pages .page").length}`);
    // The status does not wait for a paint: a hidden frame gets no animation
    // frames, and its problems are still the reader's.
    if (done) busy(false);
    // Two animation frames promise the pixels are in the canvas. A window that
    // is hidden, minimised or occluded gets no frames at all, so the report
    // would never arrive and the status would say "typesetting" forever; the
    // timer is the floor that keeps a throttled frame honest.
    let sent = false;
    const postNow = () => {
      if (sent) return;
      sent = true;
      positions.clear();
      post({ type: "painted", seq, done, pages: document.querySelectorAll("#pages .page").length });
    };
    requestAnimationFrame(() => requestAnimationFrame(postNow));
    setTimeout(postNow, 250);
  };
  // The engine reports its progress through `#pages`: the paint is judged from
  // the canvases that are actually on screen (`awaitPages`). The worker is not
  // observed directly, because a listener attached from outside the bundle does
  // not receive its messages in every run.

  // ---------------------------------------------------------------------
  // Zoom and theme.
  let zoom = 1;
  const applyZoom = (factor) => {
    zoom = factor;
    const preview = api().preview;
    const box = pagesBox();
    const ratio = box ? scrollTopOf.get.call(box) / Math.max(1, box.scrollHeight) : 0;
    preview.mode = "fit-width";
    if (Math.abs(factor - 1) > 0.001) {
      const fit = Number(preview.scale);
      if (fit > 0) preview.mode = String(fit * factor);
    }
    positions.clear();
    if (box) requestAnimationFrame(() => writeScroll(ratio * box.scrollHeight));
  };
  const applyTheme = (theme) => {
    const root = document.documentElement;
    root.dataset.theme = theme.dark ? "dark" : "light";
    root.style.setProperty("--mdraft-sync", theme.sync);
    root.style.setProperty("--mdraft-sync-peak", theme.peak);
    root.style.setProperty("--mdraft-paper", theme.paper);
    root.style.setProperty("--mdraft-pane", theme.pane);
  };

  // ---------------------------------------------------------------------
  // What the reader does inside the frame. Events here never reach MDraft's
  // window, so the ones MDraft's shortcuts and scroll ownership need are
  // forwarded; the rest stay with the page.
  let lastInput = 0;
  let clickDetail = 1;
  let reference = 24;
  const gesture = () => {
    lastInput = performance.now();
    post({ type: "input" });
  };
  const installInput = () => {
    for (const type of ["pointerdown", "touchstart", "keydown"])
      addEventListener(type, gesture, { capture: true, passive: true });
    addEventListener(
      "wheel",
      (event) => {
        if (event.ctrlKey || event.metaKey) {
          event.preventDefault();
          event.stopImmediatePropagation();
          post({ type: "zoom-wheel", deltaY: event.deltaY });
          return;
        }
        gesture();
      },
      { capture: true, passive: false },
    );
    addEventListener("contextmenu", (event) => event.preventDefault(), true);
    addEventListener(
      "keydown",
      (event) => {
        if (event.key === "Escape") post({ type: "key", key: "Escape" });
      },
      true,
    );
  };
  let viewportFrame = 0;
  const reportViewport = () => {
    viewportFrame = 0;
    const box = pagesBox();
    if (!box || !api()) return;
    const top = scrollTopOf.get.call(box);
    const own = ownScroll && performance.now() < ownScroll.until && Math.abs(ownScroll.top - top) <= 2;
    if (own) return;
    const line = withProbes(() => lineAtY(top + reference));
    note(`viewport line=${line === null ? "null" : Math.round(line)} file=${openName()}`);
    post({
      type: "viewport",
      scrollTop: top,
      file: openName(),
      line,
      gesture: performance.now() - lastInput < 800,
    });
  };
  const installScroll = (box) => {
    box.addEventListener(
      "scroll",
      () => {
        if (!viewportFrame) viewportFrame = requestAnimationFrame(reportViewport);
      },
      { passive: true },
    );
    new ResizeObserver(() => positions.clear()).observe(box);
  };
  // A click on a page makes the app resolve the point through the engine's
  // source map and select it in the hidden editor, after an asynchronous page
  // lookup. The selection that follows a pointer press on the pages is the
  // answer; any other selection change is the app's own bookkeeping.
  let pendingClick = 0;
  let clickY = null;
  const installClicks = () => {
    const box = pagesBox();
    const arm = (event) => {
      // The height that was clicked, below the pages' top edge: the same
      // coordinate `reveal` takes, so the host can level the source with it.
      clickY = event.clientY - box.getBoundingClientRect().top;
      clickDetail = event.type === "dblclick" ? 2 : event.detail || 1;
      pendingClick = performance.now();
      note(`click armed detail=${clickDetail} target=${event.target?.className ?? "?"}`);
    };
    box.addEventListener("mousedown", arm, true);
    box.addEventListener("dblclick", arm, true);
    const view = api().editor;
    const dispatch = view.dispatch.bind(view);
    view.dispatch = (...args) => {
      const result = dispatch(...args);
      if (internal === 0 && pendingClick && performance.now() - pendingClick < 1500) {
        const range = view.state.selection.main;
        if (clickDetail < 2 || range.to > range.from) pendingClick = 0;
        note(`source ${openName()} ${range.from}-${range.to} detail=${clickDetail}`);
        post({
          type: "source",
          file: openName(),
          from: range.from,
          to: range.to,
          detail: clickDetail,
          y: clickY,
        });
      }
      return result;
    };
  };

  // MDraft keeps the keyboard in its own editor. The hidden editor focuses
  // itself after some gestures, which would move the reader's typing into
  // this frame.
  const nativeFocus = HTMLElement.prototype.focus;
  HTMLElement.prototype.focus = function (...args) {
    if (this.closest?.("#source, #editor")) return;
    return nativeFocus.apply(this, args);
  };

  // ---------------------------------------------------------------------
  const handlers = {
    init(message) {
      const t = api();
      // Marks need the app's cursor display; its scrolling is dropped above.
      t.settings.cursor = true;
      t.settings.darkPages = false;
      reference = Number(message.reference) || reference;
      applyTheme(message.theme);
      applyZoom(message.zoom);
    },
    project: applyProject,
    edit: applyEdit,
    text: applyText,
    open(message) {
      ensureOpen(message.file);
    },
    select(message) {
      note(`select ${message.file} ${message.from}-${message.to} blink=${message.blink === true}`);
      select(message.file, message.from, message.to, message.blink === true);
    },
    clear: clearMarks,
    // The host's sync line moved without anything scrolling: a click levelled
    // the panes at another height, and `viewport` must report the line there.
    reference(message) {
      reference = Number(message.y) || reference;
    },
    reveal(message) {
      if (!ensureOpen(message.file)) return;
      reference = Number(message.y) || reference;
      const y = withProbes(() => yOfLine(message.line));
      const box = pagesBox();
      const max = box ? box.scrollHeight - box.clientHeight : 0;
      const top = y === null ? null : writeScroll(Math.min(max, y - message.y));
      post({ type: "scrolled", seq: message.seq, scrollTop: top });
    },
    zoom(message) {
      applyZoom(message.factor);
    },
    theme(message) {
      applyTheme(message.theme);
    },
    async export(message) {
      const started = performance.now();
      try {
        const out = await api().exportPdf({ download: false });
        const pdf = new Uint8Array(out.pdf);
        post({ type: "pdf", seq: message.seq, pdf: pdf.buffer, ms: performance.now() - started }, [
          pdf.buffer,
        ]);
      } catch (error) {
        post({ type: "error", seq: message.seq, message: String(error?.message ?? error) });
      }
    },
    dispose(message) {
      // The project held copies of the reader's files; the next start deletes
      // the database too (mdraft-boot.js), this removes them now.
      try {
        const t = api();
        for (const path of t.project.paths()) t.project.remove(path);
        t.project.flush?.();
      } catch {
        /* nothing left to remove */
      }
      post({ type: "disposed", seq: message.seq });
    },
  };

  addEventListener("message", (event) => {
    if (!HOST || event.source !== parent || event.origin !== HOST) return;
    const message = event.data;
    if (!message || typeof message !== "object" || message.v !== PROTOCOL) return;
    const handler = handlers[message.type];
    if (!handler || !api()) return;
    try {
      const pending = handler(message);
      if (pending?.catch)
        pending.catch((error) =>
          post({ type: "error", seq: message.seq, message: String(error?.message ?? error) }),
        );
    } catch (error) {
      post({ type: "error", seq: message.seq, message: String(error?.message ?? error) });
    }
  });

  // ---------------------------------------------------------------------
  const boot = () => {
    const t = api();
    const box = pagesBox();
    if (!t || !box) return false;
    const missing = REQUIRED.filter((name) => !(name in t));
    document.getElementById("welcome-dialog")?.close?.();
    t.setView?.("pdf");
    document.body.dataset.view = "pdf";
    guardScroll(box);
    installScroll(box);
    installInput();
    if (!missing.includes("editor")) installClicks();
    post({
      type: "ready",
      engine: params.get("engine") === "xetex" ? "xetex" : "luatex",
      jspi: typeof WebAssembly.Suspending === "function",
      missing,
    });
    return true;
  };
  const timer = setInterval(() => {
    if (boot()) clearInterval(timer);
  }, 25);
  setTimeout(() => clearInterval(timer), 60000);
})();
