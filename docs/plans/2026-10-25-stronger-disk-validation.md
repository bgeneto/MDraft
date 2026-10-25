# Stronger pre-save disk revision validation

**Status:** in progress — implementation and Windows validation complete; the
first GitHub run of the `safety` job and the Linux Rust run remain to be recorded
**Date:** 2026-10-25
**ADR:** [`../adr/2026-10-25-disk-revision-identity.md`](../adr/2026-10-25-disk-revision-identity.md)

## Context and goal

GAP-002 delivered a stat-based external-change guard: before an in-place save,
and on the 2.5 s disk poll, MDraft compares the remembered `mtime` and size with
`stat_document`. The approved first pass deliberately deferred content
validation. Its own record is honest about the consequence: a different file
with the same size and the same `mtime` is classified as `unchanged`, and a
normal save or Auto Save overwrites it without a prompt. The `stat` and the
write are also separate IPC calls, so an external writer can land between the
check and `write_document`.

This plan closes that gap without pretending Windows and Linux offer a
filesystem compare-and-swap. A save must prove that the bytes on disk are still
the revision the buffer was based on, and the proof must happen inside the Rust
write command, immediately before the temporary file replaces the target. Any
remaining window is documented and measured rather than hidden.

It also delivers the first slice of GAP-027: the existing app-free safety
suites, `p0:unit` (99 checks) and `test:sessions` (60 checks), run in CI on every
push and pull request. The suites pass locally on Node 24.22; the quality
workflow currently runs Node 22 and never invokes them. Crash/relaunch
automation remains GAP-027 follow-up work.

**Precondition.** The 2026-10-25 P0 implementation is present in the working
tree but not yet committed (`src/document-lifecycle.ts`, `src/unsaved-dialog.ts`,
the P0 plan/ADR, `scripts/p0-unit.mjs`, `scripts/p0-lifecycle-test.mjs`, and the
edits to `main.ts`, `sessions.ts`, `documents.rs`, `test-all.mjs`). It must be
committed first so this change is reviewable against a stable baseline and the
new CI job starts from a green tree.

**Deviation (implementation start).** The owner approved implementation before
committing the P0 tree, so this work proceeds on top of it. The final diff will
therefore contain both changes until the owner commits; the validation record
must say so, and no P0 file is reverted or rewritten by this plan.

## Scope and non-scope

**In scope**

- A disk-revision identity derived from the raw file bytes, not from decoded
  text: SHA-256, computed in Rust with the `sha2` dependency that already backs
  the pandoc/Typst digest checks.
- `DocumentPayload.sha256` for the revision a session was opened from.
- An optional `baseSha256` on recovery entries, so a buffer recovered after a
  crash still knows which disk revision it was based on.
- A new `write_document_checked` command that receives the expected hash and
  validates it inside the backend at the last safe moment before replacement.
- A new `fingerprint_document` command for **Keep my version**, which must adopt
  the current disk revision after the reader explicitly chooses it.
- Lifecycle integration for manual save, Auto Save, Save As, reload, polling
  baselines and recovery restore.
- Rust, `p0:unit` and `p0:lifecycle` coverage, including a same-size,
  same-`mtime` rewrite and an injected intervening write.
- A CI job that runs `npm run p0:unit` and `npm run test:sessions`.

**Non-scope**

- An absolute filesystem compare-and-swap guarantee or mandatory OS file locks.
  Neither published platform offers one portably, and network shares would make
  a lock a source of hangs.
- Hashing on every 2.5 s poll. Polling stays stat-based; the authoritative check
  is at save time.
- Encoding support and Windows-1252 (GAP-021), large-file thresholds (GAP-005),
  Save All (GAP-004), saved-version history (GAP-031).
- Crash/relaunch automation and the wider GAP-027 lifecycle programme. This plan
  delivers only the CI slice the backlog already scopes as its first step.
- Changing the shape or behaviour of the existing `write_document` command.
  HTML export and any other caller that has no baseline keep using it.

## Approach and rejected alternatives

**Chosen approach: raw-byte identity plus a checked write at the backend
boundary.**

1. `read_document` hashes the bytes it read before BOM stripping and EOL
   normalisation and returns `sha256`. The session stores it beside
   `modifiedMs`/`size`.
