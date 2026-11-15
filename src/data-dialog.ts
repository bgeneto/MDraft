//! The user-facing backup, restore and recovered-document decisions.

import type {
  DataBackupEstimate,
  DataBackupResult,
  DataBackupProgress,
  DataRestorePreview,
  DataRestoreReview,
  DataRestoreReport,
  DataRestoreSelection,
  RecoveredItem,
} from "./api";

function shell(title: string): {
  dialog: HTMLDialogElement;
  content: HTMLDivElement;
  actions: HTMLDivElement;
  previous: Element | null;
} {
  const previous = document.activeElement;
  const dialog = document.createElement("dialog");
  dialog.className = "data-dialog";
  dialog.setAttribute("aria-label", title);
  const heading = document.createElement("h2");
  heading.textContent = title;
  const content = document.createElement("div");
  content.className = "data-dialog-content";
  const actions = document.createElement("div");
  actions.className = "unsaved-actions";
  dialog.append(heading, content, actions);
  dialog.addEventListener("keydown", (event) => event.stopPropagation());
  document.body.append(dialog);
  return { dialog, content, actions, previous };
}

function close(dialog: HTMLDialogElement, previous: Element | null): void {
  if (dialog.open) dialog.close();
  dialog.remove();
  if (previous instanceof HTMLElement && previous.isConnected)
    previous.focus({ preventScroll: true });
}

function paragraph(parent: HTMLElement, value: string): HTMLParagraphElement {
  const p = document.createElement("p");
  p.textContent = value;
  parent.append(p);
  return p;
}

function button(
  actions: HTMLElement,
  text: string,
  handler: () => void,
  autofocus = false,
): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = "button";
  element.textContent = text;
  element.autofocus = autofocus;
  element.addEventListener("click", handler);
  actions.append(element);
  return element;
}

function checkbox(
  parent: HTMLElement,
  text: string,
  checked: boolean,
  disabled = false,
): HTMLInputElement {
  const label = document.createElement("label");
  label.className = "data-dialog-option";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = checked;
  input.disabled = disabled;
  const description = document.createElement("span");
  description.textContent = text;
  label.append(input, description);
  parent.append(label);
  return input;
}

export function backupOptions(estimate: Promise<DataBackupEstimate>): Promise<boolean | null> {
  const { dialog, content, actions, previous } = shell("Back up MDraft data");
  paragraph(
    content,
    "Create one ZIP containing preferences, personal packages, prompts and unsaved writing. Saved documents outside MDraft and API keys are not included.",
  );
  paragraph(content, "The ZIP is not encrypted and may contain private writing and file paths.");
  paragraph(content, "Choose a new file name; existing files are not overwritten.");
  const downloads = checkbox(content, "Include downloaded tools and packages", true);
  const size = paragraph(content, "Estimating saved data…");
  let estimated: DataBackupEstimate | null = null;
  const updateSize = () => {
    if (!estimated) return;
    const bytes = estimated.savedBytes + (downloads.checked ? estimated.downloadBytes : 0);
    size.textContent = `Estimated saved data before compression: ${formatBytes(bytes)}. Unsaved writing is added separately.`;
  };
  downloads.addEventListener("change", updateSize);
  void estimate.then(
    (result) => {
      estimated = result;
      updateSize();
    },
    () => {
      size.textContent =
        "The size estimate is unavailable; MDraft will check the data when creating the backup.";
    },
  );
  paragraph(
    content,
    "If omitted, those tools and packages may need to be set up again after recovery.",
  );
  return new Promise((resolve) => {
    const finish = (value: boolean | null) => {
      close(dialog, previous);
      resolve(value);
    };
    button(actions, "Cancel", () => finish(null), true);
    button(actions, "Choose Location…", () => finish(downloads.checked));
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      finish(null);
    });
    dialog.showModal();
  });
}

