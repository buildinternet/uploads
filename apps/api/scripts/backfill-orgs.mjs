#!/usr/bin/env node
/**
 * Thin client for POST /admin/orgs/backfill (plan D4/D9, Phase 3).
 *
 * Creates a Better Auth organization (slug = workspace name) for every KV
 * workspace that doesn't already have one — idempotent, safe to re-run.
 *
 * Equivalent curl (this script just wraps this call — see
 * reencrypt-workspace-secrets.mjs for the sibling pattern this mirrors):
 *   curl -X POST "$UPLOADS_API_URL/admin/orgs/backfill" \
 *     -H "Authorization: Bearer $ADMIN_TOKEN"
 *
 * Usage:
 *   UPLOADS_API_URL=https://api.uploads.sh ADMIN_TOKEN=… \
 *     node scripts/backfill-orgs.mjs
 *
 * Or from monorepo root after setting ADMIN_TOKEN in .env:
 *   node --env-file=.env apps/api/scripts/backfill-orgs.mjs
 */
const api = (process.env.UPLOADS_API_URL ?? "https://api.uploads.sh").replace(/\/$/, "");
const token = process.env.ADMIN_TOKEN ?? process.env.UPLOADS_ADMIN_TOKEN ?? "";

if (!token) {
  console.error("error: ADMIN_TOKEN (or UPLOADS_ADMIN_TOKEN) is required");
  process.exit(1);
}

const res = await fetch(`${api}/admin/orgs/backfill`, {
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
console.log(
  `\nCreated ${body.created?.length ?? 0}, already existed ${body.existing?.length ?? 0}.`,
);
