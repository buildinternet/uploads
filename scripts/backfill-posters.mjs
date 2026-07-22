#!/usr/bin/env node
/**
 * One-time backfill: generate video poster frames (issue #299) for
 * `video/mp4` objects uploaded before write-time generation existed, or
 * uploaded via `POST /sign` (which bypasses write-time generation entirely —
 * presigned uploads go straight to R2 and never touch `generateAndStorePoster`
 * in apps/api/src/files-core.ts).
 *
 * Mirrors apps/api/scripts/backfill-gh-metadata.mjs: same GET
 * /v1/:ws/files?prefix=&cursor= cursor loop, same --workspace/--dry-run
 * argument shape, same summary-line-at-the-end reporting, same auth
 * (bearer token from env). The one addition is `--limit <n>` to bound a run.
 *
 * There is no admin route that calls `generateAndStorePoster` directly for
 * an already-stored object, and this script intentionally does not add one.
 * Instead it re-PUTs each candidate's existing bytes back to their own key
 * via `PUT /v1/:ws/files/:key` with no `X-Uploads-Meta-*` headers — the same
 * write path a fresh upload takes, which already calls
 * `generateAndStorePoster` after storing (files-core.ts) and, critically,
 * already leaves existing D1 metadata untouched when no custom meta headers
 * are sent (see the `hasCustomMeta` comment in apps/api/src/routes/files.ts).
 * That write path is gated by the `video-poster-generation` Flagship flag
 * and by `POSTER_LIMITER` (apps/api/src/poster.ts, apps/api/src/guards.ts) —
 * so this backfill only has an effect while the flag is on, and always
 * respects the same rate limit as live traffic.
 *
 * Idempotency: `video.poster` is only ever set once a poster exists, so a
 * candidate that already carries it is skipped up front — safe to re-run.
 * A `video/mp4` over 10 minutes is silently skipped server-side by
 * `POSTER_MAX_DURATION_SECONDS` (apps/api/src/poster.ts) and never gets
 * `video.poster` set; the script does not know duration up front (it isn't
 * probed until the write path runs), so oversized-by-duration clips will be
 * re-attempted (and re-skipped) on every run. This is a known, harmless
 * limitation — see docs/ops.md.
 *
 * Visibility is preserved: the list response's `visibility` field (present
 * only when an object is private) is forwarded as `X-Uploads-Visibility:
 * private` on each re-PUT, so private videos stay private. Public items send
 * no such header, matching the API's own public-by-default sanitizer.
 *
 * COST — NOT free, NOT lossless in one respect (see docs/ops.md for the
 * full callout): every re-PUT is a real upload, so each candidate consumes
 * one unit of the workspace's `maxUploadsPerPeriod` budget via
 * `reserveUploads`, exactly like a brand-new upload would, even though no
 * new object is being created. A large run can burn through a workspace's
 * upload budget and start failing with 429s partway through, or crowd out
 * real traffic sharing that budget. There is no admin bypass for this
 * (fixing it requires a new endpoint, out of scope here) — check the
 * workspace's current budget before a large run and use `--limit` to bound
 * each invocation.
 *
 * Usage (from monorepo root, with UPLOADS_API_URL / UPLOADS_WORKSPACE /
 * UPLOADS_TOKEN in .env, same names as .env.example):
 *   node --env-file=.env scripts/backfill-posters.mjs --workspace default --dry-run
 *   node --env-file=.env scripts/backfill-posters.mjs --workspace default --limit 20
 *   node --env-file=.env scripts/backfill-posters.mjs --workspace=other-ws --dry-run --limit=20
 *
 * Never point this at a production workspace during testing — use a local
 * `wrangler dev` stack (UPLOADS_API_URL=http://localhost:8787) first. When
 * UPLOADS_API_URL is unset this defaults to prod and prints a warning.
 */
import { pathToFileURL } from "node:url";

