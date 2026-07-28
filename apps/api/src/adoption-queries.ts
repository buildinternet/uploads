/**
 * Read side of the adoption metrics (`daily_metrics`).
 *
 * Deliberately pure `(db, range) => data` with no Hono/Request dependency, so
 * a future digest-email cron can call these directly instead of making an
 * HTTP hop through /admin-ui.
 *
 * D1 bills rows read, so every query here is windowed by `day >= ?` and is
 * served from one of the two covering indexes:
 *   - platform-level reads hit `daily_metrics_platform_idx` (partial on
 *     `workspace = ''`) and cost one entry per day in the window, regardless
 *     of how many workspaces exist;
 *   - per-workspace reads hit `daily_metrics_window_idx`, which carries
 *     count/bytes so there is no per-row table lookup. The table is sparse —
 *     a row exists only for a (metric, day, workspace) with real activity —
 *     so that scan is proportional to actual usage, not workspaces × days.
 */

import type { AdoptionMetric } from "./adoption";
import { utcDay } from "./adoption";

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
  db: D1Database,
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
  db: D1Database,
  since: string,
  limit = DEFAULT_LIMIT,
): Promise<WorkspaceActivity[]> {
  const result = await db
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
    .all<WorkspaceActivity>();
  return result.results;
}

/** Workspaces that uploaded at least once in the window. */
export async function activeWorkspaceCount(db: D1Database, since: string): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(DISTINCT workspace) AS n FROM daily_metrics
       WHERE metric = 'upload' AND workspace <> '' AND day >= ?`,
    )
    .bind(since)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** Per-metric event totals in the window, from platform rows only. */
export async function featureTotals(
  db: D1Database,
  since: string,
): Promise<Record<string, number>> {
  const result = await db
    .prepare(
      `SELECT metric, SUM(count) AS total FROM daily_metrics
       WHERE workspace = '' AND day >= ?
       GROUP BY metric`,
    )
    .bind(since)
    .all<{ metric: string; total: number }>();
  const totals: Record<string, number> = {};
  for (const row of result.results) totals[row.metric] = row.total;
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
  db: D1Database,
): Promise<{ workspaces: number; storedBytes: number }> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS workspaces, COALESCE(SUM(bytes), 0) AS storedBytes FROM workspace_usage`,
    )
    .first<{ workspaces: number; storedBytes: number }>();
  return { workspaces: row?.workspaces ?? 0, storedBytes: row?.storedBytes ?? 0 };
}
