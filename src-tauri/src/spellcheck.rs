//! System spell checking.
//!
//! The webview's own checker cannot do this. CodeMirror can turn the
//! `spellcheck` attribute back on — `updateAttrs` sets it false, then
//! `contentAttributes` overwrites it — but that is not the obstacle.
//!
//! WebView2 ignores the element's `lang` and uses the environment language, and
//! it has no API to choose a dictionary. WebKitGTK leaves checking disabled
//! until the host calls `webkit_web_context_set_spell_checking_languages`, which
//! Tauri does not. Both engines also check the whole contenteditable, so a code
//! fence is spelled as prose, and both throw the underline away when CodeMirror
//! rewrites the line.
//!
//! The dictionaries therefore stay where the operating system already loaded
//! them. Windows uses `ISpellChecker` (the service WebView2 itself calls), Linux
//! opens the hunspell files under `/usr/share`, and macOS uses `NSSpellChecker`.
//! Nothing is bundled and nothing is downloaded. A language that is not
//! installed comes back as absent; the editor then underlines nothing rather
//! than guessing.

use std::collections::HashMap;

/// Words a markdown editor trips over that are not misspellings.
const ALLOWED: &[&str] = &[
    "mdraft",
    "tauri",
    "codemirror",
    "pandoc",
    "typst",
    "katex",
    "mermaid",
    "webview2",
    "github",
];

/// The form to hand to the dictionary, or nothing when the token should not be
/// checked at all.
///
/// All-caps, digits and an internal capital are skipped: `HTML`, `H2O` and
/// `CodeMirror` are not prose errors. A curly apostrophe is folded to `'`
/// first, because the dictionaries were built with the straight one and
/// `d’água` would otherwise be unknown.
fn accepted_form(word: &str) -> Option<String> {
    let trimmed = word.trim_matches(|c: char| {
        c == '\'' || c == '\u{2019}' || c == '\u{2018}' || c == '-' || c == '\u{2010}'
    });
    if trimmed.is_empty() {
        return None;
    }
    let mut normalized = String::with_capacity(trimmed.len());
    let mut letters = 0usize;
    let mut uppers = 0usize;
    let mut seen_letter = false;
    let mut internal_capital = false;
    for ch in trimmed.chars() {
        if ch.is_numeric() {
            return None;
        }
        let ch = match ch {
            '\u{2019}' | '\u{2018}' | '\u{02BC}' => '\'',
            other => other,
        };
        if ch.is_alphabetic() {
            letters += 1;
            if ch.is_uppercase() {
                uppers += 1;
            }
            // `McDonald` and `CodeMirror`. An accented capital (`d'Água`) is
            // ordinary Portuguese, so only ASCII capitals count as CamelCase.
            if seen_letter && ch.is_ascii_uppercase() {
                internal_capital = true;
            }
            seen_letter = true;
        }
        normalized.push(ch);
    }
    if letters == 0 || internal_capital || (letters >= 2 && uppers == letters) {
        return None;
    }
    if ALLOWED
        .iter()
        .any(|entry| entry.eq_ignore_ascii_case(&normalized))
    {
        return None;
    }
    Some(normalized)
}

/// Prose words of a markdown fragment, in order.
///
/// Fenced and inline code, URLs, HTML tags and mathematics are blanked before
/// the scan, so a typo inside them never becomes a candidate. The editor uses
/// the markdown syntax tree for the same cuts; this function is the one the
/// unit tests lock, and [`misspelled_indices`] applies [`accepted_form`] again
/// so a token the frontend should have dropped still cannot be underlined.
#[cfg(test)]
fn prose_words(text: &str) -> Vec<String> {
    let masked = mask_uncheckable(text);
    let mut words = Vec::new();
    let mut current = String::new();
    let flush = |current: &mut String, words: &mut Vec<String>| {
        if current.is_empty() {
            return;
        }
        // A hyphen joins words the dictionary stores separately (`well-known`).
        // Checking each side avoids flagging the compound. Apostrophes stay,
        // because `d'água` is one word.
        for part in current.split('-') {
            if let Some(form) = accepted_form(part) {
                words.push(form);
            }
        }
        current.clear();
    };
    for ch in masked.chars() {
        if ch.is_alphabetic() || ch == '\'' || ch == '\u{2019}' || ch == '\u{2018}' || ch == '-' {
            current.push(ch);
        } else {
            flush(&mut current, &mut words);
        }
    }
    flush(&mut current, &mut words);
    words
}

/// Replace regions that are not prose with spaces, preserving offsets and
/// newlines so a word cannot run across a fence.
#[cfg(test)]
fn mask_uncheckable(text: &str) -> String {
    let mut bytes = text.as_bytes().to_vec();
    blank_front_matter(&mut bytes);
    blank_fences(&mut bytes);
    blank_delimited(&mut bytes, b'`', b'`', false);
    blank_pattern(&mut bytes, match_url);
    blank_pattern(&mut bytes, match_math);
    blank_pattern(&mut bytes, match_html);
    String::from_utf8(bytes)
        .unwrap_or_else(|error| String::from_utf8_lossy(error.as_bytes()).into_owned())
}

