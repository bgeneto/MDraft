# Build and environment traps

**Rust tests fail with `Access is denied. (os error 5)` while saving test settings, or socket tests report `os error 10013`.** On the managed Windows host, the default temporary directory can be outside writable roots and loopback sockets can be restricted. A run of the settings tests failed three filesystem cases until both `TEMP` and `TMP` were set to `src-tauri/target/test-tmp`; the full suite then passed those cases but five image download tests still failed on loopback access. The same full suite passed with loopback access outside the sandbox. These failures do not establish a settings or image regression. Use a workspace-owned temporary directory and separately report or verify any sandbox-restricted socket tests.

Toolchain, SDK, path, permission and shell problems that stop a build or a command before any application code runs.

Part of [the trap record](../traps.md). Search across every domain with:

```powershell
rg -n "<literal error text>" docs/agent-guide/traps
```

**`git diff --stat` shows every line of an edited TypeScript file as changed.**
On Windows, Python's default text-mode `Path.write_text` translates LF to CRLF,
even when the tracked file uses LF. Check `git ls-files --eol` before assuming
the change is substantive; preserve the existing line endings when editing and
write LF bytes explicitly for an LF-tracked file.

**`error: rustc 1.85.1 is not supported by the following packages:` from a WSL build even though rustup has Rust 1.91.1**
Running `wsl.exe -- ... bash scripts/build-linux.sh` without a login shell inherited a PATH that found Debian's `/usr/bin/rustc` and Node 20, not the user's installed rustup and Node 24 binaries. The compiler really was too old for that invocation; it did not mean Linux needed a new Rust installation. Check `rustc --version` and `node --version` in the exact WSL process, then prepend the existing `~/.cargo/bin` and Node 24 bin directory to its PATH before building.

**`git switch` or `git diff` says `fatal: this operation must be run in a work tree` inside a managed `.codex/worktrees` checkout, while `git status` and `git rev-parse --is-inside-work-tree` work**
On a managed Windows sandbox whose writable roots did not include the attached worktree and its linked Git metadata, the same commands succeeded with the required workspace access outside that sandbox. Do not conclude that the checkout is bare or recreate it; check the worktree path and granted access first, then request the necessary access for the operation.

**`git diff --check` reports `src-tauri/src/typst.rs:...: trailing whitespace` on every changed line**
That tracked file has CRLF in the index (`git ls-files --eol` reports `i/crlf`), so Git's default whitespace check treats the carriage return as trailing whitespace on this host. Run `git -c core.whitespace=cr-at-eol diff --check` to check actual whitespace without converting the entire existing file and obscuring the substantive diff.

**Piping a PowerShell here-string to `wsl.exe ... bash -s` reports `/tmp/.../probe\r: No such file or directory` even when `probe` exists**
The pipeline delivered CRLF to Bash, so the command name included a carriage return; replacing `\r` in the PowerShell string still produced line endings through the text pipeline on this host. For multi-line orchestration, pipe Python source to `wsl.exe ... python3 -` and invoke commands with argument arrays, or write a verified LF-only script before invoking Bash.

**`wsl.exe ... bash -lc 'v=example; printf "value=<%s>\n" "$v"'` prints `value=<>` from PowerShell**
Nested Windows/WSL argument quoting can expand the variable before the inner `bash` runs: `set -x` showed `v=example` followed by `printf ... ''`. A computed path consequently became `/project` and failed with `mkdir: cannot create directory ‘/project’: Permission denied`. Use explicit absolute paths for simple commands, or pass a script through stdin with verified quoting; inspect the exact resolved target before any filesystem mutation.

