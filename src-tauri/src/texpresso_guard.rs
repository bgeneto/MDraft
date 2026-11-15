//! The download budget of one TeXpresso preview session.
//!
//! A document can make the engine download far more than it typesets: one
//! missing font made luaotfload open every font in the bundle, about 3,300
//! downloads and 1 GB per compile (2026-11-15). The preview now turns that
//! rebuild off (`src/texpresso/luaotfload.ts`), and this guard is the backstop
//! for every other runaway: XeTeX, a document that loads a whole font family
//! tree, or a cause nobody has seen yet.
//!
//! The download that would cross a budget is **held**, not refused: its
//! request waits while the reader is asked. Continue doubles that budget and
//! the download goes ahead, so nothing is lost; Stop refuses it and every
//! later download of the session. Refusing outright would leave the pinned
//! engine with a failed read it was never written to expect, and the decision
//! would be the guard's instead of the reader's.
//!
//! A session starts when the frame loads its page (`latex_texpresso::serve`),
//! which also releases any request still held by the previous frame.

use serde::Serialize;
use std::{
    collections::HashSet,
    sync::{Condvar, LazyLock, Mutex, MutexGuard},
};

/// Distinct font files one session may download before the reader is asked.
/// A long book with a few families uses a few dozen; the scan this guards
/// against opens thousands.
const FONT_BUDGET: usize = 100;
/// Files of any kind, and bytes, before the reader is asked. A cold compile of
/// a large book downloads a few hundred files and well under 300 MB.
const FILE_BUDGET: u64 = 1_500;
const BYTE_BUDGET: u64 = 750 * 1024 * 1024;

/// The message a refused download carries after Stop.
pub const STOPPED: &str = "TeX file downloads were stopped for this preview.";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Reason {
    /// More distinct font files than the font budget.
    Fonts,
    /// More files than the file budget.
    Files,
    /// More bytes than the byte budget.
    Bytes,
}

/// What the preview shows while a download waits for the reader.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Held {
    pub reason: Reason,
    /// Distinct font files, all files and bytes downloaded so far this session.
    pub fonts: u64,
    pub files: u64,
    pub bytes: u64,
}

/// The guard's state as `latex_stats` reports it.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub held: Option<Held>,
    pub stopped: bool,
    /// Bytes the files this session uses occupy in the cache, when that alone
    /// is more than the cache limit; eviction then leaves them in place.
    pub cache_overflow: Option<u64>,
}

struct Guard {
    session: u64,
    fonts: HashSet<String>,
    files: u64,
    bytes: u64,
    font_budget: usize,
    file_budget: u64,
    byte_budget: u64,
    held: Option<Held>,
    stopped: bool,
    /// Bundle paths (`files/…`) this session read, from the cache or the
    /// network: eviction must not remove what the next compile reads again.
    working: HashSet<String>,
    cache_overflow: Option<u64>,
}

impl Guard {
    fn new(session: u64) -> Self {
        Guard {
            session,
            fonts: HashSet::new(),
            files: 0,
            bytes: 0,
            font_budget: FONT_BUDGET,
            file_budget: FILE_BUDGET,
            byte_budget: BYTE_BUDGET,
            held: None,
            stopped: false,
            working: HashSet::new(),
            cache_overflow: None,
        }
    }

    /// The budget downloading `path` would cross, if any.
    fn crossing(&self, path: &str) -> Option<Reason> {
        if is_font(path) && !self.fonts.contains(path) && self.fonts.len() >= self.font_budget {
            Some(Reason::Fonts)
        } else if self.files >= self.file_budget {
            Some(Reason::Files)
        } else if self.bytes >= self.byte_budget {
            Some(Reason::Bytes)
        } else {
            None
        }
    }

    fn snapshot(&self, reason: Reason) -> Held {
        Held {
            reason,
            fonts: self.fonts.len() as u64,
            files: self.files,
            bytes: self.bytes,
        }
    }
}

static GUARD: LazyLock<(Mutex<Guard>, Condvar)> =
    LazyLock::new(|| (Mutex::new(Guard::new(0)), Condvar::new()));

fn guard() -> MutexGuard<'static, Guard> {
    GUARD.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The font formats luaotfload and XeTeX scan.
pub fn is_font(path: &str) -> bool {
    let name = path.strip_suffix("~h").unwrap_or(path).to_ascii_lowercase();
    [".otf", ".ttf", ".ttc", ".pfb", ".afm"]
        .iter()
        .any(|suffix| name.ends_with(suffix))
}

/// A new frame: fresh budgets, and any request the old frame left waiting is
/// released as refused (its frame is gone).
pub fn reset() {
    let mut state = guard();
    let next = state.session.wrapping_add(1);
    *state = Guard::new(next);
    GUARD.1.notify_all();
}

/// Wait until downloading `path` is within budget, or the reader decides.
pub fn admit(path: &str) -> Result<(), String> {
    let mut state = guard();
    let session = state.session;
    loop {
        if state.session != session {
            return Err("The preview restarted.".into());
        }
        if state.stopped {
            return Err(STOPPED.into());
        }
        let Some(reason) = state.crossing(path) else {
            return Ok(());
        };
        if state.held.is_none() {
            state.held = Some(state.snapshot(reason));
        }
        while state.held.is_some() && state.session == session {
            state = GUARD
                .1
                .wait(state)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
        }
        // Re-evaluated: Continue raised a budget, Stop set `stopped`, a reset
        // changed the session.
    }
}

/// Count a finished download.
pub fn record(path: &str, bytes: u64) {
    let mut state = guard();
    state.files += 1;
    state.bytes = state.bytes.saturating_add(bytes);
    if is_font(path) {
        state.fonts.insert(path.to_string());
    }
}

