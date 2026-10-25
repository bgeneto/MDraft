// Unit tests for the P0 data-safety layer.
//
//   node scripts/p0-unit.mjs
//
// No application and no build. `src/recovery.ts`, `src/disk-change.ts` and
// `src/typst-commands.ts` have no runtime imports beyond their own types, so
// Node 24 can load them after stripping TypeScript.

import { buildRecoveryEntry, createRecoveryScheduler, newRecoveryId } from "../src/recovery.ts";
import { classifyDiskChange } from "../src/disk-change.ts";
import { createDocumentLifecycle } from "../src/document-lifecycle.ts";
import { createSessionStore } from "../src/sessions.ts";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import {
  TYPST_DISPLAY_MATH,
  TYPST_OUTLINE,
  TYPST_QUOTE,
  TYPST_RULE,
  TYPST_TABLE,
  typstHeadingLine,
  typstInline,
  typstShiftHeadingLine,
  typstUnsupported,
} from "../src/typst-commands.ts";

const checks = [];
function check(ok, label, detail = "") {
  checks.push({ ok, label, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` - ${detail}` : ""}`);
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function session(id, overrides = {}) {
  return {
    id,
    path: "C:\\notes\\chapter.md",
    name: "chapter.md",
    directory: "C:\\notes",
    language: "markdown",
    savedContent: "saved\n",
    dirty: true,
    revision: 0,
    lineEnding: "\n",
    hadBom: false,
    lossy: false,
    size: 6,
    modifiedMs: 100,
    sha256: "sha:saved\n",
    readOnly: false,
    recoveryId: null,
    draft: null,
    conflict: null,
    editorState: null,
    previewScroll: 0,
    editorScroll: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Recovery entry
// ---------------------------------------------------------------------------

{
  const s = session("s1", { recoveryId: null });
  const entry = buildRecoveryEntry(s, "draft\n");
  check(/^[A-Za-z0-9_-]+$/.test(entry.id), "a recovery id is filename-safe", entry.id);
  check(s.recoveryId === entry.id, "the session remembers the generated id");
  check(entry.path === "C:\\notes\\chapter.md", "the entry carries the path");
  check(entry.name === "chapter.md", "the entry carries the name");
  check(entry.language === "markdown", "the entry carries the language");
  check(entry.content === "draft\n", "the entry carries the buffer");
  check(entry.lineEnding === "\n", "the entry carries the line ending");
  check(entry.baseModifiedMs === 100 && entry.baseSize === 6, "the entry carries the disk base");
  check(entry.baseSha256 === "sha:saved\n", "the entry carries the disk revision hash");
  check(entry.updatedMs === 0, "the host stamps updatedMs, not this builder");

  const reused = buildRecoveryEntry(s, "draft 2\n");
  check(reused.id === entry.id, "a second write reuses the same journal id");
  check(newRecoveryId() !== newRecoveryId(), "new ids differ");
}

// ---------------------------------------------------------------------------
// Recovery scheduler
// ---------------------------------------------------------------------------

{
  const saves = [];
  const removes = [];
  const notices = [];
  const scheduler = createRecoveryScheduler({
    save: async (entry) => saves.push(entry),
    remove: async (id) => removes.push(id),
    notify: (message) => notices.push(message),
    debounceMs: 10,
  });
  const s = session("s2", { recoveryId: null });

  scheduler.schedule(s, "first\n");
  scheduler.schedule(s, "second\n");
  await delay(35);
  check(
    saves.length === 1,
    "two changes inside the debounce produce one write",
    String(saves.length),
  );
  check(saves[0]?.content === "second\n", "the newest text wins");

  await scheduler.flush(s, "third\n");
  check(saves.length === 2 && saves[1].content === "third\n", "flush bypasses the timer");
  check(saves[1].baseModifiedMs === s.modifiedMs, "flush uses the current disk base");

  await scheduler.forget(s);
  check(removes.length === 1 && removes[0] === saves[0].id, "forget removes the journal id");
  check(s.recoveryId === null, "forget clears the session id");

  scheduler.dispose();
}

{
  // A forget must wait for an in-flight save, or the older write can recreate
  // the entry after the remove.
  const order = [];
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const removes = [];
  const scheduler = createRecoveryScheduler({
    save: async () => {
      order.push("save-start");
      await gate;
      order.push("save-end");
    },
    remove: async (id) => {
      order.push("remove");
      removes.push(id);
    },
    notify: () => {},
    debounceMs: 10,
  });
  const s = session("s3", { recoveryId: null });

  const flushing = scheduler.flush(s, "draft\n");
  // Let the queued task enter `save` before the forget invalidates later work.
  await delay(0);
  const forgetting = scheduler.forget(s);
  release();
  await Promise.all([flushing, forgetting]);
  check(
    order.join(",") === "save-start,save-end,remove",
    "remove is serialised behind the save",
    order.join(","),
  );
  check(removes.length === 1, "the serialised forget still removes");
  scheduler.dispose();
}

{
  const notices = [];
  const scheduler = createRecoveryScheduler({
    save: async () => {
      throw new Error("disk full");
    },
    remove: async () => {},
    notify: (message) => notices.push(message),
    debounceMs: 5,
  });
  const s = session("s4", { recoveryId: null });
  scheduler.schedule(s, "one\n");
  await delay(20);
  scheduler.schedule(s, "two\n");
  await delay(20);
  check(notices.length === 1, "a persistent save failure is reported once", String(notices.length));
  check(notices[0]?.includes("disk full"), "the notice names the failure");
  scheduler.dispose();
}

{
  const removes = [];
  const scheduler = createRecoveryScheduler({
    save: async () => {},
    remove: async (id) => removes.push(id),
    notify: () => {},
    debounceMs: 5,
  });
  const s = session("s5", { recoveryId: "old-entry" });
  scheduler.schedule(s, s.savedContent);
  await delay(15);
  check(removes[0] === "old-entry", "writing the saved content forgets the old entry");
  scheduler.dispose();
}

// ---------------------------------------------------------------------------
// Disk change classification
// ---------------------------------------------------------------------------

{
  const base = session("d1");
  check(
    classifyDiskChange(base, { exists: true, size: 6, modifiedMs: 100, readOnly: false }) ===
      "unchanged",
    "same size and mtime is unchanged",
  );
  check(
    classifyDiskChange(base, { exists: true, size: 7, modifiedMs: 100, readOnly: false }) ===
      "modified",
    "a size change is modified",
  );
  check(
    classifyDiskChange(base, { exists: true, size: 6, modifiedMs: 101, readOnly: false }) ===
      "modified",
    "an mtime change is modified",
  );
  check(
    classifyDiskChange(base, { exists: false, size: 0, modifiedMs: 0, readOnly: false }) ===
      "deleted",
    "a missing file is deleted",
  );
  check(
    classifyDiskChange(session("d2", { path: null }), {
      exists: false,
      size: 0,
      modifiedMs: 0,
      readOnly: false,
    }) === "unchanged",
    "an untitled buffer has no disk state",
  );
}

// ---------------------------------------------------------------------------
// Typst commands
// ---------------------------------------------------------------------------

{
  check(typstHeadingLine("Title", 1) === "= Title", "heading 1 uses one equals");
  check(typstHeadingLine("Title", 4) === "==== Title", "heading 4 uses four equals");
  check(typstHeadingLine("  = Title", 2) === "  == Title", "heading keeps indentation");
  check(typstHeadingLine("  = Title", 0) === "  Title", "paragraph strips the marker");
  check(typstHeadingLine("Title", 9) === "====== Title", "heading caps at six");
  check(typstShiftHeadingLine("= Title", 1) === "== Title", "shift down adds a level");
  check(typstShiftHeadingLine("=== Title", -1) === "== Title", "shift up removes a level");
  check(typstShiftHeadingLine("Title", -1) === "= Title", "a paragraph becomes a heading");
  check(typstShiftHeadingLine("Title", 1) === "Title", "a paragraph does not shift down");

  check(TYPST_QUOTE.text.startsWith("#quote(block: true)["), "quote uses #quote(block)");
  check(
    TYPST_QUOTE.text[TYPST_QUOTE.caret - 1] === "\n",
    "quote caret starts on the empty body line",
  );
  check(TYPST_TABLE.text.startsWith("#table("), "table uses #table");
  check(
    TYPST_TABLE.text[TYPST_TABLE.caret - 1] === "[",
    "table caret starts inside the first cell",
  );
  check(TYPST_RULE === "#line(length: 100%)", "rule uses #line");
  check(TYPST_OUTLINE === "#outline()", "TOC uses #outline");
  check(TYPST_DISPLAY_MATH.text.startsWith("$ "), "display math opens with a spaced dollar");
  check(TYPST_DISPLAY_MATH.text.endsWith(" $"), "display math closes with a spaced dollar");

  check(typstInline("strong").before === "*" && typstInline("strong").after === "*", "strong is *");
  check(
    typstInline("emphasis").before === "_" && typstInline("emphasis").after === "_",
    "emphasis is _",
  );
  check(typstInline("strike").before === "#strike[", "strike uses #strike");
  check(typstInline("link").before === '#link("https://")[', "link uses #link");
  check(typstInline("math").before === "$", "inline math is $");
  check(typstUnsupported("task").length > 0, "task has a note");
  check(typstUnsupported("alert").length > 0, "alert has a note");
  check(typstUnsupported("frontMatter").length > 0, "front matter has a note");
}

// The controller below is the same orchestration used by main.ts, with delayed
// IO instead of timing assumptions. Assert text/bytes/journal, not just counters.
function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** A stand-in for the Rust digest: an exact content identity is all the shell sees. */
const digest = (text) => `sha:${text}`;

function lifecycleHarness(overrides = {}) {
  const store = createSessionStore();
  const texts = new Map(),
    disk = new Map(),
    entries = new Map(),
    notices = [];
  const first = store.active();
  function add(s, path, content = "base", dirty = true) {
    Object.assign(s, {
      path,
      name: path ?? "Untitled",
      savedContent: "base",
      dirty,
      modifiedMs: path ? 100 : 0,
      size: 4,
      sha256: path ? digest("base") : null,
    });
    texts.set(s.id, content);
    if (path) disk.set(path, { content: "base", modifiedMs: 100, size: 4, sha256: digest("base") });
    return s;
  }
  add(first, "a.md");
  const recovery = createRecoveryScheduler({
    save: async (e) => entries.set(e.id, e),
    remove: async (id) => entries.delete(id),
    notify: (text) => notices.push(text),
    debounceMs: 10000,
  });
  const deps = {
    sessions: store,
    text: (s) => texts.get(s.id),
    recovery,
    stat: async (path) => ({ exists: disk.has(path), readOnly: false, ...disk.get(path) }),
    read: async (path) => ({
      path,
      name: path,
      directory: "",
      tokens: 1,
      lineEnding: "\n",
      hadBom: false,
      lossy: false,
      readOnly: false,
      ...disk.get(path),
    }),
    write: async (path, content, eol, bom, expected) => {
      const current = disk.get(path);
      if (expected !== null && current?.sha256 !== expected) {
        return {
          written: false,
          change: current ? "modified" : "deleted",
          size: current?.size ?? 0,
          modifiedMs: current?.modifiedMs ?? 0,
          sha256: current?.sha256 ?? "",
        };
      }
      const info = {
        written: true,
        change: "saved",
        modifiedMs: (disk.get(path)?.modifiedMs ?? 100) + 1,
        size: content.length,
        sha256: digest(content),
      };
      disk.set(path, {
        content,
        modifiedMs: info.modifiedMs,
        size: info.size,
        sha256: info.sha256,
      });
      return info;
    },
    choosePath: async () => "copy.md",
    decide: async () => "cancel",
    replace: (s, payload) => {
      Object.assign(s, {
        savedContent: payload.content,
        modifiedMs: payload.modifiedMs,
        size: payload.size,
        sha256: payload.sha256 ?? digest(payload.content),
        conflict: null,
      });
      s.revision++;
      texts.set(s.id, payload.content);
    },
    adoptPath: (s, path) => {
      s.path = path;
      s.name = path;
    },
    changed: () => {},
    conflict: (s, kind) => {
      s.conflict = kind;
    },
    notify: (text) => notices.push(text),
    committing: () => {},
    ...overrides,
  };
  const controller = createDocumentLifecycle(deps);
  const edit = (s, text) => {
    texts.set(s.id, text);
    s.revision++;
    s.dirty = text !== s.savedContent;
    recovery.schedule(s, text);
  };
  return { store, first, texts, disk, entries, notices, recovery, deps, controller, edit, add };
}

{
  const entered = deferred(),
    gate = deferred();
  const h = lifecycleHarness();
  const realWrite = h.deps.write;
  h.deps.write = async (...args) => {
    entered.resolve();
    await gate.promise;
    return realWrite(...args);
  };
  h.edit(h.first, "first edit");
  const saving = h.controller.save(h.first);
  await entered.promise;
  h.edit(h.first, "first edit plus typing");
  gate.resolve();
  await saving;
  check(h.disk.get("a.md").content === "first edit", "save writes the captured snapshot");
  check(h.first.dirty, "typing during save remains dirty");
  check(h.texts.get(h.first.id) === "first edit plus typing", "save never replaces newer text");
  check(
    [...h.entries.values()][0]?.content === "first edit plus typing",
    "newer text remains journaled",
  );
  check(
    [...h.entries.values()][0]?.baseModifiedMs === h.first.modifiedMs,
    "journal adopts the written disk baseline",
  );
  check(h.first.sha256 === digest("first edit"), "the baseline hash follows the written snapshot");
  check(
    [...h.entries.values()][0]?.baseSha256 === digest("first edit"),
    "journal records the base hash of the written revision",
  );
  await h.controller.save(h.first);
  check(
    h.disk.get("a.md").content === "first edit plus typing",
    "second save writes the final text",
  );
  check(
    !h.first.dirty && h.entries.size === 0,
    "only the saved current revision is clean and unjournaled",
  );
  h.recovery.dispose();
}

{
  const h = lifecycleHarness();
  let expected = "unset";
  const realWrite = h.deps.write;
  h.deps.write = async (...args) => {
    expected = args[4];
    return realWrite(...args);
  };
  h.edit(h.first, "checked save");
  await h.controller.save(h.first);
  check(expected === digest("base"), "save forwards the session's baseline hash");
  check(
    h.first.sha256 === digest("checked save") && !h.first.dirty,
    "a successful checked save adopts the returned digest",
  );
  h.recovery.dispose();
}

{
  const h = lifecycleHarness();
  h.edit(h.first, "local text survives a conflict");
  h.deps.write = async () => ({
    written: false,
    change: "modified",
    size: 11,
    modifiedMs: 200,
    sha256: digest("external text"),
  });
  const saved = await h.controller.save(h.first);
  await h.recovery.flush(h.first);
  check(!saved && h.first.dirty, "a checked-write conflict refuses the save and keeps the text");
  check(h.first.conflict === "modified", "a checked-write conflict raises the normal notice");
  check(
    h.disk.get("a.md").content === "base" &&
      h.texts.get(h.first.id) === "local text survives a conflict",
    "a checked-write conflict leaves both disk and buffer untouched",
  );
  check(
    [...h.entries.values()].some((e) => e.content === "local text survives a conflict"),
    "a checked-write conflict keeps the recovery entry",
  );
  const automatic = await h.controller.save(h.first, true);
  check(!automatic, "Auto Save is refused by the same checked-write conflict");
  await h.controller.poll();
  check(h.first.conflict === "modified", "an unchanged-stat poll cannot clear a content conflict");
  check(
    h.first.dirty && h.first.sha256 === digest("base"),
    "polling an unresolved conflict preserves its dirty baseline",
  );
  h.recovery.dispose();
}

{
  const entered = deferred(),
    gate = deferred();
  const h = lifecycleHarness();
  h.first.dirty = false;
  h.disk.set("a.md", { content: "external", modifiedMs: 200, size: 8 });
  const read = h.deps.read;
  h.deps.read = async (p) => {
    const payload = await read(p);
    entered.resolve();
    await gate.promise;
    return payload;
  };
  const polling = h.controller.poll();
  await entered.promise;
  h.edit(h.first, "local typing");
  gate.resolve();
  await polling;
  check(
    h.texts.get(h.first.id) === "local typing",
    "pending auto reload cannot replace newer typing",
  );
  check(
    h.first.dirty && h.first.savedContent === "base",
    "stale read cannot clean or change baseline",
  );
  check(h.first.conflict === "modified", "stale external read leaves a visible conflict");
  await h.recovery.flush(h.first);
  check(
    [...h.entries.values()][0]?.content === "local typing",
    "reload retains recovery of newer typing",
  );
  h.recovery.dispose();
}

{
  const picked = deferred(),
    entered = deferred(),
    written = deferred(),
    gate = deferred();
  const h = lifecycleHarness({
    choosePath: async () => {
      entered.resolve();
      return picked.promise;
    },
  });
  const a = h.first,
    b = h.add(h.store.create(), "b.md", "B text");
  h.store.add(b);
  const realWrite = h.deps.write;
  let saveAsExpected = "unset";
  h.deps.write = async (...args) => {
    saveAsExpected = args[4];
    written.resolve();
    await gate.promise;
    return realWrite(...args);
  };
  h.edit(a, "A text");
  const saving = h.controller.saveAs(a);
  await entered.promise;
  h.store.setActive(b.id);
  picked.resolve("copy.md");
  await written.promise;
  h.edit(a, "A newer text");
  gate.resolve();
  await saving;
  check(
    a.path === "copy.md" && b.path === "b.md",
    "Save As keeps its initiating session across dialog/write",
  );
  check(h.texts.get(b.id) === "B text", "Save As cannot overwrite the newly active tab");
  check(h.store.active() === b, "Save As does not steal focus back from another tab");
  check(
    h.texts.get(a.id) === "A newer text" && a.dirty,
    "Save As retains newer edits in the original tab",
  );
  check(h.disk.get("copy.md").content === "A text", "Save As records exactly the copied bytes");
  check(saveAsExpected === null, "Save As has no baseline hash to check");
  check(
    [...h.entries.values()].some((e) => e.path === "copy.md" && e.content === "A newer text"),
    "Save As journals newer text under its new path",
  );
  h.recovery.dispose();
}

{
  const entered = deferred(),
    gate = deferred();
  const h = lifecycleHarness();
  let concurrent = 0,
    max = 0,
    writes = 0;
  const realWrite = h.deps.write;
  h.deps.write = async (...args) => {
    concurrent++;
    max = Math.max(max, concurrent);
    writes++;
    if (writes === 1) {
      entered.resolve();
      await gate.promise;
    }
    const info = await realWrite(...args);
    concurrent--;
    return info;
  };
  h.edit(h.first, "one");
  const firstSave = h.controller.save(h.first);
  await entered.promise;
  h.edit(h.first, "two");
  const secondSave = h.controller.save(h.first, true);
  gate.resolve();
  await Promise.all([firstSave, secondSave]);
  check(max === 1 && writes === 2, "manual and Auto Save writes are serialized");
  check(
    h.disk.get("a.md").content === "two" && !h.first.dirty,
    "last queued save keeps the latest bytes",
  );
  h.recovery.dispose();
}

{
  const h = lifecycleHarness();
  const b = h.add(h.store.create(), "b.md", "B edits");
  h.store.add(b);
  h.edit(h.first, "A edits");
  h.edit(b, "B edits");
  await h.recovery.flushAll([h.first, b]);
  const decisions = ["discard", "cancel"];
  h.deps.decide = async () => decisions.shift();
  let finalized = false;
  const ok = await h.controller.close([h.first, b], () => {
    finalized = true;
    return true;
  });
  check(
    !ok && !finalized && h.store.list().length === 2,
    "later Cancel aborts bulk close without removing tabs",
  );
  check(h.entries.size === 2, "an uncommitted Discard cannot remove recovery");
  h.deps.decide = async () => "discard";
  check(
    await h.controller.close([h.first, b], () => true, true),
    "explicit Discard can finish window close",
  );
  check(h.entries.size === 0, "successful window Discard does not recreate recovery in finally");
  h.recovery.dispose();
}

{
  const h = lifecycleHarness();
  h.edit(h.first, "draft");
  h.deps.decide = async () => {
    h.edit(h.first, "newer during decision");
    return "discard";
  };
  check(
    !(await h.controller.close([h.first], () => true)),
    "a stale Discard decision cannot close newer edits",
  );
  check(
    [...h.entries.values()][0]?.content === "newer during decision",
    "aborted close protects the latest revision",
  );
  h.recovery.dispose();
}

{
  const h = lifecycleHarness({ decide: async () => "save", choosePath: async () => null });
  h.first.path = null;
  h.edit(h.first, "untitled draft");
  check(!(await h.controller.close([h.first], () => true)), "Save As cancellation aborts close");
  check(
    h.first.dirty && [...h.entries.values()][0]?.content === "untitled draft",
    "cancelled untitled save retains text and journal",
  );
  h.recovery.dispose();
}

{
  const h = lifecycleHarness({
    write: async () => {
      throw Error("disk full");
    },
  });
  h.edit(h.first, "draft");
  await h.recovery.flush(h.first);
  let failed = false;
  try {
    await h.controller.save(h.first);
  } catch {
    failed = true;
  }
  check(
    failed && h.first.dirty && h.entries.size === 1,
    "write failure leaves dirty work and recovery intact",
  );
  h.deps.decide = async () => "cancel";
  check(
    !(await h.controller.close([h.first], () => true)),
    "failed save does not poison later cancellation",
  );
  h.recovery.dispose();
}

{
  const h = lifecycleHarness();
  h.first.lossy = true;
  h.edit(h.first, "recovered \ufffd");
  check(!(await h.controller.save(h.first, true)), "Auto Save refuses legacy lossy recovery");
  check(
    h.disk.get("a.md").content === "base" && h.first.dirty,
    "lossy Auto Save cannot alter the original",
  );
  h.deps.choosePath = async () => "a.md";
  check(!(await h.controller.saveAs(h.first)), "same-path Save As cannot bypass lossy protection");
  h.deps.choosePath = async () => "utf8-copy.md";
  check(await h.controller.save(h.first), "acknowledged legacy text can be saved to a UTF-8 copy");
  check(
    h.first.path === "utf8-copy.md" && !h.first.lossy && h.disk.get("a.md").content === "base",
    "copy clears legacy flag without rewriting the original",
  );
  h.recovery.dispose();
}

{
  const h = lifecycleHarness();
  const b = h.add(h.store.create(), "copy.md", "other edits");
  h.store.add(b);
  check(
    !(await h.controller.saveAs(h.first)),
    "Save As refuses a destination already owned by another tab",
  );
  check(
    h.store.byId(b.id) === b && h.texts.get(b.id) === "other edits",
    "target collision cannot discard another buffer",
  );
  h.recovery.dispose();
}

{
  const entered = deferred(),
    gate = deferred();
  const h = lifecycleHarness({ decide: async () => "discard" });
  const read = h.deps.read;
  h.deps.read = async (p) => {
    entered.resolve();
    await gate.promise;
    return read(p);
  };
  h.edit(h.first, "draft");
  const reload = h.controller.reload(h.first);
  await entered.promise;
  h.edit(h.first, "newer draft");
  gate.resolve();
  check(
    !(await reload) && h.texts.get(h.first.id) === "newer draft",
    "explicit Reload also refuses a stale replacement",
  );
  check(h.first.dirty, "cancelled stale Reload leaves dirty state intact");
  h.recovery.dispose();
}

// Execute the real shell export functions with deferred picker/render/tool IO.
// Importing main.ts directly would boot a webview; AST selection keeps its actual
// function bodies while supplying only the browser/IO boundary they depend on.
const shell = ts.createSourceFile(
  "main.ts",
  readFileSync(new URL("../src/main.ts", import.meta.url), "utf8"),
  ts.ScriptTarget.Latest,
  true,
);
const exportNames = [
  "exportSource",
  "documentStem",
  "exportSuggestion",
  "directoryOf",
  "buildExportArticle",
  "exportHtml",
  "exportPdf",
  "exportPdfBrowser",
  "exportWithPandoc",
];
const exportCode = ts.transpileModule(
  shell.statements
    .filter((n) => ts.isFunctionDeclaration(n) && exportNames.includes(n.name?.text))
    .map((n) => n.getText(shell))
    .join("\n"),
  {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  },
).outputText;
function exportHarness(language, delay) {
  const entered = deferred(),
    release = deferred(),
    calls = [],
    errors = [];
  const first = {
    name: "origin.md",
    path: "/origin/origin.md",
    directory: "/origin",
    language,
    text: "ORIGINAL SOURCE",
    lineEnding: "\r\n",
    hadBom: true,
  };
  const second = {
    ...first,
    name: "other.html",
    path: "/other/other.html",
    directory: "/other",
    language: "html",
    text: "OTHER BUFFER",
  };
  const pause = async (kind) => {
    if (delay === kind) {
      entered.resolve();
      await release.promise;
    }
  };
  const context = {
    doc: first,
    settings: { lastDirectory: null, enableMath: true, enableMermaid: true },
    isDark: false,
    KATEX_STYLESHEET_URL: "katex.css",
    pandocCache: null,
    typstCache: { found: true },
    textOf: (s) => s.text,
    editor: { getDoc: () => context.doc.text },
    customImageFolder: () => `${context.doc.directory}/images`,
    saveDialog: async () => {
      await pause("picker");
      return "/output/result";
    },
    toast: () => ({ dismiss() {} }),
    message: async (error) => errors.push(error),
    ask: async () => false,
    nativePrintArticle: async () => null,
    wrapNativePrintHtml: (title, html) => `${title}\n${html}`,
    keepHeadingsWithNext: () => {},
    document: { createElement: () => ({ innerHTML: "" }), getElementById: () => null },
    renderPreview: (text) => ({ html: `<p>${text}</p>` }),
    renderAsciidocPreview: async (text) => ({ html: `<p>${text}</p>` }),
    renderMermaidIn: async () => pause("article"),
    rewriteExportReferences: () => {},
    buildHtmlPrintDocument: async (text, base) => {
      calls.push({ printSource: text, base });
      await pause("html-print");
      return text;
    },
    exportFontCss: async () => "",
    exportTypographyCss: () => "",
    highlightThemeCss: () => "",
    wrapStandaloneHtml: (title, html) => `${title}\n${html}`,
    wrapPrintHtml: (title, html) => `${title}\n${html}`,
    refreshPandocStatus: async () => {
      await pause("tools");
      context.pandocCache = { found: true };
    },
    refreshTypstStatus: async () => {},
    pandocSetup: async () => {},
    typstSetup: async () => {},
    renderAsciidocForExport: async (text, opts) => {
      calls.push({ converted: text, base: opts.baseDir });
      await pause("convert");
      return `<p>${text}</p>`;
    },
    basename: (name) => name.split("/").pop(),
    console: { info() {} },
    api: {
      writeDocument: async (target, content, eol, bom) => calls.push({ target, content, eol, bom }),
      runAfterExport: async () => ({ afterErrors: [] }),
      printDocument: async (content, stem) => {
        calls.push({ content, stem });
        return "/print.html";
      },
      renderTypst: async (_path, text) => ({ html: text, css: "" }),
      runExport: async (request) => {
        calls.push(request);
        return { outputPath: request.outputPath, afterErrors: [] };
      },
    },
  };
  runInNewContext(
    `${exportCode}\nglobalThis.routes={exportHtml,exportPdf,exportPdfBrowser,exportWithPandoc,buildExportArticle,exportSource};`,
    context,
  );
  return { context, first, second, entered, release, calls, errors, routes: context.routes };
}
{
  const h = exportHarness("markdown", "picker");
  const job = h.routes.exportHtml();
  await h.entered.promise;
  h.context.doc = h.second;
  h.release.resolve();
  await job;
  check(
    h.errors.length === 0 && h.calls[0]?.content.includes("ORIGINAL SOURCE"),
    "HTML export retains source text across a picker tab switch",
  );
  check(
    h.calls[0]?.content.startsWith("origin.md\n") && !h.calls[0].content.includes("OTHER BUFFER"),
    "HTML export title and body belong to the same snapshot",
  );
}
{
  const h = exportHarness("html", "picker");
  const job = h.routes.exportHtml();
  await h.entered.promise;
  h.context.doc = h.second;
  h.release.resolve();
  await job;
  check(
    h.calls[0]?.content === h.first.text && h.calls[0].eol === "\r\n" && h.calls[0].bom === true,
    "HTML source copy retains initiating bytes and write format",
  );
}
{
  const h = exportHarness("html", "html-print");
  const job = h.routes.exportPdfBrowser();
  await h.entered.promise;
  h.context.doc = h.second;
  h.release.resolve();
  await job;
  check(
    h.calls[0]?.base === "/origin" &&
      h.calls[1]?.stem === "origin" &&
      h.calls[1].content === h.first.text,
    "HTML print retains text, resource base and filename after rendering yields",
  );
}
{
  const h = exportHarness("typst", "article");
  const job = h.routes.exportPdfBrowser();
  await h.entered.promise;
  h.context.doc = h.second;
  h.release.resolve();
  await job;
  check(
    h.calls[0]?.stem === "origin" && h.calls[0].content.startsWith("origin.md\n"),
    "Print retains the initiating name after asynchronous article rendering",
  );
  check(
    h.calls[0]?.content.includes('class="markdown-body typst-document"') &&
      h.calls[0].content.includes(h.first.text),
    "Rendered export class and text retain the initiating language",
  );
}
for (const delay of ["tools", "picker", "convert"]) {
  const h = exportHarness("asciidoc", delay);
  const job = h.routes.exportWithPandoc({ id: "latex", label: "LaTeX", extension: "tex" });
  await h.entered.promise;
  h.context.doc = h.second;
  h.release.resolve();
  await job;
  const request = h.calls.find((call) => call.formatId);
  check(
    h.errors.length === 0 &&
      request?.inputPath === h.first.path &&
      request.markdown.includes(h.first.text) &&
      request.language === "html" &&
      request.imageRoot === "/origin/images",
    `Pandoc retains source/path/language/image root during delayed ${delay}`,
  );
}

const failed = checks.filter((entry) => !entry.ok).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