/** Must match apps/api/src/guards.ts VIDEO_TYPES intersected with poster.ts's supported input. */
export const POSTER_CONTENT_TYPE = "video/mp4";

/** Must match apps/api/src/poster.ts POSTER_MAX_INPUT_BYTES. */
export const MAX_INPUT_BYTES = 100 * 1024 * 1024;

/**
 * Pure classification: given one listing item, decide whether it's a
 * poster-backfill candidate or should be skipped (with a reason). No I/O.
 */
export function classifyItem(item) {
  if (item.metadata?.["video.poster"] === "1") {
    return { skip: "already-postered" };
  }
  if (item.contentType !== POSTER_CONTENT_TYPE) {
    return { skip: `not-${POSTER_CONTENT_TYPE}` };
  }
  if (typeof item.size === "number" && item.size > MAX_INPUT_BYTES) {
    return { skip: "too-large (>100MB)" };
  }
  return { candidate: true };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Orchestrates the list→classify→(re-put) loop. `fetchImpl`/`sleepImpl` are
 * injectable for tests; production callers pass the globals.
 *
 * @returns {Promise<{scanned: number, generated: number, skipped: Record<string, number>, failed: number}>}
 */
export async function runBackfill({
  apiUrl,
  workspace,
  token,
  dryRun = false,
  limit,
  // Comfortably under the 30/min POSTER_LIMITER ceiling.
  intervalMs = 3000,
  fetchImpl = fetch,
  sleepImpl = sleep,
  log = console.log,
}) {
  const base = apiUrl.replace(/\/$/, "");
  const counts = { scanned: 0, generated: 0, skipped: {}, failed: 0 };
  const recordSkip = (reason) => {
    counts.skipped[reason] = (counts.skipped[reason] ?? 0) + 1;
  };

  let cursor;
  let processed = 0;

  outer: for (;;) {
    const listUrl = new URL(`${base}/v1/${workspace}/files`);
    listUrl.searchParams.set("metadata", "1");
    if (cursor) listUrl.searchParams.set("cursor", cursor);

    let listRes;
    try {
      listRes = await fetchImpl(listUrl.toString(), {
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch (err) {
      counts.failed += 1;
      log(`error: list failed (${err instanceof Error ? err.message : String(err)})`);
      break;
    }
    if (!listRes.ok) {
      counts.failed += 1;
      log(`error: list failed (HTTP ${listRes.status})`);
      break;
    }
    const page = await listRes.json();
    const items = Array.isArray(page.items) ? page.items : [];

    for (const item of items) {
      if (limit != null && processed >= limit) break outer;
      processed += 1;
      counts.scanned += 1;

      const decision = classifyItem(item);
      if (decision.skip) {
        recordSkip(decision.skip);
        log(`skip  ${item.key} (${decision.skip})`);
        continue;
      }

      if (dryRun) {
        log(`[dry-run] would generate poster for ${item.key} (size=${item.size})`);
        continue;
      }

      if (!item.url) {
        counts.failed += 1;
        log(`error: ${item.key} has no fetchable url, cannot re-put`);
        continue;
      }

      try {
        const bytesRes = await fetchImpl(item.url);
        if (!bytesRes.ok) {
          counts.failed += 1;
          log(`error: download ${item.key} failed (HTTP ${bytesRes.status})`);
          continue;
        }
        const bytes = new Uint8Array(await bytesRes.arrayBuffer());

        // No X-Uploads-Meta-* headers: existing D1 metadata is left
        // untouched (see files.ts hasCustomMeta comment). The write path
        // this hits calls generateAndStorePoster after storing.
        //
        // Visibility (issue #365 review, critical): putObject builds R2
        // custom metadata fresh on every write and only sets the private
        // flag when the request explicitly carries it (files-core.ts —
        // `storedVisibility = opts?.visibility === "private" ? ... `).
        // Without forwarding it here, every private video this script
        // touches would silently flip to public on re-PUT, since
        // store.upload metadata is full-replace, not a merge. `GET
        // /v1/:ws/files` (files-core.ts listObjects) already surfaces
        // `visibility: "private"` per item whenever the object is private
        // (absent/undefined means public) — the same field
        // headObjectJson/list responses use everywhere else in the API, so
        // this is the cheapest honest source and needs no new endpoint.
        // Forward it verbatim via the header the PUT route actually parses
        // (`sanitizeVisibility(c.req.header("x-uploads-visibility"))`,
        // apps/api/src/routes/files.ts) — omitted entirely for public
        // items, matching the sanitizer's "anything but 'private'" default.
        const putRes = await fetchImpl(`${base}/v1/${workspace}/files/${item.key}`, {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": item.contentType,
            "X-Uploads-Replace": "1",
            ...(item.visibility === "private" ? { "X-Uploads-Visibility": "private" } : {}),
          },
          body: bytes,
        });
        if (!putRes.ok) {
          counts.failed += 1;
          log(`error: re-put ${item.key} failed (HTTP ${putRes.status})`);
          continue;
        }
        counts.generated += 1;
        log(`generated poster for ${item.key}`);
      } catch (err) {
        counts.failed += 1;
        log(`error: ${item.key} failed (${err instanceof Error ? err.message : String(err)})`);
      } finally {
        // Every attempted item sleeps, including the continue paths above
        // (download-failure, PUT-failure) — otherwise a run that starts
        // hitting non-ok responses fires the rest back-to-back with no
        // delay, defeating the rate-limit guarantee documented above.
        await sleepImpl(intervalMs);
      }
    }

    cursor = page.cursor;
    if (!cursor) break;
  }

  return counts;
}

function parseArgs(argv) {
  const opts = { dryRun: false, workspace: undefined, limit: undefined };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      opts.dryRun = true;
    } else if (arg.startsWith("--workspace=")) {
      opts.workspace = arg.slice("--workspace=".length);
    } else if (arg === "--workspace") {
      opts.workspace = argv[++i];
    } else if (arg.startsWith("--limit=")) {
      opts.limit = Number(arg.slice("--limit=".length));
    } else if (arg === "--limit") {
      opts.limit = Number(argv[++i]);
    } else {
      throw new Error(`unexpected argument: ${arg}`);
    }
  }
  if (opts.limit != null && (!Number.isFinite(opts.limit) || opts.limit <= 0)) {
    throw new Error("--limit must be a positive number");
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
  const defaultedApi = !process.env.UPLOADS_API_URL;
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
  if (defaultedApi) {
    console.warn(`warning: UPLOADS_API_URL unset; defaulting to ${apiUrl} (production)`);
  }

  console.log(
    `backfilling video posters for ${apiUrl} workspace=${workspace}${
      opts.dryRun ? " (dry-run)" : ""
    }${opts.limit != null ? ` limit=${opts.limit}` : ""}`,
  );

  let summary;
  try {
    summary = await runBackfill({
      apiUrl,
      workspace,
      token,
      dryRun: opts.dryRun,
      limit: opts.limit,
    });
  } catch (err) {
    console.error(`error: backfill failed (${err instanceof Error ? err.message : String(err)})`);
    process.exit(1);
  }

  const skippedTotal = Object.values(summary.skipped).reduce((a, b) => a + b, 0);
  const skippedBreakdown = Object.entries(summary.skipped)
    .map(([reason, n]) => `${reason}=${n}`)
    .join(", ");
  console.log(
    `\ndone: scanned=${summary.scanned} generated=${summary.generated} skipped=${skippedTotal}${
      skippedBreakdown ? ` (${skippedBreakdown})` : ""
    } failed=${summary.failed}`,
  );
  process.exit(summary.failed > 0 ? 1 : 0);
}

// Only run when executed directly (`node backfill-posters.mjs`), not when
// imported for its pure functions.
const isMain = (() => {
  try {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
})();
if (isMain) {
  void main();
}
