# Organize the agent guide by topic

**Status:** done
**Date:** 2026-11-08
**ADR:** none; this organizes maintainer documentation without changing product architecture.

## Context and goal

`AGENTS.md` is currently 306,406 bytes. Its instructions, script catalog, test
descriptions and troubleshooting history are loaded together even when an agent
needs only one of them. The Traps section alone is 184,907 bytes. The root guide
also has uncommitted edits, including script descriptions and traps, which are
part of the material to preserve.

Make the automatically discovered root guide small and route agents to specific
topics on demand. An agent solving one problem should not need to load the full
script catalog, testing inventory or troubleshooting history to do so.

## Scope and non-scope

- Organize the existing agent-facing content into a short root guide and
  focused documents, including separate script/test catalogs and categorized
  trap records. Preserve the existing instructions, examples, command
  descriptions, test inventories and trap entries, including the current
  uncommitted changes.
- Repair links affected by moving content. Keep existing root heading fragments
  usable, including links from completed plans and external references, and
  make currently maintained contributor guides point directly to relevant
  topics where useful.
- This is a documentation reorganization, not a change to policy, application
  behavior, dependencies, test counts or historical decisions. Do not rewrite
  completed plans or ADRs. Do not create another automatically discovered
  `AGENTS.md` under the new guide directory.

## Approach and rejected alternatives

Keep `AGENTS.md` as the always-loaded entry point: concise, globally applicable
rules; the existing heading anchors as short pointers; and explicit instructions
to read only the guides relevant to the task. Keep the approval triggers,
network and UI invariants, and obligations to document scripts and record traps
discoverable there. The detailed policies remain authoritative in the linked
workflow guide. Keep the Windows toolchain and test-state warnings prominent
enough to be found before the corresponding commands are run.

Put the detailed material under `docs/agent-guide/`, divided by purpose. Split
the existing scripts and test tables by topic, with a compact index and a
preserved description of test order. Split traps by problem domain rather than
moving 185 KB into a single new file. Each complete entry has one home; the
index names the domains and shows how to search them with `rg`, rather than
duplicating hundreds of symptoms in another large file. Put links between
related guides where a task spans domains.

Target at most 6 KB for the root file and roughly 24 KB or less per topical
catalog or trap file. Split an oversized topic further by a meaningful
subtopic, without cutting an entry in half; record any justified exception in
this plan. This is a navigation and context-size target, not permission to omit
details. Compare actual UTF-8 sizes before and after; use a model tokenizer only
if one is already available, and do not claim an exact token count from bytes.

Rejected alternatives:

- Keeping the entire guide in `AGENTS.md` retains the automatic context cost.
- Moving all traps or all script tables into a single file merely relocates the
  same large-read problem.
- Reducing the size by summarizing or deleting existing traps, test details or
  policies would lose information that maintainers deliberately recorded.
- Putting all details in nested `AGENTS.md` files could load unrelated
  instructions automatically and obscure which guide to consult.

## Steps

- [x] Recheck the worktree and snapshot the current `AGENTS.md` as the migration
      baseline, including any edits made after this plan was drafted. Inventory
      its headings, actual relative links, table rows and complete trap entries;
      do not replace it from `HEAD` or discard anyone else's changes.
- [x] Create the focused workflow, architecture, development, testing and
      release guides listed below. Move all original sections into their owning
      topics, preserving examples and instructions. Keep the test runner's
      documented execution order clear even when table rows live in separate
      topic catalogs.
- [x] Divide the npm commands, test harnesses and build helpers into the
      subject catalogs. Preserve every original row and its full description,
      and point the script index to each catalog. Keep the requirement to
      document new scripts and the conventions for new test scripts explicit.
- [x] Move every complete trap entry to an appropriate domain file; retain its
      literal symptom, diagnosis, fix and surrounding detail. Add a compact
      topic index and a literal-text search example. Split large domains by
      subtopic when needed, and list the additional files here before doing so.
- [x] Replace the root guide with the short entry point. Preserve its existing
      section fragments as headings with direct links to the new homes, so
      existing deep links still lead somewhere useful; retain concise mandatory
      cross-cutting instructions and route detailed questions to the guides.
- [x] Fix relative links inside moved material and update the maintained
      contributor, backlog, plan-template and ADR-index links as necessary.
      Leave historical plans and ADR records intact.
- [x] Validate content preservation, links, relevant anchors, file sizes and
      focused navigation paths. Review the diff for unrelated changes. Record
      the measured results and any deviations here, add any qualifying new trap
      to the appropriate trap guide, tick completed steps and set this plan to
      `done`.

## Files and modules

- `AGENTS.md`: short automatically loaded rules and topic links, preserving
  existing heading fragments.
