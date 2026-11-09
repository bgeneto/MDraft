# Test runner traps

`scripts/test-all.mjs` itself: the order it runs, the guards it applies, the cleanup it owes, and the failures that come from the runner rather than from a suite.

Part of [the trap record](../traps.md). Search across every domain with:

```powershell
rg -n "<literal error text>" docs/agent-guide/traps
```

**`Typst prerequisite missing` in the isolated harness even though MDraft has Typst installed.**
MDraft's managed Typst lives under the normal profile, while the test instance
has a separate application identifier and cannot see that directory. The harness
adds the installed managed binary to the test child process's `PATH`; check the
normal profile's `typst/<version>/typst.exe` before concluding the host lacks it.

**`npm test` reports `the application exited with code 0 before opening port 92xx` for every UI layer, and killing the leaked `mdraft.exe` makes a new PID appear**
An orphaned `node scripts/test-all.mjs` from an earlier, interrupted run was still
alive; each fresh launch handed off to its instance through the single-instance
plugin and exited 0. `Stop-Process` on the app alone is not enough because the
harness relaunches it. Find the parent first —
`Get-CimInstance Win32_Process -Filter "Name='mdraft.exe'"` and read
`ParentProcessId` — stop the `test-all.mjs` node process, then the app. Check for
both before blaming a change: `Get-CimInstance Win32_Process -Filter
"Name='node.exe'" | Where-Object { $_.CommandLine -like '*test-all.mjs*' }`. The
earlier entry about a running installation is the same failure with a different
parent.

**`preview-zoom`, `typst-preview`, `word-sync` and `sync` fail on a host where `typst --version` works**
The harness gives each UI suite a private `%APPDATA%`, and `managed_root` in
`src-tauri/src/typst.rs` resolves the managed compiler through
`app_data_dir()/typst`. A Typst installed by MDraft into the *real* profile is
therefore invisible to the test instance, which reports
`Document zoom's Typst checks require Typst` — or, for `typst-preview`, exits 2
with an empty log before printing any check. These four fail identically on an
untouched checkout, so verify with `git stash push -u` before investigating. Put
`typst` on `PATH` to exercise them.

**Interrupting `npm test` printed `interrupted — closing the instance this run started` but did not restore the user's settings**
An older SIGINT handler exited directly, bypassing `main()`'s `finally`;
the original settings and recovery are copied to the printed staging folder's
`user-state` directory. Restore those exact saved files after stopping an
older test runner, and verify their hashes before removing any backup. The
runner now unwinds through its restoration path on interruption.

**A 100-image preview test waits 30 seconds with `loaded:43, pending:57` even though the local fallback ran once**
Preview images intentionally have `loading="lazy"`; the remaining images were outside the viewport and had not failed or loaded. A stress test that needs to count all resolutions must either scroll through the document or explicitly set its test images to `loading="eager"` before waiting. Do not diagnose the pending images as a stalled IPC call.

**`the application exited with code 0 before opening port 9222` for every UI layer, although the release binary is valid**
An installed `C:\Program Files\MDraft\mdraft.exe` was already running. Since the
single-instance plugin uses the application identifier, a staged test copy with
the same identifier forwards its fixture paths to that installation and exits;
a private `WEBVIEW2_USER_DATA_FOLDER` does not isolate the handoff. The harness
preflight only rejected processes locking `target/release`, so it still moved
and reset the shared settings/recovery before discovering there was no test
window. This looked like seven application startup regressions; CIM showed the
installed process and the failures were all successful second-process exits.
Before taking user state or launching a test, stop the run if any instance of
the same identifier is open; do not kill the user's window. For a concurrent
audit, use a disposable build with a distinct identifier, and make the temporary
harness and close-check settings path use that same identifier. Restore the
original release executable after the audit. Supplying only APPDATA or a private
WebView2 folder does not create this isolation. See
`docs/backlog-review-2026-10-25.md` (R-05).

**`favorites-restore` fails only inside the full suite with `the editor menu adds the active document`**
The suite's boot signal is a rendered `.cm-line`, which can be true before `installEditorContextMenu` has attached its contextmenu listener. A single synthetic right-click at that moment sees no application menu, so the favorite action is "missing"; the isolated layer usually boots fast enough to pass. Retry the gesture for a few hundred milliseconds (or wait for the menu listener's own signal) instead of treating one right-click as the final answer. The same applies to the tab menu.

