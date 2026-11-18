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
  const ENGINE = params.get("engine") === "luatex" ? "luatex" : "xetex";
  // The renderer leaves out the text of a font it cannot load and says so only
  // on the console: `renderer: missing font file <name>.pfb` for a TeX font
  // with no Type 1 file, `renderer: missing native font …` for an OpenType
  // one. (Before release 0.2 this was every virtual font under XeLaTeX.) The app
  // calls `console.warn` by name at each use, so wrapping it before the
  // reader's project arrives sees every line; the names become problems.
  const missingFonts = new Set();
  let onMissingFont = () => {};
  try {
    const warn = console.warn;
    console.warn = function (...args) {
      try {
        const text = args.map(String).join(" ");
        const match = /^renderer: missing (font file|native font) (\S{1,200})/.exec(text);
        const name = match?.[2].replace(/\.pfb$/i, "");
        if (name && !missingFonts.has(name) && missingFonts.size < 50) {
          missingFonts.add(name);
          onMissingFont();
        }
      } catch {
        /* the console keeps working whatever the line holds */
      }
      return warn.apply(this, args);
    };
  } catch {
    /* without the wrapper a missing font goes unreported, as before */
  }
  const fontProblem = (name) => ({
    file: "",
    line: 0,
    column: 0,
    severity: "warning",
    message: `The preview cannot load the font ${name}. Text in it is blank in the preview.`,
  });
  // A local library file the engine loaded in place of TeX Live's copy. The
  // worker cannot post to this page directly (worker.js says why).
  try {
    new BroadcastChannel("mdraft-texmf").onmessage = (event) => {
      const name = event.data?.type === "override" ? event.data.name : null;
      if (typeof name === "string") post({ type: "library-override", name });
    };
  } catch {
    /* without the channel the override goes unreported, never unloaded */
  }
  // The worker fetches a manifest name and broadcasts the bytes here. The
  // main-thread renderer reads the project table, not the worker's, so the
  // bytes are pushed after the compile that fetched them and the project is
  // typeset once more; the next render then has every image and font.
  let projectPending = new Map();
  let projectFetchedSincePaint = false;
  const projectFonts = new Set();
  try {
    new BroadcastChannel("mdraft-project").onmessage = (event) => {
      const data = event.data;
      if (
        data?.type !== "fetched" ||
        typeof data.name !== "string" ||
        !(data.bytes instanceof Uint8Array)
      )
        return;
      projectPending.set(data.name, data.bytes);
      projectFetchedSincePaint = true;
      if (/\.(?:otf|ttf|ttc|otc|pfb)$/i.test(data.name)) projectFonts.add(data.name);
      post({ type: "project-fetched", name: data.name });
    };
  } catch {
    /* without the channel the renderer keeps the eager files only */
  }
  const api = () => globalThis.texpresso;
  const flushProjectFiles = () => {
    if (!projectPending.size) return false;
    const t = api();
    for (const [name, bytes] of projectPending) {
      t.project.put(name, bytes);
      // Windows resolves an image's case-insensitive spelling; the renderer
      // looks the document's literal name up on its own table. Keep the alias
      // only in the frame: the next project sync removes it.
      const lower = name.toLowerCase();
      if (lower !== name) t.project.put(lower, bytes);
    }
    t.project.flush?.();
    projectPending = new Map();
    return true;
  };
  /** Remove luaotfload's per-font cache entries for the project fonts we served. */
  const forgetProjectFonts = (names) => {
    if (!names.length) return;
    const norm = (value) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
    const wanted = names.map((name) =>
      norm((name.split("/").pop() ?? name).replace(/\.[^.]+$/, "")),
    );
    // Do not create the database: opening it just to delete a key would leave
    // an empty version-1 database the worker cannot upgrade.
    const open = () =>
      new Promise((resolve) => {
        const request = indexedDB.open("texpresso-luatex-caches", 1);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(null);
        request.onblocked = () => resolve(null);
      });
    const exists = () =>
      typeof indexedDB.databases === "function"
        ? indexedDB.databases().then(
            (list) => list.some((db) => db.name === "texpresso-luatex-caches"),
            () => false,
          )
        : Promise.resolve(false);
    void exists().then((there) => (there ? open() : null)).then((db) => {
      if (!db?.objectStoreNames.contains("files")) {
        db?.close();
        return;
      }
      try {
        const tx = db.transaction("files", "readwrite");
        const store = tx.objectStore("files");
        const keys = store.getAllKeys();
        keys.onsuccess = () => {
          let removed = 0;
          for (const key of keys.result) {
            const text = String(key).toLowerCase();
            if (!text.endsWith(".luc")) continue;
            const base = norm(text.split("/").pop().replace(/\.luc$/, ""));
            if (!wanted.some((name) => base === name || base.startsWith(name))) continue;
            store.delete(key);
            removed += 1;
          }
          if (removed) note("forgot project font caches=" + removed);
        };
        tx.oncomplete = () => db.close();
        tx.onerror = () => db.close();
      } catch {
        db.close();
      }
    });
  };
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
  // A compile step the reader should see in Logs as well: a long first run
  // otherwise shows a status line that never changes.
  const step = (what) => {
    note(what);
    post({ type: "trace", text: String(what).slice(0, 500) });
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
  // A followed link is the one write of the app's that is kept (see
  // `followLink`): until `linkScroll` passes, its first write goes through, and
  // `linkLanding` tells `reportViewport` that the reader did not scroll.
  let linkScroll = 0;
  let linkLanding = null;
  const guardScroll = (box) => {
    if (box.__mdraftGuarded) return;
    box.__mdraftGuarded = true;
    Object.defineProperty(box, "scrollTop", {
      configurable: true,
      get() {
        return scrollTopOf.get.call(this);
      },
      set(value) {
        // Otherwise the app's caret-follow; see above. A probe's caret is never a link's.
        if (internal !== 0 || performance.now() >= linkScroll) return;
        linkScroll = 0;
        scrollTopOf.set.call(this, Math.max(0, Number(value) || 0));
        linkLanding = { top: scrollTopOf.get.call(this), until: performance.now() + 400 };
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
      step("compile unavailable");
      return;
    }
    step("compile asked");
    const token = ++compileToken;
    let tries = 0;
    // Animation frames stop while the host is not drawing this frame (hidden
    // behind another view). Such a frame never creates its page canvases, so a
    // missing canvas then says nothing about an accepted run.
    let watching = true;
    let lastFrame = performance.now();
    const frameClock = () => {
      if (token !== compileToken || !watching) return;
      lastFrame = performance.now();
      requestAnimationFrame(frameClock);
    };
    requestAnimationFrame(frameClock);
    const attempt = () => {
      if (token !== compileToken) return;
      tries += 1;
      let refused = false;
      Promise.resolve()
        .then(() => api().compile())
        .then(
          () => step(`compile accepted try=${tries}`),
          (error) => {
            refused = true;
            step(`compile refused: ${error?.message ?? error}`);
          },
        );
      // The app refuses a run while it typesets its own example project, so a
      // request is retried until the first canvas appears; the watchdog gives
      // up after its budget and reports, so the host can fall back.
      let started = performance.now();
      const watch = () => {
        if (token !== compileToken) return;
        const canvases = document.querySelectorAll("#pages canvas").length;
        if (canvases > 0) {
          watching = false;
          awaitStable(token, started);
          return;
        }
        if (performance.now() - started > 4000) {
          // Asking again restarts an accepted run, so an undrawn frame waits
          // for frames instead of spending a try.
          if (!refused && performance.now() - lastFrame > 1000) {
            started = performance.now();
            setTimeout(watch, 100);
            return;
          }
          // The first run on a fresh profile rebuilds the engine's font cache
          // from the bundle; that is minutes, not milliseconds, so the budget
          // is generous and the host's own watchdog is the outer bound.
          if (tries < 75) {
            attempt();
            return;
          }
          watching = false;
          step("paint timeout");
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
        step("engine alive");
        requestCompile();
        return;
      }
      if (performance.now() - started > 15_000) {
        step("engine alive timeout");
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
          step(`paint pages=${pages} canvases=${canvases} after=${Math.round(now - started)}`);
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
    if (message.replace) {
      projectPending = new Map();
      projectFetchedSincePaint = false;
    }
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
      step(`project files=${message.files.length} compile=${message.compile} replace=${message.replace}`);
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
    const fonts = [...missingFonts].map(fontProblem);
    try {
      return (api().problems() ?? [])
        .slice(0, 200)
        .map((p) => ({
          file: String(p.file ?? ""),
          line: Number(p.line) || 0,
          column: Number(p.column) || 0,
          severity: p.severity === "warning" ? "warning" : "error",
          message: String(p.message ?? ""),
        }))
        .concat(fonts);
    } catch {
      return fonts;
    }
  };
  // A font is first drawn, and found missing, after the paint that cleared
  // `busy`; the host's problem list must still hear of it before its export.
  onMissingFont = () => {
    if (!isBusy) post({ type: "status", busy: false, problems: problems() });
  };
  /**
   * The app's own verdict on the run an export just converted. When the worker
   * gives up (out of memory, after its one restart from scratch) the status
   * reads `Failed after N ms: <reason>`, and the export still returns the pages
   * typeset before that; nothing else tells them from a finished document. The
   * title can precede the end of the `busy` state by about 1.5 s, so the answer
   * waits for it, bounded. Errors in the document are not this: they read
   * `… with errors: …` or `Stopped after …` and are the problem list's.
   */
  const engineVerdict = async () => {
    const status = document.getElementById("status");
    if (!status) {
      note("no #status: an engine failure cannot be reported");
      return null;
    }
    const failed = () => status.title.startsWith("Failed after ");
    const deadline = performance.now() + 3000;
    while (!failed() && status.classList.contains("busy") && performance.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const match = /^Failed after [^:]*: ([\s\S]+)$/.exec(status.title);
    if (!match) return null;
    const message = match[1].trim().slice(0, 200);
    return {
      reason: /out of memory/i.test(message) ? "memory" : "engine",
      message,
      pages: document.querySelectorAll("#pages .page").length,
    };
  };
  const painted = (done) => {
    const seq = editSeq;
    positions.clear();
    step(`painted done=${done} seq=${seq} pages=${document.querySelectorAll("#pages .page").length}`);
    // The status does not wait for a paint: a hidden frame gets no animation
    // frames, and its problems are still the reader's.
    if (done) busy(false);
    if (done) {
      if (flushProjectFiles() || projectFetchedSincePaint) {
        projectFetchedSincePaint = false;
        step("project files fetched; typesetting again");
        scheduleCompile();
      } else if (projectFonts.size) {
        forgetProjectFonts([...projectFonts]);
      }
    }
    if (zoomPending && api()) applyZoom(zoom);
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
  // The zoom was applied before any page had a size, so its fit-width base was
  // unknown; the first paint applies it again.
  let zoomPending = false;
  let zoomWidth = -1;
  /**
   * Set the app's zoom mode and lay the pages out.
   *
   * `preview.mode` only stores the mode in the pinned release: nothing is laid
   * out until a compile changes a page size. The layout runs from the app's own
   * zoom control, so the mode goes through it, as a reader's choice would. A
   * custom scale is not among its options and gets one for the moment.
   */
  const setMode = (value) => {
    const select = document.getElementById("zoom");
    if (!select) {
      api().preview.mode = value;
      return false;
    }
    let added = null;
    if (![...select.options].some((option) => option.value === value)) {
      added = new Option(value, value);
      added.hidden = true;
      select.add(added);
    }
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
    added?.remove();
    return true;
  };
  const applyZoom = (factor) => {
    zoom = factor;
    const preview = api().preview;
    const box = pagesBox();
    const ratio = box ? scrollTopOf.get.call(box) / Math.max(1, box.scrollHeight) : 0;
    const sized = (document.querySelector("#pages .page")?.offsetWidth ?? 0) > 0;
    const custom = Math.abs(factor - 1) > 0.001;
    zoomPending = custom && !sized;
    zoomWidth = box ? box.clientWidth : -1;
    // Fit-width first: the layout it runs makes `preview.scale` the real fit,
    // the base the document zoom multiplies.
    const laidOut = setMode("fit-width");
    if (custom && sized) {
      const fit = Number(preview.scale);
      if (fit > 0) {
        const target = Math.min(8, Math.max(0.1, fit * factor));
        setMode(String(target));
        const now = Number(preview.scale);
        if (!laidOut || !(Math.abs(now - target) <= target * 0.01)) {
          // The pinned app changed: say so instead of leaving a dead zoom.
          note(`zoom not applied scale=${now} target=${target}`);
          post({ type: "error", message: "The preview did not apply the document zoom." });
        }
      }
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
  const gesture = (event) => {
    lastInput = performance.now();
    // The reader scrolls or types: a link still on its way must not yank the
    // pages. A press may be the second half of the double-click that followed it.
    if (event?.type !== "pointerdown") linkScroll = 0;
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
    // A followed link leaves the source where it is, as a link in the PDF view does.
    const landed =
      linkLanding && performance.now() < linkLanding.until && Math.abs(linkLanding.top - top) <= 2;
    if (landed) linkLanding = null;
    note(`viewport line=${line === null ? "null" : Math.round(line)} file=${openName()}`);
    post({
      type: "viewport",
      scrollTop: top,
      file: openName(),
      line,
      gesture: !landed && performance.now() - lastInput < 800,
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
    new ResizeObserver(() => {
      positions.clear();
      // A custom scale is absolute, and the app refits only in a fit mode: the
      // document zoom is relative to the pane, so a new width applies it again.
      if (Math.abs(zoom - 1) > 0.001 && box.clientWidth !== zoomWidth && api()) applyZoom(zoom);
    }).observe(box);
  };
  // A click on a page makes the app resolve the point through the engine's
  // source map and select it in the hidden editor, after an asynchronous page
  // lookup. The selection that follows a pointer press on the pages is the
  // answer; any other selection change is the app's own bookkeeping.
  let pendingClick = 0;
  let clickY = null;
  // The pressed point in the viewport, for `resolveClick`.
  let clickPoint = null;
  // The primary button is down on the pages, and the app has selected a range
  // since: a drag, which the app turns into a source selection as it moves.
  let down = false;
  let dragged = false;

  /** The app's caret box for a source offset, in viewport pixels, or null. */
  const caretBox = (offset) => {
    const view = api().editor;
    quietly(() => view.dispatch({ selection: { anchor: offset } }));
    const mark = document.querySelector("#pages .cursor-mark.caret");
    const page = mark?.closest(".page");
    if (!page) return null;
    const rect = page.getBoundingClientRect();
    const part = (value) => Number.parseFloat(value) / 100;
    const left = part(mark.style.left);
    const top = part(mark.style.top);
    const height = part(mark.style.height);
    if (!Number.isFinite(left) || !Number.isFinite(top)) return null;
    const y = rect.top + top * rect.height;
    const h = Number.isFinite(height) ? height * rect.height : 0;
    return { x: rect.left + left * rect.width, top: y, bottom: y + h, height: h };
  };
  const CLICK_PROBES = 96;
  const WORD = /[\p{L}\p{N}]+/gu;
  /**
   * The source offset under a clicked point, verified against the page.
   *
   * The app answers a click with a line and a column. For text that TeX set as
   * written the column is the clicked character; for text a macro produced, or
   * a paragraph the engine attributes to its first line, it is only nearby. So
   * the answer is mapped forward again (`caretBox`, about half a millisecond)
   * and compared with the pixel that was clicked:
   *
   * 1. the answer's own box, walked along its row towards the pointer;
   * 2. failing that, the word boundaries of the answered line and its two
   *    neighbours on each side: the one on the clicked row nearest the pointer,
   *    walked the same way.
   *
   * "exact" needs a box on the clicked row within one row height of the
   * pointer. "line" is the answered line when it is typeset at all; "none" is
   * a position nothing confirms. The probes are capped, so a hostile document
   * costs a bounded time (a correct answer costs a handful).
   */
  const resolveClick = (answer, point) => {
    const view = api().editor;
    const doc = view.state.doc;
    if (!point || answer < 0 || answer > doc.length)
      return { offset: answer, precision: "none", probes: 0 };
    return withProbes(() => {
      const seen = new Map();
      const boxAt = (offset) => {
        if (seen.has(offset)) return seen.get(offset);
        if (seen.size >= CLICK_PROBES) return null;
        const box = caretBox(offset);
        seen.set(offset, box);
        return box;
      };
      // The horizontal miss of a box on the clicked row; Infinity off the row.
      const miss = (box) => {
        if (!box) return Infinity;
        const slack = Math.max(3, box.height * 0.35);
        if (point.y < box.top - slack || point.y > box.bottom + slack) return Infinity;
        return Math.abs(box.x - point.x);
      };
      /** Walk from `start` along its source line while the miss shrinks. */
      const walk = (start) => {
        const line = doc.lineAt(start);
        let at = start;
        let best = miss(boxAt(at));
        if (best === Infinity) return { at, best };
        const step = boxAt(at).x < point.x ? 1 : -1;
        for (let next = at + step; next >= line.from && next <= line.to; next += step) {
          const m = miss(boxAt(next));
          // A macro argument can have no box of its own: look past a short gap.
          if (m === Infinity && Math.abs(next - at) < 4) continue;
          if (m >= best) break;
          at = next;
          best = m;
        }
        return { at, best };
      };
      const accept = (hit) => hit.best <= Math.max(6, seen.get(hit.at)?.height ?? 0);
      let hit = walk(answer);
      if (!accept(hit)) {
        const home = doc.lineAt(answer).number;
        let nearest = { at: answer, best: Infinity };
        for (const delta of [0, -1, 1, -2, 2]) {
          const number = home + delta;
          if (number < 1 || number > doc.lines) continue;
          const line = doc.line(number);
          for (const match of line.text.matchAll(WORD)) {
            for (const at of [line.from + match.index, line.from + match.index + match[0].length]) {
              const m = miss(boxAt(at));
              if (m < nearest.best) nearest = { at, best: m };
            }
          }
        }
        if (nearest.best < hit.best) hit = walk(nearest.at);
      }
      if (accept(hit)) return { offset: hit.at, precision: "exact", probes: seen.size };
      const line = doc.lineAt(answer);
      const typeset =
        [...seen].some(([offset, box]) => box && offset >= line.from && offset <= line.to) ||
        caretBox(line.from) !== null;
      return { offset: answer, precision: typeset ? "line" : "none", probes: seen.size };
    });
  };

  const installClicks = () => {
    const box = pagesBox();
    const arm = (event) => {
      // The double-click `followLink` replays is the app's link, not a lookup.
      if (replaying) return;
      // `dblclick` fires after the second press, which may already have brought
      // the word. Arming again would forward whatever the engine selects next
      // (its caret, settling) as a second answer that replaces the word.
      if (event.type === "dblclick" && !pendingClick) return;
      // The height that was clicked, below the pages' top edge: the same
      // coordinate `reveal` takes, so the host can level the source with it.
      clickY = event.clientY - box.getBoundingClientRect().top;
      clickPoint = { x: event.clientX, y: event.clientY };
      clickDetail = event.type === "dblclick" ? 2 : event.detail || 1;
      pendingClick = performance.now();
      if (event.type === "mousedown") {
        down = event.button === 0;
        dragged = false;
      }
      note(`click armed detail=${clickDetail} target=${event.target?.className ?? "?"}`);
    };
    box.addEventListener("mousedown", arm, true);
    box.addEventListener("dblclick", arm, true);
    const view = api().editor;
    const send = (from, to, extra) =>
      post({
        type: "source",
        file: openName(),
        from,
        to,
        detail: clickDetail,
        y: clickY,
        drag: false,
        precision: "none",
        ...extra,
      });
    // The release ends a drag: the range it left is sent once more as the final
    // one, without a height, because the pressed row is not where it ended.
    addEventListener(
      "mouseup",
      () => {
        const range = view.state.selection.main;
        if (down && dragged && range.to > range.from) {
          note(`source ${openName()} ${range.from}-${range.to} drag end`);
          send(range.from, range.to, { y: null });
        }
        down = false;
        dragged = false;
      },
      true,
    );
    const dispatch = view.dispatch.bind(view);
    view.dispatch = (...args) => {
      const result = dispatch(...args);
      if (internal !== 0) return result;
      const range = view.state.selection.main;
      if (down && clickDetail < 2 && range.to > range.from) {
        // Every step of a drag, however long it lasts.
        dragged = true;
        pendingClick = 0;
        send(range.from, range.to, { drag: true, y: null });
        return result;
      }
      if (pendingClick && performance.now() - pendingClick < 1500) {
        // A double-click's answer is the word it names. A caret that arrives
        // meanwhile (the first press's late lookup, or the engine collapsing
        // its selection) is not an answer: sent, the host marks its paragraph.
        if (clickDetail >= 2 && range.to === range.from) return result;
        pendingClick = 0;
        if (clickDetail < 2 && range.to === range.from) {
          const started = performance.now();
          const hit = resolveClick(range.head, clickPoint);
          note(
            `source ${openName()} ${range.head}->${hit.offset} ${hit.precision} probes=${hit.probes} ms=${Math.round(performance.now() - started)}`,
          );
          send(hit.offset, hit.offset, { precision: hit.precision });
        } else {
          note(`source ${openName()} ${range.from}-${range.to} detail=${clickDetail}`);
          send(range.from, range.to, {});
        }
      }
      return result;
    };
  };

  // ---------------------------------------------------------------------
  // Links. The app follows a link only on a double-click, and both of its ways
  // out are closed in MDraft: a destination writes `#pages.scrollTop`, which the
  // guard above drops, and a web address calls `window.open`, which the main
  // window refuses. A single click on a link was therefore one more source
  // lookup. As in the PDF view, a press on a link now belongs to the link: the
  // source map never sees it, the app follows a destination with its one scroll
  // let through, and a web address goes to the host, which vets it and hands it
  // to the system.
  const LINK_SCROLL_MS = 3000;
  let linkPress = null;
  let replaying = false;
  /** The followable link under a viewport point, `{ uri }` or `{ dest }`, or null. */
  const linkAt = (x, y) => {
    try {
      const action = api()?.preview?.linkAt?.(x, y)?.action;
      return action && typeof action === "object" && ("uri" in action || "dest" in action)
        ? action
        : null;
    } catch {
      return null;
    }
  };
  const sameLink = (a, b) =>
    Boolean(a && b) &&
    String(a.uri ?? "") === String(b.uri ?? "") &&
    String(a.dest ?? "") === String(b.dest ?? "");
  const followLink = (action, x, y) => {
    if ("uri" in action) {
      note("link uri");
      post({ type: "link", uri: String(action.uri) });
      return;
    }
    // Only the app knows where a destination is, and its own double-click
    // follows one. The replay reaches the app's handler on the pages; `arm` and
    // the capture below let it pass.
    const box = pagesBox();
    if (!box) return;
    const at = document.elementFromPoint(x, y);
    note("link dest");
    linkScroll = performance.now() + LINK_SCROLL_MS;
    replaying = true;
    try {
      (at && box.contains(at) ? at : box).dispatchEvent(
        new MouseEvent("dblclick", {
          bubbles: true,
          cancelable: true,
          view: window,
          detail: 2,
          clientX: x,
          clientY: y,
        }),
      );
    } finally {
      replaying = false;
    }
  };
  const installLinks = () => {
    addEventListener(
      "pointerdown",
      (event) => {
        linkPress = null;
        if (event.button !== 0 || !event.isPrimary) return;
        const action = linkAt(event.clientX, event.clientY);
        if (!action) return;
        linkPress = action;
        // The app starts its source lookup from this press on the pages, and a
        // cancelled press sends no `mousedown` for `arm`.
        event.stopPropagation();
        event.preventDefault();
      },
      true,
    );
    addEventListener(
      "mousedown",
      (event) => {
        if (linkPress) event.stopPropagation();
      },
      true,
    );
    addEventListener(
      "click",
      (event) => {
        const press = linkPress;
        linkPress = null;
        if (!press) return;
        event.stopPropagation();
        event.preventDefault();
        // The second click of a double-click: the first one followed the link.
        if (event.detail > 1) return;
        // A press released off its link follows nothing.
        const action = linkAt(event.clientX, event.clientY);
        if (sameLink(action, press)) followLink(action, event.clientX, event.clientY);
      },
      true,
    );
    // The app's own double-click would follow the link again, its own way, and
    // `arm` would wait for a source answer.
    addEventListener(
      "dblclick",
      (event) => {
        if (replaying || !linkAt(event.clientX, event.clientY)) return;
        event.stopPropagation();
        event.preventDefault();
      },
      true,
    );
    // The app titles a link "… (double-click to open)" or "Double-click to
    // follow". One click follows it here, so the title is the PDF view's: the
    // address of a web link, nothing for a destination. This runs after the
    // app's own handler on the pages, which leaves the title empty off a link.
    addEventListener("mousemove", (event) => {
      const box = pagesBox();
      if (!box?.title) return;
      const action = linkAt(event.clientX, event.clientY);
      if (action) box.title = "uri" in action ? String(action.uri) : "";
    });
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
        const ms = performance.now() - started;
        const failure = await engineVerdict();
        if (failure) step(`engine failed: ${failure.message} pages=${failure.pages}`);
        post(
          { type: "pdf", seq: message.seq, pdf: pdf.buffer, ms, ...(failure ? { failure } : {}) },
          [pdf.buffer],
        );
      } catch (error) {
        post({ type: "error", seq: message.seq, message: String(error?.message ?? error) });
      }
    },
    dispose(message) {
      // The project held copies of the reader's files; the next start deletes
      // the database too (mdraft-boot.js), this removes them now.
      projectPending = new Map();
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
    installLinks();
    post({
      type: "ready",
      engine: ENGINE,
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
