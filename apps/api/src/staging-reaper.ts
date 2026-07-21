/**
 * Phase 4a: reaper for branch-staged GitHub attachments (`gh/<owner>/<repo>/branch/<branch>/<file>`,
 * D1 `file_metadata` tags `gh.kind=branch`, `gh.staged-at`). Two cleanup rules:
 *
 * - Promoted: `gh.promoted-at` older than PROMOTED_MAX_AGE_DAYS → delete. The
 *   staged original already did its job once promoted into a PR; keep it
 *   around briefly (in case the promotion needs to be redone) then reap it.
 * - Abandoned: no `gh.promoted-at`/`gh.promoted-to` (never promoted) and
 *   `gh.staged-at` older than ABANDONED_MAX_AGE_DAYS → delete. Missing or
 *   unparsable `gh.staged-at` is left alone — never guess-delete.
 *
 * Invoked from the Worker scheduled handler alongside `runRetentionSweep`.
 * Deletion goes through `deleteObject` (files-core.ts) so R2, D1 metadata,
 * and the workspace usage ledger stay consistent — the same path the
 * `/v1/:workspace/files` DELETE route uses.
 */
import { deleteObject } from "./files-core";
import { findObjectsByMetadataAcrossWorkspaces, getMetadataForKeys } from "./file-metadata";
import { loadWorkspaceRecord } from "./workspace";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** `gh.promoted-at` older than this is reaped. */
export const PROMOTED_MAX_AGE_DAYS = 7;
/** `gh.staged-at` (never promoted) older than this is reaped. */
export const ABANDONED_MAX_AGE_DAYS = 30;

/**
 * Candidates scanned per invocation (cross-workspace `gh.kind=branch` D1
 * query) — also the effective cap on deletions per run, mirroring the
 * batch discipline of the existing retention sweep/purge passes.
 */
export const STAGING_REAP_SCAN_LIMIT = 300;

export interface StagingReapResult {
  scanned: number;
  deleted: Array<{ workspace: string; key: string; reason: "promoted" | "abandoned" }>;
  skipped: number;
  errors: Array<{ workspace: string; key: string; error: string }>;
}

function isOlderThan(iso: string | undefined, maxAgeMs: number, now: number): boolean {
  if (!iso) return false;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return false;
  return now - ms > maxAgeMs;
}

/** Belt-and-braces: never delete anything outside the branch-staging keyspace, however it got flagged. */
function looksLikeBranchStagingKey(key: string): boolean {
  return key.startsWith("gh/") && key.includes("/branch/");
}

export async function runStagingReaper(env: Env): Promise<StagingReapResult> {
  const now = Date.now();
  const candidates = await findObjectsByMetadataAcrossWorkspaces(
    env.DB,
    "gh.kind",
    "branch",
    STAGING_REAP_SCAN_LIMIT,
  );

  const deleted: StagingReapResult["deleted"] = [];
  const errors: StagingReapResult["errors"] = [];
  let skipped = 0;
  const workspaceCache = new Map<string, Awaited<ReturnType<typeof loadWorkspaceRecord>>>();

  // Group valid keys by workspace so hydrate is one IN-list query per workspace.
  const keysByWorkspace = new Map<string, string[]>();
  for (const { workspace, key } of candidates) {
    if (!looksLikeBranchStagingKey(key)) {
      skipped += 1;
      continue;
    }
    const list = keysByWorkspace.get(workspace);
    if (list) list.push(key);
    else keysByWorkspace.set(workspace, [key]);
  }

  const metaByWorkspace = new Map<string, Map<string, Record<string, string>>>();
  const hydrateFailed = new Set<string>();
  for (const [workspace, keys] of keysByWorkspace) {
    try {
      metaByWorkspace.set(workspace, await getMetadataForKeys(env.DB, workspace, keys));
    } catch (err) {
      hydrateFailed.add(workspace);
      const message = err instanceof Error ? err.message : String(err);
      for (const key of keys) errors.push({ workspace, key, error: message });
    }
  }

  // Candidates arrive ordered by (workspace, key); Map insertion order preserves that.
  for (const [workspace, keys] of keysByWorkspace) {
    if (hydrateFailed.has(workspace)) continue;
    const metaMap = metaByWorkspace.get(workspace);

    for (const key of keys) {
      const meta = metaMap?.get(key);
      // Missing: row raced away between candidate scan and hydrate.
      if (!meta || meta["gh.kind"] !== "branch") {
        skipped += 1;
        continue;
      }

      let reason: "promoted" | "abandoned" | undefined;
      if (meta["gh.promoted-at"]) {
        if (isOlderThan(meta["gh.promoted-at"], PROMOTED_MAX_AGE_DAYS * MS_PER_DAY, now)) {
          reason = "promoted";
        }
      } else if (isOlderThan(meta["gh.staged-at"], ABANDONED_MAX_AGE_DAYS * MS_PER_DAY, now)) {
        reason = "abandoned";
      }
      if (!reason) {
        skipped += 1;
        continue;
      }

      let ws = workspaceCache.get(workspace);
      if (ws === undefined) {
        ws = await loadWorkspaceRecord(env, workspace);
        workspaceCache.set(workspace, ws);
      }
      if (!ws) {
        errors.push({ workspace, key, error: "workspace not found" });
        continue;
      }

      try {
        await deleteObject(env, ws, key, workspace);
        deleted.push({ workspace, key, reason });
      } catch (err) {
        errors.push({ workspace, key, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  const result: StagingReapResult = { scanned: candidates.length, deleted, skipped, errors };
  console.log(
    JSON.stringify({
      message: "staging_reap",
      scanned: result.scanned,
      deleted: result.deleted.length,
      skipped: result.skipped,
      errors: result.errors.length,
    }),
  );
  return result;
}
