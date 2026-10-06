/**
 * Helpers for the operator uploads drill-down (`/admin/metrics`). The overview
 * carries only a bounded per-day top-contributors summary; the full day table
 * and a single workspace's series are fetched on demand from
 * `/admin-ui/metrics/uploads/{day,workspace}`. Pure so the page script only
 * owns DOM wiring and fetching.
 */
import type { MetricsOverview } from "@uploads/api/admin-ui";
import { normalizeUtcDay } from "./admin-metrics-chart";

export type UploadDaySummary = MetricsOverview["series"]["uploadsByDay"][number];

/** Response of `GET /admin-ui/metrics/uploads/day`. */
export interface UploadsDayResponse {
  day: string;
  total: number;
  contributors: { workspace: string; count: number; bytes: number }[];
}

/** Response of `GET /admin-ui/metrics/uploads/workspace`. */
export interface UploadsWorkspaceResponse {
  workspace: string;
  window: { days: number; since: string };
  series: { day: string; count: number; bytes: number }[];
}

export interface DayContributor {
  workspace: string;
  count: number;
  bytes: number;
  /** Fraction of that day's attributed uploads, 0–1. */
  share: number;
}

const nonNegative = (value: unknown): number => Math.max(0, Number(value) || 0);

/** Index the overview's per-day summary by normalized UTC day. */
export function indexDaySummaries(
  rows: readonly UploadDaySummary[] | undefined,
): Map<string, UploadDaySummary> {
  const byDay = new Map<string, UploadDaySummary>();
  for (const row of rows ?? []) {
    const day = normalizeUtcDay(row.day);
    if (day) byDay.set(day, { ...row, day, total: nonNegative(row.total) });
  }
  return byDay;
}

/** Attach each contributor's share of the day's total, busiest first. */
export function withShares(response: UploadsDayResponse): DayContributor[] {
  const total = nonNegative(response.total);
  return response.contributors.map((c) => ({
    workspace: c.workspace,
    count: nonNegative(c.count),
    bytes: nonNegative(c.bytes),
    share: total > 0 ? nonNegative(c.count) / total : 0,
  }));
}

/** Index of the largest value (latest wins a tie), or null when every value is 0. */
export function peakIndex(values: readonly number[]): number | null {
  let best: number | null = null;
  values.forEach((value, i) => {
    if (value > 0 && (best === null || value >= values[best])) best = i;
  });
  return best;
}
