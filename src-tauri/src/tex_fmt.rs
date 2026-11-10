//! The LaTeX formatter's WebAssembly module, fetched once and cached.
//!
//! tex-fmt's npm entry imports its 1.66 MiB `.wasm` module, so bundling the
//! package puts the formatter inside every executable, including the sessions
//! that never format a `.tex` file. The wasm-bindgen glue is 8 KiB and can be
//! bundled on its own; the bytes are fetched here on the first Format Document
//! and cached, the same user-initiated-download shape the LaTeX engine uses.

use std::path::PathBuf;

use tauri::Manager;

const VERSION: &str = "0.5.7-npm.1";
/// Pinned to the immutable npm release; jsDelivr serves package files directly.
const URL: &str = "https://cdn.jsdelivr.net/npm/tex-fmt@0.5.7-npm.1/tex_fmt_bg.wasm";
const SHA256: &str = "830a0f2b31ead82b1852be061386029fa2deee4aeb0e77e6061bb1b3d02f23ad";
const MAX_BYTES: usize = 4 * 1024 * 1024;

fn cache_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|error| format!("No application data directory: {error}"))?
        .join("tex-fmt")
        .join(VERSION)
        .join("tex_fmt_bg.wasm"))
}

fn fetch() -> Result<Vec<u8>, String> {
    let mut response = ureq::get(URL).call().map_err(|error| {
        format!("The LaTeX formatter needs a one-time download, which failed: {error}")
    })?;
    response
        .body_mut()
        .with_config()
        .limit(MAX_BYTES as u64)
        .read_to_vec()
        .map_err(|error| format!("The LaTeX formatter download could not be read: {error}"))
}

/// Bytes of `tex_fmt_bg.wasm`, downloaded and hash-verified on first use.
///
/// The reply is a raw IPC payload: a `Vec<u8>` would cross the boundary as a
/// JSON array of 1.7 million numbers.
#[tauri::command]
pub async fn tex_fmt_wasm(app: tauri::AppHandle) -> Result<tauri::ipc::Response, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = cache_path(&app)?;
        if let Ok(bytes) = std::fs::read(&path)
            && bytes.len() <= MAX_BYTES
            && crate::latex::digest(&bytes) == SHA256
        {
            return Ok(tauri::ipc::Response::new(bytes));
        }
        // A cache file that fails verification is replaced, not trusted: the
        // checksum is the only thing that makes the download safe to execute.
        let bytes = fetch()?;
        if crate::latex::digest(&bytes) != SHA256 {
            return Err("The downloaded LaTeX formatter did not match its pinned checksum.".into());
        }
        crate::latex::write_atomic(&path, &bytes)?;
        Ok(tauri::ipc::Response::new(bytes))
    })
    .await
    .map_err(|error| format!("The LaTeX formatter task failed: {error}"))?
}
