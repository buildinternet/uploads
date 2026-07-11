/**
 * Workspace usage ledger — durable D1 counters for multi-tenant quotas.
 *
 * files-sdk's in-memory `usage()` plugin does not survive across Worker
 * requests and does not track net stored size after deletes. This ledger is
 * keyed by workspace (not API token): multiple tokens share one prefix.
 *
 * Metering write failures never fail the storage op. Budget checks read this
 * ledger before put (see budget.ts) when the workspace record sets caps.
 */

export interface WorkspaceUsage {
  workspace: string;
  /** Net stored bytes under the workspace (after overwrites/deletes). */
  bytes: number;
  /** Net object count under the workspace. */
  objects: number;
  /** Successful puts in the current UTC calendar month. */
  uploadsInPeriod: number;
  /** Period key `YYYY-MM` (UTC). */
  periodStart: string;
  updatedAt: string;
}

interface UsageRow {
  workspace: string;
  bytes: number;
  objects: number;
  uploads_in_period: number;
  period_start: string;
  updated_at: string;
}

export type UsageDelta = { bytes: number; objects: number; uploads: number };

/** UTC calendar month as `YYYY-MM` — the upload-budget window. */
export function usagePeriodStart(now = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function toUsage(row: UsageRow): WorkspaceUsage {
  return {
    workspace: row.workspace,
    bytes: row.bytes,
    objects: row.objects,
    uploadsInPeriod: row.uploads_in_period,
    periodStart: row.period_start,
    updatedAt: row.updated_at,
  };
}

export function emptyUsage(workspace: string, now = new Date()): WorkspaceUsage {
  return {
    workspace,
    bytes: 0,
    objects: 0,
    uploadsInPeriod: 0,
    periodStart: usagePeriodStart(now),
    updatedAt: now.toISOString(),
  };
}

export async function getWorkspaceUsage(
  db: D1Database,
  workspace: string,
  now = new Date(),
): Promise<WorkspaceUsage> {
  const row = await db
    .prepare(
      `SELECT workspace, bytes, objects, uploads_in_period, period_start, updated_at
       FROM workspace_usage WHERE workspace = ? LIMIT 1`,
    )
    .bind(workspace)
    .first<UsageRow>();

  if (!row) return emptyUsage(workspace, now);

  const period = usagePeriodStart(now);
  if (row.period_start === period) return toUsage(row);
  // New month: surface zero uploads without waiting for a put.
  return { ...toUsage(row), uploadsInPeriod: 0, periodStart: period };
}

/** Apply a delta. `bytes`/`objects` may be negative; `uploads` only on puts. */
export async function applyUsageDelta(
  db: D1Database,
  workspace: string,
  delta: UsageDelta,
  now = new Date(),
): Promise<void> {
  if (delta.bytes === 0 && delta.objects === 0 && delta.uploads === 0) return;

  const period = usagePeriodStart(now);
  const updatedAt = now.toISOString();

  // Ensure row, then update — clearer than a 13-bind upsert, same effect.
  await db.batch([
    db
      .prepare(
        `INSERT OR IGNORE INTO workspace_usage
           (workspace, bytes, objects, uploads_in_period, period_start, updated_at)
         VALUES (?, 0, 0, 0, ?, ?)`,
      )
      .bind(workspace, period, updatedAt),
    db
      .prepare(
        `UPDATE workspace_usage SET
           bytes = MAX(0, bytes + ?),
           objects = MAX(0, objects + ?),
           uploads_in_period = CASE
             WHEN period_start = ? THEN uploads_in_period + ?
             ELSE MAX(0, ?)
           END,
           period_start = ?,
           updated_at = ?
         WHERE workspace = ?`,
      )
      .bind(
        delta.bytes,
        delta.objects,
        period,
        delta.uploads,
        delta.uploads,
        period,
        updatedAt,
        workspace,
      ),
  ]);
}

/** Best-effort metering: log and continue if D1 fails. */
export async function recordUsageSafe(
  db: D1Database,
  workspace: string,
  delta: UsageDelta,
  now = new Date(),
): Promise<void> {
  try {
    await applyUsageDelta(db, workspace, delta, now);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      JSON.stringify({ message: "usage ledger update failed", workspace, delta, error: message }),
    );
  }
}

/**
 * Replace absolute bytes/objects from a storage scan (reconcile).
 * Preserves uploads_in_period for the current period when the row exists.
 */
export async function setUsageTotals(
  db: D1Database,
  workspace: string,
  totals: { bytes: number; objects: number },
  now = new Date(),
): Promise<WorkspaceUsage> {
  const period = usagePeriodStart(now);
  const updatedAt = now.toISOString();
  const bytes = Math.max(0, Math.floor(totals.bytes));
  const objects = Math.max(0, Math.floor(totals.objects));

  await db.batch([
    db
      .prepare(
        `INSERT OR IGNORE INTO workspace_usage
           (workspace, bytes, objects, uploads_in_period, period_start, updated_at)
         VALUES (?, ?, ?, 0, ?, ?)`,
      )
      .bind(workspace, bytes, objects, period, updatedAt),
    db
      .prepare(
        `UPDATE workspace_usage SET
           bytes = ?,
           objects = ?,
           updated_at = ?
         WHERE workspace = ?`,
      )
      .bind(bytes, objects, updatedAt, workspace),
  ]);

  return getWorkspaceUsage(db, workspace, now);
}