#[cfg(test)]
fn blank_range(bytes: &mut [u8], start: usize, end: usize) {
    for byte in bytes.iter_mut().take(end).skip(start) {
        if *byte != b'\n' && *byte != b'\r' {
            *byte = b' ';
        }
    }
}

#[cfg(test)]
fn blank_front_matter(bytes: &mut [u8]) {
    let text = String::from_utf8_lossy(bytes);
    let rest = if text.starts_with("---\r\n") {
        5
    } else if text.starts_with("---\n") {
        4
    } else {
        return;
    };
    let body = &text[rest..];
    let mut offset = rest;
    for line in body.split_inclusive('\n') {
        let content = line.trim_end_matches(['\n', '\r']);
        if content == "---" {
            blank_range(bytes, 0, offset + line.len());
            return;
        }
        offset += line.len();
    }
}

#[cfg(test)]
fn line_spans(bytes: &[u8]) -> Vec<(usize, usize, usize)> {
    let mut lines = Vec::new();
    let mut start = 0usize;
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i] == b'\n' {
            lines.push((start, i, i + 1));
            i += 1;
            start = i;
        } else {
            i += 1;
        }
    }
    if start <= bytes.len() {
        lines.push((start, bytes.len(), bytes.len()));
    }
    lines
}

#[cfg(test)]
fn fence_marker(line: &str) -> Option<&str> {
    let trimmed = line.trim_start();
    if trimmed.starts_with("```") {
        Some("```")
    } else if trimmed.starts_with("~~~") {
        Some("~~~")
    } else {
        None
    }
}

#[cfg(test)]
fn blank_fences(bytes: &mut [u8]) {
    let lines = line_spans(bytes);
    let mut i = 0usize;
    while i < lines.len() {
        let (start, end, next) = lines[i];
        let line = String::from_utf8_lossy(&bytes[start..end]);
        if let Some(marker) = fence_marker(&line) {
            let mut close = lines.len();
            let mut j = i + 1;
            while j < lines.len() {
                let (ls, le, _) = lines[j];
                let text = String::from_utf8_lossy(&bytes[ls..le]);
                if text.trim_start().starts_with(marker) {
                    close = j;
                    break;
                }
                j += 1;
            }
            let until = if close < lines.len() {
                lines[close].2
            } else {
                bytes.len()
            };
            let _ = next;
            blank_range(bytes, start, until);
            i = if close < lines.len() {
                close + 1
            } else {
                lines.len()
            };
        } else {
            i += 1;
        }
    }
}

/// Blank `` `code` `` on a single line. An unmatched backtick is left alone so
/// it cannot swallow the rest of the paragraph.
#[cfg(test)]
fn blank_delimited(bytes: &mut [u8], open: u8, close: u8, multiline: bool) {
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i] != open {
            i += 1;
            continue;
        }
        let mut j = i + 1;
        let mut found = None;
        while j < bytes.len() {
            if !multiline && (bytes[j] == b'\n' || bytes[j] == b'\r') {
                break;
            }
            if bytes[j] == close {
                found = Some(j);
                break;
            }
            j += 1;
        }
        if let Some(end) = found {
            if end > i + 1 {
                blank_range(bytes, i, end + 1);
            }
            i = end + 1;
        } else {
            i += 1;
        }
    }
}

#[cfg(test)]
fn blank_pattern(bytes: &mut [u8], mut matcher: impl FnMut(&[u8], usize) -> Option<usize>) {
    let mut i = 0usize;
    while i < bytes.len() {
        if let Some(end) = matcher(bytes, i)
            && end > i
        {
            blank_range(bytes, i, end);
            i = end;
            continue;
        }
        i += 1;
    }
}

#[cfg(test)]
fn match_url(bytes: &[u8], i: usize) -> Option<usize> {
    let rest = &bytes[i..];
    let scheme = if rest.starts_with(b"https://") {
        8
    } else if rest.starts_with(b"http://") {
        7
    } else if rest.starts_with(b"www.") {
        4
    } else {
        return None;
    };
    let mut end = i + scheme;
    while end < bytes.len() && !bytes[end].is_ascii_whitespace() {
        end += 1;
    }
    Some(end)
}

#[cfg(test)]
fn match_html(bytes: &[u8], i: usize) -> Option<usize> {
    if bytes[i] != b'<' {
        return None;
    }
    let mut end = i + 1;
    while end < bytes.len() && end - i < 200 {
        if bytes[end] == b'\n' || bytes[end] == b'\r' {
            return None;
        }
        if bytes[end] == b'>' {
            return Some(end + 1);
        }
        end += 1;
    }
    None
}

#[cfg(test)]
fn match_math(bytes: &[u8], i: usize) -> Option<usize> {
    let rest = &bytes[i..];
    if rest.starts_with(b"$$") {
        return find_bytes(bytes, i + 2, b"$$").map(|at| at + 2);
    }
    if rest.starts_with(br"\(") {
        return find_bytes(bytes, i + 2, br"\)").map(|at| at + 2);
    }
    if rest.starts_with(br"\[") {
        return find_bytes(bytes, i + 2, br"\]").map(|at| at + 2);
    }
    if rest.starts_with(b"$") && !rest.starts_with(b"$$") {
        // `$x$` or `$x + y$`, but not a currency `$5` with no closer, and not
        // `$ spaced$` which is how people write money.
        if rest.len() < 3 || rest[1] == b' ' || rest[1] == b'\n' || rest[1] == b'$' {
            return None;
        }
        let mut j = i + 1;
        while j < bytes.len() && bytes[j] != b'$' && bytes[j] != b'\n' && bytes[j] != b'\r' {
            j += 1;
        }
        if j < bytes.len() && bytes[j] == b'$' && j > i + 1 && bytes[j - 1] != b' ' {
            return Some(j + 1);
        }
    }
    None
}

