/**
 * Per-PR media activity rollup (`github_pr_activity` D1 table, issue #338).
 * A row is upserted from putObject whenever an object carrying
 * `gh.kind=pull` metadata lands — server-side promotion and direct `--pr`
 * attaches both flow through that choke point — so the table answers
 * "which PRs recently got media?" without a webhook event log.
 *
 * `media_count` counts media-write events (an overwrite of the same key
 * counts again), not distinct files; treat it as an activity signal, not an
 * inventory. Rows are keyed by `ref` ("owner/repo#n", lowercased) and carry
 * the last workspace that wrote media for the PR (in practice one workspace
 * per repo, per the `github_repo_links` binding model).
 */
import { type D1Queryable } from "./db-session";
import type { ScopeCursor } from "./pr-scope";

export interface PrActivity {
  ref: string;
  repo: string;
  prNumber: number;
  branch: string | null;
  workspaceName: string;
  mediaCount: number;
  firstMediaAt: string;
  lastMediaAt: string;
}

interface PrActivityRow {
  ref: string;
  repo_full_name: string;
  pr_number: number;
  branch: string | null;
  workspace_name: string;
  media_count: number;
  first_media_at: string;
  last_media_at: string;
}

function rowToActivity(row: PrActivityRow): PrActivity {
  return {
    ref: row.ref,
    repo: row.repo_full_name,
    prNumber: row.pr_number,
    branch: row.branch,
    workspaceName: row.workspace_name,
    mediaCount: row.media_count,
    firstMediaAt: row.first_media_at,
    lastMediaAt: row.last_media_at,
  };
}

export interface PrMediaEvent {
  /** "owner/name" — lowercased here, so callers can pass tag values as-is. */
  repo: string;
  prNumber: number;
  branch?: string | null;
  workspaceName: string;
  /** Media writes this event represents (>= 1). */
  count: number;
}

/**
 * Best-effort upsert: never throws — activity tracking rides along with an
 * upload/promote response and a D1 blip here must not fail that request.
 * `first_media_at` is set once; `last_media_at` always advances; a null
 * branch never clobbers a previously recorded one. Invariant: `title`/`state`
 * belong to the workspace that owns the row, so when the writer's workspace
 * differs from the stored one the row changes hands and title/state reset to
 * NULL (they refill via the linked-repo webhook or the `/pulls` backfill).
 * Without this, a workspace that tags another's `gh.repo`/`gh.number` would
 * inherit that workspace's private title and state.
 */
