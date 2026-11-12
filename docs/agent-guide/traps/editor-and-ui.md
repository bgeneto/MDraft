# Editor and UI traps

CodeMirror, the theme layer, menus, shortcuts, Preferences and the DOM measurements that decide what the reader sees.

Part of [the trap record](../traps.md). Search across every domain with:

```powershell
rg -n "<literal error text>" docs/agent-guide/traps
```

**A snippet placeholder closes the brace group, so the follow-up completion popup never opens**
`\cite{key}` is a *complete* `\cite`, so `latexContextAt` stops reporting a
citation context and the list of the project's real keys never appears. The same
template also poisons the index: `projectReferences` scans the active buffer, so
the literal `key` is harvested as a citation the document defines and is offered
back to the reader. Argument templates therefore use **empty** tab stops —
`cite{${1}}`, not `cite{${1:key}}` — which keeps the group open and inserts
nothing that looks like data. `completion-latex-unit` pins
`no argument template carries a placeholder`.

**Templating an optional `[...]` group puts the first tab stop in the wrong place**
`\includegraphics[options]{file}` templated literally starts the reader in the
options group, which is almost never what they want to type first. The optional
group is dropped and only the mandatory braces are templated, so the row inserts
`\includegraphics{}` with the caret in the file argument; the `detail` column
still tells the reader that options exist.

**A completion row whose `label` is a snippet template paints `${1:…}` in the popup**
`Completion.render` shows `displayLabel || label`, so storing the template in
`label` puts raw tab-stop syntax in the list — `section{${1:title}}` — which is
not LaTeX and reads as a bug. Rows carry the bare name in `label`, the template
in `template`, and `latex-source.ts` passes `displayLabel` so the two cannot
disagree.

**The whole window fails to boot — every UI suite reports `the window finished booting` FAIL and `TypeError: Cannot read properties of null (reading 'focus')` — after adding a nested selector to `buildChromeTheme`**
`EditorView.theme` renders through `style-mod`, which substitutes `&` only at the
**start** of a selector (`part.replace(/&/, sel)` in `style-mod.js`). A nested
object such as `{ ".cm-tooltip-autocomplete": { "& > ul": { … } } }` therefore
produces an invalid rule, the theme throws while the editor is being constructed,
and the editor never mounts — so `.cm-content` does not exist and the first
`focus()` in any suite throws. It reads as a broken application rather than a bad
CSS key. Write the selector out in full (`.cm-tooltip-autocomplete > ul`) instead
of nesting, and treat "the window finished booting" as a possible frontend
exception rather than a harness problem.

**A native `<datalist>` popup looks unthemed, but "it ignores the theme" is not the diagnosis**
A reported screenshot of the AI Assistant's Translate target showed a dark,
foreign-looking list against the dark panel, which reads as "the native popup
does not follow the app theme". `:root` and `[data-theme="dark"]` set
`color-scheme` (`src/styles.css:6`, `:84`), and the popup in that screenshot was
dark in a dark app, so its colour is at least consistent — a screenshot cannot
separate "follows `color-scheme`" from "follows the OS". What CSS can never reach
on a datalist is the type scale, row height, hover tint, the mark on the current
value and the scrollbar, and those are what actually look foreign. Judge the
control by those, and do not write a check that only compares backgrounds: the
native popup passes it.

**Ctrl+Shift+0 passes a synthetic shortcut test but does nothing with the real keyboard**
Windows can consume this input-language chord before WebView2 receives the digit.
A trusted-key capture showed only the modifiers; `Ctrl+Alt+0` delivered the digit
and reset 150% to 100%. Keep Ctrl+Alt+0 as the advertised binding, accept the old
alias where delivered, and preserve Ctrl+0 for Normal Paragraph. CDP dispatch
cannot prove an OS-reserved chord is usable.

