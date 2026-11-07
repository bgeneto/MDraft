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
 * Connect to the page target and return a small CDP handle.
 *
 * `onConsole` and `onException` are registered before `Runtime.enable`, so events
 * emitted during start-up are not missed.
 */
export async function openPage(port) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = list.find((entry) => entry.type === "page");
  if (!target) throw new Error(`No page target on port ${port}`);

  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });

  let nextId = 1;
  const pending = new Map();
  const consoleListeners = [];
  const exceptionListeners = [];

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
      return;
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

  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      socket.send(JSON.stringify({ id, method, params }));
    });

  // Listeners first: `Runtime.enable` replays nothing, so an event emitted before
  // it is lost forever.
  const onConsole = (listener) => consoleListeners.push(listener);
  const onException = (listener) => exceptionListeners.push(listener);
  await send("Runtime.enable");

  /** Evaluate and return the value, throwing on a rejected promise. */
  async function evaluate(expression) {
    const result = await send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.result?.exceptionDetails) {
      throw new Error(result.result.exceptionDetails.text ?? "evaluation failed");
    }
    return result.result?.result?.value;
  }

  return { send, evaluate, onConsole, onException, close: () => socket.close() };
}

/** Emit a menu event, the way the native menu does. */
export function emitMenu(page, id) {
  return page.evaluate(
    `window.__TAURI_INTERNALS__.invoke("plugin:event|emit", { event: "menu", payload: ${JSON.stringify(id)} })`,
  );
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
