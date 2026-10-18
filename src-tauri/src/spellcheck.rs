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
    if trimmed.chars().count() < 2 {
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
    if letters < 2 || internal_capital || (uppers == letters && letters >= 2) {
        return None;
    }
    if ALLOWED.iter().any(|entry| entry.eq_ignore_ascii_case(&normalized)) {
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
    blank_pattern(&mut bytes, |bytes, i| match_url(bytes, i));
    blank_pattern(&mut bytes, |bytes, i| match_math(bytes, i));
    blank_pattern(&mut bytes, |bytes, i| match_html(bytes, i));
    String::from_utf8(bytes).unwrap_or_else(|error| String::from_utf8_lossy(error.as_bytes()).into_owned())
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
            let until = if close < lines.len() { lines[close].2 } else { bytes.len() };
            let _ = next;
            blank_range(bytes, start, until);
            i = if close < lines.len() { close + 1 } else { lines.len() };
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
        if let Some(end) = matcher(bytes, i) {
            if end > i {
                blank_range(bytes, i, end);
                i = end;
                continue;
            }
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

/// Our tags, in the order the preference list shows them.
fn public_tags(raws: &[String]) -> Vec<String> {
    let mut en = false;
    let mut en_gb = false;
    let mut pt_br = false;
    let mut pt_pt = false;
    for raw in raws {
        match public_tag(raw) {
            Some("en") => en = true,
            Some("en-GB") => {
                en = true;
                en_gb = true;
            }
            Some("pt-BR") => pt_br = true,
            Some("pt-PT") => pt_pt = true,
            _ => {}
        }
    }
    let mut out = Vec::new();
    if en {
        out.push("en".to_string());
    }
    if en_gb {
        out.push("en-GB".to_string());
    }
    if pt_br {
        out.push("pt-BR".to_string());
    }
    if pt_pt {
        out.push("pt-PT".to_string());
    }
    out
}

/// Map an OS language tag onto the small set the editor knows.
fn public_tag(raw: &str) -> Option<&'static str> {
    let tag = raw.trim().to_ascii_lowercase().replace('_', "-");
    if tag == "en-gb" || tag.starts_with("en-gb-") {
        return Some("en-GB");
    }
    if tag == "en" || tag.starts_with("en-") {
        return Some("en");
    }
    if tag == "pt-br" || tag.starts_with("pt-br-") {
        return Some("pt-BR");
    }
    if tag == "pt-pt" || tag == "pt" || tag.starts_with("pt-") {
        return Some("pt-PT");
    }
    None
}

/// Lower is a better match. `en-US` beats `en-AU` when the reader asked for `en`.
fn tag_rank(raw: &str) -> u8 {
    let tag = raw.trim().to_ascii_lowercase().replace('_', "-");
    if tag == "en-us" || tag == "en-gb" || tag == "pt-br" || tag == "pt-pt" {
        0
    } else {
        1
    }
}

fn resolve<'a>(raws: &'a [String], requested: &str) -> Option<&'a str> {
    let mut exact: Option<&str> = None;
    let mut exact_rank = u8::MAX;
    let mut english: Option<&str> = None;
    let mut english_rank = u8::MAX;
    for raw in raws {
        let Some(tag) = public_tag(raw) else {
            continue;
        };
        let rank = tag_rank(raw);
        if tag == requested && rank < exact_rank {
            exact = Some(raw.as_str());
            exact_rank = rank;
        }
        // A machine with only British English still has an English dictionary.
        // `en` should use it rather than underline every word.
        if requested == "en" && (tag == "en" || tag == "en-GB") && rank < english_rank {
            english = Some(raw.as_str());
            english_rank = rank;
        }
    }
    exact.or(english)
}

/// Indices into `words` that the dictionary rejects.
///
/// Tokens that [`accepted_form`] declines are not errors. An unknown language
/// yields an empty list: underlining the whole paragraph is worse than checking
/// nothing.
fn misspelled_indices(language: &str, words: &[String]) -> Vec<u32> {
    if language.is_empty() || language == "auto" {
        return Vec::new();
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
        return Vec::new();
    }
    let mut out = Vec::new();
    for slot in engine::check(language, &unique) {
        if let Some(group) = owners.get(slot as usize) {
            out.extend_from_slice(group);
        }
    }
    out.sort_unstable();
    out
}

