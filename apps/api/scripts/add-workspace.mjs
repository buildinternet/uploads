#!/usr/bin/env node
/**
 * Register a workspace in the REGISTRY KV namespace and mint its bearer token.
 * The token is printed once; only its SHA-256 hash is stored.
 *
 * Usage (from apps/api):
 *   node scripts/add-workspace.mjs <name> \
 *     [--bucket <bucket>]   # omit for shared-bucket mode (uploads-default + "<name>/" prefix)
 *     [--binding UPLOADS] [--public-base-url https://media.example.com] \
 *     [--account-id ...] [--access-key-id ...] [--secret-access-key ...] \
 *     [--max-storage 25GB] [--max-uploads-per-month 10000] [--max-upload-bytes 25MB] \
 *     [--max-video-bytes 8MB] [--retention-days N] \
 *     [--allowed-prefixes default|f,screenshots,gh] [--max-key-depth 8] \
 *     [--no-default-limits] # skip shared/agent template (start unlimited)
 *     [--local]             # write to wrangler dev's local KV instead of prod
 *
 * By default, new workspaces get the shared/agent limit template (see
 * workspace-limit-defaults.mjs / docs/ops.md). Explicit --max-* flags override
 * individual fields; pass unlimited/none/off to clear one. Change later with
 * scripts/set-workspace-limits.mjs without re-minting tokens.
 *
 * Default (no --bucket): the workspace is a "<name>/" prefix in the shared
 * uploads-default bucket, served at https://storage.uploads.sh/<name>/...
 * Creating one is a pure KV write — no bucket, binding, or deploy needed.
 *
 * BYO mode (--bucket): dedicated bucket, today's behavior. Credential flags
 * fall back to R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY, and
 * --public-base-url to R2_PUBLIC_BASE_URL, so you can keep them in the
 * repo-root .env and run:
 *   node --env-file=../../.env scripts/add-workspace.mjs <name> --bucket <bucket>
 * Env fallbacks apply ONLY in BYO mode — shared-mode records never inherit
 * BYO-bucket credentials from the environment.
 */
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import { sharedAgentLimitFields } from "./workspace-limit-defaults.mjs";

