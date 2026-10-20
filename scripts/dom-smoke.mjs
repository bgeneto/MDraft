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
    themeIcon: (() => {
      const svg = document.querySelector('#btn-theme svg');
      return {
        paths: svg?.querySelectorAll('path').length ?? 0,
        circles: svg?.querySelectorAll('circle').length ?? 0,
      };
    })(),
    appClasses: document.getElementById('app').className,
    bootError: document.body.textContent.includes('Failed to start MDraft'),
    editorLines: q('.cm-line'),
    editorChars: (document.querySelector('.cm-content')?.textContent ?? '').length,
    editorFontSize: getComputedStyle(document.querySelector('.cm-editor')).fontSize,
    editorLineHeight: getComputedStyle(document.querySelector('.cm-scroller')).lineHeight,
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
    statusEncoding: document.getElementById('status-encoding')?.textContent ?? '',
    docTabs: document.querySelectorAll('.doc-tab').length,
    activeTab: document.querySelector('.doc-tab[aria-selected="true"] .doc-tab-name')?.textContent ?? '',
  });
})()`);

console.log("=== rendered DOM ===");
for (const [key, value] of Object.entries(doc)) console.log(`  ${key.padEnd(16)} ${value}`);

check("boot succeeded", !doc.bootError);
check("editor rendered", doc.editorLines > 5 && doc.editorChars > 200);
// 1.5 is the default line height; a fresh 15 px editor therefore measures
// 22.5 px per line. A changed font size without a proportional line box means
// the unitless value was replaced by a fixed one.
check(
  "editor starts at 15px with a proportional 1.5 line height",
  doc.editorFontSize === "15px" && doc.editorLineHeight === "22.5px",
);
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
check("a document tab is shown", doc.docTabs === 1);
check("the open tab is feature-tour.md", doc.activeTab === "feature-tour.md");
check("exactly one view mode is active", doc.activeModeButtons === 1);
check("no duplicate source-mode button", doc.hasLegacySourceButton === false);
check("status icons are inline SVG", doc.statusIcons.every((icon) => icon.isSvg));
check("status icons are at least 16px", doc.statusIcons.every((icon) => icon.size >= 16));
check("status icons inherit the theme colour", doc.statusIcons.every((icon) => icon.stroke.length > 0));
check(
  "the theme button shows the sun in light and the moon in dark",
  doc.theme === "dark"
    ? doc.themeIcon.paths === 1 && doc.themeIcon.circles === 0
    : doc.themeIcon.paths === 1 && doc.themeIcon.circles === 1,
);
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
    defaultExtensionOptions: (() => {
      const row = rows.find(
        (r) =>
          (r.querySelector('.prefs-label')?.textContent ?? '').replace('?', '').trim() ===
          'Default File Extension',
      );
      return row ? [...row.querySelectorAll('select option')].map((o) => o.value) : [];
    })(),
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
check("nine sections", prefs.sectionNames.split(",").length === 9);
check(
  "sections named and ordered like Typora",
  prefs.sectionNames === "Files,Editor,Image,Markdown,HTML,Export,Appearance,General,Typography",
);
check("first section selected", prefs.activeSection === "Files" && prefs.sectionHeading === "Files");
check("every section has rows", prefs.emptySections === "");
check("rows rendered", prefs.totalRows >= 24);
check("controls present", prefs.selects >= 2 && prefs.checkboxes >= 2 && prefs.buttons >= 1);
check("default extension offers Typst", prefs.defaultExtensionOptions.includes("typ"));
check("search box present", prefs.hasSearch);
const editorSection = prefs.perSection.find((section) => section.name === "Editor");
check(
  "spelling preference",
  Boolean(editorSection) &&
    editorSection.labels.includes("Check spelling while typing") &&
    editorSection.labels.includes("Dictionary"),
);

// The On Launch row gained a fourth choice: reopen the tab set that was open
// when the window last closed. A row that only moved its own select would look
// identical until the next launch, so the choice is read back through
// `get_settings` — and put back, so the suite leaves no trace.
const onLaunch = await evaluate(`(async () => {
  [...document.querySelectorAll('.prefs-section')]
    .find((s) => s.textContent === 'Files').click();
  const findRow = () => [...document.querySelectorAll('.prefs-row')].find((r) =>
    (r.querySelector('.prefs-label')?.textContent ?? '').replace('?', '').trim() === 'On Launch');
  const select = () => findRow()?.querySelector('select') ?? null;
  if (!select()) return JSON.stringify({ found: false });

  const initial = select().value;
  const options = [...select().options].map((o) => ({ value: o.value, label: o.textContent }));
  // The real help text is the span's title; its textContent is the "?" mark.
  const help = findRow().querySelector('.prefs-help')?.getAttribute('title') ?? '';

  select().value = 'tabs';
  select().dispatchEvent(new Event('change', { bubbles: true }));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let stored = '';
  for (let i = 0; i < 30 && stored !== 'tabs'; i += 1) {
    await sleep(100);
    stored = (await window.__TAURI_INTERNALS__.invoke('get_settings')).onLaunch;
  }

  const back = select();
  back.value = initial;
  back.dispatchEvent(new Event('change', { bubbles: true }));
  return JSON.stringify({ found: true, initial, options, help, stored, restored: back.value });
})()`);

console.log("\n=== the On Launch preference ===");
console.log(`  choices  ${onLaunch.options?.map((o) => o.label).join(" | ")}`);
check(
  "On Launch offers the remembered tab set",
  onLaunch.found === true &&
    onLaunch.options.map((o) => o.value).join(",") === "welcome,new,last,tabs" &&
    onLaunch.options[onLaunch.options.length - 1].label === "Reopen the last tabs",
);
check(
  "the fourth choice explains what is restored",
  /saved document/i.test(onLaunch.help ?? "") && /not restored/i.test(onLaunch.help ?? ""),
);
check("the choice reaches the settings file", onLaunch.stored === "tabs");
check("the preference is left as it was found", onLaunch.restored === onLaunch.initial);

// Search filters the navigation down to matching sections. A group heading is
// a searchable category too: "Recent Locations" is a heading, not a row, and
// used to leave the section with nothing the reader could see.
const search = await evaluate(`(() => {
  const input = document.querySelector('.prefs-search');
  const run = (value) => {
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return {
      sections: [...document.querySelectorAll('.prefs-section')].map((s) => s.textContent).join(','),
      labels: [...document.querySelectorAll('.prefs-label')].map((l) => l.textContent.replace('?','').trim()).join('|'),
      groups: [...document.querySelectorAll('.prefs-group')].map((g) => g.textContent).join('|'),
      buttons: [...document.querySelectorAll('.prefs-button')].map((b) => b.textContent).join('|'),
    };
  };
  const mermaid = run('mermaid');
  const locations = run('locations');
  const fileTree = run('file tree');
  const clear = run('clear recent');
  input.value = '';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return JSON.stringify({ mermaid, locations, fileTree, clear });
})()`);

console.log("\n=== preferences search ===");
console.log(`  mermaid    ${search.mermaid.sections} / ${search.mermaid.labels}`);
console.log(`  locations  ${search.locations.sections} / ${search.locations.groups} / ${search.locations.labels}`);
console.log(`  file tree  ${search.fileTree.sections} / ${search.fileTree.groups} / ${search.fileTree.labels}`);
console.log(`  clear      ${search.clear.sections} / ${search.clear.buttons}`);
check(
  "search narrows sections",
  search.mermaid.sections === "Markdown" &&
    search.locations.sections === "Files" &&
    search.fileTree.sections === "Files" &&
    search.clear.sections === "Files",
);
check(
  "search keeps the matching row or heading",
  /Enable Diagrams/.test(search.mermaid.labels) &&
    /Recent Locations/.test(search.locations.groups) &&
    /Show Hidden Folders and Files/.test(search.fileTree.labels) &&
    /Clear Recent Files/.test(search.clear.buttons),
);

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
  const allLabels = [...document.querySelectorAll('.prefs-row')]
    .map((row) => (row.querySelector('.prefs-label')?.textContent ?? '').replace('?', '').trim());
  const editorSizeIdx = allLabels.indexOf('Editor font size');
  const sourceEditorIdx = allLabels.indexOf('Source Editor');
  const wanted = ['Source Editor', 'Preview text', 'Preview headings', 'Preview code'];
  const rows = [...document.querySelectorAll('.prefs-row')].filter((row) => {
    const label = (row.querySelector('.prefs-label')?.textContent ?? '').replace('?', '').trim();
    return wanted.includes(label);
  });
  return JSON.stringify({
    editorAboveSource: editorSizeIdx !== -1 && sourceEditorIdx === editorSizeIdx + 1,
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
  faces.editorAboveSource &&
    faces.labels.length === 4 &&
    faces.tags.every((tag) => tag === "SELECT") &&
    faces.controls.every((count) => count === 1),
);
check(
  "face pickers list the faces and keep a selection",
  faces.options.every((count) => count >= 10) && faces.selected.every(Boolean),
);

// Math is drawn at KaTeX's own 1.21em, which is what makes it larger than the
// prose in the reference screenshot. The preference must visibly change the
// rendered formula — a stored number that nothing reads would pass any check
// that only looked at settings.json — and the field must refuse a value outside
// the range it advertises.
const mathScale = await evaluate(`(() => {
  [...document.querySelectorAll('.prefs-section')]
    .find((s) => s.textContent === 'Typography').click();
  const findRow = () => [...document.querySelectorAll('.prefs-row')].find((r) =>
    (r.querySelector('.prefs-label')?.textContent ?? '').replace('?', '').trim() === 'Math scale');
  const input = () => findRow()?.querySelector('input[type=number]') ?? null;
  const width = () => {
    const katex = document.querySelector('#preview .math-inline .katex');
    return katex ? Math.round(katex.getBoundingClientRect().width * 10) / 10 : 0;
  };
  if (!input()) return JSON.stringify({ found: false });

  const bounds = { min: input().min, max: input().max, value: input().value };
  const set = (value) => {
    const field = input();
    field.value = String(value);
    field.dispatchEvent(new Event('change', { bubbles: true }));
  };
  // Measure the 100% baseline explicitly: the starting value is now a preset
  // default (95 for System), not KaTeX's own ratio.
  set(100);
  const before = width();
  set(70);
  const at70 = width();
  set(40);                       // below the range: must clamp up
  const clampedLow = input().value;
  set(400);                      // above the range: must clamp down
  const clampedHigh = input().value;
  // Leave the stored setting as it was found, so the next suite does not
  // inherit a shrunken preview.
  set(bounds.value);
  const restored = width();
  return JSON.stringify({ found: true, bounds, before, at70, clampedLow, clampedHigh, restored });
})()`);

console.log("\n=== math scale preference ===");
console.log(`  bounds   ${mathScale.bounds?.min}–${mathScale.bounds?.max}  value ${mathScale.bounds?.value}`);
console.log(`  width    ${mathScale.at70} px at 70%, ${mathScale.before} px at 100%`);
console.log(`  clamps   ${mathScale.clampedLow} / ${mathScale.clampedHigh}`);

check(
  "math scale row is present and bounded 70–130",
  mathScale.found &&
    mathScale.bounds.min === "70" &&
    mathScale.bounds.max === "130" &&
    mathScale.bounds.value === "95",
);
check(
  "math scale visibly shrinks rendered math",
  mathScale.before > 20 && Math.abs(mathScale.at70 / mathScale.before - 0.7) < 0.05,
);
check(
  "math scale input clamps out-of-range values",
  mathScale.clampedLow === "70" && mathScale.clampedHigh === "130",
);
check(
  "math returns to its starting scale",
  mathScale.before > 20 &&
    Math.abs(mathScale.restored / mathScale.before - Number(mathScale.bounds.value) / 100) < 0.02,
);

// Editor font size, Preview font size and Math scale are reader adjustments,
// not part of a preset's identity. Editing one must leave the picker on the
// preset, and each preset must remember its own sizes across a round trip.
// An unvisited preset starts at its default sizes (15/18/92 for Serif,
// 15/18/80 for Renaissance, 15/16/95 for System).
const presetSizes = await evaluate(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const section = [...document.querySelectorAll('.prefs-section')]
    .find((s) => s.textContent === 'Typography');
  if (section) section.click();

  const row = (label) => [...document.querySelectorAll('.prefs-row')].find((r) =>
    (r.querySelector('.prefs-label')?.textContent ?? '').replace('?', '').trim() === label);
  const input = (label) => row(label)?.querySelector('input[type=number]') ?? null;
  const checkbox = (label) => row(label)?.querySelector('input[type=checkbox]') ?? null;
  const setNumber = (label, value) => {
    const field = input(label);
    if (!field) return false;
    field.value = String(value);
    field.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  };
  const active = () => document.querySelector('.prefs-choice.active')?.textContent ?? '';
  const choose = (label) => {
    const button = [...document.querySelectorAll('.prefs-choice')]
      .find((b) => b.textContent === label);
    if (!button) return false;
    button.click();
    return true;
  };
  const read = () => ({
    active: active(),
    editor: input('Editor font size')?.value,
    body: input('Preview font size')?.value,
    math: input('Math scale')?.value,
    oldstyle: checkbox('Oldstyle figures in prose')?.checked ?? false,
  });

  // System is the starting preset. Give it sizes that are not 16/16/90.
  if (
    !setNumber('Editor font size', 17) ||
    !setNumber('Preview font size', 18) ||
    !setNumber('Math scale', 92)
  ) {
    return JSON.stringify({ ok: false });
  }
  await sleep(200);
  const system = read();

  choose('Serif');
  await sleep(250);
  const serifFresh = read();
  setNumber('Editor font size', 20);
  setNumber('Preview font size', 19);
  setNumber('Math scale', 83);
  await sleep(200);
  const serif = read();

  choose('Renaissance');
  await sleep(250);
  const renaissance = read();
  choose('Serif');
  await sleep(250);
  const serifBack = read();
  choose('System');
  await sleep(250);
  const systemBack = read();

  // Leave the suite on the first-run sizes, whichever check failed.
  setNumber('Editor font size', 15);
  setNumber('Preview font size', 16);
  setNumber('Math scale', 95);
  await sleep(200);
  const reset = read();

  return JSON.stringify({
    ok: true,
    system,
    serifFresh,
    serif,
    renaissance,
    serifBack,
    systemBack,
    reset,
  });
})()`);

