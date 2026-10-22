# Typography

MDraft treats the preview as a document, not as an HTML dump. Type is chosen in
four roles, and for Markdown and AsciiDoc the same choices travel into native
HTML and printed PDF exports.

## The faces

Thirteen families are compiled into the application under the SIL Open Font
License. None is fetched at runtime.

| Family | Used for | Source |
| --- | --- | --- |
| Source Serif 4 | Prose in the Serif preset | [adobe-fonts/source-serif](https://github.com/adobe-fonts/source-serif) |
| Source Sans 3 | Headings in the Serif preset | [adobe-fonts/source-sans](https://github.com/adobe-fonts/source-sans) |
| JetBrains Mono | Code and source in Editorial, and the grotesque code fallback | [JetBrains/JetBrainsMono](https://github.com/JetBrains/JetBrainsMono) |
| Fira Code | Code and source in Serif | [tonsky/FiraCode](https://github.com/tonsky/FiraCode) |
| EB Garamond | Prose and headings in Renaissance | [octaviopardo/EBGaramond12](https://github.com/octaviopardo/EBGaramond12) |
| IBM Plex Mono | Code and source in Renaissance | [IBM/plex](https://github.com/IBM/plex) |
| Bodoni Moda | Prose in Editorial | [indestructible-type/Bodoni](https://github.com/indestructible-type/Bodoni) |
| Archivo | Headings in Editorial | [Omnibus-Type/Archivo](https://github.com/Omnibus-Type/Archivo) |
| Jost | Prose and headings in Bauhaus | [indestructible-type/Jost](https://github.com/indestructible-type/Jost) |
| Azeret Mono | Code and source in Bauhaus | [displaay/azeret](https://github.com/displaay/azeret) |
| Alegreya | Prose in Notebook | [huertatipografica/Alegreya](https://github.com/huertatipografica/Alegreya) |
| Caveat | Headings in Notebook | [googlefonts/caveat](https://github.com/googlefonts/caveat) |
| Victor Mono | Code and source in Notebook | [rubjo/victor-mono](https://github.com/rubjo/victor-mono) |

The editor chrome keeps the operating system's UI font. A menu that reflows with
the document's typeface would be a less predictable application.

## Roles

**Preferences › Typography** has one face picker for each role:

- **Source Editor** — the source pane. Monospaced by default; any family works.
- **Preview text** — prose in the preview and in exports.
- **Preview headings** — headings in the preview and in exports.
- **Preview code** — fenced and inline code in the preview.

Each picker offers the thirteen bundled families first, then faces likely to be
installed on Windows, macOS or a Linux desktop. A value written by an older
version, or a family not in the list, is shown as a custom entry rather than
silently replaced.

The default is **System**: prose, headings and code use the operating system's
own faces, so a fresh document embeds no font at all. The bundled faces are
there for the presets that ask for them.

## Presets

A preset sets the four faces and the OpenType switches together, because the
hard part of choosing type is the pairing rather than one family.

| Preset | Character |
| --- | --- |
| **System** | The default. No bundled faces; nothing is embedded in an export. |
| **Serif** | Source Serif 4 under Source Sans 3, with Fira Code in both code roles. A neutral modern book: oldstyle figures, ligatures and slashed zero on; starts at 17 px preview size and 88% math scale. |
| **Renaissance** | EB Garamond in prose and headings, IBM Plex Mono in the editor. A 16th-century book page: low contrast, small x-height, serif headings, oldstyle figures, no code ligatures, 80% math scale. |
| **Editorial** | Bodoni Moda's hairline Didone under Archivo's grotesque headings, with JetBrains Mono in code. A mid-century magazine: lining figures, ligatures and slashed zero on, 17 px preview size and 90% math scale. |
| **Bauhaus** | Jost's circles and straight lines in prose and headings, with Azeret Mono's geometric code. A 1920s poster with no serif anywhere: ligatures and slashed zero on, proportional table figures, 17 px and 90% math. |
| **Notebook** | Alegreya's calligraphic serif under Caveat's handwriting, with Victor Mono's narrow, cursive-italic code. A writer's notebook: oldstyle and tabular figures, ligatures on, 17 px and 86% math. |

`Classic`, `Literary` and `Technical` were removed. A reader who had one of them
selected keeps the saved stacks in `settings.json`, so the picker shows
**Custom** until a new preset is chosen; the old per-preset size entries remain
inert. No value is lost.

Every preset is a starting point: changing a face or a switch moves the panel
to **Custom**, which keeps the values you chose. The four role pickers are not
locked to a preset.

Editor font size, preview font size and math scale are not part of a preset's
identity. They are reader adjustments remembered per preset: set Serif to 19 px,
visit System and Renaissance, and Serif still comes back at 19 px. A preset that
has never been adjusted starts at its own defaults (System 16/95, Serif 18/92,
Renaissance 19/80, Editorial 17/90, Bauhaus 17/90, Notebook 17/86). The editor
font size starts at 15 px for every preset, with a 1.5 line height that scales
with the size. **Line Height** in *Preferences › Editor* chooses **Compact**
(1.3×), **Normal** (1.5×) or **Wide** (1.8×). It is a global preference, not a
per-preset adjustment, and it applies to the source pane only: the preview keeps
its own reading line height. Under Custom, all three sizes are global. Changing
any of the three sizes does not leave the active preset.

## OpenType

| Setting | Default | Effect |
| --- | --- | --- |
| Ligatures in code | Off in System and Renaissance; on in Serif, Editorial, Bauhaus and Notebook | Draws `->` and `=>` as single glyphs in faces that have them |
| Tabular figures in tables | On, except Bauhaus | Equal-width digits, so columns line up |
| Oldstyle figures in prose | On in Serif, Renaissance and Notebook | Figures with ascenders and descenders in running text |
| Slashed zero in code | On in Serif, Renaissance, Editorial and Bauhaus; off in System and Notebook | Distinguishes `0` from `O` |

Two faces need a note rather than a checkbox:

- **Jost's `tnum` is a fullwidth set**, not a tabular one. Bauhaus therefore
  leaves tabular figures off; turning the switch on would replace the table
  digits with wide fullwidth glyphs.
- **Victor Mono's slashed zero is stylistic set `ss02`**, not the `zero` feature
  that `font-variant-numeric` can request. Notebook leaves the switch off.
- **Alegreya's default figures are oldstyle**, and **EB Garamond's default
  figures are tabular lining**. The switches describe the result; on those two
  faces the default already has the requested shape.

Kerning and standard ligatures are stated explicitly rather than left to the
browser's defaults, and variable fonts are asked to interpolate their optical
size axis for the size in use.

## Semibold, not Bold

Emphasis, headings and table headers are set at weight 600 (Semibold), not 700
(Bold), in the preview, the Typst document view, exported HTML and printed PDF.
Semibold holds its counters at heading sizes and sits closer to the body text;
Bold at 700 reads as a different face.

Source Serif 4, EB Garamond, Bodoni Moda, Jost and Alegreya carry the weight on
a variable axis. Source Sans 3 ships a separate Semibold cut; Archivo and Caveat
are bundled as a single Semibold instance for the heading role. IBM Plex Mono
and Victor Mono ship 400, 400 italic and 700; the code view uses 700 where a
token is bold. The editor and code are deliberately excluded from the 600 rule:
syntax highlighting uses 700 because the extra weight is what makes a token read
as syntax. Mathematics keeps KaTeX's own weights for the same reason.

## Mathematics

KaTeX 0.19 renders `$…$`, `$$…$$`, `\(…\)` and `\[…\]` in Markdown, and
`latexmath:[…]` in AsciiDoc. Its Computer Modern faces are bundled, so formulas
do not depend on the reader's fonts.

KaTeX draws at `1.21em`, which is why a formula reads slightly larger than the
text beside it. **Preferences › Typography › Math scale** multiplies that ratio
from 70% to 130%. 100% keeps KaTeX's own size; about 83% makes a formula match
the prose. Serif uses 88%; System 95%; Renaissance 80% so the mathematics does
not shout beside Garamond; Editorial and Bauhaus 90%, and Notebook 86%. The
preview, exported HTML and printed PDF all read the same value.

A perfect text-and-math match would need a different math font and a renderer
that can use it — KaTeX's metrics are tied to its own fonts. A future
"Typeset" preset with Latin Modern would be the closest match, at the cost of a
different licence (GFL) and a look close to Editorial.

## Exports

For Markdown and AsciiDoc, a native HTML or printed PDF export embeds the
bundled faces as data URLs, so the document looks the same on a machine that
has never had them installed. A document naming a family by name would
otherwise get a silent fallback, and the PDF would stop matching the preview
exactly when a face had been chosen.

Only faces that actually win in a stack are embedded. A fallback cannot render,
and carrying it added weight for nothing. The default System preset embeds no
fonts because there is nothing to embed.

The new families are subset to Latin, Vietnamese, punctuation, arrows, maths,
box drawing and geometric shapes, with the features the panel uses. Greek and
Cyrillic are not in those subsets; the Serif preset, whose Source faces are
bundled whole, remains the full-coverage choice. A document that mixes Greek or
Cyrillic into a new preset falls back in the preview; an export falls back to
the reader's system for those runs. Approximate base64 sizes of a print
document: Renaissance 513 KiB, Editorial 694 KiB, Bauhaus 150 KiB, Notebook
448 KiB, Serif 1,919 KiB.

Pandoc exports (DOCX, ODT, LaTeX and the rest) use pandoc's own layout. They do
not carry the preview's typography in the same way; the native HTML and PDF
(Print) paths are the ones that do.

## Licences

All thirteen families are under the SIL Open Font License 1.1, which permits
bundling inside an application provided the copyright notice and licence text
travel with it. They do: **Help › Font Licences** displays the texts inside the
application, and the same files are under
[`src/assets/fonts/licenses/`](../src/assets/fonts/licenses).

Subsetting is a modification. Eight of the new families declare no Reserved
Font Name and keep their canonical names in the subset. **IBM Plex Mono**
declares "Plex", so it is bundled whole, unchanged. The two Source families are
also bundled unchanged from Adobe's release. Lora ("Lora") and Source Code Pro
("Source") were considered and rejected for the same reason; the Notebook body
uses Alegreya instead.

`scripts/font-sources.json` records every source pin. `scripts/fetch-fonts.ps1`
downloads and verifies each source, calls `scripts/subset-fonts.py` for the
Google families, and rewrites `src/assets/fonts/fonts.json` with the output
bytes and SHA-256. The Python tooling (fonttools and brotli) is needed only to
refresh the fonts, never by an ordinary build. The woff2 files are committed.