/// The reader's answer to the held download; false when nothing was held.
pub fn decide(allow: bool) -> bool {
    let mut state = guard();
    let Some(held) = state.held.take() else {
        return false;
    };
    if allow {
        // Double from what was used, so a second prompt comes as late again.
        match held.reason {
            Reason::Fonts => state.font_budget = state.font_budget.max(state.fonts.len()) * 2,
            Reason::Files => state.file_budget = state.file_budget.max(state.files) * 2,
            Reason::Bytes => state.byte_budget = state.byte_budget.max(state.bytes) * 2,
        }
    } else {
        state.stopped = true;
    }
    GUARD.1.notify_all();
    true
}

/// Remember a bundle file the session read.
pub fn note_working(path: &str) {
    let mut state = guard();
    if !state.working.contains(path) {
        state.working.insert(path.to_string());
    }
}

/// Whether eviction must keep `path` (a `files/…` path with `/`).
pub fn working_contains(path: &str) -> bool {
    guard().working.contains(path)
}

pub fn set_cache_overflow(bytes: Option<u64>) {
    guard().cache_overflow = bytes;
}

pub fn report() -> Report {
    let state = guard();
    Report {
        held: state.held.clone(),
        stopped: state.stopped,
        cache_overflow: state.cache_overflow,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{thread, time::Duration};

    /// The guard is process-wide; its tests run one at a time.
    static SERIAL: Mutex<()> = Mutex::new(());

    fn serial() -> MutexGuard<'static, ()> {
        SERIAL.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn font(n: usize) -> String {
        format!("files/tt2026/v3/Font{n}.otf~h")
    }

    fn wait_held() -> Held {
        for _ in 0..200 {
            if let Some(held) = report().held {
                return held;
            }
            thread::sleep(Duration::from_millis(5));
        }
        panic!("no download was held");
    }

    #[test]
    fn fonts_are_recognised_by_format() {
        assert!(is_font("files/tt2026/v3/LXGWNeoXiHei.ttf~h"));
        assert!(is_font("files/tt2026/v1/ASANA.TTC~h"));
        assert!(is_font("files/tt2022/v1/cmr10.pfb~h"));
        assert!(!is_font("files/tt2026/v1/fontspec.sty~h"));
        assert!(!is_font("files/tt2026/v1/cmr10.tfm~h"));
    }

    #[test]
    fn a_font_scan_is_held_until_the_reader_continues() {
        let _one = serial();
        reset();
        for n in 0..FONT_BUDGET {
            admit(&font(n)).unwrap();
            record(&font(n), 10);
        }
        // A font already downloaded is not a new one, and other files pass.
        admit(&font(0)).unwrap();
        admit("files/tt2026/v1/fontspec.sty~h").unwrap();

        let waiting = thread::spawn(|| admit(&font(FONT_BUDGET)));
        let held = wait_held();
        assert_eq!(held.reason, Reason::Fonts);
        assert_eq!(held.fonts, FONT_BUDGET as u64);
        assert!(!waiting.is_finished(), "the download waits for the reader");

        assert!(decide(true));
        waiting.join().unwrap().unwrap();
        assert!(report().held.is_none());
        // Continue doubled the budget: the next font passes at once.
        record(&font(FONT_BUDGET), 10);
        admit(&font(FONT_BUDGET + 1)).unwrap();
    }

    #[test]
    fn stop_refuses_the_held_download_and_the_rest_of_the_session() {
        let _one = serial();
        reset();
        for n in 0..FONT_BUDGET {
            record(&font(n), 10);
        }
        let waiting = thread::spawn(|| admit(&font(FONT_BUDGET)));
        wait_held();
        assert!(decide(false));
        assert_eq!(waiting.join().unwrap().unwrap_err(), STOPPED);
        assert!(report().stopped);
        assert_eq!(admit("files/tt2026/v1/fontspec.sty~h").unwrap_err(), STOPPED);

        // A new frame starts with a clean slate.
        reset();
        assert_eq!(report(), Report::default());
        admit(&font(FONT_BUDGET)).unwrap();
    }

    #[test]
    fn file_and_byte_budgets_hold_too() {
        let _one = serial();
        reset();
        for n in 0..FILE_BUDGET {
            record(&format!("files/tt2026/v1/p{n}.sty~h"), 1);
        }
        let waiting = thread::spawn(|| admit("files/tt2026/v1/more.sty~h"));
        assert_eq!(wait_held().reason, Reason::Files);
        decide(true);
        waiting.join().unwrap().unwrap();

        reset();
        record("files/tt2026/v1/big.fmt~h", BYTE_BUDGET);
        let waiting = thread::spawn(|| admit("files/tt2026/v1/next.sty~h"));
        assert_eq!(wait_held().reason, Reason::Bytes);
        decide(true);
        waiting.join().unwrap().unwrap();
    }

    #[test]
    fn a_new_frame_releases_a_held_download_as_refused() {
        let _one = serial();
        reset();
        for n in 0..FONT_BUDGET {
            record(&font(n), 10);
        }
        let waiting = thread::spawn(|| admit(&font(FONT_BUDGET)));
        wait_held();
        reset();
        assert!(waiting.join().unwrap().is_err());
        assert!(!decide(true), "nothing is held after the reset");
    }

    #[test]
    fn the_working_set_is_per_session() {
        let _one = serial();
        reset();
        note_working("files/tt2026/v1/fontspec.sty~h");
        assert!(working_contains("files/tt2026/v1/fontspec.sty~h"));
        assert!(!working_contains("files/tt2026/v1/other.sty~h"));
        reset();
        assert!(!working_contains("files/tt2026/v1/fontspec.sty~h"));
    }
}
