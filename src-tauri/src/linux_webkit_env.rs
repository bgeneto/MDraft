//! Process-environment defaults that WebKitGTK reads while it initialises.
//!
//! `WEBKIT_DISABLE_DMABUF_RENDERER` has to be set before GTK/WebKitGTK create
//! the first web process. On Wayland, WebKitGTK can abort the whole process with
//! "Error 71 (Protocol error) dispatching to Wayland display" while it attaches
//! a DMA-BUF frame, so there is no window in which an application message could
//! appear. The only automatic answer is to set the variable before Tauri builds
//! the app.
//!
//! The failure is not limited to the proprietary NVIDIA driver. This host uses
//! `nouveau` and reproduced the same abort without the variable and the same
//! successful start with it, and upstream reports include AMD. The default is
//! therefore any Wayland session; the cost is DMA-BUF acceleration, which a
//! text editor does not need, and every choice can be overridden:
//!
//! | Variable | Effect |
//! | --- | --- |
//! | `WEBKIT_DISABLE_DMABUF_RENDERER` (any value) | The reader's own value wins; nothing is changed. |
//! | `MDRAFT_WEBKIT_DMABUF=0` | Never set the mitigation. |
//! | `MDRAFT_WEBKIT_DMABUF=1` | Force it on for a Wayland session (the default; useful for diagnostics). |
//! | `MDRAFT_WEBKIT_DMABUF_DEBUG=1` | Print the decision to stderr. |
//!
//! `GDK_BACKEND` decides first because it is what GDK acts on. An X11 session,
//! including `GDK_BACKEND=x11` on a Wayland desktop, is left alone: the crash is
//! in the Wayland frame path, not in X11.

/// WebKitGTK's switch for the shared-memory frame path.
pub(crate) const DMABUF_VAR: &str = "WEBKIT_DISABLE_DMABUF_RENDERER";
/// The application's own override. `0` leaves the environment untouched.
pub(crate) const OVERRIDE_VAR: &str = "MDRAFT_WEBKIT_DMABUF";
/// Diagnostic switch for support reports.
const DEBUG_VAR: &str = "MDRAFT_WEBKIT_DMABUF_DEBUG";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Session {
    Wayland,
    X11,
    Unknown,
}

/// What the process should do with `WEBKIT_DISABLE_DMABUF_RENDERER`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Decision {
    /// Set the variable to `1`.
    Disable,
    /// Leave the environment exactly as it arrived.
    Leave(Reason),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Reason {
    UserValue,
    ForcedOff,
    NotWayland,
}

/// The first recognised entry of `GDK_BACKEND` is the backend GDK will try
/// first, so it wins over everything else. `*` names no backend in particular.
pub(crate) fn gdk_backend_session(list: Option<&str>) -> Option<Session> {
    for item in list?.split(',') {
        match item.trim() {
            "wayland" => return Some(Session::Wayland),
            "x11" => return Some(Session::X11),
            _ => continue,
        }
    }
    None
}

/// Which display server GDK may use.
///
/// `GDK_BACKEND` is authoritative because it is what GDK acts on.
/// `XDG_SESSION_TYPE` comes next, then the socket variables, which are all that
/// is left when a `.desktop` launcher or `sudo` scrubbed the session
/// environment. `DISPLAY` alone means X11.
pub(crate) fn session_type(
    gdk_backend: Option<&str>,
    xdg_session_type: Option<&str>,
    wayland_display: Option<&str>,
    wayland_socket: Option<&str>,
    display: Option<&str>,
) -> Session {
    if let Some(session) = gdk_backend_session(gdk_backend) {
        return session;
    }
    match xdg_session_type.map(str::trim) {
        Some("wayland") => return Session::Wayland,
        Some("x11") => return Session::X11,
        _ => {}
    }
    let has = |value: Option<&str>| value.is_some_and(|value| !value.is_empty());
    if has(wayland_display) || has(wayland_socket) {
        return Session::Wayland;
    }
    if has(display) {
        return Session::X11;
    }
    Session::Unknown
}

