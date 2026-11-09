# An installed TeX distribution is the reader's external program

**Status:** accepted
**Date:** 2026-11-08
**Supersedes:** `2026-11-08-native-tex-process-boundary.md`

## Context

The first native TeX design treated the installed engine as part of the
application's network surface. It required a proven process-tree network
boundary before enabling the feature: an AppContainer on Windows, a network
namespace on Linux, `sandbox-exec` on macOS. On the available Windows host that
gate could not be satisfied because the machine-wide AppContainer registration
was absent, so the feature stayed unavailable even though the reader's MiKTeX
was installed and working.

The reader then made an explicit product decision: an installed TeX distribution
is a program **they** chose and installed. It runs with their operating-system
permissions, its own package manager may use the network to obtain packages, and
MDraft should neither prevent nor police that traffic. The application itself
still makes no network request in order to run an installed engine.

## Decision

The network-isolation gate for installed TeX is withdrawn. MDraft runs the
selected engine directly, on the explicit Validate or Compile action, on every
platform.

The safeguards that remain are the ones needed for correctness and for avoiding
accidental execution, not for claiming a network boundary:

- the bounded project snapshot is staged into an app-owned private directory;
- the engine receives structured arguments, never a shell command string;
- `-no-shell-escape` is passed, so a document cannot run arbitrary commands;
- `latexmk`, `latexmkrc`, project-supplied executables and arbitrary
  `% !TEX program` values are still refused;
- the working directory, environment, stdin/stdout/stderr, timeout and output
  size are controlled by MDraft;
- Cancel terminates the engine's whole process tree (a job object on Windows, a
  process group on Unix).

MiKTeX's package installer is **not** disabled and `MIKTEX_AUTOINSTALL` is not
forced off: a missing package may be downloaded by MiKTeX itself. TeX Live's
packages remain managed by its own `tlmgr`; a missing package produces TeX
Live's own error. MDraft does not install or update either distribution.

The Preferences text states the trust model: the engine is a separate program,
it runs with the reader's permissions, it may use the network for its own
packages, and only trusted documents and installations should be used.

## Consequences

- Native TeX works on Windows, Linux and macOS without platform-specific
  sandbox support, profile registration or ACL changes.
- MDraft can no longer claim that a native compile is provably offline. The
  claim is narrower and true: the application itself makes no request to run a
  compile; the installed distribution may.
- A distribution that installs packages on demand can make the first compile of
  a document slow. The pane shows the engine's own log and the compile progress.
- The bundled WebAssembly engine remains fully local and unchanged; it is still
  the default for readers who do not opt in.
- Shell escape stays disabled even though the engine has network access: package
  installation does not require it, and a document running arbitrary commands is
  a separate risk that this decision does not accept.
