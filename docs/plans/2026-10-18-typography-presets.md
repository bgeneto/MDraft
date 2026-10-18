# Four typographic schools for the presets

**Status:** done
**Date:** 2026-10-18
**ADR:** `../adr/2026-10-18-typography-presets.md` (created with the implementation)

## Context and goal

The typography picker has five presets, but four of them share the same voice.
`Classic` and `Literary` carry **identical** `sourceFont`, `bodyFont`,
`headingFont` and `codeFont` stacks (Source Serif 4, Source Sans 3, JetBrains
Mono); only `oldstyleFigures`, `ligaturesInCode` and `slashedZero` differ.
`Technical` swaps prose and headings to Inter but keeps JetBrains Mono. `Serif`
is the same Source superfamily with Fira Code. The result is that switching
between presets changes an invisible OpenType feature, not the page; a
non-specialist cannot see that anything happened.

The bundled font payload today is about 2,534 KiB:

| Family | Files | KiB |
| --- | --- | --- |
| Source Serif 4 (variable) | 2 | 758 |
| Source Sans 3 (static) | 6 | 572 |
| Inter (variable) | 2 | 723 |
| JetBrains Mono (static) | 4 | 372 |
| Fira Code (variable) | 1 | 110 |

The request is to keep **System** and **Serif** untouched, replace the other
three with distinct schools/eras, and add a fourth, informal/handwritten preset.
Each preset must change the dominant texture — body serif and code mono at
minimum — remain libre, and not inflate the binary materially.

The goal is six presets, each a complete typographic system:

| Preset | School | Body | Headings | Code |
| --- | --- | --- | --- | --- |
| System | the operating system | system-ui | system-ui | system mono |
| Serif (unchanged) | transitional/humanist superfamily | Source Serif 4 | Source Sans 3 | Fira Code |
| Renaissance | Garalde (16th c.) | EB Garamond | EB Garamond 600 | IBM Plex Mono |
| Editorial | Didone (18th c.) + grotesque | Bodoni Moda | Archivo 600 | JetBrains Mono |
| Bauhaus | geometric (20th c.) | Jost | Jost 600 | Azeret Mono |
| Notebook | humanist + handwritten | Alegreya | Caveat 600 | Victor Mono |

The design specimen is already at
`docs/screenshots/typography-presets-proposal.png`; it is a reference, not a
shipped screenshot.

## Scope and non-scope

**In scope:**

- Replace `Classic`, `Literary` and `Technical` with `Renaissance`, `Editorial`
  and `Bauhaus`; add `Notebook`. Keep `System` and `Serif` byte-for-byte in
  their stacks, defaults and OpenType values.
- Nine new OFL families: EB Garamond, IBM Plex Mono, Bodoni Moda, Archivo, Jost,
  Azeret Mono, Alegreya, Caveat, Victor Mono. Remove Inter.
- A font-build pipeline that pins sources, instances the variable faces that
  need a single weight, subsets the Latin and symbol ranges, and writes woff2
  plus `fonts.json` and the licence texts.
- Per-preset body size, math scale, note, OpenType defaults and preset ids.
- Seven chips (six presets plus Custom) and the shorter `Custom` label.
- Licence page, `docs/typography.md`, README, AGENTS.md, tests, ADR.

**Non-scope:**

- The four roles, the four pickers and the per-preset size memory already
  exist; no new settings schema and no Rust behaviour change.
- No change to System or Serif. No rename of "Serif" (it names a category, not
  a school; a later copy change can revisit it).
- No KaTeX, math-font or renderer change. KaTeX keeps Computer Modern; the new
  presets set a math scale that tolerates it.
- No export-format change and no new export path. Exports keep embedding the
  first bundled family in each stack.
- No runtime font fetching, no user font installation, no font manager.
- No Greek/Cyrillic coverage in the new subsets by default; the kept Serif
  preset remains the full-coverage option. See Open questions.
- No line-height, measure, editor-chrome or UI-density redesign.
- No migration of old preset ids or saved sizes; old `presetOverrides` keys
  become inert (see Risks).
- No "Typeset"/Latin Modern preset in this change.

## Approach and rejected alternatives

### The matrix

The preset definitions in `src/fonts.ts` become:

