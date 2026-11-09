# Test suite traps

Individual app-free and UI suites: what they assert, what they leave behind, and why a suite passes alone and fails in the full run.

Part of [the trap record](../traps.md). Search across every domain with:

```powershell
rg -n "<literal error text>" docs/agent-guide/traps
```

**A test launched with `visible: false` still displayed `main.tex — MDraft`**
The window-state plugin calls `show()` during restoration, including when
the Tauri window configuration starts hidden. The `MDRAFT_TEST_HIDDEN` mode
must also exclude the main window from window-state restoration; verify the
actual Win32 window visibility before running a suite while someone is working.

**An Auto Save test reports that undo was not persisted after exactly `20000 ms`, although the editor already shows the undone text**
Auto Save itself runs every 20 seconds; a timeout equal to that interval can expire just before the next timer and disk write. The editor state observed through CDP showed the undo had succeeded while the saved file still had the previous revision. Wait one full interval plus slack (the tab test uses 28 seconds), and check undo/redo in the editor separately from the subsequent disk flush.

**`group prototype: visible paragraph is in the accessibility tree` fails immediately after a zoom reset**
The test restored zoom after scrolling at 300%, so the target was no longer visible and `content-visibility: auto` could leave its subtree skipped. The same paragraph appeared in the accessibility tree once the test scrolled it into view again and waited two animation frames. Re-establish visibility after changing zoom before concluding that a visible paragraph is missing; this check does not substitute for a screen-reader traversal.

**A test asserts that the appended wrapper rule was added, and the assertion passes before the code does**
`prepare` assembles one string from the preamble, the action prompt and (now) a fixed appendix. The first version of the test looked for `Return only the requested content`, a sentence the **preamble** already contains, so it was measuring the wrong part of the message: it reported the appendix present when Improve deliberately does not get one, and a reader would have "fixed" the code to make it pass. Assert on a phrase that only the new part can contain (`The application reads only the text inside <tag>`), or on the assembled tail, and prove the exception as well as the rule.

