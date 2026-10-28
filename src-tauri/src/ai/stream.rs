//! Streaming filter for the delimited answers the action prompts ask for.
//!
//! Every action except Ask asks the model to wrap its answer in a tag such as
//! `<revised>`. The panel must never show those tags, and the text that arrives
//! before the tag (a stray sentence, a code fence) must not become the answer.
//! This filter emits only the content of the expected tag, handling tags split
//! across network chunks and models that ignore the instruction entirely.
//!
//! `done` carries the authoritative text produced by [`TagFilter::finish`], so
//! the panel can replace whatever it streamed with the final answer.

use crate::ai::prompt::MAX_OUTPUT;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum State {
    /// Looking for the opening tag. Text before it is discarded.
    Seek,
    /// Inside the expected tag; emitting content.
    Inside,
    /// The tag closed; the remainder is only inspected for notes.
    After,
    /// No tag was found within the lookahead, or this is a passthrough filter.
    Raw,
}

pub struct TagFilter {
    tag: String,
    secondary: Option<String>,
    state: State,
    buffer: String,
    out: String,
    after: String,
    started: bool,
    truncated: bool,
}

impl TagFilter {
    /// Filter for `tag`; `secondary` (Improve's `notes`) is extracted at the end
    /// but never streamed.
    pub fn new(tag: &str, secondary: Option<&str>) -> Self {
        Self {
            tag: tag.to_string(),
            secondary: secondary.map(str::to_string),
            state: State::Seek,
            buffer: String::new(),
            out: String::new(),
            after: String::new(),
            started: false,
            truncated: false,
        }
    }

    /// No tag: every delta is content. Used by Ask, whose answer is free-form.
    pub fn passthrough() -> Self {
        Self {
            tag: String::new(),
            secondary: None,
            state: State::Raw,
            buffer: String::new(),
            out: String::new(),
            after: String::new(),
            started: false,
            truncated: false,
        }
    }

    pub fn truncated(&self) -> bool {
        self.truncated
    }

    /// Feed one network chunk, returning only the new visible text.
    pub fn feed(&mut self, chunk: &str) -> String {
        if self.truncated || chunk.is_empty() {
            return String::new();
        }
        self.buffer.push_str(chunk);
        let mut produced = String::new();
        loop {
            match self.state {
                State::Seek => {
                    let open = format!("<{}>", self.tag);
                    let close = format!("</{}>", self.tag);
                    if let Some(index) = find_ci(&self.buffer, &open) {
                        self.buffer.drain(..index + open.len());
                        self.state = State::Inside;
                        continue;
                    }
                    // A model that forgets the opening tag but remembers the
                    // closing one still gets a clean answer: the text before
                    // the closing tag is the content, and the remainder is only
                    // inspected for Improve's notes.
                    if let Some(index) = find_ci(&self.buffer, &close) {
                        let text = self.buffer[..index].to_string();
                        self.buffer.drain(..index + close.len());
                        self.state = State::After;
                        produced.push_str(&self.push(&text));
                        continue;
                    }
                    // A model that ignores the tags must not have its whole
                    // answer held back. After this much text, stream it raw.
                    if self.buffer.len() > 512 {
                        self.state = State::Raw;
                        continue;
                    }
                    break;
                }
                State::Raw => {
                    let text = std::mem::take(&mut self.buffer);
                    produced.push_str(&self.push(&text));
                    break;
                }
                State::Inside => {
                    let close = format!("</{}>", self.tag);
                    let secondary_open = self
                        .secondary
                        .as_ref()
                        .map(|tag| format!("<{}>", tag));
                    let close_at = find_ci(&self.buffer, &close);
                    let secondary_at = secondary_open
                        .as_deref()
                        .and_then(|open| find_ci(&self.buffer, open));
                    let stop = match (close_at, secondary_at) {
                        (Some(a), Some(b)) => Some(a.min(b)),
                        (Some(a), None) => Some(a),
                        (None, Some(b)) => Some(b),
                        (None, None) => None,
                    };
                    if let Some(index) = stop {
                        let tag_len = if close_at == Some(index) {
                            close.len()
                        } else {
                            secondary_open.as_ref().map(String::len).unwrap_or(0)
                        };
                        let text = self.buffer[..index].to_string();
                        self.buffer.drain(..index + tag_len);
                        self.state = State::After;
                        produced.push_str(&self.push(&text));
                        continue;
                    }
                    // Keep enough tail that a closing tag split across chunks
                    // is never emitted as text.
                    let keep = close
                        .len()
                        .max(secondary_open.as_ref().map(String::len).unwrap_or(0));
                    if self.buffer.len() > keep {
                        let mut cut = self.buffer.len() - keep;
                        cut = floor_char_boundary(&self.buffer, cut);
                        let text = self.buffer[..cut].to_string();
                        self.buffer.drain(..cut);
                        produced.push_str(&self.push(&text));
                    }
                    break;
                }
                State::After => {
                    let text = std::mem::take(&mut self.buffer);
                    self.append_after(&text);
                    break;
                }
            }
        }
        produced
    }

