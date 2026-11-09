# Assets and landing-page traps

Icons, the GitHub Pages site, its images and the documentation assets that ship beside the application.

Part of [the trap record](../traps.md). Search across every domain with:

```powershell
rg -n "<literal error text>" docs/agent-guide/traps
```

**A custom 404 at `/MDraft/404.html` loses its stylesheet, icon and script when it is served for `/MDraft/some/deep/path`**
GitHub Pages answers an unknown project URL with the `404.html` content but keeps the requested URL, so a relative `./styles.css` resolves under the missing directory and 404s too; the page renders unstyled with no theme. Put `<base href="https://bgeneto.github.io/MDraft/">` in the 404 and the language-specific base in `pt-br/404.html`, then use paths relative to that base. A normal page cannot use this trick: `<base>` changes every anchor, so keep it only on the error pages.

**An anchor jump leaves a 100 px band of the previous section under the sticky header**
`scroll-padding-top` on `html` and `scroll-margin-top` on the target both apply. With 88 px on each, clicking `#typography` put the section top at 176 px while the 75 px header ended at 75, leaving a 101 px strip of the previous dark band; the heading looked detached. Keep one mechanism: the site uses `scroll-padding-top: 80px` and no `scroll-margin-top` on sections. Measure `section.getBoundingClientRect().top` against the header's bottom after a real nav click, not by eye.

**A full-page screenshot shows every below-the-fold screenshot as an empty box**
The landing page marks its section images `loading="lazy"`. Playwright's `fullPage: true` captures without scrolling, so the images are never requested and the capture looks like the assets are missing; the build and a real scroll load all of them. Scroll each section (or wait for `img.complete`) before judging the layout, and do not "fix" an image that the browser simply has not fetched yet.

**`height: 100%` on a screenshot frame pushes its `<figcaption>` into the next list**
In a CSS grid, a `figure` stretches to the row height; an inner `.shot-frame` with `height:100%` then fills that height, and the caption is laid out below the frame but outside the figure's own box. The next `.feature-list` starts at the figure's nominal bottom, so the caption and its "Click to enlarge" hint painted over the first bullets. Measured in the math pair: figure 430px, frame 430px, caption 45px, and the list only 26px after the figure bottom; after removing the rule, frame 374px, caption 45px, figure 430px, and the list starts 26px below the caption. Let the frame size to its image; if two cards must match heights, stretch a wrapper that contains the caption, not the frame alone.

**`Preview: http://127.0.0.1:4173/MDraft/` prints, but the browser cannot load it and `Invoke-WebRequest` reports `An attempt was made to access a socket in a way forbidden by its access permissions`**
On this Windows host, a site preview started inside the sandbox can announce its
listener yet remain inaccessible to the host browser. Escalating only the client
timed out, so the page itself was not the problem. Stop the owned server, run
`npm run site:serve` with normal execution escalation, and check the URL outside
the sandbox with `Invoke-WebRequest -NoProxy -ErrorAction Stop` before opening it.

**`new System.Drawing.Icon(path, 256, 256)` returns the 128 frame**
.NET cannot decode PNG-compressed ICO entries and silently falls back to a
smaller one, so a 256-frame check reports a false mismatch. Parse the ICO
directory from the raw bytes.

**The window and taskbar show an orange “W” on KDE Wayland, not the MDraft icon**
The compositor does not read a GTK window's icon on Wayland: KWin resolves the
window's `app_id` to `<app_id>.desktop`, reads its `Icon=`, and falls back to the
Breeze `wayland` icon when the lookup is empty (`XdgToplevelWindow::updateIcon()`
in `src/xdgshellwindow.cpp`). GTK3 sets `app_id` from `g_get_prgname()`, which
was the binary name `mdraft`, while Tauri named the installed entry after
`productName`, `MDraft.desktop`, and the lookup is case-sensitive. Measured on
the installed binary before the fix with `WAYLAND_DEBUG=1 /usr/bin/mdraft`:
`xdg_toplevel.set_app_id("mdraft")`, while
`/usr/share/applications/MDraft.desktop` was the only entry.

The Linux product name is now `mdraft`, so the app id, the entry's basename
(`mdraft.desktop`), its `StartupWMClass=mdraft` and the binary name all agree;
the launcher label stays `Name=MDraft` because that is a literal in
`src-tauri/linux.desktop.hbs`. `src-tauri/src/lib.rs` still sets the GLib program
name from the merged config's `productName` before Tauri builds the GTK
application: the call is what makes the four values keep agreeing, rather than a
coincidence that a future rename would break. Do not conclude the icon assets or
`bundle.icon` are wrong from this; X11 uses `_NET_WM_ICON` and looked correct.

**The regenerated 512px icon shows the cyan chevron as pale grey, though the source PNG is correct**
Median-cut quantisation spent every palette entry on the navy↔white antialiasing edge, whose range is the full 0–255; the cyan accent is only about 1% of the pixels, so it was never split out and was averaged into a pale box. Measured: `pixel(256,440)` became `[236,240,243]` instead of the source's `[0,184,244]`, and the 176-entry palette contained zero cyan entries. `scripts/build-icons.mjs` seeds the palette with the most frequent colour, repeatedly adds the most frequent colour farthest from it (weighted farthest-point), then runs three Lloyd passes; the same pixel now maps to `[11,186,244]`. Do not judge a regenerated set by the files existing or by `tauri icon` succeeding: open the 512 PNG and sample a pixel inside the accent.

**`icon .../src-tauri/icons/32x32.png is not RGBA` while the Windows build and every test pass**
Tauri's Linux `generate_context!` reads the bundle PNGs as RGBA and rejects an indexed PNG; the Windows build does not check the colour type. `scripts/build-icons.mjs` used to write palette PNGs for the bundle (the size saving is only safe inside ICO/ICNS, whose frames are expanded), so `build-linux.sh` failed at the Rust proc macro after compiling every dependency. The bundle PNGs are colour type 6 now and the generator writes `rgbaPng` for them; verify with byte 25 of the IHDR (`6`, not `3`) and sample the accent pixel. The master `docs/icon/mdraft-icon.png` is absent from this checkout, so `npm run icons` cannot regenerate; converting the committed PNGs with `System.Drawing` preserves their quantised colours and the `[11,186,244]` accent.
