//! Keeps the application window on the application.
//!
//! Previews render document content in the main webview. A link whose `href`
//! slips past the frontend's click handling would load a website in place of
//! the editor, and then nothing can answer the menus or the close guard: the
//! window cannot be closed without killing the process, and unsaved edits are
//! gone with the page. The frontend routes every preview link to the system
//! browser; this module makes the failure impossible to get stuck in.
//!
//! * Windows: WebView2 reports only top-level navigations, so foreign URLs are
//!   cancelled before they load.
//! * macOS/Linux: WebKit reports iframe navigations through the same hook, and
//!   an HTML preview may legitimately embed `https:` frames, so a URL alone
//!   cannot be judged there. A main-frame page load that is not the application
//!   instead sends the window straight back to it.
//! * Every platform: the main window never opens new windows (Ctrl-, Shift- or
//!   middle-click on a live link, `target="_blank"`).

use std::sync::{Arc, OnceLock};

use tauri::webview::{NewWindowResponse, PageLoadEvent};
use tauri::{Runtime, Url, WebviewWindowBuilder};

/// Whether `url` is a page of the application itself.
///
/// `dev` is the dev-server origin in debug builds. `about:blank` and
/// `about:srcdoc` are documents the webview creates itself.
pub fn is_app_url(url: &Url, dev: Option<&Url>) -> bool {
    match url.scheme() {
        "tauri" => url.host_str() == Some("localhost"),
        "about" => matches!(url.path(), "blank" | "srcdoc"),
        "http" | "https" => {
            url.host_str() == Some("tauri.localhost")
                || dev.is_some_and(|dev| url.origin() == dev.origin())
        }
        _ => false,
    }
}

/// Install the guards on a main-window builder; see the module comment.
pub fn guard<'a, R: Runtime, M: tauri::Manager<R>>(
    builder: WebviewWindowBuilder<'a, R, M>,
    dev: Option<Url>,
) -> WebviewWindowBuilder<'a, R, M> {
    // The first application page the window loads is where it returns to.
    let home: Arc<OnceLock<Url>> = Arc::new(OnceLock::new());
    let builder = builder.on_new_window(|_, _| NewWindowResponse::Deny);

    #[cfg(windows)]
    let builder = {
        let dev = dev.clone();
        builder.on_navigation(move |url| {
            let allowed = is_app_url(url, dev.as_ref());
            if !allowed {
                eprintln!(
                    "[navigation] blocked main-window navigation to {}",
                    url.origin().ascii_serialization()
                );
            }
            allowed
        })
    };

    builder.on_page_load(move |window, payload| {
        if payload.event() != PageLoadEvent::Started {
            return;
        }
        let url = payload.url();
        if is_app_url(url, dev.as_ref()) {
            if url.scheme() != "about" {
                let _ = home.set(url.clone());
            }
            return;
        }
        if let Some(home) = home.get() {
            eprintln!("[navigation] main window left the application; returning");
            let _ = window.navigate(home.clone());
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(value: &str) -> Url {
        Url::parse(value).unwrap()
    }

    #[test]
    fn application_pages_are_allowed() {
        assert!(is_app_url(&url("tauri://localhost/index.html"), None));
        assert!(is_app_url(&url("http://tauri.localhost/"), None));
        assert!(is_app_url(&url("https://tauri.localhost/index.html"), None));
        assert!(is_app_url(&url("about:blank"), None));
        let dev = url("http://localhost:1420");
        assert!(is_app_url(
            &url("http://localhost:1420/src/main.ts"),
            Some(&dev)
        ));
    }

    #[test]
    fn foreign_pages_are_refused() {
        assert!(!is_app_url(&url("https://typst.app/"), None));
        assert!(!is_app_url(&url("http://localhost:1420/"), None));
        assert!(!is_app_url(
            &url("http://localhost:8080/"),
            Some(&url("http://localhost:1420"))
        ));
        assert!(!is_app_url(
            &url("http://tauri.localhost.example.com/"),
            None
        ));
        assert!(!is_app_url(&url("tauri://evil/"), None));
        assert!(!is_app_url(&url("file:///C:/Windows/"), None));
        assert!(!is_app_url(&url("http://asset.localhost/x"), None));
        assert!(!is_app_url(&url("about:config"), None));
    }
}