console.log("\n=== sizes remembered per preset ===");
for (const [name, size] of [
  ["System", presetSizes.system],
  ["Serif (fresh)", presetSizes.serifFresh],
  ["Serif", presetSizes.serif],
  ["Renaissance", presetSizes.renaissance],
  ["Serif (back)", presetSizes.serifBack],
  ["System (back)", presetSizes.systemBack],
  ["reset", presetSizes.reset],
]) {
  console.log(`  ${name.padEnd(14)} ${size?.editor}px / ${size?.body}px / ${size?.math}%  active ${size?.active}`);
}

check(
  "editing a size keeps the preset active",
  presetSizes.system?.active === "System" &&
    presetSizes.serif?.active === "Serif" &&
    presetSizes.renaissance?.active === "Renaissance" &&
    presetSizes.serifBack?.active === "Serif",
);
check(
  "an unvisited preset starts at its default sizes",
  presetSizes.serifFresh?.editor === "15" &&
    presetSizes.serifFresh?.body === "18" &&
    presetSizes.serifFresh?.math === "92" &&
    presetSizes.serifFresh?.oldstyle === true &&
    presetSizes.renaissance?.editor === "15" &&
    presetSizes.renaissance?.body === "18" &&
    presetSizes.renaissance?.math === "80" &&
    presetSizes.renaissance?.oldstyle === true,
);
check(
  "editor and preview font sizes are remembered per preset",
  presetSizes.system?.editor === "17" &&
    presetSizes.serif?.editor === "20" &&
    presetSizes.serifBack?.editor === "20" &&
    presetSizes.systemBack?.editor === "17" &&
    presetSizes.system?.body === "18" &&
    presetSizes.serif?.body === "19" &&
    presetSizes.serifBack?.body === "19" &&
    presetSizes.systemBack?.body === "18",
);
check(
  "math scale is remembered per preset",
  presetSizes.system?.math === "92" &&
    presetSizes.serif?.math === "83" &&
    presetSizes.serifBack?.math === "83" &&
    presetSizes.systemBack?.math === "92",
);
check(
  "the preset test restores 15 px / 95%",
  presetSizes.reset?.editor === "15" &&
    presetSizes.reset?.body === "16" &&
    presetSizes.reset?.math === "95" &&
    presetSizes.reset?.active === "System",
);

