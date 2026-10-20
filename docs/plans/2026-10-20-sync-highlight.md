# Sync highlight contrast, and word tracking for HTML and Typst Pages

**Status:** done
**Date:** 2026-10-20
**ADR:** `../adr/2026-10-20-sync-highlight-color.md` and `../adr/2026-10-20-html-word-sync.md`, both new, written in step 1. The second adds a "Superseded in part by" pointer to the HTML exclusion in `../adr/2026-10-18-word-level-sync.md` and does not rewrite that decision.

## Context and goal

Clicking or selecting in the preview paints the corresponding source range with `.cm-sync-word`. On a light editor that mark is a clear yellow. On a dark editor it is a dull olive or brown, easy to miss against syntax-coloured text. The three reports are the same bug:

- Light, Paper: `rgba(255, 193, 7, 0.30)` on `#ffffff` blends to about `#ffecb5`. Visible.
- Dark, Ink (`#1e1e1e`): `rgba(255, 213, 79, 0.24)` blends to about `rgb(84, 74, 42)`. A faint brown under blue tokens.
- Dark, Solarized (`#002b36`): the same wash blends to about `rgb(61, 84, 60)`. The teal's green channel wins, so the "yellow" is olive. This is the third screenshot.

The colour is `--word-sync` on `:root` / `[data-theme="dark"]`. That follows the application chrome, not the editor surface. A syntax palette owns the writing surface and can disagree with the chrome (Solarized Dark while the app is light, or the reverse). Alpha-blending a yellow onto teal cannot stay yellow.

The mark already persists until Escape or an edit. It does not fade. On a dark surface it is so faint that it looks as if it had gone. The reader wants it to pulse about four times on arrival, then stay — not to be removed when the pulse ends.

That paint has to be the same wherever a preview gesture already calls `editor.setSyncRange`: Markdown, AsciiDoc, Typst Document, and Typst Pages. HTML never calls it. A click in the guest only reveals the source line and blinks the block. Making the new behaviour equal for HTML means giving the guest a word position, not a second highlighter.

Typst Pages and HTML are the two formats whose positions are not exact. Both can be tightened with what the current pipeline already has. Neither needs a new dependency, a second compiler, or work on the keystroke path.

## Scope and non-scope

In scope:

- A resting highlight that stays amber on every syntax surface, and a pulse of four beats of 500 ms — two seconds — that ends on that resting colour. The decoration is not cleared when the pulse ends.
- The same pulse and colour for every format that paints a source range, including a Typst Pages paragraph and, once mapped, an HTML word.
- The preview's `::highlight(mdraft-sync)` pulses with the same four 500 ms beats. It is a second highlight name toggled from the host, not a CSS animation on the pseudo-element, because animation support there differs between WebView2 and WebKitGTK.
- HTML preview → source at word granularity, from the parse5 locations the preview walk already records, reported by the bridge. A mismatch paints nothing for the word and keeps today's line reveal.
- Typst Pages: a one-word line no longer maps to the nearest occurrence, and PDF ligatures / soft hyphens fold before the match. A window that is not unique still paints nothing.
- A stronger dark `--word-sync` for the preview's `::highlight(mdraft-sync)`, which is the grey wash in the first screenshot. No pulse on that highlight.
- Unit checks for the Typst rule and the HTML offset rule, and CDP checks that the mark is visible and still there after the pulse.

Out of scope:

