/**
 * BYO-bucket detection for `ws:<name>` records, plus the KV key metadata that
 * mirrors it (#1094). Neutral module: imported by routes, the metrics overview
 * and the workspace writers alike, so none of them has to reach into a route
 * file for the predicate.
 *
 * Why metadata: `REGISTRY.list({ prefix: "ws:" })` returns each key's metadata
 * for free, so "is this workspace BYO?" comes off the paged list instead of one
 * record read per workspace. Every writer of a live record must pass
 * `workspaceKeyMetadata(record)` to `put` — a `put` without `metadata` erases
 * whatever was there.
 */
import { storageBudgetApplies } from "./budget";
import {
  isPurgedTombstone,
  listWorkspaceKeys,
  loadWorkspaceRecord,
  type PurgedTombstone,
  type WorkspaceRecord,
} from "./workspace";

/**
 * True when `record` is customer-credential (BYO) storage: HTTP credentials
 * with no R2 binding. Delegates to `storageBudgetApplies` (budget.ts) rather
 * than re-deriving the signal, so the two surfaces can't drift on what counts
 * as BYO — `storageBudgetApplies` returns `false` for exactly this shape.
 */
export function isByoRecord(
  record: Pick<
    WorkspaceRecord,
    "binding" | "accountId" | "accessKeyId" | "secretAccessKey" | "endpoint"
  >,
): boolean {
  return !storageBudgetApplies(record);
}

/** KV key metadata stored on `ws:<name>`. Tiny on purpose (KV caps metadata at 1024 bytes). */
export interface WorkspaceKeyMetadata {
  byob: boolean;
}

/**
 * Metadata for a record about to be written. Soft-deleted records and purged
 * tombstones are never BYO here, matching how the admin list treats them
 * (`loadWorkspaceRecord` returns null for both, which renders as shared).
 */
export function workspaceKeyMetadata(
  record: WorkspaceRecord | PurgedTombstone,
): WorkspaceKeyMetadata {
  if (isPurgedTombstone(record) || record.deletedAt) return { byob: false };
  return { byob: isByoRecord(record) };
}

/** Parse metadata read back from a KV list entry; null when absent or malformed (legacy key). */
export function parseWorkspaceKeyMetadata(value: unknown): WorkspaceKeyMetadata | null {
  if (!value || typeof value !== "object") return null;
  const { byob } = value as { byob?: unknown };
  return typeof byob === "boolean" ? { byob } : null;
}

/**
 * BYO status for every registered workspace. Reads the flag from key metadata
 * on the paged list; only keys missing it (records written before #1094 and
 * not yet backfilled) cost one record read. Throws if the list or a fallback
 * read fails — callers decide whether that is fatal or "unknown".
 */
export async function listWorkspaceByobStatus(env: Env): Promise<Map<string, boolean>> {
  const keys = await listWorkspaceKeys(env);
  const status = new Map<string, boolean>();
  const legacy: string[] = [];
  for (const { name, metadata } of keys) {
    const parsed = parseWorkspaceKeyMetadata(metadata);
    if (parsed) status.set(name, parsed.byob);
    else legacy.push(name);
  }
  const records = await Promise.all(legacy.map((name) => loadWorkspaceRecord(env, name)));
  legacy.forEach((name, i) => {
    const record = records[i];
    status.set(name, record ? isByoRecord(record) : false);
  });
  return status;
}

/**
 * Operator backfill: rewrite metadata on every existing `ws:` key that lacks
 * it (or carries a stale value), re-putting the unchanged blob. Idempotent.
 * Goes through the raw value rather than `mutateWorkspaceRecord` so `version`
 * is not bumped; a concurrent writer that lands between our read and put is
 * itself writing metadata, and we skip when the blob changed under us.
 */
export interface ByobMetadataBackfillResult {
  dryRun: boolean;
  scanned: number;
  updated: number;
  skipped: number;
  errors: { workspace: string; error: string }[];
}

export async function backfillWorkspaceKeyMetadata(
  env: Env,
  opts: { dryRun?: boolean } = {},
): Promise<ByobMetadataBackfillResult> {
  const dryRun = opts.dryRun === true;
  const result: ByobMetadataBackfillResult = {
    dryRun,
    scanned: 0,
    updated: 0,
    skipped: 0,
    errors: [],
  };
  for (const { name, metadata } of await listWorkspaceKeys(env)) {
    result.scanned += 1;
    const key = `ws:${name}`;
    try {
      const raw = await env.REGISTRY.get(key, "text");
      if (raw === null) {
        result.skipped += 1;
        continue;
      }
      const record = JSON.parse(raw) as WorkspaceRecord | PurgedTombstone;
      const wanted = workspaceKeyMetadata(record);
      if (parseWorkspaceKeyMetadata(metadata)?.byob === wanted.byob) {
        result.skipped += 1;
        continue;
      }
      if (!dryRun) {
        // Re-check just before writing so we never clobber a newer blob.
        if ((await env.REGISTRY.get(key, "text")) !== raw) {
          result.skipped += 1;
          continue;
        }
        await env.REGISTRY.put(key, raw, { metadata: wanted });
      }
      result.updated += 1;
    } catch (err) {
      result.errors.push({
        workspace: name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return result;
}
