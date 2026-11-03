# The AI key falls back to a private file when the Linux keyring refuses it

**Status:** accepted
**Date:** 2026-11-03

## Context

The first AI Assistant ADR chose the OS credential store and a session-only
fallback. That is still the preferred order, but it is not sufficient on Linux.
The `keyring` 4.2 Secret Service store writes into the default collection. When
a fresh session has no default collection, the store's create path calls
`get_default_collection()` twice: `create_item("default")` catches the no-entry
error, then `create_collection("default")` resolves the same missing alias and
fails. The write is refused. The old behavior then kept the key in memory and
told the reader it would disappear on restart, which is exactly the reported
failure.

Creating a collection is not a reliable repair: gnome-keyring prompts for a
password, the prompt can be dismissed or hidden, and a headless session cannot
answer it. A Tauri app also cannot assume a Secret Service is present at all.

The key must not enter `settings.json`: that file is copied by backups and sync,
and every process that can read the home directory can read it anyway. The
recovery journal, channel events and error messages have the same rule.

## Decision

The key is resolved in this order, and the source is reported to the UI:

1. the in-memory key typed during this session;
2. a JSON file beside `settings.json` named `ai-keys.json`;
3. the OS credential store.

The file is written atomically, the file mode is `0600` and its directory mode
is `0700` on Unix. The file wins over the keychain when both have an entry,
because a file entry only exists after a keychain write failed: it is the newer
key. A successful keychain write removes the corresponding file entry, so the
keychain takes over again on the next save. Preferring the keychain first would
silently keep using an older entry after the reader saved a replacement during
an outage. The file never contains anything except credential ids and keys, and
the UI says "Saved in a private file (not encrypted)" rather than implying
keychain security.

The session-only fallback remains the last resort when both the keychain and the
file are unwritable, so the assistant is never unusable because storage failed.

## Consequences

- A Linux reader keeps the key across restarts in the reported environment.
- The fallback is plaintext. That is a deliberate, visible tradeoff: it is
  readable by the user's account, not by other users, and it is not copied by
  settings backups. A future change can add an opt-out if the product needs one.
- The keyring stays the preferred store. When it works, the file is deleted and
  the source reports `keychain`; while a file entry exists it is the key in use,
  because it is the one the reader most recently saved.
- The file is part of the app's state for testing: the harness backs it up and
  removes it between layers, exactly as it does `settings.json`.
- A key can be cleared from all three stores; the clear command reports what
  remains if one of them fails.
