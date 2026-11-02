//! The AI Assistant's context budget.
//!
//! One setting, measured in approximate tokens, bounds the text sent with a
//! request. The passage, Ask's question and history, and Continue's preceding
//! text all draw from the same number; the shares below keep their historical
//! proportions without turning one reader-facing budget into three.
//!
//! The estimator lives in [`crate::tokens`] and is the same one the status bar
//! uses. A real BPE vocabulary would be model-specific and much heavier; this
//! budget is a guard rail, not an exact tokenizer.

/// Default document-context budget for one AI request.
pub const DEFAULT_AI_CONTEXT_TOKENS: usize = 8_192;
/// The smallest budget the Preferences row and a hand-edited file may set.
pub const MIN_AI_CONTEXT_TOKENS: usize = 1_024;
/// The hard ceiling, so a hand-edited file cannot grow a request without bound.
pub const MAX_AI_CONTEXT_TOKENS: usize = 32_768;

/// The smallest Continue or per-turn history share, even at the lowest budget.
const MIN_PART_TOKENS: usize = 256;

/// Keep a configured budget inside the supported range.
pub fn clamp_context_tokens(tokens: usize) -> usize {
    tokens.clamp(MIN_AI_CONTEXT_TOKENS, MAX_AI_CONTEXT_TOKENS)
}

/// Add digit grouping to a token number, matching the panel's `Intl.NumberFormat`.
pub fn format_tokens(tokens: usize) -> String {
    let digits = tokens.to_string();
    let mut out = String::with_capacity(digits.len() + digits.len() / 3);
    for (index, digit) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index).is_multiple_of(3) {
            out.push(',');
        }
        out.push(digit);
    }
    out
}

/// The derived caps for one request.
///
/// `context` is the whole context budget. `continue_part` is shared by
/// Continue's selection and its preceding text, and `history_turn` keeps one
/// long conversation turn from consuming the history's share.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AiLimits {
    pub context: usize,
    pub continue_part: usize,
    pub history_turn: usize,
}

impl AiLimits {
    pub fn from_context_tokens(tokens: usize) -> Self {
        let context = clamp_context_tokens(tokens);
        Self {
            context,
            continue_part: (context / 2).max(MIN_PART_TOKENS),
            history_turn: (context / 4).max(MIN_PART_TOKENS),
        }
    }
}

impl Default for AiLimits {
    fn default() -> Self {
        Self::from_context_tokens(DEFAULT_AI_CONTEXT_TOKENS)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_default_is_8192_tokens() {
        let limits = AiLimits::default();
        assert_eq!(limits.context, 8_192);
        assert_eq!(limits.continue_part, 4_096);
        assert_eq!(limits.history_turn, 2_048);
    }

    #[test]
    fn a_budget_is_clamped_at_both_ends() {
        assert_eq!(clamp_context_tokens(1), MIN_AI_CONTEXT_TOKENS);
        assert_eq!(
            clamp_context_tokens(usize::MAX),
            MAX_AI_CONTEXT_TOKENS
        );
        assert_eq!(AiLimits::from_context_tokens(1).context, 1_024);
        assert_eq!(
            AiLimits::from_context_tokens(99_999).context,
            MAX_AI_CONTEXT_TOKENS
        );
    }

    #[test]
    fn the_lowest_budget_keeps_usable_shares() {
        let limits = AiLimits::from_context_tokens(MIN_AI_CONTEXT_TOKENS);
        assert_eq!(limits.context, 1_024);
        assert_eq!(limits.continue_part, 512);
        assert_eq!(limits.history_turn, 256);
    }

    #[test]
    fn token_numbers_are_grouped() {
        assert_eq!(format_tokens(0), "0");
        assert_eq!(format_tokens(999), "999");
        assert_eq!(format_tokens(1_024), "1,024");
        assert_eq!(format_tokens(8_192), "8,192");
        assert_eq!(format_tokens(32_768), "32,768");
    }
}