**`git status` shows `ai/limits.rs`, `ai/prompt.rs`, `ai/prompts_file.rs`, `ai/provider.rs` and `ai/stream.rs` modified although only `ai/mod.rs` was edited**
`rustfmt src-tauri/src/ai/mod.rs` formats the module **and every submodule it
declares**, so it rewrote test formatting in files nobody touched and made the
patch look five times larger. Run `rustfmt --skip-children` on a module file, or
run rustfmt only on the leaf file being edited, and revert the unrelated files
with `git checkout --`. This is the same rule as the existing
`cargo fmt --check` trap: the tree is not rustfmt-clean, so a repository-wide or
module-wide format is not a neutral operation.

**`Gdk-Message: … Error 71 (Protocol error) dispatching to Wayland display.` and “commit 7108d56 fixes it”**
`7108d56` is not a Tauri commit: it is `happier-dev/happier@7108d561`, an
application-level default for `__NV_DISABLE_EXPLICIT_SYNC`. The resolved stack
here is `tauri 2.12.5`, `wry 0.57.1`, `tao 0.37.2`, and grepping all three
sources for `WEBKIT_DISABLE_DMABUF_RENDERER`, `__NV_DISABLE_EXPLICIT_SYNC` or
NVIDIA detection returns nothing, so there was no upstream fix to inherit. On
the reporter's NVIDIA Wayland machine `__NV_DISABLE_EXPLICIT_SYNC=1` did not
help; `WEBKIT_DISABLE_DMABUF_RENDERER=1` did, and it must be set before
GTK/WebKitGTK initialise (`lib.rs::run`, before `generate_context!`). Do not
scope this to NVIDIA: this host reproduced the same abort on `nouveau` and
started with the variable, and upstream reports include AMD. `linux_webkit_env.rs`
now applies it on any Wayland session, with `MDRAFT_WEBKIT_DMABUF=0` as the
opt-out. Resolve a commit's repository before concluding that a dependency
contains it.

**`gh auth status` reports `The token in default is invalid.` inside the sandbox**
The sandboxed command could not use this host's Windows keyring credentials;
the same command outside the sandbox authenticated successfully with the
existing account. Verify authentication with normal execution escalation before
concluding that the user must log in again or replacing stored credentials.

**`OUT_DIR env var is not set, do you have a build script?` despite `src-tauri/build.rs` being present**
On this host the restricted shell also logged `could not canonicalize path` for
the workspace ancestors. The same MSVC-wrapped cargo command outside the sandbox
compiled successfully; the build script was not missing. Use the normal command
escalation rather than changing Cargo metadata or deleting the cache. The test
executable still needs workspace `TEMP`/`TMP`, as the separate file-IO trap says.

**`cannot open include file 'windows.h'` / `LNK1181`**
Cargo never found the Windows SDK because the registry version and the on-disk
version disagree. Run everything through `scripts\with-msvc.cmd`.

**`link.exe` resolves to the wrong program**
`C:\Program Files\Git\usr\bin\link.exe` is GNU `link`, not MSVC's linker, and it
sits on `PATH`. The MSVC wrapper puts the right one first; do not "fix" a link
error by editing `PATH` by hand.