// Line Height lives under Editor, directly after Content Width. It stores a
// name rather than a number, applies only to the source pane, and must survive
// both a font-size change and a preset switch. The measurements are the point:
// at 15 px the three choices are 19.5 / 22.5 / 27 px, not merely a changed
// select value.
const lineHeightPref = await evaluate(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const section = [...document.querySelectorAll('.prefs-section')]
    .find((s) => s.textContent === 'Editor');
  if (section) section.click();
  await sleep(200);

  const labelOf = (row) => (row.querySelector('.prefs-label')?.textContent ?? '').replace('?', '').trim();
  const rows = () => [...document.querySelectorAll('.prefs-row')];
  const row = (label) => rows().find((r) => labelOf(r) === label);
  const select = (label) => row(label)?.querySelector('select') ?? null;
  const setSelect = (label, value) => {
    const field = select(label);
    if (!field) return false;
    field.value = value;
    field.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  };
  const setNumber = (label, value) => {
    const field = row(label)?.querySelector('input[type=number]') ?? null;
    if (!field) return false;
    field.value = String(value);
    field.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  };
  const computed = () => getComputedStyle(document.querySelector('.cm-scroller')).lineHeight;
  const stored = async () => (await window.__TAURI_INTERNALS__.invoke('get_settings')).editorLineHeight;

  const labels = rows().map(labelOf);
  const lineIndex = labels.indexOf('Line Height');
  const widthIndex = labels.indexOf('Content Width');
  const control = select('Line Height');
  if (!control) return JSON.stringify({ found: false });

  const options = [...control.options].map((o) => [o.value, o.textContent]);
  const initial = control.value;

  if (!setSelect('Line Height', 'compact')) return JSON.stringify({ found: false });
  await sleep(300);
  const compact = computed();
  let compactStored = '';
  for (let i = 0; i < 30 && compactStored !== 'compact'; i += 1) {
    await sleep(100);
    compactStored = await stored();
  }

  if (!setSelect('Line Height', 'normal')) return JSON.stringify({ found: false });
  await sleep(300);
  const normal = computed();

  if (!setSelect('Line Height', 'wide')) return JSON.stringify({ found: false });
  await sleep(300);
  const wide = computed();

  // The multiplier must follow Editor font size: 1.5 x 20 px = 30 px. The size
  // field lives in Typography, so move there and back to set each preference.
  const showSection = (name) => {
    const target = [...document.querySelectorAll('.prefs-section')]
      .find((s) => s.textContent === name);
    if (target) target.click();
  };
  showSection('Typography');
  await sleep(200);
  if (!setNumber('Editor font size', 20)) return JSON.stringify({ found: false });
  await sleep(250);
  showSection('Editor');
  await sleep(200);
  setSelect('Line Height', 'normal');
  await sleep(300);
  const scaled = computed();

  showSection('Typography');
  await sleep(200);
  setNumber('Editor font size', 15);
  await sleep(250);

  // A preset switch must not reset the global spacing. Serif remembers 20 px
  // from the earlier preset test, so Wide there is 1.8 x 20 = 36 px.
  showSection('Editor');
  await sleep(200);
  setSelect('Line Height', 'wide');
  await sleep(250);
  showSection('Typography');
  await sleep(200);
  const choose = (text) => {
    const button = [...document.querySelectorAll('.prefs-choice')]
      .find((b) => b.textContent === text);
    if (button) button.click();
  };
  choose('Serif');
  await sleep(350);
  const afterPreset = await stored();
  const presetHeight = computed();
  choose('System');
  await sleep(350);

  // Leave the suite on first-run state: System preset, Normal spacing.
  showSection('Editor');
  await sleep(200);
  setSelect('Line Height', 'normal');
  await sleep(300);
  const restored = select('Line Height')?.value ?? '';
  const restoredHeight = computed();

  return JSON.stringify({
    found: true,
    options,
    initial,
    directlyBelow: lineIndex >= 0 && lineIndex === widthIndex + 1,
    compact,
    compactStored,
    normal,
    wide,
    scaled,
    afterPreset,
    presetHeight,
    restored,
    restoredHeight,
  });
})()`);

console.log("\n=== Line Height preference ===");
console.log(`  choices  ${lineHeightPref.options?.map((o) => o[1] + '=' + o[0]).join(" | ")}`);
console.log(
  `  measured ${lineHeightPref.compact} / ${lineHeightPref.normal} / ${lineHeightPref.wide}` +
    ` · 20px Normal ${lineHeightPref.scaled} · after preset ${lineHeightPref.presetHeight}`,
);
check(
  "Line Height sits directly below Content Width",
  lineHeightPref.found === true && lineHeightPref.directlyBelow === true,
);
check(
  "Line Height offers Compact, Normal and Wide",
  lineHeightPref.options?.map((o) => o[0]).join(",") === "compact,normal,wide" &&
    lineHeightPref.options?.map((o) => o[1]).join(",") === "Compact,Normal,Wide",
);
check(
  "each Line Height choice changes the source line box",
  lineHeightPref.compact === "19.5px" &&
    lineHeightPref.normal === "22.5px" &&
    lineHeightPref.wide === "27px",
);
check(
  "the Line Height choice reaches the settings file",
  lineHeightPref.compactStored === "compact",
);
check(
  "the line height scales with Editor font size",
  lineHeightPref.scaled === "30px",
);
check(
  "switching presets keeps the line height",
  lineHeightPref.afterPreset === "wide" && lineHeightPref.presetHeight === "36px",
);
check(
  "the Line Height test restores Normal",
  lineHeightPref.restored === "normal" && lineHeightPref.restoredHeight === "22.5px",
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

  // At the default 16 px the whole visible source column can map to blocks that
  // still fit inside the preview pane, so the off-screen case this phase exists
  // to test never occurs. Give the preview a taller measure for the measurement
  // and restore the reader's size before returning.
  const previousBodySize = document.documentElement.style.getPropertyValue('--body-size');
  document.documentElement.style.setProperty('--body-size', '20px');
  await sleep(300);

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

  document.documentElement.style.setProperty('--body-size', previousBodySize || '16px');
  await sleep(200);

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
// Phase 3b — sync is continuous inside a block, at both font extremes
// ---------------------------------------------------------------------------
//
// The old mapping aligned a block only when its first line reached the top of
// the source and then held the preview still until the next block. It passed
// every check above because they only ask whether the preview moved at all.
// This phase scrolls a few pixels at a time through the longest block, once
// with a large preview font and once with a small one: a staircase gives one
// value, interpolation gives many, and a small nudge of the preview must come
// back to the same source position instead of jumping to the block start.

const interpolation = await evaluate(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const preview = document.getElementById('preview');
  const previewPane = document.getElementById('preview-pane');
  const scroller = document.querySelector('.cm-scroller');

  const openPrefs = () => {
    const overlay = document.querySelector('.prefs-overlay');
    if (!overlay || overlay.hidden) document.getElementById('btn-prefs').click();
    return overlay;
  };
  const closePrefs = () => {
    document.querySelector('.prefs-overlay')?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  };
  const setNumber = (sectionName, label, value) => {
    const section = [...document.querySelectorAll('.prefs-section')]
      .find((s) => s.textContent === sectionName);
    if (!section) return false;
    section.click();
    const row = [...document.querySelectorAll('.prefs-row')].find((r) =>
      (r.querySelector('.prefs-label')?.textContent ?? '').replace('?', '').trim() === label);
    const input = row?.querySelector('input[type=number]');
    if (!input) return false;
    input.value = String(value);
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  };
  const setFonts = (editorPx, previewPx) => {
    openPrefs();
    const ok =
      setNumber('Typography', 'Editor font size', editorPx) &&
      setNumber('Typography', 'Preview font size', previewPx);
    closePrefs();
    return ok;
  };

  // The longest source-line span between consecutive top-level blocks. A
  // one-line heading cannot show interpolation; the code fences can.
  const anchors = [...preview.querySelectorAll('[data-line]')];
  let bestIndex = 0;
  let bestGap = 0;
  for (let i = 0; i + 1 < anchors.length; i++) {
    const gap = Number(anchors[i + 1].dataset.line) - Number(anchors[i].dataset.line);
    if (gap > bestGap) { bestGap = gap; bestIndex = i; }
  }

  const measure = async (editorPx, previewPx) => {
    if (!setFonts(editorPx, previewPx)) return { ok: false, editorPx, previewPx };
    await sleep(500);

    // Put the block in the editor, then move it from 12% down to the top so the
    // top visible line is inside it rather than in the block before.
    anchors[bestIndex].dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true, clientX: 0, clientY: 0 }));
    await sleep(500);
    const start = Math.max(0, scroller.scrollTop + scroller.clientHeight * 0.12 + 2);
    const samples = [];
    for (const step of [0, 8, 16, 24, 32]) {
      scroller.scrollTop = start + step;
      await sleep(200);
      samples.push(Math.round(previewPane.scrollTop));
    }
    const distinct = new Set(samples).size;
    const monotonic = samples.every((value, i) => i === 0 || value >= samples[i - 1]);
    const moved = samples[samples.length - 1] - samples[0];
    const slope = moved / 32;

    // Reverse map: 3px further down the preview should move the source by only
    // the local slope, not jump to the top of the block. The tolerance follows
    // the measured slope, because 3 preview pixels are worth more source pixels
    // when the preview font is small.
    //
    // The floor is one line of the 40 px editor: the 11 px preview moves only
    // 5 px over the whole 32 px sweep, so a one-pixel reading error changes
    // 3/slope by 3.5 px. The test exists to catch a jump to the block's top,
    // which is hundreds of pixels; a 32 px floor does not hide that.
    const sourceBeforeInverse = scroller.scrollTop;
    previewPane.scrollTop = samples[samples.length - 1] + 3;
    await sleep(350);
    const inverseDelta = Math.abs(scroller.scrollTop - sourceBeforeInverse);
    const inverseLimit = Math.max(32, slope > 0.05 ? 3 / slope + 8 : 1000);

    return {
      ok: true,
      editorPx,
      previewPx,
      samples,
      distinct,
      monotonic,
      moved,
      inverseDelta,
      inverseLimit,
    };
  };

  const large = await measure(10, 32);
  const small = await measure(40, 11);

  // Restore the settings and the viewport whatever the measurements said.
  setFonts(16, 16);
  previewPane.scrollTop = 0;
  scroller.scrollTop = 0;
  await sleep(400);

  return JSON.stringify({ ok: true, gap: bestGap, large, small });
})()`);