export function backupComplete(result: DataBackupResult): Promise<boolean> {
  const { dialog, content, actions, previous } = shell("Backup saved");
  paragraph(content, `Verified ZIP: ${result.path}`);
  paragraph(
    content,
    `${formatBytes(result.bytes)} · ${result.files} files · captured ${new Date(result.capturedAtMs).toLocaleString()}`,
  );
  paragraph(content, "Keep this unencrypted ZIP somewhere private.");
  return new Promise((resolve) => {
    const finish = (reveal: boolean) => {
      close(dialog, previous);
      resolve(reveal);
    };
    button(actions, "Close", () => finish(false), true);
    button(actions, "Show in Folder", () => finish(true));
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      finish(false);
    });
    dialog.showModal();
  });
}

export function restoreOptions(preview: DataRestorePreview): Promise<DataRestoreSelection | null> {
  const { dialog, content, actions, previous } = shell("Restore backup");
  paragraph(
    content,
    `Created ${new Date(preview.createdAtMs).toLocaleString()} by MDraft ${preview.appVersion}; backup format ${preview.formatVersion}. Source: ${preview.sourceOs} ${preview.sourceArch}${preview.portable ? ", portable" : ""}.`,
  );
  paragraph(
    content,
    `Validated data: ${formatBytes(preview.totalBytes)}. Selected preferences, prompts and personal packages replace the current categories. Recovered writing is added as separate copies.`,
  );
  const available = (name: string) => Boolean(preview.categories[name]?.included);
  const inputs: Record<keyof DataRestoreSelection, HTMLInputElement> = {
    settings: checkbox(
      content,
      "Preferences, favorites and saved lists",
      available("settings"),
      !available("settings"),
    ),
    prompts: checkbox(content, "AI prompt overrides", available("prompts"), !available("prompts")),
    personal: checkbox(
      content,
      "Personal TeX packages",
      available("personal"),
      !available("personal"),
    ),
    recovery: checkbox(
      content,
      "Unsaved and previously recovered writing",
      available("recovery") || available("session"),
      !(available("recovery") || available("session")),
    ),
    downloads: checkbox(
      content,
      "Downloaded tools and packages (retained for inspection)",
      available("downloads") && preview.compatiblePlatform,
      !available("downloads") || !preview.compatiblePlatform,
    ),
    window: checkbox(
      content,
      "Window placement",
      false,
      !available("window") || !preview.compatiblePlatform,
    ),
  };
  paragraph(
    content,
    "Unavailable categories were not included or are incompatible with this computer. Imported AI, after-export commands and native TeX paths remain disabled until reviewed.",
  );
  const warning = document.createElement("p");
  warning.setAttribute("role", "alert");
  content.append(warning);
  return new Promise((resolve) => {
    const finish = (selection: DataRestoreSelection | null) => {
      close(dialog, previous);
      resolve(selection);
    };
    button(actions, "Cancel", () => finish(null), true);
    button(actions, "Continue…", () => {
      const selection = Object.fromEntries(
        Object.entries(inputs).map(([key, input]) => [key, input.checked]),
      ) as unknown as DataRestoreSelection;
      if (!Object.values(selection).some(Boolean)) {
        warning.textContent = "Select at least one available category.";
        return;
      }
      finish(selection);
    });
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      finish(null);
    });
    dialog.showModal();
  });
}

export function confirmRestore(source: string, review: DataRestoreReview): Promise<boolean> {
  const { dialog, content, actions, previous } = shell("Review restore");
  paragraph(content, `Backup: ${source}`);
  paragraph(content, `Safety backup saved and verified: ${review.safetyBackup.path}`);
  paragraph(
    content,
    `Recovered writing: ${review.recoveredDocuments}; preserved journals: ${review.salvagedJournals}; downloaded files retained for inspection: ${review.quarantinedDownloads}.`,
  );
  for (const adjustment of review.adjustments) paragraph(content, adjustment);
  paragraph(
    content,
    "MDraft will ask about unsaved documents, then restart. Once the restore begins, it must finish or roll back before the app can open.",
  );
  return new Promise((resolve) => {
    const finish = (value: boolean) => {
      close(dialog, previous);
      resolve(value);
    };
    button(actions, "Cancel", () => finish(false), true);
    button(actions, "Restore and Restart", () => finish(true));
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      finish(false);
    });
    dialog.showModal();
  });
}