**`unexpected closing delimiter` or `unknown start of token: \`**
A JavaScript regex literal written inside Rust, or a backtick inside a
template literal in an `.mjs` file. Both happened here. Rust has no regex
literals; and a backtick ends a template literal, so use `\x60` or restructure.

**`ParserError: An expression was expected after '('` from PowerShell**
Nested quoting in an inline `node -e "…"`. Write the script to a file instead —
every non-trivial snippet here lives in `scripts/`.

**`ReplaceFileW EIO (Win32 1175): C:\…\README.md` from the edit tool**
The file was open in another program that did not grant delete sharing, so
Windows could not replace it atomically — Notepad++ left open on a file under
edit is the usual culprit here. Nothing is wrong with the patch or the file.
Retry the same edit once; the second attempt succeeds as soon as the external
handle is released. Do not switch to an in-place shell write to work around it:
it bypasses the tool's read-before-write check and the other program's buffer
then overflows the change on its next save.

**`git worktree remove` empties the main checkout's `node_modules` when the worktree borrowed it through a junction**
To reuse dependencies in a temporary worktree, `node_modules` was made a
Windows directory junction to the main checkout, and the worktree was removed
with `git worktree remove --force`. Git's recursive delete followed the junction
and deleted the **target's** contents, leaving an empty `node_modules` in the
main checkout. The next `npm run dist` then failed in the portable pass with
`npm error could not determine executable to run`: without the local
`@tauri-apps/cli`, `npx tauri` fetched the unrelated `tauri@0.15.0` package from
the registry, which has no bin. Restore with `npm ci`. Before removing a
worktree, delete the junction itself with `cmd /c rmdir <worktree>\node_modules`
(no `/s`), or give the worktree its own install. `scripts/dist.mjs` now checks
for `node_modules/@tauri-apps/cli/tauri.js` first and runs the package's `tauri`
script rather than `npx tauri`, so the message names the missing dependency.

**`npm run dist` sits on `Building … 461/463: mdraft` for minutes even though
every dependency is cached**
That unit is the app crate (lib + bin). The release profile used to give it
`lto = true` with `codegen-units = 1`, which is effectively single-threaded:
104 s per pass. `dist.mjs` then makes it run **twice**: the portable pass and
the ordinary pass carry different `TAURI_CONFIG` values, and `tauri-build`
declares `cargo:rerun-if-env-changed=TAURI_CONFIG`, so the final crate is dirty
each time. Each pass also rewrites `dist/`, and every file there is listed in
`src-tauri/target/release/mdraft.d`, so a frontend rebuild dirties the crate
again. Measured on this host with a warm cache: 222 s total, 208 s of it in that
step; the frontend build is 1.3 s and bundling 7 s. `--no-portable` halves it.
The profile now ships `lto = "thin"` with `codegen-units = 16`: the same step
takes 27 s and a whole `npm run dist` 78 s, with no meaningful change in binary
size. Do not try profile changes casually through
`CARGO_PROFILE_RELEASE_LTO` / `CARGO_PROFILE_RELEASE_CODEGEN_UNITS`: they
invalidate all 461 dependency fingerprints, and switching back invalidates them
again, so the next ordinary build is a cold rebuild.

**`cargo test` fails with `Access is denied` in every temp-directory test, and the release app exits with WebView2 `0x800700AA`**
Both are the agent harness, not the code. Executables launched from inside the
workspace run under a file sandbox that cannot create files outside it. The test
binary at `src-tauri\target\debug\deps\mdraft_lib-*.exe` cannot create
`%TEMP%\tt-*`, so ten tests fail with
`Os { code: 5, kind: PermissionDenied, message: "Access is denied." }`; and
`mdraft.exe` cannot create its WebView2 profile under `%LOCALAPPDATA%`, which the
runtime reports as
`HRESULT(0x800700AA): "The requested resource is in use."` (sometimes
`0x8007139F`). Neither is profile corruption. Copy the test executable or the app
to a directory outside the workspace and run it there: all 75 runnable tests pass
and the window starts. `cargo test` still has to be invoked from the workspace
through the MSVC wrapper, so run the executable it produces from `%TEMP%`.

**`cl : Command line error D8050 : cannot execute '…\c1.dll': failed to get command line into debug records` while `cargo test` compiles `ring`**
The message names the compiler, so it reads as a broken MSVC install, the wrong
`cl.exe` or a missing SDK — none of them. `cl.exe` writes debug records for `/Z7`
through its temporary directory, and when `%TEMP%`/`%TMP%` names a directory the
launching process may not write to, that write fails and `cl` reports the loader
error instead. On this host both variables point at `T:\Temp` (`T:` is a separate
local volume), and the workspace sandbox covers only executables launched from
inside the workspace: `echo > %TEMP%\x` from `cmd` succeeds while the same
compiler spawned by cargo is denied. The same run then produces a second,
unrelated-looking symptom — 13 tests panic with
`Os { code: 5, kind: PermissionDenied, message: "Access is denied." }`. Prove it
in one step, before touching the toolchain, by pointing `TEMP` and `TMP` at a
folder **inside** the workspace: the build completes and all 56 runnable tests
pass. `CARGO_PROFILE_DEV_DEBUG=0` also gets the build through, because without
`-Z7` no debug records are written; that hides the cause rather than fixing it.

**A direct `cargo test` fails 14 file-IO tests with `Os { code: 5, kind: PermissionDenied }`, but `npm test -- --only rust` passes**
The test binary inherits the machine temp directory (`T:\Temp` here), which the
workspace sandbox does not let it write. `scripts/test-all.mjs` runs cargo with
`TEMP`/`TMP` inside `src-tauri/target/test-tmp/cargo`, which it is allowed to
write. Failures in `documents`, `images` and `html_preview` are the signal; the
settings and menu tests still pass, so it looks like a regression in unrelated
modules. Use the harness for the Rust layer on this host, or point `TEMP` at a
workspace path before a bare `cargo test`.

**`building ... FAIL` with `An Application Control policy has blocked this file. (os error 4551)` for `target\release\build\*\build-script-build.exe`**
The host runs ESET and Code Integrity is enforced; a freshly compiled release
build script can be blocked while its on-access scan is still in progress. The
same binary copied to `%TEMP%` and run a moment later executed normally, and a
plain retry of `npm test` completed the build. The debug target is usually
unaffected because its build scripts have already been scanned. Do not read this
as a broken toolchain or a source problem, do not disable the security product,
and do not clean `target/release`; retry once the scan settles. Running the
blocked executable by hand returns the same policy error, while its debug
counterpart runs and prints the expected `cargo:` lines.

**`cargo fmt --check` reports hundreds of differences in files you did not touch**
The tree is not rustfmt-clean: the installed rustfmt wants different import
ordering and test indentation in `html_preview.rs`, `images.rs`, `menu.rs`,
`settings.rs`, `spellcheck.rs` and `typst.rs` itself. A repository-wide check
therefore fails before it reaches your patch, and running `cargo fmt` would turn
a small change into a tree-wide diff. Match the surrounding style by hand and
use `cargo check` / `cargo test` as the gate; do not reformat the repository to
make the check green.

**A Linux build opens its GTK menus but a white content pane under WSLg**
The window title can still be the document name and the native menu complete while
`ps` shows no `WebKitWebProcess`: WebKitGTK's sandbox failed to start the web
process in this WSL2 session. Launching with
`WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1` (plus `GDK_BACKEND=x11` and the
usual `WEBKIT_DISABLE_COMPOSITING_MODE=1`) starts it. Even then, `import`/`scrot`
may capture the GTK window but not the WebKit surface, and WSLg's X11 has no
EWMH window manager, so clicks and typing cannot focus the webview reliably. Do
not read the white pane as a CSS, CSP or frontend regression; verify the native
menus and use a real desktop (or the Windows CDP suites) for content interaction.

**`ERR_MODULE_NOT_FOUND: Cannot find module ...\\src\\ai\\actions' imported from ...\\src\\ai\\history.ts` when running `npm run ai:unit`**
Vite resolves extensionless imports, Node ESM does not, and `context.ts` had hidden the difference because all of its imports are type-only and erased. A runtime import in a module the Node suites load directly must name the file: use `./actions.ts` (enabled by `allowImportingTsExtensions`) rather than `./actions`. The application build accepts either; only the app-free test fails.

