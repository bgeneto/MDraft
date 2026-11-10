# Preview and sync traps

The preview renderers, the source maps behind word sync, the PDF text layer and the measured cost of rendering.

Part of [the trap record](../traps.md). Search across every domain with:

```powershell
rg -n "<literal error text>" docs/agent-guide/traps
```

**A Typst Pages wheel over a column does not move the source when the pane is already at the page top**
`scrollInput` only remembered the pointer for the next scroll event. At the top both columns share the same `scrollTop`, so the test's column handoff produced no scroll event; the retained old column won and the source stayed one section behind (a 764px probe error). Trigger the preview sync from the wheel itself, and use a non-consuming `scrollAnchorsAt(reference, false)` for bookmark/refinement reads so a pending correction cannot steal a newer gesture's pointer. Do not diagnose the 764px as a matcher gap: the word was mapped and the region was simply not reselected.

**The Pages canvas reports an A4 aspect ratio of `2.0000`**
A newly created canvas has browser-default backing dimensions `300 × 150`,
which satisfy a naive `width > 0` readiness check before lazy PDF painting.
Scroll the relevant page into view and wait for actual PDF dimensions before
checking its aspect ratio; the default canvas does not prove a distorted PDF.

**Escape clears preview paint but leaves `.cm-sync-word` and collapses the source selection**
CodeMirror's default Escape keymap consumes the event before a bubbling document
listener can dismiss correspondence. Handle active correspondence in capture
phase and consume Escape only for the editor/preview target; preserve dialog
handlers and unrelated Escape gestures. Use real CDP key events with the editor
focused: dispatching a KeyboardEvent directly on `document` bypasses the keymap
and falsely passes this case.

**PDF text extraction contains `pen` / `dulum` although the page visibly shows `pen-` / `dulum`**
Typst's PDF ActualText can omit the layout hyphen. Requiring an extracted `-`
loses these words even with `disableNormalization: true`. Inspect text items
alongside the visible text layer; join otherwise unknown letter fragments only
when the complete literal source word exists and surrounding anchors validate
its occurrence. Zero-width text items can also carry combining marks and must
not be discarded solely because their measured width is zero.

**Typst list items are separated by a top-level `Space`, not by another node in the list**
The Lezer tree puts `Space "\n"` between sibling `ListItem`s. Treating every
non-list node as the end of the list produced one list per item, and the Markdown
renderer then joined them with blank lines. Ignore whitespace-only nodes while a
list is open (`space.trim() === "" && list && inline.length === 0`), and inspect
the tree before assuming the list is contiguous.

**A Typst paragraph beginning with inline formatting gets no `data-line`**
`blockText` joins descendant text nodes with spaces, so `<strong>Abstract</strong>—This`
folds to `abstract —this` while the source folds to `abstract—this`. The prefix
lookup fails and the whole block is skipped, which looked like a word-map bug
rather than a folding one. Normalize whitespace before em/en dashes in `fold`;
the Typst preview suite asserts that the abstract is anchored.

**`Property 'destroy' does not exist on type 'PDFDocumentProxy'` after adding PDF.js**
PDF.js 6 keeps destruction on the `PDFDocumentLoadingTask` returned by
`getDocument`, not on the document proxy, and `page.render` takes `canvas`, not
only `canvasContext`. Store the loading task and call `loadingTask.destroy()`;
pass `canvas: page.canvas` to the render task.

**Every PDF line appears twice when you query `.textLayer span`**
PDF.js wraps each text item in `<span class="markedContent">`, and the wrapper's
`textContent` repeats its inner span. A `querySelectorAll("span")` therefore
sees two copies of every line; the outer copy has a zero-size rect and a source
line map built from it selects the wrong line. Query
`span[role="presentation"]:not(.markedContent)` and group those by baseline.