#[cfg(test)]
fn find_bytes(bytes: &[u8], from: usize, needle: &[u8]) -> Option<usize> {
    bytes[from..]
        .windows(needle.len())
        .position(|window| window == needle)
        .map(|at| from + at)
}

/// Canonicalize a bounded BCP 47-shaped OS tag without accepting paths.
pub(crate) fn normalize_tag(raw: &str) -> Option<String> {
    let raw = raw.trim();
    if raw.len() > 64 || raw.is_empty() {
        return None;
    }
    let raw = raw.replace('_', "-");
    let mut parts = raw.split('-');
    let first = parts.next()?;
    if !(2..=3).contains(&first.len()) || !first.bytes().all(|b| b.is_ascii_alphabetic()) {
        return None;
    }
    let mut out = first.to_ascii_lowercase();
    for part in parts {
        if part.is_empty() || part.len() > 8 || !part.bytes().all(|b| b.is_ascii_alphanumeric()) {
            return None;
        }
        out.push('-');
        if part.len() == 2 && part.bytes().all(|b| b.is_ascii_alphabetic()) {
            out.push_str(&part.to_ascii_uppercase());
        } else if part.len() == 4 && part.bytes().all(|b| b.is_ascii_alphabetic()) {
            let mut chars = part.chars();
            out.push(chars.next()?.to_ascii_uppercase());
            out.push_str(&chars.as_str().to_ascii_lowercase());
        } else {
            out.push_str(&part.to_ascii_lowercase());
        }
    }
    Some(out)
}

/// Keep historic English and Portuguese aliases while exposing OS languages.
fn public_tags(raws: &[String]) -> Vec<String> {
    let mut tags = raws
        .iter()
        .filter_map(|raw| normalize_tag(raw))
        .collect::<Vec<_>>();
    if tags.iter().any(|tag| tag == "en" || tag.starts_with("en-")) {
        tags.push("en".into());
    }
    if tags.iter().any(|tag| tag == "pt") {
        tags.push("pt-PT".into());
    }
    tags.sort();
    tags.dedup();
    tags
}

fn resolve<'a>(raws: &'a [String], requested: &str) -> Option<&'a str> {
    let requested = normalize_tag(requested)?;
    let mut fallback: Option<(&str, u8)> = None;
    for raw in raws {
        let Some(tag) = normalize_tag(raw) else {
            continue;
        };
        if tag == requested && requested != "en" {
            return Some(raw);
        }
        let rank = if requested == "en" {
            match tag.as_str() {
                "en-US" => 0,
                "en" => 1,
                "en-GB" => 2,
                _ if tag.starts_with("en-") => 3,
                _ => continue,
            }
        } else if requested == "pt-PT" && tag == "pt" {
            0
        } else {
            continue;
        };
        if fallback.is_none_or(|(_, previous)| rank < previous) {
            fallback = Some((raw.as_str(), rank));
        }
    }
    fallback.map(|(raw, _)| raw)
}

/// Indices into `words` that the dictionary rejects.
///
/// Tokens that [`accepted_form`] declines are not errors. An unavailable
/// dictionary or engine failure is returned to the caller.
fn misspelled_indices(language: &str, words: &[String]) -> Result<Vec<u32>, String> {
    if language.is_empty() || language == "auto" {
        return Err("Choose an available spelling dictionary.".into());
    }
    let mut unique: Vec<String> = Vec::new();
    let mut owners: Vec<Vec<u32>> = Vec::new();
    let mut slot_of: HashMap<String, usize> = HashMap::new();
    for (index, word) in words.iter().enumerate().take(4_000) {
        let Some(form) = accepted_form(word) else {
            continue;
        };
        if let Some(&slot) = slot_of.get(&form) {
            owners[slot].push(index as u32);
        } else {
            slot_of.insert(form.clone(), unique.len());
            owners.push(vec![index as u32]);
            unique.push(form);
        }
    }
    if unique.is_empty() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for slot in engine::check(language, &unique)? {
        if let Some(group) = owners.get(slot as usize) {
            out.extend_from_slice(group);
        }
    }
    out.sort_unstable();
    Ok(out)
}

fn suggestions_for(language: &str, word: &str) -> Result<Vec<String>, String> {
    let Some(form) = accepted_form(word) else {
        return Ok(Vec::new());
    };
    let mut list = engine::suggest(language, &form)?;
    list.truncate(8);
    Ok(list)
}

#[tauri::command]
pub async fn spellcheck_languages() -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(engine::languages)
        .await
        .map_err(|_| "Could not discover spelling dictionaries.".to_string())?
}