**An interrupted `npm test` exits `-1` and a later CDP suite reports `CDP connection is closed before Runtime.evaluate`.** One interrupted isolated run left its pre-run settings and recovery journal under the staging directory's `user-state`, so later runs backed up the interrupted run's replacement settings instead of the original isolated profile. Compare and preserve those backups before restoring them; never assume a terminated harness ran its `finally` block. The CDP disconnect also occurred in a separate sample-only retry that later passed, so it does not by itself establish a document or compiler regression. Inspect the application and test logs and rerun the focused case; preserve the literal failure rather than declaring the entire previous suite green.

**`CreateAppContainerProfile: Key Software\Classes\Local Settings\Software\Microsoft\Windows\CurrentVersion\AppContainer\Mappings (0x80070005)`**
The machine has no AppContainer mappings key, so creating a profile needs
machine-wide registry write access the signed-in user does not have. A
profile-less `NtCreateLowBoxToken` looks like a way out — it does block loopback —
but its token is not a real AppContainer token: `whoami` exits with
`ERROR: The handle is invalid.`, MiKTeX reports `Windows API error 2` for a path
with every separator stripped, and TeX Live says
`This path points to an invalid file : C:\Users`. Do not ship that substitution.
Implement the documented profile route, validate it, and report the platform as
unavailable when the profile cannot be created.