2. `write_document_checked(path, content, lineEnding, hadBom, expectedSha256)`
   shares the existing writer internals with `write_document`:
   - if `expectedSha256` is present, read the current file **once**, validate it
     is text (the existing binary/lossy guard) and hash those same bytes;
   - missing file while an expected hash exists → return
     `{ written: false, change: "deleted", … }`;
   - hash mismatch → return `{ written: false, change: "modified", size,
     modifiedMs, sha256 }` and create no temporary file;
   - otherwise write the temporary sibling, then read and hash the target again
     immediately before `rename`. A mismatch there removes the temporary file
     and returns the same conflict outcome. This is the best narrowing available
     without a filesystem CAS; the residual interval is the time between the
     second read and the rename;
   - on success return `{ written: true, change: "saved", size, modifiedMs,
     sha256 }`, where `sha256` is the digest of the exact bytes written (BOM and
     EOL included), so the frontend adopts the new baseline without a re-read.
3. `write_document` keeps its current signature and return type. It delegates to
   the shared writer with no expected hash and maps the success outcome back to
   `SavedInfo`. HTML export and any legacy caller are untouched.
4. `fingerprint_document(path)` returns the current stat plus the raw-byte hash
   without decoding the text. **Keep my version** calls it while the lifecycle
   snapshot guard is active and adopts `sha256`, `modifiedMs` and `size`
   together. It never adopts a hash it did not observe.
5. The lifecycle controller keeps the existing stat preflight for the fast path
   (read-only, deleted, obviously modified) and for the notice UI. The checked
   write is the authority: when it returns a conflict, the controller marks the
   session conflicted, leaves the dirty text and its recovery entry intact, and
   returns `false`. Auto Save follows the same path, so it pauses exactly where
   a manual save would; the UI's Auto Save list also skips a session whose
   conflict is still unresolved.
6. Recovery journals `baseSha256`. Restored sessions use it, so the first save
   after a crash is content-checked even when the file changed while MDraft was
   closed. Entries written by older builds deserialize with `baseSha256: null`;
   for one launch they fall back to the stat guard, which is no worse than
   today. They are rewritten with a hash on the first dirty journal update.
7. Cost stays where it matters: hashing happens on open, on explicit save, and
   on Keep my version. The 2.5 s poll reads no file content.

**Rejected alternatives**

- *Hash in `stat_document`.* It would read every open file every 2.5 s,
  including network shares and large documents, to answer a question only a save
  needs answered.
- *Hash in the frontend through Web Crypto.* The frontend never sees the raw
  bytes: the IPC payload is decoded text, so BOM, EOL and encoding differences
  would disappear from the identity. It would also have to send the whole file
  over IPC again.
- *A separate `verify_document` followed by `write_document`.* Two commands
  leave the same check-then-write window; it is the current design with extra
  latency.
- *OS advisory locks or a mandatory lock file.* They hang or lie on network
  shares, differ across platforms, and can strand a document after a crash.
- *Change `write_document` to always require a hash.* It would break HTML export
  and make a command's contract depend on a caller that has no baseline.
- *Promise compare-and-swap.* No portable primitive exists. The plan documents
  the narrow remaining race and tests the check immediately before rename.

## Steps

- [ ] Confirm the delivered P0 tree is committed; create the branch for this
      plan. *(Deferred: the owner approved proceeding before that commit; see the
      deviation above.)*
- [x] Rust: add `sha256` to `DocumentPayload` and compute it from the raw bytes
      in `read_document`; add `base_sha256` to `RecoveryEntry` with
      `#[serde(default)]` so old journals load.
- [x] Rust: factor the write path into one internal function; add
      `write_document_checked` and `fingerprint_document`; register both in
      `lib.rs`; keep `write_document` behaviour and return shape unchanged.
- [x] Rust tests: same size + restored `mtime` with different bytes is a
      conflict and leaves the target untouched; correct hash writes and returns
      the new digest; missing target reports `deleted`; BOM/EOL changes produce
      a different digest; the pre-rename recheck refuses an intervening write
      and removes the temporary sibling; old recovery JSON without the field
      loads.
- [x] TypeScript: extend `api.ts` (`sha256`, `RecoveryEntry.baseSha256`,
      checked-write outcome, `fingerprintDocument`, `writeDocumentChecked`).