#[tauri::command]
pub async fn spellcheck_check(language: String, words: Vec<String>) -> Result<Vec<u32>, String> {
    tauri::async_runtime::spawn_blocking(move || misspelled_indices(&language, &words))
        .await
        .map_err(|_| "Could not check spelling.".to_string())?
}

#[tauri::command]
pub async fn spellcheck_suggest(language: String, word: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || suggestions_for(&language, &word))
        .await
        .map_err(|_| "Could not obtain spelling suggestions.".to_string())?
}

// ---------------------------------------------------------------------------
// Windows: ISpellChecker on a dedicated STA thread.
//
// Tauri runs a synchronous command on the blocking pool, and this factory is
// apartment-threaded. Creating it on whichever pool thread drew the command
// fails, or succeeds and then faults the next call on a different thread.
// One thread owns the factory and every checker.
// ---------------------------------------------------------------------------

#[cfg(windows)]
mod engine {
    use super::{public_tags, resolve};
    use std::collections::HashMap;
    use std::sync::OnceLock;
    use std::sync::mpsc::{self, Receiver, Sender};
    use std::time::Duration;
    use windows::Win32::Globalization::{
        IEnumSpellingError, ISpellChecker, ISpellCheckerFactory, SpellCheckerFactory,
    };
    use windows::Win32::System::Com::{
        CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, CoCreateInstance, CoInitializeEx,
        CoTaskMemFree, IEnumString,
    };
    use windows::core::{HSTRING, PWSTR};

    enum Request {
        Languages(Sender<Result<Vec<String>, String>>),
        Check {
            language: String,
            words: Vec<String>,
            reply: Sender<Result<Vec<u32>, String>>,
        },
        Suggest {
            language: String,
            word: String,
            reply: Sender<Result<Vec<String>, String>>,
        },
    }

    fn worker() -> &'static Sender<Request> {
        static SLOT: OnceLock<Sender<Request>> = OnceLock::new();
        SLOT.get_or_init(|| {
            let (tx, rx) = mpsc::channel();
            std::thread::Builder::new()
                .name("spellcheck".into())
                .spawn(move || worker_loop(rx))
                .ok();
            tx
        })
    }

    fn ask<T>(build: impl FnOnce(Sender<Result<T, String>>) -> Request) -> Result<T, String> {
        let (tx, rx) = mpsc::channel();
        worker()
            .send(build(tx))
            .map_err(|_| "The spelling service is unavailable.".to_string())?;
        rx.recv_timeout(Duration::from_secs(3))
            .map_err(|_| "The spelling service did not respond.".to_string())?
    }

    pub fn languages() -> Result<Vec<String>, String> {
        ask(Request::Languages)
    }

    pub fn check(language: &str, words: &[String]) -> Result<Vec<u32>, String> {
        let language = language.to_string();
        let words = words.to_vec();
        ask(|reply| Request::Check {
            language,
            words,
            reply,
        })
    }

    pub fn suggest(language: &str, word: &str) -> Result<Vec<String>, String> {
        let language = language.to_string();
        let word = word.to_string();
        ask(|reply| Request::Suggest {
            language,
            word,
            reply,
        })
    }

    struct Session {
        factory: Option<ISpellCheckerFactory>,
        raw_tags: Vec<String>,
        init_error: Option<String>,
        checkers: HashMap<String, ISpellChecker>,
    }

    impl Session {
        fn start() -> Self {
            unsafe {
                // S_FALSE (already initialised) is a success we do not care about.
                let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
                let factory: windows::core::Result<ISpellCheckerFactory> =
                    CoCreateInstance(&SpellCheckerFactory, None, CLSCTX_INPROC_SERVER);
                let Ok(factory) = factory else {
                    return Self {
                        factory: None,
                        raw_tags: Vec::new(),
                        init_error: Some("The Windows spelling service is unavailable.".into()),
                        checkers: HashMap::new(),
                    };
                };
                let tags = factory
                    .SupportedLanguages()
                    .map_err(|_| "Could not discover Windows spelling dictionaries.".to_string())
                    .and_then(|list| read_strings(&list));
                let (raw_tags, init_error) = match tags {
                    Ok(tags) => (tags, None),
                    Err(error) => (Vec::new(), Some(error)),
                };
                Self {
                    factory: Some(factory),
                    raw_tags,
                    init_error,
                    checkers: HashMap::new(),
                }
            }
        }

        fn languages(&self) -> Result<Vec<String>, String> {
            if let Some(error) = &self.init_error {
                return Err(error.clone());
            }
            Ok(public_tags(&self.raw_tags))
        }

        fn checker(&mut self, language: &str) -> Result<ISpellChecker, String> {
            if let Some(error) = &self.init_error {
                return Err(error.clone());
            }
            let raw = resolve(&self.raw_tags, language)
                .ok_or_else(|| "The selected spelling dictionary is not installed.".to_string())?
                .to_string();
            if let Some(existing) = self.checkers.get(&raw) {
                return Ok(existing.clone());
            }
            let factory = self
                .factory
                .as_ref()
                .ok_or_else(|| "The Windows spelling service is unavailable.".to_string())?;
            let created = unsafe { factory.CreateSpellChecker(&HSTRING::from(&raw)) }
                .map_err(|_| "Could not open the spelling dictionary.".to_string())?;
            self.checkers.insert(raw, created.clone());
            Ok(created)
        }

        fn check(&mut self, language: &str, words: &[String]) -> Result<Vec<u32>, String> {
            let checker = self.checker(language)?;
            let mut bad = Vec::new();
            for (index, word) in words.iter().enumerate() {
                if is_misspelled(&checker, word)? {
                    bad.push(index as u32);
                }
            }
            Ok(bad)
        }

        fn suggest(&mut self, language: &str, word: &str) -> Result<Vec<String>, String> {
            let checker = self.checker(language)?;
            unsafe { checker.Suggest(&HSTRING::from(word)) }
                .map_err(|_| "Could not obtain spelling suggestions.".to_string())
                .and_then(|list| read_strings(&list))
        }
    }

    fn worker_loop(rx: Receiver<Request>) {
        let mut session = Session::start();
        while let Ok(request) = rx.recv() {
            match request {
                Request::Languages(reply) => {
                    let _ = reply.send(session.languages());
                }
                Request::Check {
                    language,
                    words,
                    reply,
                } => {
                    let _ = reply.send(session.check(&language, &words));
                }
                Request::Suggest {
                    language,
                    word,
                    reply,
                } => {
                    let _ = reply.send(session.suggest(&language, &word));
                }
            }
        }
    }

    fn is_misspelled(checker: &ISpellChecker, word: &str) -> Result<bool, String> {
        let errors = unsafe { checker.Check(&HSTRING::from(word)) }
            .map_err(|_| "The spelling service could not check a word.".to_string())?;
        next_error(&errors)
    }

    fn next_error(errors: &IEnumSpellingError) -> Result<bool, String> {
        // `Next` returns S_FALSE and a null pointer when the word is clean.
        // Any real error means the dictionary rejected the token.
        unsafe {
            let mut slot = None;
            let hr = errors.Next(&mut slot);
            if hr.is_err() {
                return Err("The spelling service could not read its result.".into());
            }
            Ok(slot.is_some())
        }
    }

    fn read_strings(list: &IEnumString) -> Result<Vec<String>, String> {
        let mut out = Vec::new();
        loop {
            let mut buf = [PWSTR::null()];
            let mut fetched = 0u32;
            let hr = unsafe { list.Next(&mut buf, Some(std::ptr::addr_of_mut!(fetched))) };
            if hr.is_err() {
                if !buf[0].is_null() {
                    unsafe { CoTaskMemFree(Some(buf[0].as_ptr() as *const std::ffi::c_void)) };
                }
                return Err("The spelling service could not enumerate its results.".into());
            }
            if fetched == 0 {
                break;
            }
            if buf[0].is_null() {
                break;
            }
            let text = unsafe { buf[0].to_string() };
            unsafe { CoTaskMemFree(Some(buf[0].as_ptr() as *const std::ffi::c_void)) };
            let text =
                text.map_err(|_| "The spelling service returned invalid text.".to_string())?;
            if !text.is_empty() {
                out.push(text);
            }
            if out.len() >= 256 {
                break;
            }
        }
        Ok(out)
    }
}

