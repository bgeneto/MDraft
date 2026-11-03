# Linux platform fixes: app-center copy, Wayland startup, API-key persistence, and native speech

**Status:** done
**Date:** 2026-11-03
**ADR:** `../adr/2026-11-03-ai-key-file-fallback.md`

## Context and goal

Four Linux-facing problems were reported against 0.7.7. Three of them are
functional failures on Ubuntu, and one is stale copy shown by the app center.

1. **App-center description is out of date.** `src-tauri/tauri.conf.json` still
   describes MDraft as "in the spirit of Typora", and lists "PDF typeset by
   Typst" as a headline feature. The application has since grown an optional AI
   assistant, tabs with per-document state, favorites, typography presets,
   native HTML/PDF/Print export and pandoc export. The description should name
   what the product is now, not what it resembled in 2025.

2. **Wayland startup dies before a window exists.**
   `Gdk-Message: … Error 71 (Protocol error) dispatching to Wayland display.`
   The process is killed by the compositor while GTK/WebKitGTK attach a
   DMA-BUF frame, so no in-app error can be shown. `WEBKIT_DISABLE_DMABUF_RENDERER=1`
   works around it; `__NV_DISABLE_EXPLICIT_SYNC=1` does not on the reporter's
   machine. The reporter has NVIDIA; this host reproduced the same abort with
   `nouveau` and the same successful start with the variable, and upstream
   reports include AMD, so the condition is Wayland, not one driver.

   Investigation:
   - The referenced commit `7108d56` is **not** in Tauri, wry or tao. It is
     `happier-dev/happier@7108d561`, which defaults `__NV_DISABLE_EXPLICIT_SYNC`
     to `1`. That is a different workaround and it does not help this reporter.
   - The resolved Tauri stack is `tauri 2.12.5`, `wry 0.57.1`, `tao 0.37.2`;
     none of them contains `WEBKIT_DISABLE_DMABUF_RENDERER`,
     `__NV_DISABLE_EXPLICIT_SYNC` or any NVIDIA detection. There is no upstream
     fix for us to inherit.
   - WebKitGTK honors `WEBKIT_DISABLE_DMABUF_RENDERER` (the string is present in
     `libwebkit2gtk-4.1.so.0` on Ubuntu 26.04, WebKitGTK 2.52.6).
   - The workaround must be set **before GTK/WebKit initializes**, which means in
     `run()` before `tauri::Builder`, not from the frontend. That also makes it
     apply regardless of how the app was launched: desktop entry, AppImage,
     `xdg-open`, or a terminal command.

3. **The AI API key is lost on restart on Linux.**
   The keyring crate's Linux Secret Service store uses the default collection.
   In `secret-service` 5.2, a missing default collection is not created: the
   no-entry path calls `create_collection("default")`, which calls
   `get_default_collection()` again and fails the same way. A fresh Ubuntu
   session without a login keyring therefore reports
   "The system credential store refused the key", keeps the key in memory, and
   loses it when the process exits. The UI's current answer is session-only,
   which is exactly the complaint.

4. **Read Aloud cannot work in Ubuntu's WebKitGTK.**
   Measured on Ubuntu 26.04 with WebKitGTK 2.52.6: a minimal GTK/WebKit probe
   reports `{"has":false,"n":-1}` for `speechSynthesis`. WebKitGTK is built
   without the Web Speech synthesis backend, so no amount of installing
   speech-dispatcher will make `getVoices()` non-empty. `spd-say` itself works
   and `spd-say -L` lists 141 default voices (14,806 including variants) with
   espeak-ng. The Preferences note currently tells the reader to install
   packages but cannot make the webview see them.

The goal is that a Linux reader can start MDraft on Wayland, keep an AI
key across restarts, and use Read Aloud through the system's speech service,
without pre-pending environment variables or installing anything MDraft could
detect and use itself.

## Scope and non-scope

**In scope**

- Replace the bundle `longDescription` and the npm description; keep the
  short description.
- Add a pre-GTK startup workaround that sets
  `WEBKIT_DISABLE_DMABUF_RENDERER=1` when Wayland is in use, with an
  environment override and user-value precedence. The default is any Wayland
  session because the failure is not NVIDIA-specific.
- Add a persistent, user-private file fallback for the AI key when the system
  credential store refuses a write. Prefer the keyring; migrate back to it when
  it works; report the storage source honestly in Preferences.
