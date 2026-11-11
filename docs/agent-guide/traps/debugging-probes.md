# Debugging probe traps

CDP probes and measurements that report the wrong thing: selection, focus, scroll, timing, stubs and the helpers that parse their own replies.

Part of [the trap record](../traps.md). Search across every domain with:

```powershell
rg -n "<literal error text>" docs/agent-guide/traps
```

**A CDP suite's `evaluate` helper already parses JSON, so `JSON.parse(await evaluate(...))` throws `SyntaxError: "[object Object]" is not valid JSON`**
`dom-smoke.mjs` returns `typeof value === "string" ? JSON.parse(value) : value`, while `licence-test.mjs` returns the raw value. Copying a snippet between suites therefore breaks on the one that parses. Read the helper before adding a probe, and let the helper do the parsing.

**A Preferences search probe on a word that appears in two sections fails, although the search works**
`latex` matched both **Export** (the `LaTeX` heading) and **Editor**, because the completion row's help text names LaTeX. A search term is not a section locator. Pick a phrase unique to the target (`preferred image syntax` for Image) or assert that the expected section is present rather than that it is the only one.

**`TypeError: Failed to construct 'ClipboardItem': Empty dictionary argument` while backing up the clipboard**
WebView2 can return an item with `types: []` from `navigator.clipboard.read()`.
A nonempty item array does not prove there is usable
clipboard content; cloning each item blindly fails before the paste regression
can run. Filter out items with no exposed formats before materializing their
blobs and constructing the backup `ClipboardItem`s.

**`connect ECONNREFUSED 127.0.0.1:9238` after the same probe's `/json/list` returned page targets**
Several diagnostic launches reused one `WEBVIEW2_USER_DATA_FOLDER` and exposed
multiple MDraft page targets through the same browser endpoint. Stopping an
earlier launcher removed that endpoint; this was not evidence that PDF.js or
Pages had failed to start. Keep launch, CDP readiness polling, gestures and
cleanup in one diagnostic lifecycle, with one private WebView profile. Inspect
the returned page targets before retrying a launch, and clean up only the
instance that the probe owns.

**`Cannot find path '...\AC\Temp\mdraft-format-math-probe.mjs' because it does not exist` immediately after a successful write and run**
Separate agent shell calls on this Windows host can receive different sandbox
`TEMP` directories. Recomputing `Join-Path $env:TEMP <name>` in the next call
looked like the first write had failed, but named a different directory. Keep
multi-call probes at a fixed ignored workspace path such as
`node_modules/.cache/mdraft-format-math-probe.mjs`, or reuse the resolved absolute
path from the first call. Remove the temporary probe when finished.

**Assigning `window.__TAURI_INTERNALS__.invoke` leaves the export save-picker stub unused**
In the production Tauri webview its descriptor is non-writable and
non-configurable; a sloppy-mode assignment silently does nothing. Inspect
`Object.getOwnPropertyDescriptor` rather than assuming the mock was installed.
Do not weaken IPC protection to make a test pass. The native HTML currency test
uses Print's real shared article, the actual pure HTML wrapper, and the Rust
writer. For delayed IO/picker tests, `p0-lifecycle-test.mjs` instead wraps the
browser `fetch` transport for `ipc.localhost`, preserves Tauri response headers,
and restores the hook in `finally`; it never changes the protected IPC methods.
Check the interception actually ran before drawing conclusions from a timing test.

**`p0-lifecycle ... FAIL 0/1 checks` with `Timed out: window.__p0TestOnly.block?.entered` after a save command is split**
The suite delays and fails IPC by command name. When GAP-032 moved the editor's
save from `write_document` to `write_document_checked`, the `block("write_document", …)`
hook never fired, so the first delayed-save check sat until its timeout and the
whole layer looked like a hung application. Update every `block(...)` and the
`failPath` branch when a command is split; keep a direct legacy-command call only
where that command's own contract is the subject. The harness is not broken and
the app did not regress.

**`p0-lifecycle` times out waiting for a modal after emitting `open-files` with a PDF**
GAP-017 made startup and handoff paths report a refusal as a toast
(`openPath(..., { silent: true })`) so several paths cannot stack native modal
dialogs. The suite still waited for the intercepted `plugin:dialog|message`
text and failed at 23/24. Accept the toast (or both) when the handoff UX changes;
do not restore a modal per path just to keep the old assertion.

**`ReferenceError: require is not defined` when SSR-loading `src/markdown.ts` for a pure export-wrapper test**
The browser module imports CSS and Highlight.js's CommonJS entry point; loading
the whole module through Vite SSR can inline that dependency into an ESM
evaluator. This is a test-environment mismatch, not a broken application build.
Exercise the renderer in the real webview; when checking only its pure wrapper,
compile the actual pure declarations in isolation as `export-test.mjs` does.
Do not rewrite runtime imports to satisfy a Node-only wrapper test.