**A live status line put in a `text` row's `fieldNote` is invisible exactly when it matters**
`fieldNote` is the cleared-model explanation, and the renderer hides it while the input has a value (`note.hidden = input.value.trim() !== ""`). Moving the "2 models found." answer there looked correct and the note was simply absent whenever a model id was typed, which is the normal case. `fieldNote` is for text *about an empty field*; an answer from an action belongs in a `note` row or in the control's own line (the API Key row's `.prefs-key-state`). The same shape applies to any row property that is gated on the field's value.

**The X button does nothing and the window will not close**
`onCloseRequested` in the frontend calls `window.destroy()` for you when the
handler does not `preventDefault()`. That command is gated by the capability set,
and `core:window:allow-destroy` is **not** part of `core:default`. Without it the
close is a silent no-op: the Rust side reports `CloseRequested` and then never
`Destroyed`, and the only way out is killing the process. Add the permission.
`scripts/test-close.ps1` exists because nothing else in the suite catches this.

**Typing stops after the final dirty tab closes, although the editor is visible**
Making the body inert during close commit blurs the editor. Removing `inert`
does not restore focus, and a final-tab replacement disconnects the old focused
element. Capture focus before commit, restore it if still connected, otherwise
focus the new editor. Assert this with real typing/focus, including WebKitGTK.

**`window.print()` silently does nothing in WebView2**
It does not throw, and `beforeprint` and `afterprint` both fire immediately, so
it looks like it worked — but no print UI opens and nothing is produced. WebView2
does not implement a print interface: the host application is expected to provide
one (`ICoreWebView2_16::ShowPrintUI`, or `PrintToPdf` for a silent file). The PDF
export therefore renders the same HTML the preview uses, writes it to the
temporary directory, and lets the *system browser* print it, because a real
browser does implement `window.print()`. Verified by calling it over CDP and
screenshotting immediately after: the application was unchanged and the events
had already fired.

**Spawning any console program from this GUI flashes a console window per call**
The application is built with `windows_subsystem = "windows"`, so it owns no
console — and Windows then allocates a brand new one, window included, for every
console child it spawns. Measured: **12 `pandoc` launches created 18 `conhost`
processes.** One `pandoc_status()` was worse than it looked, because it launched
pandoc twice: once to find it and once to read its version.

Two fixes, and both are needed:

  * `CreationFlags(CREATE_NO_WINDOW)` on every `Command`, through the `quiet()`
    helper in `export.rs`. There are four spawn sites; a new one that skips the
    helper reintroduces the flicker.
  * `find_pandoc` now returns the version from the same launch that proved the
    binary runs, so a status query costs one launch instead of two.

`CREATE_NO_WINDOW` rather than `DETACHED_PROCESS`: the child still gets a console,
so its standard handles keep working, which is how pandoc's output is read.

The LaTeX native runner (`latex_native/runner/windows.rs`) was a fifth spawn
site that skipped the helper, because it calls `CreateProcessW` directly for its
job object and cannot use `Command`. Choosing an installed MiKTeX or TeX Live then
flashed up to eight windows during validation and one per compile pass. It now
sets `CREATE_NO_WINDOW` itself; any new raw `CreateProcessW` site must too.

**A "no console window" test passes with the fix removed**
The first version of the runner test started the probe from the test process
and asserted `GetConsoleWindow()` was null in the child. It passed **with and
without** `CREATE_NO_WINDOW`: a child without the flag inherits its parent's
console, and an agent's shell (and so `cargo test`) already runs in a console
that has no window, so the child reported "no window" either way. A terminal
would have produced the opposite false result. The release app has *no* console,
which is the only state where the flag matters. The test therefore runs a
launcher process that calls `FreeConsole()` first and starts the probe through
the real `run()`. Without the flag it now reports `child-window=visible`. Before
trusting a test like this, remove the fix once and watch it fail.

