/**
 * Read side of the adoption metrics (`daily_metrics`).
 *
 * Deliberately pure `(db, range) => data` with no Hono/Request dependency, so
 * a future digest-email cron can call these directly instead of making an
 * HTTP hop through /admin-ui.
 *
 * D1 bills rows read, so every query here binds both `metric` and `day >= ?`
 * and is served from one of the two covering indexes:
 *   - platform-level reads hit `daily_metrics_platform_idx` (partial on
 *     `workspace = ''`), which is keyed `(metric, day, ...)`. Binding
 *     `metric` lets D1 SEEK straight to the window instead of scanning the
 *     whole partial index with `day >= ?` as a residual filter, so cost is
 *     one entry per day in the window (per metric), regardless of how many
 *     workspaces exist. `featureTotals` needs a total per metric, so it
 *     issues one bound-`metric` query per `ADOPTION_METRICS` entry, batched
 *     into a single round trip, rather than a single unbound `GROUP BY
 *     metric` query — the latter would leave the index's leading column
 *     unconstrained and force a full scan;
 *   - per-workspace reads hit `daily_metrics_window_idx`, which carries
 *     count/bytes so there is no per-row table lookup. The table is sparse —
 *     a row exists only for a (metric, day, workspace) with real activity —
 *     so that scan is proportional to actual usage, not workspaces × days.
 *     That scan happens ONCE, in `workspaceDaySeries`; the per-workspace
 *     activity table and active-workspace counts are derived from its rows by
 *     the pure helpers below (`deriveWorkspaceActivity`,
 *     `countActiveWorkspaces`, `rowsSince`) rather than by re-querying the
 *     same rows with different GROUP BYs.
 */

import type { AdoptionMetric } from "./adoption";
import { ADOPTION_METRICS, utcDay } from "./adoption";
import { type D1Queryable } from "./db-session";

export interface DayPoint {
  day: string;
  count: number;
  bytes: number;
}

export interface WorkspaceActivity {
  workspace: string;
  uploads: number;
  bytes: number;
  /** Most recent day with an upload, `YYYY-MM-DD`. */
  lastActive: string;
  /** Whether the workspace has any `github_repo_links` row with a non-null `installation_id`. */
  githubApp: boolean;
}

/** Default cap on the per-workspace table. */
const DEFAULT_LIMIT = 100;

/**
 * Inclusive first day of an N-day window ending today, `YYYY-MM-DD`.
 * `days = 1` means today only.
 */
export function windowStart(days: number, now = new Date()): string {
  const start = new Date(now.getTime());
  start.setUTCDate(start.getUTCDate() - (Math.max(1, Math.floor(days)) - 1));
  return utcDay(start);
}

/** Daily platform totals for one metric. One index entry per day in window. */
export async function platformSeries(
  db: D1Queryable,
  metric: AdoptionMetric,
  since: string,
): Promise<DayPoint[]> {
  const result = await db
    .prepare(
      `SELECT day, count, bytes FROM daily_metrics
       WHERE metric = ? AND workspace = '' AND day >= ?
       ORDER BY day`,
    )
    .bind(metric, since)
    .all<DayPoint>();
  return result.results;
}

/** One workspace's upload count on one day. */
export interface WorkspaceDayPoint {
  day: string;
  workspace: string;
  count: number;
  bytes: number;
}

/**
 * Every (day, workspace) upload row in the window, busiest workspace first
 * within each day — the drill-down behind the platform uploads chart ("who
 * caused this spike"). Served entirely from `daily_metrics_window_idx`, and
 * the table is sparse, so cost is one entry per workspace per active day.
 *
 * This is the single per-workspace read: callers needing a shorter window,
 * the per-workspace totals, or active-workspace counts fetch the widest
 * window they need and narrow it in JS with the helpers below.
 */
export async function workspaceDaySeries(
  db: D1Queryable,
  since: string,
): Promise<WorkspaceDayPoint[]> {
  const result = await db
    .prepare(
      `SELECT day, workspace, count, bytes FROM daily_metrics
       WHERE metric = 'upload' AND workspace <> '' AND day >= ?
       ORDER BY day ASC, count DESC, workspace ASC`,
    )
    .bind(since)
    .all<WorkspaceDayPoint>();
  return result.results;
}

/** Rows on or after `since` (`YYYY-MM-DD` compares lexically). Preserves order. */
export function rowsSince(rows: WorkspaceDayPoint[], since: string): WorkspaceDayPoint[] {
  return rows.filter((row) => row.day >= since);
}

/**
 * Per-workspace totals for the window starting at `since`, busiest first
 * (uploads DESC, workspace ASC), capped at `limit`. Pure derivation from
 * `workspaceDaySeries` rows; `githubApp` is the set from
 * `workspacesWithGithubApp`, passed in so it is queried once per build.
 */
