// Generates every icon the Tauri bundle needs from one square master PNG.
//
// `tauri icon` keeps the artwork in truecolour, which made this repository's
// icon set weigh 2.4 MB (a 1.2 MB icon.icns and a 661 KB icon.png) for flat
// artwork with three colours. This generator resamples with Lanczos, quantises
// each size to the palette it can actually show, and writes RGBA PNGs for the
// bundle (Tauri's Linux icon loader rejects palette PNGs) plus palette PNGs
// inside the ICNS container where a smaller frame is safe, then wraps them in
// ICO and ICNS. It also writes the 256x256.png and 512x512.png files listed in
// tauri.conf.json, which `tauri icon` no longer emits.
//
//   node scripts/build-icons.mjs [--source docs/icon/mdraft-icon.png]
//                                [--out src-tauri/icons]

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} needs a value`);
  return value;
}

const SOURCE = path.resolve(ROOT, argument("--source", "docs/icon/mdraft-icon.png"));
const OUT = path.resolve(ROOT, argument("--out", "src-tauri/icons"));

// ---------------------------------------------------------------- PNG decode

function decodePng(file) {
  const buf = fs.readFileSync(file);
  if (buf.subarray(1, 4).toString("latin1") !== "PNG") throw new Error(`${file}: not a PNG`);
  let pos = 8;
  let header = null;
  let palette = null;
  let transparency = null;
  const data = [];
  while (pos < buf.length) {
    const length = buf.readUInt32BE(pos);
    const type = buf.subarray(pos + 4, pos + 8).toString("latin1");
    const chunk = buf.subarray(pos + 8, pos + 8 + length);
    if (type === "IHDR") header = chunk;
    else if (type === "PLTE") palette = chunk;
    else if (type === "tRNS") transparency = chunk;
    else if (type === "IDAT") data.push(chunk);
    pos += 12 + length;
  }
  if (!header) throw new Error(`${file}: no IHDR`);
  const width = header.readUInt32BE(0);
  const height = header.readUInt32BE(4);
  const depth = header[8];
  const color = header[9];
  const interlace = header[12];
  if (depth !== 8) throw new Error(`${file}: only 8-bit PNGs are supported (got ${depth})`);
  if (interlace !== 0) throw new Error(`${file}: interlaced PNGs are not supported`);

  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[color];
  if (!channels) throw new Error(`${file}: unsupported colour type ${color}`);

  const raw = zlib.inflateSync(Buffer.concat(data));
  const stride = width * channels;
  const bytes = Buffer.alloc(stride * height);
  let offset = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[offset++];
    const row = raw.subarray(offset, offset + stride);
    offset += stride;
    const current = bytes.subarray(y * stride, (y + 1) * stride);
    const previous = y > 0 ? bytes.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? current[x - channels] : 0;
      const b = previous ? previous[x] : 0;
      const c = previous && x >= channels ? previous[x - channels] : 0;
      let value = row[x];
      if (filter === 1) value += a;
      else if (filter === 2) value += b;
      else if (filter === 3) value += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (filter !== 0) throw new Error(`${file}: bad filter ${filter}`);
      current[x] = value & 255;
    }
  }

  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    let r;
    let g;
    let b;
    let a = 255;
    if (color === 2 || color === 6) {
      r = bytes[i * channels];
      g = bytes[i * channels + 1];
      b = bytes[i * channels + 2];
      if (color === 6) a = bytes[i * channels + 3];
    } else if (color === 0 || color === 4) {
      r = g = b = bytes[i * channels];
      if (color === 4) a = bytes[i * channels + 1];
    } else {
      const index = bytes[i];
      r = palette[index * 3];
      g = palette[index * 3 + 1];
      b = palette[index * 3 + 2];
      if (transparency && index < transparency.length) a = transparency[index];
    }
    rgba[i * 4] = r;
    rgba[i * 4 + 1] = g;
    rgba[i * 4 + 2] = b;
    rgba[i * 4 + 3] = a;
  }
  return { width, height, rgba };
}

// --------------------------------------------------------------- PNG encode

function filterRows(pixels, width, height, bpp, strategy) {
  const stride = width * bpp;
  const out = Buffer.alloc((stride + 1) * height);
  let offset = 0;
  for (let y = 0; y < height; y++) {
    const current = pixels.subarray(y * stride, (y + 1) * stride);
    const previous = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : null;
    let chosen = 0;
    let best = null;
    let bestScore = Infinity;
    const candidates = strategy === "none" ? [0] : [0, 1, 2, 3, 4];
    for (const filter of candidates) {
      const row = Buffer.alloc(stride);
      let score = 0;
      for (let x = 0; x < stride; x++) {
        const a = x >= bpp ? current[x - bpp] : 0;
        const b = previous ? previous[x] : 0;
        const c = previous && x >= bpp ? previous[x - bpp] : 0;
        let value = current[x];
        if (filter === 1) value -= a;
        else if (filter === 2) value -= b;
        else if (filter === 3) value -= (a + b) >> 1;
        else if (filter === 4) {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          value -= pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        }
        row[x] = value & 255;
        score += row[x] > 127 ? 256 - row[x] : row[x];
      }
      if (score < bestScore) {
        bestScore = score;
        best = row;
        chosen = filter;
      }
    }
    out[offset++] = chosen;
    best.copy(out, offset);
    offset += stride;
  }
  return out;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "latin1");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "latin1"), data])), 8 + data.length);
  return out;
}

let crcTable = null;
function crc32(buffer) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buffer.length; i++) crc = crcTable[(crc ^ buffer[i]) & 255] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function encodePng({ width, height, pixels, palette }) {
  const color = palette ? 3 : 6;
  const bpp = palette ? 1 : 4;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = color;
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;

  const chunks = [Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", header)];
  if (palette) {
    const table = Buffer.alloc(palette.length * 3);
    for (let i = 0; i < palette.length; i++) {
      table[i * 3] = palette[i][0];
      table[i * 3 + 1] = palette[i][1];
      table[i * 3 + 2] = palette[i][2];
    }
    chunks.push(chunk("PLTE", table));
  }

  let best = null;
  for (const strategy of ["none", "adaptive"]) {
    const filtered = filterRows(pixels, width, height, bpp, strategy);
    const compressed = zlib.deflateSync(filtered, { level: 9, memLevel: 9 });
    const candidate = Buffer.concat([chunk("IDAT", compressed), chunk("IEND", Buffer.alloc(0))]);
    const bytes = Buffer.concat([...chunks, candidate]);
    if (!best || bytes.length < best.length) best = bytes;
  }
  return best;
}

// ------------------------------------------------------------------ resample

function lanczos(x) {
  if (x === 0) return 1;
  const ax = Math.abs(x);
  if (ax >= 3) return 0;
  const pix = Math.PI * x;
  return (3 * Math.sin(pix) * Math.sin(pix / 3)) / (pix * pix);
}

function weightsFor(sourceSize, targetSize) {
  const scale = targetSize / sourceSize;
  const filterScale = scale < 1 ? 1 / scale : 1;
  const support = 3 * filterScale;
  const result = [];
  for (let i = 0; i < targetSize; i++) {
    const center = (i + 0.5) / scale - 0.5;
    const left = Math.max(0, Math.floor(center - support));
    const right = Math.min(sourceSize - 1, Math.ceil(center + support));
    const taps = [];
    let total = 0;
    for (let j = left; j <= right; j++) {
      const weight = lanczos((j - center) / filterScale);
      if (weight !== 0) {
        taps.push([j, weight]);
        total += weight;
      }
    }
    result.push(taps.map(([j, weight]) => [j, weight / total]));
  }
  return result;
}

function resample({ width, height, rgba }, targetWidth, targetHeight) {
  const horizontalWeights = weightsFor(width, targetWidth);
  const verticalWeights = weightsFor(height, targetHeight);
  const horizontal = new Float32Array(targetWidth * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < targetWidth; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (const [sx, weight] of horizontalWeights[x]) {
        const i = (y * width + sx) * 4;
        r += rgba[i] * weight;
        g += rgba[i + 1] * weight;
        b += rgba[i + 2] * weight;
        a += rgba[i + 3] * weight;
      }
      const o = (y * targetWidth + x) * 4;
      horizontal[o] = r;
      horizontal[o + 1] = g;
      horizontal[o + 2] = b;
      horizontal[o + 3] = a;
    }
  }

  const out = new Uint8Array(targetWidth * targetHeight * 4);
  for (let y = 0; y < targetHeight; y++) {
    for (let x = 0; x < targetWidth; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (const [sy, weight] of verticalWeights[y]) {
        const i = (sy * targetWidth + x) * 4;
        r += horizontal[i] * weight;
        g += horizontal[i + 1] * weight;
        b += horizontal[i + 2] * weight;
        a += horizontal[i + 3] * weight;
      }
      const o = (y * targetWidth + x) * 4;
      out[o] = Math.max(0, Math.min(255, Math.round(r)));
      out[o + 1] = Math.max(0, Math.min(255, Math.round(g)));
      out[o + 2] = Math.max(0, Math.min(255, Math.round(b)));
      out[o + 3] = Math.max(0, Math.min(255, Math.round(a)));
    }
  }
  return { width: targetWidth, height: targetHeight, rgba: out };
}

// --------------------------------------------------------------- quantising

// Builds a palette that keeps both the dominant surfaces and small saturated
// accents. Median cut starved the cyan chevron: the navy/white edge spans the
// full range, so every split went there and the chevron ended up averaged into
// a pale grey box. Greedy farthest-point seeding weighted by pixel count gives
// a distinct colour a place as soon as the neighbouring shades are covered.
function buildPalette({ width, height, rgba }, limit) {
  const buckets = new Map();
  for (let i = 0; i < width * height; i++) {
    const r = rgba[i * 4];
    const g = rgba[i * 4 + 1];
    const b = rgba[i * 4 + 2];
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.r += r;
      bucket.g += g;
      bucket.b += b;
      bucket.count += 1;
    } else {
      buckets.set(key, { r, g, b, count: 1 });
    }
  }
  const candidates = [...buckets.values()].map((bucket) => ({
    r: bucket.r / bucket.count,
    g: bucket.g / bucket.count,
    b: bucket.b / bucket.count,
    count: bucket.count,
  }));
  if (candidates.length <= limit)
    return candidates.map((c) => [Math.round(c.r), Math.round(c.g), Math.round(c.b)]);

  const distance = (a, b) => {
    const dr = a.r - b.r;
    const dg = a.g - b.g;
    const db = a.b - b.b;
    return dr * dr * 2 + dg * dg * 4 + db * db * 3;
  };

  // Seed with the most common bucket, then repeatedly add the bucket that is
  // both frequent and far from everything already chosen.
  const seed = candidates.reduce((best, c) => (c.count > best.count ? c : best), candidates[0]);
  const palette = [{ r: seed.r, g: seed.g, b: seed.b }];
  const nearest = new Float64Array(candidates.length).fill(Infinity);
  for (let i = 0; i < candidates.length; i++) nearest[i] = distance(candidates[i], palette[0]);
  while (palette.length < limit) {
    let pick = -1;
    let bestScore = 0;
    for (let i = 0; i < candidates.length; i++) {
      if (nearest[i] === 0) continue;
      const score = nearest[i] * candidates[i].count;
      if (score > bestScore) {
        bestScore = score;
        pick = i;
      }
    }
    if (pick === -1) break;
    const color = { r: candidates[pick].r, g: candidates[pick].g, b: candidates[pick].b };
    palette.push(color);
    for (let i = 0; i < candidates.length; i++)
      nearest[i] = Math.min(nearest[i], distance(candidates[i], color));
  }

  // A few weighted Lloyd iterations move the seeded colours onto the actual
  // cluster means without letting a single noisy bucket drag a colour away.
  for (let iteration = 0; iteration < 3; iteration++) {
    const sums = palette.map(() => ({ r: 0, g: 0, b: 0, count: 0 }));
    for (const candidate of candidates) {
      let best = 0;
      let bestDistance = Infinity;
      for (let p = 0; p < palette.length; p++) {
        const d = distance(candidate, palette[p]);
        if (d < bestDistance) {
          bestDistance = d;
          best = p;
        }
      }
      const sum = sums[best];
      sum.r += candidate.r * candidate.count;
      sum.g += candidate.g * candidate.count;
      sum.b += candidate.b * candidate.count;
      sum.count += candidate.count;
    }
    for (let p = 0; p < palette.length; p++) {
      if (sums[p].count === 0) continue;
      palette[p] = {
        r: sums[p].r / sums[p].count,
        g: sums[p].g / sums[p].count,
        b: sums[p].b / sums[p].count,
      };
    }
  }

  return palette.map((c) => [Math.round(c.r), Math.round(c.g), Math.round(c.b)]);
}

function quantise({ width, height, rgba }, limit) {
  const palette = buildPalette({ width, height, rgba }, limit);
  const cache = new Int16Array(32768).fill(-1);
  const indices = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const r = rgba[i * 4];
    const g = rgba[i * 4 + 1];
    const b = rgba[i * 4 + 2];
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    let index = cache[key];
    if (index === -1) {
      let best = 0;
      let bestDistance = Infinity;
      for (let p = 0; p < palette.length; p++) {
        const dr = r - palette[p][0];
        const dg = g - palette[p][1];
        const db = b - palette[p][2];
        const distance = dr * dr * 2 + dg * dg * 4 + db * db * 3;
        if (distance < bestDistance) {
          bestDistance = distance;
          best = p;
        }
      }
      index = best;
      cache[key] = index;
    }
    indices[i] = index;
  }
  return { width, height, indices, palette };
}

function paletteLimit(size) {
  if (size <= 24) return 32;
  if (size <= 48) return 64;
  if (size <= 64) return 80;
  if (size <= 128) return 112;
  if (size <= 256) return 144;
  return 176;
}

function palettePng(image) {
  const quantised = quantise(image, paletteLimit(Math.max(image.width, image.height)));
  return encodePng({
    width: quantised.width,
    height: quantised.height,
    pixels: quantised.indices,
    palette: quantised.palette,
  });
}

function rgbaPng(image) {
  const quantised = quantise(image, paletteLimit(Math.max(image.width, image.height)));
  const pixels = new Uint8Array(image.width * image.height * 4);
  for (let i = 0; i < image.width * image.height; i++) {
    const color = quantised.palette[quantised.indices[i]];
    pixels[i * 4] = color[0];
    pixels[i * 4 + 1] = color[1];
    pixels[i * 4 + 2] = color[2];
    pixels[i * 4 + 3] = 255;
  }
  return encodePng({ width: image.width, height: image.height, pixels });
}

// ---------------------------------------------------------------- containers

function buildIco(frames) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(frames.length, 4);
  const directory = Buffer.alloc(16 * frames.length);
  let offset = header.length + directory.length;
  frames.forEach((frame, index) => {
    const entry = index * 16;
    directory[entry] = frame.size >= 256 ? 0 : frame.size;
    directory[entry + 1] = frame.size >= 256 ? 0 : frame.size;
    directory[entry + 2] = 0;
    directory[entry + 3] = 0;
    directory.writeUInt16LE(1, entry + 4);
    directory.writeUInt16LE(32, entry + 6);
    directory.writeUInt32LE(frame.data.length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += frame.data.length;
  });
  return Buffer.concat([header, directory, ...frames.map((frame) => frame.data)]);
}

function buildIcns(frames) {
  const chunks = frames.map((frame) => {
    const data = Buffer.alloc(8 + frame.data.length);
    data.write(frame.type, 0, "latin1");
    data.writeUInt32BE(data.length, 4);
    frame.data.copy(data, 8);
    return data;
  });
  const total = 8 + chunks.reduce((sum, item) => sum + item.length, 0);
  const header = Buffer.alloc(8);
  header.write("icns", 0, "latin1");
  header.writeUInt32BE(total, 4);
  return Buffer.concat([header, ...chunks]);
}

// --------------------------------------------------------------------- main

const master = decodePng(SOURCE);
if (master.width !== master.height) throw new Error(`${SOURCE}: the master must be square`);
console.log(`master ${master.width}x${master.height} ${fs.statSync(SOURCE).size} bytes`);

const cache = new Map();
function sized(size) {
  if (!cache.has(size)) cache.set(size, resample(master, size, size));
  return cache.get(size);
}

fs.mkdirSync(OUT, { recursive: true });

const written = [];
function write(name, data) {
  const file = path.join(OUT, name);
  fs.writeFileSync(file, data);
  written.push([name, data.length]);
}

// Bundle PNGs. 256x256.png and 512x512.png are listed in tauri.conf.json even
// though `tauri icon` stopped emitting them.
// Tauri's Linux `generate_context!` reads these as RGBA and refuses an
// indexed PNG (`icon ... is not RGBA`), so every bundle PNG is colour type 6.
for (const size of [32, 64, 128, 256, 512]) {
  write(`${size}x${size}.png`, rgbaPng(sized(size)));
}
write("128x128@2x.png", rgbaPng(sized(256)));
write("icon.png", rgbaPng(sized(1024)));

// Windows Store logos.
for (const size of [30, 44, 71, 89, 107, 142, 150, 284, 310]) {
  write(`Square${size}x${size}Logo.png`, rgbaPng(sized(size)));
}
write("StoreLogo.png", rgbaPng(sized(50)));

// Windows .ico: 32-bit frames, so the shell blends the edges correctly.
const icoFrames = [16, 24, 32, 48, 64, 128, 256].map((size) => ({
  size,
  data: rgbaPng(sized(size)),
}));
write("icon.ico", buildIco(icoFrames));

// macOS .icns. Duplicate pixel sizes are intentional: each type names a
// logical size, and Retina picks the @2x one.
const icnsFrames = [
  ["icp4", 16],
  ["icp5", 32],
  ["icp6", 64],
  ["ic07", 128],
  ["ic08", 256],
  ["ic09", 512],
  ["ic10", 1024],
  ["ic11", 32],
  ["ic12", 64],
  ["ic13", 256],
  ["ic14", 512],
].map(([type, size]) => ({
  type,
  // The legacy 16/32/64 slots predate PNG-in-ICNS and expect 32-bit data;
  // every modern slot is happy with the smaller palette PNG.
  data: type.startsWith("icp") ? rgbaPng(sized(size)) : palettePng(sized(size)),
}));
write("icon.icns", buildIcns(icnsFrames));

let total = 0;
for (const [name, length] of written) {
  total += length;
  console.log(`  ${name.padEnd(24)} ${String(length).padStart(8)} bytes`);
}
console.log(`total ${written.length} files, ${total} bytes`);
