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
import { createSessionStore, pathKey } from "../src/sessions.ts";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { EditorSelection, EditorState } from "@codemirror/state";
import { history, undo } from "@codemirror/commands";
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
    encoding: "UTF-8",
    encodingBlocked: false,
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
      encoding: "UTF-8",
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
  let forwardedEncoding = "unset";
  const realWrite = h.deps.write;
  h.deps.write = async (...args) => {
    expected = args[4];
    forwardedEncoding = args[5];
    return realWrite(...args);
  };
  h.edit(h.first, "checked save");
  await h.controller.save(h.first);
  check(expected === digest("base"), "save forwards the session's baseline hash");
  check(forwardedEncoding === h.first.encoding, "save forwards the document's encoding");
  check(
    h.first.sha256 === digest("checked save") && !h.first.dirty,
    "a successful checked save adopts the returned digest",
  );
  h.recovery.dispose();
}

{
  // A save the chosen encoding cannot represent is refused without inventing a
  // replacement character, and Save As falls back to UTF-8 for the copy.
  const h = lifecycleHarness();
  h.first.encoding = "windows-1252";
  h.edit(h.first, "café 😀");
  h.deps.write = async (_path, _content, _eol, _bom, _expected, encoding) => {
    if (encoding === "windows-1252") {
      return { written: false, change: "encoding", size: 0, modifiedMs: 0, sha256: "" };
    }
    return {
      written: true,
      change: "saved",
      size: 9,
      modifiedMs: 201,
      sha256: digest("café 😀"),
    };
  };
  const refused = await h.controller.save(h.first);
  check(!refused && h.first.encodingBlocked, "an unmappable save sets the encoding-blocked flag");
  check(h.first.dirty, "an encoding refusal leaves the buffer dirty");
  check(
    h.notices.some((text) => text.includes("cannot store")),
    "an encoding refusal is explained",
  );
  h.deps.choosePath = async () => h.first.path;
  const samePath = await h.controller.saveAs(h.first);
  check(
    !samePath && h.first.encoding === "windows-1252",
    "Save As cannot UTF-8-convert the protected original in place",
  );
  h.deps.choosePath = async () => "café-utf8.md";
  const copy = await h.controller.saveAs(h.first, "café-utf8.md");
  check(copy && h.first.encoding === "UTF-8", "Save As writes the blocked text as UTF-8");
  check(h.first.path === "café-utf8.md", "the UTF-8 copy adopts its new path");
  check(!h.first.encodingBlocked, "a successful UTF-8 copy clears the blocked state");
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
  // Helpers the selected routes call. A free identifier that is neither
  // selected nor stubbed throws inside the export's own try and fails the
  // ownership checks for an unrelated reason.
  "toastReport",
  "missingResources",
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
  const legacyPaths = [];
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
    resolveLegacyImagesForExport: async (_holder, _images, path) => legacyPaths.push(path),
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
  return {
    context,
    first,
    second,
    entered,
    release,
    calls,
    errors,
    legacyPaths,
    routes: context.routes,
  };
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
  check(
    h.legacyPaths[0] === h.first.path,
    "legacy image resolution keeps the initiating document path",
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

// ---------------------------------------------------------------------------
// Shell ownership: the real `src/main.ts` bodies, selected by name, run against
// a real session store and a scripted editor. Every free identifier a selected
// function uses must be provided by the harness context.
// ---------------------------------------------------------------------------

function shellCode(names) {
  const found = shell.statements.filter(
    (n) => ts.isFunctionDeclaration(n) && names.includes(n.name?.text),
  );
  const missing = names.filter((name) => !found.some((n) => n.name.text === name));
  if (missing.length) throw new Error(`main.ts no longer declares ${missing.join(", ")}`);
  return ts.transpileModule(found.map((n) => n.getText(shell)).join("\n"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
}

/** A scripted single editor view whose programmatic edits fire the change listener. */
function scriptedEditor(context) {
  let text = "";
  const editor = {
    getDoc: () => text,
    setDoc(next) {
      const changed = next !== text;
      text = next;
      if (changed) context.onDocChanged(next);
    },
    type(next) {
      text = next;
      context.onDocChanged(next);
    },
    captureState: () => {
      const captured = text;
      return { doc: { toString: () => captured, length: captured.length } };
    },
    restoreState(state) {
      text = state.doc.toString();
    },
    view: { scrollDOM: { scrollTop: 0 }, state: { doc: { lines: 1 } } },
  };
  for (const name of [
    "setLanguage",
    "setSpellcheck",
    "focus",
    "clearDiagnostics",
    "clearSyncRange",
    "scrollToLine",
  ])
    editor[name] = () => {};
  return editor;
}

const shellNoops = [
  "stopReadAloud",
  "invalidatePreview",
  "restorePreview",
  "applyLatexMarks",
  "syncGuest",
  "resetOutline",
  "applyLayout",
  "resetTokenCount",
  "scheduleTokenCount",
  "refreshTitle",
  "refreshStatus",
  "renderDocTabs",
  "renderSidebar",
  "renderNotice",
  "scheduleOutlineRefresh",
  "scheduleRender",
  "toast",
];

function shellHarness(names, extra = {}) {
  const sessions = createSessionStore();
  const journal = new Map();
  const context = {
    sessions,
    settings: { spellcheck: false, spellcheckWords: [] },
    performance: { now: () => 0 },
    SYNC_SUPPRESS_MS: 0,
    latexProblems: [],
    latexProblemRoot: null,
    htmlScrollTop: 0,
    previewPane: { scrollTop: 0 },
    pendingPreviewScroll: null,
    suppressEditorScrollUntil: 0,
    suppressPreviewScrollUntil: 0,
    assistant: null,
    languageForExtension: () => "markdown",
    // displayDoc reads these spelling globals; the ownership tests below do not
    // exercise spelling, so the harness supplies neutral values.
    effectiveSpellingLanguage: () => "en",
    ignoredSpellingWords: () => [],
    spellingSessionKey: () => "test",
    preferences: null,
    console: { warn() {} },
    recovery: {
      schedule: (s, text) => journal.set(s.id, text),
      forget: async (s) => journal.delete(s.id),
    },
    ...extra,
  };
  for (const name of shellNoops) if (!(name in context)) context[name] = () => {};
  context.onDocChanged = (text) => {
    // The parts of the shell's change listener that ownership depends on.
    context.doc.revision += 1;
    context.doc.dirty = text !== context.doc.savedContent;
    if (context.doc.dirty) journal.set(context.doc.id, text);
    else journal.delete(context.doc.id);
  };
  context.editor = scriptedEditor(context);
  context.doc = sessions.active();
  runInNewContext(`${shellCode(names)}\nglobalThis.fns={${names.join(",")}};`, context);
  return { context, sessions, journal, fns: context.fns, editor: context.editor };
}

function describeFile(s, path, content) {
  s.path = path;
  s.name = path.split("/").pop();
  s.directory = path.slice(0, path.lastIndexOf("/"));
  s.savedContent = content;
  s.dirty = false;
}

function filePayload(path, content) {
  return {
    path,
    name: path.split("/").pop(),
    directory: path.slice(0, path.lastIndexOf("/")),
    content,
    lineEnding: "\n",
    hadBom: false,
    encoding: "UTF-8",
    lossy: false,
    readOnly: false,
    size: content.length,
    modifiedMs: 1,
    sha256: null,
    tokens: 0,
  };
}

const recoveryNames = [
  "restoreRecovery",
  "snapshotDoc",
  "displayDoc",
  "activateSession",
  "textOf",
  "closeSessions",
  "basename",
  "directoryOf",
  "languageFor",
  "recoveryLanguage",
];

/** Two open documents, A on screen and B hidden, plus the journal `entries`. */
function recoveryHarness(entries, files = {}) {
  const h = shellHarness(recoveryNames, {
    api: {
      listRecovery: async () => entries.map((item) => ({ ...item })),
      removeRecovery: async () => {},
      readDocument: async (path) => {
        await delay(1);
        if (!(path in files)) throw new Error("missing");
        return filePayload(path, files[path]);
      },
    },
    lifecycle: { close: async (_targets, finalize) => finalize(() => true) },
    loadUntitled: async () => {},
    defaultDocumentLanguage: () => "markdown",
    recoveryNotice: null,
  });
  const a = h.context.doc;
  describeFile(a, "/p/a.md", "disk A");
  h.editor.setDoc("disk A");
  const b = h.sessions.create();
  describeFile(b, "/p/b.md", "disk B");
  h.sessions.add(b);
  h.sessions.setActive(a.id);
  return { ...h, a, b };
}

const journalEntry = (path, content, updatedMs) => ({
  id: `j-${path}`,
  path,
  name: path.split("/").pop(),
  language: "markdown",
  content,
  updatedMs,
  lineEnding: "\n",
  hadBom: false,
  encoding: "UTF-8",
  lossy: false,
  readOnly: false,
  baseModifiedMs: 1,
  baseSize: 6,
  baseSha256: null,
});
const consistent = (h) =>
  h.sessions.active() === h.context.doc && h.sessions.byId(h.context.doc.id) === h.context.doc;

{
  // The hidden tab's entry is newer, so recovery activates it first. The tab on
  // screen must keep its own draft through that switch.
  const h = recoveryHarness([
    journalEntry("/p/b.md", "draft B", 2),
    journalEntry("/p/a.md", "draft A", 1),
  ]);
  await h.fns.restoreRecovery();
  check(h.context.doc === h.b, "recovery activates the newest recovered tab");
  check(h.fns.textOf(h.a) === "draft A", "the tab that was on screen keeps its recovered draft");
  check(h.fns.textOf(h.b) === "draft B", "the newest recovered tab shows its draft");
  check(h.a.dirty && h.journal.get(h.a.id) === "draft A", "the shadowed draft stays journaled");
  await h.fns.activateSession(h.a.id);
  check(h.editor.getDoc() === "draft A", "returning to the first tab shows its draft, not disk");
  check(consistent(h), "displayed and store active sessions agree after recovery");
}
{
  // The tab on screen is the newest entry and a second entry opens a new tab.
  const h = recoveryHarness(
    [journalEntry("/p/a.md", "draft A", 2), journalEntry("/p/c.md", "draft C", 1)],
    { "/p/c.md": "disk C" },
  );
  await h.fns.restoreRecovery();
  const c = h.sessions.findByPath("/p/c.md");
  check(h.context.doc === h.a && h.editor.getDoc() === "draft A", "the on-screen draft is shown");
  check(c?.draft === "draft C" && h.fns.textOf(c) === "draft C", "the new tab holds its draft");
  check(consistent(h), "a new recovered tab does not move the store's active session");
  check(
    h.sessions.next() === h.b && h.sessions.list().at(-1) === c,
    "Next Tab follows the tab on screen; recovered tabs append at the end",
  );
  await h.fns.closeSessions([h.a.id]);
  check(
    !h.sessions.byId(h.a.id) && consistent(h),
    "closing the displayed recovered tab leaves a tab that is in the store",
  );
}
{
  // An edit while later entries are still being read must build on the draft.
  const h = recoveryHarness(
    [journalEntry("/p/a.md", "draft A", 3), journalEntry("/p/c.md", "draft C", 1)],
    { "/p/c.md": "disk C" },
  );
  const job = h.fns.restoreRecovery();
  await delay(0);
  h.editor.type(`${h.editor.getDoc()}!`);
  await job;
  check(h.journal.get(h.a.id) === "draft A!", "an edit during restore journals the recovered text");
  check(consistent(h), "the active session stays consistent through an edit during restore");
}

// ---------------------------------------------------------------------------
// LaTeX export ownership (F14): the project snapshot belongs to the tab the
// export started on, even when the Pandoc lookup yields to a tab switch.
// ---------------------------------------------------------------------------

function latexExportHarness() {
  const release = deferred();
  const requests = [];
  const errors = [];
  const h = shellHarness(
    [
      "exportWithPandoc",
      "exportLatexWithWriter",
      "openWriterChooser",
      "latexExportSnapshot",
      "latexExportRequest",
      "exportSource",
      "exportSuggestion",
      "documentStem",
      "toastReport",
      "missingResources",
      "basename",
      "joinDir",
      "textOf",
    ],
    {
      pathKey,
      latexPreview: null,
      pandocCache: null,
      typstCache: { found: true },
      customImageFolder: () => null,
      toast: () => ({ dismiss() {} }),
      saveDialog: async () => "/out/result",
      message: async (text) => errors.push(String(text)),
      pandocSetup: async () => {},
      typstSetup: async () => {},
      refreshTypstStatus: async () => {},
      renderAsciidocForExport: async (text) => text,
      showWriterChooser: async () => ({ writer: "html", label: "HTML", extension: "html" }),
      api: {
        latexProjectSnapshot: async (root, overlays) => ({
          mainFile: root.split("/").pop(),
          files: overlays.map((item) => ({ path: item.path, data: item.text })),
          skipped: [],
        }),
        pandocListWriters: async () => [{ name: "html", label: "HTML", extension: "html" }],
        runExport: async (request) => {
          requests.push(request);
          return { outputPath: request.outputPath, afterErrors: [], warnings: "" };
        },
        runPandocWriter: async (request) => {
          requests.push(request);
          return { outputPath: request.outputPath, afterErrors: [], warnings: "" };
        },
      },
    },
  );
  h.context.refreshPandocStatus = async () => {
    await release.promise;
    h.context.pandocCache = { found: true };
  };
  const a = h.context.doc;
  describeFile(a, "/a/main.tex", "\\section{A}");
  a.language = "latex";
  h.editor.setDoc("\\section{A} unsaved");
  const b = h.sessions.create();
  describeFile(b, "/b/main.tex", "\\section{B}");
  b.language = "latex";
  h.sessions.add(b);
  h.sessions.setActive(a.id);
  const md = h.sessions.create();
  describeFile(md, "/m/notes.md", "# notes");
  h.sessions.add(md);
  h.sessions.setActive(a.id);
  const switchTo = (session) => {
    h.context.doc = h.sessions.setActive(session.id);
    h.editor.setDoc(session.savedContent);
  };
  return { ...h, a, b, md, release, requests, errors, switchTo };
}

for (const [route, run] of [
  [
    "configured format",
    (h) => h.fns.exportWithPandoc({ id: "docx", label: "Word", extension: "docx" }),
  ],
  [
    "direct writer",
    (h) => h.fns.exportLatexWithWriter("html", "HTML", "html", h.fns.exportSource()),
  ],
]) {
  for (const target of ["b", "md"]) {
    const h = latexExportHarness();
    const job = run(h);
    await delay(0);
    h.switchTo(h[target]);
    h.release.resolve();
    await job;
    const request = h.requests[0];
    const files = request?.snapshot?.files ?? [];
    check(
      h.errors.length === 0 &&
        request?.inputPath === "/a/main.tex" &&
        files.some((file) => file.path === "/a/main.tex" && file.data === "\\section{A} unsaved") &&
        !files.some((file) => file.path.startsWith("/b/")),
      `${route} export keeps project A when the lookup yields to ${target === "b" ? "LaTeX B" : "a Markdown tab"}`,
      h.errors.join("; "),
    );
  }
}
{
  const h = latexExportHarness();
  const job = h.fns.openWriterChooser();
  await delay(0);
  h.switchTo(h.b);
  h.release.resolve();
  await job;
  check(
    h.requests[0]?.inputPath === "/a/main.tex" &&
      !h.requests[0].snapshot.files.some((file) => file.path.startsWith("/b/")),
    "the writer chooser keeps project A when the lookup yields to LaTeX B",
    h.errors.join("; "),
  );
}

// ---------------------------------------------------------------------------
// Paste ownership (F2): a delayed paste lands in the document it was made in —
// at the live caret, or in its hidden tab's stored state — and nowhere else.
// ---------------------------------------------------------------------------

const editorSource = ts.createSourceFile(
  "editor.ts",
  readFileSync(new URL("../src/editor.ts", import.meta.url), "utf8"),
  ts.ScriptTarget.Latest,
  true,
);
const insertionContext = { EditorSelection };
runInNewContext(
  `${
    ts.transpileModule(
      editorSource.statements
        .filter(
          (n) =>
            ts.isFunctionDeclaration(n) &&
            [
              "blockInsertSpec",
              "nativeTextSpec",
              "pastedInsertSpec",
              "pasteInsertionSpec",
            ].includes(n.name?.text),
        )
        .map((n) => n.getText(editorSource).replace(/^export /, ""))
        .join("\n"),
      { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } },
    ).outputText
  }\nglobalThis.pasteInsertionSpec = pasteInsertionSpec;`,
  insertionContext,
);

function pasteHarness() {
  const toasts = [];
  const h = shellHarness(
    ["capturePasteOwner", "pasteOwnerState", "insertForOwner", "resolveRichImage", "altFromPath"],
    {
      pasteInsertionSpec: insertionContext.pasteInsertionSpec,
      toast: (text) => {
        toasts.push(text);
        return { dismiss() {} };
      },
      settings: { richPasteImages: "download", imageApplyLocal: true },
      richImageOptions: () => ({ rule: "assetsFolder" }),
      hasImageDestination: (_language, path) => path !== null,
      typstImageProblem: () => null,
      KEEP_ORIGINAL_RICH: "kept",
      NO_FOLDER_KEPT: "no folder",
    },
  );
  const live = [];
  h.editor.insertBlock = (text) => live.push(text);
  h.editor.insertPasted = (text) => live.push(text);
  h.editor.insertNativeText = (text) => live.push(text);
  const a = h.context.doc;
  describeFile(a, "/a/doc.md", "para\n");
  const b = h.sessions.create();
  describeFile(b, "/b/other.md", "other\n");
  h.sessions.add(b);
  h.sessions.setActive(a.id);
  /** Leave A for B, the way activateSession stores the hidden tab's state. */
  const hideA = () => {
    a.editorState = EditorState.create({
      doc: "para\n",
      selection: { anchor: 4 },
      extensions: [history()],
    });
    h.context.doc = h.sessions.setActive(b.id);
  };
  return { ...h, a, b, live, toasts, hideA };
}
const block = (text) => ({ kind: "block", text });

{
  const h = pasteHarness();
  const owner = h.fns.capturePasteOwner();
  h.a.revision += 3; // typing in the same document does not invalidate the paste
  check(
    h.fns.insertForOwner(owner, block("![x](assets/x.png)")) && h.live.length === 1,
    "a delayed paste into the tab on screen goes to the live caret, even after typing",
  );
}
{
  const h = pasteHarness();
  const owner = h.fns.capturePasteOwner();
  h.hideA();
  const inserted = h.fns.insertForOwner(owner, block("![x](assets/x.png)"), ["/a/assets/x.png"]);
  const text = h.a.editorState.doc.toString();
  check(
    inserted && h.live.length === 0 && text === "para\n\n![x](assets/x.png)\n\n",
    "a paste whose tab was hidden lands in that tab's stored state",
    JSON.stringify(text),
  );
  check(
    h.a.dirty && h.journal.get(h.a.id) === text && h.toasts.some((t) => t.includes("doc.md")),
    "the hidden tab becomes dirty, is journaled, and the reader is told where the paste went",
  );
  let undone = h.a.editorState;
  undo({ state: undone, dispatch: (tr) => (undone = tr.state) });
  check(undone.doc.toString() === "para\n", "the hidden-tab paste undoes as one step");
}
for (const [label, change] of [
  ["closed", (h) => h.sessions.remove(h.a.id)],
  ["reloaded", (h) => (h.a.incarnation += 1)],
  ["saved to another folder", (h) => ((h.a.path = "/c/doc.md"), (h.a.directory = "/c"))],
  ["saved as another language", (h) => (h.a.language = "typst")],
]) {
  const h = pasteHarness();
  const owner = h.fns.capturePasteOwner();
  h.hideA();
  change(h);
  const inserted = h.fns.insertForOwner(owner, block("![x](assets/x.png)"), ["/a/assets/x.png"]);
  check(
    !inserted &&
      h.live.length === 0 &&
      h.a.editorState.doc.toString() === "para\n" &&
      h.toasts.some((t) => t.includes("/a/assets/x.png")),
    `a paste whose document was ${label} inserts nothing and names the saved image`,
  );
}
{
  const h = pasteHarness();
  const owner = h.fns.capturePasteOwner();
  h.hideA();
  h.a.path = "/a/renamed.md";
  h.a.name = "renamed.md";
  check(
    h.fns.insertForOwner(owner, block("![x](assets/x.png)")) &&
      h.a.editorState.doc.toString().includes("assets/x.png"),
    "a rename in the same folder keeps the paste valid",
  );
}
{
  const h = pasteHarness();
  const owner = h.fns.capturePasteOwner();
  h.context.doc = h.sessions.setActive(h.b.id);
  h.a.draft = "recovered";
  check(
    !h.fns.insertForOwner(owner, block("x")) && h.a.draft === "recovered",
    "a hidden tab holding a never-shown recovered draft is not edited",
  );
}
{
  // An image resolved after a tab switch still saves under the paste's folder.
  const h = pasteHarness();
  const calls = [];
  h.context.api = {
    downloadImage: async (_url, path) => {
      calls.push(path);
      return { absolutePath: `${path}-x.png`, markdownPath: "x.png", bytes: 1, source: "remote" };
    },
  };
  const owner = h.fns.capturePasteOwner();
  h.hideA();
  const assets = [];
  const resolved = await h.fns.resolveRichImage(
    { src: "https://example.test/x.png", alt: "" },
    "markdown",
    () => {},
    owner,
    assets,
  );
  check(
    calls[0] === "/a/doc.md" && resolved?.src === "x.png" && assets[0] === "/a/doc.md-x.png",
    "a rich-paste image resolves against the pasting document, not the tab on screen",
  );
}

// ---------------------------------------------------------------------------
// Open and startup ownership (F3): one tab per path, and a blank startup tab
// that is filled at most once and never over the reader's typing.
// ---------------------------------------------------------------------------

function openHarness() {
  const reads = new Map();
  const errors = [];
  const writes = [];
  let writeGate = null;
  const h = shellHarness(
    [
      "openPath",
      "openPaths",
      "loadUntitled",
      "takeStartupSlot",
      "restoreLastTabs",
      "snapshotDoc",
      "describe",
      "activateSession",
      "displayDoc",
      "textOf",
      "languageFor",
    ],
    {
      settings: { recordRecent: false, sidebarTab: "outline", lastTabs: [], lastActiveTab: null },
      message: async (text) => errors.push(String(text)),
      openPathChain: Promise.resolve(),
      planRestore: (saved, active, exists) => ({
        tabs: saved.filter(exists),
        active,
        missing: 0,
      }),
    },
  );
  h.context.toast = (text) => errors.push(String(text));
  h.context.showInEditor = async () => {
    h.editor.setDoc(h.context.doc.draft ?? h.context.doc.savedContent);
    h.context.doc.draft = null;
  };
  h.context.api = {
    readDocument: (path) => {
      const gate = reads.get(path) ?? deferred();
      reads.set(path, gate);
      return gate.promise.then((content) => {
        if (content instanceof Error) throw content;
        return filePayload(path, content);
      });
    },
    pathExists: async () => true,
  };
  h.context.lifecycle = createDocumentLifecycle({
    sessions: h.sessions,
    text: (s) => h.fns.textOf(s),
    read: async () => {
      throw new Error("unused");
    },
    stat: async () => ({ exists: false }),
    write: async (path, text) => {
      writes.push(path);
      if (writeGate) await writeGate.promise;
      return { written: true, modifiedMs: 2, size: text.length, sha256: null };
    },
    recovery: { schedule() {}, forget: async () => {}, flush: async () => {} },
    choosePath: async () => "/p/x.md",
    decide: async () => "cancel",
    replace() {},
    adoptPath: (s, path) => {
      s.path = path;
      s.name = path.split("/").pop();
      s.directory = path.slice(0, path.lastIndexOf("/"));
    },
    changed() {},
    conflict() {},
    notify: (text) => errors.push(text),
    committing() {},
  });
  h.context.startupSlot = { session: h.context.doc, revision: h.context.doc.revision };
  const release = (path, content) => {
    const gate = reads.get(path) ?? deferred();
    reads.set(path, gate);
    gate.resolve(content);
  };
  return {
    ...h,
    errors,
    writes,
    release,
    gateWrites: () => (writeGate = deferred()),
    openWrites: () => writeGate.resolve(),
    tabsFor: (path) => h.sessions.list().filter((s) => s.path === path),
  };
}

{
  const h = openHarness();
  h.context.startupSlot = null;
  const first = h.fns.openPath("/p/x.md");
  const second = h.fns.openPath("/p/x.md");
  await delay(0);
  h.release("/p/x.md", "X");
  const [one, two] = await Promise.all([first, second]);
  check(
    h.tabsFor("/p/x.md").length === 1 && one === two && h.context.doc === one,
    "two concurrent opens of one path leave one tab and resolve to it",
  );
}
{
  const h = openHarness();
  const blank = h.context.doc;
  const job = h.fns.openPath("/p/x.md");
  await delay(0);
  h.editor.type("typed while starting");
  h.release("/p/x.md", "X");
  const opened = await job;
  check(
    opened !== blank && blank.path === null && h.fns.textOf(blank) === "typed while starting",
    "a startup read does not replace a blank tab the reader typed in",
  );
  check(
    h.journal.get(blank.id) === "typed while starting" && h.sessions.byId(blank.id) === blank,
    "the typed tab keeps its recovery entry",
  );
}
{
  const h = openHarness();
  const blank = h.context.doc;
  const a = h.fns.openPath("/p/a.md");
  const b = h.fns.openPath("/p/b.md");
  await delay(0);
  h.release("/p/b.md", "B");
  h.release("/p/a.md", "A");
  await Promise.all([a, b]);
  check(
    h.tabsFor("/p/a.md").length === 1 &&
      h.tabsFor("/p/b.md").length === 1 &&
      h.sessions.list().length === 2,
    "two startup reads fill the blank tab once and open the other as a tab",
  );
  check(blank.path !== null, "the blank startup tab is reused rather than left empty");
}
{
  // Save As holds the path while it writes; the open must then focus that tab.
  const h = openHarness();
  h.context.startupSlot = null;
  const other = h.context.doc;
  describeFile(other, "/p/other.md", "other");
  h.editor.setDoc("other");
  h.gateWrites();
  const saving = h.context.lifecycle.saveAs(other);
  await delay(0);
  const opening = h.fns.openPath("/p/x.md");
  await delay(0);
  h.release("/p/x.md", "disk X");
  h.openWrites();
  await saving;
  const opened = await opening;
  check(
    h.tabsFor("/p/x.md").length === 1 && opened === other,
    "an open racing a Save As to the same path focuses the saved tab instead of duplicating it",
  );
}
{
  const h = openHarness();
  h.context.settings.lastTabs = ["/p/gone.md", "/p/kept.md"];
  const job = h.fns.restoreLastTabs();
  await delay(0);
  h.release("/p/gone.md", new Error("vanished"));
  await delay(5);
  h.release("/p/kept.md", "K");
  await job;
  check(
    h.sessions.list().length === 1 && h.tabsFor("/p/kept.md").length === 1,
    "a failed first remembered tab leaves the slot for the next one, not an empty tab",
  );
}
{
  const h = openHarness();
  h.sessions.remove(h.context.doc.id);
  await h.fns.loadUntitled("", "markdown");
  check(
    h.sessions.byId(h.context.doc.id) === h.context.doc && h.sessions.list().length === 1,
    "a startup fill after the blank tab was closed creates a tab that is in the store",
  );
}

// ---------------------------------------------------------------------------
// LaTeX engine freshness (F6): a backend or engine change makes the compiled
// PDF stale at once, and manual mode does not compile because of it.
// ---------------------------------------------------------------------------

for (const autoCompile of [false, true]) {
  const statuses = [];
  let compiles = 0;
  const h = shellHarness(["invalidateLatexBuild", "latexCurrent"], {
    renderToken: 7,
    renderTimer: 0,
    latexInFlight: true,
    previewStale: false,
    preview: { dataset: { latexCurrent: "7" } },
    // The engine change also empties the compiled-output store and the key.
    latexStore: { clear() {} },
    committedKey: "k",
    window: { clearTimeout() {} },
    cancelLatex() {},
    discardStagedPdf() {},
    syncMenuState() {},
    doRender: () => compiles++,
    setLatexStatus: (text) => statuses.push(text),
  });
  h.context.settings.latexAutoCompile = autoCompile;
  h.context.doc.language = "latex";
  const preview = { token: 7, activeId: h.context.doc.id, revisions: [] };
  check(h.fns.latexCurrent(preview), "a compiled LaTeX PDF is current before the engine changes");
  h.fns.invalidateLatexBuild();
  check(
    !h.fns.latexCurrent(preview) &&
      h.context.previewStale &&
      !("latexCurrent" in h.context.preview.dataset) &&
      compiles === 0,
    `an engine change makes the PDF stale without compiling (auto-compile ${autoCompile ? "on" : "off"})`,
  );
  check(
    autoCompile ? statuses.length === 0 : statuses.some((text) => text.includes("engine changed")),
    `manual mode says why the preview is out of date (auto-compile ${autoCompile ? "on" : "off"})`,
  );
}

// ---------------------------------------------------------------------------
// Auto Save and a deciding close (F16): a background save must not void the
// reader's answer to the unsaved-changes dialog.
// ---------------------------------------------------------------------------

function autoSaveHarness() {
  const decision = deferred();
  let writeGate = null;
  const writes = [];
  const h = shellHarness(["autoSaveTick", "writeSession", "textOf"], {
    autoSaveRunning: false,
    message: async () => {},
  });
  h.context.settings.autoSave = true;
  const s = h.context.doc;
  describeFile(s, "/p/a.md", "saved");
  h.editor.type("edited");
  h.context.lifecycle = createDocumentLifecycle({
    sessions: h.sessions,
    text: (x) => h.fns.textOf(x),
    read: async () => filePayload("/p/a.md", "saved"),
    stat: async () => ({ exists: true, modifiedMs: 0, size: 0, sha256: null, readOnly: false }),
    write: async (path, text) => {
      writes.push(text);
      if (writeGate) await writeGate.promise;
      return { written: true, modifiedMs: 0, size: 5, sha256: null };
    },
    recovery: { schedule() {}, forget: async () => {}, flush: async () => {} },
    choosePath: async () => null,
    decide: () => decision.promise,
    replace() {},
    adoptPath() {},
    changed() {},
    conflict() {},
    notify() {},
    committing() {},
  });
  return {
    ...h,
    s,
    writes,
    decision,
    gateWrites: () => (writeGate = deferred()),
    openWrites: () => writeGate.resolve(),
  };
}

for (const answer of ["discard", "save"]) {
  const h = autoSaveHarness();
  let closed = false;
  const closing = h.context.lifecycle.close([h.s], async () => (closed = true));
  await delay(0);
  await h.fns.autoSaveTick();
  check(h.writes.length === 0, `Auto Save waits while the close dialog is open (${answer})`);
  h.decision.resolve(answer);
  const result = await closing;
  check(
    result && closed,
    `choosing ${answer} in the close dialog closes the tab despite Auto Save`,
  );
}
{
  // The mechanism the guard prevents: a save during the dialog voids the answer.
  const h = autoSaveHarness();
  const closing = h.context.lifecycle.close([h.s], async () => true);
  await delay(0);
  await h.context.lifecycle.save(h.s, true);
  h.decision.resolve("discard");
  check(!(await closing), "a save during the close dialog invalidates the close's snapshot");
}
{
  const h = autoSaveHarness();
  h.gateWrites();
  const first = h.fns.autoSaveTick();
  await delay(0);
  await h.fns.autoSaveTick();
  h.openWrites();
  await first;
  check(h.writes.length === 1, "an Auto Save tick does not overlap one still running");
}

const failed = checks.filter((entry) => !entry.ok).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