- The block blink (`.sync-blink`, `.mdraft-blink`). It is a different pointer: it fades on purpose, and `dom-smoke` / `html-preview-test` assert that it leaves nothing behind. Do not make it persist, and do not reuse it as the word mark.
- A preference, a menu item, or a status chip for the pulse or the colour. Four beats is the behaviour; reduced motion skips the motion and shows the resting colour immediately.
- Embedding the Typst compiler, or `typst.ts`. The previous measurement still holds: about +50 MB for the crate, about 13.7 MB compressed for the WASM pipeline, and a second compiler. The CLI PDF still has no source spans.
- Source → Typst Pages highlighting, and source → HTML-guest highlighting. Both are the other direction. The source mark is the one the screenshots judge.
- Changing what a gesture selects. A single click still reveals the line (and, on Typst Pages, still paints the paragraph). A double-click or a drag still paints the word. HTML gains the word paint on double-click and drag only, so it matches Markdown rather than inventing a single-click word mark.
- Markdown, AsciiDoc, and Typst Document mapping. Those emitters are unchanged. Generated Typst text (`#lorem`, a `#let` value) still paints nothing.
- Any `#[tauri::command]`, `settings.json` field, or menu payload.

## Approach and rejected alternatives

### Colour: the palette owns the band, and the band is opaque

`buildChromeTheme` sets `--editor-sync` and `--editor-sync-peak` on the editor root from two new fields on `SyntaxPalette`. `.cm-sync-word` reads those variables. The stylesheet owns `background-color`; the theme does not also set it, so the animation and the resting colour have one owner.

The colours are opaque. Alpha is what turned Solarized's yellow into olive: `rgba(255, 213, 79, 0.24)` on `#002b36` is `rgb(61, 84, 60)`. An opaque gold cannot be pulled green by the surface underneath.

Each dark palette gets a gold that satisfies all of these, tuned by a screenshot rather than by the hex in this plan:

- Amber, not olive: in the computed colour, R > G > B.
- Obvious against the surface: the red channel is at least 70 above the surface's red. That is the difference the Ink screenshot lacks in practice once syntax colour sits on top of a low wash, and it is large enough to see at a glance.
- The palette's `text` colour stays readable on the resting band (contrast at least 3:1). This is a locator, not body text. If a candidate fails, darken the band; do not lighten it until the text goes.
- The peak is lighter than the rest and is used only by the animation. A Typst Pages single click paints a whole paragraph, so the resting band must not be a highlighter pen.

Light palettes stay close to today's `#ffecb5` blend. That screenshot is the one that already works; the peak only needs to be distinguishable from the rest.

First candidates, to be replaced if a screenshot disagrees:

| Palette | Surface | Rest | Peak |
| --- | --- | --- | --- |
| paper, github-light | `#ffffff` | `#ffe08a` | `#ffc107` |
| solarized-light | `#fdf6e3` | `#f3d36b` | `#e6b422` |
| ink | `#1e1e1e` | `#7a5c10` | `#c49214` |
| github-dark | `#0d1117` | `#7a5e12` | `#c49214` |
| one-dark | `#282c34` | `#7a5e14` | `#c4921a` |
| solarized-dark | `#002b36` | `#6e5610` | `#c49a1a` |
| nord | `#2e3440` | `#6e5820` | `#c4a35a` |

The preview does not use a syntax palette. Its surface is `--bg`. Raise the dark `--word-sync` to about `rgba(255, 196, 0, 0.42)`, which blends to roughly `rgb(132, 105, 17)` on `#1e1e1e` instead of `rgb(84, 74, 42)`. Add `--word-sync-peak` for the pulsing name. Leave the light value, or nudge it only if the peak on the source makes the preview look abandoned.

### Pulse: four 500 ms beats, ending on the resting colour

```css
@keyframes sync-word-pulse {
  0%, 100% { background-color: var(--editor-sync, var(--word-sync)); }
  40%      { background-color: var(--editor-sync-peak, var(--word-sync)); }
}
.cm-sync-word {
  background-color: var(--editor-sync, var(--word-sync));
  border-radius: 2px;
  animation: sync-word-pulse 500ms ease-in-out 4;
}
```

Four beats of 500 ms — two seconds. The element's own `background-color` is the resting colour, so when the animation ends the mark is still there. There is no timer that removes the class or calls `clearSyncRange`. That timer is the bug this plan exists not to write.

`prefers-reduced-motion: reduce` sets `animation: none`. The mark is painted immediately at the resting colour.