**Pane sync: only scrolling may scroll**
The rule that survived review is that a click never moves the other pane, and
keyboard movement may reveal the caret's block only when it has actually left the
view. Getting there took two wrong versions, both shipped:

  1. A click in the **preview** scrolled the preview. The caret change travelled
     back through `onCursor` and yanked the clicked block to the top. It also
     made drag-selection impossible, because the text slid out from under the
     pointer mid-drag. Fixed with the `caretCameFromPreview` flag.
  2. A click in the **source** scrolled the preview, the same mistake in the other
     direction: `scrollPreviewToLine` always aligned the block to the top, even
     when it was already on screen. Fixed by splitting *follow* (always align, used
     by scroll sync) from *reveal* (only when off screen).

  "Reveal if off screen" is still not enough on its own, which is the part worth
  remembering: the rendered preview is roughly **twice as tall** as its markdown
  for a document with tables and diagrams, so a source line can be plainly visible
  in the left pane while its block sits far below the preview fold. Revealing it
  there throws the alignment away — the exact complaint. Hence `caretByPointer`:
  the pointer never scrolls, the keyboard may.

  Two functions now exist, `alignPreviewToLine` and `revealPreviewLine`, and
  confusing them is how this regresses. `revealCursorInPreview` after a re-render
  also has to respect `caretByPointer`, or a pending render reintroduces the jump
  through the back door.

**The HTML preview iframe loads but every Tauri command from it hangs instead of rejecting**
A sandboxed iframe with an opaque origin sends `Origin: null`; the IPC custom
protocol rejects that before ACL, and the postMessage fallback makes the frame's
URL the IPC source. WebView2 receives the message and the ACL rejects it, but
Tauri evaluates the response in the **main** frame, so the iframe's promise never
settles. Do not `await` an `invoke` from the guest in a test; race it with a
timeout and prove the command did nothing by checking its side effect (the suite
tries `write_document` to a temp path). The parent's own `invoke` still resolves.

**`http://<nonce>.mdraft-preview.localhost` is routed by wry but is local to Tauri**
The workaround recognises the host prefix `http://mdraft-preview.`, not a
subdomain before the protocol name, and Tauri's `is_local_url` strips
`.localhost` to `mdraft-preview`, which is a registered scheme. That makes the
guest a **local** ACL origin. Use `http://mdraft-preview.<nonce>.invalid`
(Windows) or `mdraft-preview://<nonce>.invalid` (elsewhere): wry still routes it,
and Tauri treats it as remote. Never "fix" a secure-context problem by switching
to `.localhost`.

**`allow-same-origin` on the HTML guest would make it same-origin with the app after navigation**
A sandboxed iframe with both `allow-scripts` and `allow-same-origin` can navigate
itself to the embedder's origin (its `document.referrer` names it), and then
reach `parent.document` and remove the sandbox. The guest is deliberately opaque;
local fonts and ES modules get CORS on the preview scheme instead. The preview
suite asserts `parent.document` throws.

**On Linux, the HTML preview shows linked CSS unstyled, images as alt text and classic scripts unrun**
The first Linux launch looked like a parser bug: only `<script type="module">`
reached the scheme handler. WebKitGTK requires a local stylesheet, image or
classic script loaded from this custom scheme to be a **CORS-mode** request; a
plain no-cors `<link>`, `<img>` or `<script src>` is dropped before any network
request, so the handler never sees it. Modules already are CORS-mode and an
inline `<style>` hides the CSS failure. The fix has two halves: the preview copy
adds `crossorigin="anonymous"` to **local** `link[rel=stylesheet]`, `script[src]`,
`img`, `source`, `video` and `audio` (never to CDN URLs, whose images may not send
CORS), and `allows_cors` answers static asset kinds even when `Sec-Fetch-Dest` is
absent. A `fetch()` still reports `Sec-Fetch-Dest: empty` and gets no header, and
`connect-src` blocks it. Verify with a screenshot, not with the DOM: the source
pane is correct either way.

**A selection made in the preview collapses about 100 ms after it is painted**
The editor still had focus, and CodeMirror writes its own selection back into the
DOM on the next update — the update the word-sync decoration dispatch causes.
Measured: `getSelection()` was `"Presidente"` at 0 and 40 ms, `""` at 100 ms,
while `.cm-sync-word` was already painted. A real mouse press in the preview
blurs the editor first, so this only appears when the selection is made by script
or by keyboard. `setSyncRange` now blurs the content element before dispatching.