console.log("\n=== sync interpolation at both font extremes ===");
for (const [label, measured] of [
  ["10px editor / 32px preview", interpolation.large],
  ["40px editor / 11px preview", interpolation.small],
]) {
  console.log(
    `  ${label}: ${measured?.samples?.join(", ")}  ` +
      `(moved ${measured?.moved} px, inverse drift ${measured?.inverseDelta} px ` +
      `of ${measured?.inverseLimit} allowed)`,
  );
}

const interpolates = (measured) =>
  measured?.ok === true &&
  measured.monotonic === true &&
  measured.distinct >= 4 &&
  measured.moved > 0;

check(
  "sync test found a multi-line block",
  interpolation.ok === true && interpolation.gap >= 3,
);
check(
  "sync interpolates with a large preview font",
  interpolates(interpolation.large),
);
check(
  "sync interpolates with a small preview font",
  interpolates(interpolation.small),
);
check(
  "reverse sync returns to the same source position at both extremes",
  interpolation.large?.inverseDelta <= interpolation.large?.inverseLimit &&
    interpolation.small?.inverseDelta <= interpolation.small?.inverseLimit,
);

// ---------------------------------------------------------------------------
// Phase 4 — mode flags and the native menu's check marks
// ---------------------------------------------------------------------------
//
// A check mark in a native menu is not in the DOM, so `Page.captureScreenshot`
// cannot see it. The `menu_state` command reports what the menu actually holds;
// the flags are measured through their attributes and text, not their colours.