- [x] Sessions/lifecycle: add `sha256` to `Session` and `blank()`/`describe`/
      `replace`; journal it; pass it to the checked write; adopt the outcome
      hash; update **Keep my version**, reload and poll baselines.
- [x] `p0-unit`: assert the expected hash is forwarded, a conflict does not
      clear dirty/recovery, a success adopts the new hash, newer typing stays
      dirty, and Save As has no baseline. **Keep my version** is covered by the
      UI layer, because it lives in the shell.
- [x] `p0-lifecycle`: rewrite a temporary document with the same size and
      restored timestamps, press Save, assert the notice and unchanged bytes,
      then **Keep my version** and save successfully.
- [x] CI: add a `safety` job to `.github/workflows/quality.yml` using Node 24,
      `npm ci`, `npm run p0:unit`, `npm run test:sessions`. Keep the existing
      Node 22 frontend job.
- [x] Measure hash cost on `samples/feature-tour.md`, the physics paper and a
      generated 10 MiB document; record the numbers below.
- [x] Update `AGENTS.md`, `README.md` and `docs/guide.md` counts/claims; update
      the backlog rows for GAP-032 and the delivered GAP-027 slice.
- [x] Run the validation layers below and record deviations here.

## Files and modules

| File | Why it must change |
| --- | --- |
| `src-tauri/src/documents.rs` | Payload hash, recovery-safe writer refactor, checked write, fingerprint, Rust tests |
| `src-tauri/src/recovery.rs` | Optional `base_sha256` in the journal entry and its round-trip test |
| `src-tauri/src/lib.rs` | Register `write_document_checked` and `fingerprint_document` |
| `src/api.ts` | Types and wrappers for the new payload field and commands |
| `src/sessions.ts` | `Session.sha256` and its blank value |
| `src/recovery.ts` | Journal the base hash |
| `src/document-lifecycle.ts` | Checked write, conflict handling, baseline adoption, keep-mine fingerprint |
| `src/main.ts` | `describe`/`replace`/recovery restore wiring; `keepMine` uses the fingerprint |
| `scripts/p0-unit.mjs`, `scripts/p0-lifecycle-test.mjs` | Reproducing tests at the cheapest layers that can see the failure |
| `.github/workflows/quality.yml` | The app-free safety suites in CI |
| `AGENTS.md`, `README.md`, `docs/guide.md`, `docs/backlog.md` | Counts, claims and status |

## Risks and rollback

- **Hash cost on large files.** SHA-256 is linear and runs on the blocking write
  path; a 100 MiB file adds a full read. Measure before shipping; if the cost is
  unacceptable, the fallback is a fast fingerprint (size + head/tail digest)
  with a clearly weaker guarantee, not a return to metadata-only.
- **Network shares.** Reading the target twice doubles latency and may observe
  a share's stale cache. The conflict is safe (it refuses), but a false conflict
  is possible. Document it; do not add locks.
- **Old recovery entries.** `baseSha256` is optional. For one launch after
  upgrade they keep the stat guarantee only; no old entry is deleted or
  rewritten until the buffer is dirty again.
- **Keep my version race.** The fingerprint and the adoption must stay inside
  the existing `lifecycle.current(before)` guard, or a file could change between
  the stat and the adoption.
- **Temporary sibling cleanup.** Every conflict path must remove the file it
  created, or the document folder accumulates `.name.pid.n.tmp` files. The
  existing Rust test that counts directory entries is extended.
- **Rollback.** The new commands are additive and the existing `write_document`
  contract is unchanged. Reverting the TypeScript to `writeDocument` restores
  today's stat guard immediately; the extra recovery field is ignored by older
  builds.

## Tests and validation

- `npm run test:rust` (through `scripts\cargo-vcvars.cmd`, or `npm test -- --only rust`
  so `TEMP`/`TMP` live inside the workspace).
- `npm run p0:unit` and `npm run test:sessions`.
- `npm run p0:lifecycle` against a fresh instance.
- `npm run build`, `npm run lint`, `npm run format:check`, `npm run knip`.
- `npm test -- --only rust` and a second run on Linux for the `#[cfg]`-split
  path tests when the Linux environment is available.
