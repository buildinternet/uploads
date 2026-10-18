/**
 * Read side of held uploads (`upload-hold.ts`) for the public surfaces that
 * hydrate many keys at once (feeds, galleries). Kept apart from
 * `upload-hold-service.ts`, which imports the comment service, so these
 * readers do not pull in a cycle.
 */

import { dbFor } from "./db-session";
import { getMetadataForKeys } from "./file-metadata";
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

/**
 * Every key in the workspace held for approval. A moved hold has no public
 * object to list, so the comment and `uploads approve` find held files
 * here. Seeks `file_metadata_ai_idx` (the literal `substr` predicate must
 * stay, or SQLite scans). Holds are rare, so the result is small.
 */
export async function listHeldKeys(env: Env, workspaceName: string): Promise<string[]> {
  const result = await dbFor(env)
    .prepare(
      `SELECT object_key FROM file_metadata
       WHERE workspace = ? AND meta_key = ? AND meta_value = ?
         AND substr(meta_key, 1, 3) = 'ai.'
       ORDER BY object_key
       LIMIT 1000`,
    )
    .bind(workspaceName, HOLD_META_KEY, HOLD_PENDING)
    .all<{ object_key: string }>();
  return (result.results ?? []).map((row) => row.object_key);
}