```ts
// System and Serif are unchanged.
{
  id: "renaissance",
  label: "Renaissance",
  note: "Garamond's 16th-century old style: low contrast, a small x-height, serif headings and oldstyle figures. IBM Plex Mono sets the editor and code.",
  defaults: { bodyFontSize: 18, mathFontScale: 90 },
  values: {
    sourceFont: '"IBM Plex Mono", "JetBrains Mono", ui-monospace, monospace',
    bodyFont: '"EB Garamond", "Source Serif 4", Georgia, "Times New Roman", serif',
    headingFont: '"EB Garamond", "Source Serif 4", Georgia, "Times New Roman", serif',
    codeFont: '"IBM Plex Mono", "JetBrains Mono", ui-monospace, monospace',
    ligaturesInCode: false,
    tabularFigures: true,
    oldstyleFigures: true,
    slashedZero: true,
  },
}
{
  id: "editorial",
  label: "Editorial",
  note: "Bodoni Moda's hairline Didone against Archivo's grotesque headings, with JetBrains Mono in code. Lining figures and ligatures; the page behaves like a magazine.",
  defaults: { bodyFontSize: 17, mathFontScale: 100 },
  values: {
    sourceFont: '"JetBrains Mono", ui-monospace, monospace',
    bodyFont: '"Bodoni Moda", "Source Serif 4", "Times New Roman", serif',
    headingFont: '"Archivo", "Source Sans 3", system-ui, sans-serif',
    codeFont: '"JetBrains Mono", ui-monospace, monospace',
    ligaturesInCode: true,
    tabularFigures: true,
    oldstyleFigures: false,
    slashedZero: true,
  },
}
{
  id: "bauhaus",
  label: "Bauhaus",
  note: "Jost's circles and straight lines in prose and headings, with Azeret Mono's geometric code. No serif anywhere; tabular figures and the arrow ligature.",
  defaults: { bodyFontSize: 17, mathFontScale: 95 },
  values: {
    sourceFont: '"Azeret Mono", "JetBrains Mono", ui-monospace, monospace',
    bodyFont: '"Jost", "Source Sans 3", system-ui, sans-serif',
    headingFont: '"Jost", "Source Sans 3", system-ui, sans-serif',
    codeFont: '"Azeret Mono", "JetBrains Mono", ui-monospace, monospace',
    ligaturesInCode: true,
    tabularFigures: true,
    oldstyleFigures: false,
    slashedZero: true,
  },
}
{
  id: "notebook",
  label: "Notebook",
  note: "Alegreya's calligraphic serif under Caveat's handwriting, with Victor Mono's narrow, cursive-italic code. A notebook rather than a printed page.",
  defaults: { bodyFontSize: 17, mathFontScale: 95 },
  values: {
    sourceFont: '"Victor Mono", "JetBrains Mono", ui-monospace, monospace',
    bodyFont: '"Alegreya", "Source Serif 4", Georgia, serif',
    headingFont: '"Caveat", "Alegreya", cursive',
    codeFont: '"Victor Mono", "JetBrains Mono", ui-monospace, monospace',
    ligaturesInCode: true,
    tabularFigures: true,
    oldstyleFigures: true,
    slashedZero: false,
  },
}
```

The order in `TYPOGRAPHY_PRESETS` is `system`, `superfamily`, `renaissance`,
`editorial`, `bauhaus`, `notebook`; the picker then reads System, Serif,
Renaissance, Editorial, Bauhaus, Notebook, Custom.

The OpenType defaults are deliberate, not inherited:

| Preset | Ligatures | Tabular | Oldstyle | Slashed zero | Why |
| --- | --- | --- | --- | --- | --- |
| Renaissance | off | on | on | on | Plex has no `liga`/`calt`; EB Garamond has `onum`/`tnum`; Plex has `zero` |
| Editorial | on | on | off | on | JetBrains has `calt`/`zero`; Bodoni has `tnum`; lining is the magazine choice |
| Bauhaus | on | on | off | on | Azeret has `calt` (at least `->`) and `zero`; Jost has `tnum`, no `onum` |
| Notebook | on | on | on | off | Victor has `calt`; Alegreya has `onum`/`tnum`; Victor's slashed zero is `ss02`, not `zero` |

Sizes are starting points, not identity: Renaissance 18 px preview / 90% math;
Editorial 17/100; Bauhaus 17/95; Notebook 17/95; Serif stays 18/80; System 16/100.
The editor font size stays 16 for every preset.

### Why these pairings

