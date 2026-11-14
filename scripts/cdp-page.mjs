// A CDP console listener, so a suite can see what the page logged.
//
//   import { openPage } from "./cdp-page.mjs";
//   const page = await openPage(port);
//   page.onConsole((level, text) => ...);
//
// Why this exists: several failures in this repository are invisible from the
// DOM. A compile that fails, a fetch that 404s, a promise that rejects inside a
// render — none of them change a selector, and `Runtime.evaluate` cannot see them
// because they happen in a callback the test never called. `Runtime.consoleAPICalled`
// and `Runtime.exceptionThrown` are the only way to observe them.
//
// The listener is deliberately tiny and dependency-free, matching the other
// scripts here: Node's built-in `WebSocket` speaks CDP, and every suite that
// needs more than this should grow its own rather than a framework.

/**
 * Connect to a target and return a small CDP handle.
 *
 * `onConsole` and `onException` are registered before `Runtime.enable`, so events
 * emitted during start-up are not missed.
 *
 * `options.type` selects the target type (`page` by default); `options.match` is
 * a regular expression over the target's URL, for suites that drive the LaTeX
 * preview frame rather than the application page.
 */
export async function openPage(port, options = {}) {
  const type = options.type ?? "page";
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = list.find(
    (entry) => entry.type === type && (!options.match || options.match.test(entry.url)),
  );
  if (!target) throw new Error(`No ${type} target on port ${port}`);

  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });

  let nextId = 1;
  const pending = new Map();
  const consoleListeners = [];
  const exceptionListeners = [];
  const eventListeners = [];

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id !== undefined && pending.has(message.id)) {
      const request = pending.get(message.id);
      clearTimeout(request.timer);
      pending.delete(message.id);
      if (message.error)
        request.reject(new Error(`CDP ${request.method}: ${message.error.message}`));
      else request.resolve(message);
      return;
    }
    if (message.method) {
      for (const listener of eventListeners) listener(message.method, message.params ?? {});
    }
    // `Runtime.consoleAPICalled` carries the arguments as RemoteObjects; the
    // `value` is present for primitives, `description` for everything else.
    if (message.method === "Runtime.consoleAPICalled") {
      const text = (message.params.args ?? [])
        .map((arg) => arg.value ?? arg.description ?? arg.type ?? "")
        .join(" ");
      for (const listener of consoleListeners) listener(message.params.type, text);
    }
    if (message.method === "Runtime.exceptionThrown") {
      const detail = message.params.exceptionDetails;
      const text = detail?.exception?.description ?? detail?.text ?? "exception";
      for (const listener of exceptionListeners) listener(String(text));
    }
  });
  socket.addEventListener("close", () => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error(`CDP connection closed during ${request.method}`));
    }
    pending.clear();
  });

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      if (socket.readyState !== WebSocket.OPEN) {
        reject(new Error(`CDP connection is closed before ${method}`));
        return;
      }
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP ${method} timed out after 30 seconds`));
      }, 30000);
      pending.set(id, { resolve, reject, method, timer });
      try {
        socket.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        pending.delete(id);
        reject(error);
      }
    });

  // Listeners first: `Runtime.enable` replays nothing, so an event emitted before
  // it is lost forever.
  const onConsole = (listener) => consoleListeners.push(listener);
  const onException = (listener) => exceptionListeners.push(listener);
  const onEvent = (listener) => eventListeners.push(listener);
  await send("Runtime.enable");

  /** Evaluate and return the value, throwing on a rejected promise. */
  async function evaluate(expression) {
    const result = await send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.result?.exceptionDetails) {
      const detail = result.result.exceptionDetails;
      throw new Error(detail.exception?.description ?? detail.text ?? "evaluation failed");
    }
    return result.result?.result?.value;
  }

  return { send, evaluate, onConsole, onException, onEvent, close: () => socket.close() };
}

/** Emit a menu event, the way the native menu does. */
export function emitMenu(page, id) {
  return page.evaluate(
    `window.__TAURI_INTERNALS__.invoke("plugin:event|emit", { event: "menu", payload: ${JSON.stringify(id)} })`,
  );
}

/**
 * Select the hidden WasmTex backend for a layer that predates the incremental
 * default. WasmTex is disabled, not deleted: its tests still need the code they
 * cover, and the hook is the only writer that selects it.
 */
export async function useWasmTex(page) {
  await emitMenu(page, "view.latexBackend.wasmtex");
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const backend = await page.evaluate(
      `document.querySelector("#preview")?.dataset.latexBackend ?? ""`,
    );
    if (!backend) return;
    await sleep(100);
  }
  throw new Error("the WasmTex backend did not become active");
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
