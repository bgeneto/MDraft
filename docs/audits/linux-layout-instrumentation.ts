//! Copied into an isolated Linux checkout for the native WebKitGTK probe only.
import { writeDocument } from "./api";

const events: Array<{ at: number; age: number; editor: boolean }> = [];
let controlAt = Infinity;
window.addEventListener(
  "keydown",
  (event) => {
    if (event.key === "ArrowRight") {
      events.push({ at: event.timeStamp, age: performance.now() - event.timeStamp,
        editor: !!(event.target as Element | null)?.closest?.(".cm-content") });
    }
  },
  true,
);

// The runner waits for this marker, then sends control keys while the main
// thread is intentionally blocked. All files are inside the isolated checkout.
window.setTimeout(async () => {
  const root = "/tmp/mdraft-group-native-20261106";
  await writeDocument(`${root}/control-ready.txt`, "ready", "LF", false);
  window.setTimeout(() => {
    controlAt = performance.now();
    const end = controlAt + 350;
    while (performance.now() < end) { /* positive control */ }
    window.setTimeout(async () => {
      const preview = document.getElementById("preview");
      const marker = preview?.textContent?.includes("linuxlayoutmarker") ?? false;
      const groups = preview?.querySelectorAll("[data-audit-group], .md-preview-group").length ?? 0;
      await writeDocument(`${root}/layout-metrics.json`, JSON.stringify({ events, controlAt, marker, groups }), "LF", false);
    }, 2500);
  }, 1200);
}, 15000);