- Add a Linux speech backend that drives `spd-say` (speech-dispatcher) for
  Read Aloud, list its default voices, and make the Preferences note name the
  exact packages and a test command.
- Tests and documentation for all of the above.

**Non-scope**

- Fixing WebKitGTK's DMA-BUF implementation or waiting for an upstream Tauri
  release. The workaround is a mitigation, not a root-cause fix.
- Bundling or auto-installing speech-dispatcher, espeak-ng or a keyring daemon.
- Changing Windows or macOS credential storage or speech behavior.
- Making the HTML guest, spelling or export paths use the new speech service.
- An in-app error dialog for the Wayland crash: the process is terminated
  before the webview exists. The automatic workaround and the documented
  fallback are the only viable answers.

## Approach and rejected alternatives

### 1. Description

Replace `bundle.longDescription` with copy that names the current product:
four markup languages, live preview, math/diagrams/highlighting, optional AI
assistant, tabs/favorites, typography, and HTML/PDF/pandoc export. Keep
`shortDescription` short. Update `package.json`'s `description` so the two do
not disagree.

Rejected: keeping "in the spirit of Typora" as a positioning statement. It is
factually stale, and it is the first thing an app-center visitor reads.

### 2. Wayland startup

Add `src-tauri/src/linux_webkit_env.rs` with:

- `session_type()`: `GDK_BACKEND` is authoritative (first recognized entry
  wins); otherwise `XDG_SESSION_TYPE=wayland`, `WAYLAND_DISPLAY`, or
  `WAYLAND_SOCKET`; `DISPLAY` alone means X11.
- `decide()`: the user's `WEBKIT_DISABLE_DMABUF_RENDERER` value always wins;
  `MDRAFT_WEBKIT_DMABUF=0` forces the mitigation off; otherwise apply on any
  Wayland session. `MDRAFT_WEBKIT_DMABUF=1` is an explicit force-on, kept for
  diagnostics.
- `apply_before_gtk_init()`: read the environment, log the decision when
  `MDRAFT_WEBKIT_DMABUF_DEBUG=1`, and set the variable before Tauri starts.
- Call it first in `lib.rs::run()`, before `generate_context!()` and the Tauri
  builder.

Because it is an in-process environment default, a desktop shortcut does not
need `Exec=env …`; every launch path inherits it. If the process still dies
before a window, no application code can show a message, so the mitigation is
the only automatic answer. `README.md` gains a troubleshooting entry with the
manual variable and a desktop-entry example for the case where detection misses
an unusual session setup.

Rejected alternatives:

- **Scope detection to the proprietary NVIDIA driver.** The approved plan
  started here, but this host reproduced the same abort with `nouveau`, and
  upstream reports include AMD. An NVIDIA-only check would leave those readers
  broken; `MDRAFT_WEBKIT_DMABUF=0` is the opt-out instead.
- **Apply the variable on X11 too.** The abort is in the Wayland frame path;
  X11 sessions keep their acceleration.
- **Use `tauri-plugin-wayland-nvidia-quirk`.** It is a 0.1.0 third-party plugin
  that forces an early GL context instead of disabling DMA-BUF. It is unproven
  on the reporter's machine, and adding a dependency for a platform quirk is
  more surface than the small environment default. We can revisit it if the
  env workaround fails on hardware we can test.
- **Set `__NV_DISABLE_EXPLICIT_SYNC=1`.** The reporter already tried it and it
  did not work; the DMA-BUF variable is the proven one.
- **Use `Exec=env …` in the desktop template only.** It would not help the
  AppImage's own launcher, a terminal launch or `xdg-open`, and it duplicates
  the decision in packaging.

### 3. API-key persistence

Add a Linux-only file fallback beside `settings.json`:

- `ai-keys.json`, mode `0600`, directory mode `0700`, written atomically
  through a temporary sibling and `rename`.
- `secret::resolve` tries session → file → keyring. A file entry is only
  created when the keyring refused a write, so it is the newer key; preferring
  the keyring first would silently keep using an older keychain entry after the
  reader saved a replacement during a keyring outage.
- `secret::keychain_set` still runs first. On success it deletes any stale file
  entry. On failure, write the file and report `source: "file"` with a warning
  naming the file and saying it is not encrypted, so the reader can decide.
- `secret::keychain_delete` removes the keychain entry, the file entry and the
  session entry.
- `AiKeySource` gains `"file"`. Preferences shows
  "Saved in a private file (not encrypted)" and a help sentence with the
  location. The key is never written to `settings.json`, a recovery entry, a
  channel event or an error message.