    /// Flush the buffers and return the final answer and its notes.
    ///
    /// The text is trimmed and an outer code fence that wraps the *whole* answer
    /// is removed. A fence that is part of the answer's own content is kept.
    pub fn finish(&mut self) -> (String, String) {
        match self.state {
            State::Seek => {
                let text = std::mem::take(&mut self.buffer);
                if !text.trim().is_empty() {
                    // The model ignored the tag entirely. The whole answer is
                    // then the answer.
                    let _ = self.push(&text);
                }
            }
            State::Inside => {
                let mut text = std::mem::take(&mut self.buffer);
                if let Some(index) = partial_tag_suffix(&text, &self.tag) {
                    text.truncate(index);
                }
                let _ = self.push(&text);
            }
            State::After => {
                let text = std::mem::take(&mut self.buffer);
                self.append_after(&text);
            }
            State::Raw => {
                let text = std::mem::take(&mut self.buffer);
                let _ = self.push(&text);
            }
        }

        self.out = strip_wrapping_fence(self.out.trim()).to_string();
        let notes = self
            .secondary
            .as_ref()
            .and_then(|tag| extract_tag(&self.after, tag))
            .unwrap_or_default();
        (self.out.clone(), notes)
    }

    fn push(&mut self, text: &str) -> String {
        if text.is_empty() {
            return String::new();
        }
        let text = if self.started {
            text
        } else {
            let trimmed = text.trim_start();
            if trimmed.is_empty() {
                return String::new();
            }
            self.started = true;
            trimmed
        };
        self.append(text)
    }

    fn append(&mut self, text: &str) -> String {
        if self.truncated || text.is_empty() {
            return String::new();
        }
        let used = self.out.chars().count();
        let room = MAX_OUTPUT.saturating_sub(used);
        if room == 0 {
            self.truncated = true;
            return String::new();
        }
        let total = text.chars().count();
        let take = total.min(room);
        let piece: String = text.chars().take(take).collect();
        if take < total {
            self.truncated = true;
        }
        self.out.push_str(&piece);
        piece
    }

    fn append_after(&mut self, text: &str) {
        if self.after.len() >= 16_000 {
            return;
        }
        let room = 16_000 - self.after.len();
        let piece: String = text.chars().take(room).collect();
        self.after.push_str(&piece);
    }
}

/// Case-insensitive `find` that is byte-index safe: the needles are ASCII, and
/// lowercasing only ASCII bytes preserves every byte length.
fn find_ci(haystack: &str, needle: &str) -> Option<usize> {
    haystack.to_ascii_lowercase().find(needle)
}

fn floor_char_boundary(text: &str, index: usize) -> usize {
    if index >= text.len() {
        return text.len();
    }
    let mut index = index;
    while index > 0 && !text.is_char_boundary(index) {
        index -= 1;
    }
    index
}

/// If `text` ends with a prefix of `</tag>`, return where that suffix starts.
fn partial_tag_suffix(text: &str, tag: &str) -> Option<usize> {
    let close = format!("</{}>", tag);
    let lower = text.to_ascii_lowercase();
    for length in (1..close.len()).rev() {
        if lower.ends_with(&close[..length]) {
            return Some(text.len() - length);
        }
    }
    None
}

fn extract_tag(text: &str, tag: &str) -> Option<String> {
    let open = format!("<{}>", tag.to_ascii_lowercase());
    let close = format!("</{}>", tag.to_ascii_lowercase());
    let lower = text.to_ascii_lowercase();
    let start = lower.find(&open)? + open.len();
    let end = lower[start..].find(&close)? + start;
    let value = text[start..end].trim();
    if value.is_empty() {
        None
    } else {
        Some(value.to_string())
    }
}

fn is_fence_line(line: &str) -> bool {
    let trimmed = line.trim();
    if !trimmed.starts_with("```") {
        return false;
    }
    let language = trimmed.trim_start_matches('`').trim();
    language
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '+' | '.'))
}

