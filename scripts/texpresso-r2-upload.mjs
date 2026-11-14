// Upload the TeXpresso mirror (and the engine files) to a Cloudflare R2 bucket
// with the object layout the application expects:
//
//   texlive/<snapshot>/tt2026/…      the five format and metadata files
//   texlive/<snapshot>/files/…       the bundle files
//   texlive/<snapshot>/SHA256SUMS    (and digests.bin once it exists)
//   engine/<release>/…               the TeXpresso app and engine files
//
// The mirror is uploaded as it lies; no folder needs rearranging. Run it on a
// case-sensitive filesystem (Linux, WSL's own disk): the index has two names
// that differ only by case, and a Windows copy of the mirror loses one.
//
//   export R2_ACCOUNT_ID=…  R2_ACCESS_KEY_ID=…  R2_SECRET_ACCESS_KEY=…
//   node scripts/texpresso-r2-upload.mjs --bucket texpresso \
//     --data ~/github/texpresso/texpresso-mirror-2026 \
//     [--engine <dir with ocaml.js, *.wasm, vendor/…>] \
//     [--snapshot tt2026-2026-11] [--release release-0-133-g454f1bc] \
//     [--concurrency 32] [--dry-run] [--verify] [--force] [--digests-only]
//
//   --dry-run      list what would be uploaded; needs no credentials
//   --verify       upload nothing; compare the bucket with the local files
//   --force        upload even when the bucket already has the key at that size
//   --digests-only upload just texlive/<snapshot>/digests.bin (the one object a
//                  bucket built before the table existed is missing)
//   --self-test    check the request signer against AWS's published example
//
// Resumable: it lists the bucket first and skips keys already there with the
// right size, so an interrupted run is simply started again. Every file is
// hashed before it leaves: the hash must equal the mirror's SHA256SUMS line,
// and it is the signed payload hash, so R2 refuses a body damaged in transit.
// No dependencies; credentials come from the environment only.
import { createHash, createHmac } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const hmac = (key, data) => createHmac("sha256", key).update(data).digest();
/** RFC 3986 encoding as SigV4 wants it; `/` is kept only inside a path. */
const encode = (text, keepSlash = false) =>
  [...Buffer.from(text, "utf8")]
    .map((byte) => {
      const char = String.fromCharCode(byte);
      return /[A-Za-z0-9._~-]/.test(char) || (keepSlash && char === "/")
        ? char
        : "%" + byte.toString(16).toUpperCase().padStart(2, "0");
    })
    .join("");

