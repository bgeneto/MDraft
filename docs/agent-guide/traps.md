# Traps

Every entry here is time somebody already lost. The record is split by domain
so a task loads one file, not all of them.

## Recording a trap is required

**If you lose time to something that was not obvious, add it to the right file
below before you finish the task.** Do not wait to be asked, and do not decide
it is too small. The entry that saves the next agent an hour is usually the one
that felt embarrassing to write down.

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
  answer. Several entries exist because a first diagnosis was wrong, and that
  wrong turn is what a future agent will repeat.

Do not record a trap when it belongs somewhere more specific: a wrong
`bundle.icon` path belongs in a fix and a test, not in a list of symptoms.
Traps are for knowledge that has no natural home in the code.

The list is append-only in spirit: do not delete an entry because the fix
landed, because the fix is what makes it recur.

## Domains

| File | Entries | Covers |
| --- | --- | --- |
| [traps/build-and-environment.md](traps/build-and-environment.md) | 30 | Host, shell, path, permission and WSL problems that stop a command before any application code runs. |
| [traps/toolchain-and-lint.md](traps/toolchain-and-lint.md) | 12 | Compiler versions, Clippy, ESLint, Prettier and the CI-only failures a green local run does not predict. |
| [traps/builds-and-packaging.md](traps/builds-and-packaging.md) | 13 | The bundle, staging, installer and release-artifact problems: what `npm run dist` produces and what it silently keeps. |
| [traps/processes-and-app-state.md](traps/processes-and-app-state.md) | 14 | Launched instances, leaked processes, the WebView2 profile, `settings.json` and recovery state. |
| [traps/test-runner.md](traps/test-runner.md) | 16 | `scripts/test-all.mjs` itself: the order it runs, the guards it applies, the cleanup it owes. |
| [traps/test-harness.md](traps/test-harness.md) | 16 | Individual suites: what they assert, what they leave behind, and why one passes alone and fails in the full run. |
| [traps/debugging-probes.md](traps/debugging-probes.md) | 22 | CDP drivers, stubs and probes that report the wrong thing for a reason the driver owns. |
| [traps/dom-measurement.md](traps/dom-measurement.md) | 18 | Probes that read layout, selection, focus or visibility: what the DOM reports versus what the reader sees. |
| [traps/editor-and-ui.md](traps/editor-and-ui.md) | 30 | CodeMirror, the theme layer, menus, shortcuts, Preferences and the DOM measurements that decide what the reader sees. |
| [traps/paste-and-images.md](traps/paste-and-images.md) | 11 | Rich paste, the clipboard, image destinations and the markup each document format expects. |
| [traps/preview-and-sync.md](traps/preview-and-sync.md) | 23 | The preview renderers, the source maps behind word sync, the PDF text layer and the measured cost of rendering. |
| [traps/latex-typst-asciidoc.md](traps/latex-typst-asciidoc.md) | 25 | The non-Markdown formats: engine selection, reference validation, includes, outline scans and PDF correspondence. |
| [traps/export-and-print.md](traps/export-and-print.md) | 29 | Pandoc, the browser-readable artifacts, WebView2 and WebKitGTK printing, and the PDF measurements that follow them. |
| [traps/ai-accessibility-and-typography.md](traps/ai-accessibility-and-typography.md) | 27 | The AI Assistant, Read Aloud and speech backends, and the bundled typefaces with their subsetting pipeline. |
| [traps/assets-and-site.md](traps/assets-and-site.md) | 9 | Icons, the GitHub Pages site, its images and the documentation assets that ship beside the application. |

## Searching the record

The index above names the domains; it does not repeat the symptoms. Search for
the literal text you saw, across every file at once:

```powershell
# the exact error line
rg -n "cannot open include file" docs/agent-guide/traps

# a tool or command name
rg -n "HRESULT\(0x800700AA\)" docs/agent-guide/traps

# files only, when you want the domain rather than the entry
rg -l "Pandoc exited" docs/agent-guide/traps
```

Each entry's first line is its bold symptom, so `rg -n "^\*\*"` lists every
symptom in a file, and `rg -n "^\*\*.*<word>"` finds the entries about one
subject.