/// Remove a Markdown fence only when it wraps the entire answer.
fn strip_wrapping_fence(text: &str) -> &str {
    let trimmed = text.trim();
    if !trimmed.starts_with("```") {
        return trimmed;
    }
    let Some(first_newline) = trimmed.find('\n') else {
        return trimmed;
    };
    if !is_fence_line(&trimmed[..first_newline]) {
        return trimmed;
    }
    let last_line_start = trimmed.rfind('\n').map(|index| index + 1).unwrap_or(0);
    if last_line_start <= first_newline {
        return trimmed;
    }
    let last_line = trimmed[last_line_start..].trim();
    if !last_line.starts_with("```") || !last_line.trim_start_matches('`').trim().is_empty() {
        return trimmed;
    }
    trimmed[first_newline + 1..last_line_start].trim()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn collect(chunks: &[&str]) -> (String, String) {
        let mut filter = TagFilter::new("revised", Some("notes"));
        for chunk in chunks {
            filter.feed(chunk);
        }
        // `done` replaces whatever the panel streamed: the final pass trims the
        // edges and removes an outer code fence, so the deltas are a preview,
        // not a prefix contract.
        filter.finish()
    }

    #[test]
    fn emits_only_the_expected_tag() {
        let (text, notes) = collect(&[
            "Here is the revision:\n<revised>\nThe quick brown fox.\n</revised>\n",
            "<notes>\nFixed agreement.\n</notes>",
        ]);
        assert_eq!(text, "The quick brown fox.");
        assert_eq!(notes, "Fixed agreement.");
    }

    #[test]
    fn handles_a_tag_split_across_chunks() {
        let (text, _) = collect(&["<rev", "ised>The ", "answer</re", "vised>"]);
        assert_eq!(text, "The answer");
    }

    #[test]
    fn tags_are_case_insensitive() {
        let (text, _) = collect(&["<REVISED>Hello</Revised>"]);
        assert_eq!(text, "Hello");
    }

    #[test]
    fn a_missing_opening_tag_still_stops_at_the_closing_one() {
        let (text, notes) = collect(&[
            "The revised passage.</revised><notes>Only the notes.</notes>",
        ]);
        assert_eq!(text, "The revised passage.");
        assert_eq!(notes, "Only the notes.");
    }

    #[test]
    fn a_missing_closing_tag_stops_at_the_end() {
        let mut filter = TagFilter::new("summary", None);
        // The tail guard holds back a possible partial closing tag, so the last
        // few characters arrive on finish rather than in a delta.
        filter.feed("<summary>The point");
        let (text, _) = filter.finish();
        assert_eq!(text, "The point");
    }

    #[test]
    fn a_missing_opening_tag_streams_the_whole_answer() {
        let mut filter = TagFilter::new("continuation", None);
        let long = "word ".repeat(200);
        let mut streamed = filter.feed(&long);
        let (text, _) = filter.finish();
        streamed.push_str("");
        assert_eq!(text, long.trim());
        assert!(text.starts_with("word word"));
        assert!(!streamed.is_empty());
    }

    #[test]
    fn an_outer_code_fence_is_removed() {
        let (text, _) = collect(&["<revised>```markdown\nHello\n```\n</revised>"]);
        assert_eq!(text, "Hello");
    }

    #[test]
    fn a_code_block_inside_the_answer_is_kept() {
        let (text, _) = collect(&["<revised>See this:\n```js\nx()\n```\nDone.</revised>"]);
        assert!(text.contains("```js"));
        assert!(text.ends_with("Done."));
    }

    #[test]
    fn an_empty_answer_is_empty() {
        let (text, notes) = collect(&["<revised></revised>"]);
        assert!(text.is_empty());
        assert!(notes.is_empty());
    }

    #[test]
    fn notes_are_not_streamed() {
        let mut filter = TagFilter::new("revised", Some("notes"));
        let visible = filter.feed("<revised>Answer\n</revised><notes>secret</notes>");
        assert_eq!(visible, "Answer\n");
        assert!(!visible.contains("secret"));
    }

    #[test]
    fn passthrough_streams_everything() {
        let mut filter = TagFilter::passthrough();
        let first = filter.feed("Hello ");
        let second = filter.feed("world");
        let (text, notes) = filter.finish();
        assert_eq!(first, "Hello ");
        assert_eq!(second, "world");
        assert_eq!(text, "Hello world");
        assert!(notes.is_empty());
    }

    #[test]
    fn output_is_capped() {
        let mut filter = TagFilter::passthrough();
        let huge = "x".repeat(MAX_OUTPUT + 500);
        let visible = filter.feed(&huge);
        assert_eq!(visible.chars().count(), MAX_OUTPUT);
        assert!(filter.truncated());
        let (text, _) = filter.finish();
        assert_eq!(text.chars().count(), MAX_OUTPUT);
    }

    #[test]
    fn partial_closing_tag_is_not_emitted() {
        let mut filter = TagFilter::new("summary", None);
        let visible = filter.feed("<summary>Point one</summ");
        assert!(!visible.contains("</summ"));
        let (text, _) = filter.finish();
        assert_eq!(text, "Point one");
    }
}
