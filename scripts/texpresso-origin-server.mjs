// A local stand-in for the TeXpresso origin (the future R2 bucket).
//
// Serves directories under URL prefixes with the object layout and headers the
// bucket will have, so the application differs between this server and
// production by one string: `texpresso.origin` in src-tauri/latex-engine.json.
//
//   node scripts/texpresso-origin-server.mjs \
//     --mount /texlive/tt2026-2026-11/=<mirror> \
//     --mount /engine/=<engine dir> [--port 8717] [--record <file>]
//     [--latency <ms>] [--fail <substring>=<status>] [--corrupt <substring>]
//     [--truncate <substring>]
//
// Several --mount options may name the same prefix: the directories are tried
// in order. That is how a file lost to a case collision is supplied from a
// second folder without touching the first (see the trap in
// CONTRIBUTING.md).
//
// No dependencies, loopback only, read-only, GET and HEAD.
import { createServer } from "node:http";
import { createReadStream, appendFileSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";

const args = process.argv.slice(2);
const mounts = [];
const fail = [];
const corrupt = [];
const truncate = [];
let port = 8717;
let record = null;
let latency = 0;
for (let i = 0; i < args.length; i += 1) {
  const value = args[i + 1];
  switch (args[i]) {
    case "--mount": {
      const at = value.indexOf("=");
      const prefix = value.slice(0, at);
      if (at < 1 || !prefix.startsWith("/") || !prefix.endsWith("/"))
        throw new Error(`--mount needs /prefix/=directory, got ${value}`);
      mounts.push({ prefix, root: path.resolve(value.slice(at + 1)) });
      i += 1;
      break;
    }
    case "--port":
      port = Number(value);
      i += 1;
      break;
    case "--record":
      record = path.resolve(value);
      i += 1;
      break;
    case "--latency":
      latency = Number(value);
      i += 1;
      break;
    case "--fail": {
      const at = value.lastIndexOf("=");
      fail.push({ match: value.slice(0, at), status: Number(value.slice(at + 1)) });
      i += 1;
      break;
    }
    case "--corrupt":
      corrupt.push(value);
      i += 1;
      break;
    case "--truncate":
      truncate.push(value);
      i += 1;
      break;
    default:
      throw new Error(`Unknown option ${args[i]}`);
  }
}
if (mounts.length === 0) throw new Error("At least one --mount /prefix/=directory is required.");
// Longest prefix first, keeping the order given among equal prefixes.
mounts.sort((a, b) => b.prefix.length - a.prefix.length);

const TYPES = {
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".wasm": "application/wasm",
  ".lst": "text/plain; charset=utf-8",
  ".deps": "text/plain; charset=utf-8",
};

// NTFS answers `Cherokee.tfm~h` for a request that says `cherokee.tfm~h`. The
// bucket would not, so a name counts only when the directory lists it exactly.
const listings = new Map();
async function listed(directory, name) {
  let names = listings.get(directory);
  if (!names) {
    names = readdir(directory).then(
      (entries) => new Set(entries),
      () => new Set(),
    );
    listings.set(directory, names);
  }
  return (await names).has(name);
}

async function resolve(pathname) {
  for (const { prefix, root } of mounts) {
    if (!pathname.startsWith(prefix)) continue;
    const parts = pathname.slice(prefix.length).split("/");
    if (parts.some((part) => part === "" || part === "." || part === ".." || part.includes("\\")))
      return null;
    let current = root;
    let found = true;
    for (const part of parts) {
      if (!(await listed(current, part))) {
        found = false;
        break;
      }
      current = path.join(current, part);
    }
    if (!found) continue;
    const info = await stat(current).catch(() => null);
    if (info?.isFile()) return { file: current, info };
  }
  return null;
}

const seen = new Set();
let served = 0;
let bytes = 0;

const server = createServer(async (request, response) => {
  const done = (status, body = "") => {
    response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
    response.end(request.method === "HEAD" ? "" : body);
  };
  try {
    if (request.method !== "GET" && request.method !== "HEAD") return done(405, "GET or HEAD");
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    } catch {
      return done(400, "Bad path");
    }
    if (latency > 0) await new Promise((wake) => setTimeout(wake, latency));
    const failing = fail.find((rule) => pathname.includes(rule.match));
    if (failing) return done(failing.status, "Injected failure");
    const hit = await resolve(pathname);
    if (!hit) return done(404, "Not found");
    if (record && !seen.has(pathname)) {
      seen.add(pathname);
      appendFileSync(record, pathname + "\n");
    }
    const size = hit.info.size;
    const headers = {
      "Content-Type": TYPES[path.extname(hit.file)] ?? "application/octet-stream",
      "Cache-Control": "public, max-age=31536000, immutable",
      ETag: `"${size.toString(16)}-${Math.round(hit.info.mtimeMs).toString(16)}"`,
      "Accept-Ranges": "bytes",
      "Access-Control-Allow-Origin": "*",
    };
    let start = 0;
    let end = size - 1;
    const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range ?? "");
    if (range && (range[1] || range[2])) {
      if (range[1]) {
        start = Number(range[1]);
        if (range[2]) end = Math.min(end, Number(range[2]));
      } else start = Math.max(0, size - Number(range[2]));
      if (start > end || start >= size) {
        response.writeHead(416, { "Content-Range": `bytes */${size}` });
        return response.end();
      }
      headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
    }
    const cut = truncate.some((match) => pathname.includes(match));
    if (cut) end = Math.max(start, Math.floor((start + end) / 2));
    headers["Content-Length"] = cut ? size : end - start + 1;
    response.writeHead(headers["Content-Range"] ? 206 : 200, headers);
    if (request.method === "HEAD" || size === 0) return response.end();
    served += 1;
    bytes += end - start + 1;
    const stream = createReadStream(hit.file, { start, end });
    if (corrupt.some((match) => pathname.includes(match))) {
      let first = true;
      stream.on("data", (chunk) => {
        if (first) {
          chunk[0] ^= 0xff;
          first = false;
        }
        response.write(chunk);
      });
      stream.on("end", () => response.end());
    } else if (cut) {
      // Fewer bytes than Content-Length promised, then a closed socket.
      stream.on("data", (chunk) => response.write(chunk));
      stream.on("end", () => response.destroy());
    } else stream.pipe(response);
    stream.on("error", () => response.destroy());
  } catch (error) {
    if (!response.headersSent) done(500, String(error));
    else response.destroy();
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`texpresso origin: http://127.0.0.1:${port}/`);
  for (const { prefix, root } of mounts) console.log(`  ${prefix} -> ${root}`);
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    console.log(`served ${served} files, ${bytes} bytes`);
    server.close(() => process.exit(0));
  });
}
