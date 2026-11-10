//! A file name for an untitled document, from the configured model.
//!
//! The deterministic name in `src/filename.ts` is always ready; this command is
//! the optional improvement for a note whose first line is prose rather than a
//! title. It reuses the assistant's transport, credentials and cancellation
//! plumbing, so there is no second HTTP path to keep working.
//!
//! The answer is deliberately raw. Deciding what a legal filename is belongs to
//! the frontend, which applies the same sanitiser to a heading; two rule sets
//! would drift. This side only takes the first line, removes the ceremonial
//! wrapper a model adds, and caps the length.

use std::time::Duration;

use tauri::State;
use tokio::sync::watch;

use crate::settings::AppState;
use crate::tokens::take_first_tokens;

use super::prompt::PromptMessage;
use super::provider::{self, ChatConfig, Provider};

/// Naming needs the opening, not the document. 512 tokens keeps even the
/// smallest context budget (1,024) comfortable.
const NAMING_TOKENS: usize = 512;
/// The frontend caps at 120 code points; this is only a guard against a runaway
/// answer crossing the IPC boundary.
const MAX_ANSWER_CHARS: usize = 400;
/// A reader is waiting to save. Four seconds at the frontend, five here: this
/// side has one second of slack to notice the cancellation.
const NAMING_TIMEOUT: Duration = Duration::from_secs(5);

/// The instruction. It asks for one line and names every character the
/// platform rejects, because a model that follows it saves the sanitiser work.
pub const SYSTEM: &str = "\
You name text documents in a code editor. Read the opening the user sends and \
propose one short file name.

Rules:
- Answer with the file name only, on one line. No quotes, no extension, no \
explanation, no label such as \"File name:\".
- Use the language of the document.
- Aim for four to twelve words and at most 90 characters; be specific enough to \
recognise the document months later.
- If the opening already begins with a title, keep that title.
- Never use any of these characters: < > : \" / \\ | ? *";

/// Strip one wrapper label and its separator, if the answer starts with it.
fn strip_label<'a>(text: &'a str, label: &str) -> Option<&'a str> {
    let lower = text.to_ascii_lowercase();
    let rest = lower.strip_prefix(label)?;
    // Skip spaces between the label and its separator, then require punctuation.
    // A real sentence may begin with the same letters ("Filename conventions are
    // hard"), and a space alone cannot tell the two apart.
    let trimmed = rest.trim_start();
    let separator = trimmed.chars().next()?;
    if !matches!(separator, ':' | '-' | '–' | '—') {
        return None;
    }
    let remainder = text[text.len() - trimmed.len()..].trim_start_matches(|character: char| {
        character.is_whitespace() || matches!(character, ':' | '-' | '–' | '—')
    });
    Some(remainder.trim())
}

/// The first line, without a label, wrapper tag, quotes or extension.
fn clean_answer(raw: &str) -> String {
    let mut lines = raw
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with("```"));
    let first = lines.next().unwrap_or("");
    // A model that ignored the one-line instruction sometimes puts a label on
    // its own line and the answer below it.
    let mut text = if first.ends_with(':') {
        lines.next().unwrap_or(first)
    } else {
        first
    };

    // A model that ignores the one-line rule sometimes wraps the name in the
    // XML-ish tag it uses for answers elsewhere.
    if text.starts_with('<')
        && let Some(end) = text.find('>')
    {
        let head = &text[1..end];
        if !head.is_empty() && !head.contains(' ') && head.len() < 40 {
            text = text[end + 1..].trim();
        }
    }
    if text.ends_with('>')
        && let Some(start) = text.rfind("</")
    {
        let tag = &text[start + 2..text.len() - 1];
        if !tag.is_empty() && !tag.contains(' ') && tag.len() < 40 {
            text = text[..start].trim();
        }
    }

    for label in [
        "file name",
        "filename",
        "file",
        "title",
        "título",
        "titre",
        "name",
        "nome",
        "nombre",
        "dateiname",
    ] {
        if let Some(rest) = strip_label(text, label) {
            text = rest;
            break;
        }
    }

    text = text.trim_matches(|character: char| {
        matches!(
            character,
            '"' | '\'' | '`' | '“' | '”' | '‘' | '’' | '«' | '»'
        )
    });

    let lower = text.to_ascii_lowercase();
    for extension in [
        "markdown", "asciidoc", "mdown", "mkd", "adoc", "html", "htm", "typ", "txt", "md",
    ] {
        let suffix = format!(".{extension}");
        if lower.ends_with(&suffix) {
            text = &text[..text.len() - suffix.len()];
            break;
        }
    }

    text.chars()
        .take(MAX_ANSWER_CHARS)
        .collect::<String>()
        .trim()
        .to_string()
}

