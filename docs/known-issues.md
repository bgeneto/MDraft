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
