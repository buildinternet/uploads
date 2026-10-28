/**
 * Read side of held uploads (`upload-hold.ts`) for the public surfaces that
 * hydrate many keys at once (feeds, galleries). Kept apart from
 * `upload-hold-service.ts`, which imports the comment service, so these
 * readers do not pull in a cycle.
 */

import { dbFor } from "./db-session";
import { contentHashesForKeys, contentHashForKey } from "./content-hash";
import { getMetadataForKeys } from "./file-metadata";
import { blobHoldsFor } from "./file-events";
import { aiRows } from "./classifier-admin";
import {
  deriveHoldState,
  HOLD_APPROVED,
  HOLD_META_KEY,
  HOLD_PENDING,
  projectHold,
  type BlobHoldView,
  type EffectiveHold,
} from "./upload-hold";

export type { EffectiveHold };

/** The subset of `keys` held for approval. One batched read of rows, hashes, and overrides. */
export async function heldKeysAmong(
  env: Env,
  workspaceName: string,
  keys: string[],
  preloaded?: Map<string, Record<string, string>>,
): Promise<Set<string>> {
  const held = new Set<string>();
  const views = await holdViews(env, workspaceName, keys, preloaded);
  for (const [key, view] of views) if (view.hold === "pending") held.add(key);
  return held;
}

/** Whether one key is held. */
export async function isKeyHeld(env: Env, workspaceName: string, key: string): Promise<boolean> {
  return (await heldKeysAmong(env, workspaceName, [key])).has(key);
}

/**
 * Hold state for these bytes. No event read when the file was never held.
 * A matching override supplies who released it and when.
 */
export async function effectiveHold(
  env: Env,
  workspace: string,
  objectKey: string,
  meta: Record<string, string>,
): Promise<EffectiveHold> {
  const row = meta[HOLD_META_KEY];
  if (row !== HOLD_PENDING && row !== HOLD_APPROVED) return { hold: null, by: null, at: null };
  const db = dbFor(env);
  const currentSha = await contentHashForKey(db, workspace, objectKey);
  const blobs = currentSha ? await blobHoldsFor(db, workspace, [currentSha]).catch(noBlob) : null;
  return deriveHoldState(meta, currentSha ? (blobs?.get(currentSha) ?? null) : null);
}

/** Replace `ai.hold` on held or released keys with the effective state. */
export async function presentHoldMetadata(
  env: Env,
  workspace: string,
  metaByKey: Map<string, Record<string, string>>,
): Promise<Map<string, Record<string, string>>> {
  const keys = [...metaByKey.entries()]
    .filter(([, meta]) => {
      const row = meta[HOLD_META_KEY];
      return row === HOLD_PENDING || row === HOLD_APPROVED;
    })
    .map(([key]) => key);
  if (keys.length === 0) return metaByKey;
  const views = await holdViews(env, workspace, keys, metaByKey);
  for (const key of keys) {
    const meta = metaByKey.get(key);
    const view = views.get(key);
    if (meta && view) metaByKey.set(key, projectHold(meta, view));
  }
  return metaByKey;
}

async function holdViews(
  env: Env,
  workspace: string,
  keys: string[],
  preloaded?: Map<string, Record<string, string>>,
): Promise<Map<string, EffectiveHold>> {
  const out = new Map<string, EffectiveHold>();
  if (keys.length === 0) return out;
  const db = dbFor(env);
  const rows =
    preloaded ??
    (await getMetadataForKeys(db, workspace, keys, {
      metaKeys: [HOLD_META_KEY],
    }));
  const hashes = await contentHashesForKeys(db, workspace, keys);
  const blobs = await blobHoldsFor(db, workspace, [...new Set(hashes.values())]).catch(noBlob);
  for (const key of keys) {
    const sha = hashes.get(key);
    out.set(key, deriveHoldState(rows.get(key), sha ? (blobs.get(sha) ?? null) : null));
  }
  return out;
}

function noBlob(): Map<string, BlobHoldView> {
  return new Map();
}

/**
 * Every key in the workspace held for approval. A moved hold has no public
 * object to list, so the comment and `uploads approve` find held files
 * here. Seeks `file_metadata_ai_idx` through `aiRows`. Holds are rare, so
 * the result is small.
 */