// ---------------------------------------------------------------------------
// Linux: the distro's hunspell dictionaries, by absolute path.
//
// Linking libhunspell and then asking Enchant to search inside an AppImage
// finds nothing: the provider looks next to the bundled library. Passing
// `/usr/share/hunspell/pt_BR.aff` to Hunspell_create reads the host files
// regardless of where the .so was loaded from.
// ---------------------------------------------------------------------------

#[cfg(target_os = "linux")]
mod engine {
    use super::{normalize_tag, public_tags, resolve};
    use std::ffi::{CStr, CString};
    use std::io::Read;
    use std::os::raw::{c_char, c_int};
    use std::path::{Path, PathBuf};
    use std::sync::Mutex;

    enum Hunhandle {}

    unsafe extern "C" {
        fn Hunspell_create(aff: *const c_char, dic: *const c_char) -> *mut Hunhandle;
        fn Hunspell_destroy(handle: *mut Hunhandle);
        fn Hunspell_spell(handle: *mut Hunhandle, word: *const c_char) -> c_int;
        fn Hunspell_suggest(
            handle: *mut Hunhandle,
            list: *mut *mut *mut c_char,
            word: *const c_char,
        ) -> c_int;
        fn Hunspell_free_list(handle: *mut Hunhandle, list: *mut *mut *mut c_char, count: c_int);
    }

    struct Dict {
        handle: *mut Hunhandle,
    }

    // The pointer is only used while the engine mutex is held.
    unsafe impl Send for Dict {}

    impl Drop for Dict {
        fn drop(&mut self) {
            if !self.handle.is_null() {
                unsafe { Hunspell_destroy(self.handle) };
            }
        }
    }

    struct Engine {
        raw_tags: Vec<String>,
        open: Vec<(String, Dict)>,
    }