console.log("\n=== mode flags and the native menu ===");

const FLAGS = ["flag-focus", "flag-typewriter", "flag-sync", "flag-auto-save", "flag-spellcheck"];
const menuOf = () => evaluate(`window.__TAURI_INTERNALS__.invoke("menu_state")`);
const menuChecked = (menu, id) => menu.some((entry) => entry.id === id && entry.checked);
const menuEnabled = (menu, id) => menu.find((entry) => entry.id === id)?.enabled !== false;

const readFlag = (id) =>
  evaluate(`(() => {
    const button = document.getElementById(${JSON.stringify(id)});
    const svg = button.querySelector('svg');
    return JSON.stringify({
      id: ${JSON.stringify(id)},
      svg: Boolean(svg),
      size: Math.round(svg?.getBoundingClientRect().width ?? 0),
      on: button.dataset.on,
      state: button.querySelector('.flag-state')?.textContent ?? '',
      pressed: button.getAttribute('aria-pressed'),
      inactive: button.dataset.inactive,
      focusClass: document.getElementById('app').classList.contains('focus-mode'),
      statusVisible: getComputedStyle(document.getElementById('statusbar')).display !== 'none',
      sidebarButtonVisible:
        getComputedStyle(document.getElementById('btn-sidebar')).display !== 'none',
    });
  })()`);

