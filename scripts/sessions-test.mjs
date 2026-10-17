// Unit tests for the session store.
//
//   node scripts/sessions-test.mjs
//
// This is the only layer that runs without the application. `src/sessions.ts`
// has no runtime imports (only `import type`), and Node 24 strips TypeScript
// types, so the module is imported as-is — no build step, no bundler.
//
// What it is for: the tab shell's rules are decisions about a list — insert after
// the active session, which neighbour takes over when one closes, what a new
// untitled tab is called, whether two paths name the same file. Those are cheap
// to test here and awkward to reach through the UI, which is why
// `document-tabs-test.mjs` proves the behaviour a reader sees and this file
// pins the rules underneath it.

import { createSessionStore } from "../src/sessions.ts";

const checks = [];
function check(ok, label, detail = "") {
  checks.push({ ok, label, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}

const names = (store) => store.list().map((session) => session.name);
const ids = (store) => store.list().map((session) => session.id);

/** The shell names a new session; the store only supplies the unique name. */
function untitled(store, name = store.untitledName()) {
  const session = store.create();
  session.name = name;
  store.add(session);
  return session;
}

// ---------------------------------------------------------------------------
console.log("=== a new store holds one empty document ===");
{
  const store = createSessionStore();
  const first = store.active();
  check(store.list().length === 1, "one session", String(store.list().length));
  check(first.name === "Untitled", "it is called Untitled", first.name);
  check(first.path === null, "it has no path");
  check(first.language === "markdown", "it starts as Markdown", first.language);
  check(first.dirty === false, "it is clean");
  check(first.editorState === null, "it has no captured state yet");
  check(store.list()[0] === first, "list() returns the same object", "identity");
  check(store.byId(first.id) === first, "byId finds it");
  check(store.byId("doc-does-not-exist") === undefined, "byId returns undefined for an unknown id");
}

// ---------------------------------------------------------------------------
console.log("\n=== add inserts after the active session and activates it ===");
{
  const store = createSessionStore();
  const first = store.active();
  const second = untitled(store, "Untitled 2");
  const third = untitled(store, "Untitled 3");
  check(
    ids(store).join(",") === [first.id, third.id, second.id].join(",") ||
      ids(store).join(",") === [first.id, second.id, third.id].join(","),
    "the list keeps insertion order",
    names(store).join(", "),
  );
  check(store.active() === third, "the last added session is active", store.active().name);

  // Adding after the active session, not at the end.
  store.setActive(second.id);
  const fourth = untitled(store, "Untitled 4");
  const order = ids(store);
  check(
    order.indexOf(fourth.id) === order.indexOf(second.id) + 1,
    "a new session is inserted directly after the active one",
    names(store).join(", "),
  );
}

// ---------------------------------------------------------------------------
console.log("\n=== untitledName avoids a collision ===");
{
  const store = createSessionStore();
  check(store.untitledName() === "Untitled 2", "the open Untitled takes the first name", store.untitledName());
  untitled(store, "Untitled 2");
  check(store.untitledName() === "Untitled 3", "then the next free number", store.untitledName());
  untitled(store, "Untitled 3");
  check(store.untitledName() === "Untitled 4", "and so on", store.untitledName());

  // A session with a path is a file, whatever it is called: it must not reserve
  // an untitled name. (The shell names saved tabs from the file.)
  const saved = store.create();
  saved.path = "C:\\notes\\Untitled.md";
  saved.name = "Untitled.md";
  store.add(saved);
  check(
    store.untitledName() === "Untitled 4",
    "a saved file named Untitled does not consume an untitled name",
    store.untitledName(),
  );
}

// ---------------------------------------------------------------------------
console.log("\n=== findByPath treats one file as one tab ===");
{
  const store = createSessionStore();
  const first = store.active();
  first.path = "C:\\Users\\ana\\Docs\\Notes.md";
  first.name = "Notes.md";
  first.directory = "C:\\Users\\ana\\Docs";

  check(store.findByPath("C:\\Users\\ana\\Docs\\Notes.md") === first, "the exact path matches");
  check(
    store.findByPath("C:/Users/ana/Docs/Notes.md") === first,
    "a forward-slash spelling matches the same file",
    "separators",
  );
  check(
    store.findByPath("C:\\Users\\ana\\Docs\\Notes.md\\") === first,
    "a trailing separator is ignored",
  );
  check(store.findByPath("C:\\Users\\ana\\Docs\\Other.md") === undefined, "a different file does not match");
  check(store.findByPath("Notes.md") === undefined, "a relative path is not guessed at");

  // The case-fold is a Windows rule. Reading it here keeps the platform branch
  // honest on a host whose own filesystem does not fold case.
  const savedNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  try {
    Object.defineProperty(globalThis, "navigator", {
      value: { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
      configurable: true,
    });
    check(
      store.findByPath("c:\\users\\ANA\\docs\\notes.MD") === first,
      "on Windows the compare folds case",
      "windows branch",
    );
  } finally {
    if (savedNavigator) Object.defineProperty(globalThis, "navigator", savedNavigator);
    else delete globalThis.navigator;
  }

  Object.defineProperty(globalThis, "navigator", {
    value: { userAgent: "Mozilla/5.0 (X11; Linux x86_64)" },
    configurable: true,
  });
  try {
    check(
      store.findByPath("C:\\Users\\ana\\Docs\\notes.md") === undefined,
      "elsewhere case is significant, so Notes.md and notes.md stay two files",
      "posix branch",
    );
  } finally {
    if (savedNavigator) Object.defineProperty(globalThis, "navigator", savedNavigator);
    else delete globalThis.navigator;
  }
}

// ---------------------------------------------------------------------------
console.log("\n=== remove hands back the neighbour that takes the space ===");
{
  const store = createSessionStore();
  const a = store.active();
  a.name = "a.md";
  const b = untitled(store, "b");
  const c = untitled(store, "c");

  // Removing a middle active session: the next one takes over.
  store.setActive(b.id);
  const nextAfterB = store.remove(b.id);
  check(nextAfterB === c, "removing the active middle session returns the one after it", nextAfterB?.name);
  check(store.active() === c, "and that session is already active", store.active().name);
  check(names(store).join(",") === "a.md,c", "the list lost only that session", names(store).join(","));

  // Removing the last session: the previous one takes over.
  const nextAfterC = store.remove(c.id);
  check(nextAfterC === a, "removing the last session returns the one before it", nextAfterC?.name);
  check(store.active() === a, "and it is active", store.active().name);

  // Removing an inactive session returns nothing and changes nothing.
  const d = untitled(store, "d");
  store.setActive(a.id);
  check(store.remove(d.id) === null, "removing an inactive session returns null");
  check(store.active() === a, "the active session is untouched", store.active().name);
  check(store.remove("doc-does-not-exist") === null, "an unknown id is a no-op");
}

// ---------------------------------------------------------------------------
console.log("\n=== the last session is the shell's problem, not the store's ===");
{
  const store = createSessionStore();
  const only = store.active();
  check(store.remove(only.id) === null, "removing the only session returns null");
  check(store.list().length === 0, "the list is empty", String(store.list().length));
  let threw = false;
  try {
    store.active();
  } catch {
    threw = true;
  }
  check(threw, "and there is no active session to report");
  // closeSession() replaces the last tab instead of removing it; this is why.
}

// ---------------------------------------------------------------------------
console.log("\n=== next and previous wrap, and never return undefined ===");
{
  const store = createSessionStore();
  const a = store.active();
  a.name = "a";
  const b = untitled(store, "b");
  const c = untitled(store, "c");

  store.setActive(c.id);
  check(store.next() === a, "next from the last wraps to the first", store.next().name);
  check(store.previous() === b, "previous from the last is the one before it", store.previous().name);
  store.setActive(a.id);
  check(store.previous() === c, "previous from the first wraps to the last", store.previous().name);
  check(store.next() === b, "next from the first is the second", store.next().name);

  const single = createSessionStore();
  check(single.next() === single.active(), "with one tab next returns it");
  check(single.previous() === single.active(), "and previous returns it");
}

// ---------------------------------------------------------------------------
console.log("\n=== list() is a copy and setActive rejects an unknown id ===");
{
  const store = createSessionStore();
  const copy = store.list();
  copy.push(store.create());
  check(store.list().length === 1, "mutating the returned array does not change the store", String(store.list().length));

  let threw = false;
  try {
    store.setActive("doc-nope");
  } catch {
    threw = true;
  }
  check(threw, "setActive throws rather than returning undefined");
  check(store.list().length === 1, "and it did not disturb the list");
}

// ---------------------------------------------------------------------------
const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length > 0) {
  console.log("\nFailed:");
  for (const f of failed) console.log(`  - ${f.label}${f.detail ? `: ${f.detail}` : ""}`);
}
process.exit(failed.length === 0 ? 0 : 1);
