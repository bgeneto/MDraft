// Unit tests for the export path/URL policy.
//
//   node scripts/export-paths-unit.mjs
//
// No application and no build: `src/export-paths.ts` has no runtime imports, so
// Node 24 strips its types. Every case is a path a browser must be able to load
// after the document leaves MDraft.

import {
  fileUrl,
  isLocalReference,
  publicationUrl,
  relativeUrl,
  resolveLocalPath,
  splitSuffix,
} from "../src/export-paths.ts";

const checks = [];
function check(ok, label, detail = "") {
  checks.push({ ok, label, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}
const equal = (actual, expected, label) =>
  check(actual === expected, label, actual === expected ? "" : `got ${actual}, want ${expected}`);

const target = (documentDir, outputDir, absolute = false) => ({
  documentDir,
  outputDir,
  absolute,
});

// ---------------------------------------------------------------------------
console.log("=== what counts as a local reference ===");
{
  check(isLocalReference("html-tour/image.png"), "a relative path is local");
  check(isLocalReference("C:\\Pictures\\a.png"), "a drive path is local");
  check(isLocalReference("C:/Pictures/a.png"), "a slash drive path is local");
  check(isLocalReference("\\\\server\\share\\a.png"), "a UNC path is local");
  check(isLocalReference("/home/me/a.png"), "a POSIX absolute path is local");
  check(isLocalReference("file:///C:/a.png"), "a file URL is local");
  check(!isLocalReference("https://example.com/a.png"), "https is remote");
  check(!isLocalReference("data:image/png;base64,AAAA"), "data is not a file");
  check(!isLocalReference("#details"), "a fragment is not a file");
  check(!isLocalReference("mailto:me@example.com"), "mailto is not a file");
  check(!isLocalReference("asset://localhost/x.png"), "the app protocol is not a file");
  check(!isLocalReference("//cdn.example.com/a.png"), "protocol-relative is remote");
}

console.log("\n=== suffix and resolution ===");
{
  const suffix = splitSuffix("image.png?raw=1#top");
  equal(suffix.path, "image.png", "the query and fragment are separated");
  equal(suffix.suffix, "?raw=1#top", "the suffix is preserved");
  equal(
    resolveLocalPath("./image.png", "C:\\docs"),
    "C:/docs/image.png",
    "a dot-relative path resolves beside the document",
  );
  equal(
    resolveLocalPath("../images/a b.png", "C:\\docs\\notes"),
    "C:/docs/images/a b.png",
    "a parent component cancels the document folder",
  );
  equal(
    resolveLocalPath("C:\\Pictures\\a.png", "C:\\docs"),
    "C:/Pictures/a.png",
    "an absolute drive path is not joined to the document",
  );
  equal(
    resolveLocalPath("/home/me/a.png", "C:\\docs"),
    "/home/me/a.png",
    "a POSIX absolute path is not joined",
  );
  equal(
    resolveLocalPath("file:///C:/My%20Pictures/a.png", null),
    "C:/My Pictures/a.png",
    "a file URL decodes its path",
  );
  equal(
    resolveLocalPath("\\\\server\\share\\dir\\a.png", null),
    "//server/share/dir/a.png",
    "a UNC path keeps its server and share",
  );
}

console.log("\n=== file URLs ===");
{
  equal(
    fileUrl("C:\\My Pictures\\ação.png"),
    "file:///C:/My%20Pictures/a%C3%A7%C3%A3o.png",
    "a drive path encodes spaces and Unicode",
  );
  equal(
    fileUrl("/home/me/a b.png"),
    "file:///home/me/a%20b.png",
    "a POSIX path encodes its spaces",
  );
  equal(
    fileUrl("\\\\server\\share\\dir\\a b.png"),
    "file://server/share/dir/a%20b.png",
    "a UNC path becomes a host URL",
  );
}

console.log("\n=== relative URLs ===");
{
  equal(relativeUrl("C:\\docs", "C:\\docs\\a.png"), "a.png", "a child file is a bare name");
  equal(relativeUrl("C:\\docs\\sub", "C:\\docs\\a.png"), "../a.png", "a sibling needs one parent");
  equal(relativeUrl("C:\\docs", "D:\\a.png"), null, "different volumes cannot be relative");
  equal(
    relativeUrl("C:\\Docs", "c:\\docs\\A.png"),
    "A.png",
    "the Windows comparison folds case but keeps the target spelling",
  );
  equal(relativeUrl("/home/me/docs", "/home/me/a.png"), "../a.png", "POSIX relative paths work");
  equal(
    relativeUrl("//server/share/docs", "//server/share/a.png"),
    "../a.png",
    "a UNC share is one root",
  );
}

console.log("\n=== publication policy ===");
{
  equal(
    publicationUrl("html-tour/image.png", target("C:\\repo\\samples", "C:\\repo\\out", false)),
    "../samples/html-tour/image.png",
    "an export beside the document stays relative",
  );
  equal(
    publicationUrl("html-tour/image.png", target("C:/repo/samples", "T:/out", false)),
    "file:///C:/repo/samples/html-tour/image.png",
    "a different volume falls back to a file URL",
  );
  equal(
    publicationUrl("html-tour/image.png", target("C:/repo/samples", null, true)),
    "file:///C:/repo/samples/html-tour/image.png",
    "print always uses an absolute file URL",
  );
  equal(
    publicationUrl("https://example.com/a?b#c", target("C:/repo", "C:/out")),
    "https://example.com/a?b#c",
    "a remote destination is untouched",
  );
  equal(
    publicationUrl("#details", target("C:/repo", "C:/out")),
    "#details",
    "an in-page heading stays in the page",
  );
  equal(
    publicationUrl("data:image/png;base64,AAAA", target("C:/repo", "C:/out")),
    "data:image/png;base64,AAAA",
    "a data URL is untouched",
  );
  equal(
    publicationUrl("//cdn.example.com/a.png", target("C:/repo", "C:/out")),
    "https://cdn.example.com/a.png",
    "a protocol-relative image becomes an explicit network URL",
  );
  equal(
    publicationUrl("file:///C:/repo/image.png", target("C:/repo/docs", "C:/repo/out")),
    "../image.png",
    "an existing file URL is rebased like a path",
  );
  equal(
    publicationUrl("feature-tour.md", target("C:/repo/samples", "C:/repo/samples/out")),
    "../feature-tour.md",
    "a local document link keeps its destination",
  );
  equal(
    publicationUrl("img/a%20b.png", target("C:/repo/samples", "C:/repo/out", false)),
    "../samples/img/a%20b.png",
    "an encoded space is decoded, resolved and encoded once",
  );
  equal(
    publicationUrl("../img/a.png#figure", target("C:/repo/samples", "C:/repo/out", false)),
    "../img/a.png#figure",
    "a fragment survives the rewrite",
  );
  equal(
    publicationUrl("img/a.png", target(null, "C:/out", false)),
    "img/a.png",
    "an untitled document has no folder to resolve against",
  );
  equal(
    publicationUrl("C:\\repo\\image.png", target("C:/repo/docs", "C:/repo/out", false)),
    "../image.png",
    "a drive path is rebased against the output folder",
  );
}

equal(
  new URL(
    publicationUrl("//cdn.example.com/a.png", target("C:/repo", null, true)),
    "file:///C:/temp/print.html",
  ).href,
  "https://cdn.example.com/a.png",
  "a network image still resolves to HTTPS from the print file origin",
);
equal(
  publicationUrl("\\\\server\\share\\a.png", target("C:/repo", null, true)),
  "file://server/share/a.png",
  "a backslash UNC image retains its filesystem meaning",
);

console.log(`\n${checks.filter((c) => c.ok).length}/${checks.length} checks passed`);
process.exit(checks.every((c) => c.ok) ? 0 : 1);
