// Does a misspelling get a wavy underline, and does turning spelling off remove it?
//
//   node scripts/spellcheck-test.mjs [port]
//
// The dictionary is the operating system's. This sets it to English explicitly,
// because automatic detection waits for a few sentences and a one-word document
// must not be underlined. The mark is a DOM decoration, so a synthetic insert
// and a preference click are the thing under test.

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const port = process.argv[2] ?? "9222";

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = list.find((target) => target.type === "page");
if (!page) {
  console.error("no page target; start the application with the debug port open");
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
const pending = new Map();
let id = 1;
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const i = id++;
    pending.set(i, resolve);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
ws.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  const resolve = pending.get(message.id);
  if (resolve) {
    pending.delete(message.id);
    resolve(message);
  }
});
await new Promise((resolve) => ws.addEventListener("open", resolve));
await send("Runtime.enable");

async function evaluate(expression) {
  const response = await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (response.result?.exceptionDetails) {
    throw new Error(response.result.exceptionDetails.exception?.description ?? "evaluate failed");
  }
  return response.result.result.value;
}

const checks = [];
function check(ok, label, detail = "") {
  checks.push(ok);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}

function row(label) {
  return `[...document.querySelectorAll('.prefs-row')].find((row) =>
    (row.querySelector('.prefs-label')?.textContent ?? '').replace(/\\?$/, '').trim() === ${JSON.stringify(label)})`;
}

await evaluate(`(() => {
  const scroller = document.querySelector('.cm-scroller');
  if (scroller) scroller.scrollTop = 0;
  const existing = document.querySelector('.prefs-overlay');
  if (!existing || existing.hidden) document.getElementById('btn-prefs').click();
  [...document.querySelectorAll('.prefs-section')].find((section) => section.textContent === 'Editor')?.click();
})()`);

let english = false;
for (let attempt = 0; attempt < 25 && !english; attempt++) {
  english = await evaluate(`(() => {
    const row = ${row("Dictionary")};
    const select = row?.querySelector('select');
    return Boolean(select && [...select.options].some((option) => option.value === 'en'));
  })()`);
  if (!english) await new Promise((resolve) => setTimeout(resolve, 200));
}
if (!english) console.log("  SKIP  English dictionary is not installed");

let testTypo = null;
let testSuggestions = [];
if (english) {
  const candidates = ["mispeling", "recieve", "wrogn", "helo", "zzqx", "qzxqv", "mispellzword"];
  const rejected = await evaluate(`window.__TAURI_INTERNALS__.invoke("spellcheck_check", {
    language: "en", words: ${JSON.stringify(candidates)}
  })`);
  for (const index of rejected) {
    const candidate = candidates[index];
    const suggestions = await evaluate(`window.__TAURI_INTERNALS__.invoke("spellcheck_suggest", {
      language: "en", word: ${JSON.stringify(candidate)}
    })`);
    if (!testTypo || suggestions.length) {
      testTypo = candidate;
      testSuggestions = suggestions;
    }
    if (suggestions.length) break;
  }
  if (!testTypo) console.log("  SKIP  installed dictionary accepted all test candidates");
}