export async function listHeldKeys(env: Env, workspaceName: string): Promise<string[]> {
  const rows = await loadHeld(env, { workspace: workspaceName, limit: 1000 });
  return rows.map((row) => row.objectKey);
}

/** One held file, across workspaces, for the operator view. */
export interface HeldFileRow {
  workspace: string;
  objectKey: string;
}

/**
 * Pending holds across every workspace (or one), oldest key order, for the
 * operator release. Seeks `file_metadata_ai_idx`, which leads with
 * `(meta_key, meta_value, workspace, object_key)`.
 */
export async function listHeldAcrossWorkspaces(
  env: Env,
  opts: { workspace?: string; limit: number },
): Promise<HeldFileRow[]> {
  return loadHeld(env, { workspace: opts.workspace, limit: opts.limit });
}

/** How many files are held, per workspace, for the operator view. */
export async function countHeldByWorkspace(
  env: Env,
): Promise<{ workspace: string; count: number }[]> {
  try {
    const result = await dbFor(env)
      .prepare(
        `SELECT h.workspace AS workspace, COUNT(*) AS count
         FROM blob_hold b
         JOIN file_content_hash h
           ON h.workspace = b.workspace AND h.content_sha256 = b.content_sha256
         WHERE b.state = 'held'
         GROUP BY h.workspace
         ORDER BY count DESC, h.workspace`,
      )
      .all<{ workspace: string; count: number }>();
    return (result.results ?? []).map((row) => ({
      workspace: row.workspace,
      count: Number(row.count),
    }));
  } catch (err) {
    if (!noSuchTable(err)) throw err;
    const rows = await holdRows(env, undefined, HOLD_PENDING);
    const counts = new Map<string, number>();
    for (const row of rows) counts.set(row.workspace, (counts.get(row.workspace) ?? 0) + 1);
    return [...counts.entries()]
      .map(([workspace, count]) => ({ workspace, count }))
      .sort((a, b) => b.count - a.count || a.workspace.localeCompare(b.workspace));
  }
}

function noSuchTable(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes("no such table");
}

/** Keys whose bytes are `blob_hold.state = held`, bounded by `limit`. */
async function loadHeld(
  env: Env,
  opts: { workspace?: string; limit: number },
): Promise<HeldFileRow[]> {
  try {
    const workspaceClause = opts.workspace ? "AND b.workspace = ?" : "";
    const binds: unknown[] = [];
    if (opts.workspace) binds.push(opts.workspace);
    binds.push(opts.limit);
    const result = await dbFor(env)
      .prepare(
        `SELECT h.workspace AS workspace, h.object_key AS object_key
         FROM blob_hold b
         JOIN file_content_hash h
           ON h.workspace = b.workspace AND h.content_sha256 = b.content_sha256
         WHERE b.state = 'held' ${workspaceClause}
         ORDER BY h.workspace, h.object_key
         LIMIT ?`,
      )
      .bind(...binds)
      .all<{ workspace: string; object_key: string }>();
    return (result.results ?? []).map((row) => ({
      workspace: row.workspace,
      objectKey: row.object_key,
    }));
  } catch (err) {
    if (!noSuchTable(err)) throw err;
    const rows = await holdRows(env, opts.workspace, HOLD_PENDING);
    return rows.slice(0, opts.limit);
  }
}

async function holdRows(
  env: Env,
  workspace: string | undefined,
  value: string,
): Promise<HeldFileRow[]> {
  if (workspace) {
    const result = await dbFor(env)
      .prepare(
        `SELECT object_key FROM file_metadata
         WHERE workspace = ? AND meta_key = ? AND meta_value = ?
           AND ${aiRows("")}
         ORDER BY object_key`,
      )
      .bind(workspace, HOLD_META_KEY, value)
      .all<{ object_key: string }>();
    return (result.results ?? []).map((row) => ({ workspace, objectKey: row.object_key }));
  }
  const result = await dbFor(env)
    .prepare(
      `SELECT workspace, object_key FROM file_metadata
       WHERE meta_key = ? AND meta_value = ? AND ${aiRows("")}
       ORDER BY workspace, object_key`,
    )
    .bind(HOLD_META_KEY, value)
    .all<{ workspace: string; object_key: string }>();
  return (result.results ?? []).map((row) => ({
    workspace: row.workspace,
    objectKey: row.object_key,
  }));
}