**Tauri 2 never translates menu accelerators on Windows, so the menu lies**
*Symptom:* the File, Paragraph, Format and View shortcuts do nothing while the
Edit ones work, and the menu prints "Ctrl+N" beside *New* regardless.
*Cause:* muda documents that the application's own message loop must call
`TranslateAcceleratorW` with the menu's `haccel()`. Neither `wry` 0.57, `tao`
0.37 nor `tauri-runtime-wry` 2.12 calls it — verified by grepping their sources
for it, which returns nothing but a doc comment in `tao`.
*The trap inside the trap:* the Edit entries that appear to work are Ctrl+Z/X/C/V/A,
which are **Chromium's own commands**, handled inside the webview. That makes a
total failure look like a bug in some menu entries. Ctrl+F and Ctrl+H were dead
too, and so was clicking the menu itself in that respect.
*Fix:* the accelerators are collected while the menu is built (a static registry
filled by the same `item()` helper that registers them) and handed to the
frontend by the `accelerators` command, which binds them in a capture-phase
keydown handler. Deriving the list from the menu rather than writing it out twice
is what keeps the two from drifting. A 250 ms per-id guard stops a command from
running twice on platforms whose native accelerators do work, such as GTK.
*Do not test this with CDP input:* `Input.dispatchKeyEvent` injects a synthetic
DOM event **inside** the webview and never reaches a native accelerator, so such
a test reports every shortcut broken. The frontend handler is testable that way
because it *is* DOM; `scripts/shortcut-test.mjs` does exactly that.
*Assert on the effect, not on `defaultPrevented`:* that flag says only that
something handled the key, and CodeMirror legitimately claims Ctrl+Z. Three
assertions failed this way before the axis was changed.

**Two view modes are checked at once after a toggle**
`CheckMenuItem` is a checkbox, not a radio button: setting `view.preview` does not
clear `view.split`, and the platform only toggles the item that was clicked.
`sync` must write every item in each exclusive group from one state table;
`dom-smoke.mjs` asserts exactly one check per group. Tauri/muda has no radio item,
so the check mark plus this write-everything rule is the whole mechanism.

**F8 and F9 stop working when their menu items become check marks**
The accelerators are collected by the `item()` helper that builds each
`MenuItem`, and the frontend binds only what the `accelerators` command returns.
A separate helper that built `CheckMenuItem` with an accelerator but did not push
it to `ACCELERATORS` produced a menu that printed `F8` and did nothing. Keep the
registry push in both helpers; the command reported 40 entries when this was
written, and 39 after Tools › AI Assistant lost its accelerator. A drop without
a matching menu change is the failure.

**View › Full Screen and `F11` do nothing on Windows**
`PredefinedMenuItem::fullscreen` is documented as unsupported on Windows and
GTK 3, and muda's `run_predefined` falls through to `_ => {}`; predefined items
also emit no `MenuEvent`, so the frontend never hears about the click. Replace it
on non-macOS with a custom `CheckMenuItem` whose handler calls `setFullscreen`,
and keep the predefined item on macOS for Spaces integration. `F11` now reaches
the handler through the accelerator registry, and `menu_state` proves the check.

**The status flags lose their names on a window nowhere near the breakpoint**
`.window-state.json` stores physical pixels, not CSS pixels: on this 165 % display
the restored window was 1770 px wide, but `window.innerWidth` was **1073**, under
the 1080 px media query, so the labels were hidden and the screenshot looked like
a CSS bug. Measure `innerWidth` and `devicePixelRatio` over CDP before choosing a
breakpoint. The five flags plus a long cursor selection also truncate the word
and token counts near 1070 px; keep the visible names short (`Type`, `Auto`).

**A tab switch throws `RangeError: Position 30262 is out of range for changeset of length 2532`, and the command silently does nothing**
The numbers are two different documents: `2532` is the buffer on screen, `30262`
a position from a larger one. A restored `EditorState` carries CodeMirror's
`Language.state` parse context, whose `skipped` ranges belong to the document the
state was captured from; `view.dispatch({changes})` maps them through the new
change set and `ParseContext.changes` throws when one lies beyond the buffer. The
symptom is *not* an error: `runMenuAction` catches handler rejections and only
calls `toast(...)`, so Ctrl+N "does nothing" and the tab appears much later, when
an unrelated dispatch happens to succeed. No suite saw it because every fixture
is small. Drop the grammar — `languageCompartment.reconfigure([])` — before
replacing the buffer and immediately after `view.setState()`, then let
`setLanguage` install it again for the document on screen. Two habits follow: when
a menu command "does nothing", read `#toast` (and `Runtime.exceptionThrown`)
before touching the handler, and treat a state captured for one document as
unusable for another.

