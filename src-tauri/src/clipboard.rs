//! Plain-text clipboard for the editor's menu.
//!
//! This replaces `tauri-plugin-clipboard-manager`, which links `arboard` with
//! its default `image-data` feature. That feature pulls the PNG and BMP codecs
//! into every build for clipboard image support this application never calls:
//! clipboard images arrive as `ClipboardEvent` data and go to
//! `images::save_clipboard_image`, not through the clipboard API. The default
//! features stay off in `Cargo.toml`; `wayland-data-control` is the Linux
//! backend the plugin enabled too.
//!
//! One `Clipboard` lives for the whole session, as the plugin's did. On X11 and
//! Wayland the application that copied the text is the one that must answer
//! later paste requests, so a per-call instance would lose the contents as soon
//! as the command returned.

use std::sync::Mutex;

/// The long-lived clipboard handle, managed by the Tauri app.
pub struct ClipboardStore(Mutex<Option<arboard::Clipboard>>);

impl ClipboardStore {
    /// Open the system clipboard once. A failure is kept and reported per
    /// call, so a missing display or a locked clipboard cannot abort start-up.
    pub fn new() -> Self {
        Self(Mutex::new(arboard::Clipboard::new().ok()))
    }

    fn with<T>(
        &self,
        operation: impl FnOnce(&mut arboard::Clipboard) -> Result<T, arboard::Error>,
    ) -> Result<T, String> {
        let mut guard = self
            .0
            .lock()
            .map_err(|_| "The system clipboard is unavailable.".to_string())?;
        let clipboard = guard
            .as_mut()
            .ok_or_else(|| "The system clipboard could not be opened.".to_string())?;
        operation(clipboard).map_err(|error| error.to_string())
    }

    fn read_text(&self) -> Result<String, String> {
        self.with(|clipboard| clipboard.get_text())
    }

    fn write_text(&self, text: &str) -> Result<(), String> {
        self.with(|clipboard| clipboard.set_text(text))
    }

    /// Drop the handle on exit so the platform can release what it owns. The
    /// plugin did this on `RunEvent::Exit`; a destructor is not enough because
    /// managed state does not have a defined drop order at process shutdown.
    pub fn release(&self) {
        if let Ok(mut guard) = self.0.lock() {
            guard.take();
        }
    }
}

#[tauri::command]
pub async fn clipboard_read_text(
    state: tauri::State<'_, ClipboardStore>,
) -> Result<String, String> {
    state.read_text()
}

#[tauri::command]
pub async fn clipboard_write_text(
    state: tauri::State<'_, ClipboardStore>,
    text: String,
) -> Result<(), String> {
    state.write_text(&text)
}
