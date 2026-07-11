/**
 * App-driven retention: delete objects older than `retentionDays` on the
 * workspace record. Uses object `lastModified` from the store (R2 upload time).
 * After purge, call reconcile so the ledger matches storage.
 *
 * files-sdk notes:
 * - Walk with `listAll()` (same as reconcile) — cursor pagination, prefix-scoped.
 * - Expire with bulk `delete(keys[])` so R2/S3 use native multi-object delete
 *   instead of one request per key (see files-sdk delete bulk form).
 * - `softDelete` plugin is a recycle bin (move to `.trash`), not TTL — skip.
 * - R2 lifecycle rules via `files.raw` are bucket-wide, not per-workspace —
 *   multi-tenant prefixes need this app-level pass until we own the bucket
 *   lifecycle policy per prefix.
 */
import { positiveLimit } from "./budget";
import { reconcileWorkspaceUsage, type ReconcileResult } from "./reconcile";
import { storage } from "./storage";
import type { WorkspaceRecord } from "./workspace";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
/** Cap listed deleted keys in the response so agents don't get huge payloads. */
const MAX_KEYS_IN_RESPONSE = 100;
/**
 * Batch size for files-sdk bulk delete. S3/R2 DeleteObjects allows 1000;
 * stay under that and keep isolate memory bounded while listing.
 */
const DELETE_BATCH = 500;

export interface PurgeExpiredResult {
  workspace: string;
  retentionDays: number;
  cutoff: string;
  deleted: number;
  freedBytes: number;
  /** Sample of deleted keys (capped). */
  keys: string[];
  keysTruncated: boolean;
  reconcile: ReconcileResult;
}

export function retentionCutoff(retentionDays: number, now = new Date()): Date {
  return new Date(now.getTime() - retentionDays * MS_PER_DAY);
}

function isExpired(lastModified: Date | number | undefined, cutoff: Date): boolean {
  if (lastModified === undefined) return false;
  const modified = lastModified instanceof Date ? lastModified : new Date(lastModified);
  return !Number.isNaN(modified.getTime()) && modified < cutoff;
}

/**
 * Delete objects last-modified before the retention window. No-ops when
 * `retentionDays` is unset. Always re-reconciles so the ledger matches storage.
 */
export async function purgeExpiredObjects(
  env: Env,
  ws: WorkspaceRecord,
  workspaceName: string,
  now = new Date(),
): Promise<PurgeExpiredResult | { skipped: true; reason: string }> {
  const days = positiveLimit(ws.retentionDays);
  if (days === undefined) {
    return { skipped: true, reason: "retentionDays not set on workspace" };
  }

  const cutoff = retentionCutoff(days, now);
  const store = await storage(env, ws);
  const sampleKeys: string[] = [];
  let deleted = 0;
  let freedBytes = 0;
  let keysTruncated = false;
  let batch: string[] = [];

  async function flush() {
    if (batch.length === 0) return;
    // Bulk form: native multi-delete on R2/S3 when available.
    await store.delete(batch);
    batch = [];
  }

  for await (const item of store.listAll()) {
    if (!isExpired(item.lastModified, cutoff)) continue;

    batch.push(item.key);
    deleted += 1;
    freedBytes += item.size ?? 0;
    if (sampleKeys.length < MAX_KEYS_IN_RESPONSE) sampleKeys.push(item.key);
    else keysTruncated = true;

    if (batch.length >= DELETE_BATCH) await flush();
  }
  await flush();

  const reconcile = await reconcileWorkspaceUsage(env, ws, workspaceName, now);
  return {
    workspace: workspaceName,
    retentionDays: days,
    cutoff: cutoff.toISOString(),
    deleted,
    freedBytes,
    keys: sampleKeys,
    keysTruncated,
    reconcile,
  };
}