/** AWS Signature Version 4 for one request; returns the headers to send. */
function sign({
  method,
  host,
  pathname,
  query = {},
  headers = {},
  payloadHash,
  key,
  secret,
  region,
  date,
}) {
  const amzDate = date.toISOString().replace(/[-:]|\.\d{3}/g, "");
  const day = amzDate.slice(0, 8);
  const all = { ...headers, host, "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate };
  const names = Object.keys(all)
    .map((name) => name.toLowerCase())
    .sort();
  const lower = Object.fromEntries(Object.entries(all).map(([k, v]) => [k.toLowerCase(), v]));
  const canonicalQuery = Object.keys(query)
    .sort()
    .map((name) => `${encode(name)}=${encode(String(query[name]))}`)
    .join("&");
  const canonical = [
    method,
    encode(pathname, true),
    canonicalQuery,
    ...names.map((name) => `${name}:${String(lower[name]).trim()}`),
    "",
    names.join(";"),
    payloadHash,
  ].join("\n");
  const scope = `${day}/${region}/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonical)].join("\n");
  const signingKey = hmac(hmac(hmac(hmac("AWS4" + secret, day), region), "s3"), "aws4_request");
  const signature = createHmac("sha256", signingKey).update(toSign).digest("hex");
  const sent = { ...lower };
  delete sent.host;
  sent.authorization = `AWS4-HMAC-SHA256 Credential=${key}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}`;
  return { headers: sent, canonicalQuery, signature };
}

function selfTest() {
  // "Example: GET Object" from the Amazon S3 Signature Version 4 documentation.
  const { signature } = sign({
    method: "GET",
    host: "examplebucket.s3.amazonaws.com",
    pathname: "/test.txt",
    headers: { range: "bytes=0-9" },
    payloadHash: sha256(""),
    key: "AKIAIOSFODNN7EXAMPLE",
    secret: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    region: "us-east-1",
    date: new Date("2013-05-24T00:00:00Z"),
  });
  const expected = "f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41";
  const ok = signature === expected && encode("a b/~é", true) === "a%20b/~%C3%A9";
  console.log(`${ok ? "PASS" : "FAIL"} request signer matches the published example`);
  process.exit(ok ? 0 : 1);
}

const options = {
  bucket: null,
  data: null,
  engine: null,
  snapshot: "tt2026-2026-11",
  release: "release-0-133-g454f1bc",
  concurrency: 32,
};
const flags = new Set();
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 1) {
  const name = args[i].replace(/^--/, "");
  if (["dry-run", "verify", "force", "self-test", "digests-only"].includes(name)) flags.add(name);
  else if (name in options) options[name] = args[++i];
  else throw new Error(`Unknown option ${args[i]}`);
}
if (flags.has("self-test")) selfTest();
if (!options.bucket) throw new Error("--bucket is required.");
if (!options.data && !options.engine)
  throw new Error("Give --data <mirror>, --engine <dir>, or both.");
const concurrency = Math.max(1, Number(options.concurrency) || 32);
const home = (value) =>
  value?.startsWith("~/") ? path.join(process.env.HOME ?? "", value.slice(2)) : value;
const dataRoot = options.data ? path.resolve(home(options.data)) : null;
const engineRoot = options.engine ? path.resolve(home(options.engine)) : null;

const dry = flags.has("dry-run");
const account = process.env.R2_ACCOUNT_ID;
const accessKey = process.env.R2_ACCESS_KEY_ID;
const secretKey = process.env.R2_SECRET_ACCESS_KEY;
if (!dry && !(account && accessKey && secretKey))
  throw new Error(
    "Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY in the environment.",
  );
const host = `${account}.r2.cloudflarestorage.com`;

const TYPES = {
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".wasm": "application/wasm",
  ".lst": "text/plain; charset=utf-8",
  ".deps": "text/plain; charset=utf-8",
};
const IMMUTABLE = "public, max-age=31536000, immutable";

async function walk(root, relative = "") {
  const out = [];
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const next = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await walk(root, next)));
    else if (entry.isFile()) out.push(next);
  }
  return out;
}

/** What to upload: { key, file, sha256? } for every object. */
async function plan() {
  const items = [];
  if (flags.has("digests-only")) {
    if (!dataRoot) throw new Error("--digests-only needs --data <mirror>.");
    const table = path.join(dataRoot, "digests.bin");
    if (!existsSync(table))
      throw new Error(`${table} is missing; run scripts/texpresso-digest-table.mjs first.`);
    const pins = JSON.parse(
      await readFile(new URL("../src-tauri/texpresso.json", import.meta.url), "utf8"),
    );
    return [
      {
        key: `texlive/${options.snapshot}/${pins.digests.path}`,
        file: table,
        sha256: pins.digests.sha256,
        mutable: false,
      },
    ];
  }
  if (dataRoot) {
    const prefix = `texlive/${options.snapshot}/`;
    const sumsPath = path.join(dataRoot, "SHA256SUMS");
    if (!existsSync(sumsPath))
      throw new Error(`${sumsPath} is missing; this is not the verified mirror.`);
    const sums = new Map();
    for (const line of (await readFile(sumsPath, "utf8")).split("\n")) {
      const match = /^([0-9a-f]{64}) [ *](.+)$/.exec(line);
      if (match) sums.set(match[2], match[1]);
    }
    for (const top of ["tt2026", "files"]) {
      if (!existsSync(path.join(dataRoot, top))) throw new Error(`${dataRoot}/${top} is missing.`);
      for (const relative of await walk(dataRoot, top)) {
        const expected = sums.get(relative);
        if (!expected)
          throw new Error(`${relative} is not in SHA256SUMS; refusing to upload an unlisted file.`);
        items.push({
          key: prefix + relative,
          file: path.join(dataRoot, relative),
          sha256: expected,
        });
      }
    }
    const local = new Set(items.map((item) => item.key.slice(prefix.length)));
    const absent = [...sums.keys()].filter((name) => !local.has(name));
    if (absent.length)
      throw new Error(
        `${absent.length} file(s) named by SHA256SUMS are not on disk (first: ${absent[0]}). ` +
          "On a case-insensitive filesystem this is the Cherokee.tfm/cherokee.tfm collision.",
      );
    items.push({ key: prefix + "SHA256SUMS", file: sumsPath, mutable: true });
    const digests = path.join(dataRoot, "digests.bin");
    if (existsSync(digests)) items.push({ key: prefix + "digests.bin", file: digests });
  }
  if (engineRoot) {
    const prefix = `engine/${options.release}/`;
    for (const relative of await walk(engineRoot))
      items.push({ key: prefix + relative, file: path.join(engineRoot, relative) });
  }
  return items;
}

async function request(method, key, { query = {}, headers = {}, body = null, payloadHash } = {}) {
  const pathname = `/${options.bucket}${key ? "/" + key : ""}`;
  const signed = sign({
    method,
    host,
    pathname,
    query,
    headers,
    payloadHash: payloadHash ?? sha256(body ?? ""),
    key: accessKey,
    secret: secretKey,
    region: "auto",
    date: new Date(),
  });
  const url = `https://${host}${encode(pathname, true)}${signed.canonicalQuery ? "?" + signed.canonicalQuery : ""}`;
  return fetch(url, { method, headers: signed.headers, body });
}

