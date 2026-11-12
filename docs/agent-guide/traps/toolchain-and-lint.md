# Toolchain, lint and CI traps

Rust and TypeScript compiler versions, Clippy, ESLint, Prettier and the CI-only failures that a green local run does not predict.

Part of [the trap record](../traps.md). Search across every domain with:

```powershell
rg -n "<literal error text>" docs/agent-guide/traps
```

**CI's Quality job fails on `cargo clippy --all-targets -- -D warnings` and `npm run format:check` although `npm run check:rust`, `npm test` and `npm run build` are all green**
Nothing local applies those two gates: `check:rust` is plain `cargo check`, `test-all.mjs` runs `cargo test` without `-D warnings`, and `format:check` is not part of `npm test`. The failures were "method `len` is never used" at `src\ai\prompts_file.rs:73:12` (a `pub fn` in a private module whose only callers are `#[cfg(test)]`), two "this `if` statement can be collapsed", and `[warn] scripts/ai-assistant-test.mjs`. All four reproduced on the local Rust 1.91.1 with the same commands, so this was not the version skew described in the next entry — the gates had simply never been run. Run `.\scripts\cargo-vcvars.cmd clippy --manifest-path src-tauri\Cargo.toml --all-targets -- -D warnings` and `npm run format:check` before pushing; a green `npm test` is not evidence for either, and a release tag pushed on top of a red Quality run publishes artefacts from a tree nobody linted.

**Local Clippy passes, but CI fails with `chunks_exact_to_as_chunks` / `unnecessary_sort_by`**
The local toolchain is Rust 1.91.1 while the CI `stable` toolchain can be newer
(the first 0.5.0 run used Clippy 1.99). New warnings become errors under
`-D warnings`. Use `as_chunks::<4>().0.iter()` for the fixed-width image brands
and `sort_by_key(Reverse(...))` for descending recovery timestamps; both retain
the existing behavior and compile on the declared minimum Rust. Recheck the
current runner rather than treating a clean local older Clippy as CI evidence.

**`error: function ... is never used` on the Windows Quality runner for helpers the Linux backend calls**
`src-tauri/src/speech.rs` defines `rate_to_spd`, `spd_language`, `parse_voices` and `speak_arguments`, and their only callers are `status_blocking`/`speak_blocking`, which are `#[cfg(target_os = "linux")]`. Quality's Rust job is `windows-latest`, so on that target the four have no caller and `cargo clippy --all-targets -- -D warnings` ends with `error: could not compile mdraft (lib) due to 4 previous errors`. `npm test`, `cargo test` and `npm run check:rust` are all green — the test profile compiles the lib only as the `cfg(test)` harness, where the unit tests use them, and `cargo check` prints a warning rather than an error. Gate a platform-only helper with `#[cfg(any(target_os = "linux", test))]`: the Linux build keeps it, every test build keeps it, and Windows stops compiling it. Reproduce the gate locally with `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` before pushing. Deleting the helper "fixes" the warning by breaking Read Aloud on Linux.

**`npm run lint` fails with `no-control-regex` in `src/latex-outline.ts` and `src/paste/render-latex.ts` on an untouched checkout**
Both files contain a NUL in a regex character class (`/[\x00-\x1f]/`-style masking), which `no-control-regex` rejects. The two errors predate any change you are making and are not caused by the file you edited — run `npx eslint <your files>` to see whether your change is clean, rather than reading the repository-wide failure as yours. Do not "fix" them by rewriting the masking to a different regex: the NUL range is the point.

**`npx tsc --noEmit` fails in `src/editor.ts` or `src/latex.ts`, a file the current change never touched, and passes a minute later**
Another process was editing the same working tree: an agent session or a second editor was mid-write on a LaTeX-diagnostics feature, so the typecheck saw a half-applied patch (`Type 'Range<Decoration>' is missing …`, `'MAX_REFERENCE_DIAGNOSTICS' is declared but its value is never read`). The tell is the file's `LastWriteTime` advancing between two runs. Poll `npx tsc --noEmit` until it is clean and confirm the modification times have stopped moving before treating a build failure as yours; do not "fix" a file you did not edit. The same applies to `npm run format:check`, which listed 17 files of that in-flight work while every file this change touched was clean.

**`TypeError [ERR_UNKNOWN_FILE_EXTENSION]: Unknown file extension ".ts"` from `npm run read-aloud:unit`**
Ubuntu's Node 22 is built without TypeScript support, so it cannot import
`src/read-aloud.ts`; Node 24 strips the types. The suite is not broken. Run the
script with Node 24 when the system Node is older. Do not rewrite the `.ts`
imports to `.js` to satisfy Node 22.

