//! Tools › Encoding and Line Endings: reinterpret, convert, save.
//!
//! The shell owns the document and every byte decision (Rust decodes, encodes
//! and checks the fit); this module presents a snapshot and reports the
//! reader's choice through `EncodingDialogHost`. Like the statistics dialog it
//! is rebuilt on every open and removed when it closes. Actions close the
//! dialog first and then call the host, so a native message box or the
//! unsaved-changes prompt never stacks on top of it.

import type { EncodingCandidate, EncodingFit, EncodingInspection } from "./api";
import type { SaveFormat } from "./document-lifecycle";
import {
  canonicalDeclared,
  declarationReplacement,
  displayEncoding,
  ENCODING_GROUPS,
  encodingInfo,
  findDeclarations,
  isUnicode,
} from "./encodings";

export interface EncodingDialogDocument {
  name: string;
  /** Null for an untitled buffer: only its first-save format can be chosen. */
  path: string | null;
  readOnly: boolean;
  dirty: boolean;
  language: string;
  encoding: string;
  hadBom: boolean;
  lineEnding: "\n" | "\r\n";
  /** The editor text when the dialog opened. The dialog is modal. */
  text: string;
  /** Which section to show first. */
  tab?: "convert" | "reinterpret";
  /** A line shown above the sections, e.g. after a Reopen. */
  notice?: string;
}

export interface DeclarationEdit {
  from: number;
  to: number;
  insert: string;
}

export interface EncodingDialogHost {
  /** The bytes on disk, or null for an untitled buffer. */
  inspect(): Promise<EncodingInspection> | null;
  fit(encoding: string): Promise<EncodingFit>;
  reopen(encoding: string): void;
  convert(format: SaveFormat, copy: boolean, edits: DeclarationEdit[]): void;
  /** Untitled buffer: remember the format for its first save. */
  apply(format: SaveFormat, edits: DeclarationEdit[]): void;
  goTo(offset: number): void;
  focusEditor(): void;
}

type TargetKind = "utf8" | "utf8bom" | "utf16le" | "utf16be" | "current" | "other";

const eolName = (eol: string) => (eol === "\r\n" ? "CRLF" : "LF");

function formatName(format: SaveFormat): string {
  const bom = format.hadBom && format.encoding === "UTF-8" ? " with BOM" : "";
  return `${displayEncoding(format.encoding)}${bom} · ${eolName(format.lineEnding)}`;
}

function node<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = "",
  text = "",
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text) element.textContent = text;
  return element;
}

function lineAndColumn(text: string, offset: number): { line: number; column: number } {
  let line = 1;
  let start = 0;
  for (let index = text.indexOf("\n"); index !== -1 && index < offset;) {
    line += 1;
    start = index + 1;
    index = text.indexOf("\n", start);
  }
  return { line, column: offset - start + 1 };
}

let sequence = 0;

