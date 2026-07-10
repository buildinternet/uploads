#!/usr/bin/env node

import { randomUUID } from "node:crypto";

const args = new Set(process.argv.slice(2));
const lifecycle = args.has("--lifecycle");
const apiUrl = (process.env.UPLOADS_API_URL ?? "https://api.uploads.sh").replace(/\/$/, "");
const workspace = process.env.UPLOADS_WORKSPACE ?? "default";
const token = process.env.UPLOADS_TOKEN;

if (args.has("--help")) {
  process.stdout.write(`uploads API contract smoke test

Usage:
  node scripts/smoke-contract.mjs
  UPLOADS_TOKEN=... node scripts/smoke-contract.mjs --lifecycle

Environment:
  UPLOADS_API_URL    API base (default: https://api.uploads.sh)
  UPLOADS_WORKSPACE  workspace (default: default)
  UPLOADS_TOKEN      required only for --lifecycle

The default check is read-only. --lifecycle uploads a unique test object,
verifies metadata/listing/public bytes, and deletes it in a finally block.
The token is read only from the environment so it does not appear in argv.
`);
  process.exit(0);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function request(path, init, expected) {
  const response = await fetch(`${apiUrl}${path}`, init);
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    throw new Error(`${init?.method ?? "GET"} ${path}: expected JSON, got ${text.slice(0, 120)}`);
  }
  if (!expected.includes(response.status)) {
    throw new Error(
      `${init?.method ?? "GET"} ${path}: expected ${expected.join("/")}, got ${response.status}: ${text}`,
    );
  }
  return { body };
}

const health = await request("/health", undefined, [200]);
assert(health.body?.ok === true, "GET /health did not return { ok: true }");
process.stdout.write(`ok health ${apiUrl}\n`);

if (!lifecycle) {
  process.stdout.write("ok read-only contract (use --lifecycle for upload verification)\n");
  process.exit(0);
}

assert(token, "UPLOADS_TOKEN is required with --lifecycle");

const key = `contract-smoke/${new Date().toISOString().slice(0, 10)}/${randomUUID()}.txt`;
const filePath = `/v1/${encodeURIComponent(workspace)}/files/${key}`;
const bytes = new TextEncoder().encode(`uploads contract smoke ${randomUUID()}\n`);
const auth = { Authorization: `Bearer ${token}` };
let uploaded = false;

try {
  const put = await request(
    filePath,
    {
      method: "PUT",
      headers: { ...auth, "Content-Type": "text/plain; charset=utf-8" },
      body: bytes,
    },
    [201],
  );
  uploaded = true;
  assert(put.body?.workspace === workspace, "upload returned the wrong workspace");
  assert(put.body?.key === key, "upload returned the wrong key");
  assert(put.body?.size === bytes.byteLength, "upload returned the wrong size");
  assert(
    typeof put.body?.url === "string" && put.body.url.length > 0,
    "upload returned no public URL",
  );
  process.stdout.write("ok upload\n");

  const metadata = await request(filePath, { headers: auth }, [200]);
  assert(metadata.body?.url === put.body.url, "metadata URL differs from upload URL");
  process.stdout.write("ok metadata\n");

  const list = await request(
    `/v1/${encodeURIComponent(workspace)}/files?prefix=${encodeURIComponent(key)}&limit=10`,
    { headers: auth },
    [200],
  );
  assert(Array.isArray(list.body?.items), "list response has no items array");
  assert(
    list.body.items.some((item) => item.key === key),
    "uploaded key is absent from list",
  );
  process.stdout.write("ok list\n");

  const publicResponse = await fetch(put.body.url, { cache: "no-store" });
  assert(publicResponse.ok, `public URL returned ${publicResponse.status}`);
  const publicBytes = new Uint8Array(await publicResponse.arrayBuffer());
  assert(
    Buffer.from(publicBytes).equals(Buffer.from(bytes)),
    "public URL bytes differ from upload",
  );
  assert(
    publicResponse.headers.get("content-type")?.startsWith("text/plain"),
    "public URL has the wrong Content-Type",
  );
  process.stdout.write("ok public bytes\n");
} finally {
  if (uploaded) {
    await request(filePath, { method: "DELETE", headers: auth }, [200]);
    await request(filePath, { headers: auth }, [404]);
    process.stdout.write("ok delete\n");
  }
}

process.stdout.write("ok lifecycle contract\n");