**`.cm-sync-word` is absent even though the decoration exists in the editor state**
CodeMirror renders only the visible lines, so a decoration whose range is
off-screen has no DOM node at all; a test that selects a word near the end of a
long document and queries immediately reports a failure that is not one. Scroll
the editor to the target first. Also read **every** `.cm-sync-word` element: a
range that crosses lines is one element per line, so `querySelector` returns only
the first segment and a paragraph-sized selection looks truncated.

**Typing stutters in a large document although the editor buffer updates in 5 ms**
`scheduleRender` rebuilt the whole preview 200 ms after every edit, on the webview's main thread. Measured with a 1.2 MB Markdown file: `renderPreview` 656 ms, `preview.innerHTML` 26 ms, `bindPreviewWords`/`scrollTextAnchors` 118 ms, `doRender` ~1.03 s; keys pressed during that render waited **932 ms** (`event.timeStamp` to the update listener) and then appeared in a burst. A 223 KB file still took ~160 ms per render. It also rendered in **Source mode**, where the pane is hidden, and built the word map in every mode. Do not diagnose this from CPU or from CodeMirror: measure the key event's age and the `doRender` duration with `performance.now()`. The cheap fixes are to skip rendering in Source, keep the pre-worker quiet period (200 ms Markdown, 250 ms AsciiDoc, 300 ms HTML, 450 ms Typst), pass `map: true` only in Split, and build the word map only in Split. The structural fix now runs that pure half in `src/preview-worker.ts`
(see `docs/adr/2026-11-04-preview-render-worker.md`); the synchronous
`renderPreview` stays as the export path and as the fallback. AsciiDoc uses the
same pattern in `src/asciidoc-worker.ts`, with its includes pre-read on the main
thread; the two workers are separate so a Markdown session never downloads
Asciidoctor. The other measured cost is the caret blink: a focused editor with a
large document burns ~9% of a core in WebKitGTK compositing here, and
`cursorBlinkRate: 0` drops it to ~1%.

**After moving the Markdown preview to a worker, typing felt *worse*, and the release build showed why**
The first worker release still rebuilt the preview by **appending each 64 KB sanitized batch to the live pane**: a 223 KB Markdown file spent 190 ms in insertion (the old one-shot `innerHTML` was 26 ms), and the size-scaled quiet period added 289 ms before the render started. The worker itself was fine (`fallback=0`), and key events were not delayed; the *preview* was late. Build batches in a detached container and swap once, use a single sanitize/insert below 300 KB, and keep the pre-worker quiet period. Measured after the fix on the release binary: 223 KB insertion 19 ms, total render 196 ms, preview lag 308 ms (old ≈360 ms); 1.2 MB preview lag 887 ms with key p95 36 ms / max 95 ms (old input block 932 ms). Probe the release binary, not just the worker in Chromium.

**Every list item with a continuation line produced no `data-f` fragments, while the preceding paragraph mapped**
`marked` hands a `list_item` a `raw` that still contains the marker and the continuation indentation (`"- Tight ...\n  \`$5$\` ...\n"`) and a `text` with both removed (`"Tight ...\n\`$5$\` ..."`). `assignChildList` searched the *normalized* child `raw` as an exact substring of the parent's `raw`, so the lookup failed for the whole item — even text on the first line. The same holds for a block quote's `>` prefixes. Build a per-line frame (`suffixFrame`) that verifies each content line is a suffix of its source line, translate child offsets through it, and split a text run that crosses a removed indent into one source-contiguous piece per line: one `data-f` span cannot map a run that skips characters. A tab that `marked` expanded to spaces fails the suffix check and must stay unmapped for that line only. Two traps inside this one: a list item's `raw` keeps the trailing newline while `text` does not (drop trailing blank parent lines before comparing), and a loose task item's paragraph `raw` has the `[ ] ` prefix put back in front of text that no longer has it.

**Every table cell lost its fragments after the list walker was rewritten**
A `table_cell` token has `text` but **no `raw`**; the old code deliberately searched `cell.text` in the row's raw and passed that as the child frame. Routing cells through the general `place()` gave them an empty `raw`, so `assignChildList` searched an empty string and every cell text node rendered without a fragment. It surfaced as `word-sync ... FAIL "Analista" paints the same word in the source (inside a table cell: literal)`, which names neither the table nor the walker. Keep the cell branch using `cell.text` as the frame.

