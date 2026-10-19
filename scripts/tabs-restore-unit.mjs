// Unit tests for the remembered tabs and the restore plan.
//
//   node scripts/tabs-restore-unit.mjs
//
// No application and no build: `src/tab-restore.ts` imports only the session
// store, which has no runtime imports of its own, and Node strips the types.
//
// What it is for: the two rules that decide what survives a restart are list
// operations — which paths are stored, in what order, deduplicated by the
// platform's own path identity, and which of them are opened again. Those are
// cheap to pin here and awkward to see through the UI, which is what the
// two-launch CDP suite proves.

import { createSessionStore } from "../src/sessions.ts";
import { MAX_LAST_TABS, planRestore, rememberTabs } from "../src/tab-restore.ts";

const checks = [];
function check(ok, label, detail = "") {
  checks.push({ ok, label, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}

/** The fields `rememberTabs` reads, plus a name for failure messages. */
const session = (id, path) => ({ id, path, name: path ?? id });

/** Run `body` with a stubbed Windows user agent, as `sessions-test.mjs` does. */
function onWindows(body) {
  const saved = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    value: { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
    configurable: true,
  });
  try {
    body();
  } finally {
    if (saved) Object.defineProperty(globalThis, "navigator", saved);
    else delete globalThis.navigator;
  }
}

// ---------------------------------------------------------------------------
console.log("=== rememberTabs keeps saved paths in tab order ===");
{
  const list = [session("1", "C:/Docs/a.md"), session("2", "C:/Docs/b.md"), session("3", "C:/Docs/c.md")];
  const remembered = rememberTabs(list, "2");
  check(
    JSON.stringify(remembered.tabs) === JSON.stringify(["C:/Docs/a.md", "C:/Docs/b.md", "C:/Docs/c.md"]),
    "order is the tab order",
    remembered.tabs.join(", "),
  );
  check(remembered.active === "C:/Docs/b.md", "the active session is remembered", String(remembered.active));
}

console.log("\n=== untitled sessions are not remembered ===");
{
  const list = [session("1", null), session("2", "C:/Docs/a.md"), session("3", null)];
  const remembered = rememberTabs(list, "3");
  check(remembered.tabs.length === 1, "one path is stored", String(remembered.tabs.length));
  check(remembered.tabs[0] === "C:/Docs/a.md", "the saved document", remembered.tabs[0]);
  check(remembered.active === null, "an untitled active tab is not remembered", String(remembered.active));
}

console.log("\n=== an empty set is empty ===");
{
  const remembered = rememberTabs([session("1", null)], "1");
  check(remembered.tabs.length === 0, "nothing is stored");
  check(remembered.active === null, "nothing is active");
}

console.log("\n=== duplicates collapse to the first occurrence ===");
{
  const list = [session("1", "C:/Docs/a.md"), session("2", "C:/Docs/b.md"), session("3", "C:/Docs/a.md")];
  const remembered = rememberTabs(list, "3");
  check(remembered.tabs.length === 2, "the repeated path is stored once", remembered.tabs.join(", "));
  check(remembered.tabs[0] === "C:/Docs/a.md", "the first occurrence keeps its place", remembered.tabs[0]);
  onWindows(() => {
    const mixed = [session("1", "C:/Docs/a.md"), session("2", "c:/docs/A.MD")];
    check(
      rememberTabs(mixed, "1").tabs.length === 1,
      "on Windows two spellings of one path are one entry",
      rememberTabs(mixed, "1").tabs.join(", "),
    );
  });
}

console.log("\n=== the list is capped, and the active tab must survive the cap ===");
{
  const list = [];
  for (let i = 0; i <= MAX_LAST_TABS; i++) list.push(session(String(i), `C:/Docs/file${i}.md`));
  const remembered = rememberTabs(list, "0");
  check(remembered.tabs.length === MAX_LAST_TABS, `kept ${MAX_LAST_TABS} paths`, String(remembered.tabs.length));
  check(remembered.tabs[0] === "C:/Docs/file0.md", "the first path is kept");
  check(
    !remembered.tabs.includes(`C:/Docs/file${MAX_LAST_TABS}.md`),
    "the first path beyond the cap is dropped",
  );
  check(remembered.active === "C:/Docs/file0.md", "an active tab inside the cap is remembered");

  const beyond = rememberTabs(list, String(MAX_LAST_TABS));
  check(beyond.active === null, "an active tab beyond the cap is not recorded", String(beyond.active));
}

// ---------------------------------------------------------------------------
console.log("\n=== planRestore preserves order and checks existence ===");
{
  const saved = ["C:/Docs/a.md", "C:/Docs/b.md", "C:/Docs/c.md"];
  const plan = planRestore(saved, "C:/Docs/b.md", (path) => path !== "C:/Docs/b.md");
  check(
    JSON.stringify(plan.tabs) === JSON.stringify(["C:/Docs/a.md", "C:/Docs/c.md"]),
    "only the existing files remain, in order",
    plan.tabs.join(", "),
  );
  check(plan.missing === 1, "one missing file is counted", String(plan.missing));
  check(plan.active === "C:/Docs/a.md", "a missing active file falls back to the first tab", String(plan.active));
}

console.log("\n=== the active tab comes back when it exists ===");
{
  const saved = ["C:/Docs/a.md", "C:/Docs/b.md"];
  const plan = planRestore(saved, "C:/Docs/b.md", () => true);
  check(plan.active === "C:/Docs/b.md", "the remembered tab is active", String(plan.active));
  check(plan.missing === 0, "nothing is missing");
}

console.log("\n=== a null or unknown active path leaves the first tab active ===");
{
  const saved = ["C:/Docs/a.md", "C:/Docs/b.md"];
  const noActive = planRestore(saved, null, () => true);
  check(noActive.active === "C:/Docs/a.md", "no remembered tab → the first is active", String(noActive.active));

  const staleActive = planRestore(saved, "C:/Docs/gone.md", () => true);
  check(
    staleActive.active === "C:/Docs/a.md",
    "a remembered tab that is not in the list → the first is active",
    String(staleActive.active),
  );
}

console.log("\n=== planRestore drops duplicates without counting them missing ===");
{
  const saved = ["C:/Docs/a.md", "C:/Docs/a.md", "C:/Docs/b.md"];
  const plan = planRestore(saved, "C:/Docs/a.md", () => true);
  check(plan.tabs.length === 2, "the duplicate is dropped", plan.tabs.join(", "));
  check(plan.missing === 0, "a duplicate is not a missing file", String(plan.missing));
  onWindows(() => {
    const mixed = ["C:/Docs/a.md", "c:/docs/A.MD"];
    check(
      planRestore(mixed, null, () => true).tabs.length === 1,
      "on Windows two spellings of one path restore once",
    );
  });
}

console.log("\n=== an empty or overlong list is handled ===");
{
  const none = planRestore([], "C:/Docs/a.md", () => true);
  check(none.tabs.length === 0, "nothing saved restores nothing");
  check(none.active === null, "and nothing is active");
  check(none.missing === 0, "nothing is missing");

  const overlong = Array.from({ length: MAX_LAST_TABS + 5 }, (_, i) => `C:/Docs/file${i}.md`);
  const plan = planRestore(overlong, null, () => true);
  check(plan.tabs.length === MAX_LAST_TABS, `restores at most ${MAX_LAST_TABS}`, String(plan.tabs.length));
  check(plan.tabs[0] === "C:/Docs/file0.md", "from the front of the list");
}

// ---------------------------------------------------------------------------
console.log("\n=== the session store and the plan agree on path identity ===");
{
  onWindows(() => {
    const store = createSessionStore();
    const first = store.active();
    first.path = "C:/Docs/note.md";
    check(
      store.findByPath("c:/docs/NOTE.md") === first,
      "the store treats the two spellings as one file",
    );
    // The store would refuse to open the second spelling as a new tab, so the
    // remembered list must refuse to store it twice — otherwise a launch would
    // behave differently from the same files opened by hand.
    const remembered = rememberTabs([first, session("2", "c:/docs/NOTE.md")], "2");
    check(remembered.tabs.length === 1, "rememberTabs keeps one entry for them", String(remembered.tabs.length));
    check(remembered.active === "c:/docs/NOTE.md", "and the active spelling is the one stored");
  });
}

const passed = checks.filter((entry) => entry.ok).length;
console.log(`\n${passed}/${checks.length} checks passed`);
process.exit(passed === checks.length ? 0 : 1);
