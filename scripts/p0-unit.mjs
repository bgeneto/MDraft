// Unit tests for the P0 data-safety layer.
//
//   node scripts/p0-unit.mjs
//
// No application and no build. `src/recovery.ts`, `src/disk-change.ts` and
// `src/typst-commands.ts` have no runtime imports beyond their own types, so
// Node 24 can load them after stripping TypeScript.

import { buildRecoveryEntry, createRecoveryScheduler, newRecoveryId } from "../src/recovery.ts";
import { classifyDiskChange } from "../src/disk-change.ts";
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
    lineEnding: "\n",
    hadBom: false,
    lossy: false,
    size: 6,
    modifiedMs: 100,
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

const failed = checks.filter((entry) => !entry.ok).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
