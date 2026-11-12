# Replace Bodoni Moda with Playfair in the Editorial preset

**Status:** done
**Date:** 2026-11-02
**ADR:** none — the rule that a bundled family is either RFN-free or copied
unmodified is already recorded in [docs/typography.md](../typography.md); this
plan applies it to one more family.

## Context and goal

The **Editorial** preset sets *Preview text* to `"Bodoni Moda"` (`src/fonts.ts`)
and ships two woff2 files, `BodoniModa-Variable.woff2` and its italic, totalling
**129 044 bytes**. The reader wants Playfair in that role.

**Playfair Display** is not a clean replacement under this repository's rules:

- It has the weights and styles — a variable `wght 400–900` plus a variable
  italic `400–900`, the same range as Bodoni Moda — but it has **no `tnum`,
  `pnum` or `zero`**, and its default figures are oldstyle rather than Bodoni's
  lining. Editorial's tabular-table switch would stop working.
- Its OFL declares the **Reserved Font Name "Playfair Display"**. Subsetting is
  a *Modified Version* and cannot use that name; even a format conversion is
  normally treated as modification. An unmodified official WOFF2 exists (652 036
  + 691 712 = **1 343 748 bytes**, +1.21 MB), so keeping the name is legal but
  expensive.

**Playfair** — the 2023 expanded family by the same designer, listed in Google
Fonts as `Playfair` — has no RFN, carries `opsz`, `wdth`, `wght 300–900`, and the
full figure set (`onum`, `lnum`, `tnum`, `pnum`, `zero`). At `opsz 17` /
`wdth 100` it matches Playfair Display closely in a specimen rendered at the
preview's 17 px.

**Goal:** the Editorial preset's body face becomes **Playfair**, Bodoni Moda and
its licence leave the tree, tabular figures and the slashed zero keep working,
and the binary-size and export-size effects are measured rather than estimated.
The reader chose to accept Playfair's **oldstyle figures** for this preset; no
CSS figure mapping changes.

No backward compatibility is required: a `settings.json` that still names
`"Bodoni Moda"` may fall back to the next family in the stack, and the reader
may Reset the preset.

## Scope and non-scope

**In scope**

- Add `Playfair-Variable.woff2` and `Playfair-Variable-Italic.woff2`, subset from
  the pinned Google Fonts sources with the feature set the panel uses.
- Add `licenses/playfair-OFL.txt`; remove the two Bodoni woff2 files and
  `licenses/bodoni-moda-OFL.txt`.
- Replace the `bodoni-moda` catalogue entry with `playfair` in
  `scripts/font-sources.json` and `src/assets/fonts/fonts.json`.
