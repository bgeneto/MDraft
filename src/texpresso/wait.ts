//! A bounded wait with its clock injected, so `texpresso-unit` can run it
//! without a DOM or real time.

/**
 * Poll until `done` holds. False when `stop` holds — checked first, so a wait
 * that was superseded does not act on a state that also happens to be done —
 * or when `ms` have passed.
 */
export async function waitUntil(
  done: () => boolean,
  ms: number,
  stop: () => boolean,
  now: () => number,
  sleep: (ms: number) => Promise<void>,
  tick = 50,
): Promise<boolean> {
  const deadline = now() + ms;
  for (;;) {
    if (stop()) return false;
    if (done()) return true;
    if (now() >= deadline) return false;
    await sleep(tick);
  }
}

/**
 * Wait for `work` while the other side keeps answering. `ask` invites an
 * answer every `every` ms, and `heard` is when the last one came. The result
 * is the work's value, or `{ silent }` (the ms without an answer) once
 * `heard` is `silentMs` old, or null when `stop` holds. A value that has
 * arrived wins over both.
 */
export async function whileAnswering<T>(
  work: Promise<T>,
  heard: () => number,
  ask: () => void,
  silentMs: number,
  stop: () => boolean,
  now: () => number,
  sleep: (ms: number) => Promise<void>,
  every = 2000,
): Promise<{ value: T } | { silent: number } | null> {
  const done: { result?: { value: T } } = {};
  const settled = work.then((value) => {
    done.result = { value };
  });
  // One turn of the microtask queue, so a reply already in hand is seen first.
  await Promise.resolve();
  for (;;) {
    if (done.result) return done.result;
    if (stop()) return null;
    const quiet = now() - heard();
    if (quiet >= silentMs) return { silent: quiet };
    ask();
    await Promise.race([sleep(every), settled]);
  }
}
