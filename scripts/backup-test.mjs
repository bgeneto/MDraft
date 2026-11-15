//! Isolated Windows UI, ZIP, restore and restart exercise.
import fs from "node:fs";
import path from "node:path";

const port = Number(process.argv[2]);
if (!Number.isInteger(port) || port <= 0) throw new Error("Pass the isolated CDP port as argv[2].");
const temporary = process.env.TEMP;
if (!temporary || !path.isAbsolute(temporary))
  throw new Error("The isolated test temporary folder is missing.");
const backupPath = path.join(temporary, "synthetic-mdraft-backup.zip");
const uiBackupPath = path.join(temporary, "synthetic-mdraft-ui.zip");
const uiSafetyPath = path.join(temporary, "synthetic-mdraft-ui-safety.zip");
const safetyPath = path.join(temporary, "synthetic-mdraft-safety.zip");
const restartSafetyPath = path.join(temporary, "synthetic-mdraft-before-restart.zip");
const secondSafetyPath = path.join(temporary, "synthetic-mdraft-before-safety-restore.zip");
const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = pages.find((entry) => entry.type === "page");
if (!page) throw new Error("No isolated application window was found.");
let socket;
let sequence = 0;
const pending = new Map();
async function connect(url) {
  socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  socket.addEventListener("message", (event) => {
    const packet = JSON.parse(event.data);
    const callback = pending.get(packet.id);
    if (callback) {
      pending.delete(packet.id);
      callback(packet);
    }
  });
  await send("Runtime.enable");
}
function send(method, params = {}) {
  const id = ++sequence;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP ${method} timed out`));
    }, 45_000);
    pending.set(id, (packet) => {
      clearTimeout(timer);
      resolve(packet);
    });
  });
}
async function evaluate(expression) {
  const reply = await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (reply.error || reply.result?.exceptionDetails)
    throw new Error(JSON.stringify(reply.error ?? reply.result.exceptionDetails));
  return reply.result.result.value;
}
await connect(page.webSocketDebuggerUrl);
let passed = 0;
let failed = 0;
function check(label, value) {
  if (value) {
    passed += 1;
    console.log(`PASS ${label}`);
  } else {
    failed += 1;
    console.error(`FAIL ${label}`);
  }
}
async function waitFor(expression, description) {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const value = await evaluate(expression);
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}.`);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

