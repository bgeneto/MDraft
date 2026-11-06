# Restore and verify word synchronization in multiline lists

**Status:** done

**Date:** 2026-11-06

**ADR:** none. The `Fragment` contract is unchanged — a fragment still maps one rendered run to one contiguous original range — and no responsibility moved to another layer. The Markdown walker gained a per-line translation frame of its own; the shared `src/source-map.ts` mapper needed no change, which is why no ADR was written.

## Context and goal

In Help → Markdown Reference, selecting or double-clicking words in the list below “How the delimiters are recognized” does not paint the corresponding words in the other pane. Clicking in the source instead briefly emphasizes the whole list. The preceding paragraph maps correctly.

This is reproducible in the pure renderer on `perf/preview-render-worker`: all seven items in that list produce no `data-f` fragments. A one-line list item does produce fragments, while a minimal item with an indented continuation line produces none. The same matching algorithm exists on `master`; this is not established as a regression introduced by the preview worker.

`marked` removes continuation indentation in a child token's `raw`, but `assignChildList` in `src/preview-render.ts` searches that normalized string as an exact substring of the parent's original `raw`. The lookup fails and the descendant offsets are not assigned, even for text on the first line of that item. Independently, `finishPreview` attaches a line anchor to the top-level `<ul>`, and the click handler blinks that entire block; this is the prominent wash visible in the report, not a successful word mapping.

The observed Markdown cause is not proof that other formats are safe. AsciiDoc converts parser line markers into block ranges (`src/asciidoc-preview.ts`); Typst Document heuristically matches rendered blocks to source (`src/typst-map.ts`). Both supply those ranges to the shared `src/source-map.ts` word mapper. Typst Pages uses a separate literal-source/PDF text-layer index (`src/typst-page-map.ts`, `src/typst-pdf.ts`). These are distinct failure paths, even though the user-facing symptom can be similar. A small in-memory probe of the shared alignment helper correctly maps sample AsciiDoc-like and Typst-like multiline list text, but does not exercise either renderer, actual block boundaries, selection events or Pages; it cannot establish end-to-end correctness.

The goal is exact, bidirectional word and selection synchronization for the reported list and supported equivalent multiline lists in Markdown, AsciiDoc and both Typst preview modes, including yellow feedback, without changing document rendering, source text or the responsiveness improvements already delivered.

## Scope and non-scope

- Cover continuation lines in unordered, ordered, task and nested Markdown lists, including lists in block quotes where the source-to-token relationship can be verified. Cover words on the first and continuation lines, selections within and across list items, and existing atomic inline code, formula and image behavior.
- Exercise supported unordered, ordered, nested and multiline lists in AsciiDoc and Typst Document and Pages, using each language's real syntax and rendering. Diagnose and fix reproduced list-specific failures in their mapping or the shared mapper; retain regression tests even when a case already works. Generated or ambiguous content must never map to an unrelated occurrence.
- Preserve the existing worker/fallback and live/export rendering contracts, sanitizer, HTML, line anchors, source contents, undo/redo, selection ownership, Escape and scroll behavior. Preserve UTF-16 offsets, CRLF/CR/LF and the existing placeholder and offset-index translations.
- Do not rewrite the built-in reference to avoid the bug, alter any markup dialect, add a dependency, change persisted settings or public Tauri commands, redesign all source mapping, virtualize lists, or change unrelated HTML mapping. Constructs that cannot be matched unambiguously must remain unmapped rather than point at an incorrect occurrence. If diagnosis reveals that an architectural replacement, dependency or public-contract change is necessary, amend this plan and obtain approval for that expanded scope before implementing it.
- The previously pending release decision is separate from this plan; do not merge or publish as part of this implementation without the relevant authorization and release checks.

## Approach and rejected alternatives

