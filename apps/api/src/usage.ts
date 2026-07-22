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

export type UploadReservation =
  | { ok: true }
  | { ok: false; usage: WorkspaceUsage; maxUploadsPerPeriod: number };

/**
 * Atomically reserve `count` uploads against the monthly budget BEFORE the
 * paid work (Browser Run render / R2 put) happens. A guarded UPDATE increments
 * `uploads_in_period` only while the workspace stays within
 * `maxUploadsPerPeriod`, so concurrent requests at the cap boundary cannot all
 * pass a read-then-check and overshoot the cap. Callers must
 * `releaseUploadsSafe` the reservation if the work fails, and must NOT count
 * the upload again in their post-work `recordUsageSafe` delta.
 *
 * Unlike recordUsageSafe this throws on D1 failure — the budget gate is a
 * precondition of the work, not best-effort metering.
 */
export async function reserveUploads(
  db: D1Database,
  workspace: string,
  count: number,
  maxUploadsPerPeriod: number | undefined,
  now = new Date(),
): Promise<UploadReservation> {
  if (maxUploadsPerPeriod === undefined) {
    // Unlimited: still count at reservation time so failure/release semantics
    // stay uniform with capped workspaces.
    await applyUsageDelta(db, workspace, { bytes: 0, objects: 0, uploads: count }, now);
    return { ok: true };
  }

  const period = usagePeriodStart(now);
  const updatedAt = now.toISOString();

  // Ensure row, then a conditional increment: the WHERE clause re-derives the
  // current period's upload count (a stale period_start means the month rolled
  // over, so it counts as 0) and only matches while the guarded increment
  // stays within the cap. `meta.changes === 0` means the budget is spent.
  const results = await db.batch([
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
           uploads_in_period = (CASE WHEN period_start = ? THEN uploads_in_period ELSE 0 END) + ?,
           period_start = ?,
           updated_at = ?
         WHERE workspace = ?
           AND (CASE WHEN period_start = ? THEN uploads_in_period ELSE 0 END) + ? <= ?`,
      )
      .bind(period, count, period, updatedAt, workspace, period, count, maxUploadsPerPeriod),
  ]);

  const changes = results[1]?.meta?.changes ?? 0;
  if (changes > 0) return { ok: true };
  return { ok: false, usage: await getWorkspaceUsage(db, workspace, now), maxUploadsPerPeriod };
}

/**
 * Return a reservation taken by `reserveUploads` after the reserved work
 * failed. Best-effort like recordUsageSafe: the reservation is already spent
 * budget, so a failed release only over-counts (never under-counts). A release
 * that lands after the month rolled over is a deliberate no-op — the
 * reservation belonged to the old period.
 */
export async function releaseUploadsSafe(
  db: D1Database,
  workspace: string,
  count: number,
  now = new Date(),
): Promise<void> {
  const period = usagePeriodStart(now);
  try {
    await db
      .prepare(
        `UPDATE workspace_usage SET
           uploads_in_period = CASE
             WHEN period_start = ? THEN MAX(0, uploads_in_period - ?)
             ELSE uploads_in_period
           END,
           updated_at = ?
         WHERE workspace = ?`,
      )
      .bind(period, count, now.toISOString(), workspace)
      .run();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      JSON.stringify({
        message: "upload reservation release failed",
        workspace,
        count,
        error: message,
      }),
    );
  }
}

export type StorageReservation =
  | { ok: true; reservedBytes: number }
  | { ok: false; usage: WorkspaceUsage; maxStorageBytes: number; deltaBytes: number };

/**
 * Atomically reserve a positive net-byte delta against `maxStorageBytes`
 * BEFORE the R2 put. Mirrors `reserveUploads` for the storage cap so
 * concurrent puts near the quota cannot all pass a read-then-check and
 * overshoot. No-ops (ok, reservedBytes 0) when `deltaBytes <= 0` or the
 * workspace is unlimited. Callers must `releaseStorageBytesSafe` on failed
 * work and must NOT re-count reserved bytes in `recordUsageSafe`.
 */
export async function reserveStorageBytes(
  db: D1Database,
  workspace: string,
  deltaBytes: number,
  maxStorageBytes: number | undefined,
  now = new Date(),
): Promise<StorageReservation> {
  if (deltaBytes <= 0) return { ok: true, reservedBytes: 0 };
  if (maxStorageBytes === undefined) return { ok: true, reservedBytes: 0 };

  const period = usagePeriodStart(now);
  const updatedAt = now.toISOString();

  const results = await db.batch([
    db
      .prepare(
        `INSERT OR IGNORE INTO workspace_usage
           (workspace, bytes, objects, uploads_in_period, period_start, updated_at)
         VALUES (?, 0, 0, 0, ?, ?)`,
      )
      .bind(workspace, period, updatedAt),
    // Distinct predicate fragment (`bytes + ? <= ?`) so fakes/tests can
    // distinguish this from the upload-count reservation (`uploads… <= ?`).
    db
      .prepare(
        `UPDATE workspace_usage SET
           bytes = bytes + ?,
           updated_at = ?
         WHERE workspace = ?
           AND bytes + ? <= ?`,
      )
      .bind(deltaBytes, updatedAt, workspace, deltaBytes, maxStorageBytes),
  ]);

  const changes = results[1]?.meta?.changes ?? 0;
  if (changes > 0) return { ok: true, reservedBytes: deltaBytes };
  return {
    ok: false,
    usage: await getWorkspaceUsage(db, workspace, now),
    maxStorageBytes,
    deltaBytes,
  };
}

/**
 * Undo a `reserveStorageBytes` reservation after the R2 write failed.
 * Best-effort (same rationale as releaseUploadsSafe).
 */
export async function releaseStorageBytesSafe(
  db: D1Database,
  workspace: string,
  reservedBytes: number,
  now = new Date(),
): Promise<void> {
  if (reservedBytes <= 0) return;
  try {
    await db
      .prepare(
        `UPDATE workspace_usage SET
           bytes = MAX(0, bytes - ?),
           updated_at = ?
         WHERE workspace = ?`,
      )
      .bind(reservedBytes, now.toISOString(), workspace)
      .run();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      JSON.stringify({
        message: "storage reservation release failed",
        workspace,
        reservedBytes,
        error: message,
      }),
    );
  }
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
