// Unit checks for Typst adaptive live-preview scheduling.
//
//   node scripts/typst-scheduler-unit.mjs
//
// Verifies bounded adaptive debouncing (80..350 ms), continuous burst flushing
// at staleBeyondCap (1500 ms), latest-wins replacement without aborting the
// active compile prematurely, and zero starvation across nonstop typing bursts.

import {
  LatestWinsGate,
  SupersededError,
  TYPST_INTERACTIVE_DELAY,
  TYPST_STALE_CAP_MS,
  TypstCompileScheduler,
} from "../src/typst-scheduler.ts";

const checks = [];
function check(ok, label, detail = "") {
  checks.push(Boolean(ok));
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// --- Calibration bounds -------------------------------------------------------
{
  check(
    TYPST_INTERACTIVE_DELAY.min === 80 && TYPST_INTERACTIVE_DELAY.max === 350,
    "Typst interactive delay bounds match 80..350 ms",
    JSON.stringify(TYPST_INTERACTIVE_DELAY),
  );
  check(TYPST_STALE_CAP_MS === 1500, "Typst stale cap defaults to 1500 ms");

  let now = 1000;
  const scheduler = new TypstCompileScheduler(
    TYPST_INTERACTIVE_DELAY,
    TYPST_STALE_CAP_MS,
    () => now,
  );
  check(
    scheduler.delayFor(now) === 350,
    "with no rhythm history, scheduler picks conservative 350 ms max delay",
  );

  // Fast burst typing (40 ms intervals): clamps at min 80 ms.
  for (let i = 0; i < 6; i += 1) {
    now += 40;
    scheduler.recordEdit(now);
  }
  const fastDelay = scheduler.delayFor(now);
  check(
    fastDelay === 80,
    "fast 40 ms typing clamps debounce down to 80 ms floor",
    String(fastDelay),
  );

  // Slow document damping stays within 80..350 ms.
  const damped = scheduler.delayFor(now, 900);
  check(
    damped >= 80 && damped <= 350 && damped > fastDelay,
    "slow render duration gently increases delay without exceeding 350 ms",
    String(damped),
  );

  // Deliberate slow typing (160 ms intervals -> 1.5 * 160 = 240 ms).
  const slowScheduler = new TypstCompileScheduler(
    TYPST_INTERACTIVE_DELAY,
    TYPST_STALE_CAP_MS,
    () => now,
  );
  for (let i = 0; i < 8; i += 1) {
    now += 160;
    slowScheduler.recordEdit(now);
  }
  const midDelay = slowScheduler.delayFor(now);
  check(midDelay === 240, "160 ms typing rhythm settles at 240 ms (1.5x)", String(midDelay));
}

// --- Nonstop burst flush guarantee & zero premature starvation ----------------
{
  let now = 0;
  const scheduler = new TypstCompileScheduler(
    TYPST_INTERACTIVE_DELAY,
    TYPST_STALE_CAP_MS,
    () => now,
  );
  const flushes = [];
  const superseded = [];
  let inFlight = null;

  // Simulate 3.4 seconds of nonstop typing every 90 ms (38 keystrokes), where
  // each compile takes 180 ms (2 keystrokes long). A naive 450 ms timer would
  // starve completely during the entire 3.4 s burst!
  for (let step = 0; step < 38; step += 1) {
    now += 90;
    const rev = scheduler.recordEdit(now);
    if (inFlight && now >= inFlight.finishAt) {
      inFlight.release();
      scheduler.markCompiled(inFlight.rev, now);
      inFlight = null;
    }
    if (scheduler.shouldFlushNow(now)) {
      scheduler
        .acquire(rev)
        .then((release) => {
          flushes.push({ rev, at: now });
          inFlight = { rev, release, finishAt: now + 180 };
        })
        .catch((err) => {
          if (err instanceof SupersededError) superseded.push(rev);
        });
      await tick();
    }
  }
  // Let any final queued revision run and mark pause flush.
  if (inFlight) {
    now = inFlight.finishAt;
    inFlight.release();
    scheduler.markCompiled(inFlight.rev, now);
    inFlight = null;
  }
  const finalRev = scheduler.recordEdit(now + 10);
  now += 10;
  const releaseFinal = await scheduler.acquire(finalRev);
  flushes.push({ rev: finalRev, at: now });
  releaseFinal();
  scheduler.markCompiled(finalRev);

  check(
    flushes.length >= 2 && flushes[0].at >= 1500 && flushes[0].at < 1700,
    "nonstop burst triggers bounded intermediate flush at ~1500 ms stale cap",
    JSON.stringify(flushes),
  );
  check(
    scheduler.pendingRevision === null && flushes[flushes.length - 1].rev === finalRev,
    "final edit settles cleanly after burst with zero stranded revision",
  );
}

// --- LatestWinsGate intermediate discard behavior -----------------------------
{
  const gate = new LatestWinsGate();
  const r1 = await gate.acquire(1);
  const outcomes = [];
  const p2 = gate.acquire(2).catch((e) => outcomes.push(`2:${e.name}`));
  const p3 = gate.acquire(3).catch((e) => outcomes.push(`3:${e.name}`));
  const p4 = gate.acquire(4).then((rel) => {
    outcomes.push("4:ok");
    return rel;
  });
  await tick();
  r1();
  const rel4 = await p4;
  rel4();
  await Promise.all([p2, p3]);
  check(
    outcomes.join(",") === "2:SupersededError,3:SupersededError,4:ok",
    "intermediate burst tokens supersede cleanly without interrupting active compile",
    outcomes.join(","),
  );
}

const failed = checks.filter((ok) => !ok).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