First add failing tests for the actual Help document and for minimal list items, and record the current output and performance baseline. Correct the Markdown token walker so that, when `marked` has removed verified list-container prefixes or indentation, positions in the normalized child can be translated monotonically back to positions in the prepared parent and then through the existing placeholder and line-ending translations to the original source. Restrict normalization to transformations that can be validated against the parent; preserve the current fail-safe behavior when the relation is ambiguous.

Independently reproduce representative lists through the actual AsciiDoc renderer, Typst Document and Typst Pages, checking both source-to-preview and preview-to-source with exact ranges. Distinguish failure to generate a block anchor, failure to align text within its source range, PDF text/geometry correspondence, and interference from the block blink. Apply the smallest verified fix in the responsible layer, including the shared mapper where appropriate; do not apply the Markdown `marked` solution to unrelated parsers. If a format passes the cases, retain those tests and avoid speculative code changes. Any shared change must be checked across all affected formats.

Prefer a sparse, line/segment-based mapping allocated only for affected list content. Preserve the `Fragment` contract that maps rendered text to its actual original UTF-16 range: when a text run crosses removed indentation, split it into source-contiguous runs at verified boundaries, or, if a sparse per-fragment translation is demonstrably necessary, explicitly update the plan and the directly affected consumers before implementing that alternative. Do not insert wrappers inside atomic code, formula or image fragments; preserve their complete source ranges. Compose the mapping through nested list levels and existing code/math placeholders without assuming a single constant offset for a multiline token. Ensure normal single-line tokens keep the cheap existing path.

Verify in the real UI whether the independent whole-block blink obscures the restored yellow selection. Preserve ordinary single-click block navigation and blink. If the block indicator interferes with an actual mapped word selection, clear or suppress only that conflicting indicator for the selection gesture, retaining the word pulse, reduced-motion behavior and existing click semantics; do not remove block navigation globally.

Rejected alternatives: changing the reference document alone (other documents remain broken); deleting all indentation before the parser or rewriting source (changes Markdown semantics and offsets); fuzzy/global text search or first-match fallback (can highlight the wrong repeated word or item); mapping every word or UTF-16 unit eagerly (unnecessary DOM/memory cost on large documents); using only the existing whole-list anchor (does not provide word correspondence); moving parsing back onto the UI thread or disabling sanitization (responsiveness and security regressions).

## Steps

- [x] Add a minimal multiline-list regression and a test using the actual `help.reference` document; demonstrate the missing/incorrect word ranges before the fix in both directions. Record which tests fail before implementation. — `scripts/preview-render-unit.mjs` reads `REFERENCE_LINES` out of `src/content.ts` and walks the reported list; run against the old walker it fails 19 of the new checks, including `the reference list maps a word from every line (5 words mapped)`. `scripts/word-sync-test.mjs` opens the built-in reference with `help.reference`.
- [x] Establish end-to-end baselines for supported multiline lists in AsciiDoc and Typst Document and Pages, both directions. Record passing and failing cases and isolate any failure to anchor creation, shared alignment, Pages mapping, or interaction; add failing regressions before each fix. — AsciiDoc and both Typst modes mapped multiline lists correctly already: the same fixture passes in `word-sync` and `typst:preview`, and `block-map-unit`/`typst-page-map-unit` now pin them. No production code changed for those formats.
- [x] Characterize `marked` token normalization for tight/loose, ordered, task, nested and block-quoted lists, tabs and continuation indentation. Define validated translation boundaries and fail-safe behavior before changing the walker. — the walker now accepts a child frame only when every content line is a verified suffix of its source line; the tab-expanded line stays unmapped and keeps its text.
- [x] Implement sparse source-offset translation and source-contiguous fragment handling in the Markdown worker-compatible renderer; compose correctly with placeholder and line-ending translations. Preserve the existing fast path for unaffected tokens and avoid repeated document-wide scans. — one `Lexed` frame per container, line segments only where `marked` dedented, `srcRuns` only for a token that actually crosses a removed indent.
- [x] Correct any reproduced list-specific AsciiDoc or Typst failures in the appropriate mapping layer, with shared-layer cross-format regressions. Do not change code for formats that pass the targeted scenarios. — none reproduced; regressions retained.
- [x] Verify whether the block blink competes with a mapped selection and, only if needed, adjust the selection gesture without changing ordinary click navigation, Escape or reduced motion. — measured in the real app: `sync-blink` on the `<ul>` and `.cm-sync-word` in the editor are present together, and the screenshot shows the amber source mark and the blue preview selection legible over the tint. No gesture changed. Two checks pin it.
- [x] Add unit, DOM/worker/fallback and real-app regressions for exact offsets, repeated words, formatting, atomic spans, multiline selections and lifecycle cancellation. Update the documented test counts in `AGENTS.md` if they change. — `preview:unit` 66 → 170, `preview:dom` 23 → 25, `block:map:unit` 12 → 22, `typst:map:unit` 21 → 35, `word-sync` 58/59 → 105, `typst:preview` 51/54 → 63; counts updated in `AGENTS.md`.
- [x] Compare before/after performance and memory on ordinary text, large paragraph documents and large lists; run the required Windows and Linux checks, document results and limitations, and complete the plan only when acceptance criteria pass. — see Results: Windows full suite and the three extreme runs are green, the WSL unit suites pass, and the unavailable Linux DOM/native interaction is recorded as a limit.