- `docs/agent-guide/workflow.md`: governance, licensing and dependency
  measurement, trap-recording discipline, and project conventions.
- `docs/agent-guide/architecture.md`: orientation, code map and the
  end-to-end preference example.
- `docs/agent-guide/development.md`: prerequisites, build pipeline, Linux,
  development loop and debugging.
- `docs/agent-guide/testing.md`: test strategy, ordering, CDP setup, Linux print
  probe, assertion principles and links to the detailed catalogs.
- `docs/agent-guide/releasing.md`: releases, landing page, portable builds and
  the release checklist.
- `docs/agent-guide/scripts.md`: concise index and instructions for finding and
  documenting repository scripts and their tests.
- `docs/agent-guide/catalog/`: subject files `build-and-site.md`,
  `editor-and-documents.md`, `preview-and-sync.md`, `latex-and-formats.md`,
  `export-and-print.md`, and `ai-accessibility-and-typography.md`. Together
  they contain all original script, harness and testing-table rows, grouped by
  topic. If needed for the size target, add explicitly named subtopics and
  record them in this plan before creating them.
- `docs/agent-guide/traps.md`: compact domain index, search and recording
  pointers.
- `docs/agent-guide/traps/`: subject files `build-and-environment.md`,
  `testing-and-debugging.md`, `editor-and-ui.md`, `preview-and-sync.md`,
  `latex-typst-asciidoc.md`, `export-and-print.md`,
  `ai-accessibility-and-typography.md`, and `assets-and-site.md`. Additional
  named subtopics may be recorded in this plan if a category is too large.
- `CONTRIBUTING.md`, `docs/backlog.md`, `docs/plans/README.md`, and
  `docs/adr/README.md`: adjust only navigation statements or links affected by
  the move, if needed.
- `docs/plans/2026-11-08-agent-guide-organization.md`: this plan, results and
  implementation status.

## Risks and rollback

- An apparently successful move can omit an entry, alter a code example, lose a
  link fragment or accidentally discard uncommitted work. Compare the result
  against a snapshot of the actual worktree version, use a row/entry inventory
  and review content and links. Preserve current line endings where practical.
- A terse root could make mandatory rules easy to miss. Keep the essential
  cross-cutting rules and plan triggers visible there and make topic links
  describe when they are needed.
- A category can be ambiguous. Choose one owning file, use cross-links where
  useful and support literal searches across all trap files.
- Roll back only this reorganization from the captured pre-move snapshot and
  remove only files created for it. Do not use a blanket reset or restore from
  `HEAD`, which would discard pre-existing changes to `AGENTS.md` or other work.

## Tests and validation

- Compare original and final inventories of section content, table rows, code
  blocks and complete trap entries, allowing only intentional relocation,
  cross-link edits and the new brief navigation text. Explicitly check the
  pre-existing uncommitted script and trap additions remain present.
- Check actual local Markdown links and heading fragments from the changed
  guides, including the existing links into `AGENTS.md`; ignore examples inside
  code blocks. Verify the root's old heading anchors still reach a pointer to
  the appropriate new location. No network access is needed.
- Measure the root and each new guide in UTF-8 bytes, report the before/after
  root reduction, and review oversized topics. Test representative navigation:
  a small local fix, locating a script/test, and investigating a PDF or LaTeX
  trap should each require the root plus only the relevant guide(s).
- Run targeted whitespace/diff checks and inspect the changed documentation.
  Application, Rust and full UI suites are not needed for documentation-only
  moves; report them as skipped. If implementation changes code or behavior,
  update this plan and its validation before expanding scope.

## Results

