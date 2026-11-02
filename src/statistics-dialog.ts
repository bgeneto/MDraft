//! The read-only document statistics modal.
//!
//! The shell owns the numbers: this module only presents a snapshot, so the
//! dialog has no dependency on the editor or on Tauri. It is rebuilt on every
//! open, like the unsaved-changes dialog, and removed when it closes.

export interface SelectionStatistics {
  /** UTF-16 code units, the same unit as the status bar's character count. */
  characters: number;
  /** UTF-8 bytes of the selected text. */
  bytes: number;
  /** Non-empty selection ranges, one per cursor. */
  ranges: number;
}

export interface DocumentStatistics {
  /** UTF-16 code units without line endings, the status bar's character count. */
  characters: number;
  words: number;
  lines: number;
  /** The bytes a save would write, including the document's EOL and BOM. */
  bytes: number;
  selection: SelectionStatistics | null;
}

const countFormat = new Intl.NumberFormat();

function formatCount(value: number): string {
  return countFormat.format(value);
}

function addRow(list: HTMLDListElement, label: string, value: string, note = ""): HTMLElement {
  const row = document.createElement("div");
  row.className = "stats-row";
  const term = document.createElement("dt");
  term.textContent = label;
  if (note) {
    const suffix = document.createElement("span");
    suffix.className = "stats-note";
    suffix.textContent = note;
    term.append(" ", suffix);
  }
  const detail = document.createElement("dd");
  detail.textContent = value;
  row.append(term, detail);
  list.append(row);
  return detail;
}

/**
 * Show the statistics snapshot in a modal and resolve when it closes.
 *
 * `tokens` is filled in when the estimator answers; the dialog is already
 * readable by then, so a slow scan never delays it. A rejected promise shows
 * "Unavailable" rather than leaving a promise unhandled.
 */
export function showDocumentStatistics(
  statistics: DocumentStatistics,
  tokens: Promise<number | null>,
  fallbackFocus?: () => void,
): void {
  const previous = document.activeElement;
  const dialog = document.createElement("dialog");
  dialog.className = "stats-dialog";
  dialog.setAttribute("aria-labelledby", "stats-title");

  const title = document.createElement("h2");
  title.id = "stats-title";
  title.textContent = "Document Statistics";

  const list = document.createElement("dl");
  list.className = "stats-list";
  addRow(list, "Characters", formatCount(statistics.characters), "(without line endings)");
  addRow(list, "Words", formatCount(statistics.words));
  const tokenValue = addRow(list, "Tokens", "Estimating…");
  tokenValue.title = "Estimated from character classes; no model vocabulary is loaded.";
  addRow(list, "Lines", formatCount(statistics.lines));
  addRow(list, "Document length", formatCount(statistics.bytes), "(UTF-8 bytes)");

  const selection = document.createElement("p");
  selection.className = "stats-selection";
  if (statistics.selection) {
    const { characters, bytes, ranges } = statistics.selection;
    selection.textContent =
      `${formatCount(characters)} selected ${characters === 1 ? "character" : "characters"} ` +
      `(${formatCount(bytes)} ${bytes === 1 ? "byte" : "bytes"}) in ` +
      `${formatCount(ranges)} ${ranges === 1 ? "range" : "ranges"}`;
  } else {
    selection.hidden = true;
  }

  const actions = document.createElement("div");
  actions.className = "stats-actions";
  const close = document.createElement("button");
  close.type = "button";
  close.textContent = "Close";
  close.autofocus = true;
  actions.append(close);
  dialog.append(title, list, selection, actions);

  let settled = false;
  const finish = () => {
    if (settled) return;
    settled = true;
    dialog.close();
    dialog.remove();
    // A menu command can follow a panel that has just been closed: its button
    // is still connected but no longer painted, so focusing it would leave the
    // keyboard nowhere. Fall back to the editor in that case.
    const restorable =
      previous instanceof HTMLElement &&
      previous !== document.body &&
      previous !== document.documentElement &&
      previous.isConnected &&
      previous.getClientRects().length > 0;
    if (restorable) previous.focus({ preventScroll: true });
    else fallbackFocus?.();
  };

  close.addEventListener("click", finish);
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    finish();
  });
  dialog.addEventListener("close", finish);
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) finish();
  });
  // The window accelerator handler runs in the capture phase, so `finish` alone
  // cannot keep keystrokes out of the editor; the shell's modal guard does that.
  // This stops the editor's own keymaps once the event has reached the dialog.
  dialog.addEventListener("keydown", (event) => event.stopPropagation());

  document.body.append(dialog);
  try {
    dialog.showModal();
  } catch {
    finish();
    return;
  }

  void tokens.then(
    (count) => {
      if (!dialog.isConnected) return;
      tokenValue.textContent = count === null ? "Unavailable" : formatCount(count);
      if (count === null) tokenValue.title = "The token estimate could not be completed.";
    },
    () => {
      if (!dialog.isConnected) return;
      tokenValue.textContent = "Unavailable";
      tokenValue.title = "The token estimate could not be completed.";
    },
  );
}
