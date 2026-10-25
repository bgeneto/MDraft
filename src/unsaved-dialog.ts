//! Explicit decisions for destructive document operations. Dismissal is Cancel.

import type { Session } from "./sessions";
import type { UnsavedDecision } from "./document-lifecycle";

export function askUnsaved(session: Session, count: number): Promise<UnsavedDecision> {
  const previous = document.activeElement;
  const dialog = document.createElement("dialog");
  dialog.className = "unsaved-dialog";
  dialog.setAttribute("aria-labelledby", "unsaved-title");
  dialog.setAttribute("aria-describedby", "unsaved-description");
  const title = document.createElement("h2");
  title.id = "unsaved-title";
  title.textContent = "Unsaved changes";
  const description = document.createElement("p");
  description.id = "unsaved-description";
  description.textContent = `Save changes to “${session.name}”?${count > 1 ? ` ${count} documents have unsaved changes.` : ""}`;
  const actions = document.createElement("div");
  actions.className = "unsaved-actions";
  dialog.append(title, description, actions);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (decision: UnsavedDecision) => {
      if (settled) return;
      settled = true;
      dialog.close();
      dialog.remove();
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus({ preventScroll: true });
      resolve(decision);
    };
    for (const [decision, label] of [
      ["discard", "Discard"],
      ["cancel", "Cancel"],
      ["save", "Save"],
    ] as const) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.decision = decision;
      button.textContent = label;
      if (decision === "cancel") button.autofocus = true;
      button.addEventListener("click", () => finish(decision));
      actions.append(button);
    }
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      finish("cancel");
    });
    dialog.addEventListener("close", () => finish("cancel"));
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) finish("cancel");
    });
    dialog.addEventListener("keydown", (event) => event.stopPropagation());
    document.body.append(dialog);
    try {
      dialog.showModal();
    } catch {
      finish("cancel");
    }
  });
}
