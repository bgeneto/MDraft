//! Export-through-pandoc test for a running MDraft window.
//!
//!     .\src-tauri\target\release\MDraft.exe samples\feature-tour.md
//!     node scripts\export-test.mjs 9222
//!     node scripts\export-test.mjs 9222 --install   # also downloads pandoc (~40 MB)
//!
//! This drives the Rust command directly instead of clicking through the UI,
//! because the export starts with a *native* save dialog and no DOM test can
//! dismiss one. Everything after the dialog is exercised for real: pandoc runs,
//! files land on disk, and their bytes are inspected.
//!
//! `--install` additionally exercises the self-install path, which is far too
//! slow and too network-dependent to sit in the default run.
//!
//! The window must have `samples/feature-tour.md` (or any document) open, and
//! `%APPDATA%\io.github.bernh.mdraft\settings.json` must have been deleted so
//! the default format list is in place.

import { mkdirSync, readFileSync, rmSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import ts from "typescript";
import { runInNewContext } from "node:vm";

const port = process.argv[2] ?? "9222";
const withInstall = process.argv.includes("--install");
const workDir = join(tmpdir(), "mdraft-export-test");

// The print document is written by the application, not by this script, so the
// old copy has to go before the button is pressed or a stale one would satisfy
// the checks below.
rmSync(join(tmpdir(), "mdraft-print"), { recursive: true, force: true });

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = list.find((t) => t.type === "page");
if (!page) {
  console.error("No page target. Is the app running with --remote-debugging-port?");
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
const pending = new Map();
let nextId = 1;

const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

ws.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  const entry = pending.get(message.id);
  if (!entry) return;
  pending.delete(message.id);
  if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
  else entry.resolve(message.result);
});

await new Promise((resolve, reject) => {
  ws.addEventListener("open", resolve);
  ws.addEventListener("error", reject);
});
await send("Runtime.enable");

/** Evaluate an expression in the page, surfacing page-side rejections. */
async function evaluate(expression) {
  const result = await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) {
    const text =
      result.exceptionDetails.exception?.description ??
      result.exceptionDetails.text ??
      "unknown page error";
    throw new Error(text);
  }
  return result.result.value;
}

const checks = [];
const check = (ok, label, detail) => {
  checks.push({ ok, label, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
};

// ---------------------------------------------------------------------------

rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });

// The Rust side reads the format list from settings, so a format is identified
// by id. These are the built-in defaults.
const invoke = (cmd, args) =>
  evaluate(
    `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args ?? {})})`,
  );

const call = async (cmd, args) => {
  // Invoke rejects with the command's error string, so a failure is captured
  // rather than thrown: several checks below expect one.
  return evaluate(`
    window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args ?? {})})
      .then((value) => ({ ok: true, value }))
      .catch((error) => ({ ok: false, error: String(error) }))
  `);
};

// (1) The IPC bridge this script depends on must exist.
const bridge = await evaluate(`typeof window.__TAURI_INTERNALS__?.invoke === "function"`);
check(bridge === true, "the Tauri IPC bridge is reachable from the page");

// (2) Pandoc detection.
const status = await call("pandoc_status");
const found = status.ok && status.value?.found === true;
check(
  found,
  "pandoc_status finds pandoc",
  found
    ? `version ${status.value.version} via ${status.value.source}`
    : (status.error ?? "not found"),
);
// `pdfEngine` is null when nothing was found, which is a real answer rather
// than a missing field.
check(
  status.ok && status.value !== null && "pdfEngine" in status.value,
  "pandoc_status reports the PDF engine state",
  status.value?.pdfEngine ? status.value.pdfEngine : "none installed (null)",
);

// The document that is open in the window, used for ${inputPath} and to check
// that an export cannot overwrite its own source.
const documentPath = await evaluate(`
  (() => {
    const name = document.title.replace(/^• /, "").split(" — ")[0];
    return name;
  })()
`);

