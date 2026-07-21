/**
 * Daily retention sweep: every REGISTRY workspace with retentionDays set runs
 * purgeExpiredObjects. Also finalizes soft-deleted workspaces (#247) whose
 * grace window (`purgeAt`) has passed — full hard teardown, then a permanent
 * purged tombstone so the slug stays reserved. Invoked from the Worker
 * scheduled handler.
 */
import { deleteOrg, listOrgs } from "./org-workspaces";
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
  orgsSwept: Array<{
    slug: string;
    deleted: boolean;
    error?: string;
  }>;
}

/**
 * Orgs younger than this are never treated as orphans: self-serve
 * registration creates the org before the `ws:` KV write, so a sweep landing
 * in that gap would otherwise delete a brand-new org mid-signup. A day dwarfs
 * both the provisioning window and KV propagation.
 */
const ORPHAN_ORG_MIN_AGE_MS = 24 * 60 * 60 * 1000;

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

  // #250 orphan-org sweep: after the ws-record pass, list every auth-side org
  // and delete (force) any whose slug has no `ws:<slug>` KV key at all, or
  // only a purged tombstone. A soft-deleted-but-still-in-grace record is NOT
  // an orphan — restore must bring the org back intact, so it's left alone.
  const orgsSwept: SweepResult["orgsSwept"] = [];
  try {
    const orgs = await listOrgs(env);
    for (const org of orgs) {
      // Registration provisions the org BEFORE writing the ws: KV record
      // (routes/workspaces.ts), so a just-created org can look orphaned for a
      // moment. Skip anything inside the provisioning window — or with no
      // parseable createdAt at all — rather than risk deleting it mid-signup.
      const createdAtMs = org.createdAt ? Date.parse(org.createdAt) : Number.NaN;
      if (!Number.isFinite(createdAtMs) || Date.now() - createdAtMs < ORPHAN_ORG_MIN_AGE_MS) {
        continue;
      }
      try {
        const record = await env.REGISTRY.get<WorkspaceRecord | PurgedTombstone>(
          `ws:${org.slug}`,
          "json",
        );
        const isOrphan = !record || isPurgedTombstone(record);
        if (!isOrphan) continue;

        await deleteOrg(env, org.slug, { force: true });
        orgsSwept.push({ slug: org.slug, deleted: true });
      } catch (err) {
        orgsSwept.push({
          slug: org.slug,
          deleted: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } catch (err) {
    // Best-effort: an AUTH fetch failure (listOrgs itself) must not fail the
    // whole sweep — log and continue with an empty orgsSwept.
    console.log(
      JSON.stringify({
        message: "orphan_org_sweep_failed",
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }

  console.log(
    JSON.stringify({
      message: "retention_sweep",
      workspacesScanned,
      workspacesWithRetention,
      purged,
      workspacesFinalized,
      orgsSwept,
    }),
  );
  return { workspacesScanned, workspacesWithRetention, purged, workspacesFinalized, orgsSwept };
}
