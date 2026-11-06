//! Synthetic renderer cost only; this does not measure filesystem or UI latency.
import { performance } from "node:perf_hooks";
import { renderChunks } from "../../src/preview-render.ts";

const variants = {
  ordinary: (i) => `![image ${i}](images/picture-${i}.png)`,
  escaped: (i) => `![image ${i}](C:\\\\images\\\\picture-${i}.png)`,
  legacy: (i) => `![image ${i}](C:\\images\\.hidden\\picture-${i}.png)`,
};
for (const [name, image] of Object.entries(variants)) {
  const source = Array.from({ length: 10000 }, (_, i) => image(i)).join("\n\n");
  const samples = [];
  let candidates = 0;
  for (let run = 0; run < 4; run++) {
    const start = performance.now();
    const result = renderChunks(source, { map: false, math: false });
    const elapsed = performance.now() - start;
    candidates = Object.keys(result.legacyImages ?? {}).length;
    if (run > 0) samples.push(elapsed);
  }
  console.log(JSON.stringify({ name, count: 10000, candidates, milliseconds: samples }));
}
