/**
 * App-driven retention: delete objects older than `retentionDays` on the
 * workspace record. Uses object `lastModified` from the store (R2 upload time).
 * After purge, call reconcile so the ledger matches storage.
 */
import { positiveLimit } from "./budget";
import { reconcileWorkspaceUsage, type ReconcileResult } from "./reconcile";
import { storage } from "./storage";
import type { WorkspaceRecord } from "./workspace";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
/** Cap listed deleted keys in the response so agents don't get huge payloads. */
const MAX_KEYS_IN_RESPONSE = 100;

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

/**
 * Delete objects last-modified before the retention window. No-ops when
 * `retentionDays` is unset. Always re-reconciles when anything was deleted
 * (and still reconciles when nothing matched so operators can chain safely).
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
  const store = storage(env, ws);
  const keys: string[] = [];
  let deleted = 0;
  let freedBytes = 0;
  let keysTruncated = false;

  for await (const item of store.listAll()) {
    const modified = item.lastModified ? new Date(item.lastModified) : null;
    if (!modified || Number.isNaN(modified.getTime()) || modified >= cutoff) continue;

    await store.delete(item.key);
    deleted += 1;
    freedBytes += item.size ?? 0;
    if (keys.length < MAX_KEYS_IN_RESPONSE) keys.push(item.key);
    else keysTruncated = true;
  }

  const reconcile = await reconcileWorkspaceUsage(env, ws, workspaceName, now);
  return {
    workspace: workspaceName,
    retentionDays: days,
    cutoff: cutoff.toISOString(),
    deleted,
    freedBytes,
    keys,
    keysTruncated,
    reconcile,
  };
}