- Add `ai-keys.json` to `scripts/test-all.mjs`'s `USER_STATE` so a CI or test
  run cannot leave a mock key in the developer's config directory.

Rejected alternatives:

- **Keep session-only.** It is the reported bug.
- **Write the key into `settings.json`.** The existing ADR rejects this:
  settings are copied by backups and sync and are readable by any process.
- **Delete the keyring and force a new default collection.** Creating a
  collection makes gnome-keyring prompt for a password, and the user may
  cancel or may not see the prompt. It is not a reliable fallback.
- **Add `libsecret` FFI.** It still relies on a collection and a prompt, and it
  adds a build dependency for no better guarantee than the file fallback.
- **Encrypt the file with a machine id.** It looks secure but is not: the
  machine id is readable, and the file already lives in the user's home. Honest
  permissions and an honest label are better than security theatre.

### 4. Read Aloud through speech-dispatcher

The webview cannot speak on Linux, so the Rust side must:

- `speech_status()`: run `spd-say -L`, parse the fixed-column output, keep the
  `VARIANT == "none"` rows (141 default voices, not 14,806), and return
  `{ available, reason, voices }`. A missing `spd-say` returns
  `available: false` with the install command.
- `speech_speak(text, lang, voice, rate)`: spawn `spd-say -w` with a unique
  connection (`-N MDraft -n mdraft`), pass `-y <voice>` or `-l <lang>`, map the
  Web Speech rate 0.5–2.0 to `-r -50…100`, and resolve when the child exits.
  A poll loop over `Child::try_wait` keeps the child handle available for Stop.
- `speech_stop()`: take and kill the child, then run
  `spd-say -C -N MDraft -n mdraft` to clear anything already queued.

The frontend keeps `src/read-aloud.ts` platform-neutral by adding an optional
`backend` and `voiceSource` to `createReadAloud`. `src/system-speech.ts` wraps
the three commands and is selected in `main.ts` only when the webview has no
`speechSynthesis` (the measured Linux condition). `read-aloud.ts` stays
importable under Node for its existing unit suite.

Preferences changes:

- No voices on Linux: name the exact commands, for example
  `sudo apt install speech-dispatcher espeak-ng`, then
  `spd-say "Hello"`. Keep the existing "Nothing is downloaded by MDraft" line.
- Voices found: say they come from speech-dispatcher, are offline, and list the
  languages. The existing Windows and macOS text is unchanged.
- The menu's blocked reason uses the same tailored sentence, not
  "This webview has no speech synthesis."

Rejected alternatives:

- **Use Web Speech and assume a future WebKitGTK build enables it.** The
  measured build has no API at all; this would leave the feature broken.
- **Call `spd-say` from the frontend through the shell plugin.** It adds a
  plugin and a permission for a command the Rust side already owns, and Stop
  needs process control.
- **Embed a TTS engine.** That would add a large dependency and contradict the
  "nothing is downloaded" promise.
- **Use `libspeechd` FFI.** `spd-say` is part of the same package, needs no
  header or linker dependency, and gives us wait/cancel semantics directly.

## Steps

- [x] Update `bundle.longDescription` in `src-tauri/tauri.conf.json` and
      `description` in `package.json`.
- [x] Add `src-tauri/src/linux_webkit_env.rs` with session and override
      detection; unit-test each decision.
- [x] Call the module first in `src-tauri/src/lib.rs::run()`.
- [x] Add `ai-keys.json` file storage to `src-tauri/src/ai/secret.rs`, with
      mode `0600`, atomic writes and tests.
- [x] Route `ai_set_key`, `ai_clear_key`, `ai_status` through the file fallback
      and add `"file"` to `AiKeySource`.
- [x] Update the Preferences key-state label and help text for `"file"`.
- [x] Add `ai-keys.json` to `scripts/test-all.mjs`'s `USER_STATE`.
- [x] Add `src-tauri/src/speech.rs` with `speech_status`, `speech_speak`,
      `speech_stop`, the `spd-say -L` parser and rate mapping; register the
      commands in `lib.rs`.
- [x] Add `src/system-speech.ts` and the optional backend/voice-source hooks in
      `src/read-aloud.ts`; select the native path in `src/main.ts`.
- [x] Rewrite the Linux branch of `voiceAvailabilityNote` and the blocked
      reason with the exact install/test commands.
