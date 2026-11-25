//! The guest-side bridge for the HTML preview.
//!
//! This file is inlined into the preview copy of the document, not imported by
//! the application bundle. It runs inside the sandboxed iframe, has no access to
//! the Tauri API (the frame's origin is opaque and its URL host is not a local
//! Tauri origin), and talks to the editor only through `postMessage`.
//!
//! The token below is per render. It is not a secret — the document can read its
//! own bridge — so every message is treated as untrusted by the parent. It only
//! stops a stale frame from driving a newer preview.

(function () {
  "use strict";

  if (window.parent === window) return;

  // F5 and Ctrl+R are WebView2 browser accelerators: a reload here discards the
  // whole application state, unsaved tabs included, with no prompt. The parent
  // document swallows them, but a key pressed while this frame has focus never
  // reaches the parent, so the same rule is installed inside the guest. Only
  // the reload family is touched; editing keys belong to the document.
  window.addEventListener(
    "keydown",
    function (event) {
      var reload =
        event.key === "F5" ||
        ((event.ctrlKey || event.metaKey) &&
          (event.code === "KeyR" || String(event.key).toLowerCase() === "r"));
      if (!reload) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    },
    true,
  );

  var TOKEN = "__MDRAFT_TOKEN__";
  var INITIAL_SCROLL = "__MDRAFT_SCROLL__";
  var initialScrollTarget =
    INITIAL_SCROLL !== "" && isFinite(Number(INITIAL_SCROLL))
      ? Math.max(0, Number(INITIAL_SCROLL))
      : null;
  var BLINK_MS = 620;
  var SYNC_MARGIN = 12;
  // Where the host's sync line crosses this viewport. It is SYNC_MARGIN until a
  // pointer gesture levels the panes at another height; the host says where.
  var probeY = SYNC_MARGIN;
  var SYMBOLS = {
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

  /* __MDRAFT_ALIGN__ */

  var IGNORED_TEXT = "script,style,textarea,title,template,svg,math,noscript";
  // Output of the document's own math renderer (MathJax 2/3, KaTeX). It is not
  // counted as structure, so the elements around it keep their ordinals.
  var RENDERED =
    'mjx-container,[class^="MathJax"],[class*=" MathJax"],[class^="katex"],[class*=" katex"]';
  var UNCOUNTED = { script: true, style: true, template: true, noscript: true };
  var OPAQUE = { svg: true, math: true, textarea: true, title: true };

  // The host's original text table, per stamp: `originalTexts[n][i]` is the
  // stamp's i-th text node as parse5 saw it, `originalParents[n][i]` its parent
  // ordinal. Null until the host sends it (or when it was too large to send);
  // then the guest's own text-node positions are the identities.
  var originalTexts = null;
  var originalParents = null;
  var alignments = new WeakMap();

  // The document's reveal.js deck once it is ready (see "Paged decks").
  var deck = null;
  var deckWatched = false;
  var deckSteering = false;
  var pendingLine = null;

  var anchors = [];
  var keys = [];
  var layoutQueued = false;
  var scrollQueued = false;
  var readySent = false;
  var blinkTimer = 0;
  var blinking = null;
  var layoutEpoch = 0;
  var scrollInput = 0;
  var scrollDragging = false;
  var ownScrollTarget = null;
  var ownScrollUntil = 0;
  var pendingInitialScroll = initialScrollTarget;

  // Scroll instantaneously even when the document sets `scroll-behavior: smooth`,
  // and mark the resulting scroll as host-driven until genuine user input arrives
  // so CSS `scroll-snap` or `overflow-anchor` adjustments do not echo back.
  function instantScrollTo(top) {
    var target = Math.max(0, top);
    var before = window.scrollY;
    window.scrollTo({ left: 0, top: target, behavior: "instant" });
    var after = window.scrollY;
    if (Math.abs(after - before) >= 0.5) {
      ownScrollTarget = after;
      ownScrollUntil = performance.now() + 150;
    }
  }

  // Viewport-pinned (`fixed`/`sticky`) and hidden subtrees do not name a
  // readable flow position. Memoised per scan to keep layout reads O(nodes).
  function isExcludedAnchor(element, cache) {
    var chain = [];
    var excluded = false;
    for (var node = element; node && node.nodeType === 1; node = node.parentElement) {
      var known = cache ? cache.get(node) : undefined;
      if (known !== undefined) {
        excluded = known;
        break;
      }
      chain.push(node);
      var style = window.getComputedStyle(node);
      if (
        style.position === "fixed" ||
        style.position === "sticky" ||
        style.visibility === "hidden" ||
        style.visibility === "collapse"
      ) {
        excluded = true;
        break;
      }
    }
    if (cache) {
      for (var j = 0; j < chain.length; j += 1) cache.set(chain[j], excluded);
    }
    return excluded;
  }

  function post(message) {
    message.__mdraft = TOKEN;
    try {
      window.parent.postMessage(message, "*");
    } catch (error) {
      /* the preview is going away */
    }
  }

  function scanAnchors() {
    var found = [];
    var nodes = document.querySelectorAll("[data-mdraft-line]");
    // A deck lays every slide over the same viewport, and the slides around
    // the present one still have boxes, transformed far off screen. Only the
    // slide on screen has positions worth reporting.
    var slide = deck ? deck.getCurrentSlide() : null;
    var excludedCache = slide ? null : new WeakMap();
    for (var i = 0; i < nodes.length; i += 1) {
      var element = nodes[i];
      if (slide && !slide.contains(element)) continue;
      if (!slide && isExcludedAnchor(element, excludedCache)) continue;
      var line = parseInt(element.getAttribute("data-mdraft-line"), 10);
      if (!isFinite(line)) continue;
      var rect = element.getBoundingClientRect();
      // Hidden elements and 1x1 screen-reader helpers (`.sr-only`,
      // `.visually-hidden`) have no visible flow box to synchronise against.
      if (rect.width <= 1 && rect.height <= 1) continue;
      found.push({ line: line, top: rect.top + window.scrollY, element: element });
    }
    found.sort(function (left, right) {
      return left.line - right.line || left.top - right.top;
    });
    anchors = found;
  }

  function metrics() {
    return {
      top: window.scrollY,
      height: Math.max(
        document.documentElement ? document.documentElement.scrollHeight : 0,
        document.body ? document.body.scrollHeight : 0,
      ),
      client: window.innerHeight,
      line: deck ? deckLine() : lineAtTop(),
      paged: deckPage(),
    };
  }

  function lineAtTop() {
    if (anchors.length === 0) return 1;
    var y = window.scrollY + SYNC_MARGIN;
    var line = anchors[0].line;
    var bestTop = -Infinity;
    for (var i = 0; i < anchors.length; i += 1) {
      var top = anchors[i].top;
      if (top <= y + 1 && top >= bestTop) {
        bestTop = top;
        line = anchors[i].line;
      }
    }
    return line;
  }

  function publicAnchors() {
    return anchors.map(function (anchor) {
      return { line: anchor.line, top: anchor.top };
    });
  }

  function layout() {
    layoutEpoch += 1;
    scanAnchors();
    var state = metrics();
    post({
      type: "layout",
      anchors: publicAnchors(),
      epoch: layoutEpoch,
      top: state.top,
      height: state.height,
      client: state.client,
      line: state.line,
      paged: state.paged,
    });
  }

  function queueLayout() {
    if (layoutQueued) return;
    layoutQueued = true;
    window.requestAnimationFrame(function () {
      layoutQueued = false;
      layout();
    });
  }

  function queueScroll() {
    if (scrollQueued) return;
    scrollQueued = true;
    window.requestAnimationFrame(function () {
      scrollQueued = false;
      var state = metrics();
      var own =
        (ownScrollTarget !== null && Math.abs(state.top - ownScrollTarget) <= 1) ||
        performance.now() < ownScrollUntil;
      ownScrollTarget = null;
      post({
        type: "scroll",
        own: own,
        top: state.top,
        height: state.height,
        client: state.client,
        line: state.line,
        paged: state.paged,
        epoch: layoutEpoch,
        probe: scrollDragging ? null : scrollProbe(),
      });
    });
  }

  function anchorForLine(line) {
    if (anchors.length === 0) return null;
    var found = null;
    for (var i = 0; i < anchors.length; i += 1) {
      if (anchors[i].line <= line) found = anchors[i];
      else break;
    }
    return found || anchors[0];
  }

  // -------------------------------------------------------------------------
  // Paged decks (reveal.js)
  //
  // A deck does not scroll: every slide is laid over one viewport and the
  // reader moves between them. Following the source therefore means changing
  // slide, through the deck's own API, and a slide change in the guest is
  // reported to the host as a line. Only the document's global `Reveal` (the
  // build reveal.js, Quarto and pandoc load) is recognised.
  // -------------------------------------------------------------------------

  function revealApi() {
    var api = window.Reveal;
    if (!api || (typeof api !== "object" && typeof api !== "function")) return null;
    var needed = ["getIndices", "slide", "on", "isReady", "getCurrentSlide"];
    for (var i = 0; i < needed.length; i += 1) {
      if (typeof api[needed[i]] !== "function") return null;
    }
    return api;
  }

  function watchDeck() {
    var api = revealApi();
    if (!api || deckWatched) return;
    deckWatched = true;
    var start = function () {
      if (deck) return;
      deck = api;
      api.on("slidechanged", pageChanged);
      api.on("fragmentshown", pageChanged);
      api.on("fragmenthidden", pageChanged);
      if (pendingLine !== null) goToLine(pendingLine);
      pendingLine = null;
      layout();
    };
    try {
      if (api.isReady()) start();
      else api.on("ready", start);
    } catch (error) {
      /* not the deck API after all */
    }
  }

  function deckPage() {
    if (!deck) return null;
    var at = deck.getIndices();
    return {
      h: at.h | 0,
      v: at.v | 0,
      f: typeof at.f === "number" && isFinite(at.f) ? at.f : -1,
    };
  }

  function lineOf(element) {
    var stamped = element && element.closest ? element.closest("[data-mdraft-line]") : null;
    var line = stamped ? parseInt(stamped.getAttribute("data-mdraft-line"), 10) : NaN;
    return isFinite(line) ? line : null;
  }

  // The line the reader is looking at: the fragment just shown, else the slide.
  function deckLine() {
    var slide = deck.getCurrentSlide();
    if (!slide) return 1;
    var fragment = slide.querySelector(".current-fragment");
    return lineOf(fragment) || lineOf(slide) || 1;
  }

  function pageChanged() {
    if (deck.isOverview && deck.isOverview()) return;
    // Recomputed now: the anchors belong to the slide that was left.
    layout();
    post({ type: "page", line: deckLine(), own: deckSteering, paged: deckPage() });
  }

  /** The innermost slide holding `element`; a stack stands for its first slide. */
  function slideOf(element) {
    var slide = element.closest(".reveal .slides section");
    if (!slide) return null;
    var first = slide.querySelector(":scope > section");
    return first || slide;
  }

  // Show `element`: its slide, and its fragment if it is one the reader has
  // not reached yet. Fragments already shown are never hidden again, and the
  // present slide is left alone when it already shows the element.
  function showInDeck(element) {
    var slide = element ? slideOf(element) : null;
    if (!slide) return;
    var target = deck.getIndices(slide);
    var now = deck.getIndices();
    var fragment = element.closest(".fragment");
    var index =
      fragment && slide.contains(fragment)
        ? parseInt(fragment.getAttribute("data-fragment-index"), 10)
        : NaN;
    var same = (target.h | 0) === (now.h | 0) && (target.v | 0) === (now.v | 0);
    var shown = typeof now.f === "number" ? now.f : -1;
    if (same && (!isFinite(index) || shown >= index)) return;
    // The deck reports this change synchronously; it is the host's own.
    deckSteering = true;
    try {
      deck.slide(target.h | 0, target.v | 0, isFinite(index) ? index : undefined);
    } finally {
      deckSteering = false;
    }
  }

  // The last stamped element at or before `line`, wherever it is in the deck.
  function goToLine(line) {
    if (!isFinite(line)) return;
    var nodes = document.querySelectorAll(".reveal .slides [data-mdraft-line]");
    var best = null;
    var bestLine = -1;
    for (var i = 0; i < nodes.length; i += 1) {
      var value = parseInt(nodes[i].getAttribute("data-mdraft-line"), 10);
      if (isFinite(value) && value <= line && value >= bestLine) {
        best = nodes[i];
        bestLine = value;
      }
    }
    if (!best && nodes.length) best = nodes[0];
    showInDeck(best);
  }

  function blink(line) {
    var anchor = anchorForLine(line);
    if (!anchor) return;
    if (blinking && blinking !== anchor.element) {
      blinking.classList.remove("mdraft-blink");
    }
    window.clearTimeout(blinkTimer);
    blinking = anchor.element;
    blinking.classList.remove("mdraft-blink");
    // Reflow so clicking the same block twice replays the transition.
    void blinking.offsetWidth;
    blinking.classList.add("mdraft-blink");
    blinkTimer = window.setTimeout(function () {
      if (blinking) blinking.classList.remove("mdraft-blink");
      blinking = null;
    }, BLINK_MS);
  }

  function keyNames(event) {
    var names = [];
    if (event.key && event.key !== "Unidentified") names.push(event.key.toUpperCase());
    var code = event.code || "";
    if (code.indexOf("Key") === 0) names.push(code.slice(3));
    else if (code.indexOf("Digit") === 0) names.push(code.slice(5));
    else if (SYMBOLS[code]) names.push(SYMBOLS[code]);
    return names;
  }

  function acceleratorFor(event) {
    var names = keyNames(event);
    for (var i = 0; i < keys.length; i += 1) {
      var key = keys[i];
      if (
        event.ctrlKey !== !!key.ctrl ||
        event.altKey !== !!key.alt ||
        event.shiftKey !== !!key.shift ||
        event.metaKey !== !!key.meta
      ) {
        continue;
      }
      for (var n = 0; n < names.length; n += 1) {
        if (key.keys.indexOf(names[n]) >= 0) return key.id;
      }
    }
    return null;
  }

  window.addEventListener("scroll", queueScroll, { passive: true });
  window.addEventListener("resize", queueLayout);
  window.addEventListener("load", function () {
    watchDeck();
    if (!deck && !revealApi() && pendingInitialScroll !== null && scrollInput === 0) {
      var target = pendingInitialScroll;
      pendingInitialScroll = null;
      instantScrollTo(target);
    }
    queueLayout();
  });

  document.addEventListener("DOMContentLoaded", function () {
    installBlinkStyle();
    watchDeck();
    var restored = false;
    if (!deck && !revealApi() && pendingInitialScroll !== null) {
      var target = pendingInitialScroll;
      instantScrollTo(target);
      restored = true;
      if (Math.abs(window.scrollY - target) <= 1) pendingInitialScroll = null;
    }
    layout();
    if (!readySent) {
      readySent = true;
      var state = metrics();
      post({
        type: "ready",
        epoch: layoutEpoch,
        anchors: publicAnchors(),
        top: state.top,
        height: state.height,
        client: state.client,
        line: state.line,
        paged: state.paged,
        restored: restored,
      });
    }
  });

  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(queueLayout).catch(function () {});
  }

  if (window.ResizeObserver) {
    try {
      new ResizeObserver(queueLayout).observe(document.documentElement);
    } catch (error) {
      /* old engines */
    }
  }

  if (window.MutationObserver) {
    try {
      new MutationObserver(queueLayout).observe(document.documentElement, {
        childList: true,
        subtree: true,
      });
    } catch (error) {
      /* old engines */
    }
  }

  document.addEventListener(
    "mousedown",
    function (event) {
      var target = event.target;
      var element = target && target.closest ? target.closest("[data-mdraft-line]") : null;
      if (!element) return;
      var line = parseInt(element.getAttribute("data-mdraft-line"), 10);
      if (isFinite(line)) post({ type: "line", line: line });
    },
    true,
  );

  var selectionTimer = 0;

  // The host records one entry per text node under a stamped block. The guest
  // reports only that index and the selected characters; it never sees a source
  // offset. A document whose own scripts replaced the text will fail the host's
  // sample check, which is the intended fail-closed result.
  function ownedText(stamp) {
    var nodes = [];
    var walker = document.createTreeWalker(stamp, NodeFilter.SHOW_TEXT);
    for (var text = walker.nextNode(); text; text = walker.nextNode()) {
      var parent = text.parentElement;
      if (parent.closest("[data-mdraft-n]") !== stamp || parent.closest(IGNORED_TEXT)) continue;
      nodes.push(text);
    }
    return nodes;
  }

  // Text the reader can select that no source text owns: formula output from
  // the document's renderer, embedded SVG and MathML.
  function ignoredText(node) {
    var parent = node.parentElement;
    return !!parent && !!parent.closest(IGNORED_TEXT + "," + RENDERED);
  }

  function validTexts(n) {
    var texts = originalTexts[n];
    var parents = originalParents[n];
    if (texts === null || texts === undefined) return { texts: [], parents: [] };
    if (!Array.isArray(texts) || !Array.isArray(parents) || texts.length !== parents.length)
      return null;
    for (var i = 0; i < texts.length; i += 1) {
      if (typeof texts[i] !== "string" || !Number.isInteger(parents[i])) return null;
    }
    return { texts: texts, parents: parents };
  }

  // The stamp's text nodes aligned with the host's original table, counted the
  // way `buildHtmlPreview` counts them. Rebuilt when the layout epoch moves; a
  // node whose text changed since is caught by the live comparison in
  // `textEntry` and `resolveSpec`. Null when the host sent no table.
  function stampAlignment(stamp, n) {
    if (!originalTexts) return null;
    var cached = alignments.get(stamp);
    if (cached && cached.epoch === layoutEpoch) return cached;
    var table = validTexts(n);
    if (!table) return null;
    var nodes = [];
    var observed = [];
    var count = 0;
    var element = false;
    var visit = function (parent, ordinal) {
      for (var child = parent.firstChild; child; child = child.nextSibling) {
        if (child.nodeType === 3) {
          nodes.push(child);
          observed.push({ text: child.data, parent: ordinal, element: element, last: false });
          element = false;
        } else if (child.nodeType === 1) {
          element = true;
          var tag = child.localName;
          if (UNCOUNTED[tag] || child.matches(RENDERED)) continue;
          var own = count;
          count += 1;
          if (!OPAQUE[tag] && !child.hasAttribute("data-mdraft-n")) visit(child, own);
        }
      }
    };
    visit(stamp, -1);
    var seen = new Set();
    for (var i = observed.length - 1; i >= 0; i -= 1) {
      if (!/\S/.test(observed[i].text)) continue;
      observed[i].last = !seen.has(observed[i].parent);
      seen.add(observed[i].parent);
    }
    var aligned = {
      epoch: layoutEpoch,
      texts: table.texts,
      nodes: nodes,
      map: alignTextRuns(table.texts, table.parents, observed),
    };
    alignments.set(stamp, aligned);
    return aligned;
  }

  // A text node's identity in the host's coordinates: the stamp, the original
  // text node, and where this node's text starts inside it.
  function textEntry(node) {
    if (!node || node.nodeType !== 3) return null;
    var element = node.parentElement;
    var stamp = element && element.closest ? element.closest("[data-mdraft-n]") : null;
    if (!stamp) return null;
    var n = parseInt(stamp.getAttribute("data-mdraft-n"), 10);
    if (!isFinite(n)) return null;
    var aligned = stampAlignment(stamp, n);
    if (!aligned) {
      var index = ownedText(stamp).indexOf(node);
      return index >= 0 ? { n: n, index: index, base: 0 } : null;
    }
    var at = aligned.nodes.indexOf(node);
    var hit = at >= 0 ? aligned.map[at] : null;
    if (!hit || aligned.texts[hit.index].substr(hit.base, node.data.length) !== node.data)
      return null;
    return { n: n, index: hit.index, base: hit.base };
  }

  // The live pieces of one host range, each checked against the host's sample.
  // A range across a formula has a piece on each side; none when the text no
  // longer matches.
  function resolveSpec(spec, stamps) {
    if (spec.sample.length !== spec.end - spec.start) return [];
    var stamp = stamps.get(spec.n);
    if (stamp === undefined) {
      stamp = document.querySelector('[data-mdraft-n="' + spec.n + '"]');
      stamps.set(spec.n, stamp);
    }
    if (!stamp) return [];
    var aligned = stampAlignment(stamp, spec.n);
    if (!aligned) {
      var node = ownedText(stamp)[spec.index];
      return node &&
        spec.end <= node.length &&
        node.data.slice(spec.start, spec.end) === spec.sample
        ? [{ node: node, start: spec.start, end: spec.end }]
        : [];
    }
    var pieces = [];
    for (var i = 0; i < aligned.nodes.length; i += 1) {
      var hit = aligned.map[i];
      if (!hit || hit.index !== spec.index) continue;
      var piece = aligned.nodes[i];
      var from = Math.max(spec.start, hit.base);
      var to = Math.min(spec.end, hit.base + piece.length);
      if (to <= from) continue;
      if (
        piece.data.slice(from - hit.base, to - hit.base) !==
        spec.sample.slice(from - spec.start, to - spec.start)
      )
        return [];
      pieces.push({ node: piece, start: from - hit.base, end: to - hit.base });
    }
    return pieces;
  }

  function scrollProbe() {
    var excludedCache = new WeakMap();
    // Prefer the centre column first so two- and three-column docs (left nav,
    // main article, right TOC) probe the article instead of a sidebar.
    var xs = [window.innerWidth * 0.5, window.innerWidth * 0.35, window.innerWidth * 0.65, 32];
    for (var y of [probeY + 2, probeY + 14, probeY + 28, probeY + 64, probeY + 100]) {
      if (y >= window.innerHeight) continue;
      for (var x of xs) {
        var point = document.caretRangeFromPoint && document.caretRangeFromPoint(x, y);
        if (!point || point.startContainer.nodeType !== 3) continue;
        var node = point.startContainer;
        if (node.parentElement && isExcludedAnchor(node.parentElement, excludedCache)) continue;
        var box = node.parentElement ? node.parentElement.getBoundingClientRect() : null;
        if (box && box.width <= 1 && box.height <= 1) continue;
        var entry = textEntry(node);
        if (!entry) continue;
        var offset = point.startOffset;
        var words = node.data.matchAll(/[\p{L}\p{M}\p{N}_]+/gu);
        for (var word of words) {
          var start = word.index,
            end = start + word[0].length;
          if (offset >= start && offset <= end)
            return {
              n: entry.n,
              index: entry.index,
              start: entry.base + start,
              end: entry.base + end,
              sample: word[0],
            };
        }
      }
    }
    return null;
  }

  function reportScrollInput() {
    ownScrollTarget = null;
    ownScrollUntil = 0;
    pendingInitialScroll = null;
    scrollInput += 1;
    post({ type: "scrollInput", dragging: scrollDragging });
  }
  window.addEventListener("wheel", reportScrollInput, { capture: true, passive: true });
  // Ctrl+wheel is the editor's preview zoom, not a scroll of this document.
  window.addEventListener(
    "wheel",
    function (event) {
      if (!(event.ctrlKey || event.metaKey)) return;
      event.preventDefault();
      post({ type: "zoomWheel", deltaY: event.deltaY });
    },
    { capture: true, passive: false },
  );
  window.addEventListener("touchstart", reportScrollInput, { capture: true, passive: true });
  window.addEventListener(
    "keydown",
    function (event) {
      if (/^(Arrow|Page|Home|End| )/.test(event.key)) reportScrollInput();
    },
    true,
  );
  window.addEventListener(
    "pointerdown",
    function (event) {
      scrollDragging = event.button === 0 && !!event.target.closest("[data-mdraft-n]");
      reportScrollInput();
    },
    true,
  );
  window.addEventListener(
    "pointerup",
    function () {
      if (scrollDragging) {
        scrollDragging = false;
        reportScrollInput();
      }
    },
    true,
  );
  window.addEventListener("blur", function () {
    scrollDragging = false;
  });

  function measureScroll(data) {
    if (
      !Number.isSafeInteger(data.request) ||
      data.epoch !== layoutEpoch ||
      !Array.isArray(data.ranges) ||
      data.ranges.length > 64
    )
      return;
    var points = [];
    var stamps = new Map();
    for (var i = 0; i < data.ranges.length; i += 1) {
      var spec = data.ranges[i];
      if (
        !spec ||
        !Number.isSafeInteger(spec.n) ||
        spec.n < 0 ||
        !Number.isSafeInteger(spec.index) ||
        spec.index < 0 ||
        !Number.isSafeInteger(spec.start) ||
        !Number.isSafeInteger(spec.end) ||
        spec.start < 0 ||
        spec.end <= spec.start ||
        typeof spec.sample !== "string" ||
        spec.sample.length > 120
      )
        return;
      var piece = resolveSpec(spec, stamps)[0];
      if (!piece) continue;
      var range = document.createRange();
      range.setStart(piece.node, piece.start);
      range.setEnd(piece.node, piece.end);
      var box = range.getBoundingClientRect();
      if (box.width && box.height)
        points.push({
          at: i,
          top: box.top + window.scrollY,
          height: box.height,
          sample: spec.sample,
        });
    }
    post({
      type: "scrollGeometry",
      request: data.request,
      epoch: layoutEpoch,
      input: scrollInput,
      top: window.scrollY,
      points: points,
    });
  }

  // A pointer gesture: the height that was clicked and, when verified text is
  // under it, that text's identity and the clicked character's row. The identity
  // is a text-node index and an offset inside that text, never a source offset;
  // the host owns the mapping.
  function reportGesture(x, y) {
    var message = { type: "gesture", y: y };
    var point = document.caretRangeFromPoint && document.caretRangeFromPoint(x, y);
    var node = point && point.startContainer.nodeType === 3 ? point.startContainer : null;
    var entry = node ? textEntry(node) : null;
    if (entry) {
      for (var word of node.data.matchAll(/[\p{L}\p{M}\p{N}_]+/gu)) {
        var start = word.index,
          end = start + word[0].length;
        if (point.startOffset < start || point.startOffset > end) continue;
        var at = Math.min(point.startOffset, end - 1);
        var glyph = document.createRange();
        glyph.setStart(node, at);
        glyph.setEnd(node, at + 1);
        var box = glyph.getBoundingClientRect();
        // Text found for a click in a margin is not the row that was clicked.
        if (box.height && y >= box.top - box.height && y <= box.bottom + box.height) {
          message.n = entry.n;
          message.index = entry.index;
          message.start = entry.base + start;
          message.end = entry.base + end;
          message.sample = word[0];
          message.at = at - start;
          message.top = box.top;
          message.bottom = box.bottom;
        }
        break;
      }
    }
    post(message);
  }

  function reportSelection(reveal) {
    // A timer from the previous gesture must not steal focus back from source.
    if (!document.hasFocus()) return;
    var selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
      post({ type: "clearSync" });
      return;
    }
    var range = selection.getRangeAt(0);
    if (range.toString().length > 2000) {
      post({ type: "clearSync" });
      return;
    }
    var common = range.commonAncestorContainer;
    var walker = document.createTreeWalker(common, NodeFilter.SHOW_TEXT);
    var segments = [];
    for (
      var node = common.nodeType === 3 ? common : walker.nextNode();
      node;
      node = common.nodeType === 3 ? null : walker.nextNode()
    ) {
      if (!range.intersectsNode(node)) continue;
      var start = node === range.startContainer ? range.startOffset : 0;
      var end = node === range.endContainer ? range.endOffset : node.length;
      while (start < end && /\s/.test(node.data[start])) start += 1;
      while (end > start && /\s/.test(node.data[end - 1])) end -= 1;
      if (end <= start) continue;
      // A formula inside the selection has no text of its own in the source
      // table; the pieces on either side still bound the source range.
      if (ignoredText(node)) continue;
      var entry = textEntry(node);
      if (!entry || segments.length >= 128) {
        post({ type: "clearSync" });
        return;
      }
      segments.push({
        n: entry.n,
        index: entry.index,
        start: entry.base + start,
        end: entry.base + end,
        sample: node.data.slice(start, end),
      });
    }
    if (!segments.length) {
      post({ type: "clearSync" });
      return;
    }
    post({
      type: "select",
      n: segments[0].n,
      index: segments[0].index,
      start: segments[0].start,
      end: segments[0].end,
      sample: segments[0].sample,
      segments: segments,
      reveal: reveal === true,
    });
  }

  document.addEventListener(
    "dblclick",
    function () {
      window.clearTimeout(selectionTimer);
      selectionTimer = window.setTimeout(function () {
        reportSelection(true);
      }, 0);
    },
    true,
  );

  document.addEventListener("selectionchange", function () {
    window.clearTimeout(selectionTimer);
    selectionTimer = window.setTimeout(function () {
      reportSelection(false);
    }, 120);
  });

  var wordRanges = [];
  var wordTimer = 0;
  var wordKey = "";
  var motion = window.matchMedia("(prefers-reduced-motion: reduce)");

  function clearWords() {
    window.clearTimeout(wordTimer);
    wordTimer = 0;
    wordRanges = [];
    wordKey = "";
    if (window.CSS && CSS.highlights) {
      CSS.highlights.delete("mdraft-sync");
      CSS.highlights.delete("mdraft-sync-peak");
    }
  }

  function paintWords(specs) {
    if (
      !Array.isArray(specs) ||
      !specs.length ||
      specs.length > 128 ||
      !window.CSS ||
      !CSS.highlights ||
      !window.Highlight
    ) {
      clearWords();
      return;
    }
    var key = JSON.stringify(specs);
    var ranges = [];
    var stamps = new Map();
    // Each range is checked on its own: one text node a script replaced must
    // not hide the words around it that still match.
    for (var i = 0; i < specs.length; i += 1) {
      var spec = specs[i];
      if (
        !spec ||
        !Number.isInteger(spec.n) ||
        !Number.isInteger(spec.index) ||
        !Number.isInteger(spec.start) ||
        !Number.isInteger(spec.end) ||
        spec.start < 0 ||
        spec.end <= spec.start ||
        typeof spec.sample !== "string"
      )
        continue;
      var pieces = resolveSpec(spec, stamps);
      for (var p = 0; p < pieces.length; p += 1) {
        var range = document.createRange();
        range.setStart(pieces[p].node, pieces[p].start);
        range.setEnd(pieces[p].node, pieces[p].end);
        ranges.push(range);
      }
    }
    if (!ranges.length) {
      clearWords();
      return;
    }
    // A highlight on a slide that is not on screen is no highlight at all.
    if (deck) showInDeck(ranges[0].startContainer.parentElement);
    if (key === wordKey && wordTimer) return;
    clearWords();
    wordKey = key;
    wordRanges = ranges;
    var rest = new Highlight(...ranges),
      peak = new Highlight(...ranges);
    CSS.highlights.set("mdraft-sync", rest);
    if (motion.matches) return;
    var beat = 0;
    function step() {
      if (!wordRanges.length) return;
      beat += 1;
      var high = beat % 2 === 1 && !motion.matches && beat < 8;
      CSS.highlights.set(high ? "mdraft-sync-peak" : "mdraft-sync", high ? peak : rest);
      CSS.highlights.delete(high ? "mdraft-sync" : "mdraft-sync-peak");
      wordTimer = !motion.matches && beat < 8 ? window.setTimeout(step, 250) : 0;
    }
    wordTimer = window.setTimeout(step, 250);
  }

  motion.addEventListener("change", function () {
    if (motion.matches && wordRanges.length && window.Highlight && CSS.highlights) {
      window.clearTimeout(wordTimer);
      wordTimer = 0;
      CSS.highlights.delete("mdraft-sync-peak");
      CSS.highlights.set("mdraft-sync", new Highlight(...wordRanges));
    }
  });

  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape") {
      window.clearTimeout(selectionTimer);
      clearWords();
      post({ type: "clearSync" });
    }
  });

  document.addEventListener(
    "mouseup",
    function (event) {
      // The release, not the press: for a drag the row that matters is where it
      // ended, and nothing may scroll while it is in progress.
      if (event.button === 0) reportGesture(event.clientX, event.clientY);
      window.clearTimeout(selectionTimer);
      selectionTimer = window.setTimeout(function () {
        reportSelection(false);
      }, 120);
    },
    true,
  );

  document.addEventListener(
    "click",
    function (event) {
      var target = event.target;
      var image = target && target.closest ? target.closest("img") : null;
      if (image && (event.ctrlKey || event.metaKey)) {
        var source = image.getAttribute("src") || "";
        if (!source) return;
        event.preventDefault();
        event.stopPropagation();
        var resolved;
        try {
          resolved = new URL(source, document.baseURI).href;
        } catch (error) {
          return;
        }
        post({ type: "link", href: resolved, raw: source });
        return;
      }
      var link = target && target.closest ? target.closest("a") : null;
      if (!link) return;
      var raw = link.getAttribute("href") || "";
      if (!raw) return;
      event.preventDefault();
      event.stopPropagation();
      if (raw.charAt(0) === "#") {
        var id = raw.slice(1);
        var destination = id ? document.getElementById(id) : null;
        // Scrolling a deck's hidden overflow would shift every slide.
        if (destination && deck) showInDeck(destination);
        else if (destination) destination.scrollIntoView({ block: "start" });
        else if (!id || id.toLowerCase() === "top") window.scrollTo(0, 0);
        // No element by that name: a fragment such as reveal.js's `#/3` is a
        // route the document's own script follows on `hashchange`. Setting it
        // here, not by the default action, keeps a `<base>` from turning it
        // into a navigation away from the preview.
        else location.hash = raw;
        return;
      }
      var resolved;
      try {
        resolved = new URL(raw, document.baseURI).href;
      } catch (error) {
        return;
      }
      post({ type: "link", href: resolved, raw: raw });
    },
    true,
  );

  window.addEventListener(
    "keydown",
    function (event) {
      if (event.isComposing || event.keyCode === 229) return;
      var modified = event.ctrlKey || event.metaKey || event.altKey;
      var functionKey = /^F\d{1,2}$/.test(event.key || "");
      if (!modified && !functionKey) return;
      var id = acceleratorFor(event);
      if (!id) return;
      event.preventDefault();
      event.stopPropagation();
      post({ type: "action", id: id });
    },
    true,
  );

  window.addEventListener("message", function (event) {
    if (event.source !== window.parent) return;
    var data = event.data;
    if (!data || data.__mdraft !== TOKEN) return;
    if (data.type === "scrollTo") {
      // A deck's viewport does not scroll; the host steers it by line.
      if (deck) return;
      if (data.input !== undefined && data.input !== scrollInput) return;
      pendingInitialScroll = null;
      var top = Number(data.top);
      if (isFinite(top)) instantScrollTo(top);
    } else if (data.type === "measureScroll") {
      measureScroll(data);
    } else if (data.type === "probeAt") {
      var height = Number(data.y);
      if (isFinite(height)) probeY = Math.max(0, Math.min(window.innerHeight, height));
    } else if (data.type === "scrollToLine") {
      pendingInitialScroll = null;
      if (deck) {
        goToLine(Number(data.line));
        return;
      }
      // The deck is still starting: its first slide is not yet laid out.
      if (revealApi()) {
        pendingLine = Number(data.line);
        return;
      }
      var anchor = anchorForLine(Number(data.line));
      if (anchor) instantScrollTo(anchor.top - SYNC_MARGIN);
    } else if (data.type === "blink") {
      blink(Number(data.line));
    } else if (data.type === "hash") {
      pendingInitialScroll = null;
      var element = document.getElementById(String(data.id));
      if (element && deck) showInDeck(element);
      else if (element) element.scrollIntoView({ block: "start" });
    } else if (data.type === "highlightWords") {
      paintWords(data.ranges);
    } else if (data.type === "keys") {
      keys = Array.isArray(data.list) ? data.list : [];
    } else if (data.type === "texts") {
      // Validated per stamp when it is first used; a malformed stamp keeps the
      // guest's own positions for that stamp only.
      var valid = Array.isArray(data.texts) && Array.isArray(data.parents);
      originalTexts = valid ? data.texts : null;
      originalParents = valid ? data.parents : null;
      alignments = new WeakMap();
    }
  });

  function installBlinkStyle() {
    if (document.getElementById("mdraft-blink-style")) return;
    var style = document.createElement("style");
    style.id = "mdraft-blink-style";
    style.textContent =
      ".mdraft-blink{outline:2px solid #4c8dff !important;outline-offset:2px !important}" +
      ".mdraft-blink{transition:outline-color 120ms ease}";
    style.textContent +=
      "::highlight(mdraft-sync){background-color:rgba(255,193,7,.3)}" +
      "::highlight(mdraft-sync-peak){background-color:rgba(255,167,0,.55)}" +
      "@media(prefers-reduced-motion:reduce){.mdraft-blink{transition:none}}";
    document.head.appendChild(style);
  }
})();
