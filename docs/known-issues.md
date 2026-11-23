# Known issues

Entries here describe observed user-facing issues whose cause or fix has not
been confirmed. Recheck each entry against the current code before treating its
diagnosis or version details as current.

## Windows menu bar can change colour after minimizing and restoring

**Status:** Reproduced in the user's screenshots; cause not yet confirmed
**Reported:** 2026-10-25 · Windows 11, build 26200
**Area:** Native Windows menu bar (Tauri / Muda)

After minimizing and restoring MDraft, the native menu bar may appear light
while the editor remains light, or appear dark. In one supplied screenshot the
light menu has a one-pixel `#2b2b2b` line along its bottom edge; in the other,
the whole menu bar is `#2b2b2b`. The title bar is dark in both. The user reports
that this happens mainly after minimizing and restoring the window.

The Windows appearance registry reported dark for both Apps and System
(`AppsUseLightTheme=0`, `SystemUsesLightTheme=0`) during investigation. The
frontend applies MDraft's light/dark theme to the editor; the native Tauri
window and menu theme are left to the platform. The screenshots therefore show
the native menu changing appearance independently of the editor.

**Cause assessment:** Muda 0.20.0, the version selected by the current lockfile,
custom-draws dark Windows menu bars and separately paints the narrow strip
under the bar during `WM_NCACTIVATE` / `WM_NCPAINT`. That repaint path is
consistent with a partial native repaint after a window activation change. The
observed `#2b2b2b` line matches Muda's dark menu paint colour. This is evidence
for the rendering path, not a confirmed root cause: the minimize/restore
sequence has not yet been reproduced under instrumentation.

Muda previously tracked an extra line below Windows menu bars in
[issue #123](https://github.com/tauri-apps/muda/issues/123), which was closed
after a fix. That historical issue is related context; it does not establish
that this report is the same defect.

**Versions observed on this machine:** Tauri 2.12.4, Muda 0.20.0, Tao 0.37.1,
Wry 0.57.0, and WebView2 Runtime 155.0.4283.62. These versions are a snapshot,
not a statement that every dependency is current. Tauri 2.12.5 was already
available during investigation; its release notes do not mention this menu
painting issue, and it still selects Muda 0.20.

**Next investigation:** Capture native menu theme and paint events while
repeatedly minimizing and restoring, including while a menu rebuild occurs.
Then verify a fix by checking that the menu background and its lower edge stay
consistent through repeated restore cycles, with both light and dark editor
themes.

## Long documents stop part-way in the bundled preview

**Status:** fixed in the pinned 2026-11-20 TeXpresso build; earlier builds still stop
**Reported:** 2026-11-17 · Windows 11, TeXpresso `release-0-133-g454f1bc`; remeasured on `release-0.2-13-g6a91b6a`; fixed in `log-based-completion-2-ga271257`
**Area:** Bundled LaTeX preview (TeXpresso), XeLaTeX and LuaLaTeX

The pinned 2026-11-20 build removes the stop: upstream reports the fix for
long documents with many drawings or plots, and a 592-page `infdesc` project
reached its final page (576 pages in the preview's counter) in about 90 s under
XeLaTeX in the public editor. The 4 GiB heap cap is unchanged; the engine
retains less memory and answers completion queries from logs. MDraft's release
validates the same run through its own frame.

The paragraphs below describe the earlier builds. The preview engine keeps
snapshots and a rollback record for fast edits inside
its WebAssembly memory, and both are bounded. A 592-page textbook stopped at
page 218 (XeLaTeX) and 204 (LuaLaTeX) on the 2 GiB engines of
`release-0-133-g454f1bc`, and at about page 452 and 428 on the 4 GiB engines of
`release-0.2-13-g6a91b6a`, each time with `retcon_trail: the arena is full`, so
its table of contents, written at the end of the document, stays empty. A
smaller snapshot budget did not move the last wall. MDraft labels such a build
**PDF with errors** with the page where it stopped and offers only
`<root>-partial.pdf`; an installed TeX distribution compiles the whole document.

The engine's memory is not all the preview uses. Measured on 2026-11-18
(Windows 11, WebView2), the process that hosts the preview reached a working
set of about 7 GB on that textbook, with either engine: the engine's 3.5–3.7 GB,
the preview's page index (0.9 GB kept, 1.2–2.7 GB while typesetting) and the
browser's own share. Until 2026-11-18 the engine also restarted from scratch
after running out of memory, stopped at the same page, and kept the first
engine's memory meanwhile: 11.1 GB at peak with XeLaTeX. MDraft now reports the
failure at once, then releases the engine and holds the document. Edits wait
for Compile, since each build would stop at the same page again.