**A restored tab set opens only one tab, named after the last file in the list**
`openPath` has an `installingStartup` branch that fills the window's first blank
session instead of adding a tab — right for a single startup file, wrong for a
remembered set, where every call through that branch replaced the same session.
The window ended up holding one document while `settings.json` held all of them,
which is what makes it look like a persistence bug. Measured in the two-launch
suite as `FAIL two tabs came back — 1` with that one tab named
`feature-tour.md`. Set `installingStartup = false` before opening the second
file, so the rest are added as tabs; anything else that opens several documents
before the first paint needs the same rule.

**The selection background paints a strip to the left of the text**
A wrapped or multi-line selection covered part of the editor's horizontal margin,
between the gutter and the first character. `RectangleMarker.forRange` in
CodeMirror measures the full-width rectangles from `.cm-line`'s `paddingLeft` and
`paddingRight`, not from `.cm-content`'s: with `padding: 0 28px` on the content
box, the between-lines rectangle starts at `contentRect.left + 6px` (the default
line padding), 22px left of the text. Put horizontal padding on `.cm-line`
instead; selection then starts exactly at the text edge. Verified by measuring
`min(.cm-selectionBackground)` against `view.coordsAtPos(0).left` in a 409px
pane.

**F5 and Ctrl+R wipe every open tab and unsaved buffer, with no prompt**
WebView2 keeps its browser accelerator keys enabled (`AreBrowserAcceleratorKeysEnabled`
defaults to true, and wry exposes `with_browser_accelerator_keys` but Tauri 2.12
does not pass it through), so the webview reloads itself. `onCloseRequested`
never runs for a reload, so the dirty guard is bypassed; with Auto Save on, the
buffers may also be written to disk under the user. Measured: F5 reset the window
to the last saved file, `window.__marker` was gone and the tab strip collapsed to
one tab. A capture-phase `keydown` that calls `preventDefault()` on `F5` and
`Ctrl/Cmd+R` **does** stop it — verified with a real key press (`SendKeys`), not
CDP, because CDP input never reaches the browser accelerator. The HTML guest is a
separate document, so `html-bridge.js` installs the same guard inside the iframe;
a key pressed while the guest has focus never reaches the parent document's
listener.

**`<p>` in Markdown closes the tag even with "Auto-close HTML tags" turned off**
The preference removed the editor's own tag handler, and the tag still closed.
`markdown()` installs `htmlTagLanguage` — `html({ matchClosingTags: false })` —
and that support carries CodeMirror's `autoCloseTags`; at a line-start HTML block
its guard is true, so it fires independently of the editor's compartment. A
mid-line `x <p>` did not close, which is what made the two sources look alike.
Pass `htmlTagLanguage: html({ matchClosingTags: false, autoCloseTags: false })`
to `markdown()` and own the behavior in `tag-close.ts`; the suite's off-check now
types at the start of a line, where the two disagree.

**The editor's right-click menu shows only "Format Document"**
`src/format/menu.ts` called `event.preventDefault()` on the editor's
`contextmenu` and built a one-item menu. The webview's native Cut, Copy, Paste,
Delete and Select All were therefore gone: **a listener that calls
`preventDefault()` owns the entire menu**, not just the item it adds. Replace it
with the complete menu or do not intercept. The editor menu now carries the
clipboard and selection commands, case conversion, comments, line operations and
Format Document; `src/spellcheck.ts` still stops the event first when a
misspelled word is under the pointer, so spelling keeps its own menu.