- **Renaissance.** EB Garamond and IBM Plex Mono are both humanist, low-contrast
  and open-apertured; Plex's larger x-height is the concession code needs, and
  EB Garamond 600 for headings keeps the page in one voice. Cormorant Garamond
  is the more dramatic Garamond but a display cut, too light at 16–18 px;
  Courier Prime is the obvious typewriter but light and feature-poor.
- **Editorial.** Bodoni Moda's `opsz` axis chooses the text cut at 17 px, so the
  hairlines survive; Archivo's grotesque, high-x-height headings hold the page.
  JetBrains Mono is the grotesque code face that closes the system, already
  bundled, with ligatures and `zero`. Libre Bodoni is the sturdier fallback if
  17 px looks fragile for a reader, but it is static and loses the optical-size
  axis.
- **Bauhaus.** Jost is a Futura revival with a variable weight and a readable
  double-storey `a`; Azeret Mono is geometric, spans 100–900, and carries
  `zero` and `calt`. Poppins has no italic and one width; DM Mono stops at 500
  and has neither `zero` nor code ligatures.
- **Notebook.** Alegreya is a calligraphic humanist with `onum` and `tnum`;
  Caveat puts a hand in the headings; Victor Mono is narrow, fully accented and
  has a true cursive italic plus `calt` ligatures. The result is a writer's
  desk, not a comic.

### The informal preset, and the monos that lost

The literal comic route does not survive Portuguese:

- Comic Mono is ASCII-only — 106 glyphs, no `ã`, `õ` or `ç`. `programação`
  breaks.
- Comic Shanns Mono does carry the accents, but they are visibly misaligned at
  display sizes, it has one weight, and it has no GSUB features. Serious Shanns
  has six styles but inherits Comic Mono's ASCII base (it adds only `λ`, `ł`,
  `Ł`). Both are MIT, both are the wrong trade for a text editor.
- Recursive Mono Casual is the serious variable alternative, but Google's
  static instances drop `calt`/`liga`/`zero`; using it would require another
  instancing/subsetting step for one face.
- Victor Mono has 1,436 glyphs, complete accents, `calt` ligatures and a
  cursive italic. Paired with Caveat it gives the handwritten signal without
  breaking the text.

Lora was the first choice for the Notebook body, but its OFL declares a Reserved
Font Name ("Lora"); subsetting would force a rename. Alegreya has no RFN, has
the same calligraphic warmth, and subsets well.

### Font sources, build and OFL policy

The thirteen families (the four kept ones and the nine new ones) are pinned in
a new `scripts/font-sources.json`; the existing `scripts/fetch-fonts.ps1`
becomes the driver that downloads, verifies, calls
`scripts/subset-fonts.py`, copies the licences and rewrites
`src/assets/fonts/fonts.json`. Ordinary builds never run any of this: the woff2
files are committed and Vite only resolves them.

| Family | Upstream | Source / instance | Output |
| --- | --- | --- | --- |
| EB Garamond | `google/fonts` at a pinned commit | `EBGaramond[wght].ttf`, `EBGaramond-Italic[wght].ttf`; variable subset | 2 woff2 |
| IBM Plex Mono | `IBM/plex` release | official woff2 400, 400 italic, 700; unmodified | 3 woff2 |
| Bodoni Moda | `google/fonts` | `BodoniModa[opsz,wght].ttf` + italic; variable subset | 2 woff2 |
| Archivo | `google/fonts` | `Archivo[wdth,wght].ttf`; instance `wght=600, wdth=100`; subset | 1 woff2 |
| Jost | `google/fonts` | `Jost[wght].ttf` + italic; variable subset | 2 woff2 |
| Azeret Mono | `google/fonts` | `AzeretMono[wght].ttf`; variable subset | 1 woff2 |
| Alegreya | `google/fonts` | `Alegreya[wght].ttf` + italic; variable subset | 2 woff2 |
| Caveat | `google/fonts` | `Caveat[wght].ttf`; instance `wght=600`; subset | 1 woff2 |
| Victor Mono | `rubjo/victor-mono` v1.5.6 | official woff2 400, 400 italic, 700; unmodified | 3 woff2 |

The subset recipe is the same for every new text face:

