//! Approximate token counts for the status bar.
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

#[tauri::command]
pub async fn count_tokens(text: String) -> usize {
    tauri::async_runtime::spawn_blocking(move || estimate_tokens(&text))
        .await
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::estimate_tokens;

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
}