## Results

### Cause and fix

`marked` returns a `list_item` whose `raw` still contains the marker and every
continuation line's indentation, and whose `text` — the string its children were
lexed from — has both removed. `assignChildList` looked the child's `raw` up as an
exact substring of the parent's `raw`, so a multi-line item failed at the first
continuation line and the whole item, including its first line, produced no
`data-f` fragment. Block quotes had the same shape (`>` prefixes), which no test
covered.

`src/preview-render.ts` now carries a small `Lexed` frame instead of a bare
number: the text a container's descendants were lexed from, and — only when the
lexer rewrote the lines — one segment per line with the source offset of its first
character. A line is accepted only when it is a verified suffix of its source
line; a tab that `marked` expanded to spaces fails that check and stays unmapped
while the rest of the item keeps its offsets. A token that crosses a removed
indent is split into one source-contiguous run per line, because one `data-f`
span can only map one contiguous range. Everything else keeps the old constant
offset and one allocation-free frame (`segments: null`).

The `Fragment` contract, `src/source-map.ts`, the worker protocol, the sanitizer,
the line anchors and the export path are unchanged. No dependency, setting or
Tauri command was added. `src/content.ts` was not touched.

### Files changed

- `src/preview-render.ts`: the frame, validated per-line translation, source-run
  splitting of a text piece, `srcEnd` for atomic fragments, and the loose-task
  prefix shift.
- `scripts/preview-render-unit.mjs`, `scripts/block-map-unit.mjs`,
  `scripts/typst-page-map-unit.mjs`, `scripts/word-sync-test.mjs`,
  `scripts/typst-preview-test.mjs`: regressions.
- `docs/audits/list-word-sync-perf.mjs`: the before/after probe (one case per
  process so the sampled heap belongs to that document).
- `AGENTS.md`: test counts and six trap entries.

### Performance (same host, warmed, three runs per process)

`node docs/audits/list-word-sync-perf.mjs <case>`; median of three warmed runs.

| Document | Before | After | Fragments |
| --- | --- | --- | --- |
| 374 KiB prose (6,000 paragraphs) | 75 ms | 83 ms | 6,000 → 6,000 |
| 245 KiB list, single-line items | 161 ms | 144 ms | 30,000 → 30,000 |
| 368 KiB list, every item with a continuation line | 121 ms | 119 ms | **0 → 12,000** |
| 5.6 MiB, 72,000 CRLF paragraphs | 1,435 ms | 1,416 ms | 72,000 → 72,000 |