**A new-tab CDP probe finds no `.math-inline`, or currency checks fail on an empty preview**
`Ctrl+N` activation and focus are not synchronous with the synthetic keydown.
`Input.insertText` sent immediately afterwards can target the previous surface
instead of the new editor; this initially looked like a renderer regression.
Wait for the new tab to activate and focus `.cm-content` before inserting text,
as `newTab` in `rich-paste-test.mjs` does.

**A multi-cursor paste probe produces `AC\\$6 A` instead of two insertions**
CodeMirror's default add-selection modifier is Ctrl on Windows/Linux and Meta
on macOS, not Alt. Use CDP mouse modifier `2` (Ctrl) on Windows; verify the
installed `addsSelectionRange` implementation before diagnosing paste mapping.

**A paste into a fresh tab produces `R\\$5\nA A` instead of inline text**
CodeMirror remembers its last linewise copy across tabs. Pasting the exact same
text with empty selections intentionally inserts whole lines, even in a new
tab. This looked like the currency transform had introduced block spacing.
Use a different clipboard value for an unrelated multi-selection test, or make
a nonempty-selection copy to clear the linewise metadata. Preserve that native
metadata when adding clipboard filters.

**The CDP test scripts do not work against the Linux build**
They speak Chrome DevTools Protocol through WebView2's remote debugging port.
WebKitGTK has no CDP: it offers a WebKit inspector instead
(`WEBKIT_INSPECTOR_SERVER`), which is a different protocol and only in debug
builds. On Linux the automated coverage is therefore `cargo test` plus a manual
launch; do not read a missing `9222` endpoint as an app failure.

**A test that launches the app can leave it running and break the next build**
This is how the failure above gets manufactured. Any script that starts
`MDraft.exe` has to kill it on **every** exit path — an early `Write-Error`
under `$ErrorActionPreference = "Stop"` exits before the cleanup runs, which is
what `scripts/test-close.ps1` used to do. Wrap the launched process in
`try { … } finally { … }`, and re-check for leftovers after touching either
script.

**A second MDraft for a CDP test dies with `HRESULT(0x800700AA)`, even when the exe is outside the workspace**
WebView2 allows one browser process per user-data folder, and every instance
defaults to `%LOCALAPPDATA%\io.github.bernh.mdraft\EBWebView`. While another
MDraft window — including the user's portable build — is open, launching a test
copy with the same `identifier` fails with
`failed to create webview: WebView2 error: WindowsError(Error { code: HRESULT(0x800700AA), message: "The requested resource is in use." })`.
Setting `WEBVIEW2_USER_DATA_FOLDER` does **not** help: Tauri resolves
`app_local_data_dir()` and passes that to WebView2, overriding the variable.
Build a throwaway binary with a different identifier and run it from outside the
workspace:
`tauri build --no-bundle --config .tmp-test/tauri.htmltest.conf.json`, where the
merge sets `identifier` and `productName`. That gives the test its own settings
and WebView2 profile. Delete `%APPDATA%\<test identifier>` to reset it; do not
kill the user's instance or delete the shared profile.

**A probe that reuses the release binary needs `MDRAFT_TEST_HIDDEN` + `MDRAFT_TEST_IDENTIFIER`, and an orphaned runner keeps stealing the port**
The existing `0x800700AA` entries describe the profile conflict; what they do not
say is that the *release* binary already supports an isolated launch, so no
throwaway build is needed: set `MDRAFT_TEST_HIDDEN=1` and
`MDRAFT_TEST_IDENTIFIER=io.github.bernh.mdraft.test-automation` and copy the exe
outside the workspace. It prints `MDRAFT_TEST_HIDDEN_ISOLATED_WINDOW_V2` on
stderr, which is how a probe confirms it took that path. Two failure modes cost
time anyway. First, an orphaned `node scripts/test-all.mjs` from an earlier
interrupted run relaunches the app through the single-instance plugin, so the
probe's `fetch("http://127.0.0.1:<port>/json/list")` reports `no page target`
while `Get-Process mdraft` shows a *new* PID each time; kill the `node.exe` whose
command line matches `test-all` before anything else. Second, `Start-Process`
with `-RedirectStandardOutput` blocks until the child exits, so a launch that
succeeds looks like a hung command — spawn it from Node with `stdio: "ignore"`
instead. `Emulation.setDeviceMetricsOverride` does **not** resize a hidden
WebView2 window reliably; to test a narrow pane, set `--editor-max-width` and
switch to Source mode (the split pane caps the content column, so the override
appears to do nothing).

**A CDP driver that checks `if (message.id && pending.has(message.id))` hangs on `Runtime.enable`**
`Runtime.enable` is the first request, so its response carries `id: 0`, which is
falsy. The response arrives and is dropped, the promise never resolves, and the
socket looks dead. Compare `message.id !== undefined`, or start `nextId` at 1.
Found while writing `word-sync-test.mjs`, after first blaming the WebView2
endpoint.