**`typewriter` reports `undo keeps the primary caret centered — {"fraction":-0.054…}` once in a while**
The centering check sampled once after 400ms, while the typewriter extension settles on the frame after an IME/undo transaction. Poll the caret fraction for up to a second before failing; a single sample is not evidence that centering is broken. This was a test-timing failure, not a Typewriter or scroll-sync regression.

**A `cargo test` run reports `test result: ok` and the harness still says the layer failed**
The harness parses a summary line, so a run whose output was captured differently reports `-1`. Check the log's own `test result:` line before believing a layer failure — and note that `cargo clippy --all-targets -- -D warnings` on this tree currently fails on `launch.rs`, `latex.rs` and the test-identifier block in `lib.rs`, none of which this change touched. Run Clippy and read the file paths in its output rather than treating the exit code as evidence about your patch.

**`npm test` refuses to start with `MDraft is already running (pid …)` after a full run**
The full suite's last layer can leave an installed or portable copy running (here `C:\Program Files\MDraft\mdraft.exe`, opened by a suite that launches a document). The default harness correctly refuses to touch shared state, and `--no-build`/`--kill` cannot bypass it. Keep that window open; `--allow-installed` is limited to suites explicitly marked read-only that run under the hidden `.test-automation` identifier. It is not an override for the full suite or a suite that writes a checked-in fixture.

**`Get-Process -Id <pid>` says the process is missing, but `npm test` still reports that MDraft is running**
The workspace PowerShell view can miss an installed app process because of its process-inspection permissions. The harness uses `Get-CimInstance Win32_Process -Filter "Name='mdraft.exe'"`; run that query with the same approved permissions before concluding the app exited. In a restricted workspace it can fail with `Access to a CIM resource was not available to the client`; the harness must stop before launching in that case. Do not bypass the check or infer that no process is running from `Get-Process` or `tasklist`. If the query reports a `C:\Program Files\MDraft\mdraft.exe` path, leave the user app alone and use only an explicitly safe isolated suite or wait for it to close.

**A CDP suite prints `26/26 checks passed` and then hangs the whole `npm test`**
The suite is green, but the Node process never exits: an open `WebSocket` keeps
the event loop alive. `recent-menu-test.mjs` had no `ws.close()` and called
`process.exit` only on failure, so `test-all.mjs` waited on it until the outer
timeout, and `recent-menu ...` looked like the layer that hung. Every CDP suite
must end with `ws.close(); process.exit(failed === 0 ? 0 : 1);` on both paths.

**A second MDraft for a CDP test never appears, and the old window answers the new port**
The suite reports restored tabs, an unsaved dialog for an earlier test fixture, or a "Saved" toast you did not trigger. A previous MDraft with the same identifier was still alive; the single-instance plugin forwarded the new launch's paths to it and the new process exited, while `http://127.0.0.1:<port>/json/list` still returned the old page. Check `Get-Process | Where-Object { $_.ProcessName -match 'mdraft' }` before every probe, close the old window (or give the test build its own identifier), and do not "fix" the feature the old window appears to break.

**An app-free `npm test -- --only ...` finishes while another UI suite exits with `Warning: Detected unsettled top-level await`**
The harness cleanup used to close every process whose path contained `mdraft-test-`, even when the current run had no staged app. That could close another harness's active window and make its CDP request hang; the raw Node exit did not prove an application crash. App-free runs now skip process cleanup, UI runs only close their own exact staged executable, and preflight refuses to start while another harness or staged instance is running. Check ownership before stopping any process; the shared `.test-automation` profile still makes simultaneous UI runs unsafe.

**A full `npm test` leaves the run at `html ... crashed after 19 checks` for twenty minutes**
`html-preview-test.mjs` gives each CDP request no timeout, and the 20th check evaluates a promise in the **guest iframe** target. In the full run that request never answered: the layer ran for 1214 s and reported `exit 4294967295` only after the script was killed, while `npm test -- --only html --no-build` passed 60/60 in the next attempt, with `guest command does not execute or return a value (no response)` in about 1.5 s. A page-side `Promise.race` does not rescue a dead CDP connection. Read a `crashed after N checks` line whose duration is minutes as a harness hang, re-run the layer alone before blaming the HTML guest, and add a per-request timeout to the iframe client if it recurs.

**`test-close.ps1` hangs in an agent shell before it can print its checks**
Its own `Start-Process` inherits the harness's output handles (see the trap
above), so the script prints `launching mdraft.exe` and then never returns. This
is the harness, not a close regression. Run the script from a normal terminal for
the release check, or use a redirected `Start-Process` plus `taskkill /PID`
without `/F`, and own the profile as described above.
