# Installed TeX runs only inside a proven platform sandbox

**Status:** superseded by `2026-11-08-native-tex-user-responsibility.md`
**Date:** 2026-11-08

## Context

The bundled LuaLaTeX engine runs as WebAssembly inside the WebView, so it has no
network or process capability of its own. An installed distribution is different:
`lualatex`, `latexmk`, BibTeX and Biber are separate processes that can open
sockets, read files and start children. The repository's network rule covers the
processes the application starts, and the approved plan makes a non-privileged
process-tree network boundary a condition of enabling native execution on a
platform.

## Decision

An installed distribution is a separate, explicit opt-in, off by default. The
application launches nothing while it starts, while status is read, or while an
installation is merely discovered. Discovery reads directory metadata only.

**Validate** is the one action that may execute external code. It creates the
platform sandbox and proves the boundary on the reader's own machine by running a
loopback client inside it, launches each tool's `--version`, then compiles a
one-page probe through the same staging and containment a real build uses. Only
then is the directory saved, and only the reader's explicit switch starts a build.

The boundary is platform-specific:

- **Windows:** an AppContainer token with no capability SIDs, created through the
  documented `CreateAppContainerProfile` API, held in a kill-on-close job object.
  A profile-less lowbox token is not used: it blocks the network but breaks real
  engines.
- **Linux:** `unshare --user --map-root-user --net`, inherited by the whole tree.
- **macOS:** `sandbox-exec` with `(deny network*)`, also inherited.

If the probe cannot prove the boundary, native execution stays unavailable on
that platform with the reason shown. There is no unsandboxed fallback, no
automatic switch to another engine, and no policy exception hidden behind a
compiler flag.

A native job uses the same bounded project snapshot as the bundled backend,
stages it into an app-owned directory, and writes generated files only there.
Shell escape is disabled, `latexmk` runs with `-norc`, MiKTeX's package installer
is disabled on every engine invocation, and project executables are refused by
the staging rules. The distribution owns its own packages and cache; MDraft
never updates it or downloads its packages.

The filesystem is deliberately **not** claimed as a security sandbox: an engine
the reader chose runs with the reader's file permissions, and MDraft says so in
Preferences. The enforced boundary is the network, which is what the repository
policy requires. Result ownership, warning handling and cancellation remain the
rules in `2026-11-08-latex-preview-and-engine-boundaries.md`.

## Consequences

- Native availability depends on the machine: a Windows system whose AppContainer
  profile cannot be created, or a Linux system with unprivileged user namespaces
  disabled, reports that instead of running the engine.
- Validation is slower than discovery because it compiles a probe; it is an
  explicit action and its cost is visible.
- The sandbox needs read/write access to the distribution and a private job
  directory. On Windows that is a per-profile SID grant on the selected tree.
- Cancellation must terminate the whole owned tree and ignore late output; the
  preview's revision token remains the authority on whether a result is current.
- Adding a platform means implementing and proving a boundary for it first; a
  feature switch alone is not enough.