A second gesture on the same range must pulse again. `syncSourceFromPreview` and `syncSourceFromPageSelection` return early when the range is unchanged, so they never reach `setSyncRange`, and CodeMirror will not recreate the element. Add `pulseSyncRange()` that only restarts the animation: set `animation` to `none`, read `offsetWidth`, clear the inline style. Call it from `setSyncRange` and from those two early returns. Skip the restart when reduced motion is set, or the inline style puts the animation back.

Escape, a document change, and a collapsed selection keep clearing the decoration, exactly as they do now.

The preview highlight does not use a CSS animation on `::highlight()`. The host registers the same `Range` under one of two names, `mdraft-sync` (resting) and `mdraft-sync-peak`, and swaps which name is active every 250 ms for 2 s — four full 500 ms beats — then leaves `mdraft-sync` registered. Eight registry writes, no DOM mutation, no layout. The timer is cancelled when the selection changes, collapses, is cleared, or a render replaces the map. A second identical selection restarts the timer without rebuilding the `Range`.

### HTML: the host already has the offsets

`buildHtmlPreview` parses with `sourceCodeLocationInfo` and splices `data-mdraft-line` onto block tags. It does not reserialise, and it must not start. parse5's text nodes carry `startOffset` / `endOffset` into the original source. The guest is an opaque iframe, so the host cannot read the selection; the bridge already posts clicks.

On each stamped element, also splice `data-mdraft-n="N"` (a monotonic id, preview copy only, same insertion path as the line attribute). While walking, record a host-side table: for each text node under that element, `{ n, index, src0, src1, decoded }`. `decoded` is what the browser's text node will contain (`&amp;` is `&`). The table is rebuilt when the preview is rebuilt, inside the walk that already runs. It is not sent to the guest.

The bridge, on double-click and on a settled drag, posts `{ type: "select", n, index, start, end, sample }` where `index` is the text-node index under the closest `[data-mdraft-n]`, and `start`/`end` are offsets in that text node's data. Debounce the drag the way Typst Pages already does (about 120 ms). A selection longer than a couple of thousand characters falls back to the line post; it is not a word request.

The host translates `(n, index, start, end)` through the table to a source range and calls `setSyncRange`. Before trusting the offset, the recorded `decoded` slice must equal `sample`. A script that rewrote the DOM, or a parser repair that split the text node differently, fails that check: no word mark, the existing line reveal still runs. A missing `data-mdraft-n` is the same fallback. Do not search the source for the selected word. A repeated word would mark the wrong one, which is the failure the Typst Pages map already refused.

`td` / `th` are not block tags. The closest stamp is the `tr` (or the `table`). The text-node index within that element still distinguishes the cells. No new tag list.

A single click keeps `handleHtmlLine`: reveal the line, blink the guest block, no word mark. That is what Markdown does.

### Typst Pages: stop guessing the one-word line

`mapLine` matches a 2- to 4-word window exactly, and that path stays. A one-word line currently picks the nearest occurrence of that word to the caret. A repeated heading, or the same word in the other column, is then marked wrong. The rule in the Typst ADR is that a missing mark is acceptable and a wrong mark is not. The nearest-word fallback breaks it.

`TypstPageContext` gains the previous and next visual line texts. Those lines are already indexed in `typst-pdf.ts`. The one-word case builds a window from the neighbours (last two words before, the word, first two after) and looks that window up in the sequence index that already exists. One candidate: use it. More than one, or none: paint nothing. The caret hint must not break that tie. The lookup runs on the click, not on the render.

Fold only the match key, not the returned offsets. Extend `normalize` so both sides agree on what PDF.js actually emits: strip `\u00ad`, and expand `ﬁ`/`ﬂ`/`ﬃ`/`ﬄ` to `fi`/`fl`/`ffi`/`ffl` before tokenising. Curly quotes and dashes are not word characters today, so they already do not affect the key. Do not skip `#ident` in the index in this change. That is a parser, and the neighbour window is the fix for a short line landing inside markup. A generated line still has no window and still paints nothing.

