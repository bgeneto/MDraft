//! Second-launch handoff and initial multi-file opening.
//!
//!     npm test -- --only single-instance
//!
//! The harness launches the staged executable with two documents. This suite
//! then starts the same executable again, from the repository directory, and
//! requires the running window to receive the path as a tab. The second process
//! must exit before creating a WebView, so there is still exactly one page
//! target.

import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const port = Number(process.argv[2] ?? 9222);
const exe = process.env.MDRAFT_EXE;
const repo = process.env.MDRAFT_REPO ?? process.cwd();
if (!exe) {
  throw new Error("MDRAFT_EXE is required; run through npm test -- --only single-instance");
}

const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = targets.find((target) => target.type === "page");
if (!page) throw new Error(`No page target for the single-instance test on port ${port}`);
const ws = new WebSocket(page.webSocketDebuggerUrl);
const pending = new Map();
let nextId = 0;
ws.addEventListener("message", (event) => {
  const response = JSON.parse(event.data);
  const resolve = pending.get(response.id);
  if (resolve) {
    pending.delete(response.id);
    resolve(response);
  }
});
await new Promise((resolve) => ws.addEventListener("open", resolve));

function send(method, params = {}) {
  return new Promise((resolve) => {
    const id = ++nextId;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
}
await send("Runtime.enable");

async function evaluate(expression) {
  const result = await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.error || result.result?.exceptionDetails) {
    throw new Error(
      result.result?.exceptionDetails?.exception?.description ?? JSON.stringify(result.error),
    );
  }
  return result.result.result.value;
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function wait(expression, limit = 20000) {
  const until = Date.now() + limit;
  while (Date.now() < until) {
    if (await evaluate(expression)) return true;
    await sleep(100);
  }
  throw new Error(`Timed out: ${expression}`);
}
const checks = [];
function check(ok, label, detail = "") {
  checks.push(ok);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}
const tab = (name) =>
  `[...document.querySelectorAll('.doc-tab')].find(t=>t.querySelector('.doc-tab-name')?.textContent===${JSON.stringify(name)})`;
const tabs = () =>
  evaluate(`[...document.querySelectorAll('.doc-tab-name')].map(t=>t.textContent)`);
const dirty = (name) => evaluate(`${tab(name)}?.classList.contains('is-dirty')??false`);
const pageTargets = async () =>
  (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).filter(
    (target) => target.type === "page",
  );

/** Start the staged executable as a second launch, from the repository. */
function launch(args) {
  let stderr = "";
  const env = { ...process.env };
  // If the handoff fails, the second process must not touch the user's real
  // WebView2 profile. The running test instance owns this one.
  if (process.env.MDRAFT_TEST_USER_DATA) {
    env.WEBVIEW2_USER_DATA_FOLDER = process.env.MDRAFT_TEST_USER_DATA;
  }
  const child = spawn(exe, args, {
    cwd: repo,
    env,
    windowsHide: true,
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk.toString()).slice(-1000);
  });
  return {
    child,
    get stderr() {
      return stderr;
    },
  };
}

function waitExit(launched, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      launched.child.kill();
      reject(new Error(`${label} did not exit`));
    }, 15000);
    launched.child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    launched.child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stderr: launched.stderr });
    });
  });
}

try {
  await wait(
    `document.querySelector('.cm-content') && document.title.includes('word-sync.md')`,
    60000,
  );

  // -------------------------------------------------------------------------
  // The initial launch opened both paths once, in order.
  // -------------------------------------------------------------------------
  const initial = await tabs();
  check(
    initial.length === 2 && initial[0] === "feature-tour.md" && initial[1] === "word-sync.md",
    "an initial launch with two paths opens two tabs in order",
    initial.join(", "),
  );
  check(
    await evaluate(`${tab("word-sync.md")}?.getAttribute('aria-selected')==='true'`),
    "the last startup path is the active tab",
  );
  check((await pageTargets()).length === 1, "the initial launch has one page target");

  // A dirty buffer must survive the handoff, not just the tab.
  await evaluate(`document.querySelector('.cm-content').focus()`);
  await send("Input.insertText", { text: "HANDOFF-MARKER\n" });
  await wait(`${tab("word-sync.md")}?.classList.contains('is-dirty')`);
  check(await dirty("word-sync.md"), "the startup buffer became dirty before the handoff");

  // -------------------------------------------------------------------------
  // Relative path from the second launch.
  // -------------------------------------------------------------------------
  const relative = launch(["samples/asciidoc-tour.adoc"]);
  const relativeExit = await waitExit(relative, "relative second launch");
  check(
    relativeExit.code === 0,
    "the second process exits cleanly",
    `code ${relativeExit.code}${relativeExit.stderr ? `: ${relativeExit.stderr}` : ""}`,
  );
  await wait(`${tab("asciidoc-tour.adoc")}?.getAttribute('aria-selected')==='true'`);
  const afterRelative = await tabs();
  check(
    afterRelative.length === 3 && afterRelative.includes("asciidoc-tour.adoc"),
    "a relative second-launch path opens as a new tab",
    afterRelative.join(", "),
  );
  check(await dirty("word-sync.md"), "the dirty startup buffer survives the second launch");
  check((await pageTargets()).length === 1, "the second launch created no second window");

  // -------------------------------------------------------------------------
  // An already-open path is focused, not duplicated.
  // -------------------------------------------------------------------------
  const duplicate = launch([path.join(repo, "samples/feature-tour.md")]);
  const duplicateExit = await waitExit(duplicate, "duplicate second launch");
  check(duplicateExit.code === 0, "the duplicate-path process exits cleanly");
  await wait(`${tab("feature-tour.md")}?.getAttribute('aria-selected')==='true'`);
  check(
    (await tabs()).length === 3,
    "an already open path is focused instead of opening a second tab",
  );

  // -------------------------------------------------------------------------
  // A missing path is reported without dropping the valid tabs.
  // -------------------------------------------------------------------------
  const missing = path.join(os.tmpdir(), `mdraft-missing-${Date.now()}.md`);
  const missingLaunch = launch([missing]);
  // Start watching for the toast before waiting for the process to exit: the
  // toast is short-lived and the handoff itself is immediate.
  const missingToast = wait(
    `document.getElementById('toast').textContent.includes(${JSON.stringify(path.basename(missing))})`,
  );
  const missingExit = await waitExit(missingLaunch, "missing-path second launch");
  check(missingExit.code === 0, "the missing-path process exits cleanly");
  await missingToast;
  check(
    (await tabs()).length === 3,
    "a missing path creates no tab and leaves the valid ones open",
  );
} catch (error) {
  console.error(error.stack ?? error);
  check(false, "the single-instance suite completed", String(error));
} finally {
  const passed = checks.filter(Boolean).length;
  console.log(`\n${passed}/${checks.length} checks passed`);
  ws.close();
  process.exit(passed === checks.length ? 0 : 1);
}