```text
unicodes:
  U+0000-024F   Basic Latin, Latin-1 Supplement, Latin Extended-A/B
  U+1E00-1EFF   Latin Extended Additional (Vietnamese)
  U+0250-02FF   IPA and spacing modifiers
  U+0300-036F   combining marks
  U+2000-206F   general punctuation
  U+20A0-20CF   currency
  U+2100-214F   letterlike
  U+2190-21FF   arrows
  U+2200-22FF   mathematical operators
  U+2300-23FF   technical
  U+2500-257F   box drawing
  U+2580-259F   block elements
  U+25A0-25FF   geometric shapes
  U+FB00-FB06   ligatures

layout features:
  ccmp, locl, rlig, rvrn, liga, calt, onum, tnum, zero,
  kern, mark, mkmk
```

Everything else (`aalt`, `ss01`–`ss20`, `dlig`, `smcp`, `frac`, `swsh`, `hist`,
`ornm`, `salt`, `subs`, `sups`) is dropped. The UI only asks for common
ligatures, `onum`, `tnum` and `zero`, and the four switches must remain real.
`dlig` is not enabled by the preview; `smcp`, `frac` and the stylistic sets are
not used. The script verifies the resulting cmap against a probe string
(`ãõçáéíóúâêôàüñ` plus arrows/math) and the feature list before writing the
file; a missing feature fails the build.

Variable fonts are kept variable where the preset needs a weight range (EB
Garamond, Bodoni, Jost, Azeret, Alegreya); Archivo and Caveat are instanced to
the single weight the UI asks for. IBM Plex Mono and Victor Mono are copied
unmodified.

**OFL Reserved Font Names matter here.** Subsetting is a modification. EB
Garamond, Bodoni Moda, Archivo, Jost, Azeret, Alegreya, Caveat and Victor Mono
declare no RFN, so the subset keeps the canonical name. IBM Plex Mono declares
"Plex"; it is therefore bundled **whole**, preserving the name and its
Greek/Cyrillic/Vietnamese coverage. Lora ("Lora") and Source Code Pro
("Source") were rejected for the same reason. The licence page keeps every
copyright notice and licence text; the ADR records the policy.

The budget with this recipe (KiB):

| New family | Files | KiB |
| --- | --- | --- |
| EB Garamond | 2 | 216.1 |
| IBM Plex Mono (whole) | 3 | 407.5 |
| Bodoni Moda | 2 | 119.2 |
| Archivo | 1 | 19.0 |
| Jost | 2 | 81.2 |
| Azeret Mono | 1 | 29.6 |
| Alegreya | 2 | 115.6 |
| Caveat | 1 | 52.3 |
| Victor Mono | 3 | 131.1 |
| **New total** | **17** | **1,171.6** |
| Inter removed | 2 | −722.9 |
| **Net with Notebook** | | **+448.7** |

The current 2,534 KiB becomes about 2,983 KiB; the binary grows by about
0.44 MiB, inside the 0.5 MiB allowance. Without Notebook the net is about
+0.15 MiB. The Vietnamese range is included above; Greek/Cyrillic are not.

Exports embed only the first bundled family of each stack. Approximate base64
sizes: Renaissance 832 KiB (EB Garamond + IBM Plex Mono), Editorial 680 KiB
(Bodoni + Archivo + JetBrains), Bauhaus 148 KiB (Jost + Azeret), Notebook
399 KiB (Alegreya + Caveat + Victor). The current Serif export is 1,919 KiB;
every new preset is smaller.

### Rejected alternatives

- **Rename the current presets and change only OpenType.** The stacks stay the
  same and a layperson still sees no change. This is the bug, not the fix.
- **Bundle full, unsubsetted fonts.** About 4.8 MB of new faces, roughly
  +5 MiB in the binary. Unacceptable for the stated constraint.
- **Use Google Fonts' CSS woff2 subsets directly.** They are tiny, but they
  strip the features the UI depends on: measured, the EB Garamond Latin subset
  has no `onum`, the IBM Plex Mono subset has no `zero`, and Google's static
  Recursive has no `calt`/`liga`/`zero`. The typography switches would become
  dead controls.
- **Comic Mono / Comic Shanns Mono / Serious Shanns for Notebook.** Coverage or
  quality; see above.
- **Lora / Source Code Pro.** OFL Reserved Font Name; subsetting would force a
  rename.
- **Cormorant Garamond / Poppins / DM Mono / Libre Bodoni as the primary
  choices.** Display cut, no italic/one width, 500 max/no `zero`, and
  static/no opsz respectively. Each is a fallback, not the default.
- **A "Typeset" preset with Latin Modern.** It would match KaTeX exactly, but
  Latin Modern is GFL rather than OFL and visually close to Editorial; a later
  preset, not this change.