Run-to-run noise on this host is about ±10 %; none of the deltas is outside it
apart from the intended fragment count. Sampled heap was 56 → 97 MiB for the
multiline list (the 12,000 new fragment objects and their spans) and within noise
for the other cases. The real-input gate is green on the release binary in
`preview:perf`: 1.2 MB Markdown in-flight p50 1.8 / p95 2.8 / max 3.2 ms and
rapid input p95 4.8 ms, against the p95 ≤ 100 ms and max ≤ 150 ms budget; the
positive control still detects an intentional 350 ms block (p95 307 ms).

The approved extreme fixture (`npm test -- --only preview-extreme --no-build`) was
run three times on the release binary; all three passed 5/5:

| Run | 10.8 MB in-flight p50/p95/max | Rapid input p95/max | Final preview |
| --- | --- | --- | --- |
| 1 | 1.2 / 2.1 / 2.2 ms | 2.7 / 3.4 ms | 4,667 ms |
| 2 | 1.6 / 2.3 / 2.9 ms | 2.9 / 3.0 ms | 4,985 ms |
| 3 | 1.3 / 2.0 / 2.7 ms | 3.3 / 4.3 ms | 5,125 ms |

### Suite results

- **Windows, full `npm test`:** 52 of 54 layers passed, including `preview-unit`
  170/170, `preview-worker-unit` 18/18, `preview-dom` (23/23 in that run; 25/25
  standalone with the two new list checks), `word-sync` 105/105, `asciidoc` 54/54,
  `typst-preview` 63/63, and the export, PDF, typography, menu and tab layers.
- Two layers failed in that run and passed alone immediately afterwards:
  `autoclose` (`no tab is left dirty`) and `html` (a CDP request to the guest
  iframe that never answered). Both are recorded in AGENTS.md; neither touches the
  code changed here, and both are reproducible-only-under-load harness effects.
- **Debian/WSL2 (Node 24.13.1):** `preview-render-unit` 170/170,
  `block-map-unit` 22/22, `typst-page-map-unit` 35/35. The DOM suite and a native
  WebKitGTK run were **not** exercised: the shared `node_modules` was installed on
  Windows and Vite fails on Linux with `Cannot find native binding` (`@rolldown`
  has no Linux binding), and a native check would need a Linux build plus a
  display session. Recorded as a limit, not as a pass.

### Verified in the real application (Windows/WebView2)

- The built-in Markdown Reference: every one of the seven items carries fragments
  (`[7, 12, 13, 8, 12, 2, 4]` spans), and a double-click on `Tight` (first line),
  `numeric` (continuation), `Complete` (second continuation), `closer`,
  `preserving` and `survives` paints exactly that word on exactly its own source
  line.
- Markdown fixture: exact source offsets for first lines, continuation lines,
  ordered, task (tight and loose), nested and block-quoted items, the second
  occurrence of a repeated word (`delta`, 131 vs 39), a selection across items,
  and both directions.
- AsciiDoc and Typst Document: the same fixture, exact offsets and both
  directions. Typst Pages: a click in the PDF text layer paints the list word's
  own source line and the reverse paints the PDF text.
- Block blink: a single click still adds `sync-blink` to the list's `<ul>`; a
  double-click paints the word while the blink is still on. A screenshot taken
  during the blink shows the amber editor mark and the blue preview selection
  legible over the tint, so no gesture was changed.

### Limits and deviations

- **Linux interaction was not exercised.** The three pure suites pass under Debian
  (WSL2, Node 24), but the headless-Chromium DOM suite cannot start there against a
  `node_modules` installed on Windows (`Cannot find native binding` for
  `@rolldown`), and no native WebKitGTK window was driven in this session. The
  changed code is platform-independent string work with no DOM or timing
  dependency, but the Linux *interaction* part of the acceptance criteria is
  unverified rather than passed.
- **A tab-indented continuation line stays unmapped.** `marked` expands the tab to
  spaces, so the line cannot be located exactly; the first line of the item keeps
  its mapping and the tab line's text still renders. Pinned by a unit check.