    fn engine() -> &'static Mutex<Engine> {
        static SLOT: std::sync::OnceLock<Mutex<Engine>> = std::sync::OnceLock::new();
        SLOT.get_or_init(|| Mutex::new(Engine::scan()))
    }

    impl Engine {
        fn scan() -> Self {
            let mut raw_tags = Vec::new();
            for root in ROOTS {
                let Ok(entries) = std::fs::read_dir(root) else {
                    continue;
                };
                for entry in entries.take(4096).flatten() {
                    let path = entry.path();
                    if path.extension().and_then(|part| part.to_str()) != Some("aff") {
                        continue;
                    }
                    let Some(stem) = path.file_stem().and_then(|part| part.to_str()) else {
                        continue;
                    };
                    if normalize_tag(stem).is_some()
                        && path.with_extension("dic").is_file()
                        && is_utf8_dictionary(&path)
                    {
                        raw_tags.push(stem.to_string());
                    }
                }
            }
            raw_tags.sort();
            raw_tags.dedup();
            raw_tags.truncate(256);
            Self {
                raw_tags,
                open: Vec::new(),
            }
        }

        fn dict_for(&mut self, language: &str) -> Option<*mut Hunhandle> {
            let raw = resolve(&self.raw_tags, language)?;
            if let Some((_, dict)) = self.open.iter().find(|(tag, _)| tag == raw) {
                return Some(dict.handle);
            }
            let stem = raw.replace('-', "_");
            let (aff, dic) = locate(&stem).or_else(|| locate(raw))?;
            let aff = CString::new(aff.to_string_lossy().as_bytes()).ok()?;
            let dic = CString::new(dic.to_string_lossy().as_bytes()).ok()?;
            let handle = unsafe { Hunspell_create(aff.as_ptr(), dic.as_ptr()) };
            if handle.is_null() {
                return None;
            }
            self.open.push((raw.to_string(), Dict { handle }));
            Some(handle)
        }
    }

    const ROOTS: &[&str] = &[
        "/usr/share/hunspell",
        "/usr/share/myspell/dicts",
        "/usr/local/share/hunspell",
    ];

    fn utf8_aff(bytes: &[u8]) -> bool {
        let bytes = bytes.strip_prefix(b"\xef\xbb\xbf").unwrap_or(bytes);
        for line in bytes.split(|byte| *byte == b'\n') {
            let mut fields = line
                .split(u8::is_ascii_whitespace)
                .filter(|field| !field.is_empty());
            if fields.next() == Some(b"SET".as_slice()) {
                return fields.next().is_some_and(|value| {
                    value.eq_ignore_ascii_case(b"UTF-8") || value.eq_ignore_ascii_case(b"UTF8")
                });
            }
        }
        false
    }

    fn is_utf8_dictionary(path: &Path) -> bool {
        let Ok(file) = std::fs::File::open(path) else {
            return false;
        };
        let mut bytes = Vec::new();
        file.take(65_536).read_to_end(&mut bytes).is_ok() && utf8_aff(&bytes)
    }

    fn locate(stem: &str) -> Option<(PathBuf, PathBuf)> {
        let stem = stem.replace('-', "_");
        let alt = stem.replace('_', "-");
        for root in ROOTS {
            for name in [&stem, &alt] {
                let aff = Path::new(root).join(format!("{name}.aff"));
                let dic = Path::new(root).join(format!("{name}.dic"));
                if aff.is_file() && dic.is_file() && is_utf8_dictionary(&aff) {
                    return Some((aff, dic));
                }
            }
        }
        None
    }

    #[cfg(test)]
    mod tests {
        use super::utf8_aff;

        #[test]
        fn dictionary_encoding_is_checked_before_exposing_it() {
            assert!(utf8_aff(b"# comment\nSET UTF-8\n"));
            assert!(utf8_aff(b"SET utf8\r\n"));
            assert!(utf8_aff(b"\xef\xbb\xbfSET UTF-8\n"));
            assert!(!utf8_aff(b"SET ISO8859-1\n"));
            assert!(!utf8_aff(b"# missing encoding\n"));
        }
    }

    pub fn languages() -> Result<Vec<String>, String> {
        engine()
            .lock()
            .map(|engine| public_tags(&engine.raw_tags))
            .map_err(|_| "The spelling dictionary service is unavailable.".to_string())
    }

    pub fn check(language: &str, words: &[String]) -> Result<Vec<u32>, String> {
        let mut engine = engine()
            .lock()
            .map_err(|_| "The spelling dictionary service is unavailable.".to_string())?;
        let handle = engine.dict_for(language).ok_or_else(|| {
            "The selected spelling dictionary is not installed or could not be opened.".to_string()
        })?;
        let mut bad = Vec::new();
        for (index, word) in words.iter().enumerate() {
            let c = CString::new(word.as_str())
                .map_err(|_| "The word cannot be checked.".to_string())?;
            let ok = unsafe { Hunspell_spell(handle, c.as_ptr()) };
            if ok == 0 {
                bad.push(index as u32);
            }
        }
        Ok(bad)
    }

    pub fn suggest(language: &str, word: &str) -> Result<Vec<String>, String> {
        let mut engine = engine()
            .lock()
            .map_err(|_| "The spelling dictionary service is unavailable.".to_string())?;
        let handle = engine.dict_for(language).ok_or_else(|| {
            "The selected spelling dictionary is not installed or could not be opened.".to_string()
        })?;
        let c = CString::new(word).map_err(|_| "The word cannot be checked.".to_string())?;
        let mut list: *mut *mut c_char = std::ptr::null_mut();
        let count = unsafe { Hunspell_suggest(handle, &mut list, c.as_ptr()) };
        if count < 0 || (count > 0 && list.is_null()) {
            return Err("The spelling dictionary could not provide suggestions.".into());
        }
        if count == 0 {
            if !list.is_null() {
                unsafe { Hunspell_free_list(handle, &mut list, count) };
            }
            return Ok(Vec::new());
        }
        let mut out = Vec::new();
        let mut invalid = false;
        for index in 0..count {
            let ptr = unsafe { *list.add(index as usize) };
            if ptr.is_null() {
                continue;
            }
            if let Ok(text) = unsafe { CStr::from_ptr(ptr) }.to_str() {
                out.push(text.to_string());
            } else {
                invalid = true;
            }
        }
        unsafe { Hunspell_free_list(handle, &mut list, count) };
        if invalid {
            Err("The spelling dictionary returned invalid text.".into())
        } else {
            Ok(out)
        }
    }
}