export function showEncodingDialog(doc: EncodingDialogDocument, host: EncodingDialogHost): void {
  const id = `encoding-${(sequence += 1)}`;
  const untitled = doc.path === null;
  const previous = document.activeElement;
  const dialog = node("dialog", "encoding-dialog");
  dialog.setAttribute("aria-labelledby", `${id}-title`);

  // ---- Header and current format ------------------------------------------
  const header = node("header", "encoding-header");
  const title = node("h2", "", "Encoding and Line Endings");
  title.id = `${id}-title`;
  const file = node("p", "encoding-file", doc.name);
  header.append(title, file);

  const current = node("div", "encoding-current");
  const chips = node("div", "encoding-chips");
  const chip = (text: string, hint: string) => {
    const element = node("span", "encoding-chip", text);
    element.title = hint;
    chips.append(element);
  };
  chip(displayEncoding(doc.encoding), encodingInfo(doc.encoding)?.title ?? doc.encoding);
  chip(
    eolName(doc.lineEnding),
    doc.lineEnding === "\r\n" ? "Windows line endings" : "Unix line endings",
  );
  if (doc.encoding === "UTF-8" || isUnicode(doc.encoding))
    chip(doc.hadBom ? "BOM" : "No BOM", "Byte-order mark at the start of the file");
  if (untitled) chip("Not saved", "Choose what the first save writes");
  if (doc.readOnly) chip("Read-only", "The file cannot be overwritten");
  const disk = node("p", "encoding-disk");
  disk.textContent = untitled ? "Untitled document — nothing on disk yet." : "Reading the file…";
  current.append(chips, disk);

  const notice = node("p", "encoding-notice", doc.notice ?? "");
  notice.hidden = !doc.notice;

  // ---- Tabs ---------------------------------------------------------------
  const tabs = node("div", "encoding-tabs");
  tabs.setAttribute("role", "tablist");
  const makeTab = (name: string, panelId: string) => {
    const tab = node("button", "encoding-tab", name);
    tab.type = "button";
    tab.id = `${panelId}-tab`;
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-controls", panelId);
    tabs.append(tab);
    return tab;
  };
  const convertTab = makeTab(untitled ? "Save Format" : "Convert", `${id}-convert`);
  const reinterpretTab = makeTab("Reinterpret", `${id}-reinterpret`);
  if (untitled) reinterpretTab.hidden = true;

  // ---- Convert panel ------------------------------------------------------
  const convertPanel = node("section", "encoding-panel");
  convertPanel.id = `${id}-convert`;
  convertPanel.setAttribute("role", "tabpanel");
  convertPanel.setAttribute("aria-labelledby", convertTab.id);

  const targets = node("fieldset", "encoding-targets");
  targets.append(node("legend", "", untitled ? "Save as" : "Convert to"));
  const radios = new Map<TargetKind, HTMLInputElement>();
  const addTarget = (kind: TargetKind, label: string, hint: string, badge = "") => {
    const row = node("label", "encoding-target");
    const input = node("input");
    input.type = "radio";
    input.name = `${id}-target`;
    input.value = kind;
    const text = node("span", "encoding-target-text");
    const name = node("span", "encoding-target-name", label);
    if (badge) name.append(node("span", "encoding-badge", badge));
    text.append(name, node("span", "encoding-target-hint", hint));
    row.append(input, text);
    targets.append(row);
    radios.set(kind, input);
    return row;
  };
  addTarget(
    "utf8",
    "UTF-8",
    "Works with every modern editor, compiler and browser.",
    "Recommended",
  );
  addTarget(
    "utf8bom",
    "UTF-8 with BOM",
    "Only for tools that require a byte-order mark, such as Excel CSV import or PowerShell 5.",
  );
  addTarget("utf16le", "UTF-16 LE", "Windows-native files. Rarely right for documents.");
  addTarget("utf16be", "UTF-16 BE", "Big-endian UTF-16. Rarely needed.");
  if (!isUnicode(doc.encoding)) {
    addTarget(
      "current",
      `Keep ${displayEncoding(doc.encoding)}`,
      "Keep the current encoding; change only the line endings.",
    );
  }
  const otherRow = addTarget(
    "other",
    "Other encoding",
    "A legacy encoding a specific program requires.",
  );
  const otherSelect = node("select", "encoding-select");
  otherSelect.setAttribute("aria-label", "Other encoding");
  for (const group of ENCODING_GROUPS) {
    if (group.name === "Unicode") continue;
    const optgroup = node("optgroup");
    optgroup.label = group.name;
    for (const info of group.encodings) {
      const option = node("option", "", info.title);
      option.value = info.label;
      optgroup.append(option);
    }
    otherSelect.append(optgroup);
  }
  otherSelect.value = isUnicode(doc.encoding) ? "windows-1252" : doc.encoding;
  otherRow.querySelector(".encoding-target-text")?.append(otherSelect);

  const eolSet = node("fieldset", "encoding-eol");
  eolSet.append(node("legend", "", "Line endings"));
  const eolRadios = new Map<string, HTMLInputElement>();
  for (const [value, label, hint] of [
    ["\n", "LF", "Linux, macOS, Git"],
    ["\r\n", "CRLF", "Windows"],
  ] as const) {
    const row = node("label", "encoding-segment");
    const input = node("input");
    input.type = "radio";
    input.name = `${id}-eol`;
    input.value = value;
    row.append(
      input,
      node("span", "encoding-segment-name", label),
      node("span", "encoding-segment-hint", hint),
    );
    eolSet.append(row);
    eolRadios.set(value, input);
  }

  const checks = node("div", "encoding-checks");
  checks.setAttribute("aria-live", "polite");
  const fitLine = node("p", "encoding-fit");
  const declarationRow = node("label", "encoding-declaration");
  const declarationBox = node("input");
  declarationBox.type = "checkbox";
  declarationBox.checked = true;
  const declarationText = node("span");
  declarationRow.append(declarationBox, declarationText);
  const warnings = node("ul", "encoding-warnings");
  checks.append(fitLine, declarationRow, warnings);

  const summary = node("p", "encoding-summary");
  convertPanel.append(targets, eolSet, checks, summary);

  // ---- Reinterpret panel --------------------------------------------------
  const reinterpretPanel = node("section", "encoding-panel");
  reinterpretPanel.id = `${id}-reinterpret`;
  reinterpretPanel.setAttribute("role", "tabpanel");
  reinterpretPanel.setAttribute("aria-labelledby", reinterpretTab.id);
  const help = node(
    "p",
    "encoding-help",
    "Characters look wrong? Read the file on disk again as another encoding. Nothing is written; " +
      "convert afterwards to keep the new reading.",
  );
  const columns = node("div", "encoding-reinterpret");
  const list = node("div", "encoding-list");
  list.setAttribute("role", "listbox");
  list.setAttribute("aria-label", "Encodings");
  list.tabIndex = 0;
  const preview = node("div", "encoding-preview");
  preview.setAttribute("aria-live", "polite");
  columns.append(list, preview);
  const showInvalidRow = node("label", "encoding-show-invalid");
  const showInvalid = node("input");
  showInvalid.type = "checkbox";
  showInvalidRow.append(
    showInvalid,
    document.createTextNode(" Show encodings that cannot read this file"),
  );
  reinterpretPanel.append(help, columns, showInvalidRow);

  // ---- Footer -------------------------------------------------------------
  const actions = node("div", "encoding-actions");
  const cancel = node("button", "", "Cancel");
  cancel.type = "button";
  const copyButton = node("button", "", "Save Converted Copy…");
  copyButton.type = "button";
  const primary = node("button", "encoding-primary");
  primary.type = "button";
  actions.append(cancel, copyButton, primary);

  dialog.append(header, current, notice, tabs, convertPanel, reinterpretPanel, actions);

  // ---- State --------------------------------------------------------------
  let tab: "convert" | "reinterpret" = untitled ? "convert" : (doc.tab ?? "convert");
  let inspection: EncodingInspection | null = null;
  let fit: EncodingFit | "pending" | null = null;
  let fitRequest = 0;
  let fitTimer = 0;
  let chosen: string | null = null;
  const declarations = findDeclarations(doc.text, doc.language);

  const initialTarget: TargetKind =
    doc.encoding === "UTF-8"
      ? doc.hadBom
        ? "utf8bom"
        : "utf8"
      : doc.encoding === "UTF-16LE"
        ? "utf16le"
        : doc.encoding === "UTF-16BE"
          ? "utf16be"
          : "utf8";
  radios.get(initialTarget)!.checked = true;
  eolRadios.get(doc.lineEnding)!.checked = true;

  function targetFormat(): SaveFormat {
    const kind = ([...radios].find(([, input]) => input.checked)?.[0] ?? "utf8") as TargetKind;
    const lineEnding = eolRadios.get("\r\n")!.checked ? "\r\n" : "\n";
    switch (kind) {
      case "utf8":
        return { encoding: "UTF-8", hadBom: false, lineEnding };
      case "utf8bom":
        return { encoding: "UTF-8", hadBom: true, lineEnding };
      case "utf16le":
        return { encoding: "UTF-16LE", hadBom: true, lineEnding };
      case "utf16be":
        return { encoding: "UTF-16BE", hadBom: true, lineEnding };
      case "current":
        return { encoding: doc.encoding, hadBom: doc.hadBom, lineEnding };
      case "other":
        return { encoding: otherSelect.value, hadBom: false, lineEnding };
    }
  }

  const mixedEndings = () => {
    if (!inspection) return 0;
    const { crlf, lf, cr } = inspection.lineEndings;
    const kinds = [crlf, lf, cr].filter((count) => count > 0).length;
    if (kinds <= 1 && cr === 0) return 0;
    // What a save normalises: every ending that is not the document's own.
    return doc.lineEnding === "\r\n" ? lf + cr : crlf + cr;
  };

  function pendingEdits(format: SaveFormat): DeclarationEdit[] {
    if (!declarationBox.checked || declarationRow.hidden) return [];
    return declarations.flatMap((declaration) => {
      const insert = declarationReplacement(declaration, format.encoding);
      return insert === null ? [] : [{ from: declaration.from, to: declaration.to, insert }];
    });
  }

  function renderChecks(format: SaveFormat): void {
    // Fit.
    fitLine.className = "encoding-fit";
    fitLine.replaceChildren();
    if (fit === "pending") {
      fitLine.textContent = "Checking characters…";
    } else if (fit && fit.unmappable > 0) {
      fitLine.classList.add("is-error");
      const where = fit.firstOffset === null ? null : lineAndColumn(doc.text, fit.firstOffset);
      const count =
        fit.unmappable === 1 ? "1 character" : `${fit.unmappable.toLocaleString()} characters`;
      fitLine.append(
        `${count} cannot be stored in ${displayEncoding(format.encoding)}` +
          (fit.firstChar ? ` — first: “${fit.firstChar}”` : "") +
          (where ? ` at Ln ${where.line}, Col ${where.column}. ` : ". "),
      );
      if (fit.firstOffset !== null) {
        const offset = fit.firstOffset;
        const go = node("button", "encoding-link", "Go to");
        go.type = "button";
        go.addEventListener("click", () => {
          finish(false);
          host.goTo(offset);
        });
        fitLine.append(go);
      }
    } else if (fit) {
      fitLine.classList.add("is-ok");
      fitLine.textContent = `Every character fits in ${displayEncoding(format.encoding)}.`;
    }

    // Declarations that would contradict the target.
    const contradicting = declarations.filter(
      (declaration) => canonicalDeclared(declaration.declared) !== format.encoding,
    );
    const rewritable = contradicting.filter(
      (declaration) => declarationReplacement(declaration, format.encoding) !== null,
    );
    declarationRow.hidden = rewritable.length === 0;
    if (rewritable.length) {
      const first = rewritable[0];
      const where = lineAndColumn(doc.text, first.from).line;
      const replacement = declarationReplacement(first, format.encoding)!;
      const what =
        first.kind === "inputenc"
          ? "inputenc option"
          : first.kind === "xml"
            ? "XML declaration"
            : "meta charset";
      declarationText.textContent =
        `Also update the ${what} on line ${where}: “${first.declared}” → “${replacement}”` +
        (rewritable.length > 1 ? ` (and ${rewritable.length - 1} more)` : "");
    }

    const notes: string[] = [];
    for (const declaration of contradicting) {
      if (
        declarationReplacement(declaration, format.encoding) === null &&
        declaration.kind === "inputenc"
      ) {
        notes.push(
          `inputenc has no option for ${displayEncoding(format.encoding)}; LaTeX will misread this file while “${declaration.declared}” stays in the preamble.`,
        );
      }
    }
    if (
      doc.language === "latex" &&
      !declarations.some((declaration) => declaration.kind === "inputenc") &&
      !isUnicode(doc.encoding) &&
      format.encoding === "UTF-8"
    ) {
      notes.push(
        "If the preamble — possibly in another file — loads inputenc with a legacy option, change it to utf8, " +
          "and convert the project's other files too, or the compile will misread accents.",
      );
    }
    if (doc.language === "latex" && isUnicode(doc.encoding) && !isUnicode(format.encoding)) {
      notes.push(
        "LaTeX reads UTF-8 by default; a legacy encoding needs a matching \\usepackage[…]{inputenc}.",
      );
    }
    if (doc.language === "typst" && format.encoding !== "UTF-8") {
      notes.push("The Typst compiler reads only UTF-8 source files.");
    }
    if (isUnicode(doc.encoding) && !isUnicode(format.encoding) && doc.language !== "latex") {
      notes.push(
        "Most tools expect UTF-8. Choose a legacy encoding only when a program requires it.",
      );
    }
    if (format.encoding === "UTF-8" && format.hadBom && doc.language === "latex") {
      notes.push("Some older TeX tools print the byte-order mark as stray characters.");
    }
    warnings.replaceChildren(...notes.map((text) => node("li", "", text)));
    warnings.hidden = notes.length === 0;
  }

  function sameAsCurrent(format: SaveFormat): boolean {
    return (
      format.encoding === doc.encoding &&
      format.hadBom === doc.hadBom &&
      format.lineEnding === doc.lineEnding
    );
  }

  function renderConvert(): void {
    const format = targetFormat();
    otherSelect.disabled = !radios.get("other")!.checked;
    renderChecks(format);
    const fits = fit !== "pending" && !(fit && fit.unmappable > 0);
    const unchanged = sameAsCurrent(format);
    const mixed = mixedEndings();
    const parts: string[] = [];
    if (untitled) {
      parts.push(`The first save writes ${formatName(format)}.`);
    } else if (unchanged && mixed > 0) {
      parts.push(
        `Normalises ${mixed.toLocaleString()} mixed line ${mixed === 1 ? "ending" : "endings"} to ${eolName(format.lineEnding)}.`,
      );
    } else if (unchanged) {
      parts.push("The file is already saved in this format.");
    } else {
      parts.push(
        `${formatName({ encoding: doc.encoding, hadBom: doc.hadBom, lineEnding: doc.lineEnding })} → ${formatName(format)}`,
      );
    }
    if (!untitled && doc.dirty) parts.push("Unsaved changes are saved too.");
    if (!untitled && doc.readOnly)
      parts.push("This file is read-only; save a converted copy instead.");
    summary.textContent = parts.join(" ");

    if (tab !== "convert") return;
    copyButton.hidden = untitled;
    copyButton.disabled = !fits;
    primary.textContent = untitled ? "Apply" : "Convert and Save";
    primary.disabled =
      !fits || (!untitled && (doc.readOnly || (unchanged && mixed === 0 && !doc.dirty)));
  }

  function scheduleFit(): void {
    const format = targetFormat();
    window.clearTimeout(fitTimer);
    const request = (fitRequest += 1);
    if (isUnicode(format.encoding)) {
      fit = { unmappable: 0, firstChar: null, firstOffset: null };
      renderConvert();
      return;
    }
    fit = "pending";
    renderConvert();
    fitTimer = window.setTimeout(() => {
      host.fit(format.encoding).then(
        (result) => {
          if (request !== fitRequest || !dialog.isConnected) return;
          fit = result;
          renderConvert();
        },
        () => {
          if (request !== fitRequest || !dialog.isConnected) return;
          fit = null;
          fitLine.textContent = "The character check could not run.";
        },
      );
    }, 120);
  }

  // ---- Reinterpret rendering ----------------------------------------------
  const candidateFor = (label: string): EncodingCandidate | undefined =>
    inspection?.candidates.find((candidate) => candidate.encoding === label);

  function visibleOptions(): HTMLElement[] {
    return [...list.querySelectorAll<HTMLElement>("[role=option]")].filter(
      (option) => !option.hidden,
    );
  }

  function renderList(): void {
    list.replaceChildren();
    if (!inspection) return;
    const suggested = [inspection.detected, doc.encoding].filter(
      (label, index, all): label is string => !!label && all.indexOf(label) === index,
    );
    const groups = [
      { name: "Suggested", labels: suggested },
      ...ENCODING_GROUPS.map((group) => ({
        name: group.name,
        labels: group.encodings
          .map((info) => info.label)
          .filter((label) => !suggested.includes(label)),
      })),
    ];
    for (const group of groups) {
      const block = node("div", "encoding-group");
      block.setAttribute("role", "group");
      const heading = node("div", "encoding-group-name", group.name);
      heading.id = `${id}-group-${group.name.replace(/\W+/g, "-")}`;
      block.setAttribute("aria-labelledby", heading.id);
      block.append(heading);
      let shown = 0;
      for (const label of group.labels) {
        const candidate = candidateFor(label);
        const info = encodingInfo(label);
        const option = node("div", "encoding-option");
        option.id = `${id}-option-${label}`;
        option.setAttribute("role", "option");
        option.dataset.encoding = label;
        option.append(node("span", "encoding-option-name", info?.title ?? label));
        if (label === doc.encoding) option.append(node("span", "encoding-badge", "current"));
        if (label === inspection.detected)
          option.append(node("span", "encoding-badge", "detected"));
        if (!candidate?.valid) {
          option.classList.add("is-invalid");
          option.setAttribute("aria-disabled", "true");
          option.hidden = !showInvalid.checked;
        }
        if (!option.hidden) shown += 1;
        option.addEventListener("click", () => select(label));
        block.append(option);
      }
      block.hidden = shown === 0;
      list.append(block);
    }
    if (!chosen || !visibleOptions().some((option) => option.dataset.encoding === chosen)) {
      chosen = visibleOptions()[0]?.dataset.encoding ?? null;
    }
    markChosen();
  }

  function markChosen(): void {
    for (const option of list.querySelectorAll<HTMLElement>("[role=option]")) {
      const selected = option.dataset.encoding === chosen;
      option.setAttribute("aria-selected", String(selected));
      option.classList.toggle("is-selected", selected);
      if (selected) {
        list.setAttribute("aria-activedescendant", option.id);
        option.scrollIntoView({ block: "nearest" });
      }
    }
    renderPreview();
  }

  function select(label: string): void {
    chosen = label;
    markChosen();
  }

  function renderPreview(): void {
    drawPreview();
    renderReinterpretActions();
  }

  function drawPreview(): void {
    preview.replaceChildren();
    if (!inspection) {
      preview.append(node("p", "encoding-muted", "Reading the file…"));
      return;
    }
    const candidate = chosen ? candidateFor(chosen) : undefined;
    if (!chosen || !candidate) {
      preview.append(node("p", "encoding-muted", "No encoding reads this file cleanly."));
      return;
    }
    preview.append(node("h3", "", `Read as ${encodingInfo(chosen)?.title ?? chosen}`));
    if (!candidate.valid) {
      preview.append(
        node("p", "encoding-fit is-error", candidate.error ?? "Not valid for this file."),
      );
    } else if (candidate.samples.length === 0) {
      preview.append(
        node(
          "p",
          "encoding-muted",
          "This file has no non-ASCII characters; every ASCII-compatible encoding reads it the same way.",
        ),
      );
    } else {
      const lines = doc.text.split("\n");
      const table = node("div", "encoding-samples");
      for (const sample of candidate.samples) {
        const row = node("div", "encoding-sample");
        row.append(node("span", "encoding-sample-line", `Ln ${sample.line}`));
        const texts = node("div", "encoding-sample-texts");
        const now = lines[sample.line - 1] ?? "";
        const shownNow = now.length > 160 ? `${now.slice(0, 160)}…` : now;
        texts.append(node("span", "encoding-sample-new", sample.text));
        if (!doc.dirty && shownNow !== sample.text) {
          texts.append(node("span", "encoding-sample-now", shownNow));
        }
        row.append(texts);
        table.append(row);
      }
      preview.append(table);
      if (doc.dirty) {
        preview.append(
          node(
            "p",
            "encoding-muted",
            "You will be asked about your unsaved changes before reopening.",
          ),
        );
      }
    }
  }

  function renderReinterpretActions(): void {
    if (tab !== "reinterpret") return;
    const candidate = chosen ? candidateFor(chosen) : undefined;
    copyButton.hidden = true;
    primary.textContent = chosen ? `Reopen as ${displayEncoding(chosen)}` : "Reopen";
    primary.disabled =
      !candidate?.valid || (chosen === doc.encoding && inspection?.hadBom === doc.hadBom);
  }

  function setTab(next: "convert" | "reinterpret", focus = false): void {
    tab = next;
    for (const [button, panel, name] of [
      [convertTab, convertPanel, "convert"],
      [reinterpretTab, reinterpretPanel, "reinterpret"],
    ] as const) {
      const active = name === next;
      button.setAttribute("aria-selected", String(active));
      button.tabIndex = active ? 0 : -1;
      panel.hidden = !active;
    }
    if (focus) (next === "convert" ? convertTab : reinterpretTab).focus();
    if (next === "convert") renderConvert();
    else renderPreview();
    renderReinterpretActions();
  }

  // ---- Events -------------------------------------------------------------
  for (const input of radios.values()) input.addEventListener("change", scheduleFit);
  otherSelect.addEventListener("change", () => {
    radios.get("other")!.checked = true;
    scheduleFit();
  });
  // A click on the select must also choose its row.
  otherSelect.addEventListener("focus", () => {
    if (!radios.get("other")!.checked) {
      radios.get("other")!.checked = true;
      scheduleFit();
    }
  });
  for (const input of eolRadios.values()) input.addEventListener("change", renderConvert);
  declarationBox.addEventListener("change", renderConvert);
  showInvalid.addEventListener("change", renderList);

  convertTab.addEventListener("click", () => setTab("convert"));
  reinterpretTab.addEventListener("click", () => setTab("reinterpret"));
  tabs.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    if (untitled) return;
    event.preventDefault();
    setTab(tab === "convert" ? "reinterpret" : "convert", true);
  });

  list.addEventListener("keydown", (event) => {
    const options = visibleOptions();
    if (!options.length) return;
    const index = options.findIndex((option) => option.dataset.encoding === chosen);
    let next: number;
    if (event.key === "ArrowDown") next = Math.min(options.length - 1, index + 1);
    else if (event.key === "ArrowUp") next = Math.max(0, index - 1);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = options.length - 1;
    else if (event.key === "Enter" && !primary.disabled) {
      event.preventDefault();
      primary.click();
      return;
    } else return;
    event.preventDefault();
    select(options[next].dataset.encoding!);
  });

  let settled = false;
  function finish(restoreFocus = true): void {
    if (settled) return;
    settled = true;
    window.clearTimeout(fitTimer);
    fitRequest += 1;
    dialog.close();
    dialog.remove();
    if (!restoreFocus) return;
    const restorable =
      previous instanceof HTMLElement &&
      previous !== document.body &&
      previous !== document.documentElement &&
      previous.isConnected &&
      previous.getClientRects().length > 0;
    if (restorable) previous.focus({ preventScroll: true });
    else host.focusEditor();
  }

  cancel.addEventListener("click", () => finish());
  copyButton.addEventListener("click", () => {
    const format = targetFormat();
    const edits = pendingEdits(format);
    finish(false);
    host.convert(format, true, edits);
  });
  primary.addEventListener("click", () => {
    if (primary.disabled) return;
    if (tab === "reinterpret") {
      if (!chosen) return;
      const label = chosen;
      finish(false);
      host.reopen(label);
      return;
    }
    const format = targetFormat();
    const edits = pendingEdits(format);
    finish(false);
    if (untitled) host.apply(format, edits);
    else host.convert(format, false, edits);
  });
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    finish();
  });
  dialog.addEventListener("close", () => finish());
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) finish();
  });
  // The window accelerator handler runs in the capture phase; the shell's
  // modal guard keeps menu commands out. This keeps the editor's keymaps out.
  dialog.addEventListener("keydown", (event) => event.stopPropagation());

  document.body.append(dialog);
  setTab(tab);
  scheduleFit();
  try {
    dialog.showModal();
  } catch {
    finish();
    return;
  }
  (tab === "reinterpret" ? list : radios.get(initialTarget)!).focus();

  const pending = host.inspect();
  if (!pending) return;
  pending.then(
    (result) => {
      if (!dialog.isConnected) return;
      inspection = result;
      const { crlf, lf, cr } = result.lineEndings;
      const counts = [
        crlf ? `${crlf.toLocaleString()} CRLF` : "",
        lf ? `${lf.toLocaleString()} LF` : "",
        cr ? `${cr.toLocaleString()} CR` : "",
      ].filter(Boolean);
      const mixed = counts.length > 1 || cr > 0;
      disk.textContent =
        "On disk: " +
        (result.detected
          ? `detected ${displayEncoding(result.detected)}${result.hadBom ? " with BOM" : ""}`
          : "no encoding detected") +
        (counts.length ? ` · ${counts.join(", ")}` : " · no line breaks") +
        (mixed ? " — mixed line endings, saving normalises them" : "");
      disk.classList.toggle("is-warning", mixed);
      chosen = doc.encoding !== result.detected && result.detected ? result.detected : doc.encoding;
      renderList();
      renderConvert();
      renderReinterpretActions();
    },
    (error) => {
      if (!dialog.isConnected) return;
      disk.textContent = `Could not read the file: ${String(error)}`;
      disk.classList.add("is-warning");
      preview.replaceChildren(node("p", "encoding-fit is-error", String(error)));
    },
  );
}
