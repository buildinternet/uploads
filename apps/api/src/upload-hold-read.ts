/**
 * Read side of held uploads (`upload-hold.ts`) for the public surfaces that
 * hydrate many keys at once (feeds, galleries). Kept apart from
 * `upload-hold-service.ts`, which imports the comment service, so these
 * readers do not pull in a cycle.
 */

import { dbFor } from "./db-session";
import { getMetadataForKeys } from "./file-metadata";
import { HOLD_META_KEY, isHeld } from "./upload-hold";

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
