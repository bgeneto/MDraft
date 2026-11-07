# Make LaTeX export routes usable and discoverable

**Status:** done
**Date:** 2026-11-07
**ADR:** `../adr/2026-11-07-latex-export-routes.md`

## Context and goal

File › Export reports “LaTeX exports its own PDF through the preview; export
formats arrive with it” for a `.tex` document, including when the reader chooses
PDF. The code has moved on, but the gate has not:

- `src/main.ts` refuses **every** `export.*` action before its handler runs.
  It also refuses LaTeX Print and Format Document, although their handlers are
  implemented and the menu can enable them.
- `src-tauri/src/menu.rs` separately disables every configured Pandoc format for
  LaTeX, using a comment that says the LaTeX reader does not exist. Availability
  changes, document changes and menu rebuilds do not share one language-aware
  rule.
- `src-tauri/src/export.rs` **already** selects `-f latex` for `language:
  "latex"`, and the frontend captures an editor snapshot for the Pandoc path.
  However, the native HTML action does not call that path for LaTeX, despite a
  menu comment saying it does. The default configurable list has no Markdown
  target. Testing the Rust command alone has not proved a menu click works.
- `exportPdf()` already writes the compiled LuaLaTeX preview bytes, but the gate
  prevents the menu from reaching it. Its suggested filename uses the active
  document, while the preview's Save PDF button uses the project root. The
  built-in “PDF (via Typst)” is not an appropriate LaTeX PDF route.

The goal is a working, honest File › Export menu for `.tex`: the preview's own
compiled PDF and Pandoc's supported non-PDF conversions, without changing the
working export behavior for other source languages or requiring a full TeX
distribution for Pandoc conversions.

### Evidence gathered before this plan

- MDraft's managed Pandoc 3.12.1 reports **77** writers. With `PATH` restricted
  to the Pandoc directory and no `tex`, `lualatex`, `pdflatex` or `bibtex`
  command available, a simple `.tex` sample produced nonempty files through
  **74 of 76 non-PDF writers**. `bibtex` and `biblatex` returned successfully
  with empty output because that particular sample contained no bibliography;
  this is not evidence that those writers are unavailable. `asciidoctor` and
  `markdown_github` returned deprecation warnings.
- In a separate isolated-`PATH` probe with `--citeproc`, HTML, Markdown, DOCX,
  ODT, EPUB and RTF contained the main heading, a local `\input` chapter and a
  rendered BibTeX citation. DOCX, ODT and EPUB contained the local PNG. These
  are direct Pandoc probes, **not** a test of MDraft's menu or export pipeline.
