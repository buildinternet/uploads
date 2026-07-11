#!/usr/bin/env node
/**
 * Re-seal BYO credentials under the current WORKSPACE_SECRETS_KEY.
 *
 * Rotation procedure (see docs/ops.md):
 *   1. openssl rand -base64 32  → NEW
 *   2. wrangler secret put WORKSPACE_SECRETS_KEY_PREVIOUS  # paste OLD
 *   3. wrangler secret put WORKSPACE_SECRETS_KEY            # paste NEW
 *   4. WORKSPACE_SECRETS_KEY=NEW WORKSPACE_SECRETS_KEY_PREVIOUS=OLD \
 *        node scripts/reencrypt-workspace-secrets.mjs [--local] [--dry-run]
 *   5. Verify BYO workspaces; remove WORKSPACE_SECRETS_KEY_PREVIOUS
 *
 * Decrypt tries PREVIOUS then CURRENT; encrypt uses CURRENT only.
 */
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";

const args = process.argv.slice(2);
const local = args.includes("--local");
const dryRun = args.includes("--dry-run");

const PREFIX = "enc:v1:";
const current = process.env.WORKSPACE_SECRETS_KEY ?? "";
const previous = process.env.WORKSPACE_SECRETS_KEY_PREVIOUS ?? "";

function fail(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}

if (current.length < 16) {
  fail("WORKSPACE_SECRETS_KEY (current) must be set and ≥ 16 characters");
}

function aesKey(secret) {
  return crypto.createHash("sha256").update(secret).digest();
}

function encrypt(master, plaintext) {
  const key = aesKey(master);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, enc, tag]).toString("base64url");
}

function decryptOne(master, value) {
  const packed = Buffer.from(value.slice(PREFIX.length), "base64url");
  if (packed.length < 13) throw new Error("invalid ciphertext");
  const iv = packed.subarray(0, 12);
  const tag = packed.subarray(packed.length - 16);
  const data = packed.subarray(12, packed.length - 16);
  const decipher = crypto.createDecipheriv("aes-256-gcm", aesKey(master), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

function decrypt(value) {
  if (!value || !String(value).startsWith(PREFIX)) return { plain: value, usedPrevious: false };
  const masters = [current, previous].filter(
    (s, i, a) => s && s.length >= 16 && a.indexOf(s) === i,
  );
  let last;
  for (let i = 0; i < masters.length; i++) {
    try {
      return {
        plain: decryptOne(masters[i], value),
        usedPrevious: i > 0 || masters[i] === previous,
      };
    } catch (e) {
      last = e;
    }
  }
  throw last ?? new Error("decrypt failed");
}

function wrangler(args) {
  return execFileSync(
    "pnpm",
    ["exec", "wrangler", ...args, "--binding", "REGISTRY", local ? "--local" : "--remote"],
    {
      encoding: "utf8",
    },
  );
}

function listKeys() {
  // wrangler kv key list --prefix ws:
  const out = wrangler(["kv", "key", "list", "--prefix", "ws:"]);
  const parsed = JSON.parse(out);
  return parsed.map((k) => k.name).filter((n) => typeof n === "string" && n.startsWith("ws:"));
}

function getRecord(key) {
  const raw = wrangler(["kv", "key", "get", key]);
  return JSON.parse(raw);
}

function putRecord(key, record) {
  wrangler(["kv", "key", "put", key, JSON.stringify(record)]);
}

const keys = listKeys();
let scanned = 0;
let updated = 0;
let skipped = 0;
let errors = 0;

console.log(
  `reencrypt: ${keys.length} registry keys (${local ? "local" : "remote"})${dryRun ? " dry-run" : ""}`,
);

for (const key of keys) {
  scanned += 1;
  let record;
  try {
    record = getRecord(key);
  } catch (e) {
    console.error(`  ${key}: get failed — ${e.message ?? e}`);
    errors += 1;
    continue;
  }

  const hasCreds = record.accessKeyId || record.secretAccessKey;
  if (!hasCreds) {
    skipped += 1;
    continue;
  }

  try {
    const ak = record.accessKeyId ? decrypt(record.accessKeyId) : { plain: undefined };
    const sk = record.secretAccessKey ? decrypt(record.secretAccessKey) : { plain: undefined };
    const next = { ...record };
    if (ak.plain !== undefined) next.accessKeyId = encrypt(current, ak.plain);
    if (sk.plain !== undefined) next.secretAccessKey = encrypt(current, sk.plain);

    const changed =
      next.accessKeyId !== record.accessKeyId || next.secretAccessKey !== record.secretAccessKey;
    if (!changed) {
      skipped += 1;
      continue;
    }
    if (dryRun) {
      console.log(`  ${key}: would re-seal (usedPrevious=${ak.usedPrevious || sk.usedPrevious})`);
      updated += 1;
    } else {
      putRecord(key, next);
      console.log(`  ${key}: re-sealed under current key`);
      updated += 1;
    }
  } catch (e) {
    console.error(`  ${key}: ${e.message ?? e}`);
    errors += 1;
  }
}

console.log(`\ndone: scanned=${scanned} updated=${updated} skipped=${skipped} errors=${errors}`);
if (errors > 0) process.exit(1);
console.log("After verifying BYO workspaces, remove WORKSPACE_SECRETS_KEY_PREVIOUS.");
