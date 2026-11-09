# Workflow, governance and conventions

How a change is agreed, measured and recorded in this repository. Read
this before editing code that needs a plan, adding a dependency, or
finishing a task that taught you something non-obvious.

Related: [architecture.md](architecture.md) for where code lives,
[testing.md](testing.md) for the layers, [traps.md](traps.md) for the
trap record and its recording rules.

## Governance and workflow

**A plan needs approval before code is edited when any one of these holds:**
refactoring; an architectural change; more than three files; a public contract
change — a `#[tauri::command]` name, argument or return shape, its `src/api.ts`
wrapper, the `settings.json` schema (an existing file must keep loading), the
markdown dialect existing documents rely on, a menu event name, or the
`accelerators`/`menu_state` payload a test reads; a new dependency, whether npm,
cargo or a bundled font; something hard to undo, such as renaming
`productName`/`identifier` (which moves every install's settings) or rewriting
the release workflow; or the user asks for a plan.

### Licensing: MIT today, AGPL is an allowed destination

MDraft ships under the MIT License (`package.json`, `LICENSE`). **A dependency
with a copyleft licence — GPL, LGPL or AGPL — is not on its own a reason to
reject it.** The project's position is that the licence may move to the current
AGPL if a package worth having requires it: the maintainer has stated this
explicitly, and the trade is accepted rather than avoided.

What follows from that, in order of how often it matters:

1. **Size and performance decide, not the licence.** A dependency is judged on
   what it adds to the installer and to typing latency. Those numbers are
   measured and recorded in the plan that introduces it; "it is only 50 KB" is
   not a measurement, and neither is "it is AGPL so we cannot". See
   [Measuring a dependency](#measuring-a-dependency) for the method.
2. **Relicensing is a deliberate act, not a side effect.** Do not add a
   copyleft dependency and leave the licence files untouched: that makes the
   shipped artefact's terms ambiguous. A change that introduces one either
   (a) keeps the dependency out of the distributed bundle, (b) is accompanied by
   the licence change in the same branch — `LICENSE`, `package.json`,
   `README.md`, `CONTRIBUTING.md` and the About box — or (c) is not merged.
3. **The licence text is not a build input.** Nothing in the code reads the
   licence, so a licence change touches documents only and cannot break a build.
   The one exception is a dependency whose licence forbids the *use* we make of
   it, which is a legal question, not a build one.
4. **Record the reason.** When a copyleft dependency is taken, the ADR or plan
   says which one, its licence, its measured cost, and whether the application's
   own licence changed. A later reader must be able to tell why.

At the time of writing, `codemirror-lang-latex` (AGPL-3.0-or-later from 0.5.0) is
the concrete case: it is a candidate for the completion work, and the open
question is its **60 KB gzip** cost, not its licence.

### Measuring a dependency

Every "is this worth it" question in this repository is answered with numbers
from the real build, not from a package's README:

- **Bundle cost.** Build it alone with esbuild, minified, with the CodeMirror
  peers external, and report raw + gzip. Then build the *entry point we would
  actually import* — a package that tree-shakes well and one that does not look
  identical in its own README and differ by 40 KB here. `codemirror-lang-latex`
  is the cautionary example: importing only its completion source still pulls
  ~60 KB gzip because that module imports the parser utilities.
- **Runtime cost.** Typing latency on the 1.2 MB fixture from
  `preview:perf`, with the feature on and off.
- **Installer cost.** The staged binary in `bin/<os>/<arch>/` before and after.
- **What it replaces.** A dependency that removes more code than it adds is
  usually worth taking; one that duplicates an existing module is not.

Record all four in the plan. A dependency whose cost is not measured is not
approved, whatever its licence.

**No plan — implement directly**, for example: UI copy; CSS; an obvious local JS
fix; renaming a variable; a typo; a message or validation tweak; a bug confined
to one file. Do not write a plan, do not ask for approval, and do not run the
whole `npm test` out of habit: make the smallest change that fixes it, validate
with the cheapest layer that can catch the mistake, and report what you ran and
what you skipped.

When the two cases are not obvious, ask in one line — "implement directly, or do
you want a plan?" — rather than producing a plan out of caution.

When a plan is required:

1. Investigate the relevant code first, read-only.
2. Write the plan to `docs/plans/YYYY-MM-DD-short-slug.md`, following the
   template in `docs/plans/README.md`.
3. **Stop and wait for explicit approval** before implementing anything.

The plan format: context and goal; scope and non-scope; approach and rejected
alternatives; ordered steps as a checklist; affected files and modules; risks and
rollback; test and validation strategy; acceptance criteria; open questions;
status (`draft`, `approved`, `in progress`, `done`). Set the status to `approved`
when approval arrives: the file, not the conversation, is what a later session
can read.

While executing: tick the checkboxes, record deviations in the plan itself, and
never widen the scope without updating it. An approved plan is permission to
implement its scope — not to skip the [Testing](testing.md) layers or the
[Traps](traps.md) discipline. A durable architectural decision — where a
responsibility lives, a command's shape, a format that outlives the change —
becomes an ADR in `docs/adr/YYYY-MM-DD-slug.md` (template in
`docs/adr/README.md`); ADRs are superseded, never rewritten. When the work is
done, update the status and the documentation the change touched, and leave the
plan in `docs/plans/` as the record of what was agreed.

## Recording traps is required

The [Traps](traps.md) section is the most valuable part of this file: every entry
in it is time that somebody already lost. **If you lose time to something that
was not obvious, add it to Traps before you finish the task.** Do not wait to be
asked, and do not decide it is too small. The entry that saves the next agent an
hour is usually the one that felt embarrassing to write down.

An event is a trap when all three hold:

1. **You were wrong, or a tool lied to you.** A build failed for a reason
   unrelated to your change; a measurement said one thing and reality said
   another; you reached a confident conclusion that turned out to be false.
2. **It is not obvious from the code, the error text, or the documentation.** If
   the message already says exactly what to fix, it is not a trap.
3. **It can happen again** to another agent working in this repository. If it was
   a one-off caused by your own typo that the compiler caught immediately, leave
   it out.

Write the entry as **symptom → cause → fix**, using the literal error text when
there is any:

```markdown
**<the symptom, exactly as you first saw it>**
<what actually caused it>. <what to do instead, concretely>.
```

Three things make an entry good, and all three were learned by writing bad ones:

- **Quote the literal error or the literal measurement.** "The build failed" is
  useless; `C1083: cannot open include file 'windows.h'` is searchable.
- **Say how you found it when that is the reusable part.** "Instrument the Rust
  side with `eprintln!` and redirect stderr" helps the next agent far more than
  the conclusion alone.
- **Record the false conclusion you almost published**, not just the final
  answer. Three of the entries below exist because a first diagnosis was wrong,
  and that wrong turn is what a future agent will repeat.

Do not put a trap here when it belongs somewhere more specific: a wrong
`bundle.icon` path belongs in a fix and a test, not in a list of symptoms. Traps
are for knowledge that has no natural home in the code.

## Conventions

- **Comments explain why.** The code says what it does. Comments in this repo
  record the reason a non-obvious choice was made, and the failure it prevents.
- **Record the traps you hit.** Anything that cost you time for a non-obvious
  reason goes into [Traps](traps.md) before you finish, and every new script goes
  into [Repository scripts](scripts.md). Both sections are contracts with
  the next agent, not summaries for the reader.
- **Fail safe, not silent.** The line-anchor mapping drops the whole annotation
  when a token does not line up, rather than pointing at the wrong line. Keep
  that instinct.
- **Sanitise at the boundary.** Filenames, URLs and clipboard content are
  hostile until proven otherwise. `src-tauri/src/images.rs` is the reference for
  how much paranoia is expected, and each property has a test.
- **No dead controls.** Unimplemented options are `note` rows.
- **Relative paths in prose.** Link files by name, not absolute path.