export function deriveWorkspaceActivity(
  rows: WorkspaceDayPoint[],
  since: string,
  githubApp: ReadonlySet<string>,
  limit = DEFAULT_LIMIT,
): WorkspaceActivity[] {
  const byWorkspace = new Map<string, Omit<WorkspaceActivity, "githubApp">>();
  for (const row of rows) {
    if (row.day < since) continue;
    const entry = byWorkspace.get(row.workspace);
    if (entry) {
      entry.uploads += row.count;
      entry.bytes += row.bytes;
      if (row.day > entry.lastActive) entry.lastActive = row.day;
    } else {
      byWorkspace.set(row.workspace, {
        workspace: row.workspace,
        uploads: row.count,
        bytes: row.bytes,
        lastActive: row.day,
      });
    }
  }
  return [...byWorkspace.values()]
    .sort((a, b) => b.uploads - a.uploads || (a.workspace < b.workspace ? -1 : 1))
    .slice(0, limit)
    .map((entry) => ({ ...entry, githubApp: githubApp.has(entry.workspace) }));
}

/** Distinct workspaces with at least one upload row on or after `since`. */
export function countActiveWorkspaces(rows: WorkspaceDayPoint[], since: string): number {
  const active = new Set<string>();
  for (const row of rows) if (row.day >= since) active.add(row.workspace);
  return active.size;
}

/**
 * Workspace names with at least one `github_repo_links` row whose
 * `installation_id` is set — i.e. the workspace has the GitHub App
 * installed, not merely a self-serve repo link (`installation_id IS NULL`).
 * One query, joined against callers in JS rather than a SQL join, since the
 * set of linked workspaces is small and shared by both the per-workspace
 * activity table and the `workspacesWithGithubApp` total.
 */
export async function workspacesWithGithubApp(db: D1Queryable): Promise<Set<string>> {
  const result = await db
    .prepare(
      `SELECT DISTINCT workspace_name FROM github_repo_links WHERE installation_id IS NOT NULL`,
    )
    .all<{ workspace_name: string }>();
  return new Set(result.results.map((row) => row.workspace_name));
}

/**
 * Per-metric event totals in the window, from platform rows only.
 *
 * Issues one bound-`metric` query per entry in `ADOPTION_METRICS`, batched
 * into a single round trip, rather than one unbound `GROUP BY metric` query.
 * `metric` leads the `daily_metrics_platform_idx` index, so leaving it
 * unconstrained forces a full partial-index SCAN with `day >= ?` applied as a
 * residual filter — cost grows with total table history, not window size.
 * Binding `metric` lets each query SEEK to `(metric, day >= ?)` instead,
 * mirroring the pattern the other queries in this module already use.
 */
export async function featureTotals(
  db: D1Queryable,
  since: string,
): Promise<Record<string, number>> {
  const results = await db.batch<{ total: number | null }>(
    ADOPTION_METRICS.map((metric) =>
      db
        .prepare(
          `SELECT SUM(count) AS total FROM daily_metrics
           WHERE metric = ? AND workspace = '' AND day >= ?`,
        )
        .bind(metric, since),
    ),
  );
  const totals: Record<string, number> = {};
  ADOPTION_METRICS.forEach((metric, index) => {
    const total = results[index]?.results[0]?.total;
    if (typeof total === "number") totals[metric] = total;
  });
  return totals;
}

/**
 * Current platform-wide state, read from `workspace_usage` — the source of
 * truth for absolute stored bytes. Deliberately NOT derived from
 * `daily_metrics`, which only describes change over time and would drift.
 *
 * `workspaces` counts workspaces with at least one recorded upload (a
 * `workspace_usage` row). Registered-but-idle workspaces are not included —
 * the organizations total from the auth worker is the registration figure.
 * One aggregate over a table with one row per workspace.
 */
export async function platformStorage(
  db: D1Queryable,
): Promise<{ workspaces: number; storedBytes: number }> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS workspaces, COALESCE(SUM(bytes), 0) AS storedBytes FROM workspace_usage`,
    )
    .first<{ workspaces: number; storedBytes: number }>();
  return { workspaces: row?.workspaces ?? 0, storedBytes: row?.storedBytes ?? 0 };
}

/** One workspace with more than one distinct minting user actively minting tokens. */
export interface MultiIdentityWorkspace {
  workspace: string;
  users: number;
}

/**
 * Workspaces whose `auth_tokens` carry two or more distinct non-null
 * `minting_user_id` values — a revisit trigger for the actor-on-PR gate
 * (issue #579): once multiple people mint tokens for the same workspace, the
 * "is the caller the actor" gate starts mattering more than it does for a
 * single-identity workspace. Read-only; no writes. All tokens count
 * (revoked/expired included) since the signal is "has this workspace ever
 * had multiple minters", not "how many active tokens exist right now".
 */
export async function multiIdentityWorkspaces(
  db: D1Queryable,
  limit = DEFAULT_LIMIT,
): Promise<MultiIdentityWorkspace[]> {
  const result = await db
    .prepare(
      `SELECT workspace, COUNT(DISTINCT minting_user_id) AS users
       FROM auth_tokens
       WHERE minting_user_id IS NOT NULL
       GROUP BY workspace
       HAVING COUNT(DISTINCT minting_user_id) >= 2
       ORDER BY users DESC, workspace ASC
       LIMIT ?`,
    )
    .bind(limit)
    .all<MultiIdentityWorkspace>();
  return result.results;
}
