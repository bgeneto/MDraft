// End-to-end check for local TEXMF libraries in a running, isolated MDraft.
//
//   node scripts/latex-texmf-test.mjs [port]
//
// Start the app with samples/latex-texmf/main.tex. The check creates a private
// two-root library in a temporary folder outside the project, registers it with
// the real `latex_texmf_*` commands, and proves through compiled PDF text — not a
// PDF header or a source regex — that the class, a transitive package, an
// optional .def and a Lua module were resolved from the library in order:
// root 0 wins over root 1, the project wins over both. It then turns the
// library off (the compile must fail, naming the class), checks that a
// conversion snapshot never carries libraries, and that a second unrelated
// project captures the same library. With MDRAFT_TEST_TEX_BIN set, the same
// library is compiled by that installed distribution as well.
//
// Network: the bundled engine downloads standard packages from its pinned
// mirror, as the other bundled LaTeX layers do; the private files never are.

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { emitMenu, openPage, sleep, useWasmTex } from "./cdp-page.mjs";

const port = Number(process.argv[2] ?? 9222);
const checks = [];
function check(ok, label, detail = "") {
  checks.push({ ok, label, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}
function finish() {
  const failed = checks.filter((entry) => !entry.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

// ---- the private library, outside every project ---------------------------
const library = join(tmpdir(), `mdraft-texmf-e2e-${process.pid}`);
const write = (path, text) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};
const zero = join(library, "zero-texmf");
const one = join(library, "one-packages");
rmSync(library, { recursive: true, force: true });
write(
  join(zero, "tex/latex/mdraftlib/mdraftlib.cls"),
  [
    "\\NeedsTeXFormat{LaTeX2e}\\ProvidesClass{mdraftlib}",
    "\\LoadClassWithOptions{article}",
    "\\RequirePackage{mdraftdep}",
    "\\InputIfFileExists{mdraftlib-extra.def}{}{\\newcommand\\mdraftextramark{EXTRAMISSING}}",
    "\\ifdefined\\directlua\\AtBeginDocument{\\directlua{tex.sprint(require('mdraftlibmod').text)}\\par}\\fi",
    "",
  ].join("\n"),
);
write(
  join(zero, "tex/latex/mdraftlib/mdraftlib-extra.def"),
  "\\newcommand\\mdraftextramark{\\mbox{EXTRADEFOK}}\n",
);
write(
  join(zero, "tex/latex/mdraftdep/mdraftdep.sty"),
  "\\ProvidesPackage{mdraftdep}\\typeout{RESULT-DEP: zero}\\newcommand\\mdraftdepmark{\\mbox{DEPROOTZERO}}\n",
);
write(join(zero, "scripts/mdraftlib/mdraftlibmod.lua"), 'return { text = "LUAMODULEOK" }\n');
write(join(zero, "doc/latex/mdraftlib/README.md"), "not captured\n");
// Root 1 is a plain packages folder: it loses mdraftdep to root 0 and owns
// mdraftlocal.
write(
  join(one, "mdraftdep.sty"),
  "\\ProvidesPackage{mdraftdep}\\typeout{RESULT-DEP: one}\\newcommand\\mdraftdepmark{\\mbox{DEPROOTONE}}\n",
);
write(
  join(one, "nested/mdraftlocal.sty"),
  "\\ProvidesPackage{mdraftlocal}\\newcommand\\mdraftlocalmark{\\mbox{LOCALPKGROOTONE}}\n",
);

const page = await openPage(port);
const errors = [];
page.onException((text) => errors.push(text));

async function invoke(command, args = {}) {
  return page.evaluate(`(async () => {
    try {
      return { ok: true, value: await window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)}) };
    } catch (error) {
      return { ok: false, error: String(error) };
    }
  })()`);
}
async function waitFor(expression, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await page.evaluate(expression)) return true;
    await sleep(300);
  }
  return false;
}
const pdfText = () =>
  page.evaluate(
    `[...document.querySelectorAll(".typst-page .textLayer")].map((layer) => layer.textContent).join(" ")`,
  );

async function showPreferences() {
  await page.evaluate(`(() => {
    if (document.querySelector('.prefs-overlay')?.hidden !== false) document.getElementById('btn-prefs')?.click();
    [...document.querySelectorAll('.prefs-section')].find(n => n.textContent.trim() === 'LaTeX')?.click();
  })()`);
  await waitFor(
    `!!document.querySelector('.prefs-local-packages') && ![...document.querySelectorAll('.prefs-folder-status')].some(n => n.textContent === 'Checking…')`,
    10000,
  );
}

async function screenshot(name) {
  const directory = process.env.MDRAFT_COMPILED_UI_SCREENSHOTS;
  if (!directory) return;
  mkdirSync(directory, { recursive: true });
  const result = await page.send("Page.captureScreenshot", { format: "png", fromSurface: true });
  if (!result.result?.data) throw new Error("Preferences screenshot failed");
  writeFileSync(join(directory, `${name}.png`), Buffer.from(result.result.data, "base64"));
}

try {
  if (!(await waitFor('!!document.querySelector(".cm-content")', 30000)))
    throw new Error("Editor did not open.");
  await useWasmTex(page);
  const defaults = await invoke("latex_texmf_list");
  check(
    defaults.ok &&
      defaults.value.roots.length === 1 &&
      defaults.value.roots[0].enabled &&
      defaults.value.roots[0].layout === "packages" &&
      existsSync(defaults.value.roots[0].resolved),
    "the default packages folder exists and is registered before Preferences opens",
  );
  await showPreferences();
  const normal = await page.evaluate(`(() => {
    const block = document.querySelector('.prefs-local-packages');
    const text = document.querySelector('.prefs-panel').textContent;
    return { buttons: [...block.querySelectorAll('button')].map(n => n.textContent),
      additional: !!block.querySelector('.prefs-additional-folders'),
      noProse: !/Search order|Getting started|Trust and network|Personal folder/.test(text) };
  })()`);
  check(
    normal.buttons.join("|") === "Open|Choose folder…" && !normal.additional,
    "normal configuration has exactly two folder actions and no additional-folder UI",
  );
  check(normal.noProse, "technical paragraphs and the personal-folder category are absent");
  await screenshot("latex-preferences-normal");

  // Stub only the IPC transport for native dialogs. The production handlers
  // still run, and a cancelled picker must not call configure at all.
  await page.evaluate(`(() => {
    window.__texmfDialogs = { original: window.fetch, next: null, picks: 0, changes: 0 };
    window.fetch = async function(input, options) {
      const state = window.__texmfDialogs;
      const url = new URL(typeof input === 'string' ? input : input.url, location.href);
      const command = decodeURIComponent(url.pathname.slice(1));
      if (url.hostname === 'ipc.localhost' && command === 'plugin:dialog|message') {
        return new Response(JSON.stringify('Ok'), {headers: {'Content-Type':'application/json', 'Tauri-Response':'ok'}});
      }
      if (url.hostname === 'ipc.localhost' && command === 'plugin:dialog|open') {
        state.picks++;
        return new Response(JSON.stringify(state.next), {headers: {'Content-Type':'application/json', 'Tauri-Response':'ok'}});
      }
      if (url.hostname === 'ipc.localhost' && command === 'latex_texmf_configure') state.changes++;
      return state.original.call(window, input, options);
    };
    [...document.querySelectorAll('.prefs-local-packages button')].find(n => n.textContent === 'Choose folder…').click();
  })()`);
  await waitFor(
    `window.__texmfDialogs.picks === 1 && ![...document.querySelectorAll('.prefs-local-packages button')].some(n => n.disabled)`,
    10000,
  );
  check(
    await page.evaluate(`window.__texmfDialogs.changes === 0`),
    "cancelling the folder picker leaves the registration untouched",
  );
  await page.evaluate(`window.__texmfDialogs.next = ${JSON.stringify(one)};
    document.querySelector('[data-prefs-focus="primary-choose"]').click();`);
  const replaced = await waitFor(
    `document.querySelector('.prefs-folder-path')?.textContent === ${JSON.stringify(one)} &&
    !document.querySelector('[data-prefs-focus="primary-choose"]').disabled`,
    10000,
  );
  const selected = await invoke("latex_texmf_list");
  check(
    replaced &&
      selected.ok &&
      selected.value.roots.length === 1 &&
      selected.value.roots[0].id === defaults.value.roots[0].id &&
      selected.value.roots[0].layout === "packages",
    "choosing a folder replaces the primary registration through the real UI",
  );
  await page.evaluate(`window.__texmfDialogs.next = ${JSON.stringify(join(library, "missing"))};
    document.querySelector('[data-prefs-focus="primary-choose"]').click();`);
  await waitFor(
    `window.__texmfDialogs.picks === 3 && !document.querySelector('[data-prefs-focus="primary-choose"]').disabled`,
    10000,
  );
  check(
    await page.evaluate(
      `window.__texmfDialogs.changes === 1 && document.querySelector('.prefs-folder-path').textContent === ${JSON.stringify(one)}`,
    ),
    "an unavailable choice leaves the working folder unchanged",
  );
  await page.evaluate(
    `window.fetch = window.__texmfDialogs.original; delete window.__texmfDialogs;`,
  );

  await page.evaluate(`document.querySelector('[data-prefs-focus="primary-enabled"]').focus()`);
  for (const type of ["keyDown", "keyUp"]) {
    await page.send("Input.dispatchKeyEvent", {
      type,
      key: " ",
      code: "Space",
      windowsVirtualKeyCode: 32,
    });
  }
  check(
    await waitFor(
      `document.activeElement?.dataset.prefsFocus === 'primary-enabled' &&
    !document.activeElement.disabled && !document.activeElement.checked`,
      10000,
    ),
    "keyboard toggle keeps focus after the asynchronous configuration update",
  );
  for (const type of ["keyDown", "keyUp"]) {
    await page.send("Input.dispatchKeyEvent", {
      type,
      key: " ",
      code: "Space",
      windowsVirtualKeyCode: 32,
    });
  }
  await waitFor(
    `document.querySelector('[data-prefs-focus="primary-enabled"]').checked &&
    !document.querySelector('[data-prefs-focus="primary-enabled"]').disabled`,
    10000,
  );
  await invoke("latex_texmf_configure", { action: { type: "setPrimary" } });

  const defaultId = defaults.value.roots[0].id;
  await invoke("latex_texmf_configure", {
    action: { type: "setLayout", id: defaultId, layout: "tds" },
  });
  const tds = await invoke("latex_texmf_list");
  check(
    tds.ok && tds.value.roots[0].resolved === defaults.value.personalPath,
    "TEXMF mode selects the standard tree root without adding a second library",
  );
  // The precedence fixture below deliberately owns exactly two external roots.
  await invoke("latex_texmf_configure", { action: { type: "remove", id: defaultId } });
  await page.evaluate(`document.getElementById('btn-prefs')?.click()`);
  await emitMenu(page, "view.split");

  // ---- registration and inspection -----------------------------------------
  const candidate = await invoke("latex_texmf_inspect", {
    ids: null,
    candidate: zero,
    layout: null,
  });
  check(
    candidate.ok &&
      candidate.value[0].detectedLayout === "tds" &&
      candidate.value[0].names.classes.includes("mdraftlib"),
    "a TEXMF tree is recognised before it is added",
    candidate.ok ? JSON.stringify(candidate.value[0].names) : candidate.error,
  );
  let config = await invoke("latex_texmf_configure", { action: { type: "addFolder", path: zero } });
  check(
    config.ok && config.value.roots.length === 1,
    "the TEXMF tree is registered",
    config.ok ? "" : config.error,
  );
  config = await invoke("latex_texmf_configure", { action: { type: "addFolder", path: one } });
  check(
    config.ok && config.value.roots[1]?.layout === "packages",
    "a plain folder is registered with the packages layout",
    config.ok ? config.value.roots.map((root) => root.layout).join(",") : config.error,
  );
  const duplicate = await invoke("latex_texmf_configure", {
    action: { type: "addFolder", path: zero },
  });
  check(
    !duplicate.ok && /already registered/.test(duplicate.error),
    "registering the same folder twice is refused",
  );
  const reports = await invoke("latex_texmf_inspect", { ids: null, candidate: null, layout: null });
  check(
    reports.ok && reports.value.every((report) => report.status === "ok"),
    "both roots inspect cleanly",
    reports.ok
      ? reports.value.map((report) => `${report.label}:${report.status}:${report.files}`).join(" ")
      : reports.error,
  );
  check(
    reports.ok && reports.value[1].issues.some((issue) => issue.code === "shadowed"),
    "the shadowed package in root 1 is reported, not blocked",
  );

  // Preferences shows the group, its rows and its search terms.
  await page.evaluate(`(async () => {
    document.getElementById("btn-prefs")?.click();
    await new Promise((r) => setTimeout(r, 500));
    [...document.querySelectorAll(".prefs-section")].find((n) => n.textContent.trim() === "LaTeX")?.click();
  })()`);
  // The rows load the registered list asynchronously when the section is drawn.
  await waitFor(
    `(document.querySelector(".prefs-panel")?.textContent ?? "").includes("one-packages")`,
    10000,
  );
  const prefs = await page.evaluate(`document.querySelector(".prefs-panel")?.textContent ?? ""`);
  check(prefs.includes("Local packages"), "Preferences › LaTeX shows the library group");
  check(
    prefs.includes("zero-texmf") && prefs.includes("one-packages"),
    "both folders are listed in order",
  );
  check(
    await page.evaluate(`(() => {
      const details = document.querySelector('.prefs-additional-folders');
      return details && !details.open && details.querySelector('summary').textContent === 'Additional folders (1)';
    })()`),
    "existing additional folders are preserved behind a collapsed disclosure",
  );
  await page.evaluate(`document.querySelector('.prefs-additional-folders > summary').click()`);
  check(
    await page.evaluate(
      `document.querySelector('.prefs-additional-folders').open && !!document.querySelector('summary[aria-label="Actions for one-packages"]')`,
    ),
    "additional folders have accessible overflow actions",
  );
  await screenshot("latex-preferences-existing-folders");
  await page.evaluate(`document.querySelector('.prefs-additional-folders > summary').click();
    document.querySelector('.prefs-panel').style.width = '420px'; window.dispatchEvent(new Event('resize'));`);
  await sleep(250);
  check(
    await page.evaluate(`(() => {
    const panel = document.querySelector('.prefs-content');
    return panel.scrollWidth <= panel.clientWidth + 1;
  })()`),
    "the folder control fits a narrow Preferences panel",
  );
  await page.evaluate(
    `document.querySelector('.prefs-local-packages').scrollIntoView({ block: 'start' })`,
  );
  await screenshot("latex-preferences-narrow");
  await page.evaluate(
    `document.querySelector('.prefs-panel').style.width = ''; window.dispatchEvent(new Event('resize'));`,
  );
  check(
    await page.evaluate(`(() => {
    const search = document.querySelector('.prefs-search');
    search.value = 'TEXMF'; search.dispatchEvent(new Event('input', { bubbles: true }));
    const found = !!document.querySelector('.prefs-local-packages');
    search.value = ''; search.dispatchEvent(new Event('input', { bubbles: true }));
    return found;
  })()`),
    "Preferences search finds the complete folder control by TEXMF",
  );
  check(
    await page.evaluate(
      `[...document.querySelectorAll('.prefs-label:has(.prefs-help)')].every(n => n.textContent.replace(/\\?/g, '').trim())`,
    ),
    "help icons always accompany a visible label",
  );
  await page.evaluate(`document.getElementById("btn-prefs")?.click()`);

  if ((await invoke("latex_status")).value !== true) {
    // Installation can exceed CDP's per-request deadline on a cold cache.
    await page.evaluate(`(() => {
      window.__texmfInstall = { done: false, error: null };
      window.__TAURI_INTERNALS__.invoke('install_latex').then(
        () => { window.__texmfInstall.done = true; },
        error => { window.__texmfInstall.error = String(error); window.__texmfInstall.done = true; }
      );
    })()`);
    if (!(await waitFor("window.__texmfInstall.done", 180000)))
      throw new Error("Engine setup exceeded 180 seconds");
    const error = await page.evaluate("window.__texmfInstall.error");
    if (error) throw new Error(`Could not prepare the bundled engine: ${error}`);
    // Synchronize the frontend's settings copy through its own checkbox.
    await showPreferences();
    await page.evaluate(`(() => {
      const row = [...document.querySelectorAll('.prefs-row')].find(n => n.querySelector('.prefs-label')?.textContent.includes('Enable bundled TeX'));
      const checkbox = row?.querySelector('input[type=checkbox]');
      if (checkbox && !checkbox.checked) checkbox.click();
    })()`);
    if (
      !(await waitFor(
        `(() => {
      const row = [...document.querySelectorAll('.prefs-row')].find(n => n.querySelector('.prefs-label')?.textContent.includes('Enable bundled TeX'));
      return row?.querySelector('input[type=checkbox]')?.checked;
    })()`,
        10000,
      ))
    )
      throw new Error("Bundled engine switch did not update");
    await page.evaluate(`document.getElementById('btn-prefs')?.click()`);
  }
  // ---- the bundled engine, through the real preview -------------------------
  await emitMenu(page, "view.latexCompile");
  const rendered = await waitFor(
    `[...document.querySelectorAll(".typst-page .textLayer")].some((layer) => layer.textContent.includes("LOCALPKGROOTONE"))`,
    240000,
  );
  const text = await pdfText();
  check(rendered, "the bundled engine compiled the project with the library", text.slice(0, 160));
  check(text.includes("DEPROOTZERO") && !text.includes("DEPROOTONE"), "root 0 wins over root 1");
  check(text.includes("EXTRADEFOK"), "an optional .def inside the library resolves");
  check(text.includes("LUAMODULEOK"), "a Lua module inside the library resolves");
  check(
    await page.evaluate(
      `document.querySelector(".compiled-state-label")?.textContent === "PDF ready"`,
    ),
    "the preview reports a current PDF",
  );

  // ---- a second, unrelated project captures the same library ----------------
  const second = resolve("samples/latex-texmf/second/main.tex");
  const snapshot = await invoke("latex_project_snapshot", {
    path: second,
    overlays: [],
    includeLibraries: true,
  });
  check(
    snapshot.ok && snapshot.value.texmf?.roots.length === 2 && snapshot.value.files.length === 1,
    "a second project captures the library without copying it into the project",
    snapshot.ok
      ? `${snapshot.value.files.length} project file(s), ${snapshot.value.texmf?.files.length} library file(s)`
      : snapshot.error,
  );
  check(
    snapshot.ok && !snapshot.value.texmf.files.some((file) => file.path.includes("README")),
    "documentation in the library is not captured",
  );
  const conversion = await invoke("latex_project_snapshot", {
    path: second,
    overlays: [],
    includeLibraries: false,
  });
  check(
    conversion.ok && conversion.value.texmf === undefined,
    "a conversion snapshot never carries libraries",
  );

  // ---- an installed distribution compiles the same library ------------------
  if (process.env.MDRAFT_TEST_TEX_BIN) {
    const validated = await invoke("latex_native_validate", {
      directory: process.env.MDRAFT_TEST_TEX_BIN,
    });
    if (validated.ok && snapshot.ok) {
      for (const engine of ["pdflatex", "lualatex"]) {
        if (!validated.value.engines.some((entry) => entry.id === engine)) continue;
        await invoke("latex_native_set_engine", { engine });
        await invoke("latex_native_set_enabled", { enabled: true });
        const native = await invoke("latex_native_compile", {
          request: {
            job: `texmf-${engine}`,
            mainFile: snapshot.value.mainFile,
            files: snapshot.value.files,
            texmf: snapshot.value.texmf,
          },
        });
        check(
          native.ok &&
            native.value.success &&
            typeof native.value.pdf === "string" &&
            native.value.log.includes("RESULT-DEP: zero") &&
            !native.value.log.includes("RESULT-DEP: one"),
          `${engine} (installed) compiles the second project with the library`,
          native.ok ? (native.value.error ?? "") : native.error,
        );
      }
      await invoke("latex_native_set_enabled", { enabled: false });
    } else {
      check(false, "the installed distribution validates", validated.error ?? "");
    }
  } else {
    console.log("  SKIP  installed distribution: MDRAFT_TEST_TEX_BIN is not set (not run)");
  }

  // ---- turning the library off must not silently change versions -----------
  const ids = config.value.roots.map((root) => root.id);
  await invoke("latex_texmf_configure", {
    action: { type: "setEnabled", id: ids[0], enabled: false },
  });
  await emitMenu(page, "view.latexCompile");
  const failedOff = await waitFor(
    `/mdraftlib\\.cls/.test(document.body.textContent) && !document.querySelector("[data-latex-current]")`,
    180000,
  );
  check(failedOff, "with the class's folder off, the compile fails and names the class");
  check(
    await page.evaluate(`!!document.querySelector(".latex-manage-libraries")`),
    "the failure offers Manage local packages…",
  );

  // ---- a missing enabled folder blocks with a remedy ------------------------
  await invoke("latex_texmf_configure", {
    action: { type: "setEnabled", id: ids[0], enabled: true },
  });
  rmSync(one, { recursive: true, force: true });
  const missing = await invoke("latex_project_snapshot", {
    path: second,
    overlays: [],
    includeLibraries: true,
  });
  check(
    !missing.ok && /not available/.test(missing.error) && /Turn it off/.test(missing.error),
    "an enabled folder that disappeared blocks the compile with a remedy",
    missing.ok ? "captured anyway" : missing.error,
  );

  // ---- removal unregisters only ------------------------------------------------
  for (const id of ids) await invoke("latex_texmf_configure", { action: { type: "remove", id } });
  const after = await invoke("latex_texmf_list");
  check(after.ok && after.value.roots.length === 0, "remove unregisters the folders");
  check(
    (await import("node:fs")).existsSync(join(zero, "tex/latex/mdraftlib/mdraftlib.cls")),
    "remove never deletes the reader's files",
  );
  check(errors.length === 0, "no page exceptions", errors.join(" | "));
} catch (error) {
  check(false, "the run completed", String(error));
} finally {
  for (const root of (await invoke("latex_texmf_list")).value?.roots ?? [])
    await invoke("latex_texmf_configure", { action: { type: "remove", id: root.id } });
  rmSync(library, { recursive: true, force: true });
  page.close();
}
finish();