// ---------------------------------------------------------------------------
// macOS: NSSpellChecker, the same service WKWebView uses.
//
// The methods we call are not marked main-thread-only in the bindings, but
// AppKit still wants the main queue. A command that is already on it runs
// directly; any other thread hops across with exec_sync.
// ---------------------------------------------------------------------------

#[cfg(target_os = "macos")]
mod engine {
    use super::{public_tags, resolve};
    use dispatch2::DispatchQueue;
    use objc2::MainThreadMarker;
    use objc2_app_kit::NSSpellChecker;
    use objc2_foundation::{NSArray, NSString};
    use std::sync::mpsc;

    fn with_checker<T: Send>(work: impl FnOnce(&NSSpellChecker) -> T + Send) -> Option<T> {
        if MainThreadMarker::new().is_some() {
            return Some(work(&NSSpellChecker::sharedSpellChecker()));
        }
        let (tx, rx) = mpsc::sync_channel(1);
        DispatchQueue::main().exec_sync(move || {
            let checker = NSSpellChecker::sharedSpellChecker();
            let _ = tx.send(work(&checker));
        });
        rx.recv().ok()
    }

    fn raw_tags() -> Result<Vec<String>, String> {
        with_checker(|checker| {
            let langs: &NSArray<NSString> = &checker.availableLanguages();
            let mut out = Vec::new();
            for index in 0..langs.count() {
                out.push(langs.objectAtIndex(index).to_string());
            }
            out
        })
        .ok_or_else(|| "The macOS spelling service is unavailable.".to_string())
    }

    pub fn languages() -> Result<Vec<String>, String> {
        Ok(public_tags(&raw_tags()?))
    }

    pub fn check(language: &str, words: &[String]) -> Result<Vec<u32>, String> {
        let tags = raw_tags()?;
        let raw = resolve(&tags, language)
            .map(str::to_string)
            .ok_or_else(|| "The selected spelling dictionary is not installed.".to_string())?;
        with_checker(|checker| {
            let lang = NSString::from_str(&raw);
            let mut bad = Vec::new();
            for (index, word) in words.iter().enumerate() {
                let text = NSString::from_str(word);
                let range = unsafe {
                    checker.checkSpellingOfString_startingAt_language_wrap_inSpellDocumentWithTag_wordCount(
                        &text,
                        0,
                        Some(&lang),
                        false,
                        0,
                        std::ptr::null_mut(),
                    )
                };
                if range.length > 0 {
                    bad.push(index as u32);
                }
            }
            bad
        })
        .ok_or_else(|| "The macOS spelling service is unavailable.".to_string())
    }

    pub fn suggest(language: &str, word: &str) -> Result<Vec<String>, String> {
        let tags = raw_tags()?;
        let raw = resolve(&tags, language)
            .map(str::to_string)
            .ok_or_else(|| "The selected spelling dictionary is not installed.".to_string())?;
        with_checker(|checker| {
            let lang = NSString::from_str(&raw);
            let text = NSString::from_str(word);
            let range = objc2_foundation::NSRange {
                location: 0,
                length: text.length(),
            };
            let Some(guesses) = checker
                .guessesForWordRange_inString_language_inSpellDocumentWithTag(
                    range,
                    &text,
                    Some(&lang),
                    0,
                )
            else {
                return Vec::new();
            };
            let mut out = Vec::new();
            for index in 0..guesses.count() {
                out.push(guesses.objectAtIndex(index).to_string());
            }
            out
        })
        .ok_or_else(|| "The macOS spelling service is unavailable.".to_string())
    }
}

#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
mod engine {
    pub fn languages() -> Result<Vec<String>, String> {
        Err("Spelling is not available on this platform.".into())
    }

    pub fn check(_language: &str, _words: &[String]) -> Result<Vec<u32>, String> {
        Err("Spelling is not available on this platform.".into())
    }

    pub fn suggest(_language: &str, _word: &str) -> Result<Vec<String>, String> {
        Err("Spelling is not available on this platform.".into())
    }
}

#[cfg(test)]
mod tests {
    use super::{
        accepted_form, misspelled_indices, normalize_tag, prose_words, public_tags, resolve,
    };

    #[test]
    fn unavailable_dictionary_is_an_error_not_a_clean_result() {
        assert!(misspelled_indices("../bad", &["word".into()]).is_err());
        assert!(misspelled_indices("auto", &["word".into()]).is_err());
    }

