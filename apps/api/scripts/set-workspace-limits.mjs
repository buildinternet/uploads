#!/usr/bin/env node
/**
 * Patch budget / upload / key-policy limits on an existing workspace registry
 * record. Does not re-mint tokens — only updates limit fields on the KV record.
 *
 * Usage (from apps/api):
 *   node --env-file=../../.env scripts/set-workspace-limits.mjs <name> \
 *     [--max-storage 25GB] \
 *     [--max-uploads-per-month 10000] \
 *     [--max-upload-bytes 25MB] \
 *     [--retention-days 90] \
 *     [--allowed-prefixes default|f,screenshots,gh] \
 *     [--max-key-depth 8] \
 *     [--clear-max-storage] [--clear-max-uploads-per-month] [--clear-max-upload-bytes] \
 *     [--clear-retention-days] [--clear-allowed-prefixes] [--clear-max-key-depth] \
 *     [--local]
 *
 * Units: bare number = bytes (or count for uploads). Also accepts KB/MB/GB
 * and KiB/MiB/GiB (e.g. 1GB, 25MiB). Use 0 or "unlimited" with a --clear-*
 * flag to remove a cap.
 *
 * Key policy: --allowed-prefixes restricts put/sign roots (comma-separated).
 * The sentinel "default" expands to f/, screenshots/, gh/ (CLI layouts).
 * --max-key-depth caps path segments after bare-key governance.
 *
 * Show current limits only:
 *   node scripts/set-workspace-limits.mjs <name> [--local]
 */
import { wranglerKvKey } from "./run-timed.mjs";

const [name, ...rest] = process.argv.slice(2);
const opts = { local: false };
const clears = new Set();

for (let i = 0; i < rest.length; i++) {
  const flag = rest[i];
  if (!flag.startsWith("--")) fail(`unexpected argument: ${flag}`);
  const key = flag.slice(2);
  if (key === "local") {
    opts.local = true;
    continue;
  }
  if (key.startsWith("clear-")) {
    clears.add(key.slice("clear-".length));
    continue;
  }
  opts[key] = rest[++i];
}

function fail(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}

if (!name || !/^[a-z0-9][a-z0-9-]{1,62}$/.test(name)) {
  fail("workspace name must be lowercase alphanumeric/hyphens, 2-63 chars");
}

/** Parse byte sizes: 123, 1KB, 25MiB, 2GB. Returns integer bytes or null (unlimited). */
function parseBytes(raw, label) {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const s = String(raw).trim();
  if (/^(unlimited|none|off)$/i.test(s)) return null;
  const m = /^(\d+(?:\.\d+)?)\s*(b|bytes?|k|kb|kib|m|mb|mib|g|gb|gib)?$/i.exec(s);
  if (!m) fail(`invalid ${label}: ${JSON.stringify(raw)} (try 25MB, 1GiB, or a byte count)`);
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n < 0) fail(`invalid ${label}: ${JSON.stringify(raw)}`);
  const unit = (m[2] || "b").toLowerCase();
  const mult =
    unit === "b" || unit === "byte" || unit === "bytes"
      ? 1
      : unit === "k" || unit === "kb"
        ? 1000
        : unit === "kib"
          ? 1024
          : unit === "m" || unit === "mb"
            ? 1000 ** 2
            : unit === "mib"
              ? 1024 ** 2
              : unit === "g" || unit === "gb"
                ? 1000 ** 3
                : unit === "gib"
                  ? 1024 ** 3
                  : 1;
  return Math.floor(n * mult);
}

/** Parse a positive integer count (uploads per month). */
function parseCount(raw, label) {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const s = String(raw).trim();
  if (/^(unlimited|none|off)$/i.test(s)) return null;
  const n = Number(s);
  if (!Number.isInteger(n) || n < 0) fail(`invalid ${label}: ${JSON.stringify(raw)}`);
  return n === 0 ? null : n;
}

/** Parse depth: positive integer, or null for unlimited. */
function parseDepth(raw, label) {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const s = String(raw).trim();
  if (/^(unlimited|none|off)$/i.test(s)) return null;
  const n = Number(s);
  if (!Number.isInteger(n) || n < 1 || n > 64) {
    fail(`invalid ${label}: ${JSON.stringify(raw)} (use 1–64 or unlimited)`);
  }
  return n;
}

/**
 * Parse allowed key prefixes. Comma-separated list; "default" → f,screenshots,gh.
 * Returns string[] or null (clear).
 */
function parseAllowedPrefixes(raw, label) {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const s = String(raw).trim();
  if (/^(unlimited|none|off)$/i.test(s)) return null;
  const parts = s
    .split(/[,;\s]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) fail(`invalid ${label}: empty list`);
  const out = [];
  for (const part of parts) {
    if (/^default$/i.test(part)) {
      out.push("f", "screenshots", "gh");
      continue;
    }
    const cleaned = part.replace(/^\/+/, "").replace(/\/+$/, "");
    if (!cleaned || cleaned.includes("..") || !/^[\w.!-]+(?:\/[\w.!-]+)*$/.test(cleaned)) {
      fail(`invalid ${label} entry: ${JSON.stringify(part)}`);
    }
    out.push(cleaned);
  }
  return [...new Set(out)];
}

