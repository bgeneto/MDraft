# Working on MDraft

MDraft is a Rust/Tauri 2 application with a TypeScript/Vite frontend. There is
no HTTP server or Node runtime in the shipped application. The frontend calls
Rust filesystem commands through `src/api.ts`. See [architecture](docs/architecture.md),
[contributing](CONTRIBUTING.md), and the [script catalog](scripts/README.md).

## Scope and approval

Obtain owner approval of a written plan before refactoring, architectural changes,
changes spanning more than three files, dependencies, public contracts, or work
that is hard to undo. Public contracts include Tauri command names/arguments/results,
API wrappers, existing settings compatibility, document dialects, menu events,
and accelerator/menu-state payloads. Write no plan for an obvious local fix;
implement it and run the cheapest meaningful check.

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

Before committing, run `npm run repo:hygiene` and `npm run security:scan` on the
staged index. Install the local hooks with `npm run security:hooks`; pre-push
checks every outgoing ref and its history. Ignore rules alone do not remove
tracked files or protect against forced additions. Use NUL-delimited Git I/O.

Never commit credentials, environment files, signing keys, app state, generated
exports/profiles, private records, raw screenshots, or unapproved samples. A
verified history backup belongs outside the public checkout. History/ref changes,
force pushes, remote security settings, and deleting published assets require
explicit approval of the concrete operations unless already authorized.