if (english && testTypo) {
  await evaluate(`(() => {
    const select = ${row("Dictionary")}?.querySelector('select');
    select.value = 'en';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    document.querySelector('.prefs-close')?.click();
  })()`);

  // CodeMirror ignores a synthetic beforeinput. The caret has to be in the
  // viewport too: only the visible range is checked.
  const point = await evaluate(`(() => {
    const scroller = document.querySelector('.cm-scroller');
    if (scroller) scroller.scrollTop = 0;
    const line = document.querySelector('.cm-line');
    const rect = line.getBoundingClientRect();
    return { x: rect.left + 8, y: rect.top + rect.height / 2 };
  })()`);
  await send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: point.x,
    y: point.y,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  await send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: point.x,
    y: point.y,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
  await send("Input.insertText", { text: testTypo + " " });
  const inserted = await evaluate(
    `(document.querySelector('.cm-content')?.textContent ?? '').slice(0, 40)`,
  );

  let marks = 0;
  for (let attempt = 0; attempt < 20 && marks === 0; attempt++) {
    marks = await evaluate(`document.querySelectorAll('.cm-spell-error').length`);
    if (marks === 0) await new Promise((resolve) => setTimeout(resolve, 200));
  }
  check(marks > 0, "misspelling is underlined", `marks=${marks} text=${JSON.stringify(inserted)}`);

  await evaluate(`(() => {
    const existing = document.querySelector('.prefs-overlay');
    if (!existing || existing.hidden) document.getElementById('btn-prefs').click();
    [...document.querySelectorAll('.prefs-section')].find((section) => section.textContent === 'Editor')?.click();
    const box = ${row("Check spelling while typing")}?.querySelector('input[type=checkbox]');
    if (box && box.checked) {
      box.checked = false;
      box.dispatchEvent(new Event('change', { bubbles: true }));
    }
  })()`);

  const after = await evaluate(`document.querySelectorAll('.cm-spell-error').length`);
  check(after === 0, "turning spelling off clears the underline", `marks=${after}`);

  // Put the preference back. The inserted word is undone so a reused window
  // is not left with a typo at the top of the fixture.
  await evaluate(`(() => {
    const box = ${row("Check spelling while typing")}?.querySelector('input[type=checkbox]');
    if (box && !box.checked) {
      box.checked = true;
      box.dispatchEvent(new Event('change', { bubbles: true }));
    }
    [...document.querySelectorAll('.prefs-section')].find((section) => section.textContent === 'Editor')?.click();
    const select = ${row("Dictionary")}?.querySelector('select');
    if (select) {
      select.value = 'auto';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
    document.querySelector('.prefs-close')?.click();
    document.querySelector('.cm-content')?.focus();
  })()`);
  // CodeMirror owns undo. A keydown on the content element is the handler it
  // actually listens to; the native accelerator is not involved.
  await evaluate(`(() => {
    const target = document.querySelector('.cm-content');
    target.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'z', code: 'KeyZ', ctrlKey: true, bubbles: true, cancelable: true,
    }));
  })()`);
}