// Split view first: Sync Scroll is only meaningful there, and the previous
// phase may have left any mode behind.
await evaluate(`document.getElementById("mode-split").click()`);
await settle(400);

const flagState = await Promise.all(FLAGS.map(readFlag));
console.log(
  `  flags     ${flagState.map((f) => `${f.id.replace("flag-", "")}=${f.on}`).join(" ")}`,
);

check("five editor flags are present", flagState.length === 5 && flagState.every((f) => f.svg));
check("mode flags are inline SVG at least 16px", flagState.every((f) => f.svg && f.size >= 16));
check(
  "every flag states on/off and agrees with aria-pressed",
  flagState.every((f) =>
    f.on === "true"
      ? f.state === "on" && f.pressed === "true"
      : f.state === "off" && f.pressed === "false",
  ),
);

const menuBefore = await menuOf();
console.log(`  menu      ${menuBefore.filter((entry) => entry.checked).map((entry) => entry.id).join(", ")}`);
check("the menu exposes every checkable item", menuBefore.length >= 12);

const exclusiveGroups = [
  ["view.source", "view.split", "view.preview"],
  ["view.outline", "view.files", "view.recent"],
  ["themes.system", "themes.light", "themes.dark"],
];
check(
  "each exclusive menu group checks exactly one item",
  exclusiveGroups.every(
    (group) => group.filter((id) => menuChecked(menuBefore, id)).length === 1,
  ),
);