## Rejected alternatives

- **A stronger alpha on `--word-sync`, shared by every dark theme.** Measured: 24% yellow on `#002b36` is olive, and a higher alpha still mixes the teal's green into the band (`rgba(255, 196, 0, 0.45)` on that surface is about `rgb(115, 112, 30)`, R almost equal to G). Opaque and per-palette is what keeps Solarized gold. The same variable also cannot follow a syntax theme that disagrees with the chrome.
- **A CSS `box-shadow` or underline so the colour matters less.** The selection background already taught this: a decoration measured from the line box paints into the gutter margin, and an underline reads as a spelling error. Background colour is the mark the screenshots are judging.
- **Pulsing `::highlight(mdraft-sync)` as well.** The highlight pseudo-element's animation support differs between WebView2 and WebKitGTK. The source mark is a real element. The preview wash gets a stronger colour and no animation.
- **Injecting `<span data-f>` into the HTML preview.** That is the user's document. It changes selectors, layout, and the "never reserialise" rule `buildHtmlPreview` exists to protect. The guest reports an index; the host holds the offsets.
- **Searching the HTML source for the selected word.** Exact for a unique word, wrong for a repeated one. The line attribute is not a column. The parse5 offset is already there.
- **Embedding Typst, or compiling HTML beside the PDF to steal spans.** Size, a second compile on the render path, and the HTML layout is not the page. The text-layer heuristic stays; this plan only removes the branch that guesses.
- **Using the caret hint to pick among one-word candidates.** That is the current bug. Proximity is how a repeated word in the other column wins.
- **A timer that removes `.cm-sync-word` after four blinks.** The reader asked for the opposite. The block blink already fades, and it is the wrong element.

## Steps

- [x] 1. Write the two ADRs. Colour: the source mark's colour comes from the syntax palette, as an opaque band, not from `[data-theme]`. HTML: word positions are a host-side table from the parse5 locations the preview walk already has; the guest reports a text-node index and a sample; a mismatch paints nothing. Add the superseded-in-part pointer to `docs/adr/2026-10-18-word-level-sync.md` without rewriting its decision.
- [x] 2. Add `sync` and `syncPeak` to `SyntaxPalette` and to all eight palettes. `buildChromeTheme` publishes them as `--editor-sync` and `--editor-sync-peak` on the editor root and does not set `.cm-sync-word`'s background itself.
- [x] 3. In `styles.css`, point `.cm-sync-word` at those variables, add the four 500 ms beats, and honour `prefers-reduced-motion`. Raise the dark `--word-sync` and add `--word-sync-peak` used by `::highlight(mdraft-sync)` / `::highlight(mdraft-sync-peak)`. Do not touch `.sync-blink`.
- [x] 4. `editor.pulseSyncRange()` restarts the animation without dispatching a range change, and skips itself under reduced motion. Call it from `setSyncRange` and from the unchanged-range returns in `syncSourceFromPreview` and `syncSourceFromPageSelection`. In `main.ts`, alternate the preview highlight name every 250 ms for 2 s and leave the resting name registered.
- [x] 5. HTML table and bridge. Splice `data-mdraft-n`, record decoded text-node ranges in the existing walk, post `select` from double-click and settled drag, map it in the host, fail closed on a sample mismatch. Single click stays `handleHtmlLine`.
- [x] 6. Typst Pages. Pass the neighbour line texts on `TypstPageContext`. One-word lines match that window or paint nothing. Fold soft hyphens and ligatures in the match key only.
- [x] 7. Tests, counts, and the script index. See below. Update the quoted counts in `AGENTS.md` and the script headers in the same change.

## Files and modules

