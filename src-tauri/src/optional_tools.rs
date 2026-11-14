//! The optional tools' install contract: progress events and a bounded reader.
//!
//! Pandoc, Typst and the bundled TeX engine are downloaded in-process on
//! request. The frontend needs to show real bytes and phases, and every install
//! needs one lifetime rule rather than three different ones. This module owns
//! the event payload and the chunked read loop; the tool-specific installers
//! own the source, the checksum and the atomic write.
//!
//! **No install survives the application.** The work runs in `spawn_blocking`;
//! closing MDraft ends the process and the thread with it. There is deliberately
//! no detached downloader, job file or resume path.

use serde::Serialize;
use std::io::Read;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Runtime};

/// One overall deadline for an optional tool install, including its release
/// lookup and every archive read. The per-request agent timeouts are shorter or
/// equal; this one is the rule the UI promises.
pub const INSTALL_TIMEOUT: Duration = Duration::from_secs(600);

/// The frontend listens for exactly this event.
pub const PROGRESS_EVENT: &str = "optional-tools-progress";

/// The three optional tools. The serialized name matches the frontend type.
#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Tool {
    Pandoc,
    Typst,
    Latex,
}

/// The stages a row can show. `Ready` is informational; the command's resolved
/// status is what sets the final state, so a late event cannot claim success.
#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Phase {
    Downloading,
    Verifying,
    Unpacking,
    Ready,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub tool: Tool,
    pub phase: Phase,
    pub received: u64,
    pub total: Option<u64>,
}

/// Emit one progress event. A missing webview or a closed window is not an
/// install failure: the download continues and the next status probe reports it.
pub fn emit<R: Runtime>(app: &AppHandle<R>, progress: Progress) {
    let _ = app.emit(PROGRESS_EVENT, progress);
}

/// Start the clock for one install.
pub fn deadline() -> Instant {
    Instant::now() + INSTALL_TIMEOUT
}

/// Fail before the next asset when the overall deadline has passed.
pub fn check_deadline(deadline: Instant) -> Result<(), String> {
    if Instant::now() >= deadline {
        Err("The download did not finish within its time limit.".into())
    } else {
        Ok(())
    }
}

/// Read a response body into memory, enforcing one byte cap and one deadline.
///
/// The archive stays in memory so a killed process leaves no partial file. The
/// callback is called after each chunk; callers throttle it, because this loop
/// sees 64 KB at a time.
pub fn read_to_vec_bounded(
    reader: &mut impl Read,
    cap: u64,
    deadline: Instant,
    mut on_bytes: impl FnMut(u64),
) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        check_deadline(deadline)?;
        let read = reader
            .read(&mut buffer)
            .map_err(|error| format!("Could not read the download: {error}"))?;
        if read == 0 {
            return Ok(out);
        }
        if out.len() as u64 + read as u64 > cap {
            return Err(format!(
                "The download exceeded its {} MB limit.",
                cap / (1024 * 1024)
            ));
        }
        out.extend_from_slice(&buffer[..read]);
        on_bytes(out.len() as u64);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn reads_the_whole_body_and_reports_progress() {
        let bytes = vec![7u8; 200 * 1024];
        let mut seen = Vec::new();
        let out = read_to_vec_bounded(
            &mut Cursor::new(bytes.clone()),
            1024 * 1024,
            deadline(),
            |received| seen.push(received),
        )
        .expect("the body fits");
        assert_eq!(out, bytes);
        assert_eq!(seen.last().copied(), Some(bytes.len() as u64));
        assert!(
            seen.windows(2).all(|pair| pair[0] <= pair[1]),
            "progress must not go backwards: {seen:?}"
        );
    }

    #[test]
    fn stops_at_the_cap() {
        let error = read_to_vec_bounded(
            &mut Cursor::new(vec![0u8; 2 * 1024 * 1024]),
            1024 * 1024,
            deadline(),
            |_| {},
        )
        .expect_err("the body is over the cap");
        assert!(error.contains("limit"), "{error}");
    }

    #[test]
    fn stops_after_the_deadline() {
        let past = Instant::now()
            .checked_sub(Duration::from_secs(1))
            .expect("a recent instant has a past");
        let error = read_to_vec_bounded(&mut Cursor::new(vec![0u8; 1]), 1024, past, |_| {})
            .expect_err("the deadline has passed");
        assert!(error.contains("time limit"), "{error}");
    }
}