**`UpdateProcThreadAttribute(handles): A device attached to the system is not functioning. (0x8007001F)`**
The attribute list was sized for one attribute but two were added (security
capabilities + `PROC_THREAD_ATTRIBUTE_HANDLE_LIST`). `InitializeProcThreadAttributeList`
must be called with the exact count for both the sizing call and the real one;
the misleading `ERROR_GEN_FAILURE` is not about the handles at all.

**Creating a second AppContainer profile per run leaves an ACE for every dead SID on the TeX tree**
Per-run grants are simple to write and impossible to clean up reliably: a crash
leaves an ACE naming a SID no live process can revoke, and the ACL grows on every
compile until ACL enumeration itself becomes slow. Use one stable, app-named
profile and grant it once; keep per-job directories unique but owned by that
profile instead of inventing a new identity per job.

**The whole `cargo test --lib` suite fails with `Access is denied` (os error 5) on files under `T:\Temp`**
The test executable lives under a Low-integrity-labelled workspace, so the
process runs at Low integrity; `std::env::temp_dir()` is a Medium directory and
every test that creates a scratch file is denied. The failures look like 70
unrelated regressions in `documents`, `export`, `images` and `ai`. Run the suite
with `TEMP` and `TMP` pointing at a directory inside the low-labelled workspace
(`$env:TEMP = "$PWD\\.tmp-test"`), then delete it. This is a property of the test
host, not of the code under test. The agent scratchpad is **not** "inside the
workspace": it is also under `T:\Temp`, and pointing `TEMP`/`TMP` there still
fails the test that writes to `std::env::temp_dir()`
(`removing_an_asset_another_install_removed_is_not_an_error`, `Access is denied`)
while every test using `target\latex-tests` passes — a split that reads as one
flaky test. Use `src-tauri\target\test-tmp\cargo`, the folder `scripts/test-all.mjs`
uses, and the same filter then reports all 22 `latex::` tests passing.

The same denial also stops the *build* of the test binary before a single test
runs: `cl : Command line error D8050 : cannot execute '...c1.dll': failed to get
command line into debug records`, raised while compiling `ring`'s C code. It
looks like an MSVC 14.51 bug and is not one — `cl.exe` cannot write its `/Z7`
debug records to the denied temp directory. With `TEMP`/`TMP` inside the
workspace the identical command compiles with debug info; do not set
`CARGO_PROFILE_DEV_DEBUG=0` to work around it, because that hides the cause.

**You are about to reintroduce AppContainer for the installed TeX engine**
The installed-TeX design no longer uses AppContainer, lowbox tokens, profile
registration, distribution ACL grants or a network probe. The reader approved
treating the distribution as their own external program; it runs directly, may
download its own packages, and only shell escape, `latexmk`, project executables
and arbitrary engine names remain refused. See
`docs/adr/2026-11-08-native-tex-user-responsibility.md`. The entries above are
kept because they are the record of what the earlier isolation design cost, not
because that design is current.

