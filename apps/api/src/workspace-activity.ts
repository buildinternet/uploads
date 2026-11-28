/**
 * Member-facing workspace activity: uploads, PRs that got uploads, and
 * managed PR comment updates per UTC day. It is the one-workspace slice of the
 * operator metrics (`adoption-queries.ts`), shown on the workspace Usage tab.
 *
 * The response is one fixed span (`ACTIVITY_SPAN_DAYS`), filled to one point
 * per day, so the page can switch between 7, 30 and 90 days and compare each
 * with the period before it without another request. One KV cache entry per
 * workspace keeps repeat visits off D1.
 *
 * Both reads use existing covering indexes; nothing here writes to D1:
 *   - `daily_metrics` binds `metric IN (...)` and `day >= ?`, a seek on
 *     `daily_metrics_window_idx`. `workspace = ?` is a residual filter, so a
 *     read touches the span's sparse rows for every workspace (one per active
 *     workspace per day per metric), not the whole table.
 *   - `github_pr_activity` binds `workspace_name = ?` and `last_media_at >= ?`,
 *     a seek on `github_pr_activity_workspace_cursor_idx`. A PR counts on the
 *     day of its first upload; any PR first seen in the span was also last
 *     seen in it, so the `last_media_at` bound never drops one.
 *
 * The upload type split (image / video / other) comes from Analytics Engine,
 * the same source as the operator chart's. AE keeps 90 days and samples, so
 * the split only covers the last 90 days, and the page scales it to the D1
 * upload count rather than showing AE totals. When AE is unconfigured or
 * unreachable, `uploadTypes` is false and the days carry no split.
 */

import { utcDay } from "./adoption";
import { windowStart } from "./adoption-queries";
import type { UploadClassSeriesResult } from "./analytics-engine";
import { type D1Queryable } from "./db-session";

/** Days of history returned: two of the longest window, for the comparison. */
export const ACTIVITY_SPAN_DAYS = 180;

/** KV cache lifetime. Same as the operator overview's. */
export const ACTIVITY_CACHE_TTL = 600;

export interface ActivityDay {
  /** `YYYY-MM-DD`, UTC. */
  day: string;
  uploads: number;
  /** PRs whose first upload landed this day. */
  prs: number;
  /** Times the managed PR comment was posted or refreshed. */
  comments: number;
  /**
   * Upload type split from Analytics Engine (sampled; last 90 days only).
   * Absent when the split is unavailable for this day.
   */
  types?: { image: number; video: number; other: number };
}

export interface WorkspaceActivity {
  /** Oldest first, one entry per day, ending today (UTC). */
  days: ActivityDay[];
  /** Whether `types` was filled from Analytics Engine. */
  uploadTypes: boolean;
}

/** Days of upload type split to request: Analytics Engine's retention. */
export const UPLOAD_TYPE_DAYS = 90;

export function activityCacheKey(workspace: string): string {
  return `activity:v1:${workspace}`;
}

interface MetricRow {
  metric: string;
  day: string;
  count: number;
}

interface PrRow {
  first_media_at: string;
}

export async function buildWorkspaceActivity(
  db: D1Queryable,
  workspace: string,
  now = new Date(),
): Promise<WorkspaceActivity> {
  const since = windowStart(ACTIVITY_SPAN_DAYS, now);
  const [metrics, prs] = await Promise.all([
    db
      .prepare(
        `SELECT metric, day, count FROM daily_metrics
         WHERE metric IN ('upload', 'comment_posted') AND day >= ? AND workspace = ?`,
      )
      .bind(since, workspace)
      .all<MetricRow>(),
    db
      .prepare(
        `SELECT first_media_at FROM github_pr_activity
         WHERE workspace_name = ? AND last_media_at >= ?`,
      )
      .bind(workspace, `${since}T00:00:00.000Z`)
      .all<PrRow>(),
  ]);

  const byDay = new Map<string, ActivityDay>();
  const start = new Date(`${since}T00:00:00.000Z`);
  for (let i = 0; i < ACTIVITY_SPAN_DAYS; i++) {
    const date = new Date(start);
    date.setUTCDate(start.getUTCDate() + i);
    const day = utcDay(date);
    byDay.set(day, { day, uploads: 0, prs: 0, comments: 0 });
  }

  for (const row of metrics.results) {
    const entry = byDay.get(row.day);
    if (!entry) continue;
    if (row.metric === "upload") entry.uploads += row.count;
    else entry.comments += row.count;
  }
  for (const row of prs.results) {
    const entry = byDay.get(row.first_media_at.slice(0, 10));
    if (entry) entry.prs += 1;
  }

  return { days: [...byDay.values()], uploadTypes: false };
}

/** Adds the AE type split to the days it covers. Pure. */
export function withUploadTypes(
  activity: WorkspaceActivity,
  classes: UploadClassSeriesResult,
): WorkspaceActivity {
  if (!classes.available) return activity;
  const byDay = new Map(classes.days.map((point) => [point.day, point]));
  return {
    uploadTypes: true,
    days: activity.days.map((day) => {
      const point = byDay.get(day.day);
      return point
        ? { ...day, types: { image: point.image, video: point.video, other: point.other } }
        : day;
    }),
  };
}