// (3) A real export of every format that needs no extra tools.
const formats = [
  { id: "docx", ext: "docx", probe: "zip", marker: "word/document.xml" },
  { id: "epub", ext: "epub", probe: "zip", marker: "META-INF/container.xml" },
  { id: "rtf", ext: "rtf", probe: "text", marker: "{\\rtf" },
  { id: "latex", ext: "tex", probe: "text", marker: "\\documentclass" },
  { id: "rst", ext: "rst", probe: "text", marker: null },
  { id: "opml", ext: "opml", probe: "text", marker: "<opml" },
];

for (const format of formats) {
  // A space in the path on purpose: arguments are passed as a token list, so
  // this must work without any quoting.
  const output = join(workDir, `out with space.${format.ext}`);
  const result = await call("run_export", {
    request: {
      formatId: format.id,
      markdown:
        "# Export probe\n\nSome **bold** text, a table and maths $e^{i\\pi}+1=0$.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n",
      outputPath: output,
      inputPath: null,
    },
  });

  if (!result.ok) {
    check(false, `${format.id} exports`, result.error.split("\n")[0]);
    continue;
  }
  if (!existsSync(output) || statSync(output).size === 0) {
    check(false, `${format.id} exports`, "pandoc reported success but wrote nothing");
    continue;
  }

  const bytes = readFileSync(output);
  if (format.probe === "zip") {
    const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b;
    // Zip stores entry names uncompressed in the local headers, so the marker
    // can be searched for directly without unpacking.
    const hasMarker = bytes.includes(Buffer.from(format.marker));
    check(
      isZip && hasMarker,
      `${format.id} really exports (${statSync(output).size} bytes)`,
      isZip ? (hasMarker ? format.marker : `no ${format.marker}`) : "not a zip",
    );
  } else {
    const text = bytes.toString("utf8");
    check(
      !format.marker || text.includes(format.marker),
      `${format.id} really exports (${statSync(output).size} bytes)`,
      format.marker ?? "non-empty",
    );
  }
}

// (3b) An AsciiDoc source uses pandoc's AsciiDoc reader, not the Markdown one.
{
  const output = join(workDir, "asciidoc-source.tex");
  const result = await call("run_export", {
    request: {
      formatId: "latex",
      markdown: "= Export Probe\n\n== A Section\n\nA *strong* word and latexmath:[x^2].\n",
      outputPath: output,
      inputPath: null,
      language: "asciidoc",
    },
  });
  if (!result.ok) {
    check(
      false,
      "an AsciiDoc source exports through the AsciiDoc reader",
      result.error.split("\n")[0],
    );
  } else {
    const text = readFileSync(output, "utf8");
    check(
      text.includes("\\section{A Section}") && text.includes("\\textbf{strong}"),
      "an AsciiDoc source exports through the AsciiDoc reader",
      text.split("\n").find((line) => line.includes("section")) ?? "no section",
    );
  }
}

// (3c) The AsciiDoc frontend renders the source to HTML and sends
//      `language: "html"`. Asciidoctor emits `\(…\)` / `\[…\]`; without the
//      backslash math extensions pandoc's HTML reader prints them literally.
{
  const output = join(workDir, "asciidoc-rendered.tex");
  const result = await call("run_export", {
    request: {
      formatId: "latex",
      markdown: "<p>Inline \\(x^2\\) and display:</p><p>\\[\\int_0^1 x^2\\,dx\\]</p>\n",
      outputPath: output,
      inputPath: null,
      language: "html",
    },
  });
  if (!result.ok) {
    check(false, "rendered AsciiDoc HTML keeps its mathematics", result.error.split("\n")[0]);
  } else {
    const text = readFileSync(output, "utf8");
    check(
      text.includes("\\(x^2\\)") && text.includes("\\int_0^1"),
      "rendered AsciiDoc HTML keeps its mathematics",
      text.split("\n").find((line) => line.includes("x^2")) ?? "no formula",
    );
  }
}

