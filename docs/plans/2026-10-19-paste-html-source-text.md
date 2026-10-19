# Pasting markup source must not be converted

**Status:** done
**Date:** 2026-10-19
**ADR:** `../adr/2026-10-19-paste-source-text.md` (new; see step 6)

## Context and goal

Pasting an HTML snippet into an HTML document converts it instead of inserting
it. Reproduced against the conversion layer (`planPaste`, no application), with
the snippet from the report and the clipboard shapes the usual sources produce:

| Clipboard | Destination | Text inserted today |
| --- | --- | --- |
| VS Code with syntax highlighting (`text/html` = `<div style="color: #d4d4d4;…"><span style="color:#808080">&lt;</span>…`) | HTML | `<div style="color: #d4d4d4; white-space: pre"><div><span style="color: #808080">&lt;</span><span style="color: #9CDCFE">link</span>…` — the highlighting, not the tag |
| a docs page's code block (`text/html` = `<code class="language-html">&lt;link …&gt;</code>`) | HTML | `<code class="language-html">&lt;link …&gt;</code>` |
| `text/html` = the bare `<link …>` | HTML | **nothing** — `sanitizeHtmlFragment` drops `link` since DROP in `src/paste/html-fragment.ts` lists it, so the result is empty |
| VS Code flavour, same text | Markdown | `\<linkrel="stylesheet"href="https://…"\>` — escaped, and the spaces are gone |

The plain-text representation of that clipboard is already the destination's own
syntax, so no translation should happen — the user's words: `input=html,
output/destination=html`.

Why it happens. `chooseSource` (`src/paste/detect.ts`) trusts the plain text only
when `detectTextSyntax(text, "clipboard")` names the destination's language. That
classifier is deliberately conservative for HTML **fragments**: `scoreHtml`'s
comment says "a code snippet starting with `<div>` must not be eaten by the
parser" and clipboard mode returns 0 for anything that is not a whole document.
The intent is right, but the failure path it leaves is not: the very next branch
is "the clipboard has an HTML representation, use it", so the snippet is eaten by
the parser after all — through `readHtml`/`sanitizeHtmlFragment` instead of
natively. The same gap exists for Markdown text that carries only low-value
signals: `- one\n- two` scores 1, misses the score-4 threshold, and is converted
from the HTML representation.

Goal: when the clipboard's plain text is markup *written out* — HTML source, or
text carrying Markdown's own syntax — paste it as written into a destination
that can carry it (an HTML or Markdown document). Rendered copies from a
browser, Word or Google Docs keep converting exactly as they do today.

## Scope and non-scope

In scope:

- A synchronous, dependency-free predicate `isHtmlSource(text)` in
  `src/paste/detect.ts`: the text is a tag fragment (`<link …>`, `<p>Hello</p>`,
  `<div>\n<p>x</p>\n</div>`, `<style>…</style>`, `<div>`) but not prose that
  mentions a tag (`Use the <div> tag`, `<div> is how you group`, `a < b`,
  `<!-- only a comment -->`, `\<p\>`).
- `chooseSource` prefers the plain text when it is HTML source (an HTML or
  Markdown destination), and when the destination is Markdown and the text
  carries Markdown syntax (`scoreMarkdown(text) > 0`, or a visible code fence).
- Unit checks in `scripts/paste-convert-test.mjs`, three UI checks in
  `scripts/rich-paste-test.mjs`, the guide sentence, a small ADR, the quoted
  suite counts and Traps entries.
- Whole documents are included: `<!doctype html>…` copied as text is source too
  and is inserted verbatim (see Risks).

Non-scope (deliberately):

- **Destination detection** for unsaved buffers. `detectTextSyntax` and its
  two-point lead stay as they are; a code snippet still must not classify a
  buffer.
- **The sanitizer's drop list.** `link`, `meta`, `style`, `script` stay dropped
  when the HTML *representation* is the source — that is what makes copying from
  a rendered page safe (rich-paste ADR). The change only stops that
  representation from being used when the text is already markup.
- **Typst and AsciiDoc destinations** keep converting HTML source text to their
  escaped literal form (`<` is meaningful syntax in Typst; loose signals there
  are ambiguous — `@ref`, `$5$`, `<label>` occur in prose).
- **`trimInline`'s whitespace loss** (`src/paste/read-html.ts`):
  `convertInline` trims every element's children, so a token `<span> rel</span>`
  — a syntax highlighter puts each token *and its space* in its own span —
  loses the space and renders `linkrel="stylesheet"href=…`. Found while
  diagnosing this; it still affects rendered copies whose text sits alone in an
  inline element. It is recorded in Traps, not fixed here; the paste path for
  code no longer takes that route.

## Approach and rejected alternatives

Chosen: the clipboard's text is authoritative whenever it is markup and the
destination can carry that markup as text (HTML, and Markdown, which accepts raw
HTML). One new predicate decides it for HTML; the Markdown rule is the existing
"text already in the destination's syntax" branch with its threshold lowered to
"carries Markdown syntax at all". Both return
`{ source: "plain" | "markdown", native: true }`, so the paste handler does not
`preventDefault` and CodeMirror inserts the text — the same route plain prose and
confident Markdown already take.

Predicate shape: walk the text with one tag token pattern; everything at depth 0
must be a tag or whitespace (`Use the <div> tag` fails on `Use the`), text inside
an element is content, void elements do not open a level, and the text is
accepted when the level returns to 0 or the text ends with an opening tag
(`<div>` alone is something you paste; `<div> is how you group` is a sentence).
The void-element list is exported from `src/tag-name.ts` rather than copied, so
the two cannot drift.

Rejected alternatives:

- **Never use the HTML representation** (always paste `text/plain`). Kills rich
  paste for HTML documents — the feature has a test ("an HTML buffer pastes
  HTML").
- **Make the sanitizer keep `link`/`meta`/`style` when the text contains them.**
  Two sources of truth for what is safe, and it weakens the boundary the
  rich-paste ADR drew.
- **Require the plain text to equal the HTML representation's text content.**
  Fires for `Hello` + `<b>Hello</b>` (a bold word copied from a page), which must
  keep converting; the discriminator has to be "the text is markup", not "the
  two agree".
- **Loosen Typst and AsciiDoc too.** Their low-score signals are ordinary prose
  (`@user`, `$5`, `<label>`, `//`), so "carries syntax" would suppress real
  conversions.
