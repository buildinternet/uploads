#!/usr/bin/env node
/**
 * Patch budget / upload limits on an existing workspace registry record.
 * Does not re-mint tokens — only updates limit fields on the KV record.
 *
 * Usage (from apps/api):
 *   node --env-file=../../.env scripts/set-workspace-limits.mjs <name> \
 *     [--max-storage 25GB] \
 *     [--max-uploads-per-month 10000] \
 *     [--max-upload-bytes 25MB] \
 *     [--retention-days 90] \
 *     [--clear-max-storage] [--clear-max-uploads-per-month] [--clear-max-upload-bytes] \
 *     [--clear-retention-days] \
 *     [--local]
 *
 * Units: bare number = bytes (or count for uploads). Also accepts KB/MB/GB
 * and KiB/MiB/GiB (e.g. 1GB, 25MiB). Use 0 or "unlimited" with a --clear-*
 * flag to remove a cap.
 *
 * Show current limits only:
 *   node scripts/set-workspace-limits.mjs <name> [--local]
 */
import { execFileSync } from "node:child_process";

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

function wranglerKv(args) {
  return execFileSync(
    "pnpm",
    [
      "exec",
      "wrangler",
      "kv",
      "key",
      ...args,
      "--binding",
      "REGISTRY",
      opts.local ? "--local" : "--remote",
    ],
    { encoding: "utf8" },
  );
}

const key = `ws:${name}`;
let raw;
try {
  raw = wranglerKv(["get", key]);
} catch {
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

const changing = Object.keys(patch).length > 0;
if (!changing) {
  console.log(`workspace : ${name} (${opts.local ? "local" : "remote"})`);
  console.log("limits    :", JSON.stringify(before, null, 2));
  console.log("\nNo flags — nothing updated. Examples:");
  console.log(
    `  node scripts/set-workspace-limits.mjs ${name} --max-storage 25GB --max-uploads-per-month 10000`,
  );
  console.log(`  node scripts/set-workspace-limits.mjs ${name} --clear-max-storage`);
  process.exit(0);
}

for (const [field, value] of Object.entries(patch)) {
  if (value === null) delete record[field];
  else record[field] = value;
}

wranglerKv(["put", key, JSON.stringify(record)]);

const after = {
  maxStorageBytes: record.maxStorageBytes,
  maxUploadsPerPeriod: record.maxUploadsPerPeriod,
  maxUploadBytes: record.maxUploadBytes,
  maxVideoUploadBytes: record.maxVideoUploadBytes,
  retentionDays: record.retentionDays,
};

console.log(`workspace : ${name} (${opts.local ? "local" : "remote"})`);
console.log("before    :", JSON.stringify(before));
console.log("after     :", JSON.stringify(after));
console.log("\nLimits apply on the next request (KV cacheTtl ≈ 60s).");
