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
 * branch never clobbers a previously recorded one.
 */
export async function recordPrMediaActivity(
  db: D1Database,
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
  db: D1Database,
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
  db: D1Database,
  workspaceName: string,
  limit: number,
): Promise<PrActivity[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM github_pr_activity
       WHERE workspace_name = ?
       ORDER BY last_media_at DESC
       LIMIT ?`,
    )
    .bind(workspaceName, limit)
    .all<PrActivityRow>();
  return (results ?? []).map(rowToActivity);
}