export async function recordPrMediaActivity(
  db: D1Queryable,
  event: PrMediaEvent,
  now = new Date(),
): Promise<void> {
  const repo = event.repo.toLowerCase();
  const ref = `${repo}#${event.prNumber}`;
  try {
    await db
      .prepare(
        `INSERT INTO github_pr_activity
           (ref, repo_full_name, pr_number, branch, workspace_name,
            media_count, first_media_at, last_media_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(ref) DO UPDATE SET
           media_count = media_count + excluded.media_count,
           branch = COALESCE(excluded.branch, branch),
           title = CASE WHEN workspace_name = excluded.workspace_name THEN title ELSE NULL END,
           state = CASE WHEN workspace_name = excluded.workspace_name THEN state ELSE NULL END,
           workspace_name = excluded.workspace_name,
           last_media_at = excluded.last_media_at`,
      )
      .bind(
        ref,
        repo,
        event.prNumber,
        event.branch ?? null,
        event.workspaceName,
        event.count,
        now.toISOString(),
        now.toISOString(),
      )
      .run();
  } catch (err) {
    console.error(
      JSON.stringify({
        message: "pr activity record failed",
        ref,
        workspaceName: event.workspaceName,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}

/**
 * The putObject hook (files-core.ts): derives a PR media event from an
 * object's custom-metadata tag set. Only `gh.kind=pull` objects with a
 * well-formed repo + number count; anything else (branch-staged files,
 * issue attaches, non-GitHub uploads, malformed tags) is silently ignored.
 * Never throws (recordPrMediaActivity swallows D1 failures).
 */
export async function recordPrActivityFromMetadata(
  db: D1Queryable,
  workspaceName: string,
  metadata: Record<string, string>,
): Promise<void> {
  if (metadata["gh.kind"] !== "pull") return;
  const repo = metadata["gh.repo"];
  const prNumber = Number(metadata["gh.number"]);
  if (!repo || !repo.includes("/") || !Number.isInteger(prNumber) || prNumber <= 0) return;
  await recordPrMediaActivity(db, {
    repo,
    prNumber,
    branch: metadata["gh.branch"] ?? null,
    workspaceName,
    count: 1,
  });
}

/**
 * The workspace's PRs with media, most recent activity first. Strict — the
 * read endpoint should surface a D1 failure as a 5xx, not an empty feed.
 */
export async function listPrActivityForWorkspace(
  db: D1Queryable,
  workspaceName: string,
  limit: number,
): Promise<PrActivity[]> {
  const { results } = await db
    .prepare(
      `SELECT ref, repo_full_name, pr_number, branch, workspace_name,
              media_count, first_media_at, last_media_at
       FROM github_pr_activity
       WHERE workspace_name = ?
       ORDER BY last_media_at DESC
       LIMIT ?`,
    )
    .bind(workspaceName, limit)
    .all<PrActivityRow>();
  return (results ?? []).map(rowToActivity);
}

export type PrState = "open" | "closed" | "merged";

export function isPrState(value: unknown): value is PrState {
  return value === "open" || value === "closed" || value === "merged";
}

export interface PrActivityPageRow extends PrActivity {
  title: string | null;
  state: PrState | null;
}

/** Rollup columns plus title/state; shared by `listPrActivityPage` and `getPrActivityRow` (Task 6). */
const PAGE_ROW_COLUMNS = `ref, repo_full_name, pr_number, branch, workspace_name,
                    media_count, first_media_at, last_media_at, title, state`;

type PageRowRecord = PrActivityRow & { title: string | null; state: string | null };

function toPageRow(row: PageRowRecord): PrActivityPageRow {
  return {
    ...rowToActivity(row),
    title: row.title ?? null,
    state: isPrState(row.state) ? row.state : null,
  };
}

/**
 * One keyset page of the workspace's PRs with media, newest activity first.
 * Rows never resolved (null state) drop out when a `state` filter is set.
 * `since` bounds the window by `last_media_at` (the `/pulls` default is 90 days).
 * Strict: a D1 failure surfaces as a 5xx.
 */
export async function listPrActivityPage(
  db: D1Queryable,
  workspaceName: string,
  opts: {
    repo?: string;
    state?: PrState;
    /** ISO timestamp: keep rows with `last_media_at >= since` (the `/pulls` recency window). */
    since?: string;
    cursor?: ScopeCursor | null;
    limit: number;
  },
): Promise<{ rows: PrActivityPageRow[]; nextCursor: ScopeCursor | null }> {
  const params: unknown[] = [workspaceName];
  let sql = `SELECT ${PAGE_ROW_COLUMNS}
             FROM github_pr_activity
             WHERE workspace_name = ?`;
  if (opts.repo) {
    sql += ` AND repo_full_name = ?`;
    params.push(opts.repo);
  }
  if (opts.state) {
    sql += ` AND state = ?`;
    params.push(opts.state);
  }
  if (opts.since) {
    sql += ` AND last_media_at >= ?`;
    params.push(opts.since);
  }
  if (opts.cursor) {
    sql += ` AND (last_media_at < ? OR (last_media_at = ? AND ref > ?))`;
    params.push(opts.cursor.updatedAt, opts.cursor.updatedAt, opts.cursor.key);
  }
  sql += ` ORDER BY last_media_at DESC, ref ASC LIMIT ?`;
  params.push(opts.limit + 1);

  const { results } = await db
    .prepare(sql)
    .bind(...params)
    .all<PageRowRecord>();
  const rows = (results ?? []).map(toPageRow);
  const hasMore = rows.length > opts.limit;
  const page = hasMore ? rows.slice(0, opts.limit) : rows;
  const last = page.at(-1);
  return {
    rows: page,
    nextCursor: hasMore && last ? { updatedAt: last.lastMediaAt, key: last.ref } : null,
  };
}

/** Open-PR count per repo from the rollup. One bound parameter per repo: pass at most 99. */
export async function countOpenPullsByRepo(
  db: D1Queryable,
  workspaceName: string,
  repos: string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (repos.length === 0) return out;
  const { results } = await db
    .prepare(
      `SELECT repo_full_name AS repo, COUNT(*) AS n
       FROM github_pr_activity
       WHERE workspace_name = ? AND state = 'open'
         AND repo_full_name IN (${repos.map(() => "?").join(", ")})
       GROUP BY repo_full_name`,
    )
    .bind(workspaceName, ...repos)
    .all<{ repo: string; n: number }>();
  for (const row of results ?? []) out.set(row.repo, Number(row.n));
  return out;
}

/**
 * `pull_request` webhook write-through: title + state from the payload onto
 * the PR's existing rollup row. UPDATE only (rows come from media writes).
 * Gated to rows whose repo is linked to the row's own workspace: rows are
 * created from client-writable `gh.*` metadata, so without the gate another
 * workspace could fabricate a row and receive a private PR title. Unlinked
 * rows heal through the `/pulls` backfill instead. Never throws.
 */
export async function applyPrActivityWebhook(
  db: D1Queryable,
  input: { repo: string; number: number; title: string; state: PrState },
): Promise<void> {
  const ref = `${input.repo.toLowerCase()}#${input.number}`;
  try {
    await db
      .prepare(
        `UPDATE github_pr_activity SET title = ?, state = ?
         WHERE ref = ?
           AND EXISTS (
             SELECT 1 FROM github_repo_links l
             WHERE l.repo_full_name = github_pr_activity.repo_full_name
               AND l.workspace_name = github_pr_activity.workspace_name
           )`,
      )
      .bind(input.title, input.state, ref)
      .run();
  } catch (err) {
    console.error(
      JSON.stringify({
        message: "pr activity webhook update failed",
        ref,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}

/**
 * Lazy fill from the `/pulls` handler: rows whose resolved title/state
 * differs from the stored one. Scoped to `workspaceName`: a row is only
 * written while it still belongs to the caller's workspace. Invalid states
 * are skipped. Never throws.
 */
export async function backfillPrActivityState(
  db: D1Queryable,
  workspaceName: string,
  rows: Array<{ ref: string; title: string; state: string }>,
): Promise<void> {
  const valid = rows.filter((row) => isPrState(row.state));
  if (valid.length === 0) return;
  try {
    await db.batch(
      valid.map((row) =>
        db
          .prepare(
            `UPDATE github_pr_activity SET title = ?, state = ?
             WHERE ref = ? AND workspace_name = ?`,
          )
          .bind(row.title, row.state, row.ref, workspaceName),
      ),
    );
  } catch (err) {
    console.error(
      JSON.stringify({
        message: "pr activity backfill failed",
        count: valid.length,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}
