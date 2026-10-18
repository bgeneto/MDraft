# Contributing to MDraft

Bug reports, documentation fixes and pull requests are welcome. The project is
small enough that a clear report or a focused patch is more useful than a large
one.

## Before you start

Open an issue before working on a refactor, an architectural change, a public
command or settings-schema change, a new dependency, or anything that is hard
to undo. [AGENTS.md](AGENTS.md) records the project's governance and the
working rules; it is the detailed guide for the codebase, the tests and the
release process.

For a focused bug, a typo, a CSS fix or a documentation correction, just make
the change.

## Reporting a problem

Include:

- the MDraft version (visible in **Help › About MDraft**);
- the operating system and, for Linux, the distribution;
- the document format and, if it matters, a small sample document;
- what you did, what you expected, and what happened instead.

Do not attach a document you cannot share. A reduced sample is almost always
enough. For a rendering problem, a screenshot of the application is helpful.

## Development setup

You need:

- **Rust** 1.91 or newer.
- **Node.js** 20 or newer and npm. This repository uses npm, not pnpm.
- **Windows:** Visual Studio C++ build tools, the Windows SDK, and the WebView2
  runtime.
- **Linux:** `libwebkit2gtk-4.1-dev`, `libjavascriptcoregtk-4.1-dev`,
  `libsoup-3.0-dev`, `libgtk-3-dev`, `librsvg2-dev`, `libayatana-appindicator3-dev`,
  `libhunspell-dev` and `patchelf`.
- **macOS:** Xcode command line tools. No macOS release is published, but the
  source includes a macOS bundle configuration.

Install the frontend dependencies and start the development application:

```bash
npm install
npm run tauri dev
```

On Windows, run every cargo or Tauri command through the MSVC wrapper. It loads
`vcvars64.bat` so the compiler can find the Windows SDK:

```powershell
.\scripts\with-msvc.cmd npm run tauri dev
.\scripts\cargo-vcvars.cmd check --manifest-path src-tauri\Cargo.toml
```

`npm run dev` starts the Vite frontend alone, which is enough for rendering work
that does not call into Rust.

## Tests and builds

The full suite builds first, then launches each UI suite in its own instance
with its own fixture and clean first-run state. It restores the working tree and
your settings afterwards.

```bash
npm test
npm run test:rust
npm run build          # typecheck and bundle the frontend
npm run dist           # build, bundle and stage into bin/<os>/<arch>/
```

`npm test` takes a while. `--only`, `--skip` and `--no-build` narrow a run; see
the command's help or [AGENTS.md](AGENTS.md) for the layers and their fixtures.
The CDP-driven UI suites are Windows/WebView2 only; on Linux, `cargo test` plus
a manual launch are the automated coverage. Close a running copy of the
application before `npm run dist` on Windows, because Windows locks the
executable cargo has to replace.

Linux builds have to run on Linux: WSL2, a container or a Linux machine.
`scripts/build-linux.sh` copies the sources to the Linux filesystem, builds the
frontend when Node is available, and stages the `.deb` and AppImage.

## Code and documentation

- `src/` is the TypeScript frontend: the editor, previews, paste pipeline,
  preferences, sidebar, document sessions and styles.
- `src-tauri/src/` is the Rust backend: files, settings, menus, images, export,
  Typst, spelling and the HTML preview scheme.
- `docs/guide.md`, [docs/export.md](docs/export.md) and
  [docs/typography.md](docs/typography.md) are the user-facing detail. Update
  them when a feature's behaviour changes.
- `samples/` holds fixtures used by the screenshots and the UI suites.

When changing the UI, capture a new screenshot rather than describing it in the
abstract. On Windows, `scripts/screenshot.mjs` drives a running window over the
WebView2 DevTools protocol; the Linux WebKitGTK build has no CDP endpoint. The
README images are in `docs/screenshots/`; the documents they show are
`samples/tidewater-field-notes.md` and `samples/tidewater-guide.adoc`.

## Pull requests

- Keep the change scoped to one problem.
- Add or update the test that would fail without it.
- Run the cheapest layer that can catch the mistake. For a UI-only change,
  `npm run build` plus a relevant suite is usually enough; for backend behavior,
  `npm run test:rust` is the first stop.
- Update the affected documentation in the same change.
- Do not commit `bin/`, `dist/`, `node_modules/` or captures from
  `docs/screenshots/` that the README does not use.

## License

MDraft is released under the MIT License. By contributing, you agree that your
contribution can be distributed under the same terms. See [LICENSE](LICENSE).
