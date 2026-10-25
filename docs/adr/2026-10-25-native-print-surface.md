# Print through a script-free hidden webview, keeping the browser handoff

**Status:** accepted
**Date:** 2026-10-25

## Context

`window.print()` inside the application does not open a print dialog in
WebView2, so the only PDF route was to write a light HTML copy to the temporary
directory and open it in the system browser. That route works, but it cannot
produce a known output path, cannot run the after-export actions, and leaves the
application unable to report whether the reader printed or cancelled.

Both hosts expose a real printing API:

- Windows WebView2: `ICoreWebView2_7::PrintToPdf` writes a file, and
  `ICoreWebView2_16::ShowPrintUI` opens the system dialog. The print settings
  come from `ICoreWebView2Environment6::CreatePrintSettings`.
- Linux WebKitGTK: `WebKitPrintOperation` opens the GTK dialog, or writes a PDF
  when `GTK_PRINT_SETTINGS_OUTPUT_URI` names a file. Its silent path still needs
  a `GtkPrinter`; the file backend's virtual printer is what makes the output
  URI a file rather than a CUPS device.

The article itself is already the one the GAP-026 browser path validates:
`buildExportArticle` renders Markdown, AsciiDoc and static HTML, rewrites local
images to absolute file URLs, and `wrapPrintHtml` carries the typography,
KaTeX stylesheet and light token colours. Re-rendering it through pandoc or
Typst would lose the preview's alerts, table of contents and page structure.

## Decision

Printing uses one hidden `WebviewWindow` labelled `print`:

- The window is invisible, unfocused, skip-taskbar, undecorated and excluded
  from the window-state plugin.
- No capability file matches the `print` label, so the Tauri IPC bridge in it
  is unprivileged even if content reaches it.
- The article is written to a per-operation temporary directory and loaded
  from a `file://` URL, giving relative assets a real base. The HTML carries no
  document scripts. Static HTML containing a script, an inline handler, a
  `javascript:` URL or a meta refresh never reaches this surface; it keeps the
  browser route.
- The host injects the readiness check after the document loads and polls a
  marker on `documentElement`. It never relies on a page script to trigger
  printing, and it never prints before fonts and images settle.
- Windows writes with `PrintToPdf` (A4, zero host margins, backgrounds on) and
  opens the system dialog with `ShowPrintUI`. Linux uses `WebKitPrintOperation`,
  with an A4 `PageSetup` and 18/16 mm margins, and writes the PDF through the
  virtual PDF printer.
- The browser handoff remains an explicit **PDF (opens browser)…** command and
  the fallback when a host lacks the API or the document needs scripts.
- Typst keeps **PDF (via Typst)**: a Typst document already compiles a PDF
  directly, so Print and the native PDF writer are disabled for it with a label
  naming that route.

The PDF visual harness (`scripts/pdf-visual-check.mjs`) rasterizes the delivered
file with Poppler and measures page geometry, embedded fonts, selectable text,
image colours, table rules and ink. Poppler is a test-only prerequisite; the
application never calls it.

## Consequences

- The application gains platform-specific printing dependencies:
  `webview2-com`/`windows-core` on Windows, and `gtk`/`webkit2gtk` on Linux.
- A print operation creates a temporary HTML file and directory. They are
  removed after the operation; `ShowPrintUI` runs the dialog modally in this
  runtime, so the surface is destroyed when the dialog returns. A runtime that
  returns before the dialog closes would need a new lifetime check, not a
  silent leak.
- Linux silent PDF requires the file backend's virtual printer, whose name is
  translated; it is found through `gtk_enumerate_printers` and its PDF/virtual
  properties, not by a hard-coded English label.
- WebKitGTK ignores the article's `@page` margins and its `break-*` rules in
  paged media. The Linux page setup therefore supplies the margins, and the
  article groups a heading with its next block so a heading cannot be stranded.
- The print window must never be given a capability. A future change that adds
  one reopens the script-to-IPC boundary this design closes.
- The browser handoff and the direct writer share the same article assembly;
  changing the print CSS must keep both `export-browser` and `pdf-native`
  green.
