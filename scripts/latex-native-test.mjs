// End-to-end check for an installed TeX distribution.
//
//   node scripts/latex-native-test.mjs [port]
//
// Requires MDRAFT_TEST_TEX_BIN to name the directory that holds the engine
// executables (for example a portable MiKTeX `...\miktex\bin\x64`). Without it
// the layer is a skip, so the default suite does not need a TeX installation.
//
// The check drives the real application through Tauri's own command bridge:
// validation probes versions and compiles a probe, the switch selects the
// backend, a compile returns a PDF, and the preview pane commits it. It never
// touches the developer's settings: the isolated test profile owns them.

import { openPage, emitMenu, sleep } from "./cdp-page.mjs";

const port = Number(process.argv[2] ?? 9222);
const directory = process.env.MDRAFT_TEST_TEX_BIN;
const checks = [];
function check(ok, label, detail = "") {
  checks.push({ ok, label, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}

if (!directory) {
  console.log("SKIP installed TeX: MDRAFT_TEST_TEX_BIN is not set");
  process.exit(0);
}

const page = await openPage(port);
const errors = [];
page.onException((text) => errors.push(text));

async function invoke(command, args = {}) {
  const expression = `(async () => {
    try {
      const value = await window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)});
      return { ok: true, value };
    } catch (error) {
      return { ok: false, error: String(error) };
    }
  })()`;
  return page.evaluate(expression);
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await page.evaluate(predicate)) return true;
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${label}`);
}

const validated = await invoke("latex_native_validate", { directory });
check(validated.ok, "validation succeeds", validated.ok ? "" : validated.error);
if (!validated.ok) {
  console.log(`\n${checks.filter((entry) => !entry.ok).length}/${checks.length} checks failed`);
  process.exit(1);
}
check(
  Array.isArray(validated.value.engines) && validated.value.engines.length > 0,
  "engines reported",
  (validated.value.engines ?? []).map((engine) => engine.id).join(", "),
);
check(
  typeof validated.value.bin === "string" && validated.value.bin.length > 0,
  "committed directory",
  validated.value.bin,
);

const enabled = await invoke("latex_native_set_enabled", { enabled: true });
check(enabled.ok, "switch turns native on", enabled.ok ? "" : enabled.error);
const status = await invoke("latex_engine_status");
check(
  status.ok && status.value.backend === "native",
  "engine status selects native",
  status.ok ? status.value.backend : status.error,
);

const source =
  "\\documentclass{article}\n\\begin{document}\nNative integration check.\n\\end{document}\n";
const compiled = await invoke("latex_native_compile", {
  request: {
    job: "integration-1",
    mainFile: "main.tex",
    files: [{ path: "main.tex", data: Buffer.from(source, "utf8").toString("base64") }],
  },
});
check(compiled.ok, "direct compile returns", compiled.ok ? "" : compiled.error);
if (compiled.ok) {
  check(compiled.value.success === true, "compile reports success", compiled.value.error ?? "");
  check(
    typeof compiled.value.pdf === "string" && compiled.value.pdf.length > 0,
    "compile returns a PDF",
    `${compiled.value.pdf?.length ?? 0} base64 chars`,
  );
  check(compiled.value.cancelled === false, "compile was not cancelled");
  check(
    compiled.value.diagnostics.every(
      (entry) => entry.severity === "warning" || entry.severity === "error",
    ),
    "diagnostics are structured",
  );
}

// The preview must commit the native result, not only the command bridge.
await emitMenu(page, "view.latexCompile");
const committed = await waitFor(
  `Boolean(document.querySelector("[data-latex-current]"))`,
  120000,
  "the preview to commit a compiled PDF",
).catch(() => false);
check(committed, "preview commits the native PDF");
check(
  committed
    ? await page.evaluate(
        `document.querySelector(".latex-build-message")?.textContent?.includes("Compiled") === true`,
      )
    : false,
  "preview says it compiled",
);

await invoke("latex_native_set_enabled", { enabled: false });
check(errors.length === 0, "no page exceptions", errors.join(" | "));
page.close();

const failed = checks.filter((entry) => !entry.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length) process.exit(1);
