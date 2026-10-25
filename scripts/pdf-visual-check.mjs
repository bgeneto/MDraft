//! Measure the PDF the application actually produced.
//!
//!     node scripts/pdf-visual-check.mjs --pdf out.pdf --out page-dir --fixture quality
//!
//! Poppler is a test-only dependency. On Windows the tools usually live in a
//! WSL distribution, so `--rasterizer wsl` translates `C:\...` to `/mnt/c/...`
//! and runs the same commands there. Nothing here is bundled with the app.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const argv = process.argv.slice(2);
function option(name, fallback = null) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : fallback;
}
const pdf = option("--pdf");
if (!pdf) {
  console.error(
    "usage: pdf-visual-check.mjs --pdf <file> [--out <dir>] [--fixture quality] [--rasterizer auto|native|wsl]",
  );
  process.exit(2);
}
const out = path.resolve(option("--out", path.join(os.tmpdir(), `mdraft-pdf-check-${Date.now()}`)));
const fixture = option("--fixture", "none");
const requested = option("--rasterizer", "auto");
const expectedPages = Number(option("--pages", "0")) || 0;
const dpi = Number(option("--dpi", "150")) || 150;
const expectations = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--expect" && argv[i + 1]) expectations.push(argv[i + 1]);
}

fs.mkdirSync(out, { recursive: true });

const checks = [];
function check(ok, label, detail = "") {
  checks.push(ok);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}
function fail(label, detail = "") {
  check(false, label, detail);
}