- **Regex-only rule (strip tags, require whitespace).** Rejects `<p>Hello</p>`,
  which is markup with content; the depth walk is what admits it.

## Steps

- [x] 1. `src/tag-name.ts`: export the existing `VOID_ELEMENTS` set.
- [x] 2. `src/paste/detect.ts`: add `isHtmlSource()`, use it in `chooseSource`,
      and lower the Markdown-destination rule to `scoreMarkdown(text) > 0` plus a
      visible fence. Comments state why the classifier's refusal is not the
      whole answer.
- [x] 3. `scripts/paste-convert-test.mjs`: a new "markup source" section — the
      predicate table, `chooseSource`/`planPaste` for both HTML clipboard shapes
      and for the Markdown list, and a guard check that
      `Use the <code>&lt;div&gt;</code> tag` + `Use the <div> tag` still
      converts. 89/89 pass.
- [x] 4. `scripts/rich-paste-test.mjs`: paste the highlighted payload into a tab
      that detects as HTML, assert the exact snippet line is in the buffer and
      that no `<span` is; then the bare-`<link>` payload, assert the snippet is
      there (it used to insert nothing).
- [x] 5. `docs/guide.md`: one sentence in *Paste, copy and images*.
- [x] 6. `docs/adr/2026-10-19-paste-source-text.md`: the rule, referencing
      rich-paste ADR's "plain text that already matches the destination wins" and
      qualifying its "HTML → HTML is sanitised" to the HTML *representation*.
- [x] 7. `AGENTS.md` and `README.md`: quoted suite counts; a Traps entry for the
      HTML-snippet paste (symptom → cause → fix, with the literal output), and
      one for the `trimInline` space loss.
- [x] 8. Validation (below) and the plan's status.

## Deviations