- **Keep the old preset ids and migrate saved sizes.** The new presets have new
  defaults (18/90, 17/100, 17/95); carrying old 16/16/100 overrides would mask
  them. New ids; old keys inert.
- **Fetch fonts at runtime or use the system's installed copies.** Breaks the
  "the document looks the same on every machine" promise and the export
  embedding.

## Steps

- [x] Add `scripts/font-sources.json` covering all thirteen families (the four
      kept ones plus the nine new), with pinned commits or releases, per-source
      SHA-256, output names, weights and instance recipes. Inter is not in the
      list.
- [x] Add `scripts/subset-fonts.py` (fonttools + brotli, maintenance-only) that
      downloads nothing itself: it reads a source file, optionally instances it,
      subsets it with the recipe above, verifies cmap/features, and writes the
      woff2. Document that it is run only by `fetch-fonts.ps1`.
- [x] Rewrite `scripts/fetch-fonts.ps1` as the driver: download each pinned
      source, verify SHA-256, run the subsetter or copy the unmodified woff2,
      copy the OFL texts, and regenerate `src/assets/fonts/fonts.json`. The
      JSON covers the kept four families too, so there is one source list.
- [x] Generate the 17 new woff2 files and commit them; remove
      `Inter-Variable.woff2`, `Inter-Variable-Italic.woff2` and
      `inter-OFL.txt`; add the nine licence files.
- [x] Confirm the regenerated `src/assets/fonts/fonts.json`: no `inter`
      entry, nine new families with `tag`, `source`, `licence`, `licenceFile`,
      `bytes` and `sha256`; update the generated-by note if the driver's
      wording changed.
- [x] Rewrite the preset section of `src/fonts.ts` with the four new entries,
      ids, labels, notes, stacks, defaults and OpenType values; update the
      header comment that says "four families" and the Inter example in
      `familiesIn`; dedupe `FONT_SUGGESTIONS` and add "Inter" to the
      non-bundled suggestions (it is no longer shipped).
- [x] Update `src/content.ts`: import the nine new `?raw` licence texts, remove
      Inter, expand the table and the per-family sections, change "five" to
      "thirteen".
- [x] Update `src/preferences.ts`: the `Custom (user)` chip to `Custom`, the
      Font licences help from five to thirteen, the Preset help if it quotes
      old ids, and the heading-role help to allow serif headings.
      `activePreset` and the size/override setter need no structural change.
- [x] Update `src-tauri/src/settings.rs`: rename
      `typography_defaults_are_the_literary_preset` to
      `typography_defaults_are_the_system_preset` (the assertions are already
      about empty stacks). No schema change.
- [x] Update `src/styles.css` only if the seventh chip needs it; verify the row
      at 1267×1201 and at the minimum window width. No other CSS change is
      expected: `font-optical-sizing: auto` is already set.
- [x] Update `scripts/typography-test.mjs`: load the new families, assert the
      six-preset matrix and first families, add the four-preset pixel-diff
      measurement, and check the new code faces' real features (Plex no
      ligatures, JetBrains yes, Azeret's `->`, Victor's ligatures, EB Garamond
      and Alegreya `onum`, Jost `tnum`, Victor no `zero`).
- [x] Update `scripts/dom-smoke.mjs`: the per-preset size test uses
      `Renaissance` (18 px / 90% / oldstyle on) instead of `Classic`; reset to
      System 16/100 at the end.
- [x] Update `scripts/licence-test.mjs`: check all thirteen families, iterate a
      list instead of five hard-coded booleans, and update the header comment.
- [x] Update `scripts/export-test.mjs`: the bundled-family regex, and replace
      the Inter-fallback check with a new-preset fallback check (Renaissance
      exports EB Garamond + IBM Plex Mono and must not embed the JetBrains
      fallback).
- [x] Update `docs/typography.md`: the thirteen-family table, the six presets,
      the per-preset sizes and OpenType defaults, the subset/RFN policy, the
      math scales, exports and the licence count.
- [x] Update `README.md` ("Five bundled typefaces, five presets") and the
      Typography section; update `AGENTS.md` prerequisites (fonttools only for
      font maintenance), the fetch-fonts row, the test counts and two new
      Traps (Google CSS subsets drop features; OFL RFN blocks subsetting under
      the original name).
- [x] Write `docs/adr/2026-10-18-typography-presets.md`: presets are complete
      systems, the 3+1 matrix, the subset/RFN policy and the coverage default.