- [x] Extend `scripts/read-aloud-unit.mjs` with the Linux note and the injected
      voice-source behavior.
- [x] Add the README Linux troubleshooting section (manual variable and desktop
      entry example).
- [x] Add `docs/adr/2026-11-03-ai-key-file-fallback.md`.
- [x] Record the investigation results that are not obvious from the code in
      `AGENTS.md` Traps: the non-Tauri commit, Ubuntu WebKitGTK's missing speech
      synthesis, the keyring default-collection failure and the Node 22 `.ts`
      import failure.

## Implementation notes

- The file fallback is compiled on every platform, not only Linux. A broken
  Windows Credential Manager or macOS Keychain gets the same honest fallback,
  and no new condition has to guess at the platform.
- The speech backend uses `std::process::Command` and the existing `serde` /
  `serde_json` dependencies. No crate or npm package was added.
- The approved NVIDIA-only detection was widened to every Wayland session after
  this host reproduced the exact abort with `nouveau`: the unmodified dev build
  printed `Gdk-Message: … Error 71 (Protocol error) dispatching to Wayland
  display.` and exited 1, while the same build with
  `WEBKIT_DISABLE_DMABUF_RENDERER=1` started normally. A later dev run with no
  override started, printed no abort, and its WebKit web processes carried
  `WEBKIT_DISABLE_DMABUF_RENDERER=1`; a temporary `speech_status` log also
  proved the frontend calls the speech command at boot. That is the deviation
  from the approved plan, recorded here.
- The host speech probe (`speech::tests::the_host_speech_service_reports_default_voices`)
  is ignored by default, like the download and display tests, because a CI
  runner need not have a voice installed. It passed here with 141 default
  voices.
- The keychain-refusal branch is covered by `ai::tests`: a refused keychain
  writes `ai-keys.json` and reports `file`, a later successful keychain write
  removes the older file entry, and an unwritable file falls back to the
  session with the warning.
- Running the full `npm test` exposed a Linux harness bug: `runRustSuite`
  always invoked the Windows-only `cargo-vcvars` wrapper, so the Rust layer
  failed in `0.0s` with `cargo test exited -1 without a result line` although
  `cargo test` was green. `scripts/test-all.mjs` now uses plain `cargo` off
  Windows. With that fix, `npm test` passes all 17 applicable layers and skips
  the 33 CDP/close/restart layers that WebKitGTK cannot run.

## Files and modules

| File | Why |
| --- | --- |
| `src-tauri/tauri.conf.json` | App-center long description |
| `package.json` | npm description, kept consistent |
| `src-tauri/src/linux_webkit_env.rs` | New pre-GTK Wayland DMA-BUF decision |
| `src-tauri/src/lib.rs` | Call it first; register speech commands |
| `src-tauri/src/ai/secret.rs` | File fallback, source enum, tests |
| `src-tauri/src/ai/mod.rs` | Pass the config directory and report `file` |
| `src/api.ts` | `AiKeySource` and speech command wrappers |
| `src/preferences.ts` | Key-state label/help and Linux Read Aloud note |
| `src-tauri/src/speech.rs` | New speech-dispatcher backend and parser |
| `src/system-speech.ts` | Frontend wrapper for the native backend |
| `src/read-aloud.ts` | Optional injected backend and voice source |
| `src/main.ts` | Select the native path on Linux |
| `scripts/test-all.mjs` | Back up/restore `ai-keys.json` |
| `scripts/read-aloud-unit.mjs` | Linux note and injected source checks |
| `README.md` | Linux/Wayland troubleshooting and Read Aloud requirements |
| `docs/adr/2026-11-03-ai-key-file-fallback.md` | Durable credential decision |
| `AGENTS.md` | The investigation traps worth keeping |

No new Rust or npm dependency is planned. The speech backend uses
`std::process::Command`; the file fallback uses `std::fs`, `serde_json` and
Unix permission bits.

## Risks and rollback

- **The session detection misses an unusual setup.** The override
  `MDRAFT_WEBKIT_DMABUF=1` forces the mitigation, and `=0` forces it off. The
  README names both. The fallback is a manual `Exec=env …` line.
- **Disabling DMA-BUF reduces rendering performance.** It is the same tradeoff
  the reporter already accepted, scoped to the affected driver. A future
  WebKitGTK/Tauri fix lets us remove the module.
