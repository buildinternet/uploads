/**
 * Per-workspace drill-down for the operator uploads chart (`/admin/metrics`):
 * which workspaces made up a given day's bar, and one workspace's own daily
 * series for the chart filter. Built once per overview from its sparse
 * `series.uploadsByWorkspace` rows; pure so the page script only owns DOM
 * wiring.
 */
import type { MetricsOverview } from "@uploads/api/admin-ui";
import { normalizeUtcDay } from "./admin-metrics-chart";

export type WorkspaceDayRow = MetricsOverview["series"]["uploadsByWorkspace"][number];

export interface DayContributor {
  workspace: string;
  count: number;
  bytes: number;
  /** Fraction of that day's attributed uploads, 0–1. */
  share: number;
}

export interface UploadDrilldown {
  /** Per UTC day: attributed total and contributors, busiest first (ties by name). */
  byDay: Map<string, { total: number; contributors: DayContributor[] }>;
  /** Each workspace's sparse `{ day, value }` points, for `fillCountSeries`. */
  byWorkspace: Map<string, { day: string; value: number }[]>;
  /** Workspaces that uploaded in the window, by total uploads descending. */
  workspaces: string[];
}

const nonNegative = (value: unknown): number => Math.max(0, Number(value) || 0);

export function buildUploadDrilldown(rows: readonly WorkspaceDayRow[]): UploadDrilldown {
  const byDay: UploadDrilldown["byDay"] = new Map();
  const byWorkspace: UploadDrilldown["byWorkspace"] = new Map();
  const volume = new Map<string, number>();

  for (const row of rows) {
    const day = normalizeUtcDay(row.day);
    if (!day || !row.workspace) continue;
    const count = nonNegative(row.count);
    const entry = byDay.get(day) ?? { total: 0, contributors: [] };
    entry.total += count;
    entry.contributors.push({
      workspace: row.workspace,
      count,
      bytes: nonNegative(row.bytes),
      share: 0,
    });
    byDay.set(day, entry);

    const points = byWorkspace.get(row.workspace) ?? [];
    points.push({ day, value: count });
    byWorkspace.set(row.workspace, points);
    volume.set(row.workspace, (volume.get(row.workspace) ?? 0) + count);
  }

  for (const { total, contributors } of byDay.values()) {
    for (const c of contributors) c.share = total > 0 ? c.count / total : 0;
    contributors.sort((a, b) => b.count - a.count || a.workspace.localeCompare(b.workspace));
  }

  const workspaces = [...volume.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([workspace]) => workspace);

  return { byDay, byWorkspace, workspaces };
}

/** Index of the largest value (latest wins a tie), or null when every value is 0. */
export function peakIndex(values: readonly number[]): number | null {
  let best: number | null = null;
  values.forEach((value, i) => {
    if (value > 0 && (best === null || value >= values[best])) best = i;
  });
  return best;
}
