# DOM measurement traps

Probes that read layout, selection, focus or visibility: what the DOM reports versus what the reader actually sees.

Part of [the trap record](../traps.md). Search across every domain with:

```powershell
rg -n "<literal error text>" docs/agent-guide/traps
```

**The WSL WebKitGTK input probe reports event ages around `-42 ms`**
`KeyboardEvent.timeStamp` and `performance.now()` did not share an identical origin in one run; treating negative values as usable latency discarded almost all samples. `docs/audits/linux-layout-native-probe.py` retains raw ages, calibrates by the minimum observed age, and rejects a run unless an externally injected key is delayed by the intentional positive-control block. This is a calibrated estimate, not a hardware-key measurement.

**`Invoke-WebRequest http://127.0.0.1:1420/...` times out although Vite prints `ready`**
Vite's default dev server binds `localhost`, which on this host resolves to IPv6 `::1`; the IPv4 loopback is a different address. A readiness loop against `127.0.0.1:1420` therefore never connects and looks like a failed dev server. Probe `http://localhost:1420` instead, or start Vite with `--host 127.0.0.1` when a tool insists on the address.

**`node scripts/scroll-sync-test.mjs` prints its checks and then sits on `Runtime.evaluate` forever**
Returning from Source-only to Split re-renders the HTML guest, so the active iframe is replaced and the old CDP target closes. The test kept a WebSocket to the old target; its `Runtime.evaluate` Promise never settled, Node printed `unsettled top-level await`, and the manually launched MDraft window stayed on screen because the script owns only CDP, not the app process. Reject pending requests on socket close, give every CDP call a timeout, reconnect to `.html-preview-frame.active` after the split render, and close the launched app in the runner's `finally`. The repo harness already owns the app; a manual runner must do the same.

**A CDP test reading `.cm-content.innerText` sees extra blank lines**
CodeMirror's content element includes the visual gap between lines, so
`innerText` does not equal the buffer and a string comparison fails even when the
paste is correct. Join `[...document.querySelectorAll('.cm-line')].map((line) =>
line.textContent)` instead; it is the rendered source, in order. The internal
`cmView` is not exposed by this build, so do not rely on it either.

**A window-rect measurement disagrees with the saved window state**
A non-DPI-aware process gets *virtualised* coordinates from `GetWindowRect`, so
on a 150% display every reading is two thirds of the real value and looks like a
restore failure. Call `SetProcessDpiAwarenessContext(-4)` first, and compare
`GetClientRect` against the state file — the plugin stores the client size, not
the window rect, so frame chrome accounts for another 20-40 px.

**A synthetic right-click opens no menu only when the full suite runs**
`format-document-test.mjs` measured the physics line's coordinates in one
`Runtime.evaluate` and dispatched the `contextmenu` in a second. Opening the
physics tab schedules a preview-driven scroll, so under the full suite's load the
pane had moved by the second call, `elementFromPoint` named something outside the
editor, and `menuState()` reported `{"count":0}`. The three format checks then
cascaded — no format, no save, no redraw — while the same suite passed in
isolation five times. Measure the line and dispatch the event in the **same**
evaluate (`rightClickLine`), and keep one retry. Do not read this as a formatter
or spellcheck fault.

**A CDP test sets `window.getSelection()` but CodeMirror still reports no selection**
`editor.cursorInfo().selectionLength` stays 0 when a test sets a DOM Range from
`Runtime.evaluate`, even after dispatching `selectionchange`; the paste handler
then imports the image instead of replacing the selected text, so the test
reproduces a bug that is not there. Select with real mouse events
(`Input.dispatchMouseEvent` pressed/moved/released), assert
`window.getSelection().toString()` before pasting, and only then dispatch the
paste. `scripts/image-path-paste-test.mjs` does exactly this.

**A Preferences row's label includes its help mark, and one label can be a prefix of another**
`row.querySelector('.prefs-label').textContent` is `"Run a command?"` for a row that has help: the `?` span is part of the text. Worse, `"Open the exported file"` is a prefix of `"Open the exported file's folder"`, so an `includes()` match silently picks the first row and a test can report both boxes ticked while one was never touched. Strip the trailing `?` and compare the exact label. A probe that matched by substring concluded the second checkbox was already on and never clicked it, then chased a backend/frontend mismatch that did not exist. The help text itself is not in that span either: `.prefs-help`'s `textContent` is just the `?`, and the sentence lives in its `title` attribute.