try {
  const deadline = Date.now() + 60_000;
  while (
    !(await evaluate(
      "Boolean(document.querySelector('.cm-editor') && document.getElementById('btn-prefs'))",
    ))
  ) {
    if (Date.now() >= deadline) throw new Error("The isolated app did not finish starting.");
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const ui = await evaluate(`(() => {
    document.getElementById('btn-prefs').click();
    [...document.querySelectorAll('.prefs-section')].find((entry) => entry.textContent === 'Data').click();
    const buttons = [...document.querySelectorAll('.prefs-button')];
    const names = buttons.map((entry) => entry.textContent.trim());
    buttons.find((entry) => entry.textContent.includes('Back Up App Data')).click();
    const dialog = document.querySelector('.data-dialog[open]');
    const included = dialog?.querySelector('input[type=checkbox]')?.checked === true;
    [...dialog.querySelectorAll('button')].find((entry) => entry.textContent === 'Cancel').click();
    return { names, included, canceled: !document.querySelector('.data-dialog[open]') };
  })()`);
  check(
    "Data offers backup, restore and recovered-document buttons",
    ["Back Up App Data…", "Restore Backup…", "Recovered Documents…"].every((label) =>
      ui.names.includes(label),
    ),
  );
  check("downloaded tools are selected by default", ui.included);
  check("cancel closes backup options", ui.canceled);

  // Stub only native pickers and message boxes; the UI and backup commands run
  // for real against the isolated profile and this run's temporary folder.
  await evaluate(`(() => {
    const state = window.__backupUiTest = { saves: [${JSON.stringify(uiBackupPath)}, ${JSON.stringify(uiSafetyPath)}], messages: [] };
    const original = window.fetch;
    window.fetch = async function(input, options) {
      const url = new URL(typeof input === 'string' ? input : input.url, location.href);
      const command = decodeURIComponent(url.pathname.slice(1));
      if (url.hostname !== 'ipc.localhost') return original.call(this, input, options);
      const args = typeof options?.body === 'string' ? JSON.parse(options.body) : {};
      const response = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json', 'Tauri-Response': 'ok' } });
      if (command === 'plugin:dialog|save') return response(state.saves.shift() ?? null);
      if (command === 'plugin:dialog|open') return response(${JSON.stringify(uiBackupPath)});
      if (command === 'plugin:dialog|message') { state.messages.push(args.message); return response('Ok'); }
      return original.call(this, input, options);
    };
    [...document.querySelectorAll('.prefs-button')].find(entry => entry.textContent.includes('Back Up App Data')).click();
    const dialog = document.querySelector('.data-dialog[aria-label="Back up MDraft data"]');
    dialog.querySelector('input[type=checkbox]').checked = false;
  })()`);
  await waitFor(
    "document.querySelector('.data-dialog[aria-label=\"Back up MDraft data\"]')?.textContent.includes('Estimated saved data before compression')",
    "the backup size estimate",
  );
  check("the backup options show an estimated saved-data size", true);
  await evaluate(`(() => {
    const dialog = document.querySelector('.data-dialog[aria-label="Back up MDraft data"]');
    [...dialog.querySelectorAll('button')].find(entry => entry.textContent === 'Choose Location…').click();
  })()`);
  await waitFor(
    "Boolean(document.querySelector('.data-dialog[aria-label=\"Backup saved\"]'))",
    "the backup completion dialog",
  );
  const uiMessage = await evaluate(`(() => {
    const dialog = document.querySelector('.data-dialog[aria-label="Backup saved"]');
    const result = { text: dialog.textContent, canReveal: [...dialog.querySelectorAll('button')].some(entry => entry.textContent === 'Show in Folder') };
    [...dialog.querySelectorAll('button')].find(entry => entry.textContent === 'Close').click();
    return result;
  })()`);
  check(
    "the backup button creates a verified ZIP and offers to reveal it",
    uiMessage.text.includes("Verified ZIP") && uiMessage.canReveal && fs.existsSync(uiBackupPath),
  );
  await new Promise((resolve) => setTimeout(resolve, 400));
  const beforeUiRestore = await evaluate("window.__TAURI_INTERNALS__.invoke('get_settings')");
  await evaluate(`(() => {
    [...document.querySelectorAll('.prefs-button')].find(entry => entry.textContent.includes('Restore Backup')).click();
  })()`);
  await waitFor(
    "Boolean(document.querySelector('.data-dialog[aria-label=\"Restore backup\"]'))",
    "the restore preview",
  );
  const previewText = await evaluate(`(() => {
    const dialog = document.querySelector('.data-dialog[aria-label="Restore backup"]');
    const text = dialog.textContent;
    [...dialog.querySelectorAll('button')].find(entry => entry.textContent === 'Continue…').click();
    return text;
  })()`);
  check("the restore button previews the versioned ZIP", previewText.includes("backup format 1"));
  await waitFor(
    "Boolean(document.querySelector('.data-dialog[aria-label=\"Review restore\"]'))",
    "the final restore review",
  );
  const uiReview = await evaluate(`(() => {
    const dialog = document.querySelector('.data-dialog[aria-label="Review restore"]');
    const text = dialog.textContent;
    [...dialog.querySelectorAll('button')].find(entry => entry.textContent === 'Cancel').click();
    return text;
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 400));
  const afterUiRestore = await evaluate("window.__TAURI_INTERNALS__.invoke('get_settings')");
  check(
    "the restore review creates a safety ZIP and cancel preserves settings",
    uiReview.includes("synthetic-mdraft-ui-safety.zip") &&
      fs.existsSync(uiSafetyPath) &&
      JSON.stringify(beforeUiRestore) === JSON.stringify(afterUiRestore),
  );

  const result = await evaluate(`(async () => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    const channel = () => '__CHANNEL__:' + window.__TAURI_INTERNALS__.transformCallback(() => {});
    const backupId = crypto.randomUUID();
    const settings = await invoke('get_settings');
    const text = 'Synthetic unsaved writing 🌎';
    const bytes = Array.from(new TextEncoder().encode(text));
    await invoke('begin_data_backup', { jobId: backupId, destination: ${JSON.stringify(backupPath)}, includeDownloads: false, settings, bufferCount: 1, activeId: 'synthetic', onProgress: channel() });
    const metadata = { id: 'synthetic', name: 'Synthetic.md', language: 'markdown', path: null, lineEnding: '\\n', hadBom: false, encoding: 'UTF-8', lossy: false, readOnly: false, baseModifiedMs: 0, baseSize: 0, baseSha256: null };
    await invoke('begin_backup_buffer', { jobId: backupId, metadata });
    const acknowledged = await invoke('append_backup_buffer', { jobId: backupId, bufferId: 'synthetic', sequence: 0, bytes });
    await invoke('finish_backup_buffer', { jobId: backupId, bufferId: 'synthetic', sequences: 1, bytes: bytes.length });
    const exported = await invoke('finish_data_backup', { jobId: backupId });
    const restoreId = crypto.randomUUID();
    const preview = await invoke('inspect_data_restore', { jobId: restoreId, source: ${JSON.stringify(backupPath)}, onProgress: channel() });
    const before = await invoke('get_settings');
    const selection = { settings: true, prompts: false, personal: false, recovery: true, downloads: false, window: false };
    await invoke('begin_restore_safety_backup', { jobId: restoreId, destination: ${JSON.stringify(safetyPath)}, selection, settings: before, bufferCount: 0, activeId: null });
    const review = await invoke('finish_restore_safety_backup', { jobId: restoreId });
    await invoke('release_restore_for_close', { jobId: restoreId });
    await invoke('cancel_data_backup', { jobId: restoreId });
    const after = await invoke('get_settings');
    return { acknowledged, expected: bytes.length, exported, preview, review, unchanged: JSON.stringify(before) === JSON.stringify(after), theme: before.theme };
  })()`);
  check("unsaved UTF-8 text is acknowledged", result.acknowledged === result.expected);
  check(
    "the backup is a nonempty ZIP",
    fs.existsSync(backupPath) &&
      fs.readFileSync(backupPath).subarray(0, 2).equals(Buffer.from("PK")),
  );
  check(
    "the ZIP is verified and versioned",
    result.preview.formatVersion === 1 && result.preview.categories.session.included,
  );
  check("restore preparation finds the unsaved document", result.review.recoveredDocuments === 1);
  check(
    "the mandatory safety ZIP survives cancel",
    fs.existsSync(safetyPath) && result.review.safetyBackup.bytes > 0,
  );
  check("cancel leaves current settings unchanged", result.unchanged);

  const armed = await evaluate(`(async () => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    const channel = '__CHANNEL__:' + window.__TAURI_INTERNALS__.transformCallback(() => {});
    const current = await invoke('get_settings');
    current.theme = current.theme === 'dark' ? 'light' : 'dark';
    const changed = await invoke('save_settings', { settings: current });
    const jobId = crypto.randomUUID();
    await invoke('inspect_data_restore', { jobId, source: ${JSON.stringify(backupPath)}, onProgress: channel });
    await invoke('begin_restore_safety_backup', {
      jobId, destination: ${JSON.stringify(restartSafetyPath)},
      selection: { settings: true, prompts: false, personal: false, recovery: true, downloads: false, window: false },
      settings: changed, bufferCount: 0, activeId: null,
    });
    await invoke('finish_restore_safety_backup', { jobId });
    await invoke('release_restore_for_close', { jobId });
    await invoke('arm_data_restore', { jobId });
    return { changedTheme: changed.theme };
  })()`);
  check("the test changed a preference before restoring", armed.changedTheme !== result.theme);
  socket.close();
  const restartDeadline = Date.now() + 90_000;
  let restarted;
  while (!restarted) {
    if (Date.now() > restartDeadline) throw new Error("The restored app did not reopen.");
    try {
      const current = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      restarted = current.find((entry) => entry.type === "page" && entry.id !== page.id);
    } catch {
      /* The headless pass temporarily closes the debug endpoint. */
    }
    if (!restarted) await new Promise((resolve) => setTimeout(resolve, 300));
  }
  await connect(restarted.webSocketDebuggerUrl);
  while (
    !(await evaluate(
      "Boolean(document.querySelector('.data-dialog[aria-label=\"Backup restored\"]'))",
    ))
  ) {
    if (Date.now() > restartDeadline)
      throw new Error("The restore completion report did not appear.");
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  const restored = await evaluate(`(async () => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    const settings = await invoke('get_settings');
    const documents = await invoke('list_recovered_documents');
    const item = documents.find((entry) => entry.document.name === 'Synthetic.md');
    let text = '';
    if (item) {
      const transferId = crypto.randomUUID();
      await invoke('begin_recovered_read', { inboxId: item.inboxId, documentId: item.document.id, transferId });
      const decoder = new TextDecoder('utf-8', { fatal: true });
      for (;;) {
        const chunk = await invoke('read_recovered_chunk', { transferId });
        text += decoder.decode(new Uint8Array(chunk.bytes), { stream: !chunk.finished });
        if (chunk.finished) break;
      }
    }
    const report = document.querySelector('.data-dialog[aria-label="Backup restored"]');
    const saysSafety = report.textContent.includes('synthetic-mdraft-before-restart.zip');
    [...report.querySelectorAll('button')].find((entry) => entry.textContent === 'Later').click();
    return { theme: settings.theme, text, saysSafety, path: item?.document.originalPath ?? null };
  })()`);
  check("restart restores the archived preference", restored.theme === result.theme);
  check(
    "restart keeps recovered text as an independent copy",
    restored.text === "Synthetic unsaved writing 🌎" && restored.path === null,
  );
  check(
    "restore report names the safety ZIP",
    restored.saysSafety && fs.existsSync(restartSafetyPath),
  );
  const saved = await evaluate(`(async () => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    const item = (await invoke('list_recovered_documents')).find((entry) => entry.document.name === 'Synthetic.md');
    const transferId = crypto.randomUUID();
    const bytes = Array.from(new TextEncoder().encode('Updated recovered copy 🌎'));
    await invoke('begin_recovered_revision', { inboxId: item.inboxId, documentId: item.document.id, transferId });
    const acknowledged = await invoke('append_recovered_revision', { transferId, sequence: 0, bytes });
    await invoke('finish_recovered_revision', { transferId, sequences: 1, bytes: bytes.length });
    const result = await invoke('save_recovered_copies', { folder: ${JSON.stringify(temporary)}, items: [{ inboxId: item.inboxId, documentId: item.document.id }], token: crypto.randomUUID() });
    return { acknowledged, expected: bytes.length, result, remaining: (await invoke('list_recovered_documents')).length };
  })()`);
  check(
    "edits to a recovered document are durably acknowledged",
    saved.acknowledged === saved.expected,
  );
  check(
    "a recovered copy is saved without an inbox entry remaining",
    saved.result.saved.length === 1 &&
      saved.result.failed.length === 0 &&
      saved.remaining === 0 &&
      fs.readFileSync(saved.result.saved[0], "utf8") === "Updated recovered copy 🌎",
  );
  const acknowledgeDeadline = Date.now() + 15_000;
  while (await evaluate("window.__TAURI_INTERNALS__.invoke('get_restore_report')")) {
    if (Date.now() > acknowledgeDeadline)
      throw new Error("The restore report was not acknowledged.");
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  await evaluate(`(async () => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    const channel = '__CHANNEL__:' + window.__TAURI_INTERNALS__.transformCallback(() => {});
    const jobId = crypto.randomUUID();
    const settings = await invoke('get_settings');
    await invoke('inspect_data_restore', { jobId, source: ${JSON.stringify(restartSafetyPath)}, onProgress: channel });
    await invoke('begin_restore_safety_backup', { jobId, destination: ${JSON.stringify(secondSafetyPath)}, selection: { settings: true, prompts: false, personal: false, recovery: false, downloads: false, window: false }, settings, bufferCount: 0, activeId: null });
    await invoke('finish_restore_safety_backup', { jobId });
    await invoke('release_restore_for_close', { jobId });
    await invoke('arm_data_restore', { jobId });
  })()`);
  socket.close();
  const secondDeadline = Date.now() + 90_000;
  let secondPage;
  while (!secondPage) {
    if (Date.now() > secondDeadline) throw new Error("The safety backup did not reopen the app.");
    try {
      const current = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      secondPage = current.find((entry) => entry.type === "page" && entry.id !== restarted.id);
    } catch {
      /* The headless pass temporarily closes the debug endpoint. */
    }
    if (!secondPage) await new Promise((resolve) => setTimeout(resolve, 300));
  }
  await connect(secondPage.webSocketDebuggerUrl);
  while (
    !(await evaluate(
      "Boolean(document.querySelector('.data-dialog[aria-label=\"Backup restored\"]'))",
    ))
  ) {
    if (Date.now() > secondDeadline)
      throw new Error("The safety-backup restore report did not appear.");
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  const safetyTheme = await evaluate(`(async () => {
    const settings = await window.__TAURI_INTERNALS__.invoke('get_settings');
    const report = document.querySelector('.data-dialog[aria-label="Backup restored"]');
    [...report.querySelectorAll('button')].find((entry) => entry.textContent === 'Close').click();
    return settings.theme;
  })()`);
  check(
    "the safety ZIP can restore the pre-restore preference",
    safetyTheme === armed.changedTheme,
  );
} catch (error) {
  failed += 1;
  console.error(`FAIL backup integration: ${error.stack ?? error}`);
} finally {
  socket.close();
}
console.log(`\n${passed}/${passed + failed} checks passed`);
if (failed) process.exitCode = 1;