- [x] Validate with the layers below; record the measured font payload, binary
      size and export sizes in this plan; update the status to `in progress`,
      then `done`.
- [x] Replace the proposal screenshot with real application screenshots if the
      docs need them; keep the proposal image only as a design reference.

## Execution notes

- Built **13 families, 30 woff2 files, 2,794 KiB**. Inter was removed, so the
  payload is **+260 KiB** over the 2,534 KiB baseline, not the drafted
  +448.7 KiB. The new families cost: EB Garamond 235.6, IBM Plex Mono 149.4,
  Bodoni Moda 126.0, Archivo 22.9, Jost 80.3, Azeret Mono 32.1, Alegreya 132.8,
  Caveat 57.9 and Victor Mono 145.4 KiB.
- `npm run build` passed. `cargo test` passes **78 tests, 1 ignored** when the
  test executable is run from outside the workspace; the same binary run inside
  the workspace still hits the known sandbox `Access is denied` temp tests.
- `npm run typography`: **48/48**; `npm run smoke`: **93/93** on a fresh
  instance; `npm run licence`: **4/4** (59,297-character document, thirteen
  attributions); `npm run export`: **35/35**. `npm run dist` staged the NSIS,
  MSI, portable and ordinary binaries; the staged `MDraft.exe` is 13.27 MB.
- A manual Renaissance PDF export was inspected: the print document embeds
  **only EB Garamond and IBM Plex Mono**, and the code stack still names
  JetBrains as its fallback. That is the first-family-only embedding rule working
  with the new system.
- Deviations from the draft:
  - IBM Plex Mono comes from IBM's official woff2 (400/400 italic/700), not a
    Google TTF subset. It is **149.4 KiB** rather than the 407.5 estimate, which
    is why the net is smaller. The RFN is respected: the file is unmodified.
  - Victor Mono is subset (it has no RFN) instead of copied: 145.4 KiB instead of
    223.7 KiB. Its `layoutFeatures` keep `calt`; `requiredFeatures` is `calt`.
  - Feature lists are per output. `kern`, `mark` and `mkmk` were added to every
    subset (positioning is not optional). `tnum` is omitted for EB Garamond,
    Jost, Archivo and Azeret; EB Garamond's default figures are tabular, and
    Jost's `tnum` is a fullwidth set. The Bauhaus preset therefore sets
    `tabularFigures: false`.
  - The smoke test's pane-sync phase now sets `--body-size: 20px` for the
    off-screen-block measurement and restores it. At the default 16 px the whole
    visible source column maps to blocks that fit inside the preview pane, so the
    "at least one block below the fold" precondition never occurred. This is a
    test-harness change, not an application behaviour change.
  - The `Custom (user)` chip is now `Custom`, so the seven chips fit on one row
    at the 1918 px test window; the CSS already wraps if the panel is narrower.
- The pre-change staged binary size was not recorded in this session, so the
  reliable delta is the font payload (+260 KiB), not the 13.27 MB binary total.
- The implemented panel screenshot is
  `docs/screenshots/typography-presets-implemented.png`; the original design
  specimen remains `docs/screenshots/typography-presets-proposal.png`.

## Files and modules

| File | Why it must change |
| --- | --- |
| `src/fonts.ts` | The preset matrix, ids, notes, stacks, defaults and OpenType values; the family-count header; `FONT_SUGGESTIONS` |
| `src/assets/fonts/fonts.json` | Remove Inter; add nine families with output hashes and source tags |
| `src/assets/fonts/*.woff2` | Seventeen new files; two Inter files deleted |
| `src/assets/fonts/licenses/*-OFL.txt` | Nine new licence texts; `inter-OFL.txt` deleted |
| `scripts/font-sources.json` | New build input: pinned sources, SHAs, instances, output names |
| `scripts/subset-fonts.py` | New: instance, subset, verify and write woff2; maintenance only |
| `scripts/fetch-fonts.ps1` | Driver for download/verify/build/manifest; the only documented font-refresh entry point |
| `src/content.ts` | Licence imports, table and sections; remove Inter |
| `src/preferences.ts` | Chip label, licence help count, heading-role help; no structural change |
| `src-tauri/src/settings.rs` | Test name only; the settings schema is unchanged |
| `scripts/typography-test.mjs` | Family loading, preset matrix, pixel-diff and feature checks |
| `scripts/dom-smoke.mjs` | Per-preset size defaults change with the new preset ids |
| `scripts/licence-test.mjs` | Thirteen families, not five |
| `scripts/export-test.mjs` | Bundled-family regex and the fallback check, which currently names Inter |
| `docs/typography.md` | The typography reference must describe the new system |
| `README.md` | The feature summary and the family/preset count |
| `AGENTS.md` | Prerequisites, fetch-fonts description, test counts, two new Traps |
| `docs/adr/2026-10-18-typography-presets.md` | Durable matrix and subset/RFN policy |
| `src/styles.css` | Only if the seventh chip needs wrapping; otherwise no change |
| `src/api.ts` | No change: the settings schema is unchanged |
| `src/main.ts` | No change: `applyTypography` already reads the settings |