/** Click a flag, let the asynchronous menu sync land, then read both sides. */
async function toggle(id) {
  await evaluate(`document.getElementById(${JSON.stringify(id)}).click()`);
  await settle(450);
  return { flag: await readFlag(id), menu: await menuOf() };
}

const focusOn = await toggle("flag-focus");
check(
  "the Focus flag turns focus mode on and checks the menu",
  focusOn.flag.on === "true" &&
    focusOn.flag.state === "on" &&
    focusOn.flag.focusClass === true &&
    menuChecked(focusOn.menu, "view.focus"),
);
check("focus mode keeps the status bar visible", focusOn.flag.statusVisible === true);
check(
  "focus mode hides the sidebar controls instead of leaving dead buttons",
  focusOn.flag.sidebarButtonVisible === false &&
    !menuEnabled(focusOn.menu, "view.sidebar") &&
    !menuEnabled(focusOn.menu, "view.outline"),
);
const focusOff = await toggle("flag-focus");
check(
  "leaving focus mode restores the sidebar controls",
  focusOff.flag.sidebarButtonVisible === true &&
    menuEnabled(focusOff.menu, "view.sidebar") &&
    menuEnabled(focusOff.menu, "view.outline"),
);

const typewriterOn = await toggle("flag-typewriter");
check(
  "the Typewriter flag mirrors the setting and checks the menu",
  typewriterOn.flag.on === "true" &&
    typewriterOn.flag.state === "on" &&
    menuChecked(typewriterOn.menu, "view.typewriter"),
);
await toggle("flag-typewriter");