**Typing in a CDP test leaves the buffer untouched**
`closeBrackets()` is an `EditorView.inputHandler`, not a key binding: it reacts to
text insertion, so a synthetic `KeyboardEvent` dispatched from `Runtime.evaluate`
never reaches it, and a test written that way proves nothing. Type through
`Input.dispatchKeyEvent` with `{ type: "char", text, key }` (one call per
character, focused `.cm-content`), the same path the webview uses for real keys.
The autoclose suite is written that way for exactly this reason.

**`clip.exe` fails with `ERROR: Access is denied.`, and `Set-Clipboard` "succeeds" but reads back empty**
The agent session's sandbox denies clipboard ownership to any process launched
from it — the same family as `%TEMP%` writes and the WebView2 profile.
`[Windows.Forms.Clipboard]::SetDataObject` throws "Requested Clipboard operation
did not succeed" however often it is retried, and setting `-STA` or running from
outside the workspace changes nothing. A real Ctrl+V therefore cannot be driven
from here, and `Set-Clipboard` is the trap inside the trap: it reports success,
so a driver that checks nothing afterwards tests an empty clipboard. Test the
paste path with the UI suites' synthetic `ClipboardEvent` and `DataTransfer` —
that is the same `event.clipboardData` a real paste carries — and say the real
clipboard was unavailable rather than claiming a failed end-to-end check.

**A CDP suite saves twice and the second write never happens, with no error**
`runMenuAction` suppresses a repeat of the same menu id within 250 ms, so a
platform whose native accelerator also fires cannot run the command twice. The
format suite emitted `file.save`, saw the file change, formatted again and saved
again inside that window; the second `file.save` was dropped without a message.
The file stayed formatted and the tab stayed dirty, which looks exactly like a
broken undo. The tell was the toast: it still read "Already formatted", never
"Saved". Wait 300 ms before reusing a menu id from a script — a person cannot
press Save twice in 250 ms, but a test can.

**A new CDP suite opens its fixture with `emit("open-files", ["samples/…"])` and four checks fail on the wrong document**
The harness stages the binary outside the workspace, so a relative path resolves against the staged folder, the open is refused with a toast, and every later assertion measures the launch document instead. The failures read as an application bug — here, "the HTML fixture opens" and three disabled-entry checks against a Markdown tab. Resolve against the repository before emitting: `path.resolve(import.meta.dirname, "..", file)`.

**`npm test` reports `rust ... FAIL cargo test exited -1 without a result line` in 0.0s on Linux, while `cargo test` passes**
`runRustSuite` in `scripts/test-all.mjs` invoked `cargo-vcvars` unconditionally.
That is a Windows-only wrapper; on Linux `spawn` emits `ENOENT`, `run()`
returns code `-1`, and `parseRustResult` finds no summary line, so the harness
reports a Rust failure that never ran. Use plain `cargo` when `process.platform`
is not `win32`; `runWrapped` already falls through to the plain command. The
literal tell is the `0.0s` duration: a real 302-test cargo run cannot finish
that fast.

**A measurement that runs against a stopped application proves nothing**
A driver reported "0 console hosts during 8 status calls and 8 conversions" —
because the application was not running and the driver had died with
`ECONNREFUSED 127.0.0.1:9222` before doing any work. The results looked like a
clean pass. **Check the driver printed its own success line, and that the files it
should have produced exist**, before believing a zero. This is the same trap as
the CDP suites that "pass" against a window showing the wrong document.

**`sky.get_window_state({ window: mdraftWindow })` shows another app over MDraft**
On this Windows host, the returned window metadata identified MDraft correctly,
but the screenshot included a foreground application obscuring it. The almost
wrong conclusion was that the foreground app's controls belonged to MDraft, or
that an occluded-window capture was necessarily an unobscured app image.
Calling `sky.activate_window({ window: mdraftWindow })`, then capturing fresh
state, exposed the actual MDraft layout. Inspect screenshot content as well as
window metadata before choosing coordinates; do not reuse the pre-activation
screenshot or element indexes.

**A page-side wrapper around `window.__TAURI_INTERNALS__.invoke` silently does nothing**
The intended hold looked correct: `internals.invoke = (cmd, args, opts) => ...` was installed, `window.__ownerHolds` held the command, yet the command resolved immediately at full speed. `Object.getOwnPropertyDescriptor` explains it: both `window.__TAURI_INTERNALS__` and its `invoke` are `writable: false, configurable: false`, so the assignment is a silent no-op in a non-strict script. Do not diagnose this as "the API captured invoke at module load"; `@tauri-apps/api/core` does resolve `window.__TAURI_INTERNALS__.invoke` at call time, but the property cannot be replaced. Hold at the IPC boundary instead: every command is an HTTP request to `http://ipc.localhost/<command>` and CDP `Fetch.enable` with a URL pattern can pause it (`Fetch.requestPaused`), then `Fetch.continueRequest` releases it. Extend `scripts/cdp-page.mjs` with `onEvent` for the event stream; the alternative real check is a slow build, which no engine-free host can provide.