// (4) An export must not be able to clobber the document it is exporting.
//     Pandoc reads stdin and would happily truncate the source file.
if (documentPath && documentPath.endsWith(".md")) {
  const inputPath = await evaluate(`
    window.__TAURI_INTERNALS__.invoke("startup_file").then((p) => p ?? null)
  `);
  if (inputPath) {
    const guarded = await call("run_export", {
      request: {
        formatId: "docx",
        markdown: "# should not be written\n",
        outputPath: inputPath,
        inputPath,
      },
    });
    check(
      !guarded.ok && /editing/i.test(guarded.error),
      "an export refuses to overwrite its own source document",
      guarded.ok ? "it was allowed" : guarded.error.split("\n")[0],
    );
  } else {
    check(
      true,
      "an export refuses to overwrite its own source document",
      "skipped: no startup file",
    );
  }
} else {
  check(
    true,
    "an export refuses to overwrite its own source document",
    "skipped: no document open",
  );
}

// (5) An unknown format is reported, not silently ignored.
const unknown = await call("run_export", {
  request: {
    formatId: "no-such-format",
    markdown: "x",
    outputPath: join(workDir, "x.docx"),
    inputPath: null,
  },
});
check(
  !unknown.ok && /unknown export format/i.test(unknown.error),
  "an unknown format id is reported",
);

// (5b) The after-export options are global, and the HTML path runs them too.
//
//      HTML is written by the frontend, so it never reaches `run_export`. This
//      calls the same helper through `run_after_export` and uses a command that
//      exits immediately: the folder and file flags share the code path, so the
//      outcome proves the wiring without opening a window in the test.
const settingsBefore = await call("get_settings");
if (!settingsBefore.ok) throw new Error(settingsBefore.error);
const afterCommand = process.platform === "win32" ? "exit 0" : "true";
const htmlPath = join(workDir, "after-export.html");
await call("write_document", {
  path: htmlPath,
  content: "<!doctype html><h1>after export</h1>",
  lineEnding: "\n",
  hadBom: false,
});
try {
  const saved = await call("save_settings", {
    settings: {
      ...settingsBefore.value,
      afterOpenLocation: false,
      afterOpenFile: false,
      afterRunCommand: true,
      afterCommand,
    },
  });
  check(saved.ok, "the global after-export settings are saved", saved.ok ? "" : saved.error);

  const after = await call("run_after_export", { path: htmlPath });
  check(
    after.ok && after.value.afterErrors.length === 0,
    "the HTML export runs the after-export options",
    after.ok ? after.value.after.join(", ") || "nothing ran" : after.error,
  );
  check(
    after.ok && after.value.after.length === 1 && after.value.after[0] === `ran ${afterCommand}`,
    "only the enabled after-export action runs",
    after.ok ? after.value.after.join(", ") : after.error,
  );
} finally {
  // Never leave the developer's settings changed, even if a check throws.
  await call("save_settings", { settings: settingsBefore.value });
}
const restored = await call("get_settings");
check(
  restored.ok &&
    restored.value.afterOpenLocation === settingsBefore.value.afterOpenLocation &&
    restored.value.afterOpenFile === settingsBefore.value.afterOpenFile &&
    restored.value.afterRunCommand === settingsBefore.value.afterRunCommand &&
    restored.value.afterCommand === settingsBefore.value.afterCommand,
  "the after-export settings are restored after the test",
);

// (6) A relative output path is refused: the save dialog always returns an
//     absolute one, so a relative path means something went wrong upstream.
const relative = await call("run_export", {
  request: { formatId: "docx", markdown: "x", outputPath: "relative.docx", inputPath: null },
});
check(!relative.ok && /relative/i.test(relative.error), "a relative output path is refused");

// (7) PDF without a LaTeX engine must fail loudly rather than leaving an empty
//     file that looks like a successful export.
const pdfPath = join(workDir, "out.pdf");
const pdf = await call("run_export", {
  request: { formatId: "pdf", markdown: "# PDF probe\n", outputPath: pdfPath, inputPath: null },
});
if (status.value?.pdfEngine) {
  check(pdf.ok && existsSync(pdfPath), "PDF exports (an engine is installed)");
} else {
  // The message has to do more than report a number: pandoc's exit code 47
  // means "PDF program not found", and a user seeing only "exited with 47"
  // has no way to know a TeX distribution is what is missing.
  const explained = !pdf.ok && /pdf|latex|engine|pdflatex/i.test(pdf.error);
  check(
    explained,
    "PDF without a LaTeX engine fails with an explanation",
    pdf.ok ? "it claimed success" : pdf.error.split("\n").slice(0, 3).join(" / "),
  );
  check(
    !existsSync(pdfPath),
    "a failed PDF export leaves no file behind",
    existsSync(pdfPath) ? "a file was created anyway" : "nothing written",
  );
}

