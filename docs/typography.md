# Typography

MDraft treats the preview as a document, not as an HTML dump. Type is chosen in
four roles, and for Markdown and AsciiDoc the same choices travel into native
HTML and printed PDF exports.

## The faces

Five families are compiled into the application under the SIL Open Font
License. None is fetched at runtime.

| Family | Used for | Source |
| --- | --- | --- |
| Source Serif 4 | Prose in the Serif, Classic and Literary presets | [adobe-fonts/source-serif](https://github.com/adobe-fonts/source-serif) |
| Source Sans 3 | Headings in those presets | [adobe-fonts/source-sans](https://github.com/adobe-fonts/source-sans) |
| Inter | Prose and headings in the Technical preset, and an alternative sans | [rsms/inter](https://github.com/rsms/inter) |
| JetBrains Mono | Code and source in most presets | [JetBrains/JetBrainsMono](https://github.com/JetBrains/JetBrainsMono) |
| Fira Code | Code and source in the Serif preset | [tonsky/FiraCode](https://github.com/tonsky/FiraCode) |

The editor chrome keeps the operating system's UI font. A menu that reflows
with the document's typeface would be a less predictable application.

## Roles

**Preferences › Typography** has one face picker for each role:

- **Editor** — the source pane. Monospaced by default; any family works.
- **Preview text** — prose in the preview and in exports.
- **Preview headings** — headings in the preview and in exports.
- **Preview code** — fenced and inline code in the preview.

Each picker offers the five bundled families first, then faces likely to be
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
| **Serif** | Source Serif 4 under Source Sans 3, with Fira Code in both code roles. Ligatures and slashed zero on. |
| **Classic** | The same Source superfamily with JetBrains Mono and code ligatures off. |
| **Literary** | Source Serif 4 with oldstyle figures, code ligatures on, JetBrains Mono. |
| **Technical** | Inter throughout, JetBrains Mono in code, lining figures, no code ligatures. |

Every preset is a starting point: changing a face or a switch moves the panel
to **Custom (user)**, which keeps the values you chose.

Preview text size and math scale are not part of a preset. They are reader
adjustments remembered per preset: set Serif to 17 px, visit System and
Classic, and Serif still comes back at 17 px. A preset that has never been
adjusted starts at 16 px and 100%. Under Custom (user), both values are global.
Changing either size does not leave the active preset.

## OpenType

| Setting | Default | Effect |
| --- | --- | --- |
| Ligatures in code | Off | Draws `->` and `=>` as single glyphs in faces that have them |
| Tabular figures in tables | On | Equal-width digits, so columns line up |
| Oldstyle figures in prose | Off | Figures with ascenders and descenders in running text |
| Slashed zero in code | Off | Distinguishes `0` from `O` |

Kerning and standard ligatures are stated explicitly rather than left to the
browser's defaults, and variable fonts are asked to interpolate their optical
size axis for the size in use.

## Semibold, not Bold

Emphasis, headings and table headers are set at weight 600 (Semibold), not 700
(Bold), in the preview, the Typst document view, exported HTML and printed PDF.
Semibold holds its counters at heading sizes and sits closer to the body text;
Bold at 700 reads as a different face.

Source Serif 4 and Inter carry the weight on a variable axis; Source Sans 3
ships a separate Semibold cut, which is one of the files bundled here. The
editor and code are deliberately excluded: syntax highlighting uses 700 because
the extra weight is what makes a token read as syntax. Mathematics keeps
KaTeX's own weights for the same reason.

## Mathematics

KaTeX 0.19 renders `$…$`, `$$…$$`, `\(…\)` and `\[…\]` in Markdown, and
`latexmath:[…]` in AsciiDoc. Its Computer Modern faces are bundled, so formulas
do not depend on the reader's fonts.

KaTeX draws at `1.21em`, which is why a formula reads slightly larger than the
text beside it. **Preferences › Typography › Math scale** multiplies that ratio
from 70% to 130%. 100% keeps KaTeX's own size; about 83% makes a formula match
the prose. The preview, exported HTML and printed PDF all read the same value.

## Exports

For Markdown and AsciiDoc, a native HTML or printed PDF export embeds the
bundled faces as data URLs, so the document looks the same on a machine that
has never had them installed. A document naming a family by name would
otherwise get a silent fallback, and the PDF would stop matching the preview
exactly when a face had been chosen.

Only faces that actually win in a stack are embedded. A fallback cannot render,
and carrying it added weight for nothing. The default System preset embeds no
fonts because there is nothing to embed.

Pandoc exports (DOCX, ODT, LaTeX and the rest) use pandoc's own layout. They do
not carry the preview's typography in the same way; the native HTML and PDF
(Print) paths are the ones that do.

## Licences

All five families are under the SIL Open Font License 1.1, which permits
bundling inside an application provided the copyright notice and licence text
travel with it. They do: **Help › Font Licences** displays the texts inside the
application, and the same files are under
[`src/assets/fonts/licenses/`](../src/assets/fonts/licenses).

`src/assets/fonts/fonts.json` records every version, archive SHA-256 and file
SHA-256. `scripts/fetch-fonts.ps1` reproduces the set, refusing to extract an
archive whose hash has changed.