**A styled menu scrollbar is `width: 8px` in computed style and completely invisible in a screenshot**
Playwright launches its Chromium with `--hide-scrollbars`, so `::-webkit-scrollbar`
paints nothing while the layout still reserves the gutter. Measured on the editor
menu: `offsetWidth - clientWidth` was 9px and
`getComputedStyle(menu, "::-webkit-scrollbar-thumb")` returned the declared
colour, yet every pixel of that 9px column was the panel background. Do not
"fix" the CSS or add `scrollbar-color`/`scrollbar-width` because of it, and do
not trust a Playwright screenshot as evidence about a scrollbar at all. Assert
the computed pseudo-element style plus the reserved gutter, or look at the real
WebView2 window.

**A `.tex` tab's “PDF… (available after the preview compiles)” follows you into an AsciiDoc document**
`label_for` returned `None` for every language without its own arm, and
`apply_context` reads `None` as “leave the label alone” — right for the many ids
whose label never varies, wrong for the handful that do. The LaTeX arms rewrote
`export.pdf` and `file.print`; switching to a Markdown, AsciiDoc or HTML tab only
*syncs* the menu (a rebuild happens on a settings save, not a tab switch), so the
reason written for the previous document stayed on screen. The leak ran both
ways: `Markdown… (LaTeX documents)` and `More Pandoc Formats… (LaTeX documents)`
survived into a `.tex` tab and told its author the rows were for LaTeX
documents. **`None` is not a neutral answer for a language-varying id** — it is
“keep the last document's text”. Every such id needs a catch-all arm restating
the label the menu was built with, plus a test that walks a LaTeX state into an
AsciiDoc one and asserts each row. Pinned by
`a_language_specific_label_does_not_outlive_its_document` and by the AsciiDoc
section of `npm run menu`.

**A new menu item appears enabled in `menu_items` but does nothing**
`menu_items` reads the native menu that was built; it proves that the item exists
and its state, not that the frontend has a handler for its id. `format.document`
was added to the tree, `menu_items` reported `enabled=true`, and `runMenuAction`
silently returned because there was no key in `handlers`. Every new id needs a
route assertion, not only an inventory assertion; `format-document-test.mjs`
now emits the menu id and requires the formatter's toast.

**`width: calc(100% / var(--zoom))` inside a `zoom`ed element leaves a gap**
CSS `zoom` already scales the box, and a percentage width resolves against the
narrowed layout box: measured in Chromium, a 800 px pane with `zoom:1.5` gives
`width:100%` a rendered width of 800 px, `100%/1.5` gives 533 px and `100%/2.25`
gives 356 px. Dividing the width again is the double-compensation trap. Use
`width:100%` and divide only a **max-width/length cap** (the Document Zoom uses
`--preview-max-width`) or the HTML iframe's viewport remains too narrow. Measure
`getBoundingClientRect`, not `getComputedStyle(...).fontSize`, which CSS zoom
never changes.

**A sticky Typst view bar inside `#preview` grows with document zoom**
`#preview` is the zoomed article, so the Document/Pages switch inside it scaled
with the document and its buttons were no longer 100 % UI. Move the bar to a
sibling in `.preview-pane` and remove it at the start of every render; a stale
bar can otherwise outlive a tab switch for one frame, so a test that clicks it
while a Typst reference is rendering may hit the previous document. Switch via
the `view.typstDocument`/`view.typstPages` menu in that test instead.

**The Preferences resize grip looks like two nested brackets in the CSS but paints a single L**
`.prefs-resize::before` (11×11) and `::after` (5×5) both set `right:3px; bottom:3px`, so their right and bottom borders land in the same pixel row and column and the smaller bracket adds nothing; at 12× zoom the grip is one 11 px L, and a mirrored copy built the same way showed only its outer bracket. When reusing the symbol in another corner, draw one bracket — a 1 px `border-left`/`border-top` box inset from the corner — rather than re-creating a "nested" pair that overlaps. A real double bracket needs the inner element inset by the size difference, not merely made smaller.