async function retry(what, action) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await action();
    } catch (error) {
      if (attempt >= 6 || error.fatal) throw error;
      await new Promise((wake) => setTimeout(wake, 400 * 2 ** attempt));
      process.stderr.write(`\nretry ${attempt} for ${what}: ${error.message}\n`);
    }
  }
}

/** key -> size for everything under a prefix (ListObjectsV2, 1,000 per page). */
async function listBucket(prefix) {
  const found = new Map();
  let token = null;
  do {
    const query = { "list-type": "2", prefix, ...(token ? { "continuation-token": token } : {}) };
    const text = await retry(`list ${prefix}`, async () => {
      const response = await request("GET", "", { query });
      const body = await response.text();
      if (!response.ok) {
        const error = new Error(`listing failed: HTTP ${response.status} ${body.slice(0, 300)}`);
        error.fatal = response.status === 403 || response.status === 404;
        throw error;
      }
      return body;
    });
    const unescape = (value) =>
      value.replace(
        /&(amp|lt|gt|quot|apos);/g,
        (_, n) => ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" })[n],
      );
    for (const match of text.matchAll(
      /<Contents>.*?<Key>(.*?)<\/Key>.*?<Size>(\d+)<\/Size>.*?<\/Contents>/gs,
    ))
      found.set(unescape(match[1]), Number(match[2]));
    token = /<IsTruncated>true<\/IsTruncated>/.test(text)
      ? unescape(/<NextContinuationToken>(.*?)<\/NextContinuationToken>/s.exec(text)?.[1] ?? "")
      : null;
    process.stderr.write(`\rlisting ${prefix} … ${found.size}`);
  } while (token);
  process.stderr.write("\n");
  return found;
}

const megabytes = (bytes) => (bytes / 1048576).toFixed(1) + " MB";

const items = await plan();
const sizes = new Map();
let total = 0;
{
  let next = 0;
  await Promise.all(
    Array.from({ length: 64 }, async () => {
      while (next < items.length) {
        const item = items[next++];
        const size = (await stat(item.file)).size;
        sizes.set(item.key, size);
        total += size;
      }
    }),
  );
}
console.log(`local: ${items.length} objects, ${megabytes(total)}`);
for (const prefix of new Set(items.map((item) => item.key.split("/").slice(0, 2).join("/") + "/")))
  console.log(`  ${prefix}  ${items.filter((item) => item.key.startsWith(prefix)).length} objects`);
