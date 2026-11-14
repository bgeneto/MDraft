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
