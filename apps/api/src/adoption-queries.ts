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

/** Per-workspace upload activity in the window, busiest first. */
export async function workspaceActivity(
  db: D1Queryable,
  since: string,
  limit = DEFAULT_LIMIT,
): Promise<WorkspaceActivity[]> {
  const [result, linked] = await Promise.all([
    db
      .prepare(
        `SELECT workspace,
                SUM(count) AS uploads,
                SUM(bytes) AS bytes,
                MAX(day)   AS lastActive
         FROM daily_metrics
         WHERE metric = 'upload' AND workspace <> '' AND day >= ?
         GROUP BY workspace
         ORDER BY uploads DESC, workspace ASC
         LIMIT ?`,
      )
      .bind(since, limit)
      .all<Omit<WorkspaceActivity, "githubApp">>(),
    workspacesWithGithubApp(db),
  ]);
  return result.results.map((row) => ({ ...row, githubApp: linked.has(row.workspace) }));
}

/**
 * Workspace names with at least one `github_repo_links` row whose
 * `installation_id` is set — i.e. the workspace has the GitHub App
 * installed, not merely a self-serve repo link (`installation_id IS NULL`).
 * One query, joined against callers in JS rather than a SQL join, since the
 * set of linked workspaces is small and shared by both `workspaceActivity`
 * and the `workspacesWithGithubApp` total.
 */
export async function workspacesWithGithubApp(db: D1Queryable): Promise<Set<string>> {
  const result = await db
    .prepare(
      `SELECT DISTINCT workspace_name FROM github_repo_links WHERE installation_id IS NOT NULL`,
    )
    .all<{ workspace_name: string }>();
  return new Set(result.results.map((row) => row.workspace_name));
}

/** One row per workspace that uploaded at least once since `since`, with its most recent active day. */
export interface ActiveWorkspace {
  workspace: string;
  lastActive: string;
}

/**
 * Workspaces active (at least one upload) since `since`, one row each with
 * their most recent active day. Scans the window ONCE so callers who need
 * both a 7-day and a 30-day active-workspace count can derive both from a
 * single 30-day call — `buildOverview` (metrics-overview.ts) does exactly
 * this — instead of the 30-day window's rows being read twice (D1 bills rows
 * read, and the last 7 days are always a subset of the last 30).
 */
export async function activeWorkspacesSince(
  db: D1Queryable,
  since: string,
): Promise<ActiveWorkspace[]> {
  const result = await db
    .prepare(
      `SELECT workspace, MAX(day) AS lastActive FROM daily_metrics
       WHERE metric = 'upload' AND workspace <> '' AND day >= ?
       GROUP BY workspace`,
    )
    .bind(since)
    .all<ActiveWorkspace>();
  return result.results;
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
