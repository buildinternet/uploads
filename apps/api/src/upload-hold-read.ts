/**
 * Read side of held uploads (`upload-hold.ts`) for the public surfaces that
 * hydrate many keys at once (feeds, galleries). Kept apart from
 * `upload-hold-service.ts`, which imports the comment service, so these
 * readers do not pull in a cycle.
 */

import { dbFor } from "./db-session";
import { getMetadataForKeys } from "./file-metadata";
import { aiRows } from "./classifier-admin";
import { HOLD_META_KEY, HOLD_PENDING, isHeld } from "./upload-hold";

/** The subset of `keys` held for approval. One batched D1 read. */
export async function heldKeysAmong(
  env: Env,
  workspaceName: string,
  keys: string[],
): Promise<Set<string>> {
  const held = new Set<string>();
  if (keys.length === 0) return held;
  const rows = await getMetadataForKeys(dbFor(env), workspaceName, keys, {
    metaKeys: [HOLD_META_KEY],
  });
  for (const [key, meta] of rows) if (isHeld(meta)) held.add(key);
  return held;
}

/** Whether one key is held. */
export async function isKeyHeld(env: Env, workspaceName: string, key: string): Promise<boolean> {
  return (await heldKeysAmong(env, workspaceName, [key])).has(key);
}

/**
 * Every key in the workspace held for approval. A moved hold has no public
 * object to list, so the comment and `uploads approve` find held files
 * here. Seeks `file_metadata_ai_idx` through `aiRows`. Holds are rare, so
 * the result is small.
 */
export async function listHeldKeys(env: Env, workspaceName: string): Promise<string[]> {
  const result = await dbFor(env)
    .prepare(
      `SELECT object_key FROM file_metadata
       WHERE workspace = ? AND meta_key = ? AND meta_value = ?
         AND ${aiRows("")}
       ORDER BY object_key
       LIMIT 1000`,
    )
    .bind(workspaceName, HOLD_META_KEY, HOLD_PENDING)
    .all<{ object_key: string }>();
  return (result.results ?? []).map((row) => row.object_key);
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
  const workspaceClause = opts.workspace ? "AND workspace = ?" : "";
  const binds: unknown[] = [HOLD_META_KEY, HOLD_PENDING];
  if (opts.workspace) binds.push(opts.workspace);
  binds.push(opts.limit);
  const result = await dbFor(env)
    .prepare(
      `SELECT workspace, object_key FROM file_metadata
       WHERE meta_key = ? AND meta_value = ? AND ${aiRows("")} ${workspaceClause}
       ORDER BY workspace, object_key
       LIMIT ?`,
    )
    .bind(...binds)
    .all<{ workspace: string; object_key: string }>();
  return (result.results ?? []).map((row) => ({
    workspace: row.workspace,
    objectKey: row.object_key,
  }));
}

/** How many files are held, per workspace, for the operator view. */
export async function countHeldByWorkspace(
  env: Env,
): Promise<{ workspace: string; count: number }[]> {
  const result = await dbFor(env)
    .prepare(
      `SELECT workspace, COUNT(*) AS count FROM file_metadata
       WHERE meta_key = ? AND meta_value = ? AND ${aiRows("")}
       GROUP BY workspace
       ORDER BY count DESC, workspace`,
    )
    .bind(HOLD_META_KEY, HOLD_PENDING)
    .all<{ workspace: string; count: number }>();
  return (result.results ?? []).map((row) => ({
    workspace: row.workspace,
    count: Number(row.count),
  }));
}