**`#sidebar.hidden` stays false while the sidebar is visibly gone**
Sidebar visibility is a class on `.app` (`sidebar-hidden`), not the element's
`hidden` attribute; the element is always in the DOM and `.hidden` is always
`false`. A screenshot setup that asked `document.getElementById("sidebar").hidden`
concluded the sidebar was visible when it was not, clicked the toggle the wrong
way, and produced a capture with the outline where the next one had none. Read
`.app.classList.contains("sidebar-hidden")` (or the button's `aria-pressed`)
before deciding whether to toggle it.

**A Preferences test edits a row that belongs to another section, and nothing changes**
The panel renders one section at a time. With *Editor* open, `document.querySelector('.prefs-row')` cannot find **Editor font size** or the preset buttons — those live under *Typography* — so a test that ignores the setter's return value silently changes nothing and then fails on a downstream measurement (here, the line height stayed at the old font size). Click the owning section first (`Typography` for sizes and presets, `Editor` for Content Width and Line Height), re-query after every update because the panel rebuilds, and assert that the setter found its control.

**A Preferences search probe for "favorites" narrows to two sections, not one**
Search matches row labels, select options and group headings across every section. "favorites" is both the Files note **Managing Favorites** and the **Favorites** option of *Default Sidebar Panel* under *Appearance*, so a probe that expected only `Files` saw `Files,Appearance` and failed. Search a term unique to the target row (`managing`), or assert that the expected section is present rather than that it is the only one. A word shared by two sections is not a locator.

**A `conhost` count does not measure whether a console window is visible**
`CREATE_NO_WINDOW` still allocates a console — it just gives it no window — so
counting `conhost` processes reports roughly the same number either way, and
comparing "before and after" snapshots misses every transient one entirely. The
only trustworthy signal is window visibility, and **that cannot be observed from
an agent session at all**: a process launched with `CREATE_NEW_CONSOLE`, which by
definition owns a new console, produces no entry in `EnumWindows` here, while the
same enumeration correctly lists the application's own window. Conclude nothing
from a zero count; say the verification is unavailable instead.

**`Page.captureScreenshot` shows the status bar but never the native menu**
A check mark in the View, File or Themes menu cannot be photographed by CDP and
cannot be read from the DOM: the menu is a native control outside the webview.
Screenshots of the application therefore look as if the checks were never added.
The `menu_state` command returns every check item's `id` and `checked` for the
suites; use a Win32 screen capture only if a pixel proof is genuinely needed, and
do not conclude from a CDP screenshot that the menu is unchanged.

**A CDP test reports the preview word highlight as `null` even though the word is painted**
`syncPreviewFromSource` pulses by swapping the registered name between `mdraft-sync` and `mdraft-sync-peak` every 250 ms. A probe that reads only `CSS.highlights.get("mdraft-sync")` lands on the peak half of the beat and sees nothing; `word-sync` failed "a source word paints the preview" at 250 ms after the double-click for this reason, not because the mark was missing. Read either name (`get("mdraft-sync") ?? get("mdraft-sync-peak")`), and assert persistence on the computed background of `.cm-sync-word` rather than on the registry entry.

**`elementFromPoint` returns `none` for a word visibly in the iframe, and the double-click selects nothing**
The HTML word test computed the range rect in the guest but never scrolled the guest. `getBoundingClientRect` returned y=674 while the iframe viewport was about 671 px tall, so the page coordinates fell below the frame: no selection, no `select` message, and `check("the target is on screen")` passed because it only tested `!== null`. Call `scrollIntoView({ block: "center" })` in the guest, wait for the layout, and assert `0 < y < frameOrigin.height` before sending the click. The guest's rect and the frame's rect are in different coordinate systems; `elementFromPoint` on both sides is the cheap proof that they line up.

**A probe reports `csp: null` because it looks for a `<meta>` tag, while the policy is enforced**
Tauri injects the application CSP as a **response header** for the custom protocol; there is no `meta[http-equiv="Content-Security-Policy"]` in `index.html`. Asking for that element returns `null` and reads as "no CSP" even though inline scripts are already blocked. Prove enforcement by appending a script element and checking that its side effect did not happen, or read the document response headers. Do not conclude the policy is absent from the meta tag.

**`TypeError [ERR_INVALID_ARG_TYPE]: The "path" argument must be of type string. Received undefined` while asserting the Save dialog's default name**
`@tauri-apps/plugin-dialog` nests the save options: `save(options)` invokes `plugin:dialog|save` with `{ options }`, while `plugin:dialog|message` sends `message` at the top level. A stub that reads `args.defaultPath` records `undefined`, although the dialog itself still receives the right `defaultPath` — the suite looked like the name builder had produced nothing. Read `args.options?.defaultPath ?? args.defaultPath`, and assert the captured value is a string before calling `path.basename` on it; the `p0-lifecycle` and `ai` stubs both do.

**A theme check clicks the theme button once and expects dark, but the app is already dark**
The fresh profile stores `theme: "system"`, and the status-bar button toggles between light and dark. On a host whose system theme is dark, the first click goes to light, so the assertion fails in the harness while passing on a light host. Read `documentElement.dataset.theme` first and click until it is the target, then restore the original in the same loop; do not assume the starting side.