- The Markdown loosening needed one guard the plan did not name: six existing
  checks in `paste-convert-test.mjs` ("Typst to Markdown", "AsciiDoc to
  Markdown") failed because a Typst or AsciiDoc document that *contains* a
  bullet list was treated as Markdown. The rich-paste ADR's rule — shared
  constructs never decide — holds: `carriesMarkdown` only applies when the
  clipboard classifier is silent or already says Markdown. A confident other
  syntax still wins.
- The `destination === "html" && confident?.language === "html"` branch became
  unreachable (`scoreHtml`'s 6 implies a whole document, which `isHtmlSource`
  now catches first) and was removed rather than left as dead code.
- The real OS clipboard turned out to be unusable from an agent session
  (`clip.exe` → "Access is denied", `SetDataObject` → "operation did not
  succeed"). The saved-`.html` case was verified instead by launching a staged
  binary on `target.html` and dispatching the same `ClipboardEvent` the UI
  suites use; `AGENTS.md` now records the restriction so nobody re-chases it.
- The HTML-source rule is gated to HTML and Markdown destinations. "Any
  destination" and the non-scope bullet ("Typst and AsciiDoc keep converting")
  contradicted each other; the non-scope bullet has the reason — `<link>` is a
  *label* in Typst, so a verbatim tag disappears and its attributes shift into
  the prose. A new check pins it: a tag snippet into Typst becomes escaped
  literal text. The ADR records the gate; the unit count is 90, not 89.

## Files and modules

| File | Why |
| --- | --- |
| `src/tag-name.ts` | Export the void-element list the predicate needs |
| `src/paste/detect.ts` | The predicate and the source-selection rule |
| `scripts/paste-convert-test.mjs` | Unit coverage of the rule and its guards |
| `scripts/rich-paste-test.mjs` | The reported scenario through the real editor |
| `docs/guide.md` | User-visible rule |
| `docs/adr/2026-10-19-paste-source-text.md` | The durable decision |
| `AGENTS.md`, `README.md` | Quoted counts, Traps |

No Rust, no `src/api.ts`, no `settings.json` field, no new dependency.

## Risks and rollback

- **A whole HTML document copied as text is now inserted verbatim** instead of
  being sanitised. Deliberate: it is the user's own markup, and the sanitized
  path remains for the HTML representation (rendered copies). If it turns out to
  be unwanted, the predicate can carve out a leading `<!doctype`/`<html` — one
  condition.
- **A rendered copy whose visible text is entirely a tag** (e.g. a docs page's
  inline `&lt;div&gt;` selected alone) is now inserted as literal characters, so
  the preview renders the tag instead of showing the text. Rare; the alternative
  is the reported bug for every code snippet.
- **Markdown conversions change for low-score text**: a copy whose plain text
  carries a bullet, a fence or a quote line stays byte-identical instead of being
  converted. That is the existing rule's intent, so the risk is small, and the
  existing checks pin the cases that must keep converting.
- Rollback: revert the branch. Nothing persists; no migration.

## Tests and validation

- `node scripts/paste-convert-test.mjs` — the count grows from 72 to 90; the
  exact snippet comes back byte-for-byte from `planPaste` for both clipboard
  shapes, the prose guard still converts, and a tag snippet into Typst still
  becomes escaped text. **Recorded: 90/90.**
- `npm run build` — typecheck and frontend bundle. **Recorded: run by the
  `tauri build` inside `npm test`; green.**
- `npm test -- --only paste,paste-convert` — the rich-paste suite on a freshly
  launched instance, 23 checks plus the three new ones. It has to build first:
  the binary is staged from `src-tauri/target/release`, and the portable copy
  must be closed for the build and for the second instance's WebView2 profile
  (existing trap). **Recorded: paste-convert 90/90, paste 26/26.**
- The reported case on a *saved* `.html` file: the staging binary opened
  `target.html`, the highlighted payload went in through the app's paste
  handler, and the buffer held the snippet exactly, with no `<span`; a rendered
  `<p>Hello <strong>world</strong></p>` payload still converted. The real OS
  clipboard is not reachable from this session (see Deviations).
- Suites that paste through the same source choice: `npm test -- --no-build
  --only asciidoc,image-syntax` — their pastes carry prose text, which the new
  rules do not touch. **Recorded: asciidoc 51/51, image-syntax 14/14.**
- The measurement that proves it: `planPaste(payload(decorated, LINK), "html")`
  returns `LINK` with `converted: false`, and in the application the source pane
  holds the exact line — no `<span`, no `<div style=`.
- Full `npm test` is not the gate for this change: the working tree carries
  unrelated in-progress work (typography defaults), so the paste layers plus the
  build are run, and that is stated in the summary.

## Acceptance criteria

1. Pasting `<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/reveal.js/5.2.1/reset.min.css">`
   (copied from a syntax-highlighting editor, a docs code block, or a plain-text
   clipboard that also carries `text/html`) into an HTML document inserts that
   exact line, byte-for-byte, with `converted: false` and no notice.
2. The same paste into a Markdown document inserts the same line; a Markdown
   bullet list snippet stays byte-identical too.
3. `Use the <div> tag` copied from a page with its `<code>` markup still converts
   to escaped text; "an HTML buffer pastes HTML", "a list pasted into HTML
   converts", "Markdown into Markdown is native" and every other existing check
   still pass.
4. Suite counts quoted in `AGENTS.md` match the suites' own output (the README
   quotes no counts).

## Open questions

1. Include the Markdown loosening in this change, or hold it as a follow-up?
   Default: include — same defect, one condition, same section of the code.
2. New ADR, or guide and Trap entry only? Default: the ADR, because the
   rich-paste ADR's "HTML → HTML is sanitised" would otherwise read as covering
   this case.
3. Should HTML source text pasted into Typst/AsciiDoc stay converted? Default:
   yes, unchanged (see Non-scope).