function wranglerKv(args) {
  const [op, key, value] = args;
  return wranglerKvKey({
    op,
    key,
    value,
    local: opts.local,
  });
}

const key = `ws:${name}`;
let raw;
try {
  raw = wranglerKv(["get", key]);
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes("timed out")) {
    fail(
      `wrangler kv get timed out for ${key} (${opts.local ? "local" : "remote"}) — ` +
        `kill orphaned wrangler if memory is climbing (see docs/ops.md#local-wrangler-gotchas)`,
    );
  }
  fail(`workspace not found in REGISTRY: ${key} (${opts.local ? "local" : "remote"})`);
}

let record;
try {
  record = JSON.parse(raw);
} catch {
  fail(`invalid JSON for ${key}`);
}

const before = {
  maxStorageBytes: record.maxStorageBytes,
  maxUploadsPerPeriod: record.maxUploadsPerPeriod,
  maxUploadBytes: record.maxUploadBytes,
  maxVideoUploadBytes: record.maxVideoUploadBytes,
  retentionDays: record.retentionDays,
  allowedKeyPrefixes: record.allowedKeyPrefixes,
  maxKeyDepth: record.maxKeyDepth,
};

const patch = {};
if (clears.has("max-storage") || opts["max-storage"] !== undefined) {
  const v = clears.has("max-storage") ? null : parseBytes(opts["max-storage"], "max-storage");
  patch.maxStorageBytes = v;
}
if (clears.has("max-uploads-per-month") || opts["max-uploads-per-month"] !== undefined) {
  const v = clears.has("max-uploads-per-month")
    ? null
    : parseCount(opts["max-uploads-per-month"], "max-uploads-per-month");
  patch.maxUploadsPerPeriod = v;
}
if (clears.has("max-upload-bytes") || opts["max-upload-bytes"] !== undefined) {
  const v = clears.has("max-upload-bytes")
    ? null
    : parseBytes(opts["max-upload-bytes"], "max-upload-bytes");
  patch.maxUploadBytes = v;
}
if (clears.has("max-video-bytes") || opts["max-video-bytes"] !== undefined) {
  const v = clears.has("max-video-bytes")
    ? null
    : parseBytes(opts["max-video-bytes"], "max-video-bytes");
  patch.maxVideoUploadBytes = v;
}
if (clears.has("retention-days") || opts["retention-days"] !== undefined) {
  const v = clears.has("retention-days")
    ? null
    : parseCount(opts["retention-days"], "retention-days");
  patch.retentionDays = v;
}
if (clears.has("allowed-prefixes") || opts["allowed-prefixes"] !== undefined) {
  const v = clears.has("allowed-prefixes")
    ? null
    : parseAllowedPrefixes(opts["allowed-prefixes"], "allowed-prefixes");
  patch.allowedKeyPrefixes = v;
}
if (clears.has("max-key-depth") || opts["max-key-depth"] !== undefined) {
  const v = clears.has("max-key-depth") ? null : parseDepth(opts["max-key-depth"], "max-key-depth");
  patch.maxKeyDepth = v;
}

const changing = Object.keys(patch).length > 0;
if (!changing) {
  console.log(`workspace : ${name} (${opts.local ? "local" : "remote"})`);
  console.log("limits    :", JSON.stringify(before, null, 2));
  console.log("\nNo flags — nothing updated. Examples:");
  console.log(
    `  node scripts/set-workspace-limits.mjs ${name} --max-storage 25GB --max-uploads-per-month 10000`,
  );
  console.log(
    `  node scripts/set-workspace-limits.mjs ${name} --allowed-prefixes default --max-key-depth 8`,
  );
  console.log(`  node scripts/set-workspace-limits.mjs ${name} --clear-max-storage`);
  process.exit(0);
}

for (const [field, value] of Object.entries(patch)) {
  if (value === null) delete record[field];
  else record[field] = value;
}

try {
  wranglerKv(["put", key, JSON.stringify(record)]);
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes("timed out")) {
    fail(
      `wrangler kv put timed out for ${key} (${opts.local ? "local" : "remote"}) — ` +
        `limits NOT saved; kill orphaned wrangler if memory is climbing ` +
        `(see docs/ops.md#local-wrangler-gotchas)`,
    );
  }
  fail(`wrangler kv put failed for ${key}: ${msg}`);
}

const after = {
  maxStorageBytes: record.maxStorageBytes,
  maxUploadsPerPeriod: record.maxUploadsPerPeriod,
  maxUploadBytes: record.maxUploadBytes,
  maxVideoUploadBytes: record.maxVideoUploadBytes,
  retentionDays: record.retentionDays,
  allowedKeyPrefixes: record.allowedKeyPrefixes,
  maxKeyDepth: record.maxKeyDepth,
};

console.log(`workspace : ${name} (${opts.local ? "local" : "remote"})`);
console.log("before    :", JSON.stringify(before));
console.log("after     :", JSON.stringify(after));
console.log("\nLimits apply on the next request (KV cacheTtl ≈ 60s).");