**`text-wrap: pretty` silently does nothing in the editor, because CodeMirror sets `white-space: break-spaces`**
A hard-wrapped Markdown file shown in a narrower pane leaves one word alone on the
last row (`…debug it,` / `which`). `text-wrap: pretty` is the fix, but it is a
no-op while `white-space` is `break-spaces`: measured in WebView2 157, the same
line broke after `it,` with `white-space: normal`/`pre-wrap` and after `debug`
— leaving `it, which` — only with `pretty`; with `break-spaces` the computed
`text-wrap` still read `pretty` and the break never moved. CodeMirror's
`EditorView.lineWrapping` sets `break-spaces` on `.cm-lineWrapping` on purpose
(codemirror.next#606: whitespace at a wrap point hung outside the content and the
cursor could be drawn outside it), so the rule must set `white-space: pre-wrap`
back and accept the hang. Measured cost of that: at most 7px past the content box,
inside `.cm-line`'s 28px padding, and a sweep of pane widths from 360 to 700px in
Full width found no horizontal scrollbar. Verify by reading the computed
`white-space` **and** the row breaks, not by checking that the declaration exists.

**A modal closes with Escape but focus lands on `document.body` (`{"focus":false,"dialog":false,"active":""}`)**
`document.activeElement` can be `<body>` after another panel closes without restoring focus. A "previous element is connected and has client rects" check treats body as restorable, and `body.focus()` leaves the keyboard nowhere; the statistics dialog passed when the editor was focused and failed only after Preferences had been opened and closed. Exclude `document.body` and `document.documentElement`, and use the shell's editor fallback when the previous target is gone or invisible. The same applies to a just-hidden Preferences button, whose rects are empty.

**A plan claimed the Emmet CodeMirror plugin's hard-coded `'output.indent': '	'` would insert tabs into a two-space editor — it would not**
`snippet()` from `@codemirror/autocomplete` turns each leading tab of a template line into the editor's `indentUnit` and prepends the line's own indentation (`Snippet.instantiate`), so an engine that indents with tabs is exactly what it wants, and `output.baseIndent` is never needed. The wrong conclusion came from reading the plugin's option and the editor's `indentUnit.of("  ")` side by side without reading the consumer. Found by reading `Snippet.instantiate` in `node_modules/@codemirror/autocomplete/dist/index.js` while wiring `src/emmet.ts`; `scripts/emmet-unit.mjs` now applies one expansion under a two-space, a four-space and a tab `indentUnit`. When a library hands text to a CodeMirror helper, read the helper before judging the text.

**Tab on the last field of a CodeMirror snippet goes nowhere: the caret stays in the third `<li>` and never reaches the end of `<ul>…</ul>`**
`snippet()` clears its active state as soon as it moves to the last numbered field, and a template with no `${0}` has no later stop, so the next Tab falls through to indentation. Emmet's `ul>li*3` output has fields `${1}` to `${3}` and nothing else; VS Code puts the caret after the whole expansion, CodeMirror does not. `src/emmet.ts` appends `${0}` when a template has numbered fields and no final stop. A test that only compares the inserted text passes either way — `emmet-unit.mjs` calls `nextSnippetField` and asserts where the caret ends. Related: braces in template text must be written `\{` and `\}`, and a running snippet binds Tab at `Prec.highest`, so a word typed into a field is never re-read as an abbreviation by a lower binding.

**A context rule built on CSS `Declaration` or `PropertyName` nodes never fires: `m10` inside `a { }` parses as `TagName < TagSelector < RuleSet < Block`**
Lezer's CSS grammar recovers a half-typed property as the selector of a nested rule, so the node names alone say "selector" at exactly the place a declaration is about to be written. The structural facts that do hold, all found by printing `tree.topNode.resolveInner(pos, -1)` ancestor chains for about forty carets from a Node script (use `topNode`; `tree.resolveInner` is order-dependent, see the entry below) (`ensureSyntaxTree(EditorState.create({ doc, extensions: [css()] }), doc.length, 1000)`, no DOM): the nearest `Block` decides — its parent must be a `RuleSet`, a `KeyframeList` or an `AtRule` named `@font-face`/`@page`, whereas `@media`, `@layer` and `@container` blocks hold rules; a `RuleSet` that already has a `Block` child with the caret in front of it is a selector; `style="…"` yields a `Styles` node with CSS inside, not an `AttributeValue`; and in HTML a caret just after a tag's `>` resolves to that tag's `EndTag` (or `SelfClosingEndTag`), not to `Text`. `src/emmet.ts` encodes exactly these; print the chain before guessing a node name.

