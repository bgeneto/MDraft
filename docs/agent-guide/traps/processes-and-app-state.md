# Processes and application state traps

Launched instances, leaked processes, the WebView2 profile, `settings.json` and recovery state — the things a test or a build leaves behind.

Part of [the trap record](../traps.md). Search across every domain with:

```powershell
rg -n "<literal error text>" docs/agent-guide/traps
```

**`Failed to create webview: WebView2 error: WindowsError(HRESULT(0x800700AA), "The requested resource is in use.")`**
The dev app fails before any frontend code loads, so it is never a symptom of a
TypeScript change. It happens when a WebView2 user-data folder is still held;
`WEBVIEW2_USER_DATA_FOLDER` pointed at a fresh directory does **not** clear it
when the busy resource is elsewhere. Do not kill `msedgewebview2.exe`
wholesale — most of those belong to Microsoft Teams. Verify frontend behaviour
against a real `EditorState` instead: `latexCompletionSource` and `snippet()`
both run headless, which is enough to prove what a row inserts and where the
caret lands.

**A hand-launched `mdraft.exe` panics with `HRESULT(0x800700AA)` and a new PID appears after `taskkill`**
Two causes stacked. The WebView2 profile was held by a leftover instance, and an orphaned `node scripts/test-all.mjs` from an interrupted run was relaunching it through the single-instance plugin — so killing the app produced a fresh PID. `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*test-all.mjs*' }` found the parent; stop it first, then the app. To screenshot the panel afterwards, copy the binary outside the workspace and launch it with `MDRAFT_TEST_HIDDEN=1`, `MDRAFT_TEST_IDENTIFIER=io.github.bgeneto.mdraft.test-automation` and its own `WEBVIEW2_USER_DATA_FOLDER`; a copy inside the workspace cannot create the profile at all.

**`pkill -f <pattern>` kills the shell running it**
`pkill -f` matches against full command lines, and the shell's own command line
contains the pattern you just typed. The result is a silent exit 1 with no
output, which looks like the command never ran. Use a bracket so the pattern
cannot match itself: `pkill -f "amd64/mdraf[t]"`.

**A test reads `scrollLeft` before a smooth scroll has moved**
`scrollBy({ behavior: "smooth" })` returns immediately, so `element.click()` followed by a `Runtime.evaluate` of `scrollLeft` still sees the old offset; two rapid clicks can also coalesce into one page. The document-tabs suite first failed "a second page reaches the edge" for exactly this reason. Poll until the offset changes and then settles, and issue one click per page.

**Force-killing the app can corrupt its WebView2 profile, and the next launch dies silently**
After enough `Stop-Process -Force` cycles the app starts dying on launch with no
output at all — release builds have no console, so nothing is printed and the
window never appears. The Application event log shows `Event Name: BEX64`, a
DEP/buffer-overflow exception, which reads like a native regression and is not
one. The fix is to delete the WebView2 user-data folder
(`%LOCALAPPDATA%\<identifier>\EBWebView`, ~80 MB) and relaunch. Diagnose it by
launching the *previous* binary: if that also fails, the profile is at fault and
nothing in the change is. Prefer `CloseMainWindow()` over `Stop-Process -Force`
when a script needs the app gone.

**The release build dies with `BEX64` while the portable build is open**
The portable build redirects only the config directory; it shares
`%LOCALAPPDATA%\io.github.bgeneto.mdraft\EBWebView` with the ordinary build.
Starting one while the other runs makes the new process die on launch with the
same `Event Name: BEX64` signature as profile corruption, and deleting the
profile fails with `being used by another process`. Close the other MDraft
window first, then remove `EBWebView` only if the launch still fails. This is
not a native regression in the binary being tested.

**Starting the app with `Start-Process` never returns and prints nothing**
`Start-Process .\src-tauri\target\release\mdraft.exe` from a harness shell hangs
until the call is moved to the background: the GUI child inherits the caller's
output handles, so the shell never sees the pipe close, and not even the line
printed before the launch appears. It reads like the application failing to
start. Pass `-RedirectStandardOutput` and `-RedirectStandardError` to files —
which also recovers the release build's Rust output, normally discarded — and
poll `http://127.0.0.1:9222/json/list` for readiness.