**A preview double-click paints nothing in `CSS.highlights` and the test calls the correspondence broken**
The two directions are not symmetric: preview → source paints `.cm-sync-word` in the editor and leaves the preview's own selection alone; only source → preview registers `mdraft-sync` / `mdraft-sync-peak`. Assert `[...document.querySelectorAll(".cm-sync-word")].map(n => n.textContent)` for a preview gesture and `CSS.highlights` for a source gesture. Checking the wrong one reads as "the word was not mapped" while the screenshot clearly shows it.

**The first double-click of a CDP suite lands before the word map exists**
`bindWordMapAsync` runs after paint, behind `WORD_MAP_DELAY_MS` and an idle callback, so a suite that waits only for the document's DOM can click a word before `wordMap` is published; `syncSourceFromPreview` then returns early and nothing paints. The second word usually works, which looks like "only the first selection is broken". Retry the gesture (2-3 attempts with a re-measure) instead of treating one silent click as a mapping failure.

**Typing `&amp;` in a document renders `&amp;` in Split but `&` in Preview Only**
The mapped text renderer escapes every `&` (`escapeHtml`), while `marked`'s own text renderer keeps an entity the author typed. Measured on the same input: mapped chunks carry `&amp;amp; &amp;copy;`, plain chunks carry `&amp; &copy;`. This predates the list work (it reproduces on the old walker) and is recorded here rather than fixed inside it, because the plan that found it explicitly forbade unrelated rendering changes. A test that compares mapped and plain output must decode entities until stable for such a case, and a future fix belongs in one place: render each piece through `Renderer.prototype.text` instead of the local `escapeHtml`.

**`CloseMainWindow()` returns `False` for a release copy, although the window is visible**
`Get-Process` reported the title `feature-tour.md - MDraft`, and the app had been
launched normally from the temp directory, yet `$p.CloseMainWindow()` returned
`False` twice and the process stayed alive. `taskkill /PID <pid>` **without**
`/F` posts WM_CLOSE and the app exits through its normal close handler, so the
window-state flush still runs. Use that when a harness needs a graceful exit
and `CloseMainWindow()` refuses; reserve `Stop-Process -Force` for the case where
the profile is already known to be disposable.

**A programmatic preview scroll right after `resetView()` moves nothing, and the next scroll event is already gone**
The pane sync intentionally suppresses corrections for `SYNC_SUPPRESS_MS` (150 ms)
after it writes a scroll offset. `resetView()` sets both panes to 0, the resulting
correction starts that window, and the test then waited only 120 ms before
setting `#preview-pane.scrollTop = 400`. The scroll event fired while
`suppressEditorScrollUntil` was still active, the queued correction returned
early, and no second event followed: the test reported
`{"preview":399.9999694824219,"source":0}` even though the sync was healthy.
Wait at least 250 ms after reset before a programmatic scroll, as
`word-sync-test.mjs` now does; the existing content-scroll suite uses the same
guard between probes.

**A raw `<div>` silently disables `data-line`, scroll sync and click reveal for the whole document**
`marked` emits a raw HTML block that contains Markdown as separate tokens: the
opening tag, the paragraph and the closing tag. `finishPreview` zipped the
non-silent token line list against `host.children`, so a three-token div that
parsed as one element made the counts disagree and every anchor was dropped. In
`docs/samples/SEI_15117522_Memorando_Circular_00035_2026.md` that was 77 token
lines against 73 elements; `renderPreviewInto(...).linesMapped` became `false`,
`#preview [data-line]` was 0, and `editor.onScroll` returned early for the whole
file (the console note is `[sync] positional pane sync is unavailable for this
document; scrolling stays independent`). The same function also held the only
line anchors used by preview-click reveal and the block blink. Do not diagnose
this as a scroll solver bug or a missing word map: inspect
`document.querySelectorAll('#preview [data-line]').length` and compare
`host.children.length` with the token count first. Raw HTML text has no `data-f`
either, so a table cell word maps in neither direction; and `pointForSource`
snaps an offset before the next fragment to that fragment's start, which paints
the paragraph after the table. The durable fix is in
`docs/adr/2026-11-10-raw-html-sync.md`: derive `elementLines` from the rendered
tree when raw HTML crosses tokens, treat visible raw HTML text as fragments, and
only snap a fragment gap within the same source line.