export function showRestoreReport(
  report: DataRestoreReport,
  deferredWorkspace: string | null,
  hasSavedTabs: boolean,
): Promise<"later" | "recovered" | "workspace"> {
  const { dialog, content, actions, previous } = shell(
    report.restored ? "Backup restored" : "Restore was rolled back",
  );
  paragraph(content, report.message);
  if (report.review) {
    paragraph(content, `Safety backup: ${report.review.safetyBackup.path}`);
    paragraph(content, `Recovered documents: ${report.review.recoveredDocuments}`);
    for (const adjustment of report.review.adjustments) paragraph(content, adjustment);
  }
  if (deferredWorkspace)
    paragraph(content, `The restored workspace was not opened automatically: ${deferredWorkspace}`);
  return new Promise((resolve) => {
    const finish = (action: "later" | "recovered" | "workspace") => {
      close(dialog, previous);
      resolve(action);
    };
    button(
      actions,
      report.restored && report.review?.recoveredDocuments ? "Later" : "Close",
      () => finish("later"),
      true,
    );
    if (report.restored && (deferredWorkspace || hasSavedTabs)) {
      button(actions, deferredWorkspace ? "Reopen Workspace and Tabs" : "Reopen Tabs", () =>
        finish("workspace"),
      );
    }
    if (report.restored && report.review?.recoveredDocuments) {
      button(actions, "Open Recovered Documents", () => finish("recovered"));
    }
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      finish("later");
    });
    dialog.showModal();
  });
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

export function dataProgress(
  cancel: () => void,
  allowBackground = false,
): {
  update(event: DataBackupProgress): void;
  close(): void;
} {
  const { dialog, content, actions, previous } = shell("Application data");
  const status = document.createElement("p");
  status.setAttribute("role", "status");
  status.textContent = "Preparing…";
  const progress = document.createElement("progress");
  progress.setAttribute("aria-label", "Application data operation progress");
  content.append(status, progress);
  const stop = button(
    actions,
    "Cancel",
    () => {
      stop.disabled = true;
      status.textContent = "Canceling…";
      cancel();
    },
    true,
  );
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    if (!stop.disabled) stop.click();
  });
  dialog.showModal();
  let background = false;
  let closed = false;
  return {
    update(event) {
      if (stop.disabled || closed) return;
      if (allowBackground && !background && event.phase === "compressing") {
        background = true;
        dialog.close();
        dialog.classList.add("data-dialog-background");
        dialog.show();
        if (previous instanceof HTMLElement && previous.isConnected)
          previous.focus({ preventScroll: true });
      }
      const labels: Record<DataBackupProgress["phase"], string> = {
        checking: "Checking backup",
        "preparing-restore": "Preparing restore",
        preparing: "Preparing backup",
        compressing: "Creating ZIP",
        verifying: "Verifying ZIP",
      };
      status.textContent = `${labels[event.phase]}… ${formatBytes(event.bytes)} processed`;
    },
    close: () => {
      closed = true;
      close(dialog, previous);
    },
  };
}

export type RecoveredChoice = {
  action: "open" | "save-all" | "discard";
  items: RecoveredItem[];
} | null;
export function chooseRecoveredDocuments(items: RecoveredItem[]): Promise<RecoveredChoice> {
  const { dialog, content, actions, previous } = shell("Recovered documents");
  paragraph(
    content,
    "These copies do not overwrite their original files. Open them as unsaved documents, or save copies to a folder.",
  );
  if (items.length === 0)
    paragraph(content, "There are no recovered documents waiting to be saved.");
  const options = items.map((item) => ({
    item,
    input: checkbox(
      content,
      `${item.document.name}${item.document.originalPath ? ` — originally ${item.document.originalPath}` : ""}`,
      true,
    ),
  }));
  return new Promise((resolve) => {
    const finish = (value: RecoveredChoice) => {
      close(dialog, previous);
      resolve(value);
    };
    const selected = () => options.filter(({ input }) => input.checked).map(({ item }) => item);
    button(actions, "Close", () => finish(null), true);
    if (items.length > 0) {
      button(actions, "Discard Selected", () => finish({ action: "discard", items: selected() }));
      button(actions, "Save Selected…", () => finish({ action: "save-all", items: selected() }));
      button(actions, "Open Selected", () => finish({ action: "open", items: selected() }));
    }
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      finish(null);
    });
    dialog.showModal();
  });
}