// (8) The self-install path, when asked for. This is the only check that talks
//     to GitHub and the only one that changes the machine: pandoc is unpacked
//     into the application's own data directory, never system-wide.
if (withInstall) {
  console.log("\n  (downloading pandoc; this takes a minute)");
  const installed = await call("install_pandoc");
  if (!installed.ok) {
    check(false, "install_pandoc downloads and unpacks pandoc", installed.error.split("\n")[0]);
  } else {
    check(
      installed.value.found === true && installed.value.source === "managed",
      "install_pandoc installs a copy MDraft owns",
      `${installed.value.version} at ${installed.value.path}`,
    );
    check(
      existsSync(installed.value.path),
      "the installed binary is on disk",
      installed.value.path,
    );

    // The managed copy must win over whatever is on PATH, otherwise installing
    // it would have no effect on the exports that follow.
    const after = await call("pandoc_status");
    check(
      after.ok && after.value.source === "managed" && after.value.path === installed.value.path,
      "the installed copy takes precedence over PATH",
      `now using ${after.value?.version} via ${after.value?.source}`,
    );

    // And an export must still work, through the new binary.
    const output = join(workDir, "after-install.docx");
    const reExport = await call("run_export", {
      request: {
        formatId: "docx",
        markdown: "# After install\n\nExported through the managed pandoc.\n",
        outputPath: output,
        inputPath: null,
      },
    });
    check(
      reExport.ok && existsSync(output) && readFileSync(output).subarray(0, 2).toString() === "PK",
      "exporting still works through the managed pandoc",
      reExport.ok ? `${statSync(output).size} bytes` : reExport.error.split("\n")[0],
    );
  }
}

// (9) PDF through the system browser.
//
//     This is the route that needs nothing installed, so it is worth guarding
//     closely: the print document is assembled from the same preview HTML as
//     everything else, and forgetting one of the two stylesheets produces a
//     document that still looks plausible while the mathematics has collapsed
//     and the code has lost its colours.
// Capture only the final browser handoff, writing its real article through
// Rust. This suite must not leave browser tabs behind or select native PDF
// merely because its button also says "as PDF".
const printRoot = join(tmpdir(), "mdraft-print");
mkdirSync(printRoot, { recursive: true });
await evaluate(`(() => {
  const state = window.__browserExport = { original: window.fetch, lastPath: null };
  window.fetch = async function(input, options) {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    if (url.hostname === 'ipc.localhost' && decodeURIComponent(url.pathname.slice(1)) === 'print_document') {
      const args = JSON.parse(options.body);
      const target = ${JSON.stringify(printRoot)} + '/' + args.name + '.html';
      await window.__TAURI_INTERNALS__.invoke('write_document', { path: target, content: args.html, lineEnding: '\\n', hadBom: false });
      state.lastPath = target;
      return new Response(JSON.stringify(target), { headers: { 'Content-Type': 'application/json', 'Tauri-Response': 'ok' } });
    }
    return state.original.call(window, input, options);
  };
})()`);
const pdfButton = await evaluate(`
  (() => {
    const prefsButton = document.getElementById('btn-prefs');
    const existing = document.querySelector('.prefs-overlay');
    if (!existing || existing.hidden) prefsButton.click();
    const overlay = document.querySelector('.prefs-overlay');
    if (!overlay || overlay.hidden) return 'panel did not open';

    const section = [...document.querySelectorAll('.prefs-section')]
      .find((s) => /^export$/i.test(s.textContent.trim()));
    if (!section) return 'no Export section';
    section.click();

    const button = [...document.querySelectorAll('.prefs-button')]
      .find((b) => /as PDF/i.test(b.textContent));
    if (!button) return 'no PDF button';
    return 'available';
  })()
`);
check(pdfButton === "available", "the Export panel offers the native PDF button", pdfButton);