- Prove the CI job fails on a broken assertion in each suite before merging.
- **The measurement that proves it works:** a byte-for-byte comparison of the
  target file after a refused save, plus `session.dirty` and the recovery entry
  still present, for a rewrite whose size and `mtime` match the baseline.

## Acceptance criteria

- With a document open and clean, rewrite its file externally with different
  bytes of the same length while restoring the original `mtime`; press Save:
  MDraft shows the existing “changed on disk” notice, writes nothing, and the
  file still holds the external bytes.
- The same rewrite with Auto Save enabled does not overwrite the file.
- **Reload** replaces the buffer with the new disk text; **Keep my version**
  adopts the new revision and the next save writes; **Save a copy** writes
  beside it. A newer external revision after Keep my version asks again.
- The saved baseline uses the hash of the bytes actually written, including BOM
  and CRLF, so a subsequent unchanged save is not a false conflict.
- A recovery entry restored after a crash is checked against the revision it was
  journaled from; an old entry without a hash still loads and is not deleted.
- No temporary sibling is left behind after a refused write.
- Hash cost is recorded for a small, a large and a 10 MiB document.
- CI fails when either `p0:unit` or `test:sessions` regresses; both run on every
  push and pull request.
- The existing HTML export, Save As and pandoc export paths keep their current
  command contracts and behaviour.

## Validation record

Implemented on Windows on 2026-10-25, on top of the uncommitted P0 tree.

| Layer | Result |
| --- | --- |
| `node scripts/p0-unit.mjs` | **110/110** |
| `node scripts/sessions-test.mjs` | **60/60** |
| `cargo test --manifest-path src-tauri/Cargo.toml` | **130 passed**, 0 failed, 2 ignored downloads |
| `cargo clippy --all-targets -- -D warnings` | clean |
| `npm run build` | PASS |
| `npm run lint` | PASS |
| `npm run knip` | PASS |
| `npm test -- --only p0-lifecycle` | **34/34** on the staged release build, fresh profile |
| `npm test -- --only tabs` | **106/106** (Auto Save and disk poll across tabs) |
| `npx prettier --check` on every file this plan touched | PASS |

**Hash cost**, measured with the real `sha2` code in an ignored probe and then
removed: 2,534 bytes in 35.5 µs; 44,563 bytes in 11.6 µs; 10 MiB in **2.3 ms**.
The .NET end-to-end read + hash of the same 10 MiB file averaged **5.8 ms** on a
warm cache, so reading dominates and the digest is not the cost that matters.
The probe was deleted rather than kept as an ignored test.

**The measurement that proves the acceptance criterion:** the UI layer rewrites
`mixed.md` with the same byte length, restores the original `modifiedMs`, asserts
that `stat_document` reports the same size and timestamp, presses Save after
typing, and observes the “changed on disk” notice while the file still holds the
external bytes. **Keep my version** then adopts the fingerprinted revision and
the next save writes the local text. The suite passes 34/34.

**Deviations / remaining verification.**

- The P0 tree is still uncommitted; the diff contains both changes until the
  owner commits.
- `npm run format:check` fails repository-wide on `scripts/typst-preview-test.mjs`,
  a file this plan does not touch. Formatting it would create a 92-insertion,
  24-deletion unrelated diff; every file touched here passes Prettier. The
  pre-existing failure is recorded rather than silently fixed.
- The GitHub `safety` job has not run yet; it invokes exactly the two local
  commands above. The Linux Rust run (127 expected runnable tests) is pending the
  Linux environment.
- `p0-lifecycle`'s IPC hooks were updated from `write_document` to
  `write_document_checked`; the AGENTS trap records the timeout this otherwise
  produces. The legacy `write_document` contract is still exercised directly by
  the binary-refusal check.

## Open questions

- **Node version for the unit job.** Default: a separate job on Node 24, because
  the suites and their comments assume Node 24 type stripping and the local
  result. Upgrading the frontend job too can be a separate change.
- **Fingerprint fallback for huge files.** Default: full SHA-256 first; only
  introduce a partial fingerprint if the measurement shows a user-visible stall.
- **Old recovery entries.** Default: stat-only for one launch, rewritten with a
  hash on the next dirty update. Do not delete or migrate them eagerly.
