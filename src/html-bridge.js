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
    true
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
    scanAnchors();
    var state = metrics();
    post({
      type: "layout",
      anchors: publicAnchors(),
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
      var element =
        target && target.closest ? target.closest("[data-mdraft-line]") : null;
      if (!element) return;
      var line = parseInt(element.getAttribute("data-mdraft-line"), 10);
      if (isFinite(line)) post({ type: "line", line: line });
    },
    true,
  );

  document.addEventListener(
    "click",
    function (event) {
      var target = event.target;
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
      var top = Number(data.top);
      if (isFinite(top)) window.scrollTo(0, Math.max(0, top));
    } else if (data.type === "scrollToLine") {
      var anchor = anchorForLine(Number(data.line));
      if (anchor) window.scrollTo(0, Math.max(0, anchor.top - SYNC_MARGIN));
    } else if (data.type === "blink") {
      blink(Number(data.line));
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
    document.head.appendChild(style);
  }
})();
