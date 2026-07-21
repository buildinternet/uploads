/**
 * Workspace<->repo binding (`github_repo_links` D1 table), phase 3 of the
 * GitHub App integration. One repo maps to at most one workspace —
 * "first claim wins": `recordRepoLink` uses `INSERT OR IGNORE`, so a second
 * workspace that later comments/promotes against an already-linked repo
 * never steals or overwrites the binding. This narrows the webhook
 * auto-promotion path (github-webhook.ts) to a single, previously-proven
 * workspace per repo, without touching the existing any-workspace-can-call
 * `/github/comment` and `/github/promote` endpoints (those stay
 * workspace-authed and unaffected by binding).
 *
 * There is no explicit claim command yet (deferred to the CLI-side
 * `uploads github link`, PR #311) — the only way a link is created today is
 * implicitly, as a side effect of a successful authenticated comment or
 * promote call (see routes/github-comment.ts, routes/github-promote.ts).
 */

export interface RepoLink {
  repo: string;
  workspaceName: string;
  installationId: number | null;
  source: string;
  createdAt: string;
}

interface RepoLinkRow {
  repo_full_name: string;
  workspace_name: string;
  installation_id: number | null;
  source: string;
  created_at: string;
}

function normalizeRepo(repo: string): string {
  return repo.toLowerCase();
}

function rowToLink(row: RepoLinkRow): RepoLink {
  return {
    repo: row.repo_full_name,
    workspaceName: row.workspace_name,
    installationId: row.installation_id,
    source: row.source,
    createdAt: row.created_at,
  };
}

/**
 * Best-effort claim: first caller to link a repo wins, and later calls for
 * the same repo (from any workspace, including the same one) are silently
 * ignored (`INSERT OR IGNORE` on the primary key). Never throws — a D1 blip
 * here must not affect the comment/promote response it rides along with;
 * failures are logged and swallowed.
 */
export async function recordRepoLink(
  db: D1Database,
  repo: string,
  workspaceName: string,
  source: string,
  installationId: number | null = null,
  now = new Date(),
): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT OR IGNORE INTO github_repo_links
           (repo_full_name, workspace_name, installation_id, source, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(normalizeRepo(repo), workspaceName, installationId, source, now.toISOString())
      .run();
  } catch (err) {
    console.error(
      JSON.stringify({
        message: "repo link record failed",
        repo,
        workspaceName,
        source,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}

/** The workspace bound to `repo`, or null if unclaimed. Never throws (callers treat a D1 failure as "no link"). */
export async function findRepoLink(db: D1Database, repo: string): Promise<RepoLink | null> {
  try {
    const row = await db
      .prepare(`SELECT * FROM github_repo_links WHERE repo_full_name = ?`)
      .bind(normalizeRepo(repo))
      .first<RepoLinkRow>();
    return row ? rowToLink(row) : null;
  } catch (err) {
    console.error(
      JSON.stringify({
        message: "repo link lookup failed",
        repo,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return null;
  }
}

/**
 * Removes a stale link (e.g. its workspace was deleted/tombstoned). Never
 * throws — cleanup is best-effort; a failed delete just means the next
 * webhook delivery re-discovers the same stale state and retries the cleanup.
 */
export async function deleteRepoLink(db: D1Database, repo: string): Promise<void> {
  try {
    await db
      .prepare(`DELETE FROM github_repo_links WHERE repo_full_name = ?`)
      .bind(normalizeRepo(repo))
      .run();
  } catch (err) {
    console.error(
      JSON.stringify({
        message: "repo link delete failed",
        repo,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}

/**
 * Self-serve unlink (issue #318): removes `repo`'s binding only if it is
 * currently owned by `workspaceName`. Unlike `deleteRepoLink` (used for
 * best-effort cleanup of stale/tombstoned-workspace links), this throws on a
 * D1 failure — the caller (routes/github-link.ts) needs to know whether the
 * delete actually happened rather than silently reporting success.
 * Returns true only if a row owned by `workspaceName` was deleted.
 */
export async function deleteRepoLinkForWorkspace(
  db: D1Database,
  repo: string,
  workspaceName: string,
): Promise<boolean> {
  const result = await db
    .prepare(`DELETE FROM github_repo_links WHERE repo_full_name = ? AND workspace_name = ?`)
    .bind(normalizeRepo(repo), workspaceName)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

/**
 * All repos currently bound to `workspaceName` (admin visibility, issue
 * #318) — surfaced in the admin panel so an operator can see what a
 * workspace has claimed without querying D1 directly.
 */
export async function listRepoLinksForWorkspace(
  db: D1Database,
  workspaceName: string,
): Promise<RepoLink[]> {
  const { results } = await db
    .prepare(`SELECT * FROM github_repo_links WHERE workspace_name = ? ORDER BY created_at DESC`)
    .bind(workspaceName)
    .all<RepoLinkRow>();
  return (results ?? []).map(rowToLink);
}

/**
 * Operator override (issue #318): forcibly (re)assigns `repo` to
 * `workspaceName`, overwriting any existing owner — unlike `recordRepoLink`'s
 * `INSERT OR IGNORE` first-claim-wins semantics. Used only from the
 * admin-gated route; self-serve callers never get this power.
 */
export async function setRepoLink(
  db: D1Database,
  repo: string,
  workspaceName: string,
  source: string,
  installationId: number | null = null,
  now = new Date(),
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO github_repo_links
         (repo_full_name, workspace_name, installation_id, source, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(repo_full_name) DO UPDATE SET
         workspace_name = excluded.workspace_name,
         installation_id = excluded.installation_id,
         source = excluded.source,
         created_at = excluded.created_at`,
    )
    .bind(normalizeRepo(repo), workspaceName, installationId, source, now.toISOString())
    .run();
}
