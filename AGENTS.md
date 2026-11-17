# Working on MDraft

MDraft is a Rust/Tauri 2 application with a TypeScript/Vite frontend. There is
no HTTP server or Node runtime in the shipped application. The frontend calls
Rust filesystem commands through `src/api.ts`. See [architecture](docs/architecture.md),
[contributing](CONTRIBUTING.md), and the [script catalog](scripts/README.md).

## Workspace isolation

One agent works in one checkout at a time. Never run two agents in the same
working tree, and never switch branches in a checkout another agent is using.
For every task that changes files, use a dedicated worktree:

```powershell
git fetch origin
git worktree add ../MDraft-work/<short-slug> -b <type>/<short-slug> origin/master
cd ../MDraft-work/<short-slug>
git status --porcelain   # must be empty
```

Uncommitted changes belong to the checkout, not to a branch. Before any `git
switch` or `git checkout`, `git status --porcelain` must be empty. If the tree
is dirty, stop: commit on the current branch, move the work with a patch, or ask
the owner. Do not carry another task's changes onto a new branch, and do not
branch from another agent's branch.

If you discover you are on the wrong branch after editing, do not switch: stop
and report it. Recovering those edits onto a branch is an explicit owner
decision.

## Branch policy

`master` is protected and read-only for agents. Never edit or commit while
`master` is checked out. Start every task that changes files on a topic branch
created from an up-to-date `origin/master`, in a clean checkout (see [Workspace
isolation](#workspace-isolation)):

```powershell
git fetch origin
git switch -c <type>/<short-slug> origin/master
```

Read-only investigation, builds and tests may run on `master`. "Implement
directly" in this file means implement on a topic branch and open a pull
request; it never authorises a commit on `master`. A task is not done until the
work is on its own branch, pushed, a PR is open, and `git status` is clean (or
the owner explicitly asked you not to push). If a command fails because
`master` is protected, do not retry, force, or bypass it: move the changes to a
new branch and continue there.

A local `pre-commit` guard and an OpenCode branch-guard plugin enforce this. Do
not use `--no-verify` or disable either to work around it.

## Scope and approval

Obtain owner approval of a written plan before refactoring, architectural changes,
changes spanning more than three files, dependencies, public contracts, or work
that is hard to undo. Public contracts include Tauri command names/arguments/results,
API wrappers, existing settings compatibility, document dialects, menu events,
and accelerator/menu-state payloads. Write no plan for an obvious local fix;
implement it on a topic branch (see [Branch policy](#branch-policy)) and run the
cheapest meaningful check.

Owner records live in a separate private checkout. Owner sessions may load
`AGENTS.md` from `MDRAFT_OWNER_DOCS`, or from the sibling `../MDraft-owner` when
present. Plans, ADRs, audit results, handoffs, backlog, trap records, research,
personal samples, and raw captures belong there. Record approval and execution
status durably in that private plan. If private storage is unavailable, present
the proposal to the owner and wait for the required approval; do not create
internal records in this public checkout. Contributors can build and test without
the private repository. Never attach it as a nested repo, submodule, or link.

## Product requirements

- Preserve the README's no-telemetry and no-startup-network policy and its explicit
  user-initiated exceptions. Do not add background network activity or an account.
- Every preference must work. Explain unimplemented behavior as a note rather
  than exposing a control that does nothing.
- Sanitize filenames, paths, URLs, and clipboard data at their boundaries. Fail
  safely when a source mapping cannot be proved.
- Comments explain non-obvious reasons. Keep legally required license notices.

## Build and test

Use npm and Node 24 for app-free TypeScript suites. Run checks in increasing
cost, starting with the smallest relevant layer. `npm run build` typechecks and
bundles; `npm test -- --list` lists functional layers. Do not run the entire UI
suite for a copy, CSS, or narrowly scoped fix.

On Windows every cargo/Tauri invocation goes through the MSVC wrappers:

```powershell
.\scripts\with-msvc.cmd npm run tauri dev
.\scripts\cargo-vcvars.cmd test --manifest-path src-tauri\Cargo.toml
```

Use the isolated test harness for GUI checks. Do not delete or reset the owner's
settings, prompts, profile, or sessions. The harness refuses a running user app;
a different port or webview folder does not isolate the app identifier.

CDP scripts take the port as `argv[2]`, call `Runtime.enable` first, request
`awaitPromise` for asynchronous expressions, check `exceptionDetails`, print
PASS/FAIL per assertion, and exit nonzero on failure. Test/capture outputs go
to a temporary directory, never a tracked asset.

## Publication hygiene

Keep required synthetic fixtures and public assets in
`scripts/fixtures/public-assets.json`, with a concrete test/publication purpose.
New scripts must be described in `scripts/README.md` and the optional private
catalog. Record non-obvious recurring traps in private owner records, including
the literal error and the incorrect conclusion the investigation ruled out.

Before committing, run `npm run repo:hygiene`, `npm run security:scan` and
`npm run format:staged` on the staged index. Before pushing, also run the other
checks CI's Quality workflow runs for the layers you touched: `npm run lint` and
`npm run knip` for TypeScript, clippy with `-D warnings` for Rust; `npm run build`
alone does not check formatting. Install the local hooks with
`npm run security:hooks`; pre-push checks every outgoing ref and its history. Push only a topic branch and open a
pull request; the local `pre-commit` guard refuses a commit on `master`. Ignore
rules alone do not remove tracked files or protect against forced additions.
Use NUL-delimited Git I/O.

Never commit credentials, environment files, signing keys, app state, generated
exports/profiles, private records, raw screenshots, or unapproved samples. A
verified history backup belongs outside the public checkout. History/ref changes,
force pushes, remote security settings, and deleting published assets require
explicit approval of the concrete operations unless already authorized.