if (dry) {
  for (const item of items.slice(0, 5)) console.log(`  e.g. ${item.key}`);
  console.log("dry run: nothing was sent.");
  process.exit(0);
}

const remote = new Map();
for (const prefix of new Set(items.map((item) => item.key.split("/").slice(0, 2).join("/") + "/")))
  for (const [key, size] of await listBucket(prefix)) remote.set(key, size);

if (flags.has("verify")) {
  const missing = items.filter((item) => !remote.has(item.key));
  const wrong = items.filter(
    (item) => remote.has(item.key) && remote.get(item.key) !== sizes.get(item.key),
  );
  const wanted = new Set(items.map((item) => item.key));
  // A digests-only run touches one key; the rest of the prefix is expected.
  const extra = flags.has("digests-only")
    ? []
    : [...remote.keys()].filter((key) => !wanted.has(key));
  console.log(`bucket: ${remote.size} objects under these prefixes`);
  console.log(
    `${missing.length === 0 ? "PASS" : "FAIL"} every local object is in the bucket (${missing.length} missing)`,
  );
  console.log(
    `${wrong.length === 0 ? "PASS" : "FAIL"} every size matches (${wrong.length} differ)`,
  );
  console.log(
    `${extra.length === 0 ? "PASS" : "FAIL"} the bucket holds nothing else under these prefixes (${extra.length} extra)`,
  );
  for (const item of [...missing, ...wrong].slice(0, 10)) console.log(`  ${item.key}`);
  for (const key of extra.slice(0, 10)) console.log(`  extra: ${key}`);
  process.exit(missing.length || wrong.length || extra.length ? 1 : 0);
}

const todo = items.filter(
  (item) => flags.has("force") || item.mutable || remote.get(item.key) !== sizes.get(item.key),
);
const todoBytes = todo.reduce((sum, item) => sum + sizes.get(item.key), 0);
console.log(
  `bucket has ${items.length - todo.length} of them already; uploading ${todo.length} (${megabytes(todoBytes)})`,
);

let done = 0;
let sent = 0;
const failures = [];
const started = Date.now();
const progress = () => {
  const seconds = (Date.now() - started) / 1000;
  process.stderr.write(
    `\r${done}/${todo.length}  ${megabytes(sent)}  ${(done / Math.max(seconds, 1)).toFixed(0)} obj/s  ${failures.length} failed   `,
  );
};
const timer = setInterval(progress, 1000);
let cursor = 0;
await Promise.all(
  Array.from({ length: concurrency }, async () => {
    while (cursor < todo.length) {
      const item = todo[cursor++];
      try {
        const body = await readFile(item.file);
        const hash = sha256(body);
        if (item.sha256 && hash !== item.sha256) {
          const error = new Error("local bytes do not match SHA256SUMS");
          error.fatal = true;
          throw error;
        }
        await retry(item.key, async () => {
          const response = await request("PUT", item.key, {
            body,
            payloadHash: hash,
            headers: {
              "content-type": TYPES[path.extname(item.file)] ?? "application/octet-stream",
              "cache-control": item.mutable ? "no-cache" : IMMUTABLE,
            },
          });
          if (!response.ok) {
            const error = new Error(
              `HTTP ${response.status} ${(await response.text()).slice(0, 200)}`,
            );
            error.fatal = response.status === 403;
            throw error;
          }
          await response.arrayBuffer();
        });
        sent += body.length;
      } catch (error) {
        failures.push(`${item.key}: ${error.message}`);
      }
      done += 1;
    }
  }),
);
clearInterval(timer);
progress();
process.stderr.write("\n");
console.log(
  `uploaded ${done - failures.length} objects, ${megabytes(sent)}, in ${((Date.now() - started) / 1000).toFixed(0)} s`,
);
if (failures.length) {
  console.log(
    `FAIL ${failures.length} object(s) were not uploaded; run the same command again to retry them:`,
  );
  for (const line of failures.slice(0, 20)) console.log(`  ${line}`);
  process.exit(1);
}
console.log(
  "PASS all objects uploaded. Run again with --verify to compare the bucket with the mirror.",
);