- **A pre-existing rendering divergence was found and left alone.** The mapped
  text renderer escapes every `&`, so an entity the author typed renders one level
  deeper in Split than in Preview Only; it reproduces on the old walker and is
  recorded in AGENTS.md instead of being fixed inside this plan.
- **CRLF:** list lines are now exact per word (one fragment per line, so the
  mapping never crosses a `\r\n`), and a new list case asserts it. A non-list
  paragraph whose run spans a CRLF keeps its pre-existing single-run mapping.
- `typst-preview` reported three PDF pages once where the fixture is two; the same
  layer passed on the next run and in the full run. It is not reproducible and
  touches no code changed here, but it is recorded rather than forgotten.

## Files and modules

- `src/preview-render.ts`: token-position assignment, mapping composition and fragment boundaries; keep the pure pipeline usable by the worker and synchronous fallback.
- `src/source-map.ts`: fix a reproduced list-specific shared alignment or lookup defect if needed; preserve existing fragment and block behavior for other cases. If the fix requires a new mapping representation, update the plan and review its affected consumers before implementation.
- `src/asciidoc-preview.ts`, `src/asciidoc-render.ts`: investigate list markers, block ranges and renderer output; change only a diagnosed list-related cause.
- `src/typst-map.ts`, `src/typst-page-map.ts`, `src/typst-pdf.ts`: investigate Document block mapping and Pages' separate source/PDF correspondence; change only the responsible layer for a reproduced list failure.
- `src/main.ts`: only if a reproduced conflict requires a narrowly scoped interaction between block blink and actual word selection.
- `scripts/preview-render-unit.mjs`, `scripts/preview-dom-test.mjs`, `scripts/word-sync-test.mjs`: pure offsets, actual DOM/worker/fallback, and bidirectional real-app regressions. Add a separate fixture under `samples/` only if the actual built-in document cannot be exercised directly; if a new harness is added, register it in `AGENTS.md` and the appropriate runner.
- `scripts/block-map-unit.mjs`, `scripts/asciidoc-test.mjs`, `scripts/typst-page-map-unit.mjs`, `scripts/typst-preview-test.mjs`, and appropriate existing or new `samples/` fixtures: verify the shared block alignment and actual AsciiDoc and Typst Document/Pages behavior in both directions, with exact occurrence checks.
- `scripts/preview-performance-test.mjs` and/or a clearly identified probe under `docs/audits/`: before/after benchmarks only where existing probes do not cover large lists.
- `AGENTS.md`, this plan and the existing performance audit: test counts, measured results and any execution deviations. No change to `src/content.ts` is expected.

## Risks and rollback

An incorrect translation can silently select a different repeated word, cut a surrogate pair, swallow list markers or indentation, or point to the wrong position after CRLF, placeholders, entities or escapes. Nested normalization may compound these errors; AsciiDoc substitutions, Typst generated content, PDF ligatures and repeated list text add separate ambiguity. Validate actual source slices and DOM/PDF ranges, not merely the number of spans, and decline ambiguous mappings. Extra fragment splitting can increase DOM size, mapping time and memory; limit it to verified discontinuities and measure it. Changing blink behavior could alter click navigation or focus, so make any such adjustment conditional and cover single-click and double-click separately. Roll back the mapping/interaction change as an independent commit; no file or settings migration is involved.

## Tests and validation

