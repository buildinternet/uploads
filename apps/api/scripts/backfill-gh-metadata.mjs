#!/usr/bin/env node
/**
 * One-time backfill: derive gh.* metadata for objects uploaded under gh/...
 * before per-file metadata existed, so they become searchable the same way
 * `uploads attach` writes them going forward (see ghMetadataFromTarget in
 * packages/uploads/src/github.ts — this script mirrors that mapping).
 *
 * Pages GET /v1/:ws/files?prefix=gh/ (cursor loop), parses each key against
 * GH_KEY_RE, and PATCHes /v1/:ws/files/<key>/metadata with `{ set: {...} }`
 * for every match. Non-matching keys under gh/ are skipped and counted, not
 * treated as errors. Merge-semantics PATCH means re-running is harmless
 * (idempotent) — safe to re-run after interruption.
 *
 * BINDING: gh.* metadata values are canonical lowercase (gh.repo, gh.ref);
 * the object key itself keeps its original casing untouched. gh.kind is
 * "issue" for keys under gh/.../issues/... and "pull" for gh/.../pull/....
 *
 * Usage (from apps/api, with UPLOADS_API_URL / UPLOADS_WORKSPACE /
 * UPLOADS_TOKEN in the monorepo-root .env, same names as .env.example):
 *   node --env-file=../../.env scripts/backfill-gh-metadata.mjs --dry-run
 *   node --env-file=../../.env scripts/backfill-gh-metadata.mjs
 *   node --env-file=../../.env scripts/backfill-gh-metadata.mjs --workspace other-ws
 *
 * Never point this at a production workspace during testing — use a local
 * `wrangler dev` stack (UPLOADS_API_URL=http://localhost:8787) first.
 */
import { pathToFileURL } from "node:url";

/** Anchored gh/<owner>/<repo>/<pull|issues>/<number>/ prefix — see task brief. */
export const GH_KEY_RE = /^gh\/([^/]+)\/([^/]+)\/(pull|issues)\/(\d+)\//;

/**
 * Pure key-parsing + plan-building logic, no I/O. Returns the PATCH plan for
 * a matching key, or null when the key doesn't match the gh/ layout (caller
 * counts those as skipped, not errors).
 */
export function planForKey(key) {
  const m = GH_KEY_RE.exec(key);
  if (!m) return null;
  const [, ownerRaw, repoRaw, kindSeg, number] = m;
  const repo = `${ownerRaw}/${repoRaw}`.toLowerCase();
  const kind = kindSeg === "issues" ? "issue" : "pull";
  return {
    key,
    metadata: {
      "gh.repo": repo,
      "gh.kind": kind,
      "gh.number": number,
      "gh.ref": `${repo}#${number}`,
    },
  };
}

/**
 * Orchestrates the list→plan→PATCH loop. `fetchImpl` is injectable for
 * tests; production callers pass the global `fetch`.
 *
 * @returns {Promise<{matched: number, patched: number, skipped: number, errors: number}>}
 */
export async function runBackfill({
  apiUrl,
  workspace,
  token,
  dryRun = false,
  prefix = "gh/",
  fetchImpl = fetch,
  log = console.log,
}) {
  const base = apiUrl.replace(/\/$/, "");
  const counts = { matched: 0, patched: 0, skipped: 0, errors: 0 };
  let cursor;

  for (;;) {
    const listUrl = new URL(`${base}/v1/${workspace}/files`);
    listUrl.searchParams.set("prefix", prefix);
    if (cursor) listUrl.searchParams.set("cursor", cursor);

    const listRes = await fetchImpl(listUrl.toString(), {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!listRes.ok) {
      counts.errors += 1;
      log(`error: list failed (HTTP ${listRes.status})`);
      break;
    }
    const page = await listRes.json();
    const items = Array.isArray(page.items) ? page.items : [];

    for (const item of items) {
      const plan = planForKey(item.key);
      if (!plan) {
        counts.skipped += 1;
        log(`skip  ${item.key} (does not match gh/ layout)`);
        continue;
      }
      counts.matched += 1;

      if (dryRun) {
        log(`[dry-run] would PATCH ${plan.key} set=${JSON.stringify(plan.metadata)}`);
        continue;
      }

      const patchUrl = `${base}/v1/${workspace}/files/${plan.key}/metadata`;
      const patchRes = await fetchImpl(patchUrl, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ set: plan.metadata }),
      });
      if (!patchRes.ok) {
        counts.errors += 1;
        log(`error: PATCH ${plan.key} failed (HTTP ${patchRes.status})`);
        continue;
      }
      counts.patched += 1;
      log(`patch ${plan.key} set=${JSON.stringify(plan.metadata)}`);
    }

    cursor = page.cursor;
    if (!cursor) break;
  }

  return counts;
}

function parseArgs(argv) {
  const opts = { dryRun: false, workspace: undefined };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      opts.dryRun = true;
    } else if (arg === "--workspace") {
      opts.workspace = argv[++i];
    } else {
      throw new Error(`unexpected argument: ${arg}`);
    }
  }
  return opts;
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  const apiUrl = process.env.UPLOADS_API_URL ?? "https://api.uploads.sh";
  const workspace = opts.workspace ?? process.env.UPLOADS_WORKSPACE;
  const token = process.env.UPLOADS_TOKEN;

  if (!workspace) {
    console.error("error: UPLOADS_WORKSPACE (or --workspace) is required");
    process.exit(1);
  }
  if (!token) {
    console.error("error: UPLOADS_TOKEN is required");
    process.exit(1);
  }

  console.log(
    `backfilling gh.* metadata for ${apiUrl} workspace=${workspace}${opts.dryRun ? " (dry-run)" : ""}`,
  );

  const summary = await runBackfill({ apiUrl, workspace, token, dryRun: opts.dryRun });

  console.log(
    `\ndone: matched=${summary.matched} patched=${summary.patched} skipped=${summary.skipped} errors=${summary.errors}`,
  );
  process.exit(summary.errors > 0 ? 1 : 0);
}

// Only run when executed directly (`node backfill-gh-metadata.mjs`), not when
// imported for its pure functions (test/backfill-gh-metadata.test.ts).
const isMain = (() => {
  try {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
})();
if (isMain) {
  main();
}