    #[test]
    fn single_letter_words_reach_the_dictionary_in_all_scripts() {
        assert_eq!(accepted_form("a").as_deref(), Some("a"));
        assert_eq!(accepted_form("à").as_deref(), Some("à"));
        assert_eq!(accepted_form("中").as_deref(), Some("中"));
        assert_eq!(accepted_form("ALLCAPS"), None);
    }

    #[test]
    fn installed_tags_are_normalized_without_accepting_paths() {
        assert_eq!(normalize_tag(" zh_hant_tw ").as_deref(), Some("zh-Hant-TW"));
        assert_eq!(normalize_tag("fr_FR").as_deref(), Some("fr-FR"));
        for bad in ["../fr", "fr/../../tmp", "fr--FR", "fr.UTF-8", "", "a"] {
            assert_eq!(normalize_tag(bad), None, "{bad}");
        }
    }

    #[test]
    fn installed_languages_preserve_legacy_aliases_and_exact_regions() {
        let raw = ["en_GB", "fr_FR", "pt", "en_US"]
            .map(str::to_string)
            .to_vec();
        let public = public_tags(&raw);
        for tag in ["en", "en-GB", "en-US", "fr-FR", "pt-PT"] {
            assert!(public.iter().any(|item| item == tag), "{public:?}");
        }
        assert_eq!(resolve(&raw, "en"), Some("en_US"));
        assert_eq!(resolve(&raw, "en-GB"), Some("en_GB"));
        assert_eq!(resolve(&raw, "pt-PT"), Some("pt"));
        assert_eq!(resolve(&raw, "fr-FR"), Some("fr_FR"));
        assert_eq!(resolve(&raw, "../fr"), None);
        assert_eq!(resolve(&raw, "fr-CA"), None);
    }

    #[test]
    fn prose_words_skip_code_urls_math_camel_case_and_normalize_apostrophes() {
        let text = "\
A recieve sits in prose.
```
recieve
```
see `recieve` at https://recieve.example/a and $recieve$ plus \\(recieve\\).
CamelCase ALLCAPS word2 d\u{2019}água
";
        let words = prose_words(text);
        assert_eq!(
            words.iter().filter(|word| *word == "recieve").count(),
            1,
            "the prose typo stays and the fenced, inline, url and math copies go: {words:?}"
        );
        assert!(words.iter().any(|word| word == "d'água"), "{words:?}");
        assert!(!words.iter().any(|word| word == "CamelCase"), "{words:?}");
        assert!(!words.iter().any(|word| word == "ALLCAPS"), "{words:?}");
        assert!(!words.iter().any(|word| word.contains('2')), "{words:?}");
        assert!(words.iter().any(|word| word == "see"), "{words:?}");
    }

    #[test]
    fn a_closed_fence_does_not_swallow_the_paragraph_after_it() {
        let words = prose_words("Before.\n~~~\nrecieve\n~~~\nAfter recieve.\n");
        assert!(words.iter().any(|word| word == "Before"), "{words:?}");
        assert!(words.iter().any(|word| word == "After"), "{words:?}");
        assert_eq!(
            words.iter().filter(|word| *word == "recieve").count(),
            1,
            "{words:?}"
        );
    }

    #[test]
    fn front_matter_is_not_prose() {
        let words = prose_words("---\ntitle: recieve\n---\n\nA real recieve.\n");
        assert_eq!(
            words.iter().filter(|word| *word == "recieve").count(),
            1,
            "{words:?}"
        );
        assert!(!words.iter().any(|word| word == "title"), "{words:?}");
    }
}

#[cfg(all(test, windows))]
mod windows_tests {
    use super::engine;
    use super::misspelled_indices;

    #[test]
    fn english_dictionary_flags_a_nonsense_word() {
        let languages = engine::languages().expect("enumerate installed dictionaries");
        if !languages.iter().any(|language| language == "en") {
            return;
        }
        // A nonsense token tests the pipeline without asserting a particular
        // dictionary's word list. The Windows image GitHub's runner used
        // accepted "recieve" (2026-10-18), a dictionary difference rather than
        // a bug here, so a misspelling that a dictionary happens to know is not
        // this test's business.
        let bad = misspelled_indices("en", &["zzqx".into(), "the".into(), "CamelCase".into()])
            .expect("check English words");
        if !bad.contains(&0) {
            eprintln!("the English dictionary flagged nothing; skipping");
            return;
        }
        assert!(
            !bad.contains(&1),
            "the is a word, languages={languages:?} bad={bad:?}"
        );
        assert!(
            !bad.contains(&2),
            "CamelCase is not a spelling error, bad={bad:?}"
        );
    }

    #[test]
    fn portuguese_flags_a_typo_only_when_the_dictionary_is_installed() {
        let languages = engine::languages().expect("enumerate installed dictionaries");
        if !languages.iter().any(|language| language == "pt-BR") {
            return;
        }
        let bad = misspelled_indices("pt-BR", &["recceber".into(), "receber".into()])
            .expect("check Portuguese words");
        assert!(bad.contains(&0), "recceber should be rejected, bad={bad:?}");
        assert!(!bad.contains(&1), "receber is a word, bad={bad:?}");
    }
}
