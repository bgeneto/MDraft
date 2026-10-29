# Presets are complete typographic systems, and bundled fonts are subset under the OFL

**Status:** accepted
**Date:** 2026-10-18
**Amended by:** `2026-10-29-preset-state.md` — the bundled faces and the six preset systems remain; the "Custom until choosing a new one" consequence is replaced by a stored preset id and per-field diffs.

## Context

The five built-in presets were not doing the job a preset is for. `Classic` and
`Literary` carried **identical** four-role stacks (Source Serif 4, Source Sans 3,
JetBrains Mono); only the OpenType booleans differed. `Technical` changed prose
and headings to Inter but kept JetBrains Mono. `Serif` was the same Source
superfamily with Fira Code. Four of the five presets therefore had the same
texture, and a reader without a typographic vocabulary could not see the switch.

At the same time the bundled font payload was 2,534 KiB, of which Inter alone was
723 KiB and Source Sans 3's six static faces 572 KiB. The constraint was not
"add fonts"; it was "make the switch visible without inflating the binary". Two
measurements shaped the answer:

- Google Fonts' hosted woff2 subsets are small but **lose the layout features the
  panel depends on**: the EB Garamond Latin file has no `onum`, IBM Plex Mono's
  has no `zero`, Google's static Recursive has no `calt`/`liga`. A subset built
  from the upstream TTF with an explicit feature list keeps them.
- Full, unsubsetted faces for the new systems would be about 4.8 MB. A Latin +
  Vietnamese + symbols subset with the UI features costs about 1.0 MB.

The OpenType licences also matter: IBM Plex declares the Reserved Font Name
"Plex", Lora declares "Lora", and the Source fonts declare "Source". A modified
subset may not be distributed under a reserved name.

## Decision

**A preset is a complete typographic system.** It must change the preview body
and the code face, not only an OpenType switch; headings change where the school
asks for it. The six presets are:

| Preset | School | Body | Headings | Code |
| --- | --- | --- | --- | --- |
| System | the OS | system-ui | system-ui | system mono |
| Serif | transitional/humanist | Source Serif 4 | Source Sans 3 | Fira Code |
| Renaissance | Garalde | EB Garamond | EB Garamond | IBM Plex Mono |
| Editorial | Didone + grotesque | Bodoni Moda | Archivo | JetBrains Mono |
| Bauhaus | geometric | Jost | Jost | Azeret Mono |
| Notebook | humanist + handwritten | Alegreya | Caveat | Victor Mono |

The three old presets were removed; Notebook was added. System and Serif keep
their stacks, defaults and OpenType values. Inter is no longer bundled.

**New fonts enter through a pinned subsetting pipeline.** `scripts/font-sources.json`
holds every source URL, commit/tag and SHA-256. `scripts/fetch-fonts.ps1` downloads
and verifies them; `scripts/subset-fonts.py` instances and subsets the Google
families with `ccmp`, `locl`, `rlig`, `rvrn`, `liga`, `calt`, `onum`, `tnum`,
`zero`, `kern`, `mark` and `mkmk`; the output woff2 and `fonts.json` are
committed. Ordinary builds use the committed files and need neither Python nor
the network. The coverage is Latin, Latin Extended Additional (Vietnamese),
punctuation, arrows, maths, box drawing and geometric shapes; Greek and Cyrillic
are deliberately out, and the Serif preset remains the full-coverage choice.

**The OFL Reserved Font Name policy is explicit.** A family with no RFN is
subset and keeps its canonical name. IBM Plex Mono has an RFN and is bundled
whole, unchanged. Lora and Source Code Pro were rejected because they would have
to be renamed; Alegreya took the Notebook body.

**The old preset ids are gone.** `presetOverrides` entries for `classic`,
`literary` and `technical` stay in an existing `settings.json` but are inert; a
reader whose saved stacks no longer match a preset sees **Custom** until choosing
a new one. There is no automatic migration, because carrying the old 16 px/100%
values into the new presets would mask their own starting sizes.

## Consequences

- The font payload is 2,794 KiB in 30 woff2 files, about **+260 KiB** over the
  2,534 KiB baseline, because Inter (723 KiB) pays for most of the new set. The
  new families' approximate print-export sizes (base64) are Renaissance 513 KiB,
  Editorial 694 KiB, Bauhaus 150 KiB and Notebook 448 KiB, all below the Serif
  export at 1,919 KiB.
- The 13 families and 30 files are the new maintenance surface. Refreshing them
  requires Python 3 with `fonttools` and `brotli`, but only through
  `scripts/fetch-fonts.ps1`; an ordinary build and the test suite do not.
- Per-preset sizes and OpenType defaults are part of the preset experience:
  Renaissance 18 px/90%, Editorial 17/100, Bauhaus 17/95, Notebook 17/95, Serif
  18/80, System 16/100. Jost's `tnum` is a fullwidth set, so Bauhaus leaves
  tabular figures off; Victor Mono's slashed zero is `ss02`, so Notebook leaves
  it off; Alegreya's default figures are oldstyle and EB Garamond's are tabular.
- A document that mixes Greek or Cyrillic into a new preset falls back in the
  preview and, in an export, to the reader's system for those runs. The Serif
  preset is the documented answer; adding the Greek/Cyrillic ranges would cost
  roughly another 0.2 MiB.
- The design is recorded with a specimen at
  `docs/screenshots/typography-presets-proposal.png` and an implemented panel
  screenshot at `docs/screenshots/typography-presets-implemented.png`.