1. Pure renderer: assert exact original source ranges and fragment order for the reported list, first and continuation lines, single-line controls, ordered/task/nested/loose lists, mixed indentation and tabs, lists inside block quotes, repeated identical words/items, punctuation, entities, escapes, emoji/combining characters and LF/CRLF/CR. Include code, formulas and images, line boundaries and selections crossing items. Check unmappable or ambiguous input never maps to a wrong occurrence. Test both `map: true` and `map: false` and compare rendered content against the existing output.
2. DOM and worker: test source → preview and preview → source ranges and actual selected text through the real worker and the forced fallback. Check sanitized HTML, no untrusted executable content, no unexpected export markup, and unchanged output/annotations when mapping is disabled.
3. Windows/WebView2 app: open the real reference with `help.reference`, select and double-click words on both lines of several items in both directions, including a repeated word and selection across items; assert the exact yellow range/source decoration rather than merely a nonempty highlight. Check pulse/resting mark, single-click block navigation, Escape, reduced motion, focus/scroll, edit invalidation and an obsolete or cancelled render. Run `npm test` and the affected sync, export and performance layers using the repository's profile backup/restore harness.
4. Debian/WSL2: build and run the relevant unit/DOM suites and a native WebKitGTK app check for the affected list and both directions where feasible. The DOM suite uses Chromium and is not a substitute for the native check; explicitly record any unavailable native interaction instead of marking it passed.
5. Performance: on the same host and toolchain, compare at least three warmed runs before/after for ordinary single-line content, the approved 10.8 MB/72,000-paragraph CRLF fixture, and a reproducible large multiline-list fixture. Record elapsed worker conversion, resulting fragment/DOM counts, peak or sampled memory where available, input p50/p95/p99/max during conversion, swap/layout and map construction, and time to the final correct preview. Confirm nonempty samples and the positive control. For the established Windows extreme paragraph fixture retain the approved p95 ≤ 100 ms and maximum ≤ 150 ms per run; do not claim those limits for a new large-list fixture without measurement. Investigate material regressions against the baseline and state any remaining limit explicitly.
6. Cross-format regression: test real AsciiDoc and Typst lists with first and continuation lines, repeated words/items, nested and ordered lists, inline formatting/code/math, Unicode and relevant line endings. Assert exact offsets and visible word selections in both directions; cover selection across list items, ambiguous/generated text, cancellation and stale renders. Test Typst Document and Pages separately, including PDF line breaks and text geometry. Use `block:map:unit`, `asciidoc`, `typst:map:unit`, `typst:preview` and the applicable real-app harnesses on Windows; run relevant native WebKitGTK checks on Debian/WSL2 where available. Record any skipped check and reason. Compare representative list rendering/map time, input latency and memory to a same-host baseline for each format whose code changes; do not invent budgets for formats lacking an established baseline.

## Acceptance criteria

- In the actual Markdown Reference, words on the first and continuation lines of the reported list synchronize in both directions, with the expected yellow word pulse/resting mark; multiword and cross-item selections identify the correct source and preview text.
- Equivalent verified multiline list cases map exactly, including repeated text and supported nested/ordered/task variants; ambiguous or unsupported cases do not paint a different occurrence. Ordinary single-click block navigation, Escape, focus, scroll and reduced motion remain correct.
- Supported representative multiline lists in AsciiDoc and Typst Document and Pages are exercised in both directions. Reproduced defects are fixed and covered by exact-range regressions; cases that already pass remain covered without speculative implementation changes. Any unsupported or inherently ambiguous mapping must fail safely and be explicitly recorded.
- Rendered content, sanitizer, export and source bytes are unchanged. Worker and fallback agree; no new dependency, persistent setting or public Tauri contract is introduced.
- The established Windows 10.8 MB performance gate passes in three valid runs, relevant Windows/Linux tests pass or have explicit limits, and any time, memory or fragment-count changes are reported with their measurements.

## Open questions

- None blocking. **Answered:** the block blink stays for ordinary clicks; it does
  not hide the word correspondence, measured in the running application, so no
  gesture changed.
- **Answered:** neither AsciiDoc nor either Typst mode had a related end-to-end
  list defect. Both were exercised in both directions and only gained regression
  tests.
- **Open, recorded:** native screen-reader traversal and full Linux desktop
  interaction; the WSL unit suites pass, the Linux DOM suite could not start
  against the Windows `node_modules`, and no native WebKitGTK window was driven.