**`format-document` fails exactly three AsciiDoc checks — `right-clicking AsciiDoc opens the editor menu` plus the two that read the menu's items — and passes on the next run against the same binary**
The menu was opened, not missed: instrumenting the page showed `.editor-menu` added at +2 ms and removed at +8 ms, with a `scroll` event on `.cm-scroller` at +7 ms. `scrollTop` and `scrollLeft` were **0** in that handler and an `requestAnimationFrame` sampler recorded no other value for the next 1.5 s, while patched `scrollTop`/`scrollIntoView`/`scrollTo`/`scrollBy`/`focus` saw no call at all — so no code above the browser scrolled anything. Chromium emits `scroll` on a scroller when a layout change re-clamps it, and a document still finishing its first render (the AsciiDoc tab's preview renders after the source is shown) does that within a frame of the menu opening; `closeMenu` fired on any `scroll` at all. It is a race, so it fails about two runs in three and never in isolation on a fast machine. `onScroll` in `src/context-menu.ts` now compares the scroller's offset with the one captured in `openMenu` and follows only a real movement; `format-document-test.mjs` pins both halves (a dispatched no-op `scroll` must leave the menu open, `scrollTop += 40` must close it), and the first check fails 100 % on the old handler while the three AsciiDoc checks pass in that same run — which is what proves the race, not the menu. Do not read this as the right-click missing the editor or as an AsciiDoc-only menu: the listener is one per application and every language goes through it. Measure it with a `MutationObserver` on `document.body` plus the capture-phase listeners, not by reasoning about the click.

**A usage assertion reads the settings copy from before the request it just made**
`persist()` in `src/main.ts` queues the whole-settings write, so asking Rust for
`get_settings()` immediately after an AI request reaches `done` can still return
the list from before that request, while the palette already ranks the new
entry. Read it once and the check fails intermittently, or compares the palette
against a stale list and reports a mismatch that is not there. `src/ai/usage.ts`
is the app's own ranking, and `scripts/ai-assistant-test.mjs` polls with
`waitForStoredUsage(id)` before comparing, instead of sleeping or trusting a
single read. The same rule applies to any test that checks a counter written
through `applySettingsPatch`.

**`close ... FAIL 1/3 checks` after `licence ... PASS`, while close alone passes**
The tell was the title `• Untitled — MDraft` instead of the requested fixture,
and a recovery entry beginning `# Bundled typefaces`. Raw bundled licenses can
contain CRLF; CodeMirror normalizes them to LF, so an unnormalized untitled
baseline marks an untouched Help document dirty. The next close test also used
to inherit the preceding layer's recovery instead of resetting owned state.
This looked like a native close/permission regression, but the new Cancel guard
was preserving a restored buffer. Normalize new-document baselines to LF and
keep `runCloseSuite` isolated with `resetAppState()`, after the harness backs up
user state. Keep the separate dirty-window P0 checks; never bypass the prompt
just to make clean-close tests pass.

**A CDP test that inspects "what is on screen" breaks when something scrolled first**
CodeMirror renders only the visible lines, so probes that read `.cm-line` or
token spans see whatever is in the viewport. Two suites failed this way in one
session: `syntax-theme-test.mjs` reported "italics exist" as FAIL because a
previous script had left the editor scrolled into a section without emphasis, and
`dom-smoke.mjs` reported "source scroll drives the preview" as FAIL on the second
run because it scrolled to 45% from a position that was already 45%. Both now
reset to a known baseline — scroll to the top — before measuring. **Any new probe
that reads the viewport must establish its own starting position.** A suite that
passes once and fails on re-run is usually this.

  The Typst preview suite hit a variant of this with a double-click: it scrolled
  the target *paragraph* into view, but a long `#lorem` paragraph is taller than
  the pane, so the word itself stayed off screen and the click selected nothing.
  Center the word's range in `#preview-pane` before dispatching the click.

**GitHub's Windows runner accepts "recieve"**
`spellcheck::windows_tests` asserted that the runner's English dictionary rejects
a particular misspelling, and the Windows image GitHub uses accepted it:
`recieve should be rejected, languages=["en"] bad=[]`. A dictionary's word list is
not this repository's to assert. Probe with a nonsense token (`zzqx`) and skip
when the dictionary flags nothing, the way the Portuguese test already skips when
its dictionary is absent; otherwise the release fails for the image's sake.

**`recent-menu` reports 12 of 27 rows once, then passes on a fresh relaunch**
The suite seeds 25 paths by calling `add_recent` directly without updating the
frontend's `settings` copy. A whole-settings save queued by the frontend can
overwrite those seeds before the final open refreshes the module copy, so the
store appears capped at 12. This is not the `MAX_RECENT`/menu-20 regression the
failure message suggests. Rerun against a freshly launched instance, or wait for
the app to settle before seeding; the passing run keeps all 27 paths and the
20-row menu.

**A CDP suite against an isolated identifier reports an empty state as non-empty and undo checks that fail in isolation**
`taskkill /PID <id>` without `/F` posts WM_CLOSE; a dirty test buffer opened the Save prompt, the process stayed alive, and the next `Start-Process` was forwarded by the single-instance plugin to that old window. The new run therefore inherited the previous document and the previous in-memory AI history while its own `--json/list` page answered normally. After closing a disposable test instance, confirm no process remains (and that `StartTime` changed before the next launch); force-kill and delete its appdata/profile when the close prompt blocks, then relaunch.

**`read-aloud` fails "it is enabled on a Markdown document" on a cold start and passes alone**
The suite right-clicked before the first preview render; availability is derived from the rendered preview, so `readAloudBlockedReason()` correctly said "There is nothing to read." while the pane was empty. Wait for `#preview` to have text before opening the menu. Do not chase a voice, menu or permission regression from this failure.

**`autoclose` reports `no tab is left dirty — 1 dirty` inside a full run and passes alone**
`clearTab()` in `autoclose-test.mjs` selects all and deletes, then retries once because "a slow re-render can swallow the first pair". Under the load of a 54-layer run both attempts can be swallowed, so the last scenario's tab stays non-empty and the final count sees one dirty tab. It is not the tag matcher, and the suite passes 33/33 standalone. Re-run the layer before investigating autoclose.

**A reverse-sync test passes although the PDF gesture did not change the source highlight**
A prior source selection can leave the same `.cm-sync-word` text painted, so comparing only the final word is a false positive. Clear the prior source mark, assert it is gone, then make the PDF selection and assert the browser's selected PDF text before checking the new source mark.

**`image-rules` reports `the absolute-path image renders in the preview` as its only failure when the test temp path contains `\.codex`**
The generated Markdown contained a Windows path such as `C:\Users\name\.codex\...`; `marked` treats `\.` as an escape and emits `name.codex` without that separator. This was a real image-path bug, not a worker timeout. New destinations escape backslashes and a conservative local fallback handles recognized legacy references; keep the real `.codex` regression when changing either path.

**`50/50 checks passed` in the HTML suite, then every new real guest double-click selects nothing**
The scripts-off preference probe leaves Preferences open; subsequent old checks
used programmatic events and passed through the modal. New CDP mouse events hit
the overlay, so this looked like a guest focus or IPC failure. Close
`.prefs-close` before mouse probes and measure both the actual guest selection
and source decoration. A programmatic click succeeding does not prove a real
pointer can reach the same target.
