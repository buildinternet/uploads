/**
 * Daily retention sweep: every REGISTRY workspace with retentionDays set runs
 * purgeExpiredObjects. Also finalizes soft-deleted workspaces (#247) whose
 * grace window (`purgeAt`) has passed — full hard teardown, then a permanent
 * purged tombstone so the slug stays reserved. Invoked from the Worker
 * scheduled handler.
 */
import { deleteOrg, listOrgs } from "./org-workspaces";
import { purgeExpiredObjects } from "./retention";
import { PROBE_PREFIX } from "./storage-verify";
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
    /** Set when the record has no `prefix` — the sweep never force-purges those (operator-only escape hatch, see `teardownWorkspace`'s `purgeObjects`). */
    objectsSkipped?: "dedicated-bucket";
  }>;
  orgsSwept: Array<{
    slug: string;
    deleted: boolean;
    error?: string;
  }>;
  /** Orphaned storage-verify probe objects reaped from the shared bucket (issue #929 adversarial review L-4). */
  probesReaped: {
    deleted: number;
    error?: string;
  };
}

/**
 * Orgs younger than this are never treated as orphans: self-serve
 * registration creates the org before the `ws:` KV write, so a sweep landing
 * in that gap would otherwise delete a brand-new org mid-signup. A day dwarfs
 * both the provisioning window and KV propagation.
 */
const ORPHAN_ORG_MIN_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * How old a `_internal/uploads-verify/` probe object has to be before this
 * sweep deletes it. Every probe (`storage-verify.ts` `probeActiveContent`,
 * the round-trip check) deletes its own object in a `finally`, best-effort —
 * so anything still here a day later is an orphan from a delete that failed,
 * not a probe in flight. A day is orders of magnitude past the 5 s fetch
 * timeout that bounds a live probe.
 */
const PROBE_ORPHAN_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Bound on the probe-prefix listing, matching the paging idiom the object sweeps use. */
const PROBE_LIST_MAX_PAGES = 20;

/**
 * Deletes orphaned probe objects from the shared default bucket (issue #929
 * adversarial review L-4). Probe cleanup is best-effort at the probe site,
 * and the hosted-host sweep now writes several probe objects a day, so a
 * persistent delete failure would otherwise accumulate forever: nothing else
 * reaps this prefix (`verifyStorageConfig`'s not-empty check deliberately
 * filters it out, and it belongs to no workspace, so no retention policy
 * covers it).
 *
 * Never throws: the caller runs this inside the daily retention sweep, and a
 * probe-reap failure must not take the retention sweep down with it — the
 * error is reported on the result and logged, same posture as the orphan-org
 * pass.
 */
async function reapOrphanedProbeObjects(env: Env): Promise<SweepResult["probesReaped"]> {
  // Absent binding: a test env (or a self-host with no shared bucket) has
  // nothing to reap. Not an error.
  if (!env.UPLOADS_DEFAULT) return { deleted: 0 };
  const cutoff = Date.now() - PROBE_ORPHAN_MAX_AGE_MS;
  let deleted = 0;
  try {
    let cursor: string | undefined;
    for (let page = 0; page < PROBE_LIST_MAX_PAGES; page++) {
      const listed = await env.UPLOADS_DEFAULT.list({
        prefix: PROBE_PREFIX,
        limit: 1000,
        ...(cursor ? { cursor } : {}),
      });
      const stale = listed.objects
        .filter((object) => object.uploaded.getTime() < cutoff)
        .map((object) => object.key);
      if (stale.length > 0) {
        await env.UPLOADS_DEFAULT.delete(stale);
        deleted += stale.length;
      }
      cursor = listed.truncated ? listed.cursor : undefined;
      if (!cursor) break;
    }
    return { deleted };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.log(JSON.stringify({ message: "probe_orphan_sweep_failed", error }));
    return { deleted, error };
  }
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
          // No `purgeObjects` here — the sweep is automated, not an
          // operator confirming the bucket is platform-owned, so an
          // unprefixed record always keeps its objects (objectsSkipped)
          // while platform state (KV/D1/galleries) is still torn down.
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
            ...(result.objectsSkipped ? { objectsSkipped: result.objectsSkipped } : {}),
          });
          console.log(
            JSON.stringify({
              event: "workspace_purged",
              workspace: name,
              objectsDeleted: result.objectsDeleted,
              freedBytes: result.freedBytes,
              galleriesDeleted: result.galleriesDeleted,
              objectsSkipped: result.objectsSkipped,
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

  const probesReaped = await reapOrphanedProbeObjects(env);

  console.log(
    JSON.stringify({
      message: "retention_sweep",
      workspacesScanned,
      workspacesWithRetention,
      purged,
      workspacesFinalized,
      orgsSwept,
      probesReaped,
    }),
  );
  return {
    workspacesScanned,
    workspacesWithRetention,
    purged,
    workspacesFinalized,
    orgsSwept,
    probesReaped,
  };
}
