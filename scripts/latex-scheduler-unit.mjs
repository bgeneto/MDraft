// Unit checks for the LaTeX live-preview scheduler and main-document rules.
//
//   node scripts/latex-scheduler-unit.mjs
//
// Pins the contract of docs/adr/2026-11-12-latex-engine-lifetime.md: a running
// job is never aborted, the newest waiting revision replaces older waiters,
// the interactive delay follows the reader's rhythm within its bounds, and the
// staleness cap fires during continuous typing. Also pins the main-document
// rules of GAP-034 (magic comment, own \documentclass, pin, missing).
//
// No application: both modules are pure.

import {
  KeyRhythm,
  LatestWinsGate,
  SupersededError,
  adaptiveDelay,
  staleBeyondCap,
} from "../src/latex-scheduler.ts";
import {
  hasDocumentClass,
  isMainCandidate,
  magicComment,
  resolveMainDocument,
  resolveRootPath,
} from "../src/latex-root.ts";

const checks = [];
function check(ok, label, detail = "") {
  checks.push(ok);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// --- LatestWinsGate -----------------------------------------------------------
{
  const gate = new LatestWinsGate();
  const order = [];
  const release1 = await gate.acquire(1);
  check(gate.holder === 1, "an idle gate is acquired at once");
  const second = gate.acquire(2).then(
    (release) => (order.push("2 ran"), release),
    (error) => (order.push(`2 ${error.name}`), null),
  );
  const third = gate.acquire(3).then(
    (release) => (order.push("3 ran"), release),
    (error) => (order.push(`3 ${error.name}`), null),
  );
  await tick();
  check(
    order[0] === "2 SupersededError",
    "a newer waiter supersedes the older waiter",
    order.join(", "),
  );
  check(gate.holder === 1, "the running job is never displaced by waiters");
  check(gate.queued === 3, "only the newest revision waits");
  release1();
  const release3 = await third;
  await second;
  check(
    order.includes("3 ran") && !order.includes("2 ran"),
    "the newest waiter runs next; the superseded one never runs",
    order.join(", "),
  );
  check(gate.holder === 3, "the released gate passes to the waiter");
  release1();
  check(gate.holder === 3, "a stale or repeated release does not free the gate");
  release3();
  check(gate.holder === null, "the last release leaves the gate idle");
  const again = await gate.acquire(4);
  check(gate.holder === 4, "an idle gate can be acquired again");
  const waiting = gate.acquire(5).catch((error) => error);
  gate.dropWaiting(new Error("closed"));
  check(
    (await waiting).message === "closed",
    "dropWaiting rejects the waiter and leaves the runner",
  );
  check(gate.holder === 4, "dropWaiting does not release the running job");
  again();
  check(new SupersededError(1, 2) instanceof Error, "SupersededError is an Error");
}
{
  // A render that acquires twice (preview, then compile) must not displace a
  // newer render that queued between its two acquisitions.
  const gate = new LatestWinsGate();
  const release7 = await gate.acquire(7);
  const newer = gate.acquire(9);
  const older = await gate.acquire(7).then(
    () => "acquired",
    (error) => error.name,
  );
  check(older === "SupersededError", "an older token is refused while a newer one waits", older);
  check(gate.queued === 9, "the newer waiter keeps its place");
  release7();
  (await newer)();
  check(gate.holder === null, "the newer waiter runs and releases");
}

// --- adaptive delay -----------------------------------------------------------
check(adaptiveDelay([]) === 200, "no rhythm yet: the maximum delay", String(adaptiveDelay([])));
check(adaptiveDelay([100, 100, 100]) === 150, "1.5 x median of a steady 100 ms rhythm");
check(adaptiveDelay([10, 10, 10]) === 60, "a very fast rhythm is clamped to the minimum");
check(adaptiveDelay([400, 400]) === 200, "a slow rhythm is clamped to the maximum");
check(
  adaptiveDelay([100, 120, 5000, 90]) === 165,
  "the median ignores one outlier",
  String(adaptiveDelay([100, 120, 5000, 90])),
);
{
  const rhythm = new KeyRhythm(3, 1000);
  for (const at of [0, 100, 250, 2000, 2100, 2200, 2300]) rhythm.record(at);
  check(
    JSON.stringify(rhythm.intervals()) === "[100,100,100]",
    "pauses longer than 1 s are not rhythm, and only the last N intervals are kept",
    JSON.stringify(rhythm.intervals()),
  );
}
check(!staleBeyondCap(null, null, 5000), "nothing unrendered: no forced compile");
check(!staleBeyondCap(null, 1000, 2000), "under the cap: wait for a pause");
check(staleBeyondCap(null, 1000, 2600), "1.5 s of unrendered typing forces one compile");
check(!staleBeyondCap(2500, 1000, 3000), "the cap counts from the last compile start");

// --- main document ------------------------------------------------------------
check(
  magicComment("% !TeX root = ../main.tex\n\\section{A}", "root") === "../main.tex",
  "a TeXstudio root comment is read",
);
check(magicComment("%!TEX root=main\n", "root") === "main", "spacing and case do not matter");
check(
  magicComment('% !TeX root = "my thesis.tex"\n', "root") === "my thesis.tex",
  "a quoted path is unquoted",
);
check(
  magicComment("% !TEX TS-program = pdflatex\n", "program") === "pdflatex",
  "the TS- prefix form is read",
);
check(
  magicComment(`${"x\n".repeat(25)}% !TeX root = main.tex`, "root") === null,
  "a magic comment after the first 20 lines is ignored",
);
check(hasDocumentClass("\\documentclass[11pt]{article}\n"), "a document class is detected");
check(
  !hasDocumentClass("% \\documentclass{article}\n\\section{x}"),
  "a commented class is not a main file",
);
check(
  !hasDocumentClass("\\begin{verbatim}\n\\documentclass{article}\n\\end{verbatim}"),
  "a class shown in verbatim is not a main file",
);
check(
  isMainCandidate(
    String.raw`\input{header}` +
      "\n" +
      String.raw`\begin{document}` +
      "\nx\n" +
      String.raw`\end{document}`,
  ),
  "a main file whose class lives in an \\input header is still a main file",
);
check(!isMainCandidate(String.raw`\section{A}` + "\nText."), "a chapter is not a main candidate");
check(
  resolveRootPath("C:\\p\\chapters", "../main.tex") === "C:\\p\\main.tex",
  "a Windows relative root resolves",
  String(resolveRootPath("C:\\p\\chapters", "../main.tex")),
);
check(
  resolveRootPath("/home/u/p/ch", "../main") === "/home/u/p/main.tex",
  "the .tex extension is implied",
);
check(resolveRootPath("/p", "../../x.tex") === null, "a path above the filesystem root is refused");
{
  const decision = resolveMainDocument({
    directory: "/p/chapters",
    source: "% !TeX root = ../main.tex\n\\documentclass{article}",
    pinnedContains: true,
  });
  check(
    decision.kind === "comment" && decision.path === "/p/main.tex",
    "rule 1: the magic comment wins over everything",
  );
}
check(
  resolveMainDocument({ directory: "/p", source: "\\documentclass{book}", pinnedContains: true })
    .kind === "self",
  "rule 3: a file with its own class is its own main file, even inside a pinned project",
);
check(
  resolveMainDocument({ directory: "/p", source: "\\section{A}", pinnedContains: true }).kind ===
    "pinned",
  "rule 5a: a chapter of the pinned project keeps the pin",
);
check(
  resolveMainDocument({ directory: "/p", source: "\\section{A}", pinnedContains: false }).kind ===
    "missing",
  "rule 5b: a lone chapter reports a missing main document instead of compiling alone",
);

const failed = checks.filter((ok) => !ok).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