**The Vite dev server in a browser shows only `Failed to start MDraft: Cannot read properties of undefined (reading 'invoke')`, so there is no toolbar to look at**
`npm run dev` plus a browser is enough for pure rendering work only until `main.ts` runs: its first Tauri call fails on `window.__TAURI_INTERNALS__.invoke`, and the boot guard replaces `document.body` with that message, so `#compiled-controls`, `.compiled-actions` and the rest never exist. To check chrome layout without the shell, leave the failed page, rebuild the three containers yourself (`#preview-shell` > `#compiled-controls`, `#preview-pane`, `#compiler-logs`), `await import('/src/styles.css')` and `await import('/src/compiled-preview-ui.ts')`, and construct `CompiledPreviewUi` with no-op actions. That renders the real class under the real stylesheet. Pass `detail` explicitly in `status(…, { label, severity, detail, engine })` the way `main.ts` does: with a state object that has no `detail`, the ` · ` parts of the message string are used as the detail too, and the engine and time then appear twice, which looks like a layout bug and is not. Measure rows by the toolbar's own height (49px is one row; `8 + 32 + 8 + 1`), not by counting distinct `top` values — a 32px button and a 17px label centred on one line have different tops and read as two rows.

**`tree.resolveInner(13, -1)` returns `AttributeValue` in the running editor and `Styles` (the CSS inside `style="m10"`) in a unit test on the same text**
`Tree.resolveInner` keeps the last node it returned in a per-tree cache and starts the next lookup from it, so what it returns depends on earlier lookups at other positions — and in the editor completion, bracket matching, indentation and spelling all make them on the same shared tree. On `<p style="m10"></p>`, a call to `resolveInner(10, -1)` or `resolveInner(13, 1)` first makes every later `resolveInner(13, -1)` stop at `AttributeValue`, without entering the overlay. A fresh `EditorState.create` never has a warm cache, so the app-free test passed and only the real editor failed: Tab indented instead of expanding, in three CDP runs of one check, and `tauri dev` behaved the same. Three wrong conclusions came first. "The parse has not reached the node": `ensureSyntaxTree(state, node.to)` and `(state, doc.length)` changed nothing. "A stale Vite dependency cache": `grep Styles` on `node_modules/.vite/deps/@codemirror_lang-html.js` found nothing only because that file is a 145-byte re-export stub; the code is in `dist-*.js`, and the production bundle had it too. "The tree has no mount": `Tree.toString()` prints non-overlay mounts such as `<style>` bodies but never overlay mounts such as attribute values, so dumping the tree proved nothing. What found it was a Node loop that called `resolveInner` at positions 9 to 14 on one tree and printed the first two ancestors each time, then varied the first call. Use `tree.topNode.resolveInner(pos, side)`, which starts fresh (`cursorAt` never enters the overlay at all). `scripts/emmet-unit.mjs` now warms the cache four ways before asking, and fails without the fix. `src/code-context.ts` and other callers still use `syntaxTree(state).resolveInner`; this was not audited for the same exposure.

**A Preferences action looks like a click that did nothing, because every toast renders behind the panel**
`.toast` was `z-index: 50` while `.prefs-overlay` is `z-index: 100`, so progress and result toasts started from a Preferences row — including *Look for TeX in WSL*, whose only feedback for a completed look is `toast()` — were painted under the panel. The action itself ran and the row changed state, so nothing in the backend looked broken; the reader saw no reaction and clicked again. Set the toast above the overlay (and its popup layers, 120/121) and disable a button for the duration of its action: repeating *Look for TeX in WSL* used to start another WSL session, another validation and another probe compile. There was a second, independent reason the result was invisible: the actions hold a progress toast with `ms=0`, show a result toast, then call the progress handle's `dismiss()` in `finally` — the handle hid the shared element regardless of which toast was showing. `toast()` now tags each message with a generation, and a stale handle is a no-op.