/// The whole decision, from values a test can fabricate.
pub(crate) fn decide(
    user_value: Option<&str>,
    override_value: Option<&str>,
    session: Session,
) -> Decision {
    if user_value.is_some() {
        return Decision::Leave(Reason::UserValue);
    }
    match override_value.map(str::trim) {
        Some("0") => Decision::Leave(Reason::ForcedOff),
        _ if session == Session::Wayland => Decision::Disable,
        _ => Decision::Leave(Reason::NotWayland),
    }
}

fn env(name: &str) -> Option<String> {
    std::env::var_os(name).map(|value| value.to_string_lossy().to_string())
}

/// Set the mitigation before GTK/WebKitGTK initialize.
///
/// Called first in `run()`, before `tauri::generate_context!()` and the Tauri
/// builder. The web processes are spawned later and inherit the value.
pub(crate) fn apply_before_gtk_init() {
    let user_value = env(DMABUF_VAR);
    let override_value = env(OVERRIDE_VAR);
    let session = session_type(
        env("GDK_BACKEND").as_deref(),
        env("XDG_SESSION_TYPE").as_deref(),
        env("WAYLAND_DISPLAY").as_deref(),
        env("WAYLAND_SOCKET").as_deref(),
        env("DISPLAY").as_deref(),
    );
    let decision = decide(user_value.as_deref(), override_value.as_deref(), session);

    if env(DEBUG_VAR).as_deref() == Some("1") {
        eprintln!(
            "mdraft: session={session:?} {DMABUF_VAR}={user_value:?} \
             {OVERRIDE_VAR}={override_value:?} decision={decision:?}"
        );
    }

    if decision == Decision::Disable {
        // `std::env::set_var` is safe here: this runs before Tauri starts any
        // worker thread, so no other thread can be reading the environment.
        unsafe { std::env::set_var(DMABUF_VAR, "1") };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gdk_backend_outranks_the_session_variables() {
        assert_eq!(
            session_type(
                Some("x11"),
                Some("wayland"),
                Some("wayland-0"),
                None,
                Some(":0")
            ),
            Session::X11
        );
        assert_eq!(
            session_type(Some("wayland,x11"), Some("x11"), None, None, Some(":0")),
            Session::Wayland
        );
        assert_eq!(
            session_type(Some("broadway"), Some("x11"), None, None, Some(":0")),
            Session::X11
        );
    }

    #[test]
    fn socket_variables_cover_a_scrubbed_environment() {
        assert_eq!(
            session_type(None, None, Some("wayland-0"), None, Some(":0")),
            Session::Wayland
        );
        assert_eq!(
            session_type(None, None, None, Some("7"), Some(":0")),
            Session::Wayland
        );
        assert_eq!(
            session_type(None, None, None, None, Some(":0")),
            Session::X11
        );
        assert_eq!(
            session_type(None, None, Some(""), None, None),
            Session::Unknown
        );
    }

    #[test]
    fn wayland_is_enough_and_does_not_depend_on_the_gpu_driver() {
        assert_eq!(decide(None, None, Session::Wayland), Decision::Disable);
    }

    #[test]
    fn x11_and_unknown_are_left_alone() {
        assert_eq!(
            decide(None, None, Session::X11),
            Decision::Leave(Reason::NotWayland)
        );
        assert_eq!(
            decide(None, None, Session::Unknown),
            Decision::Leave(Reason::NotWayland)
        );
    }

    #[test]
    fn an_explicit_user_value_wins() {
        for value in ["0", "1", ""] {
            assert_eq!(
                decide(Some(value), None, Session::Wayland),
                Decision::Leave(Reason::UserValue),
                "{DMABUF_VAR}={value:?}"
            );
        }
    }

    #[test]
    fn the_application_override_can_switch_it_off() {
        assert_eq!(
            decide(None, Some("0"), Session::Wayland),
            Decision::Leave(Reason::ForcedOff)
        );
        assert_eq!(
            decide(None, Some("0"), Session::X11),
            Decision::Leave(Reason::ForcedOff)
        );
    }

    #[test]
    fn the_application_override_can_keep_it_on_explicitly() {
        assert_eq!(decide(None, Some("1"), Session::Wayland), Decision::Disable);
        assert_eq!(
            decide(None, Some("1"), Session::X11),
            Decision::Leave(Reason::NotWayland)
        );
    }
}