Measured 2026-11-08 against the worktree snapshot taken at the start of this
plan (`AGENTS.md` was 306,406 bytes, matching the draft's figure).

**Root reduction.** `AGENTS.md` is now **23,115 bytes**, down from 306,406 —
a **92.5%** reduction. The 6 KB target was **deliberately exceeded** (see
Deviations).

**New guides**, all UTF-8 bytes:

| File | Bytes |
| --- | --- |
| `docs/agent-guide/workflow.md` | 9,169 |
| `docs/agent-guide/architecture.md` | 11,135 |
| `docs/agent-guide/development.md` | 9,560 |
| `docs/agent-guide/testing.md` | 13,998 |
| `docs/agent-guide/releasing.md` | 11,290 |
| `docs/agent-guide/scripts.md` | 2,729 |
| `docs/agent-guide/traps.md` | 5,490 |
| `docs/agent-guide/catalog/` (6 files) | 5,184–24,988 |
| `docs/agent-guide/traps/` (15 files) | 6,636–21,143 |

Total for `docs/agent-guide/`: 333,504 bytes across 28 files. Every file is
under the 24 KB topical target except `catalog/editor-and-documents.md` at
25,091 bytes (see Deviations).

**Content preservation.** Verified mechanically against the snapshot:

- All **278** complete trap entries are present verbatim in their domain file,
  matched by exact text containment. Two entries differ only in a repaired link
  target (the `#recording-traps-is-required` pointer and the `build-linux.sh`
  row's `#building-for-linux` link), which is the intended link fix.
- All **214** table rows from the original script, harness, helper and
  testing-layer tables are present verbatim somewhere in the guides, compared
  with link targets normalised. The one difference is the same
  `build-linux.sh` row's link target.
- **34 of 37** sampled distinctive prose sentences matched literally; the other
  three matched once case and rewording were accounted for (`no HTTP server`,
  the "add a script" obligation, and `check-version.mjs` runs first).

**Links and anchors.** A checker resolved every relative Markdown link and
heading fragment across the changed files, ignoring fenced code and inline code
spans: **220 links checked, 0 problems**. The three apparent "missing file"
hits were `[text](href)`-style examples inside backticks and were correctly
skipped once inline code was masked.

**Old root fragments.** All **32** heading fragments the old `AGENTS.md`
exposed still resolve: 20 remain headings in the new root, 11 resolve to a
heading in a guide, and the MSVC wrapper heading was kept in the root as a
`###` heading so its deep link still lands.

**Navigation paths.** A small local fix needs the root alone. Locating a
script or test needs the root plus `scripts.md` plus one catalog file.
Investigating a PDF or LaTeX trap needs the root plus `traps.md` plus one
domain file. No path requires opening the full catalog or the full trap record.

**Whitespace and scope.** No trailing whitespace in the changed documents; all
new files are LF-only, matching the repository. `git status` shows no
application code, dependency or unrelated file modified by this change; the
pre-existing worktree edits (`docs/export.md`, `docs/guide.md`, `package.json`,
`scripts/*`, `src/*`, and the untracked scripts) are untouched.

**Skipped, as the plan allows for a documentation-only move:** `npm test`, the
Rust suite and the UI suites. No code, dependency or behaviour changed, so the
cheapest meaningful check was the link/anchor/content validation above.

## Deviations

1. **The root is 23 KB, not 6 KB.** The target was a navigation and
   context-size goal, and the maintainer explicitly chose fidelity over it: the
   approval triggers, the exact network exceptions, the full prerequisite list,
   the MSVC `C1083` warning and the release checklist stay at full text in the
   root, because those are the rules an agent must not miss. Every section
   still routes to its detailed guide. The root is 92.5% smaller, which is the
   context cost this plan set out to remove.
2. **Two trap domains were split beyond the plan's initial list.** The plan
   allowed additional named subtopics if a category was too large. The trap
   record therefore has 15 files rather than 8: `build-and-environment` split
   into `toolchain-and-lint` (compiler versions, Clippy, ESLint, Prettier,
   CI-only failures), `builds-and-packaging` (bundle, staging, installer,
   release artefacts) and `processes-and-app-state` (launched instances, leaked
   processes, the WebView2 profile, settings and recovery state); the harness
   material split into `test-runner` (`scripts/test-all.mjs` itself) and
   `test-harness` (individual suites); `debugging-probes` split into
   `dom-measurement` (layout, selection, focus, visibility) and the remaining
   CDP driver/stub material; and `paste-and-images` was separated from
   `editor-and-ui` because rich paste and image destinations are a distinct
   subject. Each split was made to keep every file under the 24 KB target.
3. **`catalog/editor-and-documents.md` is 24,988 bytes**, 1 KB over the
   topical target. It is one file because splitting the editor, tabs, favorites,
   menus, paste and image rows would separate suites that a single change to
   `src/main.ts` routinely needs together. The excess is small and the grouping
   is the useful one; it is recorded here rather than split.
4. **`docs/agent-guide/traps.md` keeps the trap-recording rules**, not only the
   index. The root states the obligation and links here; the qualification
   rules, entry format and search examples live in this file so the root stays
   navigational.

## Acceptance criteria

- `AGENTS.md` is at most 6 KB, describes the essential always-applicable rules,
  and links clearly to task-specific documentation without instructing agents
  to read every file.
- Every existing section, script/test table row, code example and complete trap
  entry remains available, including the changes already present in the
  worktree; all real moved links and existing root fragments resolve.
- An agent can find scripts, test guidance and relevant traps by subject or
  literal search without opening an unrelated full catalog. Topical files meet
  the size target or have a documented reason for exceeding it.
- No application code, behavior, dependencies, existing historical decisions
  or unrelated worktree changes are modified.

## Open questions

None. Use the categories above as the initial organization, refining a
category into named subtopics if its measured size warrants it.
