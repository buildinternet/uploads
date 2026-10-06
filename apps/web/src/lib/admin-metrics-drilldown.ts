/**
 * Per-workspace drill-down for the operator uploads chart (`/admin/metrics`):
 * which workspaces made up a given day's bar, and one workspace's own daily
 * series for the chart filter. Input is the overview's sparse
 * `series.uploadsByWorkspace` rows; everything here is pure so the page
 * script only owns DOM wiring.
 */
import { normalizeUtcDay } from "./admin-metrics-chart";

export interface WorkspaceDayRow {
  day: string;
  workspace: string;
  count: number;
  bytes: number;
}

export interface DayContributor {
  workspace: string;
  count: number;
  bytes: number;
  /** Fraction of that day's attributed uploads, 0–1. */
  share: number;
}

/** Contributors per UTC day, busiest first (ties by name). */
export function contributorsByDay(rows: readonly WorkspaceDayRow[]): Map<string, DayContributor[]> {
  const grouped = new Map<string, WorkspaceDayRow[]>();
  for (const row of rows) {
    const day = normalizeUtcDay(row.day);
    if (!day || !row.workspace) continue;
    const list = grouped.get(day) ?? [];
    list.push(row);
    grouped.set(day, list);
  }
  const out = new Map<string, DayContributor[]>();
  for (const [day, list] of grouped) {
    const total = list.reduce((sum, row) => sum + Math.max(0, Number(row.count) || 0), 0);
    out.set(
      day,
      list
        .map((row) => {
          const count = Math.max(0, Number(row.count) || 0);
          return {
            workspace: row.workspace,
            count,
            bytes: Math.max(0, Number(row.bytes) || 0),
            share: total > 0 ? count / total : 0,
          };
        })
        .sort((a, b) => b.count - a.count || a.workspace.localeCompare(b.workspace)),
    );
  }
  return out;
}

/** Workspaces that uploaded in the window, by total uploads descending. */
export function workspacesByVolume(rows: readonly WorkspaceDayRow[]): string[] {
  const totals = new Map<string, number>();
  for (const row of rows) {
    if (!row.workspace) continue;
    totals.set(row.workspace, (totals.get(row.workspace) ?? 0) + (Number(row.count) || 0));
  }
  return [...totals.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([workspace]) => workspace);
}

/** One workspace's uploads as sparse `{ day, value }` points for `fillCountSeries`. */
export function workspaceDayPoints(
  rows: readonly WorkspaceDayRow[],
  workspace: string,
): { day: string; value: number }[] {
  return rows
    .filter((row) => row.workspace === workspace)
    .map((row) => ({ day: row.day, value: Number(row.count) || 0 }));
}

/** Index of the largest value (latest wins a tie), or null when every value is 0. */
export function peakIndex(values: readonly number[]): number | null {
  let best: number | null = null;
  values.forEach((value, i) => {
    if (value > 0 && (best === null || value >= values[best])) best = i;
  });
  return best;
}
