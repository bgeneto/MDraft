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
  var BLINK_MS = 620;
  var SYNC_MARGIN = 12;
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
    for (var i = 0; i < nodes.length; i += 1) {
      var element = nodes[i];
      var line = parseInt(element.getAttribute("data-mdraft-line"), 10);
      if (!isFinite(line)) continue;
      var rect = element.getBoundingClientRect();
      // Hidden elements have no position to synchronise against. Keeping them
      // would make the interpolation jump to zero.
      if (rect.width === 0 && rect.height === 0) continue;
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
      line: lineAtTop(),
    };
  }

  function lineAtTop() {
    if (anchors.length === 0) return 1;
    var y = window.scrollY + SYNC_MARGIN;
    var line = anchors[0].line;
    for (var i = 0; i < anchors.length; i += 1) {
      if (anchors[i].top <= y) line = anchors[i].line;
      else break;
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
      post({
        type: "scroll",
        top: state.top,
        height: state.height,
        client: state.client,
        line: state.line,
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
  window.addEventListener("load", queueLayout);

  document.addEventListener("DOMContentLoaded", function () {
    installBlinkStyle();
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
  // offset. A document whose own scripts rewrote the DOM will fail the host's
  // sample check, which is the intended fail-closed result.
  function ownedText(stamp) {
    var nodes = [];
    var walker = document.createTreeWalker(stamp, NodeFilter.SHOW_TEXT);
    for (var text = walker.nextNode(); text; text = walker.nextNode()) {
      var parent = text.parentElement;
      if (
        parent.closest("[data-mdraft-n]") !== stamp ||
        parent.closest("script,style,textarea,title,template,svg,math,noscript")
      )
        continue;
      nodes.push(text);
    }
    return nodes;
  }

  function textEntry(node) {
    if (!node || node.nodeType !== 3) return null;
    var element = node.parentElement;
    var stamp = element && element.closest ? element.closest("[data-mdraft-n]") : null;
    if (!stamp) return null;
    var n = parseInt(stamp.getAttribute("data-mdraft-n"), 10);
    if (!isFinite(n)) return null;
    var index = ownedText(stamp).indexOf(node);
    return index >= 0 ? { n: n, index: index } : null;
  }

  function scrollProbe() {
    for (var y of [SYNC_MARGIN + 2, SYNC_MARGIN + 14, SYNC_MARGIN + 28]) {
      for (var x of [32, window.innerWidth * 0.4, window.innerWidth * 0.7]) {
        var point = document.caretRangeFromPoint && document.caretRangeFromPoint(x, y);
        if (!point || point.startContainer.nodeType !== 3) continue;
        var node = point.startContainer;
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
              start: start,
              end: end,
              sample: word[0],
            };
        }
      }
    }
    return null;
  }

  function reportScrollInput() {
    scrollInput += 1;
    post({ type: "scrollInput", dragging: scrollDragging });
  }
  window.addEventListener("wheel", reportScrollInput, { capture: true, passive: true });
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
    var nodesByStamp = new Map();
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
      var nodes = nodesByStamp.get(spec.n);
      if (!nodes) {
        var stamp = document.querySelector('[data-mdraft-n="' + spec.n + '"]');
        nodes = stamp ? ownedText(stamp) : [];
        nodesByStamp.set(spec.n, nodes);
      }
      var node = nodes[spec.index];
      if (!node || spec.end > node.length || node.data.slice(spec.start, spec.end) !== spec.sample)
        continue;
      var range = document.createRange();
      range.setStart(node, spec.start);
      range.setEnd(node, spec.end);
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
      var entry = textEntry(node);
      if (!entry || segments.length >= 128) {
        post({ type: "clearSync" });
        return;
      }
      segments.push({
        n: entry.n,
        index: entry.index,
        start: start,
        end: end,
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
      ) {
        clearWords();
        return;
      }
      var stamp = document.querySelector('[data-mdraft-n="' + spec.n + '"]');
      var node = stamp ? ownedText(stamp)[spec.index] : null;
      if (
        !node ||
        spec.end > node.length ||
        node.data.slice(spec.start, spec.end) !== spec.sample
      ) {
        clearWords();
        return;
      }
      var range = document.createRange();
      range.setStart(node, spec.start);
      range.setEnd(node, spec.end);
      ranges.push(range);
    }
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
    function () {
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
        if (destination) destination.scrollIntoView({ block: "start" });
        else window.scrollTo(0, 0);
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
      if (data.input !== undefined && data.input !== scrollInput) return;
      var top = Number(data.top);
      if (isFinite(top)) window.scrollTo(0, Math.max(0, top));
    } else if (data.type === "measureScroll") {
      measureScroll(data);
    } else if (data.type === "scrollToLine") {
      var anchor = anchorForLine(Number(data.line));
      if (anchor) window.scrollTo(0, Math.max(0, anchor.top - SYNC_MARGIN));
    } else if (data.type === "blink") {
      blink(Number(data.line));
    } else if (data.type === "hash") {
      var element = document.getElementById(String(data.id));
      if (element) element.scrollIntoView({ block: "start" });
    } else if (data.type === "highlightWords") {
      paintWords(data.ranges);
    } else if (data.type === "keys") {
      keys = Array.isArray(data.list) ? data.list : [];
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