- `src/syntax-themes.ts` — the two colours per palette, and the variables on the editor root. The surface is the only place that knows whether the band is being painted on white, teal, or `#1e1e1e`.
- `src/styles.css` — the pulse, the reduced-motion rule, the darker preview wash. One owner for `.cm-sync-word`'s background.
- `src/editor.ts` — `pulseSyncRange`. Restarting has to live next to `setSyncRange`, which is the only code that knows the decoration DOM.
- `src/main.ts` — call the pulse on an unchanged range; handle the HTML `select` message; pass neighbour lines into the Typst page map.
- `src/html-preview.ts` — the id attribute, the table, the new callback. The walk is already the parse.
- `src/html-bridge.js` — double-click and drag report. Inlined with `?raw`, so a frontend build picks it up; there is no separate guest bundle.
- `src/typst-pdf.ts` — neighbour line texts on the context. The lines are already indexed here.
- `src/typst-page-map.ts` — unique-window rule and the fold. No new index.
- `scripts/typst-page-map-unit.mjs` — new. The module has no imports, so Node runs it the way `sessions-test.mjs` runs `sessions.ts`.
- `scripts/html-source-map-unit.mjs` — new, if the offset rule is a pure function. It should be: the DOM walk and the parse stay in `html-preview.ts`, the "sample must match, then this source range" rule does not need either.
- `scripts/word-sync-test.mjs`, `scripts/syntax-theme-test.mjs`, `scripts/html-preview-test.mjs`, `scripts/typst-preview-test.mjs` — the measurements below.
- `scripts/test-all.mjs`, `package.json`, `AGENTS.md` — the new unit layers and the counts. A new script that is not listed will be rewritten.
- `docs/adr/2026-10-20-sync-highlight-color.md`, `docs/adr/2026-10-20-html-word-sync.md`, and the pointer on the 2026-10-18 word-sync ADR.

No Rust, no `src/api.ts`, no `settings.json`, no new npm or cargo dependency.

## Risks and rollback

- A resting gold that is too bright makes a Typst Pages paragraph look selected. The 3:1 text rule and the "darken, don't lighten" rule are there for that. Check a paragraph click on Ink and on Solarized Dark, not only a one-word double-click.
- Swapping the preview highlight name every 250 ms must not leave the peak name registered after the pulse. A stale timer that fires after a selection was cleared would repaint a highlight the reader dismissed. The timer is cleared with `clearPreviewWords`, `bindPreviewWords`, and every new selection; the final swap must be the resting name.
- `pulseSyncRange` writing an inline `animation` and failing to clear it would freeze the mark on the peak colour. The restart must clear the inline style, and the reduced-motion path must not set it.
- An HTML sample check that is too strict (whitespace the browser folded, a different entity decoding) makes every word miss, and the feature looks absent. Decode entities the way the browser does, compare the text node's data rather than `textContent` of the element, and cover `&amp;` plus a normal space in the unit test. A miss still reveals the line, so the failure is the old behaviour, not a wrong word.
- `data-mdraft-n` on the preview copy must not be written back to the file. It is spliced the same way as `data-mdraft-line`, which is already preview-only.
- The one-word Typst change will make some headings that used to mark the wrong place mark nothing. That is the intended direction. A heading whose neighbours make a unique window still marks.
- Rollback is reverting the branch. There is no setting to flip, and no persisted file changes shape.

## Tests and validation

Cheapest layer that can fail the change, then the UI suites that already own these gestures. Not the whole `npm test`.

