# An AsciiDoc reference document in the Help menu

**Status:** done
**Date:** 2026-10-18
**ADR:** none

## Context and goal

`Help › Markdown Reference` opens a built-in Markdown document that shows the
syntax this editor renders. AsciiDoc is now a first-class document language with
its own preview features, but the Help menu still has no equivalent, so a reader
has to discover admonitions, tables, includes, `:toc:`, LaTeX and AsciiMath by
guessing.

The goal is a second built-in document, `Help › AsciiDoc Reference`, that is
opened in AsciiDoc mode and shows the syntax and features the preview actually
supports. It should be closer to a real AsciiDoc cheat sheet than the Markdown
reference, without documenting constructs the preview does not honour.

## Scope and non-scope

In scope:

- A real `samples/asciidoc-reference.adoc` file: title, `:toc:`, `:stem:`,
  sections, formatting, links, lists, tables, admonitions, quotes, listings,
  images, includes, math in both dialects, diagrams, and a short limits section.
- `ASCIIDOC_REFERENCE` in `content.ts`, imported with `?raw` so the source file
  is the single copy and can be converted in a test.
- A `help.asciidocReference` menu item next to the Markdown one.
- A `language` argument to `showBuiltin`, so the document opens as AsciiDoc
  rather than Markdown.
- A test that the reference source converts and contains the expected blocks,
  plus the menu/typecheck layers.

Out of scope:

- A Preferences button for the AsciiDoc reference. The existing Preferences
  button stays Markdown-only.
- Documenting AsciiDoc features the preview does not implement (for example
  include attributes or `:eqnums:` for ordinary stems).
- A new accelerator, a new command, or an export path.

## Approach and rejected alternatives

The reference is a **real `.adoc` sample imported with `?raw`**, not a string
array in `content.ts`. The Markdown reference is a line array because its fences
contain backticks; AsciiDoc has no such escaping problem, and a real file lets a
Node test read and convert exactly what the menu opens. Vite bundles the raw
text, so the built-in document needs no filesystem access at runtime.

`showBuiltin` gains an optional `DocumentLanguage` argument. Markdown remains
the default, so the existing call sites and Preferences do not change. The menu
item reuses the same generic menu event handler; no Rust command is added.

Rejected:

- Inline line arrays in `content.ts`: unreadable for a 200-line AsciiDoc file
  with backslashes and listing blocks, and impossible to convert directly in a
  test.
- A second Preferences link: the request is the Help menu, and the Preferences
  host's `openDocumentation` union would grow without a user-visible need.
- Documenting every AsciiDoc feature including unimplemented ones: that would
  turn a reference into a list of broken promises.

## Steps

- [x] 1. Write `samples/asciidoc-reference.adoc` covering the supported syntax.
- [x] 2. Import it with `?raw` and export `ASCIIDOC_REFERENCE` from
      `content.ts`; update the file's header comment.
- [x] 3. Add `help.asciidocReference` to the Help submenu.
- [x] 4. Add the `language` parameter to `showBuiltin` and route the new id to
      `showBuiltin(ASCIIDOC_REFERENCE, "asciidoc")`.
- [x] 5. Add the reference checks to the AsciiDoc suite; update the suite count
      in `AGENTS.md`.
- [x] 6. Run the typecheck, Rust check and AsciiDoc suite.

**Outcome (2026-10-18):** `npm run build` passed; `cargo check` passed;
`node scripts/test-all.mjs --only asciidoc --no-build` passed **43/43 checks**.
The new checks emit `help.asciidocReference`, confirm the preview heading,
admonitions, table, three stem blocks, TOC and Mermaid diagram. The source file
converts with no error under `safe: "secure"`.

## Files and modules

- `samples/asciidoc-reference.adoc` — the document itself.
- `src/content.ts` — the raw import and the new export.
- `src-tauri/src/menu.rs` — the Help menu item.
- `src/main.ts` — the event handler and the `language` argument.
- `scripts/asciidoc-test.mjs` — checks that the source converts and has the
  promised blocks.
- `AGENTS.md` — the suite count.

## Risks and rollback

- The reference could document something the preview rejects. The conversion
  test and a fixture load catch a broken block before the menu is used.
- The raw import adds the document to the startup bundle. It is a few kilobytes
  of static text, like the Markdown reference, and the built-in help must be
  available instantly; no lazy chunk is warranted.
- Opening a built-in AsciiDoc document could use the Markdown grammar if the
  language argument is missed. The `showBuiltin` signature makes the language
  explicit at the new call site, and the test checks the file's title/markers.
- Rollback: remove the sample, the import/export, the menu item and the handler;
  the existing Markdown reference is untouched.

## Tests and validation

- `npm run build` — typecheck, including the `?raw` import and the new handler.
- `.\scripts\cargo-vcvars.cmd check --manifest-path src-tauri\Cargo.toml` — the
  menu builder compiles.
- `node scripts/test-all.mjs --only asciidoc` — the suite, including new checks
  that read `samples/asciidoc-reference.adoc`, load it with Asciidoctor under
  `safe: "secure"` and assert the title, a table, an admonition, a listing and
  a stem block.
- The one measurement that proves the reference is honest: every live example
  in it converts without an error and the expected block classes are present.

## Acceptance criteria

- `Help › AsciiDoc Reference` opens a document whose preview heading is
  `AsciiDoc Reference` and whose editor is in AsciiDoc mode.
- The document shows, live: a TOC, headings, formatting, lists, a table,
  admonitions, a quote, source and literal listings, a diagram, a LaTeX formula
  and an AsciiMath formula.
- The conversion test finds at least one each of `.admonitionblock`, `table`,
  `.listingblock` and `.stemblock`.
- The source documents images/includes in code blocks, not as live examples
  that would need a document directory.
- The reference states the limits: `include::` is local-only, `:eqnums:` does
  not number ordinary stems, and `stem:[…]` follows `:stem:`.

## Open questions

- Should Preferences also link to the AsciiDoc reference? Default: no; the Help
  menu is the requested surface.
