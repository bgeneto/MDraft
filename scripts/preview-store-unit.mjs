//! The compiled-output store: byte-bounded LRU eviction; no application.
//!
//!   node scripts/preview-store-unit.mjs
//!
//! The store decides which tab returns instantly and which recompiles, and it
//! is the one place a long session could grow without bound, so its budget and
//! eviction order are pinned here.
import assert from "node:assert/strict";
import { createPreviewStore, DEFAULT_STORE_BYTES } from "../src/preview-store.ts";

let passed = 0;
function check(label, test) {
  test();
  passed++;
  console.log(`  PASS  ${label}`);
}

check("the default budget is 96 MB", () => {
  assert.equal(DEFAULT_STORE_BYTES, 96 * 1024 * 1024);
});

check("a stored entry comes back for its key only", () => {
  const store = createPreviewStore(100);
  assert.equal(store.set("a", "A", 10), true);
  assert.equal(store.get("a"), "A");
  assert.equal(store.get("b"), undefined);
  assert.equal(store.bytes, 10);
  assert.equal(store.size, 1);
});

check("the least recently used entry is evicted first", () => {
  const store = createPreviewStore(100);
  store.set("a", "A", 40);
  store.set("b", "B", 40);
  store.get("a"); // a is now newer than b
  store.set("c", "C", 40);
  assert.equal(store.get("b"), undefined, "b was the least recently used");
  assert.equal(store.get("a"), "A");
  assert.equal(store.get("c"), "C");
  assert.equal(store.bytes, 80);
});

check("eviction frees enough bytes, not just one entry", () => {
  const store = createPreviewStore(100);
  for (const key of ["a", "b", "c", "d", "e"]) store.set(key, key, 10);
  store.set("big", "BIG", 50);
  assert.ok(store.bytes <= 100);
  assert.equal(store.get("big"), "BIG");
  assert.equal(store.get("e"), "e", "the newest small entries survive");
});

check("an entry larger than half the budget is refused and evicts nothing", () => {
  const store = createPreviewStore(100);
  store.set("a", "A", 30);
  assert.equal(store.set("huge", "H", 51), false);
  assert.equal(store.get("huge"), undefined);
  assert.equal(store.get("a"), "A");
  assert.equal(store.bytes, 30);
});

check("replacing a key replaces its bytes", () => {
  const store = createPreviewStore(100);
  store.set("a", "A1", 30);
  store.set("a", "A2", 20);
  assert.equal(store.get("a"), "A2");
  assert.equal(store.bytes, 20);
  assert.equal(store.size, 1);
});

check("a refused replacement removes the old value", () => {
  // The old value was built from the same key, but the caller has just told
  // the store the key now means something it cannot hold.
  const store = createPreviewStore(100);
  store.set("a", "A1", 30);
  assert.equal(store.set("a", "A2", 80), false);
  assert.equal(store.get("a"), undefined);
  assert.equal(store.bytes, 0);
});

check("drop removes matching keys and their bytes", () => {
  const store = createPreviewStore(100);
  store.set('["latex",1]', "L1", 10);
  store.set('["latex",2]', "L2", 10);
  store.set('["typst",1]', "T1", 10);
  assert.equal(
    store.drop((key) => key.startsWith('["latex"')),
    2,
  );
  assert.equal(store.size, 1);
  assert.equal(store.bytes, 10);
  assert.equal(store.get('["typst",1]'), "T1");
});

check("invalid sizes are refused", () => {
  const store = createPreviewStore(100);
  assert.equal(store.set("a", "A", Number.NaN), false);
  assert.equal(store.set("b", "B", -1), false);
  assert.equal(store.size, 0);
});

check("clear empties the store", () => {
  const store = createPreviewStore(100);
  store.set("a", "A", 10);
  store.clear();
  assert.equal(store.size, 0);
  assert.equal(store.bytes, 0);
  assert.equal(store.get("a"), undefined);
});

console.log(`\n${passed}/${passed} checks passed`);
