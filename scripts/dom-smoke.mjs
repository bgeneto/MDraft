// Smoke test for a running MDraft window.
//
//   1. start the app with WebView2 remote debugging enabled:
//        $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9222"
//        .\src-tauri\target\release\mdraft.exe samples\feature-tour.md
//   2. run:
//        node scripts/dom-smoke.mjs 9222
//
// It attaches over CDP with Node's built-in WebSocket client (no extra
// packages), asserts that every rendering stage produced output, then drives
// the Preferences panel and checks that its controls really change behaviour.
const PORT = Number(process.argv[2] ?? 9222);

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === "page");
if (!page) {
  console.error("no page target on port", PORT);
  process.exit(1);
}
console.log(`target ${page.id}  ${page.url}  ${JSON.stringify(page.title)}\n`);

const ws = new WebSocket(page.webSocketDebuggerUrl);
let nextId = 1;
const pending = new Map();
const consoleIssues = [];

ws.addEventListener("message", (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve } = pending.get(msg.id);
    pending.delete(msg.id);
    resolve(msg);
  } else if (msg.method === "Runtime.exceptionThrown") {
    const d = msg.params.exceptionDetails;
    consoleIssues.push(`exception: ${d.exception?.description ?? d.text}`);
  } else if (
    msg.method === "Runtime.consoleAPICalled" &&
    (msg.params.type === "error" || msg.params.type === "warning")
  ) {
    consoleIssues.push(
      `${msg.params.type}: ${msg.params.args.map((a) => a.value ?? a.description ?? "").join(" ")}`,
    );
  }
});

function send(method, params = {}) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve) => pending.set(id, { resolve }));
}

async function evaluate(expression) {
  const response = await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (response.result?.exceptionDetails) {
    throw new Error(
      `evaluate failed: ${JSON.stringify(response.result.exceptionDetails).slice(0, 400)}`,
    );
  }
  const value = response.result.result.value;
  return typeof value === "string" ? JSON.parse(value) : value;
}

const settle = (ms) => new Promise((r) => setTimeout(r, ms));

await new Promise((resolve) => ws.addEventListener("open", resolve));
await send("Runtime.enable");
await settle(2500);

const expectations = [];
const check = (label, ok) => expectations.push([label, Boolean(ok)]);

// ---------------------------------------------------------------------------
// Phase 0 — wait until the application has actually rendered
// ---------------------------------------------------------------------------

// The CDP endpoint answers as soon as WebView2 starts, which is well before the
// frontend has booted and drawn anything. Running the phases against a
// half-built page fails deep inside one of them with a message about `dataset`
// on undefined, which says nothing about the real cause. Wait for the first
// rendered block instead, and say so plainly if it never appears.
const readyDeadline = Date.now() + 60_000;
let ready = { anchors: 0, bootError: false };
for (;;) {
  ready = await evaluate(`(() => ({
    anchors: document.querySelectorAll('#preview [data-line]').length,
    bootError: document.body.textContent.includes('Failed to start MDraft'),
  }))()`);
  if (ready.anchors > 0 || ready.bootError) break;
  if (Date.now() > readyDeadline) break;
  await new Promise((resolve) => setTimeout(resolve, 250));
}

