/**
 * Read side of held uploads (`upload-hold.ts`) for the public surfaces that
 * hydrate many keys at once (feeds, galleries). Kept apart from
 * `upload-hold-service.ts`, which imports the comment service, so these
 * readers do not pull in a cycle.
 */

import { dbFor, type D1Queryable } from "./db-session";
import { contentHashesForKeys, contentHashForKey } from "./content-hash";
import { COPIED_FROM_META_KEY, getMetadataForKeys } from "./file-metadata";
import { blobHoldsFor } from "./file-events";
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
  const candidates: string[] = [];
  for (const key of keys) {
    const row = rows.get(key)?.[HOLD_META_KEY];
    if (row === HOLD_PENDING || row === HOLD_APPROVED) candidates.push(key);
    else out.set(key, { hold: null, by: null, at: null });
  }
  if (candidates.length === 0) return out;
  const hashes = await contentHashesForKeys(db, workspace, candidates);
  const blobs = await blobHoldsFor(db, workspace, [...new Set(hashes.values())]).catch(noBlob);
  for (const key of candidates) {
    const sha = hashes.get(key);
    out.set(key, deriveHoldState(rows.get(key), sha ? (blobs.get(sha) ?? null) : null));
  }
  return out;
}

/** Keys in this workspace with this hash and their own `ai.hold` row. */
export async function holdKeysForHash(
  db: D1Queryable,
  workspace: string,
  contentSha256: string,
): Promise<string[]> {
  const result = await db
    .prepare(
      `SELECT h.object_key AS object_key
       FROM file_content_hash h
       INNER JOIN file_metadata m
         ON m.workspace = h.workspace
        AND m.object_key = h.object_key
        AND m.meta_key = ?
       WHERE h.workspace = ? AND h.content_sha256 = ?`,
    )
    .bind(HOLD_META_KEY, workspace, contentSha256)
    .all<{ object_key: string }>();
  return (result.results ?? []).map((row) => row.object_key);
}

/**
 * How many promote/attach copies one hold will mark. The lookup is indexed
 * (`file_metadata_lookup_idx` on workspace, meta_key, meta_value), then the
 * content-hash primary key. The cap keeps a bad pointer from gating the
 * workspace. A copy of a copy is not in this result: only rows that point
 * directly at `sourceKey`.
 */
export const COPY_HOLD_FANOUT_LIMIT = 32;

export async function keysCopiedFrom(
  db: D1Queryable,
  workspace: string,
  sourceKey: string,
  contentSha256: string,
): Promise<string[]> {
  const result = await db
    .prepare(
      `SELECT m.object_key AS object_key
       FROM file_metadata m
       INNER JOIN file_content_hash h
         ON h.workspace = m.workspace AND h.object_key = m.object_key
       WHERE m.workspace = ?
         AND m.meta_key = ?
         AND m.meta_value = ?
         AND h.content_sha256 = ?
       ORDER BY m.object_key
       LIMIT ?`,
    )
    .bind(workspace, COPIED_FROM_META_KEY, sourceKey, contentSha256, COPY_HOLD_FANOUT_LIMIT)
    .all<{ object_key: string }>();
  return (result.results ?? []).map((row) => row.object_key);
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

/** Held files across every workspace (or one), for the operator release. */
export async function listHeldAcrossWorkspaces(
  env: Env,
  opts: { workspace?: string; limit: number },
): Promise<HeldFileRow[]> {
  return loadHeld(env, { workspace: opts.workspace, limit: opts.limit });
}

const HELD_KEY_JOIN = `FROM blob_hold b
       JOIN file_content_hash h
         ON h.workspace = b.workspace AND h.content_sha256 = b.content_sha256
       JOIN file_metadata m
         ON m.workspace = h.workspace AND m.object_key = h.object_key
        AND m.meta_key = 'ai.hold'
       WHERE b.state = 'held'`;

/** How many files are held, per workspace, for the operator view. */
export async function countHeldByWorkspace(
  env: Env,
): Promise<{ workspace: string; count: number }[]> {
  const result = await dbFor(env)
    .prepare(
      `SELECT h.workspace AS workspace, COUNT(*) AS count
       ${HELD_KEY_JOIN}
       GROUP BY h.workspace
       ORDER BY count DESC, h.workspace`,
    )
    .all<{ workspace: string; count: number }>();
  return (result.results ?? []).map((row) => ({
    workspace: row.workspace,
    count: Number(row.count),
  }));
}

/** Keys with their own hold row whose blob is `held`, bounded by `limit`. */
async function loadHeld(
  env: Env,
  opts: { workspace?: string; limit: number },
): Promise<HeldFileRow[]> {
  const workspaceClause = opts.workspace ? "AND b.workspace = ?" : "";
  const binds: unknown[] = [];
  if (opts.workspace) binds.push(opts.workspace);
  binds.push(opts.limit);
  const result = await dbFor(env)
    .prepare(
      `SELECT h.workspace AS workspace, h.object_key AS object_key
       ${HELD_KEY_JOIN} ${workspaceClause}
       ORDER BY h.workspace, h.object_key
       LIMIT ?`,
    )
    .bind(...binds)
    .all<{ workspace: string; object_key: string }>();
  return (result.results ?? []).map((row) => ({
    workspace: row.workspace,
    objectKey: row.object_key,
  }));
}