- Editorial values in `src/fonts.ts`: `bodyFont`, the preset note, and
  `oldstyleFigures: true` (Playfair's default and its `onum` shape).
- The licence page (`src/content.ts`) and its test (`scripts/licence-test.mjs`).
- The typography, export and licence suites' family names and feature checks.
- `docs/typography.md`: face table, preset table, OpenType note, Semibold
  sentence, export-size estimate.
- Font tooling: a documented `--instance-after-subset` path in
  `scripts/subset-fonts.py`, passed through `scripts/fetch-fonts.ps1`, because
  fontTools crashes when this family is instanced before subsetting; and
  `recalcTimestamp = False` so re-running the subset produces the same bytes and
  the recorded SHA-256 means something.
- Measure the release binary and the exported HTML before and after, and record
  both in the plan.

**Non-scope**

- No change to any other preset, role picker, settings schema, Rust command or
  export layout.
- No migration for saved `"Bodoni Moda"` stacks; no alias named "Playfair
  Display" and no renamed Playfair Display subset.
- No change to the meaning of the four OpenType switches. Playfair's default is
  oldstyle, so the Editorial switch starts on; the existing Alegreya precedent
  (a switch left describing the result the face already draws) applies.
- No attempt to keep an optical-size axis: `opsz` and `wdth` are pinned at build
  time. The preview's `font-optical-sizing: auto` simply has nothing to
  interpolate for this one family.
- No regeneration of the other twelve families; their committed bytes and hashes
  stay as they are.

## Approach and rejected alternatives

**Chosen:** subset **Playfair** (Google Fonts, pinned at
`google-fonts@47d54ca`), keeping the `wght 300–900` axis and pinning
`opsz = 17` and `wdth = 100` **after** glyph subsetting. The Editorial default
preview size was 17 px when this change was made (a follow-up set it to 19), so
the pinned optical cut was the one the preset drew; this is the size-optimal
choice. The feature list keeps
`ccmp, locl, rlig, rvrn, liga, calt, onum, lnum, tnum, zero, kern, mark, mkmk`
and requires `onum, lnum, tnum, liga`, so the subset cannot silently lose the
figure features. The two outputs measured **103 372 + 116 760 = 220 132 bytes**,
i.e. **+91 088 bytes (+88.95 KiB)** against Bodoni.

Editorial becomes:

```ts
bodyFont: '"Playfair", "Source Serif 4", "Times New Roman", serif',
oldstyleFigures: true,
```

with `tabularFigures: true` and `slashedZero: true` unchanged (Playfair has both
features; the slashed zero continues to matter in the code role, whose face is
JetBrains Mono).

**Rejected: Playfair Display subset under its own name.** The subset is smaller
(101 156 bytes, −27 KiB) but the OFL Reserved Font Name forbids it. Renaming to
something like "Playfair Editorial" would be legal and still small; the reader
chose the Playfair name and the complete feature set instead.

**Rejected: Playfair Display's official unmodified WOFF2.** Legal and keeps the
name, but adds 1 343 748 bytes (+1.21 MB) and still has no `tnum`, `pnum` or
`zero`.

**Rejected: Playfair with `opsz` kept variable.** It would preserve optical
sizing at every preview size but costs about 386 KB (+257 KiB) instead of
220 KB; the face is used at 17 px and the visible difference between the 17 px
and 24 px cuts is small.

**Rejected: keeping Bodoni Moda.** The reader asked for Playfair.

**Rejected: forcing lining figures through `lnum`.** It would preserve Bodoni's
figure style but changes a global CSS mapping and the table composition; the
reader explicitly chose Playfair's oldstyle design.

## Steps

- [x] Add the two Playfair sources to `scripts/font-sources.json` with their
      SHA-256 pins and the OFL URL, and add the `playfair` family entry
      (outputs with `instance: { "opsz": 17, "wdth": 100 }`,
      `instanceAfterSubset: true`, the feature lists above, weight `300 900`).
      Remove `bodoni-moda`.
- [x] Extend `scripts/subset-fonts.py` with `--instance-after-subset` and set
      `font.recalcTimestamp = False` before saving; extend
      `scripts/fetch-fonts.ps1` to pass the flag when the manifest asks for it.
- [x] Generate the two woff2 files through the updated script, copy them into
      `src/assets/fonts/`, and verify the Latin probe, the four required
      features, `fvar = [wght 300–900]`, the glyph count and two identical
      SHA-256 runs.
- [x] Fetch `ofl/playfair/OFL.txt` into
      `src/assets/fonts/licenses/playfair-OFL.txt`; delete the two Bodoni woff2
      files and `licenses/bodoni-moda-OFL.txt`.
- [x] Update `src/assets/fonts/fonts.json`: the `playfair` family in the
      `bodoni-moda` slot, with the output bytes and hashes; keep thirteen
      families.
- [x] Update `src/fonts.ts`: the module comment's Editorial paragraph (why
      Playfair rather than Playfair Display's RFN, and the pinned optical cut),
      the Editorial note, `bodyFont`, and `oldstyleFigures`.
- [x] Update `src/content.ts`: import the Playfair licence, replace the table
      row and the licence section.
- [x] Update the suites: `scripts/typography-test.mjs` (bundled name list,
      Playfair tabular-figure check, five-body-family digest, Editorial's four
      roles), `scripts/export-test.mjs` (bundled-name list), and
      `scripts/licence-test.mjs` (copyright text and variable name).
- [x] Update `docs/typography.md`: face table, Editorial character, the
      Playfair oldstyle note, Semibold sentence, and the export base64 estimate
      (694 → about 813 KiB).
- [x] Run the test layers below; fix anything they catch.
- [x] Build the release binary and compare its size with the current
      18 531 840 bytes; record the exact delta in this plan and in
      `docs/typography.md` only if it differs from the estimate.
- [x] Add the two font-maintenance traps to `AGENTS.md` and update the plan
      status to `done` with the measured numbers.
- [x] Delete the prototype/work files under `T:\Temp\opencode\playfair`.

## Files and modules

| File | Why |
| --- | --- |
| `scripts/font-sources.json` | The pinned Playfair sources, OFL and subset outputs replace the Bodoni entry. |
| `scripts/subset-fonts.py` | `--instance-after-subset` works around the fontTools `gvar` failure; `recalcTimestamp = False` makes output hashes reproducible. |
| `scripts/fetch-fonts.ps1` | Passes the new flag when the manifest names it. |
| `src/assets/fonts/Playfair-Variable.woff2` | New regular subset. |
| `src/assets/fonts/Playfair-Variable-Italic.woff2` | New italic subset. |
| `src/assets/fonts/BodoniModa-Variable.woff2` | Delete. |
| `src/assets/fonts/BodoniModa-Variable-Italic.woff2` | Delete. |
| `src/assets/fonts/licenses/playfair-OFL.txt` | New licence text. |
| `src/assets/fonts/licenses/bodoni-moda-OFL.txt` | Delete. |
| `src/assets/fonts/fonts.json` | Generated catalogue: family name, files, weights, bytes, hashes. |
| `src/fonts.ts` | Editorial's body stack, note and figure switch; the bundle rationale. |
| `src/content.ts` | Help › Font Licences must name and reproduce Playfair, not Bodoni. |
| `scripts/typography-test.mjs` | Proves Playfair loads, its tabular feature changes pixels, and Editorial resolves to it. |
| `scripts/export-test.mjs` | The export's bundled-name list must know Playfair, or the embedding check reads the wrong branch. |
| `scripts/licence-test.mjs` | The licence page's Playfair attribution. |
| `docs/typography.md` | The living typography reference; the dead plan/ADR files stay as history. |
| `AGENTS.md` | Two traps: the subset/instance order and the `head.modified` non-determinism. |

## Risks and rollback

- **The binary grows by 90 112 bytes (+88 KiB, +0.486 %)**, not shrinks. This is
  the measurable cost of keeping the Playfair name legally and keeping `tnum`;
  the alternative (renamed Playfair Display) is 27 KiB smaller. The release
  build confirms the exact figure. Rollback is one commit: restore the two
  Bodoni files and the preset line; no settings migration was written.
- **Editorial's figures change from lining to oldstyle.** This is deliberate and
  documented. The *Oldstyle figures* switch starts on; turning it off draws the
  same oldstyle figures, exactly as Alegreya's switch already does. If that is
  later judged a dead control, the follow-up is to keep `lnum` in the subset
  (already done) and change the CSS "off" value to `lining-nums`, not to
  re-subset.
- **The pinned optical cut does not follow a changed preview size.** At 18–24 px
  the 17 px cut is still legible; the reader accepted the size trade-off.
- **The font's internal name remains "Playfair 5pt SemiExpanded Light"** in name
  IDs 1/4/6 because the instancer runs with `updateFontNames = False`; the app
  and the `@font-face` use the catalogue name "Playfair", and GDI/browsers
  report the typographic family "Playfair". A PDF's internal font name may show
  the long label. Leaving it is the default; see Open questions.
- **`recalcTimestamp = False` changes future font builds' bytes.** It does not
  touch the committed files unless they are regenerated; it makes the next
  refresh reproducible instead of timestamp-dependent.
- **A future fontTools release may fix the instancing bug.** The flag remains a
  valid, documented order; either order should then produce the same glyphs.

## Tests and validation

The one measurement that proves it works: in the running application with
Editorial active, `getComputedStyle` on the preview paragraph resolves
`font-family` to Playfair **and** a screenshot of the same paragraph differs
from the Bodoni build, while `document.fonts.load('600 17px "Playfair"')`
succeeds.

- `npm run build` — typecheck the TS changes.
- Font artifact checks (Python): Latin probe, `onum`/`lnum`/`tnum`/`liga`, a
  single `wght` axis, 13 families, and two identical hashes from two runs.
- `npm run format:check`, `npm run lint`, `npm run knip` — the quality gates for
  the touched TS/JSON.
- `npm run typography` — 60 checks; Playfair declared and loaded, its `tnum`
  pixels differ, the five body faces differ, Editorial's four roles and the
  600 weight.
- `npm run licence` — 4 checks; the Playfair OFL text is on the licence page.
- `npm run smoke` — 114 checks; Preferences, preview rendering and fonts.
- `npm run export` — 40 checks; the exported HTML embeds Playfair and not
  Bodoni, and the math/code rules are unchanged.
- `npm run menu` — 123 checks; the font picker's Preferences route still opens.
  (No menu item names a face, so this is a regression guard rather than a
  feature check.)
- Release build: `npm run dist -- --no-portable` (with no MDraft running) and
  compare `src-tauri/target/release/mdraft.exe` with 18 531 840 bytes; record
  the delta.
- Visual: screenshot Editorial at 17 px with a paragraph, a table and a formula;
  confirm oldstyle running figures, tabular table figures, Playfair italic and
  the Archivo headings.

Skipped deliberately: `npm run test:rust` (no Rust change), `npm run pdf:native`
(the print path is font-agnostic and the export suite covers the embedded
faces), and the two-launch suites (no state change).

## Acceptance criteria

- The bundled family picker lists **Playfair** and no longer lists Bodoni Moda;
  Editorial's Preview text resolves to Playfair.
- `git grep -ni bodoni -- src scripts` returns nothing; only historical plan/ADR
  prose elsewhere mentions it. The two Bodoni woff2 files and its licence are
  gone.
- Playfair is subset to the documented features; `tnum` changes pixels,
  `document.fonts.load('600 17px "Playfair"')` succeeds, and the Latin probe
  passes.
- The licence page shows the Playfair copyright and the SIL OFL text; the
  thirteen-family count holds.
- `fonts.json` lists Playfair with the generated byte counts and SHA-256, and
  two identical subset runs produce the same hash.
- The release binary's size delta and the exported HTML's base64 size are
  measured and recorded; `docs/typography.md` states the new export estimate.
- The listed suites pass with their documented counts.

## Result

Implemented on 2026-11-02.

- **Fonts.** `Playfair-Variable.woff2` is 103 372 bytes and the italic 116 760;
  together **220 132 bytes**, **+91 088 bytes (+88.95 KiB)** against Bodoni's
  129 044. `fonts.json` lists thirteen families, every file and licence is
  present, and all byte counts and SHA-256 values match. Two identical subset
  runs produced the same hashes (`c04a5220…` and `b1615ee1…`).
- **Tooling.** `--instance-after-subset` refuses to run without `--instance`,
  so a missing axis pin is an error rather than a silent no-op, and
  `recalcTimestamp = False` keeps the output reproducible.
- **Release binary.** 18 621 952 bytes, **+90 112 bytes (+88 KiB, +0.486 %)**
  against the 18 531 840-byte build before the change.
- **Exported print document.** The export suite wrote 883 KB and found **7
  embedded faces: JetBrains Mono, Playfair, Archivo** — Playfair is the body
  winner and only winning families are embedded. The font base64 payload is
  about 813 KiB, which is the figure in `docs/typography.md`.
- **Suites.** `npm run build`, `npm run format:check`, `npm run lint` and
  `npm run knip` passed. `typography` **60/60**, `licence` **4/4**, `smoke`
  **114/114**, `export` **40/40**. `menu`, `test:rust` and `pdf:native` were
  skipped deliberately: the change touches no menu, Rust or print path, and the
  export suite already exercises the embedded faces.
- **Isolation.** The installed MDraft window was open, so the UI suites ran
  against a disposable build with identifier
  `io.github.bgeneto.mdraft.playfairtest`; the installed window, its settings and
  its recovery journal were not touched. That build and its profile were
  removed afterwards.
- **Visual.** A screenshot of Editorial at 17 px showed Playfair prose, Archivo
  headings and oldstyle running figures, with the preview and the source side
  by side. The `tnum` pixel check passes, so tabular table figures remain
  real.
- **Follow-up defaults.** The reader later set Editorial's own defaults to
  **19 px preview** and **80% math scale** (code scale unchanged at 96). The
  subset's pinned `opsz 17` remains the text cut; `docs/typography.md` and the
  DOM smoke matrix now state 15/19/80/96.

## Open questions

- **Internal font name.** The subset keeps the source's default instance name in
  name IDs 1/4/6. If a PDF that exposes font properties must read exactly
  "Playfair", the follow-up is to rewrite those name records (and 16/17) after
  instancing; the default is to leave them, because the application, the
  `@font-face` and the picker all use the catalogue name.