**Deleting `settings.json` "to get first-run state" destroys the user's Favorites, Recents and remembered tabs**
The instruction above is right about the test and wrong about the blast radius:
`favorites`, `recentFiles`, `lastTabs`, `lastActiveTab`, `lastDirectory` and every
preference all live in that one file, and there is no backup and no recycle bin.
Measured: two smoke runs against one long-lived profile failed 7 checks that
disappeared at 107/107 once the profile was reset — the reset was correct, the
deletion was not. Back the file up (and `.window-state.json`) before resetting and
put it back afterwards, or run the suites against a build with its own
`identifier`, which is the mechanism the `0x800700AA` entry below already uses.
Never treat `%APPDATA%\<identifier>` as disposable when the person who owns it is
not the one running the test.

**`taskkill /PID $pid` kills the agent shell, and the cleanup after it never runs**
`$pid` is PowerShell's read-only automatic variable holding the *current* process, so `$pid = [int](Get-Content pid.txt)` fails with `Cannot overwrite variable PID`, and the following `taskkill /PID $pid` signals the shell itself — it exits 255 halfway through a cleanup script, leaving the test instance, its appdata and its profile behind. Use any other name (`$appPid`, `$targetPid`) when closing a launched instance, and re-check the process list afterwards.

**`Copy-Item ...\MDraftFontTest.exe` fails with `being used by another process` after `taskkill /PID` reported `SUCCESS`, and the next launch still shows the old UI**
The isolated test instance had not actually exited (its close handler was still waiting), and the single-instance plugin forwarded the new launch to it, so CDP answered and the process list looked healthy while the binary on disk was still the old one. Check `Get-Process` and `StartTime`, force-close the disposable instance, wait for the lock to clear, then copy and relaunch. Never overwrite the installed copy the reader is using.

**Add yours before you finish the task** - see
[Recording traps is required](../traps.md#recording-a-trap-is-required) for what qualifies and
how to write it. The list is append-only in spirit: do not delete an entry because
the fix landed, because the fix is what makes it recur.

**A UI suite leaves recovery-journal entries behind, and the next launch restores test buffers**
The crash-recovery journal lives in `<app config>/recovery/` beside
`settings.json`, and every suite that types into the editor writes to it. A run
against the real config directory therefore leaves dirty test documents that the
developer's next launch offers to restore; deleting only `settings.json` does not
remove them. `scripts/test-all.mjs` now backs up and restores the whole `recovery`
directory with the two settings files, and `resetAppState` clears it between
suites. Any new launcher outside that harness must do the same, or build with its
own `identifier`.

**`%APPDATA%\io.github.bgeneto.mdraft\settings.json` ends up with a mock AI endpoint and no favorites after a test run**
Two `scripts/test-all.mjs` runs overlapped and both used the same application identifier. Each copies `settings.json`, `.window-state.json` and `recovery` into its own stage and deletes the originals; when one restored, it wrote the other run's test profile back as the "developer's" state, and the original favorites, recents and tabs were gone. The harness is not concurrency-safe. Before starting it, check for another `test-all.mjs`/`npm test` and for any MDraft process, and run one harness at a time; a concurrent audit needs a build with its own identifier. Restore the values captured before the run; a missing recovery journal and `.window-state.json` may not be recoverable.

**`APPDATA` and `LOCALAPPDATA` do not isolate a one-off close test**
Tauri resolves `app_config_dir()` and the WebView2 profile through Windows Known
Folders, not through those environment variables. A redirected `Start-Process`
with both variables pointed at a temp folder still opened the developer's real
settings, added the fixture to Recents, changed `lastDirectory` and rewrote
`%APPDATA%\io.github.bgeneto.mdraft\.window-state.json`. It proved WM_CLOSE exits
with code 0 and writes the state file, but it did so at the owner's expense. Use
`scripts/test-all.mjs` (which backs up and restores the whole state), or a build
with its own `identifier`; never treat environment redirection as isolation.
Do not override `APPDATA` when running `scripts/test-all.mjs` either: the harness
uses that variable to choose which state to back up, while Tauri still uses the
real Known Folder. In that configuration `FAIL  the render emitted source fragments  (0 fragments)`
can reflect the inherited profile, and the harness restores the wrong directory. Leave `APPDATA` unchanged for
the normal harness, or build and configure a separate test identifier.