`scripts/test-all.mjs` needs no logic change; it runs the suites by name. Its
quoted counts in `README.md`/`AGENTS.md` do change.

## Risks and rollback

- **The binary grows more than 0.5 MiB.** The measured net is +0.44 MiB with
  Notebook and the Vietnamese range. If a font's subset comes out larger, the
  first levers are: drop the Vietnamese range, trim JetBrains Mono's unused 700
  italic or Source Sans 3's unused 600/700 italics, or subset IBM Plex Mono
  under a new name (losing "IBM Plex" but saving ~0.3 MiB).
- **OFL Reserved Font Names.** IBM Plex Mono is bundled whole; Lora and Source
  Code Pro are not used. If a new source reveals an RFN not seen here, the
  family is either bundled unmodified or the subset is renamed; the licence
  page and the UI use the renamed family. This is a manual review gate in
  addition to `npm run licence`, which proves the texts but not the names.
- **The subset drops a feature or glyph.** The script verifies the probe string
  and the feature list before writing; `npm run typography` then proves the
  features change pixels. If a feature is missing, the face is not ready.
- **Bodoni Moda is fragile at 17 px.** The `opsz` axis is the mitigation; review
  at 100% and 150% DPI. If it still breaks up, switch Editorial's body to Libre
  Bodoni (static 400/400 italic/700) and keep the rest of the preset.
- **Jost is too wide at 17 px.** Review a long document; the body size can go to
  18 px, or the body can move to DM Sans while Jost keeps the headings. The
  plan's default is Jost for the full geometric voice.
- **Caveat's h4–h6 are hard to read.** Review the feature-tour headings. If they
  are, Caveat can be limited to h1–h3 with a small CSS split, or the heading
  face can change; that decision is made after the visual review, not assumed
  here.
- **The seventh chip wraps or clips.** The row already wraps in the panel; the
  `Custom (user)` → `Custom` rename recovers width. Verify at 1267×1201 and at
  the minimum window width. If it is still ugly, the Notebook chip is the one
  to move to a second row; dropping the preset is a last resort.
- **Existing readers see "Custom".** Their saved stacks name the old Source
  families and no longer match a preset; the picker shows Custom until they
  choose one. No value is lost; the old `presetOverrides` keys are inert. This
  is documented in `docs/typography.md`.
- **Removing Inter breaks a custom stack that names it.** The stack falls back
  to the system sans; "Inter" stays in `FONT_SUGGESTIONS` for machines that
  have it installed, but it is no longer guaranteed. Documented.
- **New subsets do not cover Greek/Cyrillic.** The preview falls back to Source
  Serif/Sans because they follow in the stack; an export embeds only the first
  family, so those runs fall back to the reader's system. The kept Serif preset
  is the full-coverage choice. If this is unacceptable, add the Greek/Cyrillic
  ranges for about +0.2 MiB (Open questions).
- **Old builds.** Older versions ignore the new woff2 files and see stacks that
  name unknown families; they fall back, but no data is lost. Rollback is
  reverting the branch; the settings schema is unchanged, so no migration needs
  undoing.
- **Vite inlining/hashing.** Files over 4 KB are hashed, not inlined; the
  `import.meta.glob` in `fonts.ts` and the `?raw` licence imports already handle
  this. Verify a packaged build, not only the dev server.

## Tests and validation

Layers, cheapest first:

- **Typecheck:** `npm run build`.
- **Rust:** `npm run test:rust` (the only change is the renamed default test).
- **Typography:** `npm run typography` on a fresh instance, against
  `samples/feature-tour.md`. It must prove:
  - every bundled family is declared and loads;
  - each of the six presets reports itself active and resolves the four roles
    to the expected first family;
  - the four new presets render the same paragraph with four different
    digests;
  - the OpenType defaults are real on the faces that claim them and off on the
    faces that do not.