// ---------------------------------------------------------------------------
// Tool discovery and WSL path translation
// ---------------------------------------------------------------------------
function toWslPath(value) {
  const absolute = path.resolve(value);
  const match = /^([A-Za-z]):\\(.*)$/.exec(absolute);
  if (!match) {
    throw new Error(`Cannot translate ${value} for WSL`);
  }
  return `/mnt/${match[1].toLowerCase()}/${match[2].replace(/\\/g, "/")}`;
}
function canRun(command, args) {
  try {
    execFileSync(command, args, { stdio: "ignore" });
    return true;
  } catch (error) {
    return error.status === 0;
  }
}
let rasterizer = requested;
if (rasterizer === "auto") {
  if (canRun("pdfinfo", ["-v"])) rasterizer = "native";
  else if (canRun("wsl.exe", ["-e", "pdfinfo", "-v"])) rasterizer = "wsl";
  else {
    console.error(
      "pdf-visual-check: no Poppler found. Install poppler-utils (Linux/WSL) or put pdfinfo on PATH.",
    );
    process.exit(2);
  }
}
if (rasterizer !== "native" && rasterizer !== "wsl") {
  console.error(`pdf-visual-check: unknown rasterizer ${rasterizer}`);
  process.exit(2);
}
const p = (value) => (rasterizer === "wsl" ? toWslPath(value) : path.resolve(value));
function run(command, args, label) {
  const actual = rasterizer === "wsl" ? ["-e", command, ...args] : args;
  const binary = rasterizer === "wsl" ? "wsl.exe" : command;
  try {
    return execFileSync(binary, actual, {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    throw new Error(`${label ?? command} failed: ${error.stderr || error.message}`);
  }
}
function runBinary(command, args, label) {
  const actual = rasterizer === "wsl" ? ["-e", command, ...args] : args;
  const binary = rasterizer === "wsl" ? "wsl.exe" : command;
  try {
    return execFileSync(binary, actual, {
      maxBuffer: 256 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    throw new Error(`${label ?? command} failed: ${error.stderr || error.message}`);
  }
}

console.log(`PDF visual check: ${pdf}`);
console.log(`  rasterizer: ${rasterizer}${rasterizer === "wsl" ? " (Debian)" : ""}`);
console.log(`  pages: ${out}`);

let text = "";
let pageCount = 0;
let pageSize = null;
let fonts = [];

try {
  const info = run("pdfinfo", [p(pdf)], "pdfinfo");
  pageCount = Number(/^Pages:\s+(\d+)/m.exec(info)?.[1] ?? 0);
  const size = /^Page size:\s+([\d.]+) x ([\d.]+) pts/m.exec(info);
  if (size) pageSize = { width: Number(size[1]), height: Number(size[2]) };
  check(pageCount > 0, "the PDF has pages", `${pageCount}`);
  check(
    pageSize !== null &&
      Math.abs(pageSize.width - 595.28) <= 2 &&
      Math.abs(pageSize.height - 841.89) <= 2,
    "the page is A4",
    pageSize ? `${pageSize.width} x ${pageSize.height} pt` : "missing page size",
  );
  if (expectedPages > 0) {
    check(
      pageCount === expectedPages,
      "the expected page count",
      `${pageCount} of ${expectedPages}`,
    );
  }
  if (fixture === "quality") {
    check(pageCount >= 2, "the quality fixture spans more than one page", `${pageCount}`);
  }

  const table = run("pdffonts", [p(pdf)], "pdffonts");
  fonts = table
    .split("\n")
    .slice(2)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const columns = line.split(/\s+/);
      return { name: columns[0], embedded: columns[4] === "yes" };
    });
  check(fonts.length > 0, "the PDF names its fonts", `${fonts.length}`);
  const notEmbedded = fonts.filter((font) => !font.embedded).map((font) => font.name);
  check(notEmbedded.length === 0, "every font is embedded", notEmbedded.join(", "));
  if (fixture === "quality") {
    check(
      fonts.some((font) => /katex/i.test(font.name)),
      "KaTeX fonts are embedded",
      fonts.map((font) => font.name).join(", "),
    );
  }

  text = run("pdftotext", ["-layout", p(pdf), "-"], "pdftotext");
  check(text.trim().length > 0, "the PDF contains selectable text", `${text.trim().length} chars`);
  if (fixture === "quality") {
    for (const phrase of [
      "PDF Quality Fixture",
      "Quarterly Matrix",
      "Fraction and radical",
      "Selectable prose",
      "Second page marker",
      "Epsilon",
      "Diego",
    ]) {
      check(text.includes(phrase), `the text contains “${phrase}”`);
    }
    check(!text.includes("$$"), "no literal display-math delimiters reached the page");
    check(!/\\[()[\]]/.test(text), "no literal backslash math delimiters reached the page");
  }
  for (const phrase of expectations) {
    check(text.includes(phrase), `the text contains “${phrase}”`);
  }

  const images = run("pdfimages", ["-list", p(pdf)], "pdfimages");
  const imageRows = images
    .split("\n")
    .slice(2)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(/\s+/));
  check(imageRows.length > 0, "the PDF contains a raster image", `${imageRows.length}`);
  if (fixture === "quality") {
    const useful = imageRows.filter((row) => Number(row[3]) > 0 && Number(row[4]) > 0);
    check(useful.length > 0, "the fixture image has real dimensions", JSON.stringify(useful[0]));
  }

  const pngPrefix = path.join(out, "page");
  run("pdftoppm", ["-r", String(dpi), "-png", p(pdf), p(pngPrefix)], "pdftoppm png");
  const pngs = fs
    .readdirSync(out)
    .filter((name) => /^page-\d+\.png$/.test(name))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]))
    .map((name) => path.join(out, name));
  check(pngs.length === pageCount, "one PNG per page", `${pngs.length} of ${pageCount}`);

  const ppmPrefix = path.join(out, "pixels");
  run("pdftoppm", ["-r", String(dpi), p(pdf), p(ppmPrefix)], "pdftoppm ppm");
  const ppms = fs
    .readdirSync(out)
    .filter((name) => /^pixels-\d+\.ppm$/.test(name))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]))
    .map((name) => path.join(out, name));
  check(ppms.length === pageCount, "one PPM per page", `${ppms.length} of ${pageCount}`);

  const pages = ppms.map((file) => parsePpm(fs.readFileSync(file)));
  for (const [index, page] of pages.entries()) {
    const width = Math.round(page.width);
    const height = Math.round(page.height);
    check(
      Math.abs(width - (595.28 / 72) * dpi) <= 4 && Math.abs(height - (841.89 / 72) * dpi) <= 4,
      `page ${index + 1} rasterizes to A4 at ${dpi} dpi`,
      `${width} x ${height} px`,
    );
    const ink = inkFraction(page);
    check(ink > 0.002, `page ${index + 1} is not blank`, `${(ink * 100).toFixed(2)}% ink`);
    const margins = marginWhiteness(page, Math.round(dpi * 0.42));
    check(
      margins.ratio > 0.995,
      `page ${index + 1} keeps its outer margins quiet`,
      `${(margins.ratio * 100).toFixed(2)}% white`,
    );
    const corners = cornerWhiteness(page);
    check(
      corners > 0.995,
      `page ${index + 1} has a light background`,
      `${(corners * 100).toFixed(2)}% white`,
    );
  }

  if (fixture === "quality") {
    const colors = [
      ["red", [229, 57, 53]],
      ["green", [67, 160, 71]],
      ["blue", [30, 136, 229]],
      ["yellow", [253, 216, 53]],
      ["magenta", [255, 0, 255]],
    ];
    for (const [name, rgb] of colors) {
      // Count per page: flatMapping three Buffer objects would flatten their
      // individual bytes, not their RGB triples.
      let count = 0;
      for (const page of pages) count += countNear(page.pixels, rgb, 24);
      check(count > 200, `the ${name} fixture colour is painted`, `${count} px`);
    }
    const lines = pages.reduce((sum, page) => sum + longHorizontalRuns(page), 0);
    check(lines >= 3, "the table's horizontal rules are painted", `${lines} runs`);
    const textPages = text.split("\f");
    const mathPage = textPages.findIndex((page) => page.includes("Fraction and radical"));
    check(mathPage >= 0, "the mathematics page is identifiable");
    if (mathPage >= 0 && pages[mathPage]) {
      const density = inkFraction(pages[mathPage]);
      check(
        density > 0.01,
        "the mathematics page carries visible ink",
        `${(density * 100).toFixed(2)}%`,
      );
    }
  }

  console.log(`  page PNGs:`);
  for (const png of pngs) console.log(`    ${png}`);
  const failures = checks.filter((ok) => !ok).length;
  console.log(`${checks.length - failures}/${checks.length} checks passed`);
  process.exit(failures === 0 ? 0 : 1);
} catch (error) {
  console.error(`  FAIL  ${error.message}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// PPM parsing and pixels
// ---------------------------------------------------------------------------
function parsePpm(buffer) {
  let cursor = 0;
  const token = () => {
    while (cursor < buffer.length && /\s/.test(String.fromCharCode(buffer[cursor]))) cursor++;
    if (buffer[cursor] === 0x23) {
      while (cursor < buffer.length && buffer[cursor] !== 0x0a) cursor++;
      return token();
    }
    const start = cursor;
    while (cursor < buffer.length && !/\s/.test(String.fromCharCode(buffer[cursor]))) cursor++;
    return buffer.subarray(start, cursor).toString("ascii");
  };
  const magic = token();
  if (magic !== "P6") throw new Error(`unsupported PPM magic ${magic}`);
  const width = Number(token());
  const height = Number(token());
  const maximum = Number(token());
  if (!width || !height || maximum !== 255) throw new Error("unsupported PPM header");
  cursor++;
  const pixels = buffer.subarray(cursor);
  if (pixels.length < width * height * 3) throw new Error("truncated PPM data");
  return { width, height, pixels };
}
function inkFraction(page) {
  let ink = 0;
  for (let i = 0; i < page.pixels.length; i += 3) {
    if (!white(page.pixels[i], page.pixels[i + 1], page.pixels[i + 2])) ink++;
  }
  return ink / (page.width * page.height);
}
function white(r, g, b) {
  return r >= 245 && g >= 245 && b >= 245;
}
function marginWhiteness(page, margin) {
  let whitePixels = 0;
  let total = 0;
  const sample = (x, y) => {
    const index = (y * page.width + x) * 3;
    total++;
    if (white(page.pixels[index], page.pixels[index + 1], page.pixels[index + 2])) whitePixels++;
  };
  for (let y = 0; y < margin; y += 2) {
    for (let x = 0; x < page.width; x += 2) {
      sample(x, y);
      sample(x, page.height - 1 - y);
    }
  }
  for (let x = 0; x < margin; x += 2) {
    for (let y = 0; y < page.height; y += 2) {
      sample(x, y);
      sample(page.width - 1 - x, y);
    }
  }
  return { ratio: whitePixels / Math.max(1, total) };
}
function cornerWhiteness(page) {
  const size = 12;
  let whitePixels = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      for (const [px, py] of [
        [x, y],
        [page.width - 1 - x, y],
        [x, page.height - 1 - y],
        [page.width - 1 - x, page.height - 1 - y],
      ]) {
        const index = (py * page.width + px) * 3;
        if (white(page.pixels[index], page.pixels[index + 1], page.pixels[index + 2]))
          whitePixels++;
      }
    }
  }
  return whitePixels / (size * size * 4);
}
function countNear(pixels, [r, g, b], tolerance) {
  let count = 0;
  for (let i = 0; i < pixels.length; i += 3) {
    if (
      Math.abs(pixels[i] - r) <= tolerance &&
      Math.abs(pixels[i + 1] - g) <= tolerance &&
      Math.abs(pixels[i + 2] - b) <= tolerance
    ) {
      count++;
    }
  }
  return count;
}
function longHorizontalRuns(page) {
  const minimum = Math.round(page.width * 0.45);
  let runs = 0;
  for (let y = 0; y < page.height; y++) {
    let current = 0;
    let best = 0;
    for (let x = 0; x < page.width; x++) {
      const index = (y * page.width + x) * 3;
      const dark = (page.pixels[index] + page.pixels[index + 1] + page.pixels[index + 2]) / 3 < 235;
      current = dark ? current + 1 : 0;
      if (current > best) best = current;
    }
    if (best >= minimum) runs++;
  }
  return runs;
}