if (english && testTypo) {
  const root = path.resolve(tmpdir());
  const workDir = path.resolve(mkdtempSync(path.join(root, "mdraft-spelling-")));
  if (path.dirname(workDir) !== root || !path.basename(workDir).startsWith("mdraft-spelling-"))
    throw new Error("unexpected spelling test directory");
  try {
    const typo = testTypo;
    {
      await evaluate(`(() => {
        const existing = document.querySelector('.prefs-overlay');
        if (!existing || existing.hidden) document.getElementById('btn-prefs').click();
        [...document.querySelectorAll('.prefs-section')].find((section) => section.textContent === 'Editor')?.click();
        const select = ${row("Dictionary")}?.querySelector('select');
        select.value = 'en';
        select.dispatchEvent(new Event('change', { bubbles: true }));
        document.querySelector('.prefs-close')?.click();
      })()`);
      const fixtures = [
        ["check.html", `<p title="${typo}">${typo}</p><code>${typo}</code>`, 2],
        ["check.js", `// ${typo}\nconst label = "${typo}"; const endpoint = "/${typo}";\n`, 2],
        ["check.json", `{"title":"${typo}","url":"/${typo}"}`, 1],
        ["check.css", `/* ${typo} */ .${typo}::before { content: "${typo}"; }`, 2],
        [
          "check.typ",
          "= " +
            typo +
            "\n#strong[" +
            typo +
            "]\n" +
            String.fromCharCode(96) +
            typo +
            String.fromCharCode(96),
          2,
        ],
        ["check.tex", "\\section{" + typo + "}\n\\textbf{" + typo + "}\n\\cite{" + typo + "}", 2],
      ];
      for (const [name, source, expected] of fixtures) {
        const file = path.join(workDir, name);
        writeFileSync(file, source);
        await evaluate(`window.__TAURI_INTERNALS__.invoke("plugin:event|emit", {
          event: "open-files", payload: ${JSON.stringify([file])}
        })`);
        let marks = [];
        for (let attempt = 0; attempt < 40; attempt += 1) {
          marks = await evaluate(`(() => {
            if (!(document.getElementById("status-file")?.textContent ?? "").includes(${JSON.stringify(name)})) return [];
            return [...document.querySelectorAll(".cm-spell-error")].map((node) => node.textContent);
          })()`);
          if (marks.filter((mark) => mark === typo).length >= expected) break;
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
        check(
          marks.filter((mark) => mark === typo).length === expected,
          name + " checks prose and excludes code or paths",
          JSON.stringify(marks),
        );
      }
      if (testSuggestions.length === 0) {
        console.log("  SKIP  installed dictionary returned no suggestion for the test word");
      } else {
        const name = "escaped.json";
        const encoded = "\\u" + typo.charCodeAt(0).toString(16).padStart(4, "0") + typo.slice(1);
        const source = '{"title":"' + encoded + '","url":"/unchanged"}';
        const file = path.join(workDir, name);
        writeFileSync(file, source);
        await evaluate(`window.__TAURI_INTERNALS__.invoke("plugin:event|emit", {
          event: "open-files", payload: ${JSON.stringify([file])}
        })`);
        let marked = false;
        for (let attempt = 0; attempt < 40; attempt += 1) {
          marked = await evaluate(`(() => {
            if (!(document.getElementById("status-file")?.textContent ?? "").includes("escaped.json")) return false;
            return Boolean(document.querySelector(".cm-spell-error"));
          })()`);
          if (marked) break;
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
        check(marked, "escaped JSON word is underlined");
        if (marked) {
          await evaluate(`(() => {
            const target = document.querySelector(".cm-spell-error");
            const rect = target.getBoundingClientRect();
            target.dispatchEvent(new MouseEvent("contextmenu", {
              bubbles: true, cancelable: true, button: 2,
              clientX: rect.left + Math.min(rect.width / 2, 8), clientY: rect.top + rect.height / 2
            }));
          })()`);
          let suggestion = "";
          for (let attempt = 0; attempt < 30; attempt += 1) {
            suggestion = await evaluate(`[...document.querySelectorAll(".spell-menu button")]
              .map((button) => button.textContent)
              .find((label) => label !== "Ignore" && label !== "Add to dictionary") ?? ""`);
            if (suggestion) break;
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          check(Boolean(suggestion), "escaped JSON word offers a dictionary suggestion");
          if (suggestion) {
            await evaluate(`[...document.querySelectorAll(".spell-menu button")]
              .find((button) => button.textContent === ${JSON.stringify(suggestion)})?.click()`);
            const text = await evaluate(
              `[...document.querySelectorAll(".cm-line")].map((line) => line.textContent).join("\\n")`,
            );
            let valid = false;
            try {
              valid =
                JSON.parse(text).title === suggestion && JSON.parse(text).url === "/unchanged";
            } catch {}
            check(valid, "escaped JSON suggestion changes only the intended value", text);
            await evaluate(`document.querySelector(".cm-content")?.dispatchEvent(new KeyboardEvent("keydown", {
              key: "z", code: "KeyZ", ctrlKey: true, bubbles: true, cancelable: true
            }))`);
            const undone = await evaluate(
              `[...document.querySelectorAll(".cm-line")].map((line) => line.textContent).join("\\n")`,
            );
            check(undone === source, "one undo restores the exact escaped JSON source", undone);
            await new Promise((resolve) => setTimeout(resolve, 700));
            await evaluate(`(() => {
              const hold = window.__spellHold = { original: window.fetch, entered: false, release: null };
              window.fetch = async function(input, options) {
                const url = new URL(typeof input === 'string' ? input : input.url, location.href);
                if (url.hostname === 'ipc.localhost' && decodeURIComponent(url.pathname.slice(1)) === 'spellcheck_suggest') {
                  hold.entered = true;
                  await new Promise(resolve => { hold.release = resolve; });
                }
                return hold.original.call(window, input, options);
              };
              const target = document.querySelector('.cm-spell-error');
              const rect = target.getBoundingClientRect();
              target.dispatchEvent(new MouseEvent('contextmenu', {bubbles:true, cancelable:true, button:2,
                clientX:rect.left + Math.min(rect.width / 2, 8), clientY:rect.top + rect.height / 2}));
            })()`);
            try {
              let entered = false;
              for (let attempt = 0; attempt < 30 && !entered; attempt += 1) {
                entered = await evaluate(`window.__spellHold.entered`);
                if (!entered) await new Promise((resolve) => setTimeout(resolve, 100));
              }
              if (entered) {
                await evaluate(`(() => {
                  const view = document.querySelector('.cm-content')?.cmTile?.root?.view;
                  view.dispatch({changes:{from:view.state.doc.length, insert:' '}});
                  window.__spellHold.release();
                })()`);
                await new Promise((resolve) => setTimeout(resolve, 400));
                const staleSafe = await evaluate(`(() => {
                  const view = document.querySelector('.cm-content')?.cmTile?.root?.view;
                  return !document.querySelector('.spell-menu') && view.state.doc.toString() === ${JSON.stringify(source + " ")};
                })()`);
                check(
                  staleSafe,
                  "a delayed suggestion cannot reopen a menu or change an edited document",
                );
                await evaluate(`document.querySelector('.cm-content')?.dispatchEvent(new KeyboardEvent('keydown', {
                  key:'z', code:'KeyZ', ctrlKey:true, bubbles:true, cancelable:true
                }))`);
              } else check(false, "a delayed suggestion request was captured");
            } finally {
              await evaluate(
                `window.__spellHold.release?.(); window.fetch = window.__spellHold.original; delete window.__spellHold`,
              );
            }
          }
        }
        await evaluate(`(() => {
          document.getElementById("btn-prefs").click();
          [...document.querySelectorAll(".prefs-section")].find((section) => section.textContent === "Editor")?.click();
          const select = ${row("Dictionary for this document")}?.querySelector("select");
          if (!select) throw new Error("document dictionary is missing");
          select.value = "auto";
          select.dispatchEvent(new Event("change", { bubbles: true }));
          document.querySelector(".prefs-close")?.click();
        })()`);
        let savedChoice = false;
        for (let attempt = 0; attempt < 30 && !savedChoice; attempt += 1) {
          savedChoice =
            await evaluate(`window.__TAURI_INTERNALS__.invoke("get_settings").then((settings) =>
            settings.spellcheckDocumentLanguages.some((entry) => entry.path === ${JSON.stringify(file)} && entry.language === "auto"))`);
          if (!savedChoice) await new Promise((resolve) => setTimeout(resolve, 100));
        }
        check(savedChoice, "per-document dictionary choice is saved for its path");
        const copy = path.join(workDir, "escaped-copy.json");
        await evaluate(`(() => {
          const original = window.fetch;
          window.__spellTestOriginalFetch = original;
          window.fetch = async function(input, options) {
            const url = new URL(typeof input === 'string' ? input : input.url, location.href);
            if (url.hostname === 'ipc.localhost' && decodeURIComponent(url.pathname.slice(1)) === 'plugin:dialog|save')
              return new Response(JSON.stringify(${JSON.stringify(copy)}), {headers: {'Content-Type':'application/json', 'Tauri-Response':'ok'}});
            return original.call(window, input, options);
          };
        })()`);
        try {
          await evaluate(
            `window.__TAURI_INTERNALS__.invoke("plugin:event|emit", {event:"menu", payload:"file.saveAs"})`,
          );
          let copied = false;
          for (let attempt = 0; attempt < 50 && !copied; attempt += 1) {
            copied =
              await evaluate(`window.__TAURI_INTERNALS__.invoke("get_settings").then(settings =>
              settings.spellcheckDocumentLanguages.some(entry => entry.path === ${JSON.stringify(copy)} && entry.language === "auto") &&
              settings.spellcheckDocumentLanguages.some(entry => entry.path === ${JSON.stringify(file)} && entry.language === "auto"))`);
            if (!copied) await new Promise((resolve) => setTimeout(resolve, 100));
          }
          check(copied, "Save As copies the dictionary choice and retains the original");
        } finally {
          await evaluate(
            `window.fetch = window.__spellTestOriginalFetch; delete window.__spellTestOriginalFetch`,
          );
        }
        const readonlyFile = path.join(workDir, "readonly.html");
        writeFileSync(readonlyFile, `<p>${typo}</p>`);
        chmodSync(readonlyFile, 0o444);
        try {
          await evaluate(
            `window.__TAURI_INTERNALS__.invoke("plugin:event|emit", {event:"open-files", payload:${JSON.stringify([readonlyFile])}})`,
          );
          let marked = false;
          for (let attempt = 0; attempt < 40 && !marked; attempt += 1) {
            marked = await evaluate(
              `document.title.includes('readonly.html') && Boolean(document.querySelector('.cm-spell-error'))`,
            );
            if (!marked) await new Promise((resolve) => setTimeout(resolve, 200));
          }
          if (marked) {
            await evaluate(`(() => {
              const target = document.querySelector('.cm-spell-error'), rect = target.getBoundingClientRect();
              target.dispatchEvent(new MouseEvent('contextmenu', {bubbles:true, cancelable:true, button:2,
                clientX:rect.left + Math.min(rect.width / 2, 8), clientY:rect.top + rect.height / 2}));
            })()`);
            await new Promise((resolve) => setTimeout(resolve, 500));
            const labels = await evaluate(
              `[...document.querySelectorAll('.spell-menu button')].map(button => button.textContent)`,
            );
            check(
              labels.includes("Ignore") &&
                labels.every((label) => label === "Ignore" || label === "Add to dictionary"),
              "read-only text offers no spelling replacement",
              JSON.stringify(labels),
            );
            await evaluate(
              `[...document.querySelectorAll('.spell-menu button')].find(button => button.textContent === 'Ignore')?.click()`,
            );
            let ignoreState;
            for (let attempt = 0; attempt < 30; attempt += 1) {
              ignoreState =
                await evaluate(`window.__TAURI_INTERNALS__.invoke('get_settings').then(settings => ({
                saved: settings.spellcheckWords.some(word => word.toLowerCase() === ${JSON.stringify(typo.toLowerCase())}),
                marks: [...document.querySelectorAll('.cm-spell-error')].map(mark => mark.textContent)
              }))`);
              if (!ignoreState.saved && !ignoreState.marks.includes(typo)) break;
              await new Promise((resolve) => setTimeout(resolve, 100));
            }
            check(
              !ignoreState.saved && !ignoreState.marks.includes(typo),
              "Ignore removes the mark without saving a personal word",
              JSON.stringify(ignoreState),
            );
            await evaluate(
              `[...document.querySelectorAll('.doc-tab')].find(tab => tab.querySelector('.doc-tab-name')?.textContent === 'check.html')?.click()`,
            );
            let otherMarked = false;
            for (let attempt = 0; attempt < 30 && !otherMarked; attempt += 1) {
              otherMarked = await evaluate(
                `document.title.includes('check.html') && Boolean(document.querySelector('.cm-spell-error'))`,
              );
              if (!otherMarked) await new Promise((resolve) => setTimeout(resolve, 200));
            }
            check(otherMarked, "Ignore is limited to the document session");
            if (otherMarked) {
              await evaluate(`(() => {
                const target = document.querySelector('.cm-spell-error'), rect = target.getBoundingClientRect();
                target.dispatchEvent(new MouseEvent('contextmenu', {bubbles:true, cancelable:true, button:2,
                  clientX:rect.left + Math.min(rect.width / 2, 8), clientY:rect.top + rect.height / 2}));
              })()`);
              let added = false;
              for (let attempt = 0; attempt < 30 && !added; attempt += 1) {
                added = await evaluate(`(() => {
                  const button = [...document.querySelectorAll('.spell-menu button')].find(item => item.textContent === 'Add to dictionary');
                  if (!button) return false;
                  button.click(); return true;
                })()`);
                if (!added) await new Promise((resolve) => setTimeout(resolve, 100));
              }
              let persisted = false;
              for (let attempt = 0; attempt < 30 && !persisted; attempt += 1) {
                persisted =
                  await evaluate(`window.__TAURI_INTERNALS__.invoke('get_settings').then(settings =>
                  settings.spellcheckWords.some(word => word.toLowerCase() === ${JSON.stringify(typo.toLowerCase())}))`);
                if (!persisted) await new Promise((resolve) => setTimeout(resolve, 100));
              }
              check(added && persisted, "Add to dictionary persists a personal word");
            }
          } else check(false, "read-only misspelling is underlined");
        } finally {
          chmodSync(readonlyFile, 0o666);
        }
      }
    }
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

const passed = checks.filter(Boolean).length;
console.log(`\n${passed}/${checks.length} checks passed`);
process.exit(passed === checks.length ? 0 : 1);