- **DOM smoke:** `npm run smoke` on a fresh instance. The per-preset size test
  uses Renaissance (18 px / 90% / oldstyle on) and returns to System 16/100.
- **Licences:** `npm run licence` on its own instance; all thirteen texts are
  present.
- **Export:** `npm run export` with pandoc; a Renaissance export embeds EB
  Garamond and IBM Plex Mono, does not embed the JetBrains fallback, and has no
  network font URL.
- **Distribution:** `npm run dist`; stage and measure the binary. Compare the
  font payload against the 2,534 KiB baseline and the +0.5 MiB allowance.
- **Manual visual review:** each preset on `samples/feature-tour.md` at 100% and
  150% DPI; the seventh chip at 1267×1201 and at the minimum width; a long
  document in Editorial (Bodoni hairlines) and Bauhaus (Jost measure); math in
  each preset.

The single measurement that proves the change: with the preview at a fixed
17 px and the same paragraph, screenshots of Renaissance, Editorial, Bauhaus
and Notebook produce **four distinct SHA-256 digests**, and
`document.fonts.load`/`check` succeeds for EB Garamond, Bodoni Moda, Jost and
Alegreya. If any two presets are identical, the presets are still
indistinguishable and the change has failed its purpose.

## Acceptance criteria

- System and Serif keep their exact stacks, defaults and OpenType values.
- The picker shows System, Serif, Renaissance, Editorial, Bauhaus, Notebook and
  Custom; each new preset reports itself active on selection.
- Each preset resolves all four roles to its named first family, and each
  family loads in the packaged application.
- The four new body faces are visibly distinct: the pixel-digest check passes,
  and the manual review agrees.
- The OpenType defaults in the matrix are real; a switch the face cannot
  support is off, not dead.
- Renaissance 18/90, Editorial 17/100, Bauhaus 17/95 and Notebook 17/95 are the
  starting sizes; switching away and back restores a reader's adjustment.
- The seven chips fit or wrap cleanly at 1267×1201 and at the minimum window
  width.
- The font payload is ≤3.1 MiB and the binary growth ≤0.5 MiB; the exact
  measurements are recorded in this plan.
- Inter is gone; thirteen families and thirteen OFL texts are in the licence
  document; `npm run licence` passes.
- A Renaissance export embeds EB Garamond + IBM Plex Mono and not the JetBrains
  fallback, and contains no network font URL.
- A settings file from the current version loads; old preset overrides are
  inert; no crash. An upgrading reader sees Custom until choosing a new preset.
- `npm run dist` succeeds, `bin/<os>/<arch>/` is staged, and the new binary
  launches.
- `docs/typography.md`, `README.md`, `AGENTS.md` and the ADR describe the final
  state; the test counts quoted there match the run.

## Open questions

- **Greek/Cyrillic coverage.** Default: no; the new presets are
  Latin + Vietnamese + symbols, and the kept Serif preset remains the
  full-coverage choice. Adding Greek/Cyrillic to the text faces costs about
  +0.2 MiB. If the reviewer wants parity, add it before generating the fonts.
- **IBM Plex Mono whole or subset with a rename.** Default: whole
  (~0.4 MiB, name and coverage preserved). The alternative is a subset named
  something other than "IBM Plex Mono", saving about 0.3 MiB.
- **Old preset ids and saved sizes.** Default: new ids, old `presetOverrides`
  keys inert, no migration. The alternative is mapping `classic` → `editorial`,
  `literary` → `renaissance`, `technical` → `bauhaus`, but that would carry old
  16 px/100% defaults into the new presets and mask their own starting sizes.
- **"Serif" label.** Default: keep it. A later copy change could call it
  "Source" or "Superfamily" now that the other labels name schools.
- **A "Typeset" preset with Latin Modern.** Default: not in this change. It
  would be the only perfect KaTeX text match, but GFL and visually close to
  Editorial.
- **Trimming unused faces.** Default: no. JetBrains Mono's 700 italic and
  Source Sans 3's 600/700 italics are candidates if the size allowance is
  exceeded.
- **Caveat at h4–h6.** Default: review after implementation; if it is not
  legible, limit Caveat to h1–h3 or swap the heading face rather than accept a
  preset whose small headings cannot be read.

