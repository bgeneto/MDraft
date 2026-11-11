//! Preview ownership and the waiting-surface timing policy; no application.
import assert from "node:assert/strict";
import { pathKey } from "../src/sessions.ts";
import {
  covers,
  documentOwner,
  ELAPSED_AFTER_MS,
  ELAPSED_AFTER_REDUCED_MS,
  formatElapsed,
  PENDING_GRACE_MS,
  pendingPhase,
  projectOwner,
} from "../src/preview-owner.ts";

let passed = 0;
function check(label, test) {
  test();
  passed++;
  console.log(`  PASS  ${label}`);
}

const probe = (overrides = {}) => ({
  id: "doc-1",
  incarnation: 3,
  path: "/project/main.tex",
  language: "latex",
  ...overrides,
});

check("the timing policy is the approved one", () => {
  assert.equal(PENDING_GRACE_MS, 150);
  assert.equal(ELAPSED_AFTER_MS, 5000);
  assert.equal(ELAPSED_AFTER_REDUCED_MS, 1000);
});

check("elapsed times never invent a leading zero", () => {
  assert.equal(formatElapsed(0), "0:00");
  assert.equal(formatElapsed(999), "0:00");
  assert.equal(formatElapsed(7000), "0:07");
  assert.equal(formatElapsed(59999), "0:59");
  assert.equal(formatElapsed(60000), "1:00");
  assert.equal(formatElapsed(723000), "12:03");
  assert.equal(formatElapsed(3600000), "60:00");
  assert.equal(formatElapsed(-5000), "0:00");
});

check("no owner covers nothing", () => {
  assert.equal(covers(null, probe()), false);
});

check("a document owner covers only its own id and incarnation", () => {
  const owner = documentOwner({ id: "doc-1", incarnation: 3 });
  assert.equal(covers(owner, probe()), true);
  assert.equal(covers(owner, probe({ incarnation: 4 })), false);
  assert.equal(covers(owner, probe({ id: "doc-2" })), false);
});

check("the startup slot's reused session id does not inherit content", () => {
  const owner = documentOwner({ id: "doc-1", incarnation: 0 });
  assert.equal(covers(owner, probe({ id: "doc-1", incarnation: 1, path: null })), false);
});

check("a project owner covers its root", () => {
  const owner = projectOwner({ id: "doc-1", incarnation: 3 }, [pathKey("/project/main.tex")]);
  assert.equal(covers(owner, probe()), true);
});

check("a project owner covers a member by path key", () => {
  const owner = projectOwner({ id: "doc-1", incarnation: 3 }, [
    pathKey("/project/main.tex"),
    pathKey("/project/chapters/intro.tex"),
  ]);
  assert.equal(covers(owner, probe({ id: "doc-9", path: "/project/chapters/intro.tex" })), true);
  assert.equal(covers(owner, probe({ id: "doc-9", path: "/project/chapters/intro.tex/" })), true);
  assert.equal(covers(owner, probe({ id: "doc-9", path: "/project/other.tex" })), false);
});

check("a project owner does not cover a non-LaTeX member tab", () => {
  const owner = projectOwner({ id: "doc-1", incarnation: 3 }, [
    pathKey("/project/main.tex"),
    pathKey("/project/references.bib"),
  ]);
  assert.equal(
    covers(owner, probe({ id: "doc-9", path: "/project/references.bib", language: "markdown" })),
    false,
  );
});

check("a member with no path is not covered", () => {
  const owner = projectOwner({ id: "doc-1", incarnation: 3 }, [pathKey("/project/main.tex")]);
  assert.equal(covers(owner, probe({ id: "doc-9", path: null })), false);
});

check("a member's path compare follows pathKey case folding", () => {
  const original = navigator.userAgent;
  Object.defineProperty(globalThis, "navigator", {
    value: { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
    configurable: true,
  });
  try {
    const owner = projectOwner({ id: "doc-1", incarnation: 3 }, [
      pathKey("C:\\Project\\Chapter.TEX"),
    ]);
    assert.equal(covers(owner, probe({ id: "doc-9", path: "c:\\project\\chapter.tex" })), true);
  } finally {
    Object.defineProperty(globalThis, "navigator", {
      value: { userAgent: original },
      configurable: true,
    });
  }
});

check("a project owner is itself a copy of its member list", () => {
  const keys = [pathKey("/project/main.tex")];
  const owner = projectOwner({ id: "doc-1", incarnation: 3 }, keys);
  keys.push(pathKey("/project/late.tex"));
  assert.equal(covers(owner, probe({ id: "doc-9", path: "/project/late.tex" })), false);
});

check("the waiting phase names what is being built", () => {
  assert.equal(pendingPhase("markdown"), "Rendering preview…");
  assert.equal(pendingPhase("asciidoc"), "Rendering AsciiDoc…");
  assert.equal(pendingPhase("typst"), "Compiling Typst…");
  assert.equal(pendingPhase("latex"), "Preparing LaTeX compilation…");
  assert.equal(pendingPhase("html"), "");
});