**Every shell call fails with `sandbox-local windows-acl temp grant materialization failed and its cleanup also failed`, even `pwd`**
The wording names Windows file permissions, so the obvious next move is to repair
the workspace ACL — and that is a dead end. The ACL diagnostic on
`C:\Users\bernh\Documents\GitHub\MDraft` returned `VERDICT=NOT_THIS_CLASS` with
`writeDac` and `writeOwner` both true and no package ACE, while every command in
the session, `pwd` included, failed identically: nothing about the repository
could have caused it, because the failing step runs before the command. It is the
harness's own grant provisioning. The same calls succeed in a session whose file
policy is `danger-full-access`, which does not materialize that grant. Do not run
`icacls`, change an owner or widen a permission for this message; get the session
policy changed, and if the failure survives that, report it as a harness bug
rather than a repository one.

**`smoke` fails `the choice reaches the settings file`, `p0-lifecycle` fails `newer typing remains in recovery`, `menu` fails `Code Colors writes the palette to settings`, and the LaTeX suites print `0/0 checks` — all in the same `npm test` run**
None of these is a regression. `TEMP`/`TMP` had been pointed at
`src-tauri/target/test-tmp` to get `cargo test` past the `T:\Temp` access
problem above, and the same shell then ran `npm test`. The harness stages the
binary under `%TEMP%`, so it staged it **inside the workspace**, and a binary
launched from there cannot write `%APPDATA%`: every check that reads back the
settings file or the recovery journal fails, and the LaTeX suites skip because
their engine switch never reaches `settings.json`. The harness says so in its
header — `staged … (the sandbox cannot reach %APPDATA% from inside the
workspace)` — which is the line to read first. Set the workspace `TEMP` only on
the `cargo test` command itself, never for `npm test`.

**`npm test` fails at `building` with `error: failed to read asset at …\src-tauri\../dist\assets\index-<hash>.css because The system cannot find the path specified. (os error 3)` from `tauri::generate_context!()`**
Not a broken build and not a missing file in the change. Another agent session
working in the same checkout ran `npm run build` (or its own `npm test`) while
this one was compiling: Vite empties `dist/` and writes assets under new hashes,
so the hashed name `generate_context!` had resolved from `dist/index.html` was
gone by the time the macro read it. It is tempting to blame the frontend change
and start bisecting it. Check for another `node … test-all.mjs` or `vite`
process first (`Get-CimInstance Win32_Process -Filter "Name='node.exe'"`), wait
for it to finish, and rerun; the harness's own refusal of a second harness does
not cover a plain `npm run build` in the other session.