/** Match apps/api/src/secrets.ts: enc:v1: + base64url(iv || ct || tag). */
function sealField(master, plaintext) {
  if (!master || !plaintext || String(plaintext).startsWith("enc:v1:")) return plaintext;
  if (master.length < 16) fail("WORKSPACE_SECRETS_KEY must be at least 16 characters");
  const key = crypto.createHash("sha256").update(master).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:v1:${Buffer.concat([iv, enc, tag]).toString("base64url")}`;
}

const [name, ...rest] = process.argv.slice(2);
const opts = {};
for (let i = 0; i < rest.length; i++) {
  const flag = rest[i];
  if (!flag.startsWith("--")) fail(`unexpected argument: ${flag}`);
  const key = flag.slice(2);
  if (key === "local" || key === "no-default-limits") {
    opts[key] = true;
    continue;
  }
  opts[key] = rest[++i];
}

function fail(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}

/** @returns {number | null | undefined} number, null=clear/unlimited, undefined=flag omitted */
function parseBytes(raw, label) {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const s = String(raw).trim();
  if (/^(unlimited|none|off)$/i.test(s)) return null;
  const m = /^(\d+(?:\.\d+)?)\s*(b|bytes?|k|kb|kib|m|mb|mib|g|gb|gib)?$/i.exec(s);
  if (!m) fail(`invalid ${label}: ${JSON.stringify(raw)}`);
  const n = Number(m[1]);
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

/** @returns {number | null | undefined} */
function parseCount(raw, label) {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const s = String(raw).trim();
  if (/^(unlimited|none|off)$/i.test(s)) return null;
  const n = Number(s);
  if (!Number.isInteger(n) || n <= 0) fail(`invalid ${label}: ${JSON.stringify(raw)}`);
  return n;
}

/** @returns {number | null | undefined} */
function parseDepth(raw, label) {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const s = String(raw).trim();
  if (/^(unlimited|none|off)$/i.test(s)) return null;
  const n = Number(s);
  if (!Number.isInteger(n) || n < 1 || n > 64) {
    fail(`invalid ${label}: ${JSON.stringify(raw)} (use 1–64)`);
  }
  return n;
}

/** @returns {string[] | null | undefined} */
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

/** Set, clear, or leave alone a limit field (undefined = flag omitted). */
function applyLimit(record, field, value) {
  if (value === undefined) return;
  if (value === null) delete record[field];
  else record[field] = value;
}

if (!name || !/^[a-z0-9][a-z0-9-]{1,62}$/.test(name)) {
  fail("workspace name must be lowercase alphanumeric/hyphens, 2-63 chars");
}
const token = `up_${name}_${crypto.randomBytes(24).toString("base64url")}`;

const SHARED = {
  bucket: "uploads-default",
  binding: "UPLOADS_DEFAULT",
  publicBaseUrl: "https://storage.uploads.sh",
};

const tokens = [
  {
    hash: crypto.createHash("sha256").update(token).digest("hex"),
    label: "initial",
    createdAt: new Date().toISOString(),
  },
];

const record = opts.bucket
  ? {
      // BYO mode: dedicated bucket, credentials from flags or .env.
      provider: "r2",
      bucket: opts.bucket,
      binding: opts.binding,
      publicBaseUrl: opts["public-base-url"] ?? process.env.R2_PUBLIC_BASE_URL,
      tokens,
      accountId: opts["account-id"] ?? process.env.R2_ACCOUNT_ID,
      accessKeyId: opts["access-key-id"] ?? process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: opts["secret-access-key"] ?? process.env.R2_SECRET_ACCESS_KEY,
    }
  : {
      // Shared mode: a "<name>/" prefix in the shared bucket. No env credential
      // fallback — R2_* env keys are scoped to BYO buckets, and presigning
      // against the shared bucket is deferred (see the design spec).
      provider: "r2",
      bucket: SHARED.bucket,
      binding: opts.binding ?? SHARED.binding,
      prefix: `${name}/`,
      publicBaseUrl: opts["public-base-url"] ?? SHARED.publicBaseUrl,
      tokens,
      accountId: opts["account-id"],
      accessKeyId: opts["access-key-id"],
      secretAccessKey: opts["secret-access-key"],
    };
// Shared/agent template first; flags override (or --no-default-limits skips it).
if (!opts["no-default-limits"]) {
  Object.assign(record, sharedAgentLimitFields());
}

applyLimit(record, "maxStorageBytes", parseBytes(opts["max-storage"], "max-storage"));
applyLimit(
  record,
  "maxUploadsPerPeriod",
  parseCount(opts["max-uploads-per-month"], "max-uploads-per-month"),
);
applyLimit(record, "maxUploadBytes", parseBytes(opts["max-upload-bytes"], "max-upload-bytes"));
applyLimit(record, "maxVideoUploadBytes", parseBytes(opts["max-video-bytes"], "max-video-bytes"));
applyLimit(record, "retentionDays", parseCount(opts["retention-days"], "retention-days"));
applyLimit(
  record,
  "allowedKeyPrefixes",
  parseAllowedPrefixes(opts["allowed-prefixes"], "allowed-prefixes"),
);
applyLimit(record, "maxKeyDepth", parseDepth(opts["max-key-depth"], "max-key-depth"));

const master = process.env.WORKSPACE_SECRETS_KEY;
if (master && (record.accessKeyId || record.secretAccessKey)) {
  if (record.accessKeyId) record.accessKeyId = sealField(master, record.accessKeyId);
  if (record.secretAccessKey) record.secretAccessKey = sealField(master, record.secretAccessKey);
}

Object.keys(record).forEach((k) => record[k] === undefined && delete record[k]);

const appliedLimits = {
  maxStorageBytes: record.maxStorageBytes,
  maxUploadsPerPeriod: record.maxUploadsPerPeriod,
  maxUploadBytes: record.maxUploadBytes,
  maxVideoUploadBytes: record.maxVideoUploadBytes,
  retentionDays: record.retentionDays,
  allowedKeyPrefixes: record.allowedKeyPrefixes,
  maxKeyDepth: record.maxKeyDepth,
};

execFileSync(
  "pnpm",
  [
    "exec",
    "wrangler",
    "kv",
    "key",
    "put",
    `ws:${name}`,
    JSON.stringify(record),
    "--binding",
    "REGISTRY",
    opts.local ? "--local" : "--remote",
  ],
  { stdio: "inherit" },
);

console.log(`\nworkspace : ${name}${opts.local ? " (local)" : ""}`);
console.log(`token     : ${token}`);
console.log(
  "limits    :",
  opts["no-default-limits"] && !Object.values(appliedLimits).some((v) => v !== undefined)
    ? "(none — unlimited)"
    : JSON.stringify(appliedLimits),
);
console.log("\nStore the token now — only its hash is kept in KV.");
console.log(
  `try it    : curl -H "Authorization: Bearer ${token}" https://api.uploads.sh/v1/${name}/files`,
);