- `npm run build` — the palette fields and the new editor method typecheck.
- New `scripts/typst-page-map-unit.mjs`, wired as a `kind: "node"` layer next to the other unit scripts. Pins: a repeated one-word line with two identical neighbours paints nothing; the same line with a unique neighbour window paints that occurrence; `ﬁ` in the PDF line matches `fi` in the source; a `#lorem` line still matches nothing. No application.
- New `scripts/html-source-map-unit.mjs` for the pure offset rule. Pins: `&amp;` selects the decoded character and returns the source offset of `b` in `a &amp; b`, not an offset inside the entity; a sample that does not equal the recorded text returns null; two text nodes under one stamp keep their own indexes.
- `npm run syntax` — after each dark palette, `--editor-sync` computed on `.cm-editor` has R > G > B and red at least 70 above the surface. This is the measurement the Solarized screenshot fails today (`rgb(61, 84, 60)`, G > R). No click required.
- `npm run word-sync` — the mark's text is unchanged, and two new checks: `animation-duration` is `0.5s` and `animation-iteration-count` is `4`; 2.3 s later `.cm-sync-word` is still there and its background is the resting colour, not transparent. `Emulation.setEmulatedMedia` with `prefers-reduced-motion: reduce` makes `animation-name` `none` and leaves the mark painted. Escape still clears it (the existing check).
- `npm run html` — a double-click on a word in the guest paints that word in `.cm-sync-word`, not the whole line. A single click still blinks the block and still clears that blink. The existing "blink clears itself" check stays. The suite also asserts the guest selection, the presence of the word ids, and that both the guest point and the page point land on the intended element; those four diagnostics are what turned a silent miss into a legible failure.
- `npm run typst:preview` — the existing word and column checks, plus a one-word heading that must map its own source line. Query `.cm-sync-word` after scrolling the editor to the target, or the decoration has no DOM node.
- `npm run asciidoc` — no new checks. Run it because it reads `.cm-sync-word` immediately; the mark has to exist before the animation finishes, which it does if the background is not delayed.

Skipped: Rust, sessions, paste, export, the full `npm test`. Say so in the report. Update the quoted counts for every suite whose check count changed, and for the new unit scripts in the testing table and in Repository scripts.

## Acceptance criteria

- On Ink and on Solarized Dark, a preview double-click paints a source mark whose computed background has R > G > B and whose red channel is at least 70 above the editor surface. The Solarized mark is not green.
- The mark pulses four times of 500 ms — two seconds — and is still painted 2.3 s later, at the resting colour. The preview highlight pulses with it and ends on `mdraft-sync`. Escape removes both. With reduced motion there is no animation and the resting marks are there immediately.
- The same mark, same pulse, appears for a Markdown word, an AsciiDoc word, a Typst Document word, a Typst Pages word, and an HTML word. A Typst Pages paragraph click pulses the paragraph and leaves it painted.
- An HTML double-click on the second `world` in a paragraph paints that occurrence, not the first. A guest whose text no longer matches the table paints no word and still reveals the line.
- A one-word Typst Pages line whose text occurs twice, with the same neighbours, paints nothing. The same line with a unique neighbour window paints that occurrence. `#lorem` still paints nothing.
- No new dependency. Nothing on the keystroke or render path beyond the table built inside the HTML walk that already runs, and the Typst lookup that already runs on click.
- `.sync-blink` still clears itself. `dom-smoke`'s blink checks pass unchanged.

## Open questions

- None. The preview-side wash pulses as well, through the two-name swap; the pulse is four beats of 500 ms; neither is a setting.

## Deviations

- `HtmlSelection` and `HtmlTextFragment` live in `src/html-source-map.ts` and are re-exported by `html-preview.ts`. The DOM walk and the parse stay in the preview controller; the offset rule is pure and testable without an iframe.
- The Typst Pages CDP check uses the one-word heading "Method". Identical-neighbour ambiguity is pinned in `typst-page-map-unit.mjs` instead of adding two identical paragraphs to `samples/typst-pages.typ`, which would have created a third page and broken the two-page checks.
- `html-preview-test.mjs` grew to 50 checks rather than 45: the two word checks plus four permanent diagnostics (guest selection, word-id count, guest hit, page hit). A silent miss needs a legible failure; the first attempt only reported an empty mark.
- `word-sync-test.mjs` reads either registered preview highlight name. The pulse swaps `mdraft-sync` for `mdraft-sync-peak` every 250 ms, so a probe that reads only the resting name sees `null` through no fault of the feature.
