#!/usr/bin/env node
/**
 * Register a workspace in the REGISTRY KV namespace and mint its bearer token.
 * The token is printed once; only its SHA-256 hash is stored.
 *
 * Usage (from apps/api):
 *   node scripts/add-workspace.mjs <name> --bucket <bucket> \
 *     [--binding UPLOADS] [--public-base-url https://media.example.com] \
 *     [--account-id ...] [--access-key-id ...] [--secret-access-key ...] \
 *     [--local]            # write to wrangler dev's local KV instead of prod
 *
 * Credential flags fall back to R2_ACCOUNT_ID / R2_ACCESS_KEY_ID /
 * R2_SECRET_ACCESS_KEY, and --public-base-url to R2_PUBLIC_BASE_URL, so you
 * can keep them in the repo-root .env and run:
 *   node --env-file=../../.env scripts/add-workspace.mjs <name> --bucket <bucket>
 */
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";

const [name, ...rest] = process.argv.slice(2);
const opts = {};
for (let i = 0; i < rest.length; i++) {
  const flag = rest[i];
  if (!flag.startsWith("--")) fail(`unexpected argument: ${flag}`);
  const key = flag.slice(2);
  if (key === "local") { opts.local = true; continue; }
  opts[key] = rest[++i];
}

function fail(msg) { console.error(`error: ${msg}`); process.exit(1); }

if (!name || !/^[a-z0-9][a-z0-9-]{1,62}$/.test(name)) {
  fail("workspace name must be lowercase alphanumeric/hyphens, 2-63 chars");
}
if (!opts.bucket) fail("--bucket is required");

const token = `up_${name}_${crypto.randomBytes(24).toString("base64url")}`;
const record = {
  provider: "r2",
  bucket: opts.bucket,
  binding: opts.binding,
  publicBaseUrl: opts["public-base-url"] ?? process.env.R2_PUBLIC_BASE_URL,
  tokenHash: crypto.createHash("sha256").update(token).digest("hex"),
  accountId: opts["account-id"] ?? process.env.R2_ACCOUNT_ID,
  accessKeyId: opts["access-key-id"] ?? process.env.R2_ACCESS_KEY_ID,
  secretAccessKey: opts["secret-access-key"] ?? process.env.R2_SECRET_ACCESS_KEY,
};
Object.keys(record).forEach((k) => record[k] === undefined && delete record[k]);

execFileSync(
  "pnpm",
  [
    "exec", "wrangler", "kv", "key", "put", `ws:${name}`,
    JSON.stringify(record),
    "--binding", "REGISTRY",
    opts.local ? "--local" : "--remote",
  ],
  { stdio: "inherit" },
);

console.log(`\nworkspace : ${name}`);
console.log(`token     : ${token}`);
console.log("\nStore the token now — only its hash is kept in KV.");
console.log(`try it    : curl -H "Authorization: Bearer ${token}" https://api.uploads.sh/v1/${name}/files`);