**Vite fails with `EPERM: operation not permitted, realpath '...node_modules\\@asciidoctor\\core\\build\\browser\\index.js'`**
On this Windows host the sandbox can reject Vite's dependency realpath lookup
even after TypeScript succeeds. The same build succeeds outside the sandbox;
this is not evidence of a broken dependency or parser change. Request the
normal execution escalation and rerun the same build/test command without
rewriting dependencies or replacing the source file.

**`git diff --check` reports every added line of `src-tauri/src/settings.rs`, `src-tauri/src/typst.rs`, `scripts/font-sources.json` or `src/assets/fonts/fonts.json` as "trailing whitespace"**
Those files are stored with CRLF in the index (`git ls-files --eol` says `i/crlf w/crlf`) while most of the tree is LF in the index, and the repository's `core.whitespace` does not include `cr-at-eol`. The carriage return at the end of each added line is therefore read as trailing whitespace even though the text is clean. This applies to any file whose index form is CRLF, including the two font manifests. Do not normalise the file or strip the CR — that rewrites every line. Confirm with `[IO.File]::ReadAllText` if in doubt; zero LF-only line endings means the whitespace warning is the line-ending policy, not the patch.

**`ERR_PACKAGE_PATH_NOT_EXPORTED` for `@asciidoctor/core/build/browser/index.js`**
The package's `exports` map exposes only `"."`, so the browser build cannot be
imported by subpath even though the file exists. Use
`await import("@asciidoctor/core")` and let Vite's `browser` condition select
`build/browser/index.js`. The same `exports` map is why a `node_modules` path in
the import is never the answer.

**The Linux release job fails with `libhunspell not found` while Windows passes**
The release workflow's apt list omitted `libhunspell-dev`; `build.rs` probes it
with pkg-config and panics with `install libhunspell-dev`, so `cargo test` dies
before any frontend work. `scripts/build-linux.sh` already installed it, which is
why a local Linux build did not reproduce the CI failure. Add it to the
workflow's `Install the Linux system libraries` step.

**`libhunspell not found` on an agent host where `sudo` needs a password**
`build.rs` runs `pkg-config --libs --cflags hunspell` and panics by design, so
`cargo check` and `cargo test` cannot even reach the Rust code. Install the
system package when possible. Without root, `apt-get download libhunspell-dev`,
extract it with `dpkg-deb -x` into a temp prefix, and point `PKG_CONFIG_PATH` at
its `hunspell.pc`. The extracted `.so` symlink dangles (the dev package does not
carry the runtime library), so the linker then picks `libhunspell-1.7.a` and
fails with `undefined symbol: __gxx_personality_v0`; symlink the system
`libhunspell-1.7.so.0.0.1` into the extracted `lib` directory to make the shared
library win. No repository file should change for this.

**`typescript-eslint does not support TS 7.0` although `npx tsc --version` prints 7.0.2**
TypeScript 7 ships no programmatic API, so typescript-eslint needs the 6.0 API. `package.json` therefore aliases `typescript` to `@typescript/typescript6` for the linter and `@typescript/native` to TypeScript 7 for the `tsc` binary. Do not "fix" the error with `npm install typescript@latest`, which replaces the linter's API with 7 and makes ESLint abort, and do not hide it with `--legacy-peer-deps`. Verify both halves: `npx tsc --version` is 7.0.2 while `node_modules/typescript/package.json` is 6.0.x.

**`ERR_MODULE_NOT_FOUND: Cannot find module '.../src/sessions' imported from .../src/preview-owner.ts`**
A pure module with `import { pathKey } from "./sessions"` type-checks under `moduleResolution: "bundler"` and bundles in Vite, but Node 24's type stripping resolves ESM specifiers literally: an extensionless import has no file to load. Any module a `kind: "node"` layer imports must name the extension in its **runtime** imports (`from "./sessions.ts"`); type-only imports are erased before resolution, but the repository writes those with `.ts` too. The failure appears only when the node layer runs, which can be long after `npm run build` passed — run the new unit layer before believing the module is wired.

**`Code style issues found in 222 files` after running Prettier in a Git archive on Windows**
The archive inherited the host's line-ending conversion, giving the extracted
files CRLF despite this repository's LF Prettier setting. Comparing newline bytes
in the workspace and archive showed the difference; attributing the failures to
the Prettier upgrade would have been wrong. Create the archive with
`git -c core.autocrlf=false archive HEAD` before extracting it, then rerun the
check. Remaining warnings can be real baseline issues.