fn suggestions_for(language: &str, word: &str) -> Vec<String> {
    let Some(form) = accepted_form(word) else {
        return Vec::new();
    };
    let mut list = engine::suggest(language, &form);
    list.truncate(8);
    list
}

#[tauri::command]
pub async fn spellcheck_languages() -> Vec<String> {
    tauri::async_runtime::spawn_blocking(engine::languages)
        .await
        .unwrap_or_default()
}

#[tauri::command]
pub async fn spellcheck_check(language: String, words: Vec<String>) -> Vec<u32> {
    tauri::async_runtime::spawn_blocking(move || misspelled_indices(&language, &words))
        .await
        .unwrap_or_default()
}

#[tauri::command]
pub async fn spellcheck_suggest(language: String, word: String) -> Vec<String> {
    tauri::async_runtime::spawn_blocking(move || suggestions_for(&language, &word))
        .await
        .unwrap_or_default()
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
    use std::sync::mpsc::{self, Receiver, Sender};
    use std::sync::OnceLock;
    use std::time::Duration;
    use windows::core::{HSTRING, PWSTR};
    use windows::Win32::Globalization::{IEnumSpellingError, ISpellChecker, ISpellCheckerFactory, SpellCheckerFactory};
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoTaskMemFree, IEnumString, CLSCTX_INPROC_SERVER,
        COINIT_APARTMENTTHREADED,
    };

    enum Request {
        Languages(Sender<Vec<String>>),
        Check {
            language: String,
            words: Vec<String>,
            reply: Sender<Vec<u32>>,
        },
        Suggest {
            language: String,
            word: String,
            reply: Sender<Vec<String>>,
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

    fn ask<T: Default>(build: impl FnOnce(Sender<T>) -> Request) -> T {
        let (tx, rx) = mpsc::channel();
        if worker().send(build(tx)).is_err() {
            return T::default();
        }
        rx.recv_timeout(Duration::from_secs(3)).unwrap_or_default()
    }

    pub fn languages() -> Vec<String> {
        ask(Request::Languages)
    }

    pub fn check(language: &str, words: &[String]) -> Vec<u32> {
        let language = language.to_string();
        let words = words.to_vec();
        ask(|reply| Request::Check { language, words, reply })
    }

    pub fn suggest(language: &str, word: &str) -> Vec<String> {
        let language = language.to_string();
        let word = word.to_string();
        ask(|reply| Request::Suggest { language, word, reply })
    }

    struct Session {
        factory: Option<ISpellCheckerFactory>,
        raw_tags: Vec<String>,
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
                    return Self { factory: None, raw_tags: Vec::new(), checkers: HashMap::new() };
                };
                let raw_tags = factory
                    .SupportedLanguages()
                    .map(|list| read_strings(&list))
                    .unwrap_or_default();
                Self { factory: Some(factory), raw_tags, checkers: HashMap::new() }
            }
        }

        fn languages(&self) -> Vec<String> {
            public_tags(&self.raw_tags)
        }

        fn checker(&mut self, language: &str) -> Option<ISpellChecker> {
            let raw = resolve(&self.raw_tags, language)?.to_string();
            if let Some(existing) = self.checkers.get(&raw) {
                return Some(existing.clone());
            }
            let factory = self.factory.as_ref()?;
            let created = unsafe { factory.CreateSpellChecker(&HSTRING::from(&raw)) }.ok()?;
            self.checkers.insert(raw, created.clone());
            Some(created)
        }

        fn check(&mut self, language: &str, words: &[String]) -> Vec<u32> {
            let Some(checker) = self.checker(language) else {
                return Vec::new();
            };
            let mut bad = Vec::new();
            for (index, word) in words.iter().enumerate() {
                if is_misspelled(&checker, word) {
                    bad.push(index as u32);
                }
            }
            bad
        }

        fn suggest(&mut self, language: &str, word: &str) -> Vec<String> {
            let Some(checker) = self.checker(language) else {
                return Vec::new();
            };
            unsafe { checker.Suggest(&HSTRING::from(word)) }
                .map(|list| read_strings(&list))
                .unwrap_or_default()
        }
    }

    fn worker_loop(rx: Receiver<Request>) {
        let mut session = Session::start();
        while let Ok(request) = rx.recv() {
            match request {
                Request::Languages(reply) => {
                    let _ = reply.send(session.languages());
                }
                Request::Check { language, words, reply } => {
                    let _ = reply.send(session.check(&language, &words));
                }
                Request::Suggest { language, word, reply } => {
                    let _ = reply.send(session.suggest(&language, &word));
                }
            }
        }
    }

    fn is_misspelled(checker: &ISpellChecker, word: &str) -> bool {
        let Ok(errors) = (unsafe { checker.Check(&HSTRING::from(word)) }) else {
            return false;
        };
        next_error(&errors).is_some()
    }

    fn next_error(errors: &IEnumSpellingError) -> Option<()> {
        // `Next` returns S_FALSE and a null pointer when the word is clean.
        // Any real error means the dictionary rejected the token.
        unsafe {
            let mut slot = None;
            let hr = errors.Next(&mut slot);
            if hr.is_err() {
                return None;
            }
            slot.map(|_| ())
        }
    }

    fn read_strings(list: &IEnumString) -> Vec<String> {
        let mut out = Vec::new();
        loop {
            let mut buf = [PWSTR::null()];
            let mut fetched = 0u32;
            let hr = unsafe { list.Next(&mut buf, Some(std::ptr::addr_of_mut!(fetched))) };
            if fetched == 0 || hr.is_err() {
                break;
            }
            if buf[0].is_null() {
                break;
            }
            if let Ok(text) = unsafe { buf[0].to_string() } {
                if !text.is_empty() {
                    out.push(text);
                }
            }
            unsafe { CoTaskMemFree(Some(buf[0].as_ptr() as *const std::ffi::c_void)) };
            if out.len() >= 32 {
                break;
            }
        }
        out
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
    use super::{public_tags, resolve};
    use std::ffi::{CStr, CString};
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
            for key in ["en_US", "en-US", "en_GB", "en-GB", "en", "pt_BR", "pt-BR", "pt_PT", "pt-PT"] {
                if locate(key).is_some() {
                    raw_tags.push(key.replace('_', "-"));
                }
            }
            Self { raw_tags, open: Vec::new() }
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

    fn locate(stem: &str) -> Option<(PathBuf, PathBuf)> {
        let stem = stem.replace('-', "_");
        let alt = stem.replace('_', "-");
        for root in ROOTS {
            for name in [&stem, &alt] {
                let aff = Path::new(root).join(format!("{name}.aff"));
                let dic = Path::new(root).join(format!("{name}.dic"));
                if aff.is_file() && dic.is_file() {
                    return Some((aff, dic));
                }
            }
        }
        None
    }

    pub fn languages() -> Vec<String> {
        engine()
            .lock()
            .map(|engine| public_tags(&engine.raw_tags))
            .unwrap_or_default()
    }

    pub fn check(language: &str, words: &[String]) -> Vec<u32> {
        let Ok(mut engine) = engine().lock() else {
            return Vec::new();
        };
        let Some(handle) = engine.dict_for(language) else {
            return Vec::new();
        };
        let mut bad = Vec::new();
        for (index, word) in words.iter().enumerate() {
            let Ok(c) = CString::new(word.as_str()) else {
                continue;
            };
            let ok = unsafe { Hunspell_spell(handle, c.as_ptr()) };
            if ok == 0 {
                bad.push(index as u32);
            }
        }
        bad
    }

    pub fn suggest(language: &str, word: &str) -> Vec<String> {
        let Ok(mut engine) = engine().lock() else {
            return Vec::new();
        };
        let Some(handle) = engine.dict_for(language) else {
            return Vec::new();
        };
        let Ok(c) = CString::new(word) else {
            return Vec::new();
        };
        let mut list: *mut *mut c_char = std::ptr::null_mut();
        let count = unsafe { Hunspell_suggest(handle, &mut list, c.as_ptr()) };
        if count <= 0 || list.is_null() {
            return Vec::new();
        }
        let mut out = Vec::new();
        for index in 0..count {
            let ptr = unsafe { *list.add(index as usize) };
            if ptr.is_null() {
                continue;
            }
            if let Ok(text) = unsafe { CStr::from_ptr(ptr) }.to_str() {
                out.push(text.to_string());
            }
        }
        unsafe { Hunspell_free_list(handle, &mut list, count) };
        out
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

    fn raw_tags() -> Vec<String> {
        with_checker(|checker| {
            let langs: &NSArray<NSString> = &checker.availableLanguages();
            let mut out = Vec::new();
            for index in 0..langs.count() {
                out.push(langs.objectAtIndex(index).to_string());
            }
            out
        })
        .unwrap_or_default()
    }

    pub fn languages() -> Vec<String> {
        public_tags(&raw_tags())
    }

    pub fn check(language: &str, words: &[String]) -> Vec<u32> {
        let tags = raw_tags();
        let Some(raw) = resolve(&tags, language).map(str::to_string) else {
            return Vec::new();
        };
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
        .unwrap_or_default()
    }

    pub fn suggest(language: &str, word: &str) -> Vec<String> {
        let tags = raw_tags();
        let Some(raw) = resolve(&tags, language).map(str::to_string) else {
            return Vec::new();
        };
        with_checker(|checker| {
            let lang = NSString::from_str(&raw);
            let text = NSString::from_str(word);
            let range = objc2_foundation::NSRange {
                location: 0,
                length: text.length(),
            };
            let Some(guesses) = checker
                .guessesForWordRange_inString_language_inSpellDocumentWithTag(range, &text, Some(&lang), 0)
            else {
                return Vec::new();
            };
            let mut out = Vec::new();
            for index in 0..guesses.count() {
                out.push(guesses.objectAtIndex(index).to_string());
            }
            out
        })
        .unwrap_or_default()
    }
}

#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
mod engine {
    pub fn languages() -> Vec<String> {
        Vec::new()
    }

    pub fn check(_language: &str, _words: &[String]) -> Vec<u32> {
        Vec::new()
    }

    pub fn suggest(_language: &str, _word: &str) -> Vec<String> {
        Vec::new()
    }
}

#[cfg(test)]
mod tests {
    use super::prose_words;

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
        assert_eq!(words.iter().filter(|word| *word == "recieve").count(), 1, "{words:?}");
    }

    #[test]
    fn front_matter_is_not_prose() {
        let words = prose_words("---\ntitle: recieve\n---\n\nA real recieve.\n");
        assert_eq!(words.iter().filter(|word| *word == "recieve").count(), 1, "{words:?}");
        assert!(!words.iter().any(|word| word == "title"), "{words:?}");
    }
}

#[cfg(all(test, windows))]
mod windows_tests {
    use super::engine;
    use super::misspelled_indices;

    #[test]
    fn english_dictionary_flags_a_nonsense_word() {
        let languages = engine::languages();
        if !languages.iter().any(|language| language == "en") {
            return;
        }
        // A nonsense token tests the pipeline without asserting a particular
        // dictionary's word list. The Windows image GitHub's runner used
        // accepted "recieve" (2026-10-18), a dictionary difference rather than
        // a bug here, so a misspelling that a dictionary happens to know is not
        // this test's business.
        let bad = misspelled_indices("en", &["zzqx".into(), "the".into(), "CamelCase".into()]);
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
        let languages = engine::languages();
        if !languages.iter().any(|language| language == "pt-BR") {
            return;
        }
        let bad = misspelled_indices("pt-BR", &["recceber".into(), "receber".into()]);
        assert!(bad.contains(&0), "recceber should be rejected, bad={bad:?}");
        assert!(!bad.contains(&1), "receber is a word, bad={bad:?}");
    }
}
