//! Local scroll geometry and ownership; no application, fonts or network.
import assert from "node:assert/strict";
import {
  ScrollIndex,
  ScrollOwnership,
  chooseScrollRegion,
  clampScroll,
  interpolate,
  mapScrollOffset,
  scrollCorrection,
} from "../src/scroll-sync.ts";
let passed = 0;
function check(label, test) {
  test();
  passed++;
  console.log(`  PASS  ${label}`);
}
const pair = (from, origin, target, region = "left") => ({ from, origin, target, region });
check("local geometry interpolates differing text densities", () =>
  assert.equal(scrollCorrection([pair(0, 100, 200), pair(10, 140, 280)], 120), 120),
);
check("reverse geometry returns the original reading reference", () =>
  assert.equal(scrollCorrection([pair(0, 200, 100), pair(10, 280, 140)], 240), -120),
);
check("a subpixel nudge remains continuous", () =>
  assert.equal(scrollCorrection([pair(0, 100, 200), pair(10, 140, 280)], 120.5), 120.5),
);
check("empty and nonfinite geometry never moves a pane", () => {
  assert.equal(scrollCorrection([], 12), null);
  assert.equal(scrollCorrection([pair(0, NaN, 0)], 12), null);
});
check("an unmapped distant gap holds position", () =>
  assert.equal(scrollCorrection([pair(0, 400, 800)], 12), null),
);
check("an isolated nearby anchor aligns without invented slope", () =>
  assert.equal(scrollCorrection([pair(0, 100, 80)], 110), -20),
);
check("column reset is not interpolated as a forward slope", () =>
  assert.equal(scrollCorrection([pair(0, 100, 800), pair(10, 120, 20, "right")], 111), -100),
);
check("reordered output is not interpolated", () =>
  assert.equal(scrollCorrection([pair(0, 100, 800), pair(10, 120, 20)], 111), -100),
);
check("tied wrapped rows have a stable representative", () =>
  assert.equal(
    scrollCorrection([pair(0, 100, 100), pair(1, 100, 120), pair(2, 100, 140)], 100),
    20,
  ),
);
check("large source discontinuities are bounded", () =>
  assert.equal(scrollCorrection([pair(0, 100, 100), pair(10000, 120, 600)], 109), 0),
);
check("clamps respect both ends and invalid targets", () => {
  assert.equal(clampScroll(-10, 100), 0);
  assert.equal(clampScroll(150, 100), 100);
  assert.equal(clampScroll(Infinity, 100), 0);
  assert.equal(clampScroll(50, -1), 0);
});
check("degenerate interpolation is finite", () =>
  assert.equal(interpolate(20, 10, 10, 50, 90), 50),
);
const anchors = Array.from({ length: 10000 }, (_, i) => ({ from: i * 20, to: i * 20 + 10 }));
const index = new ScrollIndex(anchors);
check("source lookup is bounded around a distant occurrence", () => {
  const near = index.near(150000, 4);
  assert.equal(near.length, 8);
  assert.equal(near[4].from, 150000);
});
check("source lookup never crosses a large unmapped gap", () =>
  assert.equal(new ScrollIndex([{ from: 10000, to: 10010 }]).near(0).length, 0),
);
check("source index does not reorder the caller's array", () => {
  const input = [
    { from: 20, to: 30 },
    { from: 0, to: 10 },
  ];
  new ScrollIndex(input);
  assert.equal(input[0].from, 20);
});
const regions = [
  { key: "1:left", top: 100, bottom: 800, left: 0, right: 250, column: 0 },
  { key: "1:right", top: 100, bottom: 800, left: 300, right: 550, column: 1 },
  { key: "2:left", top: 950, bottom: 1500, left: 0, right: 250, column: 0 },
  { key: "2:right", top: 950, bottom: 1500, left: 300, right: 550, column: 1 },
];
check("initial vertical ambiguity chooses reading order", () =>
  assert.equal(chooseScrollRegion(regions, 200, 700, null), "1:left"),
);
check("an established right column survives ordinary vertical scrolling", () =>
  assert.equal(chooseScrollRegion(regions, 220, 720, "1:right"), "1:right"),
);
check("an explicit gesture can select the other column", () =>
  assert.equal(chooseScrollRegion(regions, 220, 720, "1:left", { x: 400, y: 250 }), "1:right"),
);
check("page transition retains the established column", () =>
  assert.equal(chooseScrollRegion(regions, 950, 1400, "1:right"), "2:right"),
);
check("small boundary changes do not flicker regions", () =>
  assert.equal(chooseScrollRegion(regions, 805, 1300, "1:right"), "1:right"),
);
check("a page with no verified region cannot invent one", () =>
  assert.equal(chooseScrollRegion(regions, 2000, 2500, null), null),
);
const ownership = new ScrollOwnership();
check("reflected scroll does not become user input", () => {
  ownership.wrote("preview", 200, 100);
  assert.equal(ownership.reflected("preview", 200, 110), true);
  assert.equal(ownership.reflected("source", 200, 110), false);
});
check("different programmatic offsets are not mistaken for reflections", () =>
  assert.equal(ownership.reflected("preview", 240, 110), false),
);
check("a genuine gesture hands ownership over immediately", () => {
  const epoch = ownership.epoch;
  ownership.input();
  assert.equal(ownership.epoch, epoch + 1);
  assert.equal(ownership.reflected("preview", 200, 111), false);
});
check("reflection guard expires", () => {
  ownership.wrote("source", 10, 0);
  assert.equal(ownership.reflected("source", 10, 160), false);
});
check("an insertion above the reading point preserves its unchanged identity", () =>
  assert.equal(mapScrollOffset("alpha beta gamma", "new alpha beta gamma", 12), 16),
);
check("an edit below the reading point leaves its identity alone", () =>
  assert.equal(mapScrollOffset("alpha beta gamma", "alpha beta changed", 2), 2),
);
check("a replaced reading point has no safe restoration", () =>
  assert.equal(mapScrollOffset("alpha beta gamma", "alpha another gamma", 8), null),
);
check("unchanged snapshots preserve UTF-16 offsets", () =>
  assert.equal(mapScrollOffset("🚀 café", "🚀 café", 3), 3),
);
console.log(`\n${passed}/${passed} checks passed`);