if (ready.bootError) {
  console.error("The application reported a boot failure instead of rendering.");
  process.exit(1);
}
if (ready.anchors === 0) {
  console.error(
    "The preview rendered no blocks within 60 s.\n" +
      "The window is up but nothing was drawn: check that the right document is open\n" +
      "(this suite asserts against samples/feature-tour.md) and that no dialog is blocking.",
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Phase 1 — rendered document
// ---------------------------------------------------------------------------

const doc = await evaluate(`(() => {
  const q = (sel) => document.querySelectorAll(sel).length;
  const preview = document.getElementById('preview');
  return JSON.stringify({
    title: document.title,
    theme: document.documentElement.dataset.theme,
    appClasses: document.getElementById('app').className,
    bootError: document.body.textContent.includes('Failed to start MDraft'),
    editorLines: q('.cm-line'),
    editorChars: (document.querySelector('.cm-content')?.textContent ?? '').length,
    previewChildren: preview ? preview.children.length : 0,
    headings: q('#preview h1') + q('#preview h2') + q('#preview h3'),
    tables: q('#preview table'),
    tableRows: q('#preview table tr'),
    checkboxes: q('#preview input[type=checkbox]'),
    checkedBoxes: q('#preview input[type=checkbox]:checked'),
    codeBlocks: q('#preview pre code'),
    highlighted: q('#preview pre code.hljs'),
    hljsSpans: q('#preview pre code.hljs span'),
    mathErrors: q('#preview .math-error'),
    katexInline: q('#preview .math-inline .katex'),
    katexDisplay: q('#preview .math-display .katex'),
    mermaidBlocks: q('#preview .mermaid'),
    mermaidSvg: q('#preview .mermaid svg'),
    mermaidErrors: q('#preview .mermaid-error'),
    alerts: q('#preview .md-alert'),
    alertTitles: q('#preview .md-alert-title'),
    toc: q('#preview .md-toc'),
    tocLinks: q('#preview .md-toc a'),
    outlineItems: q('#sidebar-body .outline-item'),
    // Exactly one view-mode control may look selected, and the old duplicate
    // source-mode button must not come back.
    activeModeButtons: ['mode-source', 'mode-split', 'mode-preview'].filter((id) =>
      document.getElementById(id).classList.contains('active')).length,
    hasLegacySourceButton: Boolean(document.getElementById('btn-source')),
    // The status icons are inline SVG. Text glyphs (⚙ ◐ ☰) render as thin
    // shapes whose weight does not match, and the emoji presentation is a
    // platform-specific colour bitmap.
    statusIcons: ['btn-sidebar', 'btn-prefs', 'btn-theme'].map((id) => {
      const svg = document.getElementById(id)?.querySelector('svg');
      const box = svg?.getBoundingClientRect();
      return {
        id,
        isSvg: Boolean(svg),
        size: box ? Math.round(box.width) : 0,
        stroke: svg ? getComputedStyle(svg).color : '',
      };
    }),
    editorSurface: getComputedStyle(document.querySelector('.cm-editor')).backgroundColor,
    syntaxColors: new Set([...document.querySelectorAll('.cm-line span')]
      .map((s) => getComputedStyle(s).color)).size,
    // Counting .katex elements proves KaTeX ran, not that it is legible. These
    // measure the geometry that collapses when katex.min.css is missing: the
    // fraction rule and the radical's tail, which carry the visible sign.
    math: (() => {
      const preview = document.getElementById('preview');
      const bar = preview.querySelector('.katex .frac-line');
      const tail = preview.querySelector('.katex .sqrt .hide-tail');
      const mord = preview.querySelector('.katex .mord');
      return {
        declared: [...document.fonts].some((f) => f.family === 'KaTeX_Main'),
        available: document.fonts.check('1em KaTeX_Main'),
        fracBarWidth: bar ? Math.round(bar.getBoundingClientRect().width * 10) / 10 : 0,
        radicalWidth: tail ? Math.round(tail.getBoundingClientRect().width * 10) / 10 : 0,
        fontFamily: mord ? getComputedStyle(mord).fontFamily : '',
      };
    })(),
    statusWords: document.getElementById('status-words')?.textContent ?? '',
    statusEncoding: document.getElementById('status-encoding')?.textContent ?? ''
  });
})()`);

console.log("=== rendered DOM ===");
for (const [key, value] of Object.entries(doc)) console.log(`  ${key.padEnd(16)} ${value}`);

check("boot succeeded", !doc.bootError);
check("editor rendered", doc.editorLines > 5 && doc.editorChars > 200);
check("preview rendered", doc.previewChildren > 5);
check("headings", doc.headings >= 3);
check("gfm table", doc.tables >= 1 && doc.tableRows >= 3);
check("task list boxes", doc.checkboxes >= 2 && doc.checkedBoxes >= 1);
check("code highlighting", doc.highlighted >= 3 && doc.hljsSpans >= 10);
check("inline math", doc.katexInline >= 2);
check("display math", doc.katexDisplay >= 2);
check("no math errors", doc.mathErrors === 0);
check("mermaid svg", doc.mermaidSvg >= 2);
check("no mermaid errors", doc.mermaidErrors === 0);
check("github alerts", doc.alerts >= 1 && doc.alertTitles >= 1);
check("table of contents", doc.toc >= 1 && doc.tocLinks >= 5);
check("outline populated", doc.outlineItems >= 3);
check("exactly one view mode is active", doc.activeModeButtons === 1);
check("no duplicate source-mode button", doc.hasLegacySourceButton === false);
check("status icons are inline SVG", doc.statusIcons.every((icon) => icon.isSvg));
check("status icons are at least 16px", doc.statusIcons.every((icon) => icon.size >= 16));
check("status icons inherit the theme colour", doc.statusIcons.every((icon) => icon.stroke.length > 0));
check("source pane is syntax highlighted", doc.syntaxColors >= 4);
check("KaTeX stylesheet loaded (font declared)", doc.math.declared);
check("KaTeX_Main is available", doc.math.available);
check("fraction rules are drawn", doc.math.fracBarWidth > 2);
check("radical signs are drawn", doc.math.radicalWidth > 2);
check("math uses a KaTeX font", doc.math.fontFamily.includes("KaTeX"));
check("status bar", /word/.test(doc.statusWords) && /UTF-8/.test(doc.statusEncoding));

// ---------------------------------------------------------------------------
// Phase 2 — Preferences panel
// ---------------------------------------------------------------------------

const prefs = await evaluate(`(() => {
  // #btn-prefs toggles, so clicking unconditionally closes a panel that a
  // previous suite left open — and then every check below reads an empty
  // document. Establish the state rather than assuming it.
  const existing = document.querySelector('.prefs-overlay');
  if (!existing || existing.hidden) document.getElementById('btn-prefs').click();
  const overlay = document.querySelector('.prefs-overlay');
  const sections = [...document.querySelectorAll('.prefs-section')];

  // Walk every section: render() is synchronous, so rows are readable at once.
  const perSection = sections.map((button) => {
    button.click();
    const rows = [...document.querySelectorAll('.prefs-row')];
    return {
      name: button.textContent,
      heading: document.querySelector('.prefs-section-title')?.textContent ?? '',
      rows: rows.length,
      labels: rows.map((r) => r.querySelector('.prefs-label')?.textContent?.replace('?', '').trim())
    };
  });
  sections[0].click();

  const rows = [...document.querySelectorAll('.prefs-row')];
  return JSON.stringify({
    open: overlay ? !overlay.hidden : false,
    title: document.querySelector('.prefs-title')?.textContent ?? '',
    sectionNames: sections.map((s) => s.textContent).join(','),
    activeSection: document.querySelector('.prefs-section[aria-selected="true"]')?.textContent ?? '',
    sectionHeading: document.querySelector('.prefs-section-title')?.textContent ?? '',
    perSection,
    totalRows: perSection.reduce((n, s) => n + s.rows, 0),
    emptySections: perSection.filter((s) => s.rows === 0).map((s) => s.name).join(','),
    rowCount: rows.length,
    selects: document.querySelectorAll('.prefs-control select').length,
    checkboxes: document.querySelectorAll('.prefs-row-checkbox input[type=checkbox]').length,
    buttons: document.querySelectorAll('.prefs-button').length,
    hasSearch: Boolean(document.querySelector('.prefs-search'))
  });
})()`);

console.log("\n=== preferences ===");
for (const [key, value] of Object.entries(prefs)) {
  if (key === "perSection") continue;
  console.log(`  ${key.padEnd(16)} ${String(value).slice(0, 150)}`);
}
for (const section of prefs.perSection) {
  console.log(`  · ${section.name.padEnd(12)} ${section.rows} rows  [${section.labels.join(", ")}]`);
}

check("preferences opens", prefs.open);
check("preferences title", prefs.title === "Preferences");
check("eight sections", prefs.sectionNames.split(",").length === 8);
check(
  "sections named and ordered like Typora",
  prefs.sectionNames === "Files,Editor,Image,Markdown,Export,Appearance,General,Typography",
);
check("first section selected", prefs.activeSection === "Files" && prefs.sectionHeading === "Files");
check("every section has rows", prefs.emptySections === "");
check("rows rendered", prefs.totalRows >= 24);
check("controls present", prefs.selects >= 2 && prefs.checkboxes >= 2 && prefs.buttons >= 1);
check("search box present", prefs.hasSearch);

// Search filters the navigation down to matching sections.
const search = await evaluate(`(() => {
  const input = document.querySelector('.prefs-search');
  input.value = 'mermaid';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  const sections = [...document.querySelectorAll('.prefs-section')].map((s) => s.textContent);
  const labels = [...document.querySelectorAll('.prefs-label')].map((l) => l.textContent.replace('?','').trim());
  return JSON.stringify({ sections: sections.join(','), labels: labels.join('|') });
})()`);

console.log("\n=== preferences search 'mermaid' ===");
console.log(`  sections  ${search.sections}`);
console.log(`  labels    ${search.labels}`);
check("search narrows sections", search.sections === "Markdown");
check("search keeps the matching row", /Enable Diagrams/.test(search.labels));

// A checkbox in the panel must actually change rendering behaviour.
// The panel re-renders itself after every change, so the input has to be
// re-queried each time instead of holding a stale reference.
const toggled = await evaluate(`(async () => {
  const input = document.querySelector('.prefs-search');
  input.value = '';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  [...document.querySelectorAll('.prefs-section')]
    .find((s) => s.textContent === 'Markdown').click();

  const findBox = () => {
    const row = [...document.querySelectorAll('.prefs-row')].find((r) =>
      (r.querySelector('.prefs-label')?.textContent ?? '').startsWith('Enable Diagrams'));
    return row ? row.querySelector('input[type=checkbox]') : null;
  };

  const before = findBox().checked;
  findBox().click();                       // turn diagrams off
  await new Promise((r) => setTimeout(r, 900));
  const afterOff = {
    checked: findBox().checked,
    svg: document.querySelectorAll('#preview .mermaid svg').length,
    codeBlocks: document.querySelectorAll('#preview pre code').length
  };

  findBox().click();                       // turn them back on
  await new Promise((r) => setTimeout(r, 1200));
  const afterOn = {
    checked: findBox().checked,
    svg: document.querySelectorAll('#preview .mermaid svg').length,
    codeBlocks: document.querySelectorAll('#preview pre code').length
  };
  return JSON.stringify({ before, afterOff, afterOn });
})()`);

console.log("\n=== preferences toggles a real setting ===");
console.log(`  before          ${JSON.stringify(toggled.before)}`);
console.log(`  diagrams off    ${JSON.stringify(toggled.afterOff)}`);
console.log(`  diagrams on     ${JSON.stringify(toggled.afterOn)}`);

check("toggle turns diagrams off", toggled.before === true && toggled.afterOff.checked === false);
check("diagrams removed from preview", toggled.afterOff.svg === 0);
check("mermaid fences fall back to code", toggled.afterOff.codeBlocks > toggled.afterOn.codeBlocks);
check("toggle restores diagrams", toggled.afterOn.checked === true && toggled.afterOn.svg >= 2);

// Each face is one dropdown. The old row had a text field for the CSS stack, a
// second dropdown and a rendered specimen; three controls saying the same
// thing, with the stack field editable on top of it.
const faces = await evaluate(`(() => {
  [...document.querySelectorAll('.prefs-section')]
    .find((s) => s.textContent === 'Typography').click();
  const wanted = ['Editor', 'Preview text', 'Preview headings', 'Preview code'];
  const rows = [...document.querySelectorAll('.prefs-row')].filter((row) => {
    const label = (row.querySelector('.prefs-label')?.textContent ?? '').replace('?', '').trim();
    return wanted.includes(label);
  });
  return JSON.stringify({
    labels: rows.map((row) => row.querySelector('.prefs-label')?.textContent?.replace('?', '').trim()),
    controls: rows.map((row) =>
      row.querySelectorAll('input, select, textarea, .prefs-font-specimen').length),
    tags: rows.map((row) => row.querySelector('.prefs-control')?.firstElementChild?.tagName ?? ''),
    options: rows.map((row) => row.querySelectorAll('select option').length),
    selected: rows.map((row) => row.querySelector('select')?.selectedOptions[0]?.textContent ?? '')
  });
})()`);

console.log("\n=== typography face rows ===");
console.log(`  labels   ${faces.labels.join(', ')}`);
console.log(`  controls ${faces.controls.join(', ')}`);
console.log(`  tags     ${faces.tags.join(', ')}`);
console.log(`  selected ${faces.selected.join(', ')}`);

check(
  "one dropdown for each face",
  faces.labels.length === 4 &&
    faces.tags.every((tag) => tag === "SELECT") &&
    faces.controls.every((count) => count === 1),
);
check(
  "face pickers list the faces and keep a selection",
  faces.options.every((count) => count >= 10) && faces.selected.every(Boolean),
);

// Close with Escape.
const closed = await evaluate(`(() => {
  const overlay = document.querySelector('.prefs-overlay');
  overlay.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  return JSON.stringify({ hidden: overlay.hidden });
})()`);
check("escape closes preferences", closed.hidden === true);

// ---------------------------------------------------------------------------
// Phase 3 — source / preview position sync
// ---------------------------------------------------------------------------

const sync = await evaluate(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const preview = document.getElementById('preview');
  // The scrolling element is the pane that wraps the rendered document.
  const previewPane = document.getElementById('preview-pane');
  const scroller = document.querySelector('.cm-scroller');
  const content = document.querySelector('.cm-content');
  const cursorText = () => document.getElementById('status-cursor').textContent.replace(/\\s+/g,' ').trim();
  // A blink that has finished must leave nothing behind. The highlight is
  // deliberately not a state: a tint that stays reads as markup applied to the
  // document rather than as a pointer.
  const blinkLeftBehind = () => preview.querySelectorAll('.sync-blink').length;
  // Which preview block currently leads the pane, for the alignment assertion.
  const topVisibleLine = () => {
    const paneTop = previewPane.getBoundingClientRect().top;
    for (const a of anchors) {
      if (a.getBoundingClientRect().bottom > paneTop) return Number(a.dataset.line);
    }
    return -1;
  };
  const contentBox = content.getBoundingClientRect();

  const anchors = [...preview.querySelectorAll('[data-line]')];
  const lines = anchors.map((a) => Number(a.dataset.line));
  let monotonic = true;
  for (let i = 1; i < lines.length; i++) if (lines[i] < lines[i - 1]) monotonic = false;

  // (1) click a late block in the preview -> the editor reveals that line
  //     Phase 0 proved the preview had blocks, so an empty list here means
  //     something cleared it in between. Say that, rather than dying on a
  //     dataset access on undefined a line later.
  if (anchors.length === 0) throw new Error('the preview lost its [data-line] anchors between phases');
  const target = anchors[Math.min(7, anchors.length - 1)];
  const targetLine = Number(target.dataset.line);
  target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 0, clientY: 0 }));
  await sleep(500);
  const afterPreviewClick = cursorText();

  // (2) scroll the source -> the preview follows.
  //     Return to a known baseline first. The document is never reloaded between
  //     runs, so a previous run leaves the editor scrolled; scrolling "to 45%"
  //     from there changes nothing and the follow assertion fails for a reason
  //     that has nothing to do with syncing.
  scroller.scrollTop = 0;
  await sleep(600);
  const before = previewPane.scrollTop;
  scroller.scrollTop = Math.round((scroller.scrollHeight - scroller.clientHeight) * 0.45);
  await sleep(900);
  const after = previewPane.scrollTop;
  // Scrolling is continuous, so it must not blink at all.
  const blinkAfterScroll = blinkLeftBehind();

  // (3) clicking a block in the preview must NOT scroll the preview. Before the
  //     fix the caret change fed back through onCursor and yanked the clicked
  //     block to the top, which also destroyed any drag-selection because the
  //     text slid out from under the pointer.
  const paneBox = previewPane.getBoundingClientRect();
  const middle = anchors.find((a) => {
    const r = a.getBoundingClientRect();
    return r.top > paneBox.top + 120 && r.top < paneBox.bottom - 120;
  });
  const scrollBeforeClick = previewPane.scrollTop;
  const caretBeforeClick = cursorText();
  if (middle) {
    middle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 0, clientY: 0 }));
    await sleep(500);
  }
  const scrollAfterClick = previewPane.scrollTop;
  const caretAfterClick = cursorText();

  // (4) click a column of source lines -> none of them may move the preview.
  //     The rendered preview is much taller than its markdown and the ratio
  //     varies by section, so which lines have their block below the preview
  //     fold is not predictable. Exercise the whole column instead of one
  //     hand-picked line: revealing any of them is what used to throw the
  //     alignment away.
  const visibleLines = [...document.querySelectorAll('.cm-line')].filter((el) => {
    const r = el.getBoundingClientRect();
    return r.top > contentBox.top + 8 && r.bottom < contentBox.bottom - 8;
  });
  const baseline = previewPane.scrollTop;
  const topLineBeforeSourceClick = topVisibleLine();
  const samples = [];
  for (const fraction of [0.2, 0.4, 0.6, 0.8, 0.95]) {
    const el = visibleLines[Math.min(visibleLines.length - 1, Math.floor(visibleLines.length * fraction))];
    if (!el) continue;
    const r = el.getBoundingClientRect();
    const at = { bubbles: true, clientX: r.left + 40, clientY: r.top + r.height / 2 };
    content.dispatchEvent(new MouseEvent('mousedown', at));
    content.dispatchEvent(new MouseEvent('click', at));
    await sleep(samples.length === 0 ? 120 : 400);
    const blinkNow = blinkLeftBehind();
    const line = Number(/Ln (\\d+)/.exec(cursorText())?.[1] ?? -1);
    const block = anchors.filter((a) => Number(a.dataset.line) <= line).pop() ?? null;
    samples.push({
      fraction,
      line,
      scroll: Math.round(previewPane.scrollTop),
      blockBelowFold: block ? block.getBoundingClientRect().top > paneBox.bottom : null,
      blink: blinkNow,
    });
  }
  await sleep(900);
  const blinkAfterClick = blinkLeftBehind();
  const scrollAfterSourceClick = previewPane.scrollTop;
  const topLineAfterSourceClick = topVisibleLine();
  const maxDrift = samples.length
    ? Math.max(...samples.map((s) => Math.abs(s.scroll - baseline)))
    : -1;
  const offScreenCases = samples.filter((s) => s.blockBelowFold === true).length;
  const blinkedCases = samples.filter((s) => s.blink === 1).length;
  const clicked = samples.length ? samples[samples.length - 1].line : -1;

  return JSON.stringify({
    anchors: anchors.length,
    monotonic,
    firstLine: lines[0],
    lastLine: lines[lines.length - 1],
    targetLine,
    afterPreviewClick,
    previewPaneMax: previewPane.scrollHeight - previewPane.clientHeight,
    previewTopBefore: Math.round(before),
    previewTopAfter: Math.round(after),
    blinkAfterScroll,
    baseline: Math.round(baseline),
    sampleScrolls: samples.map((s) => s.scroll).join(','),
    sampleLines: samples.map((s) => s.line).join(','),
    maxDrift,
    offScreenCases,
    blinkedCases,
    scrollBeforeSourceClick: Math.round(baseline),
    scrollAfterSourceClick: Math.round(scrollAfterSourceClick),
    topLineBeforeSourceClick,
    topLineAfterSourceClick,
    clickedLine: clicked,
    foundMiddleBlock: Boolean(middle),
    scrollBeforeClick: Math.round(scrollBeforeClick),
    scrollAfterClick: Math.round(scrollAfterClick),
    caretBeforeClick,
    caretAfterClick,
    blinkedCases,
    blinkAfterClick
  });
})()`);

console.log("\n=== pane sync ===");
for (const [key, value] of Object.entries(sync)) console.log(`  ${key.padEnd(20)} ${value}`);

check("preview pane is scrollable", sync.previewPaneMax > 500);
check("every preview block is anchored", sync.anchors >= 10);
check("anchors are monotonic", sync.monotonic === true);
check(
  "preview click moves the caret",
  sync.afterPreviewClick.includes(`Ln ${sync.targetLine},`),
);
check("preview click finds a scrolled-into-view block", sync.foundMiddleBlock === true);
check(
  "preview click leaves the preview where it is",
  Math.abs(sync.scrollAfterClick - sync.scrollBeforeClick) < 4,
);
check(
  "preview click still moves the source caret",
  sync.caretAfterClick !== sync.caretBeforeClick,
);
check("source scroll drives the preview", sync.previewTopAfter > sync.previewTopBefore + 50);
check("scrolling never blinks", sync.blinkAfterScroll === 0);
check("clicking the source blinks the matching block", sync.blinkedCases >= 1);
check("the blink clears itself", sync.blinkAfterClick === 0);
check(
  "at least one clicked line had its block below the preview fold",
  sync.offScreenCases >= 1,
);
check(
  "no source click moves the preview",
  sync.maxDrift >= 0 && sync.maxDrift < 4,
);
check(
  "clicking the source keeps the panes aligned",
  sync.topLineAfterSourceClick === sync.topLineBeforeSourceClick,
);
check("source click lands lower in the document", sync.clickedLine > 20);

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

check("no console errors", consoleIssues.length === 0);

console.log("\n=== assertions ===");
let failed = 0;
for (const [label, ok] of expectations) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failed++;
}
if (consoleIssues.length > 0) {
  console.log("\n=== console output ===");
  for (const line of consoleIssues.slice(0, 10)) console.log("  " + line.split("\n")[0]);
}

ws.close();
console.log(`\n${expectations.length - failed}/${expectations.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