if (pdfButton === "available") {
  await invoke("plugin:event|emit", { event: "menu", payload: "export.pdf.browser" });
  // The command writes the file before handing it to the browser, so it is on
  // disk almost immediately; poll rather than assume a fixed delay.
  const stem = (documentPath ?? "untitled").replace(/\.[^.]+$/, "");
  const printPath = join(tmpdir(), "mdraft-print", `${stem}.html`);
  for (let i = 0; i < 40 && !existsSync(printPath); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  if (!existsSync(printPath)) {
    check(false, "the PDF print document is written", printPath);
  } else {
    const html = readFileSync(printPath, "utf8");
    check(true, "the PDF print document is written", `${Math.round(html.length / 1024)} KB`);

    // Without KaTeX's layout rules the mathematics silently collapses: fractions
    // lose their bar and radicals grow one across the page.
    check(
      /katex(\.min)?\.css/.test(html),
      "the print document carries the KaTeX stylesheet",
      /katex(\.min)?\.css/.test(html) ? "linked" : "MISSING — maths would collapse",
    );
    check(
      /\.hljs/.test(html),
      "the print document carries the token colours",
      /\.hljs/.test(html) ? "present" : "MISSING — code would print uncoloured",
    );
    check(html.includes("window.print()"), "the print document opens the print dialog by itself");
    // The article must be the rendered one, not the markdown source.
    check(
      html.includes("katex") && !/<h1[^>]*>#\s/.test(html),
      "the print document holds rendered output, not markdown",
    );
    // Dark token colours on white paper are unreadable, and background graphics
    // are off by default in most browsers.
    check(
      !/:root\{color-scheme:dark\}|background:#1e1e1e/.test(html),
      "the print document is forced light regardless of the editor theme",
    );

    // The reader's typefaces have to travel with the file. A browser opening a
    // document in the temporary directory cannot reach the application's assets,
    // so a family named in a stack but not embedded is silently substituted —
    // and the PDF stops matching the preview at the moment the reader had gone
    // to the trouble of choosing a face.
    const faces = [...html.matchAll(/@font-face\{font-family:"([^"]+)"[^}]*?base64,/g)].map(
      (m) => m[1],
    );
    // A system stack names no bundled family, so there is no file to embed and
    // the reader's own machine supplies the face. That is the correct outcome
    // for the default preset, not a missing asset.
    const bundledNames = [
      "Source Serif 4",
      "Source Sans 3",
      "JetBrains Mono",
      "Fira Code",
      "EB Garamond",
      "IBM Plex Mono",
      "Bodoni Moda",
      "Archivo",
      "Jost",
      "Azeret Mono",
      "Alegreya",
      "Caveat",
      "Victor Mono",
    ];
    const first = (stack) => stack.split(",")[0].replace(/["']/g, "").trim();
    const stacks = [...html.matchAll(/--font-(?:source|body|heading|code):([^;}]+)/g)].map((m) =>
      first(m[1]),
    );
    const winners = [...new Set(stacks.filter((name) => bundledNames.includes(name)))];
    const bundledStack = winners.length > 0;
    check(
      bundledStack ? faces.length > 0 : faces.length === 0,
      bundledStack
        ? "the print document embeds the chosen typefaces"
        : "system font stacks need no embedded faces",
      faces.length > 0
        ? `${faces.length} face(s): ${[...new Set(faces)].join(", ")}`
        : bundledStack
          ? "none embedded — exports would fall back"
          : "system stack, nothing to embed",
    );
    check(
      !/src:url\("(?!#|data:|\/)/.test(html),
      "the print document needs no font file from the network or the app",
    );
    // A fallback in a stack can never be used once the family ahead of it is
    // embedded, and carrying it costs hundreds of kilobytes per export. The
    // check is generic: every embedded family must be the first family of one
    // of the four role stacks.
    check(
      [...new Set(faces)].every((face) => winners.includes(face)),
      "only a family that wins its stack is embedded",
      `winners ${winners.join(", ") || "none"}; faces ${[...new Set(faces)].join(", ") || "none"}`,
    );
    check(
      /--font-body:/.test(html) && /--font-heading:/.test(html),
      "the export carries the role declarations, not just the faces",
    );
    // The preview scales KaTeX from a CSS variable; the exported document has no
    // stylesheet of its own, so the variable and the rule that consumes it must
    // both travel or the PDF ignores the reader's math size.
    check(
      /--math-scale:\d/.test(html) && /var\(--math-scale\)/.test(html),
      "the export carries the reader's math scale",
      /--math-scale:\d/.test(html)
        ? "variable and rule present"
        : "MISSING — math scale would be ignored",
    );
    // The same contract for code: the wrapper repeats the preview's 86% / 88%
    // ratios, and without the variable beside them the reader's Code scale
    // would silently stop at 100%.
    check(
      /--code-scale:\d/.test(html) && /var\(--code-scale[,)]/.test(html),
      "the export carries the reader's code scale",
      /--code-scale:\d/.test(html)
        ? "variable and rule present"
        : "MISSING — code scale would be ignored",
    );
  }

  // Close the browser tab the export opened, so a test run does not leave one
  // behind for every invocation.
  await evaluate(`'clicked'`);
}

// (10) The Preferences panel really shows an export format editor.
const panel = await evaluate(`
  (() => {
    const prefsButton = document.getElementById('btn-prefs');
    if (!prefsButton) return { opened: false, reason: 'no #btn-prefs' };

    // #btn-prefs *toggles* the panel, so clicking unconditionally closes a
    // panel that a previous run left open. Establish the state first.
    const existing = document.querySelector('.prefs-overlay');
    if (!existing || existing.hidden) prefsButton.click();

    const overlay = document.querySelector('.prefs-overlay');
    if (!overlay || overlay.hidden) return { opened: false, reason: 'the overlay did not open' };

    const sections = [...document.querySelectorAll('.prefs-section')];
    const exportSection = sections.find((s) => /^export$/i.test(s.textContent.trim()));
    if (!exportSection) {
      return { opened: true, found: false, names: sections.map((s) => s.textContent.trim()) };
    }
    exportSection.click();

    const rows = [...document.querySelectorAll('.prefs-row')];
    const labels = rows.map((r) => r.querySelector('.prefs-label')?.textContent?.replace('?', '').trim() ?? '');
    return {
      opened: true,
      found: true,
      heading: document.querySelector('.prefs-section-title')?.textContent ?? '',
      labels,
      selects: document.querySelectorAll('.prefs-control select').length,
      checkboxes: document.querySelectorAll('.prefs-row-checkbox input[type=checkbox]').length,
      // The format picker must list every configured target.
      choices: [...(document.querySelector('.prefs-control select')?.options ?? [])].map((o) => o.value),
    };
  })()
`);

check(
  panel.opened && panel.found,
  "Preferences has an Export section",
  panel.found ? panel.heading : (panel.names ?? panel.reason ?? "").toString(),
);

if (panel.found) {
  check(
    panel.labels.includes("Arguments") &&
      panel.labels.includes("Extra Arguments") &&
      panel.labels.includes("Style Reference"),
    "the Export section exposes the pandoc argument fields",
    `rows: ${panel.labels.join(", ")}`,
  );
  check(
    panel.choices.length >= formats.length + 1,
    "the format picker lists every configured target",
    panel.choices.join(", "),
  );
  check(
    panel.labels.includes("Open the exported file") && panel.labels.includes("Run a command"),
    "the after-export options are present",
  );
  check(
    panel.checkboxes >= 3 && panel.selects >= 1,
    "the Export section has real controls, not just notes",
    `${panel.selects} select(s), ${panel.checkboxes} checkbox(es)`,
  );
}

// Leave the Preferences panel closed, so the next suite starts from the state it
// expects. #btn-prefs toggles, so a suite that opens the panel and walks away
// makes an unrelated test fail.
await evaluate(`
  (() => {
    const overlay = document.querySelector('.prefs-overlay');
    if (overlay && !overlay.hidden) {
      overlay.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    }
    return 'closed';
  })()
`);

// Print and HTML Save share buildExportArticle. Exercise that real app route,
// then the actual pure HTML wrapper and Rust writer, without a native picker.
// Tauri's immutable invoke property must not be weakened just to stub a dialog.
const currencyOutput = join(workDir, "currency-native.html");
await evaluate(
  "document.querySelector('.cm-content').dispatchEvent(new KeyboardEvent('keydown',{key:'n',code:'KeyN',ctrlKey:true,bubbles:true}))",
);
await new Promise((resolve) => setTimeout(resolve, 450));
await evaluate("document.querySelector('.cm-content').focus()");
await send("Input.insertText", {
  text: "# Currency\n\nR$50 R$ 10.000 R$ 15.200,75 US$5 US$5.00 C$8,123.50 and $ a + b $ and $c + d$",
});
await new Promise((resolve) => setTimeout(resolve, 500));
await evaluate("window.__browserExport.lastPath=null");
await invoke("plugin:event|emit", { event: "menu", payload: "export.pdf.browser" });
for (let n = 0; n < 40 && !(await evaluate("window.__browserExport.lastPath")); n++)
  await new Promise((resolve) => setTimeout(resolve, 250));
const nativePrintPath = await evaluate("window.__browserExport.lastPath");
const nativePrint =
  nativePrintPath && existsSync(nativePrintPath) ? readFileSync(nativePrintPath, "utf8") : "";
const article = /<article\b[\s\S]*?<\/article>/.exec(nativePrint)?.[0] ?? "";
// Load only these actual pure function declarations: the complete browser
// module also imports CSS and DOM libraries and is not a Node test module.
const wrapperSource = readFileSync(new URL("../src/markdown.ts", import.meta.url), "utf8");
const wrapperTree = ts.createSourceFile("markdown.ts", wrapperSource, ts.ScriptTarget.Latest, true);
const declarations = wrapperTree.statements
  .filter(
    (node) =>
      ts.isFunctionDeclaration(node) &&
      ["escapeHtml", "wrapStandaloneHtml"].includes(node.name?.text),
  )
  .map((node) => node.getText(wrapperTree))
  .join("\n");
const wrapper = { exports: {} };
runInNewContext(
  ts.transpileModule(declarations, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText,
  wrapper,
);
const nativeHtml = wrapper.exports.wrapStandaloneHtml("Currency", article, false);
const savedNative = await call("write_document", {
  path: currencyOutput,
  content: nativeHtml,
  lineEnding: "\n",
  hadBom: false,
});
const html = existsSync(currencyOutput) ? readFileSync(currencyOutput, "utf8") : "";
check(
  savedNative.ok &&
    ["R$50", "R$ 10.000", "R$ 15.200,75", "US$5", "US$5.00", "C$8,123.50"].every((value) =>
      html.includes(value),
    ),
  "native HTML preserves all six currency spellings",
  savedNative.ok ? "shared app article + actual HTML wrapper + Rust writer" : savedNative.error,
);
check(
  (html.match(/class="math-(?:inline|display)"/g) ?? []).length === 2 &&
    html.includes('data-tex="a + b"') &&
    html.includes('data-tex="c + d"'),
  "native HTML exports only the two intended equations",
);
await evaluate(
  "document.querySelector('.prefs-overlay').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))",
);
console.log(
  "  Pandoc validation uses its existing source-reader dialect; padded-dollar parity is outside this change.",
);
await evaluate("window.fetch=window.__browserExport.original;delete window.__browserExport");
ws.close();
rmSync(workDir, { recursive: true, force: true });

const passed = checks.filter((c) => c.ok).length;
console.log(`\n${passed}/${checks.length} checks passed`);
process.exit(passed === checks.length ? 0 : 1);