**A WSL test fails with `Access is denied. Error code: Wsl/E_ACCESSDENIED` (wsl.exe exit -1) while the same `wsl.exe` command works in a terminal**
Not a launcher, quoting or automount bug. The `cargo test` binary lives under the
Low-integrity-labelled workspace, so it runs at Low integrity (see the `T:\Temp`
entry above), and the WSL service refuses Low-integrity callers. The first
version of the error said only "cannot reach … check automount", which pointed at
`/etc/wsl.conf`; the exit status and wsl.exe's own text are now part of the
message. Run WSL tests from a Medium copy of the test binary:
`Copy-Item src-tauri\target\debug\deps\mdraft_lib-<hash>.exe T:\Temp\mdraft-wsl-medium\`,
then `& T:\Temp\mdraft-wsl-medium\mdraft_lib-….exe --ignored a_wsl_distribution --nocapture`
with `MDRAFT_TEST_WSL_DISTRO` set. The installed application runs at Medium and
is not affected.

**`git diff --stat` shows a whole-file rewrite (e.g. `1779 + / 1725 -` for `latex.rs`) after a few small scripted edits**
Not a bad merge. Python's text mode on Windows writes `\r\n`, and this repository
keeps `core.autocrlf=false` with LF in the index for most files — so a Python
`open(p).read() … open(p, "w").write()` edit converts every line. A few files are
stored with CRLF instead (`git ls-files --eol` shows `i/crlf`, e.g.
`src-tauri/src/settings.rs`), so "convert back to LF" is also wrong for them.
Check `git ls-files --eol -- <file>` and make `w/` match `i/`; edit with the Edit
tool, `node` (`fs.writeFileSync` keeps `\n`) or Python with `newline=""`. Compare
`git diff --numstat` with `git diff --ignore-cr-at-eol --numstat` before trusting
a diff size.

**`cmd.exe /c "scriptscargo-vcvars.cmd test …"` from the Bash tool printed only `Microsoft Windows [Version 10.0.26200.…]`, the copyright line and `C:Users…MDraft>`, and the command "completed (exit code 0)"**
Nothing ran: no `Compiling`, no `test result:`, and an exit code that looks like a pass. The wrapper is a batch file that `call`s `with-msvc.cmd`, and starting it through `cmd.exe /c` from Git Bash opened an interactive shell banner instead of running it. Use the PowerShell tool — `.scriptscargo-vcvars.cmd test --manifest-path src-tauriCargo.toml <filter>` — and require the `test result: ok. 1 passed` line before calling a Rust test green. An exit code of 0 with no cargo output is not a result.

**`cargo test` reports `81 failed` with `called `Result::unwrap()` on an `Err` value: Os { code: 5, kind: PermissionDenied, message: "Access is denied." }` in modules nobody touched**
Every failing test creates a temporary directory first (`fs::create_dir_all(&dir).unwrap()` in the test helpers of `ai::secret`, `documents`, `images`, `print`, `export`, `settings` and others). In an agent session whose tools run in a sandbox the test binary is denied that write, even though a shell command in the same session can create a directory in the same place, and even with `TEMP`/`TMP` pointed into the session's scratch directory. Do not read the count as a regression. Prove it on the baseline: copy the changed file aside, `git checkout HEAD -- <file>`, run two of the failing tests by name and watch them fail the same way, then restore the copy. Judge a change by the tests it adds or touches (`cargo test … <filter>` and the `test result: ok` line), and say in the report that the rest could not run.

**A Node edit `text.replace(marker, newText)` silently duplicated the whole document: the plan file had every heading three times**
`String.prototype.replace` reads `$` sequences in a *string* replacement: `` $` `` inserts everything before the match, `$'` everything after it, `$&` the match. Documentation about Emmet, regexes or shell variables is full of `` `$` `` and `${0}`, and a backtick after a dollar sign was enough. Nothing threw; the symptom was a `grep -n "^## "` listing `## Context and goal` at lines 7, 93 and 168. The file was untracked, so there was no `git checkout` to undo it. Splice with `text.slice(0, i) + insert + text.slice(i + marker.length)`, or pass a function (`text.replace(marker, () => insert)`), whenever the inserted text is not fully under your control. Check the result with `grep -c` on a heading and `wc -l`, and keep a copy of an untracked file before rewriting it. This is also why the edits in this repository's other entries use the Edit tool.

**A Node script given to the Bash tool as a quoted heredoc ran as if its backslashes were halved: `indexOf('…("\\n=== heading')` found nothing, `new RegExp("\\(traps/" + f)` matched the empty string, and the splice that followed wrote 601 lines into a 3-line edit of `traps.md`**
Inside the heredoc `\\` reached Node as a single `\`, so string escapes and regex escapes meant something else; the first sign, three edits earlier, was `"#{x}".replace(/[{}]/g, "\\$&")` returning the text unchanged. The script then computed `at = indexOf(from)` from a pattern that never matched, and `idx.slice(0, at)` with `at === -1` is not an error — it is "everything but the last character". Write a script that contains backslashes to a file with the Write tool and run `node <file>`; throw when an `indexOf` is `-1` before slicing; never splice with a position you did not check; and run `git diff --stat` after any scripted edit, which showed `601 +++++` for a file that should have changed three lines. `git checkout -- <file>` undid it only because the file was tracked.
