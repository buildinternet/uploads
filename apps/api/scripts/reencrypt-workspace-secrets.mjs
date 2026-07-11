#!/usr/bin/env node
/**
 * Thin client for POST /admin/credentials/reencrypt.
 *
 * Prefer the admin API so WORKSPACE_SECRETS_KEY never leaves the worker.
 * Secret rotation (putting NEW / PREVIOUS) still uses wrangler secret put.
 *
 * Usage:
 *   UPLOADS_API_URL=https://api.uploads.sh ADMIN_TOKEN=… \
 *     node scripts/reencrypt-workspace-secrets.mjs [--dry-run]
 *
 * Or from monorepo root after setting ADMIN_TOKEN in .env:
 *   pnpm workspace:reencrypt-secrets --dry-run
 */
const dryRun = process.argv.includes("--dry-run");
const api = (process.env.UPLOADS_API_URL ?? "https://api.uploads.sh").replace(/\/$/, "");
const token = process.env.ADMIN_TOKEN ?? process.env.UPLOADS_ADMIN_TOKEN ?? "";

if (!token) {
  console.error("error: ADMIN_TOKEN (or UPLOADS_ADMIN_TOKEN) is required");
  process.exit(1);
}

const url = `${api}/admin/credentials/reencrypt${dryRun ? "?dryRun=1" : ""}`;
const res = await fetch(url, {
  method: "POST",
  headers: { Authorization: `Bearer ${token}` },
});
const text = await res.text();
let body;
try {
  body = JSON.parse(text);
} catch {
  body = text;
}
if (!res.ok) {
  console.error(`HTTP ${res.status}`, body);
  process.exit(1);
}
console.log(JSON.stringify(body, null, 2));
if (body.errors?.length) process.exit(1);
console.log(
  dryRun
    ? "\nDry-run only. Re-run without --dry-run, then remove WORKSPACE_SECRETS_KEY_PREVIOUS."
    : "\nDone. After verifying BYO workspaces, remove WORKSPACE_SECRETS_KEY_PREVIOUS.",
);
