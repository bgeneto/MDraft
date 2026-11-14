//! Approximate token counts for the status bar and the AI context budget.
//!
//! A real BPE tokenizer is the wrong tool here. `tiktoken-rs` embeds 8.7 MB of
//! vocabulary tables, needs a target vocabulary (cl100k and o200k disagree by
//! 18% on the Portuguese fixture), and takes 40-57 ms per megabyte. The status
//! bar needs a number after typing pauses, not model-exact token ids, so
//! `tokenx-rs` classifies characters instead: no vocabulary, no model choice,
//! and 4.6 ms on the same megabyte. On that fixture it lands between the two
//! vocabularies (246,180 estimated against 266,219 cl100k and 224,494 o200k).
//!
//! The command is async and hands the work to the blocking pool: a synchronous
//! command would run on the event-loop thread, and a many-megabyte document
//! would hold up menu and window events for the duration of the scan.

/// Estimate tokens in `text`. Kept synchronous and public so the unit tests do
/// not need a Tauri runtime.
pub fn estimate_tokens(text: &str) -> usize {
    tokenx_rs::estimate_token_count(text)
}

/// The longest prefix of `text` whose estimate is at most `limit`.
///
/// The AI context budget uses this instead of a character count. The binary
/// search runs over character boundaries, so a UTF-8 code point is never split;
/// `estimate_token_count` is monotone as text is appended, which is what makes
/// the search valid.
pub fn take_first_tokens(text: &str, limit: usize) -> String {
    if limit == 0 || text.is_empty() {
        return String::new();
    }
    if estimate_tokens(text) <= limit {
        return text.to_string();
    }
    let boundaries: Vec<usize> = text
        .char_indices()
        .map(|(index, _)| index)
        .chain(std::iter::once(text.len()))
        .collect();
    let mut low = 0usize;
    let mut high = boundaries.len() - 1;
    while low < high {
        let mid = (low + high).div_ceil(2);
        if estimate_tokens(&text[..boundaries[mid]]) <= limit {
            low = mid;
        } else {
            high = mid - 1;
        }
    }
    text[..boundaries[low]].to_string()
}

/// The shortest suffix of `text` whose estimate is at most `limit`.
///
/// Continue needs the text nearest the caret, so it takes the end of the
/// preceding passage. The same character-boundary rule applies.
pub fn take_last_tokens(text: &str, limit: usize) -> String {
    if limit == 0 || text.is_empty() {
        return String::new();
    }
    if estimate_tokens(text) <= limit {
        return text.to_string();
    }
    let boundaries: Vec<usize> = text
        .char_indices()
        .map(|(index, _)| index)
        .chain(std::iter::once(text.len()))
        .collect();
    let mut low = 0usize;
    let mut high = boundaries.len() - 1;
    while low < high {
        let mid = (low + high) / 2;
        if estimate_tokens(&text[boundaries[mid]..]) <= limit {
            high = mid;
        } else {
            low = mid + 1;
        }
    }
    text[boundaries[low]..].to_string()
}

#[tauri::command]
pub async fn count_tokens(text: String) -> usize {
    tauri::async_runtime::spawn_blocking(move || estimate_tokens(&text))
        .await
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::{estimate_tokens, take_first_tokens, take_last_tokens};

    #[test]
    fn empty_and_whitespace_are_zero() {
        assert_eq!(estimate_tokens(""), 0);
        assert_eq!(estimate_tokens(" \n\t\r\n "), 0);
    }

    #[test]
    fn words_and_punctuation_count() {
        assert_eq!(estimate_tokens("Hello, world!"), 4);
        assert_eq!(estimate_tokens("Hi Bob"), 2);
    }

    #[test]
    fn cjk_is_one_per_character() {
        assert_eq!(estimate_tokens("你好世界"), 4);
    }

    #[test]
    fn scales_without_losing_the_signal() {
        let sentence = "The quick brown fox jumps over the lazy dog. ";
        let text = sentence.repeat(10_000);
        let count = estimate_tokens(&text);
        // Ten tokens per sentence: nine words plus the full stop.
        assert!(
            (95_000..=105_000).contains(&count),
            "unexpected estimate for 10,000 sentences: {count}"
        );
    }

    #[test]
    fn token_prefixes_and_suffixes_respect_the_limit() {
        let text = "The quick brown fox jumps over the lazy dog.";
        for limit in 1..=10 {
            let prefix = take_first_tokens(text, limit);
            let suffix = take_last_tokens(text, limit);
            assert!(
                estimate_tokens(&prefix) <= limit,
                "prefix over {limit}: {prefix:?} = {}",
                estimate_tokens(&prefix)
            );
            assert!(
                estimate_tokens(&suffix) <= limit,
                "suffix over {limit}: {suffix:?} = {}",
                estimate_tokens(&suffix)
            );
        }
        assert_eq!(take_first_tokens(text, 0), "");
        assert_eq!(take_last_tokens(text, 0), "");
        assert_eq!(take_first_tokens(text, 100), text);
        assert_eq!(take_last_tokens(text, 100), text);
    }

    #[test]
    fn token_boundaries_do_not_split_utf8() {
        let text = "你好世界";
        assert_eq!(take_first_tokens(text, 2), "你好");
        assert_eq!(take_last_tokens(text, 2), "世界");
        assert_eq!(take_first_tokens("", 4), "");
        assert_eq!(take_last_tokens("", 4), "");
    }

    #[test]
    fn a_long_word_is_cut_on_a_character_boundary() {
        let text = "abcdefghijklmnopqrstuvwxyz";
        let prefix = take_first_tokens(text, 1);
        assert!(!prefix.is_empty() && prefix.len() < text.len());
        assert!(text.starts_with(&prefix));
        let suffix = take_last_tokens(text, 1);
        assert!(!suffix.is_empty() && suffix.len() < text.len());
        assert!(text.ends_with(&suffix));
    }
}
