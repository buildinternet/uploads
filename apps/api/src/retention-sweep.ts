/**
 * Daily retention sweep: every REGISTRY workspace with retentionDays set runs
 * purgeExpiredObjects. Also finalizes soft-deleted workspaces (#247) whose
 * grace window (`purgeAt`) has passed — full hard teardown, then a permanent
 * purged tombstone so the slug stays reserved. Invoked from the Worker
 * scheduled handler.
 */
import { purgeExpiredObjects } from "./retention";
import { teardownWorkspace } from "./workspace-teardown";
import { isPurgedTombstone, type PurgedTombstone, type WorkspaceRecord } from "./workspace";

export interface SweepResult {
  workspacesScanned: number;
  workspacesWithRetention: number;
  purged: Array<{
    workspace: string;
    deleted: number;
    freedBytes: number;
    skipped?: boolean;
    error?: string;
  }>;
  workspacesFinalized: Array<{
    workspace: string;
    objectsDeleted: number;
    freedBytes: number;
    galleriesDeleted: number;
    error?: string;
  }>;
}

export async function runRetentionSweep(env: Env): Promise<SweepResult> {
  let cursor: string | undefined;
  let workspacesScanned = 0;
  let workspacesWithRetention = 0;
  const purged: SweepResult["purged"] = [];
  const workspacesFinalized: SweepResult["workspacesFinalized"] = [];

  do {
    const page = await env.REGISTRY.list({ prefix: "ws:", cursor, limit: 100 });
    for (const entry of page.keys) {
      workspacesScanned += 1;
      const name = entry.name.startsWith("ws:") ? entry.name.slice(3) : entry.name;
      if (!name) continue;

      let record: WorkspaceRecord | PurgedTombstone | null = null;
      try {
        record = await env.REGISTRY.get<WorkspaceRecord | PurgedTombstone>(entry.name, "json");
      } catch (err) {
        purged.push({
          workspace: name,
          deleted: 0,
          freedBytes: 0,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
      if (!record) continue;
      // Already-finalized tombstone — nothing to do, skip harmlessly.
      if (isPurgedTombstone(record)) continue;

      if (record.deletedAt) {
        // Soft-deleted: skip normal retention purge; finalize once the grace
        // window has elapsed. A missing or unparseable purgeAt must never
        // fall through to teardown (NaN comparisons are false, which would
        // otherwise read as "grace elapsed") — surface it as an error instead.
        if (!record.purgeAt) continue;
        const purgeAtMs = Date.parse(record.purgeAt);
        if (!Number.isFinite(purgeAtMs)) {
          workspacesFinalized.push({
            workspace: name,
            objectsDeleted: 0,
            freedBytes: 0,
            galleriesDeleted: 0,
            error: `unparseable purgeAt: ${record.purgeAt}`,
          });
          continue;
        }
        if (Date.now() < purgeAtMs) continue;

        try {
          const result = await teardownWorkspace(env, name, record, {
            reason: "grace_period_expired",
            force: true,
            replaceWithTombstone: true,
          });
          workspacesFinalized.push({
            workspace: name,
            objectsDeleted: result.objectsDeleted,
            freedBytes: result.freedBytes,
            galleriesDeleted: result.galleriesDeleted,
          });
          console.log(
            JSON.stringify({
              event: "workspace_purged",
              workspace: name,
              objectsDeleted: result.objectsDeleted,
              freedBytes: result.freedBytes,
              galleriesDeleted: result.galleriesDeleted,
            }),
          );
        } catch (err) {
          workspacesFinalized.push({
            workspace: name,
            objectsDeleted: 0,
            freedBytes: 0,
            galleriesDeleted: 0,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        continue;
      }

      if (typeof record.retentionDays !== "number" || record.retentionDays <= 0) continue;

      workspacesWithRetention += 1;
      try {
        const result = await purgeExpiredObjects(env, record, name);
        if ("skipped" in result) {
          purged.push({ workspace: name, deleted: 0, freedBytes: 0, skipped: true });
        } else {
          purged.push({
            workspace: name,
            deleted: result.deleted,
            freedBytes: result.freedBytes,
          });
        }
      } catch (err) {
        purged.push({
          workspace: name,
          deleted: 0,
          freedBytes: 0,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  console.log(
    JSON.stringify({
      message: "retention_sweep",
      workspacesScanned,
      workspacesWithRetention,
      purged,
      workspacesFinalized,
    }),
  );
  return { workspacesScanned, workspacesWithRetention, purged, workspacesFinalized };
}
