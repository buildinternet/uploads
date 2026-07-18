/**
 * Shared hard-teardown sequence for a workspace: R2 objects, D1 rows (file
 * metadata + galleries), best-effort auth org, then the `ws:<name>` KV
 * record. Used by the admin hard-delete path (`DELETE
 * /admin/workspaces/:name?hard=1`) and by the retention sweep's finalization
 * of an expired soft delete (`apps/api/src/retention-sweep.ts`).
 *
 * Ordering is fail-safe: the KV record — the thing that actually grants
 * storage access — is written/deleted last, so a failure partway through
 * leaves the workspace inert rather than half-deleted-but-still-reachable.
 */
import { deleteFileMetadataForWorkspace } from "./file-metadata";
import { deleteGalleriesForWorkspace } from "./galleries";
import { deleteOrg } from "./org-workspaces";
import { storage } from "./storage";
import type { PurgedTombstone, WorkspaceRecord } from "./workspace";

// files-sdk bulk-delete batch size — mirrors retention.ts's DELETE_BATCH
// (stays under R2/S3's 1000-key DeleteObjects cap while bounding memory).
const R2_DELETE_BATCH = 500;

export interface TeardownOptions {
  /** Structured-log `event` field / reason tag (e.g. "admin_hard_delete", "grace_period_expired"). */
  reason: string;
  /**
   * Skip listing/deleting R2 objects even if the workspace is non-empty
   * (force semantics) — the caller has already decided teardown proceeds
   * regardless of object count. Defaults to true (delete unconditionally).
   */
  force?: boolean;
  /**
   * When true, replace the KV record with a minimal permanent purged
   * tombstone instead of deleting the key outright — keeps the slug
   * reserved. When false/omitted, the key is deleted (frees the slug).
   */
  replaceWithTombstone?: boolean;
}

export interface TeardownResult {
  objectsDeleted: number;
  freedBytes: number;
  galleriesDeleted: number;
}

export async function teardownWorkspace(
  env: Env,
  name: string,
  record: WorkspaceRecord,
  opts: TeardownOptions,
): Promise<TeardownResult> {
  const force = opts.force ?? true;

  const store = await storage(env, record);
  let objectCount = 0;
  let freedBytes = 0;
  let batch: string[] = [];
  for await (const item of store.listAll()) {
    objectCount += 1;
    freedBytes += item.size ?? 0;
    if (force) {
      batch.push(item.key);
      if (batch.length >= R2_DELETE_BATCH) {
        await store.delete(batch);
        batch = [];
      }
    }
  }
  if (batch.length > 0) await store.delete(batch);

  const { galleries } = await deleteGalleriesForWorkspace(env.DB, name);
  await deleteFileMetadataForWorkspace(env.DB, name);

  // Best-effort, like the self-serve rollback path in routes/workspaces.ts
  // — an org left behind after this point is orphaned (no KV record means
  // no storage access) and safe to clean up later.
  await deleteOrg(env, name).catch((err) =>
    console.error("workspace teardown: org cleanup failed for", name, "may be orphaned", err),
  );

  if (opts.replaceWithTombstone) {
    const tombstone: PurgedTombstone = {
      status: "purged",
      name,
      purgedAt: new Date().toISOString(),
      deletedAt: record.deletedAt,
    };
    await env.REGISTRY.put(`ws:${name}`, JSON.stringify(tombstone));
  } else {
    await env.REGISTRY.delete(`ws:${name}`);
  }

  console.log(
    JSON.stringify({
      event: "workspace_deleted",
      reason: opts.reason,
      workspace: name,
      forced: force,
      objectsDeleted: objectCount,
      freedBytes,
      galleriesDeleted: galleries,
    }),
  );

  return { objectsDeleted: objectCount, freedBytes, galleriesDeleted: galleries };
}