- **The file fallback is plaintext.** It is `0600` in the user's config
  directory, not in `settings.json`; the UI says it is not encrypted. The keyring
  remains preferred and stale file entries are removed on a successful keyring
  write.
- **`spd-say` is not installed on every distribution.** The status command
  reports that and the UI names the package; Windows and macOS keep the Web
  Speech path untouched.
- **A long `spd-say -L` call blocks a worker.** It runs once and is cached in
  `SpeechState`; the default-voice filter keeps the returned list small.
- **Rollback:** delete the new modules and revert the listed files; the env
  variable and the key file are runtime state, not migrations. No persisted
  format changes. `ai-keys.json` can be deleted safely.

## Tests and validation

- `cargo check` and `cargo test` (through `scripts/with-msvc.cmd` on Windows;
  plain cargo on Linux). New unit tests:
  - session detection: `GDK_BACKEND` precedence, Wayland socket, X11, unknown;
  - override precedence: user env, `MDRAFT_WEBKIT_DMABUF=0/1`;
  - `spd-say -L` parser: header, spaces in names, `none` filter, language and
    variant columns;
  - rate mapping and command-argument construction;
  - key file round-trip, `0600` mode, per-endpoint isolation, removal and
    migration.
- `npm run build` for the TypeScript/API changes.
- `npm run read-aloud:unit` (106 checks, including the new Linux note and
  injected-source checks).
- `npm run ai:unit` (184 checks) for the catalog and secret-adjacent logic.
- `npm run smoke` / `npm run menu` are unchanged by copy, but the description
  change must not affect the menu; run `npm run menu` if native menu state is
  touched (it is not).
- Manual on this host: run `spd-say -L`, start MDraft with
  `speech_status`, and confirm Preferences lists voices and Read Aloud speaks.
  This host has speech-dispatcher and espeak-ng installed.
- Manual on this host (nouveau Wayland): the crash reproduced without the
  variable and the window appeared with it; the web processes inherited it. The
  same check on the reporter's NVIDIA machine confirms the `.desktop` entry and
  the AppImage; `MDRAFT_WEBKIT_DMABUF=0` restores the old behavior.
- Manual key test: temporarily point the app at a session with no Secret
  Service, save a key, restart, confirm it is still there and the UI says
  "private file". Then restore the keyring and confirm a save migrates back.

The one measurement that proves the speech fix: on Ubuntu 26.04 with
WebKitGTK 2.52.6, `speech_status` returns a non-empty list and
`speech_speak` resolves after audible output, even though
`'speechSynthesis' in window` is `false`.

## Acceptance criteria

1. The app-center description no longer mentions Typora or "PDF typeset by
   Typst", and names the AI assistant and current feature set.
2. On any Wayland session — the reporter's NVIDIA, this host's nouveau, and the
   reported AMD case — MDraft starts without the reader setting any variable;
   the desktop entry, AppImage and terminal all behave the same.
3. `MDRAFT_WEBKIT_DMABUF=0` leaves the environment untouched;
   `MDRAFT_WEBKIT_DMABUF=1` forces the mitigation; an explicit
   `WEBKIT_DISABLE_DMABUF_RENDERER` value always wins.
4. On a Linux session where the Secret Service refuses a write, a saved AI key
   survives a restart, Preferences says it is in a private file, and no key
   appears in `settings.json`, recovery entries or logs.
5. On Ubuntu with speech-dispatcher and espeak-ng, Read Aloud lists voices,
   speaks, advances sentences and stops from the menu and the status chip.
   Without the packages, Preferences names
   `sudo apt install speech-dispatcher espeak-ng` and `spd-say "Hello"`.
6. Windows and macOS still use Web Speech and the OS keychain; `npm run
   read-aloud:unit` and `npm run ai:unit` stay green.

## Open questions

- **Should the DMA-BUF mitigation be narrowed again?** This host reproduced the
  crash with nouveau and upstream reports include AMD, so it applies to every
  Wayland session. If a future WebKitGTK or compositor release fixes the frame
  path, the whole module can be removed; until then `MDRAFT_WEBKIT_DMABUF=0`
  is the escape hatch for a reader who wants DMA-BUF acceleration.
- **Should the key file fallback be opt-in?** Default: automatic, with an
  explicit Preferences label, because the reported failure is silent key loss.
  A setting can be added later if the security tradeoff needs a switch.
- **Should the app attempt to create the default keyring collection before
  falling back?** Default: no. It prompts for a password and can block or be
  dismissed; the file fallback is deterministic.