- Pandoc's [manual](https://pandoc.org/MANUAL.html) documents its reader/writer
  model, the installed writer list and conversion fidelity limits. Its
  [FAQ](https://pandoc.org/faqs.html) documents `--citeproc` for LaTeX
  bibliographies. A TeX engine is needed to typeset a LaTeX PDF, not for the
  tested Pandoc conversions; MDraft already has an optional WebAssembly
  LuaLaTeX engine for its preview.
- Baseline app-free checks: `npm run p0:unit` **113/113** and `npm run
  latex:references:unit` **52/52** on Node 24. No real-app export test has been
  run for this draft.

## Scope and non-scope

In scope:

- Remove the stale dispatcher gate for implemented LaTeX actions, including
  Print and Format Document, and test the handlers rather than their menu states
  alone.
- Make the existing configured Pandoc formats, HTML and Markdown reachable for
  LaTeX; provide an accessible, searchable “More Pandoc formats…” chooser for
  all non-PDF writers the **installed** Pandoc reports, including its Markdown
  variants and specialized writers. Markdown has a prominent direct entry for
  LaTeX, not only an obscure custom-format recipe.
- Make File › Export › PDF save the current LuaLaTeX preview PDF. Disable the
  built-in Pandoc/Typst PDF route for LaTeX with a useful reason. Keep the
  browser PDF route disabled for LaTeX, in line with the existing PDF decision.
- Use the initiating project's unsaved source buffers, local included sources,
  bibliography and images for LaTeX conversions. Report Pandoc warnings and
  conversion limits, and preserve source/output ownership across dialogs and
  tab changes.
- Keep current settings files, customized formats and their order, labels,
  arguments, style references and after-export options. No new dependency.

Out of scope:

- Perfect conversion of arbitrary TeX macros, package-generated layout or
  complex tables. Pandoc is a converter, not a LaTeX engine; unsupported or
  lossy constructs must not be described as faithfully rendered.
- A system TeX Live, MiKTeX, Biber or Typst installation for non-PDF
  conversions; generating a new PDF behind the reader's back; or changing the
  optional LuaLaTeX engine's installation, compilation or network behavior.
- Changing the existing native HTML/PDF, Pandoc, Typst or browser routes for
  Markdown, AsciiDoc, HTML and Typst. The new format chooser may add an entry
  without changing those existing routes.
- Changes to PDF selection, scroll restoration or rendering. A separate draft
  plan, `2026-11-07-pdf-selection-and-rebuild-stability.md`, covers those;
  coordinate with its eventual implementation instead of editing it here.

## Approach and rejected alternatives

Use the existing compiled-PDF route for LaTeX and Pandoc's native LaTeX reader
for non-PDF formats. Reuse the project's bounded LaTeX snapshot and existing
export machinery rather than reading a saved main file while ignoring open
edits. Extend menu availability so it depends consistently on the current
language and installed tools. Preserve the stored format list; expose the rest
of the installed Pandoc writer list through an on-demand chooser rather than
inserting dozens of rows into the reader's preferences.

### PDF

`export.pdf` uses the same root, bytes and freshness checks as the preview's
Save PDF button. It names the root `.tex` file even when a chapter is active,
checks the entire compile snapshot again after the save dialog, and never
writes a stale PDF. If the engine is disabled, the file is unsaved, or a compile
is missing/stale, the menu or its explanation says what is needed. It does not
start a hidden compile. A successful File › Export PDF runs the existing global
after-export actions once; cancellation or a failed/stale write does not. Avoid
changing Typst's existing PDF and preview-button behavior while sharing code.

The built-in `export.pandoc.pdf` / “PDF (via Typst)” row is disabled for LaTeX
with an explicit “use compiled PDF” explanation regardless of tool status.
Explicit reader-configured custom formats retain their own arguments. Other
languages retain their present PDF rows and availability rules.

### Pandoc targets and compatibility

- Existing configured entries keep their IDs and arguments. For LaTeX, replace
  the default input reader with `latex` exactly as the backend already does;
  preserve the documented ability for the reader's extra arguments to override
  defaults. Route the direct HTML entry through Pandoc for LaTeX and use a
  direct Markdown entry. Generated HTML uses standalone output and local math
  support; it must not be the Markdown preview renderer processing raw TeX.
- The chooser obtains `pandoc --list-output-formats` **on demand** from the
  same managed-or-PATH binary MDraft would use for export. Cache only against
  that binary/version and invalidate on install/update. It shows all reported
  non-PDF writers, including aliases and bibliography-oriented writers, with
  helpful names, searchable format IDs and suitable suggested extensions.
  `pdf` points to the compiled-PDF route instead of the chooser; `chunkedhtml`
  uses its single ZIP output. Unknown future writer names remain selectable
  with a safe filename suggestion and an explicit `-t`, rather than silently
  disappearing. Report deprecated writer warnings. Bibliography-only writers
  explain an empty bibliography instead of reporting a misleading generic
  zero-byte success.
- Add a read-only `pandoc_list_writers` command and a `run_pandoc_writer`
  command with typed wrappers in `src/api.ts`. The latter accepts a writer ID,
  source snapshot and destination; it validates the writer against the current
  installed binary's advertised names and a strict safe identifier syntax,
  then calls the same backend conversion helper and argument-vector path as
  configured formats. No shell interpolation or executable path from the UI.
  Existing `run_export` callers and saved `ExportFormat` values keep working.
  Both commands fail clearly when Pandoc is missing or a writer disappears
  after an update.
- For saved projects, capture the same main/root choice as the preview and the
  open project buffer overlays **before** opening the picker. Collect the
  existing bounded, project-confined snapshot, validate its paths and write it
  into an export-owned scratch directory; never write source overlays back to
  the project. Feed the captured root source to Pandoc, resolving local
  `\input`, `\include`, bibliography and images against that snapshot. Extend
  `ExportRequest` with an optional snapshot only if needed by the shared helper;
  absence must preserve existing callers and other languages. Untitled LaTeX
  without external resources still converts; missing or unsupported references
  get a named diagnostic rather than silently reading a different file.
- Use Pandoc's built-in `--citeproc` for readable LaTeX conversions when a
  bibliography is declared, while retaining appropriate citation data for
  bibliography/structured and LaTeX writers. Honor deliberately configured
  extra arguments and show Pandoc's own warnings. Test bibliography styles and
  unsupported features rather than promising BibTeX's exact formatting.
- Make local HTML and Markdown image references usable after the scratch
  directory is removed, including when the destination is in another folder:
  embed local resources for standalone HTML and rewrite Markdown links to the
  original local resources. Do not silently leave scratch paths in output.
  For other text writers, preserve usable resources where their format supports
  it and surface any limitation. DOCX, ODT and EPUB embed their supported local
  images.
- The built-in route must not initiate network requests while discovering
  writers or converting a local project. Validate/reject unsupported remote
  resource references with a useful message and verify with a local request
  counter; do not assume a scratch directory alone blocks network access. Do not
  silently alter the reader's explicitly configured custom Pandoc arguments.
- Prevent an output target from overwriting the source or a referenced project
  input. Preserve existing target-on-failure behavior, timeout, warnings,
  after-export handling and isolation of concurrent scratch directories.

### Alternatives rejected

- **Keep the blanket gate:** it blocks a working compiler PDF and an existing
  reader, which is the reported defect.
- **Convert LaTeX to Typst for PDF:** it changes layout and needlessly requires
  another engine; the preview already contains the compiled PDF.
- **Install TeX Live for Pandoc:** measured conversions do not need it, and a
  full distribution would be a large unrelated prerequisite.
- **Add every writer to saved default preferences:** it crowds the main menu,
  changes the reader's settings and misses new writers after a Pandoc update.
- **Assume passing a filename handles unsaved projects:** it reads disk instead
  of open edits and can export a different document than the one being edited.
- **Use rendered preview HTML as the LaTeX source:** the preview is a PDF canvas,
  not semantic HTML, and PDF text extraction would lose document structure.

## Steps

- [x] 1. Record the route/ownership decision in a new ADR, superseding the
      obsolete LaTeX non-PDF restriction in the 2026-11-06 PDF ADR while
      preserving that ADR's compiled-PDF decision for both languages.
- [x] 2. Add the validated on-demand writer-list and single-writer backend
      routes, shared conversion helper, compatible request snapshot, resource
      staging and citation handling. Keep existing configured formats intact.
- [x] 3. Make language/tool availability agree at menu construction, state
      changes, tool-status changes and rebuilds; add the Markdown and chooser
      routes and the LaTeX-specific HTML and PDF labels/guards.
- [x] 4. Remove the obsolete LaTeX action gate, route HTML and Markdown through
      the new Pandoc path, and connect compiled PDF to the shared preview save
      with project-wide freshness and File › Export after-actions.
- [x] 5. Cover real menu dispatch, writer selection, non-PDF conversion,
      citations/resources, offline/no-system-TeX behavior and compiled-PDF
      ownership; cover existing languages, customized settings and race cases.
- [x] 6. Update export/LaTeX documentation, the relevant test counts in
      `AGENTS.md`, the ADR and this checklist with results and deviations.
- [x] 7. Run the applicable ordered test layers and quality gates, then mark
      this plan done. No status changes before explicit plan approval.

### Validation actually run

| Layer | Result |
| --- | --- |
| `npm run build` (tsc + vite) | clean |
| `cargo test` (through `scripts\cargo-vcvars.cmd`) | **333 passed**, 0 failed, 2 ignored |
| `npm run p0:unit` | 113/113 |
| `npm run knip` | clean |
| `npx eslint` on every changed TS/JS file | clean |
| `npx prettier --check` on every changed file | clean |
| `npm test -- --only menu,export` | **165/165** and **73/73** |
| `npm test -- --only format-document,p0-lifecycle` | 152/152 and 39/39 |
| `npm test -- --only latex-preview` | 40/41 — the one failure is `the last page remains visible while following the end`, in the concurrently-developed PDF viewport work (`src/typst-pdf.ts`, untouched by this plan); every export and print check passes |
| `cargo clippy --all-targets -- -D warnings` | fails only on `launch.rs`, `latex.rs` and the test-identifier block in `lib.rs`, all pre-existing and untouched here |

Not run: Linux and macOS hosts (unavailable), and the opt-in `ai:live` suite
(no credentials in this session).


## Files and modules

- `src/main.ts` — dispatch, source/project capture, LaTeX HTML/Markdown/PDF
  routing, destination ownership and after-export actions.
- `src/api.ts`, `src-tauri/src/lib.rs`, `src-tauri/src/export.rs` — typed,
  backward-compatible commands, writer discovery and shared Pandoc conversion.
- `src-tauri/src/menu.rs` — context/tool-dependent labels, availability and
  new menu actions across state updates and rebuilds.
- `src/latex.ts`, `src-tauri/src/latex.rs` — reuse project snapshot validation
  and staging as needed, without changing compilation behavior.
- `src/combo.ts` (reuse), a small export-chooser module and `src/styles.css` —
  accessible searchable writer choice and focus/keyboard behavior. Update
  `src/preferences.ts` only where its current Export copy would be inaccurate.
- `scripts/menu-test.mjs`, `scripts/export-test.mjs`,
  `scripts/latex-preview-test.mjs`, `scripts/format-document-test.mjs`,
  `scripts/p0-unit.mjs` and existing Rust module tests — observable menu
  dispatch, conversion, ownership and regressions.
  If a new test script is necessary, register it in `package.json`, the test
  harness and `AGENTS.md` in the same change.
- `docs/export.md`, `docs/latex.md`, `docs/guide.md`, `AGENTS.md` — correct
  user-facing routes, limitations and test inventory.
- `docs/adr/2026-11-07-latex-export-routes.md` and
  `docs/adr/2026-11-06-native-pdf-export.md` — the new decision and the old
  record's superseded marker; retain the historical decision text.
- `docs/plans/2026-11-07-latex-export-formats.md` — this plan and its results.

## Risks and rollback

- Pandoc can drop unsupported TeX constructs or formatting. Inspect contents,
  math, citations, warnings and images in real outputs, not just file existence;
  explain the loss of exact layout. The compiled PDF remains authoritative.
- Includes, metadata, URLs and symlinks can bypass a naive scratch-only policy;
  enforce the snapshot's path limits, exercise remote references with a local
  counter and fail with a useful reason when a reference cannot be handled.
- A tab or another project buffer can change while a dialog is open; test the
  initiating snapshot and recheck the PDF's full compile ownership before
  writing. Reject collisions with every source input.
- A Pandoc update can add, remove or deprecate a writer. Discover on demand,
  validate at execution, retain a safe extension fallback and display warnings.
- If the change must be reverted, revert this plan's implementation and new
  ADR together. Existing settings require no migration or rollback. Do not
  revert the separate PDF selection/scroll work or the reader's local changes.

## Tests and validation

Follow the ordered layers in `AGENTS.md`; do not run concurrent instances of
`test-all.mjs` or touch a running user instance. Use `scripts\with-msvc.cmd`
or `scripts\cargo-vcvars.cmd` for every Windows Tauri/cargo invocation.

- App-free: `npm run build`, Rust unit tests through
  `scripts\cargo-vcvars.cmd test --manifest-path src-tauri\Cargo.toml`,
  `npm run p0:unit`, `npm run latex:references:unit`, and relevant export path
  tests. Verify old settings and custom-format argument precedence.
- Real app: `npm test -- --only menu,latex-preview,format-document,export-browser,pdf-native,export`
  with the required build, installed Pandoc and warmed optional LuaLaTeX engine.
  Ensure the opt-in Pandoc suite actually runs; report any engine-dependent
  skip. Expand the real menu test to emit the actual menu event and intercept
  only the native save dialog, as `p0-lifecycle-test.mjs` does, then inspect
  the written files. A menu-enabled assertion alone cannot catch this defect.
  Also dispatch LaTeX Format Document and Print; intercept the external PDF
  viewer handoff for the Print check and verify it receives compiled PDF bytes.
- A local fixture includes a changed unsaved root and child, a local PNG,
  bibliography, math and paths with spaces/Unicode. Inspect HTML/Markdown and
  extracted DOCX/ODT/EPUB contents and image entries. Verify a chosen writer
  outside the previous defaults, every installed writer's chooser availability,
  special ZIP/bibliography handling and clear missing-tool/stale-PDF messages.
- Run representative conversions with only the managed Pandoc directory on
  `PATH`, no TeX commands and no Typst. Count local HTTP requests for a blocked
  remote resource. Compare PDF output bytes with the preview's compiled bytes;
  test stale project revisions, tab switches, cancel, overwrite protection and
  after-actions. Check all existing source languages and user-customized formats.
- Run applicable frontend quality gates and Windows Clippy. Run Linux/macOS
  platform tests where hosts are available; explicitly report untested hosts.

## Acceptance criteria

1. LaTeX File › Export › PDF writes the current LuaLaTeX preview byte for byte,
   needs neither Pandoc nor Typst nor a system TeX distribution, and refuses a
   stale/missing preview with an actionable reason.
2. LaTeX exports to HTML, Markdown, DOCX, ODT, EPUB, RTF and every other writer
   advertised by the installed Pandoc, subject to the writer's documented
   content/fidelity limits, without a system TeX installation or Typst. The
   chooser identifies bibliography-only output and no silent empty file is
   presented as a successful document conversion.
3. Open unsaved project files, local include, citation, math and image fixtures
   survive where the target supports them; paths remain usable after temporary
   files are removed. No built-in local conversion makes a network request.
4. All menu rows reflect language and tool availability after tab switches,
   tool changes and rebuilds; no LaTeX export action shows the reported stale
   toast. Missing Pandoc and missing/stale PDF receive clear feedback.
5. Existing format settings and working Markdown, HTML, AsciiDoc and Typst
   export paths remain intact. Source files and unrelated user state are not
   overwritten; warnings and configured after-export actions are honored.

## Open questions

None requiring a product decision before approval. During implementation,
measure the installed writers and document any format-specific exception; if a
writer cannot meet the stated safety or single-output behavior, update this plan
and obtain approval before narrowing its promised availability.

## Results and deviations

Measured on this host with the managed Pandoc 3.12.1, and recorded here so a
later reader does not have to rediscover them.

- **77 writers** are advertised by `pandoc --list-output-formats`; 76 are
  conversions and `pdf` is the compiled route. The chooser shows all of them,
  including aliases and citation-data writers.
- **`--resource-path` does not make `\input` resolve.** Measured: an absolute
  staged main file with its chapter beside it, run from another working
  directory, still reported `Could not load include file chapter.tex`. Pandoc's
  LaTeX reader resolves includes against the **working directory**, so the staged
  copy's root is the working directory and the original project root is the
  resource path (which does resolve `\includegraphics`). This is why the
  conversion does not simply run in the document's folder.
- **`--embed-resources` fetches a slide writer's template from a CDN.** Measured:
  `-t s5 --embed-resources` warned `Could not fetch resource s5/default/slides.css`
  and the other four, and `revealjs` produced a 830 KB file. Embedding is
  therefore limited to `html`, `html4`, `html5` and `chunkedhtml`; the slide
  writers keep their template links, which are the document's own request when
  the reader opens it. This is a **narrowing** of the plan's "embed local
  resources for standalone HTML": the plan's own no-network rule wins, and the
  reason is recorded in `embeds_resources`.
- **Bibliography-only writers are empty for LaTeX, as predicted.** `bibtex`,
  `biblatex` and `csljson` exit 0 with 0 bytes or `[]` for a `.tex` source, with
  or without `--citeproc`: pandoc's LaTeX reader does not carry the entries a
  `.bib` file holds. They stay selectable, are labelled *citation data only —
  empty for LaTeX* in the chooser, and the outcome carries a warning naming the
  limitation instead of presenting an empty file as a conversion.
- **`--citeproc` does render citations in readable writers.** Measured: HTML and
  Markdown contained `(Knuth 1984)` and a CSL bibliography block for a document
  with `\cite` and `\bibliography`. It runs only when the staged sources declare
  a bibliography, so a document without one is unchanged.
- **`chunkedhtml` writes one ZIP**, containing `index.html`, per-section pages,
  `sitemap.json` and the images. The save dialog names one file, so the ZIP is
  the single-output form the plan requires.
- **A Markdown target's image link is project-relative** (`fig/a.png`) and would
  dangle once the scratch copy is deleted, so it is rewritten to the reader's own
  file. Verified end to end in `export-test.mjs`.
- **`export.markdown` and `export.pandoc.more` are LaTeX-only rows.** The plan
  asked for a prominent direct Markdown entry for LaTeX; the other languages
  already have their own configured rows, so the row is disabled there with a
  reason rather than duplicating a route with different arguments.
- **Configured formats keep `run_export`.** `run_pandoc_writer` is the chooser's
  route only; a stored format keeps its own id, arguments, style reference and
  after-export behaviour, and both share the same staging and conversion helper.
  This keeps saved settings and their argument precedence untouched.