/// Ask the endpoint for a name. The frontend owns the fallback and the timeout
/// the reader waits on; this command reports an error rather than inventing one.
#[tauri::command]
pub async fn ai_suggest_filename(
    state: State<'_, AppState>,
    id: String,
    text: String,
) -> Result<String, String> {
    let settings = state
        .settings
        .lock()
        .map_err(|_| "Settings are unavailable.".to_string())?
        .clone();
    if !settings.ai_enabled {
        return Err("Enable the AI Assistant in Preferences first.".to_string());
    }
    if !settings.ai_suggest_filename {
        return Err("File-name suggestions are off in AI Settings.".to_string());
    }
    let provider_kind = Provider::from_id(&settings.ai_provider)
        .ok_or_else(|| "Choose a provider in AI Settings.".to_string())?;
    let base = provider::normalize_base_url(&settings.ai_base_url)?;
    let model = settings.ai_model.trim().to_string();
    if model.is_empty() {
        return Err("Set a model in AI Settings first.".to_string());
    }

    let excerpt = take_first_tokens(text.trim(), NAMING_TOKENS);
    if excerpt.trim().is_empty() {
        return Err("The document is empty.".to_string());
    }

    let (key, _) = super::resolve_key(&state, provider_kind.id(), &base);
    let host = provider::host_of(&base);
    let config = ChatConfig {
        provider: provider_kind,
        base_url: base,
        model,
        key,
        host,
        disable_reasoning: settings.ai_disable_reasoning,
    };
    let messages = vec![PromptMessage {
        role: "user".to_string(),
        content: format!("Opening of the document:\n\n{excerpt}"),
    }];

    // Registering the same cancellation map as `ai_complete` is what lets the
    // frontend stop waiting without leaving a request running in the background.
    let (sender, mut receiver) = watch::channel(false);
    let registration = state.ai.register(&id, sender);

    // A reader may replace the naming prompt too. A file that no longer parses
    // must not block a save: the built-in prompt is used and the error surfaces
    // in the assistant panel on the next Generate, where it can be fixed.
    let prompts = super::prompts_file::load(&super::prompts_path(&state)).unwrap_or_default();
    let system = prompts.suggest_file_name().unwrap_or(SYSTEM);

    let mut answer = String::new();
    let result = tokio::time::timeout(
        NAMING_TIMEOUT,
        provider::stream(&config, system, &messages, &mut receiver, |delta| {
            answer.push_str(delta)
        }),
    )
    .await;

    drop(registration);

    match result {
        Err(_) => Err("The assistant did not answer in time.".to_string()),
        Ok(Err(message)) => Err(provider::redact(&message, config.key.as_deref())),
        Ok(Ok(outcome)) => {
            if outcome.stopped {
                return Err("The request was stopped.".to_string());
            }
            let answer = clean_answer(&answer);
            if answer.is_empty() {
                Err("The model returned an empty file name.".to_string())
            } else {
                Ok(answer)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_first_line_is_the_answer() {
        assert_eq!(
            clean_answer("  The Negotiation Brief  \nA second line"),
            "The Negotiation Brief"
        );
        assert_eq!(
            clean_answer("```\nReal Name\n```"),
            "Real Name"
        );
        assert_eq!(clean_answer("   \n\n"), "");
    }

    #[test]
    fn labels_quotes_and_extensions_are_removed() {
        assert_eq!(clean_answer("File name: \"Notes.md\""), "Notes");
        assert_eq!(clean_answer("Filename - Relações EUA-China"), "Relações EUA-China");
        assert_eq!(clean_answer("Título: A Mudança"), "A Mudança");
        assert_eq!(
            clean_answer("Filename conventions are hard"),
            "Filename conventions are hard"
        );
        assert_eq!(clean_answer("C#"), "C#");
    }

    #[test]
    fn a_wrapper_tag_is_not_part_of_the_name() {
        assert_eq!(clean_answer("<name>Real Name</name>"), "Real Name");
        assert_eq!(clean_answer("<p>Unclosed"), "Unclosed");
        assert_eq!(clean_answer("<name>"), "");
    }

    #[test]
    fn a_runaway_answer_is_capped() {
        let answer = clean_answer(&"x".repeat(MAX_ANSWER_CHARS + 50));
        assert_eq!(answer.chars().count(), MAX_ANSWER_CHARS);
    }

    #[test]
    fn the_prompt_states_the_one_line_and_character_contract() {
        assert!(SYSTEM.contains("file name only"));
        assert!(SYSTEM.contains("No quotes, no extension"));
        assert!(SYSTEM.contains("language of the document"));
        assert!(SYSTEM.contains("< > :"));
    }
}
