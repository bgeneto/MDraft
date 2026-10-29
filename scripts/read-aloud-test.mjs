// Does Read Aloud work through the real editor menu?
//
//   node scripts/read-aloud-test.mjs [port]
//
// The application must be open on samples/feature-tour.md. The suite opens the
// HTML fixture itself, and returns to the Markdown one before it finishes.
//
// Audio cannot be heard from here, let alone asserted. What is asserted is what
// a person could see and what the engine reports: the chip appears with a
// position, the position advances, Stop removes it, `speechSynthesis` is
// speaking while the chip is up, and the HTML tab disables the commands with a
// reason instead of doing nothing.
//
// One detail earns its own paragraph. Chromium refuses `speak()` without sticky
// user activation, and a synthetic `MouseEvent` or `button.click()` does not
// grant it. The suite therefore starts with a **real** CDP mouse press inside
// the editor; every later click can stay synthetic.

import path from "node:path";

const port = process.argv[2] ?? "9222";
const repoRoot = path.resolve(import.meta.dirname, "..");

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = list.find((target) => target.type === "page");
if (!page) {
  console.error("no page target; start the application with the debug port open");
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
const pending = new Map();
let nextId = 1;
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const checks = [];
function check(ok, label, detail = "") {
  checks.push({ ok, label, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}

async function pollFor(expression, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return true;
    await sleep(120);
  }
  return false;
}

const invoke = (command, args = {}) =>
  evaluate(
    `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)})`,
  );

const emit = (event, payload) => invoke("plugin:event|emit", { event, payload });

const activeName = `document.querySelector('.doc-tab[aria-selected="true"] .doc-tab-name')?.textContent`;

const chipState = () =>
  evaluate(`(() => {
    const chip = document.getElementById('status-reading');
    return chip
      ? { hidden: chip.hidden, text: chip.textContent ?? '', title: chip.title }
      : null;
  })()`);

const speakingState = () =>
  evaluate(`(() => {
    if (typeof speechSynthesis === 'undefined') return { supported: false, speaking: false, pending: false, voices: 0 };
    return {
      supported: true,
      speaking: speechSynthesis.speaking,
      pending: speechSynthesis.pending,
      voices: speechSynthesis.getVoices().length,
    };
  })()`);

const menuState = () =>
  evaluate(`(() => {
    const menus = [...document.querySelectorAll('.editor-menu')];
    return {
      count: menus.length,
      items: menus[0]
        ? [...menus[0].querySelectorAll('.editor-menu-item')].map((button) => ({
            action: button.dataset.action,
            label: button.querySelector('.editor-menu-label')?.textContent ?? '',
            disabled: button.disabled,
            title: button.title,
          }))
        : [],
    };
  })()`);

const chooseEditor = (action) =>
  evaluate(`(() => {
    const button = document.querySelector('.editor-menu-item[data-action="${action}"]');
    if (!button || button.disabled) return false;
    button.click();
    return true;
  })()`);

/** Real input: this is what grants the sticky activation `speak()` needs. */
async function pressLine(index) {
  const point = await evaluate(`(() => {
    const scroller = document.querySelector('.cm-scroller');
    if (scroller) scroller.scrollTop = 0;
    const line = document.querySelectorAll('.cm-line')[${index}];
    if (!line) return null;
    const rect = line.getBoundingClientRect();
    return { x: rect.left + 30, y: rect.top + rect.height / 2 };
  })()`);
  if (!point) throw new Error(`line ${index} is not rendered`);
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
}

/** A synthetic right-click that reaches every DOM listener. */
function rightClickLine(index, offset = 30) {
  return evaluate(`(() => {
    const scroller = document.querySelector('.cm-scroller');
    if (scroller) scroller.scrollTop = 0;
    const line = document.querySelectorAll('.cm-line')[${index}];
    if (!line) return 'missing';
    const rect = line.getBoundingClientRect();
    const x = rect.left + ${offset};
    const y = rect.top + rect.height / 2;
    const target = document.elementFromPoint(x, y) ?? line;
    target.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, clientX: x, clientY: y, button: 2, buttons: 2,
    }));
    return 'sent';
  })()`);
}

async function openFile(file) {
  // Absolute: the harness launches the staged binary outside the workspace, so a
  // relative fixture path would resolve against its own folder and be refused.
  const absolute = path.resolve(repoRoot, file);
  await emit("open-files", [absolute]);
  return pollFor(
    `${activeName} === ${JSON.stringify(path.basename(file))} && document.querySelectorAll('.cm-line').length > 0`,
    20000,
  );
}

// ---------------------------------------------------------------------------
// Preferences helpers. The panel rebuilds on every change, so each one
// re-queries the rows instead of holding a stale element.
// ---------------------------------------------------------------------------

const openPrefs = () =>
  evaluate(`(() => {
    const overlay = document.querySelector('.prefs-overlay');
    if (!overlay) return false;
    if (overlay.hidden) document.getElementById('btn-prefs').click();
    return true;
  })()`);

const openPrefsSection = (title) =>
  evaluate(`(() => {
    const section = [...document.querySelectorAll('.prefs-section')]
      .find((entry) => entry.textContent === ${JSON.stringify(title)});
    if (!section) return false;
    section.click();
    return true;
  })()`);

const prefsRow = (label) =>
  `[...document.querySelectorAll('.prefs-row')].find((row) =>
    (row.querySelector('.prefs-label')?.textContent ?? '').replace('?', '').trim() === ${JSON.stringify(label)})`;

const readVoiceOptions = () =>
  evaluate(`(() => {
    const row = ${prefsRow("Voice")};
    const select = row?.querySelector('select');
    if (!select) return null;
    return [...select.options].map((option) => ({ value: option.value, label: option.textContent }));
  })()`);

const chooseVoice = (value) =>
  evaluate(`(() => {
    const row = ${prefsRow("Voice")};
    const select = row?.querySelector('select');
    if (!select) return false;
    select.value = ${JSON.stringify(value)};
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);

const readNote = () =>
  evaluate(`(() => {
    const row = ${prefsRow("Installed Voices")};
    return row?.querySelector('.prefs-note')?.textContent ?? row?.textContent ?? null;
  })()`);

const setNumber = (label, value) =>
  evaluate(`(() => {
    const row = ${prefsRow(label)};
    const input = row?.querySelector('input[type=number]');
    if (!input) return false;
    input.value = ${JSON.stringify(String(value))};
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);

const closePrefs = () =>
  evaluate(`(() => {
    const overlay = document.querySelector('.prefs-overlay');
    if (!overlay) return false;
    overlay.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return true;
  })()`);

// ---------------------------------------------------------------------------
console.log("=== the environment can speak ===");

// A real press first: the synthetic clicks below inherit its activation.
await pressLine(0);

const support = await speakingState();
check(support.supported, "the webview exposes speechSynthesis");
const voicesReady = await pollFor(`speechSynthesis.getVoices().length > 0`, 6000);
check(voicesReady, "the installed voices arrive after voiceschanged", String(support.voices));

// ---------------------------------------------------------------------------
console.log("=== the editor menu offers Read Aloud ===");
{
  // Availability is derived from the rendered preview. A cold start can reach
  // the first right-click before the first render, which reads as "nothing to
  // read" and disables the command; wait for the pane the menu measures.
  await pollFor(`(document.getElementById('preview')?.textContent ?? '').trim().length > 0`, 15000);
  check((await rightClickLine(0)) === "sent", "the first line accepts a right-click");
  const menu = await menuState();
  check(menu.count === 1, "one menu opens");

  const fromHere = menu.items.find((entry) => entry.action === "readAloudFromHere");
  const fromStart = menu.items.find((entry) => entry.action === "readAloudFromStart");
  const stop = menu.items.find((entry) => entry.action === "stopReading");

  check(fromHere?.label === "Read Aloud from Here", "the menu names the from-here command");
  check(fromHere?.disabled === false, "it is enabled on a Markdown document", fromHere?.title);
  check(
    fromStart?.label === "Read Aloud from the Beginning",
    "the menu names the from-start command",
  );
  check(fromStart?.disabled === false, "it is enabled too", fromStart?.title);
  check(stop === undefined, "Stop Reading is absent until something is being read");
}

// ---------------------------------------------------------------------------
console.log("=== a reading starts, advances and stops ===");
{
  check(await chooseEditor("readAloudFromHere"), "choosing Read Aloud from Here runs it");
  const started = await pollFor(
    `(() => {
    const chip = document.getElementById('status-reading');
    return !!chip && !chip.hidden;
  })()`,
    4000,
  );
  check(started, "the status chip appears");

  const chip = await chipState();
  check(/^Reading 1\/\d+$/.test(chip.text ?? ""), "the chip names the position", chip.text);
  check((chip.title ?? "").includes("click to stop"), "the chip explains itself", chip.title);

  const speaking = await pollFor(`speechSynthesis.speaking || speechSynthesis.pending`, 4000);
  check(speaking, "the synthesiser took the first sentence");

  const advanced = await pollFor(
    `/^Reading 2\\//.test(
    document.getElementById('status-reading')?.textContent ?? '')`,
    12000,
  );
  check(advanced, "the queue moves to the second sentence on its own");

  await rightClickLine(0);
  const whileMenu = await menuState();
  const stopEntry = whileMenu.items.find((entry) => entry.action === "stopReading");
  check(stopEntry !== undefined, "the menu offers Stop Reading while a reading runs");
  check(stopEntry?.disabled === false, "Stop Reading is enabled");
  check(
    whileMenu.items.find((entry) => entry.action === "readAloudFromHere")?.disabled === false,
    "Read Aloud stays available during a reading",
  );
}

{
  check(await chooseEditor("stopReading"), "choosing Stop Reading runs it");
  const silent = await pollFor(
    `(() => {
    const chip = document.getElementById('status-reading');
    return (!chip || chip.hidden) && !speechSynthesis.speaking && !speechSynthesis.pending;
  })()`,
    4000,
  );
  check(silent, "the chip and the voice stop together");
  check((await chipState()).text === "", "the chip is emptied, not just hidden");
}

// ---------------------------------------------------------------------------
console.log("=== the chip is the second way to stop ===");
{
  await rightClickLine(0);
  check(await chooseEditor("readAloudFromStart"), "Read Aloud from the Beginning runs");
  await pollFor(
    `(() => {
    const chip = document.getElementById('status-reading');
    return !!chip && !chip.hidden;
  })()`,
    4000,
  );
  const chip = await chipState();
  const total = Number((chip.text ?? "").match(/\/(\d+)$/)?.[1] ?? "0");
  check(total > 1, "reading from the beginning covers the whole document", chip.text);

  await evaluate(`document.getElementById('status-reading').click()`);
  const stopped = await pollFor(`document.getElementById('status-reading')?.hidden === true`, 4000);
  check(stopped, "clicking the chip stops the reading");
  check(
    await pollFor(`!speechSynthesis.speaking && !speechSynthesis.pending`, 4000),
    "the voice is silent after the chip is clicked",
  );
}

// ---------------------------------------------------------------------------
console.log("=== the HTML tab says why it cannot be read ===");
{
  check(await openFile("samples/html-tour/index.html"), "the HTML fixture opens");
  await rightClickLine(0);
  const menu = await menuState();
  const fromStart = menu.items.find((entry) => entry.action === "readAloudFromStart");
  const fromHere = menu.items.find((entry) => entry.action === "readAloudFromHere");
  check(fromStart !== undefined, "the command is still listed");
  check(fromStart?.disabled === true, "it is disabled on an HTML document");
  check(
    fromStart?.title === "The HTML preview cannot be read aloud.",
    "the tooltip names the reason",
    fromStart?.title,
  );
  check(fromHere?.disabled === true, "the from-here command is disabled too");
  await evaluate(`document.body.click()`);

  check(await openFile("samples/feature-tour.md"), "the Markdown fixture comes back");
}

// ---------------------------------------------------------------------------
console.log("=== a Portuguese document finds a Portuguese voice ===");
{
  const voices = await evaluate(`speechSynthesis.getVoices().map((voice) => ({
    name: voice.name,
    lang: voice.lang,
  }))`);
  const portuguese = voices.filter((voice) => /^pt(-|$)/i.test(voice.lang));

  check(await openFile("samples/word-sync.md"), "the Portuguese fixture opens");
  // x=2 lands in the line's left padding, so the position is the line start and
  // the spelling plugin has no miss to claim; the editor menu opens.
  await rightClickLine(2, 2);
  check(await chooseEditor("readAloudFromStart"), "Read Aloud from the Beginning runs on it");
  const started = await pollFor(
    `(() => {
      const chip = document.getElementById('status-reading');
      return !!chip && !chip.hidden;
    })()`,
    6000,
  );
  const chip = await chipState();
  check(started, "the Portuguese document starts reading");

  if (portuguese.length === 0) {
    check(true, "the Portuguese voice check is skipped: none is installed", chip.title);
  } else {
    check(
      portuguese.some((voice) => (chip.title ?? "").includes(voice.name)),
      "the chip names an installed Portuguese voice",
      chip.title,
    );
  }

  await evaluate(`document.getElementById('status-reading')?.click()`);
  await pollFor(`document.getElementById('status-reading')?.hidden === true`, 4000);
  check(await openFile("samples/feature-tour.md"), "the Markdown fixture comes back again");
}

// ---------------------------------------------------------------------------
console.log("=== Preferences lists the system's voices ===");
{
  check(await openPrefs(), "Preferences opens");
  check(await openPrefsSection("Read Aloud"), "the Read Aloud section exists");

  const options = await readVoiceOptions();
  check(
    Array.isArray(options) && options.length >= 2,
    "the voice picker is populated",
    `${options?.length ?? 0} options`,
  );
  check(options?.[0]?.value === "", "the first choice follows the document language");
  check(
    options?.slice(1).every((option) => /\(.+\)$/.test(option.label)),
    "each installed voice names its language",
    options
      ?.slice(1, 3)
      .map((option) => option.label)
      .join(" | "),
  );

  const note = await readNote();
  check(
    (note ?? "").includes("offline"),
    "the note says reading is offline",
    (note ?? "").slice(0, 70),
  );
  check(
    /Time & language|speech-dispatcher|Spoken Content/.test(note ?? ""),
    "the note names how to install another language",
  );

  const voiceName = options?.[1]?.value ?? "";
  check(await chooseVoice(voiceName), "the picker accepts a voice");
  check(
    await pollFor(
      `window.__TAURI_INTERNALS__.invoke('get_settings').then((s) => s.readAloudVoice === ${JSON.stringify(voiceName)})`,
      6000,
    ),
    "the chosen voice is saved",
    voiceName,
  );

  check(await setNumber("Speed", 1.5), "the speed row accepts a value");
  check(
    await pollFor(
      `window.__TAURI_INTERNALS__.invoke('get_settings').then((s) => s.readAloudRate === 1.5)`,
      6000,
    ),
    "the rate is saved",
  );

  // Put the fixture back: a later run (and the next suite) must see 1× automatic.
  check(await chooseVoice(""), "the picker returns to Automatic");
  check(await setNumber("Speed", 1), "the rate returns to 1×");
  await closePrefs();
}

// ---------------------------------------------------------------------------
const failed = checks.filter((entry) => !entry.ok).length;
const passed = checks.length - failed;
console.log(`\n${passed}/${checks.length} checks passed`);
ws.close();
process.exit(failed === 0 ? 0 : 1);