const syncOff = await toggle("flag-sync");
check(
  "the Sync flag turns sync off and clears the menu check",
  syncOff.flag.on === "false" &&
    syncOff.flag.state === "off" &&
    !menuChecked(syncOff.menu, "view.syncScroll"),
);
await toggle("flag-sync");

// Sync Scroll stays on but has no effect outside Split; the flag says so with
// the dimmed state rather than pretending the setting changed.
await evaluate(`document.getElementById("mode-source").click()`);
await settle(400);
const syncInSource = await readFlag("flag-sync");
await evaluate(`document.getElementById("mode-split").click()`);
await settle(400);
check("Sync is dimmed outside Split view", syncInSource.inactive === "true");

const autoOn = await toggle("flag-auto-save");
check(
  "the Auto Save flag mirrors the setting and checks the menu",
  autoOn.flag.on === "true" &&
    autoOn.flag.state === "on" &&
    menuChecked(autoOn.menu, "file.autoSave"),
);
await toggle("flag-auto-save");

// Spelling is the one flag with no menu item; the click is the toggle. Read it
// first so the check holds whatever a previous run left in settings.json.
const spellBefore = await readFlag("flag-spellcheck");
const spellToggled = await toggle("flag-spellcheck");
check(
  "the Spell flag flips the setting and states the new state",
  spellToggled.flag.on !== spellBefore.on &&
    spellToggled.flag.state === (spellToggled.flag.on === "true" ? "on" : "off") &&
    spellToggled.flag.inactive === "false",
);
await toggle("flag-spellcheck");

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
