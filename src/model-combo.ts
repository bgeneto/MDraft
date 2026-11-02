//! The AI Assistant's Model field: a combo over the ids the endpoint reported.
//!
//! A native `<datalist>` filters its suggestions by the input's current value. A
//! model id saved for the previous endpoint therefore hides every id the new
//! endpoint just returned: the arrow opens an empty popup although the fetch
//! succeeded. `src/combo.ts` opens the complete list and uses the field's text as
//! a filter only once the reader types. The field stays editable because an
//! endpoint may serve no model list at all.

import { attachCombo, closeCombo, filterEntries } from "./combo.ts";

/** Case-insensitive substring search, in the endpoint's own order. */
export function filterModelIds(models: readonly string[], query: string): string[] {
  return filterEntries(
    models.map((value) => ({ value })),
    query,
  ).map((entry) => entry.value);
}

export interface ModelComboOptions {
  /** The text field that carries the model id. */
  input: HTMLInputElement;
  /** A label for assistive technology; the row's visible label is not a `<label>`. */
  label: string;
  /** Read on every open: changing the Base URL clears the cached list. */
  models: () => readonly string[];
  /** Persist the chosen id. The field is already updated when this runs. */
  choose: (model: string) => void;
}

/** Close the open picker, for a panel re-render or a closed Preferences. */
export function closeModelCombo(): void {
  closeCombo();
}

/**
 * Build the caret and the popup for a model field.
 *
 * The return value is the caret button, which the caller appends beside the
 * input. The popup is appended to the document body: the Preferences content
 * scrolls, and an absolutely positioned list inside it would be clipped.
 */
export function attachModelCombo(options: ModelComboOptions): HTMLButtonElement {
  return attachCombo({
    input: options.input,
    label: options.label,
    listLabel: "Fetched models",
    toggleLabel: "Show all fetched models",
    entries: () => options.models().map((value) => ({ value })),
    emptyLabel: "No models fetched yet. Use Fetch model list.",
    noMatchLabel: (query) => `No fetched model matches “${query.trim()}”.`,
    choose: options.choose,
  });
}
