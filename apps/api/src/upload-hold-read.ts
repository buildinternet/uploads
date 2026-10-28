/**
 * Read side of held uploads (`upload-hold.ts`) for the public surfaces that
 * hydrate many keys at once (feeds, galleries). Kept apart from
 * `upload-hold-service.ts`, which imports the comment service, so these
 * readers do not pull in a cycle.
 */

import { dbFor } from "./db-session";
import { contentHashesForKeys, contentHashForKey } from "./content-hash";
import { getMetadataForKeys } from "./file-metadata";
import { latestOverrideEvent, latestOverridesForKeys } from "./file-events";
import { aiRows } from "./classifier-admin";
import {
  deriveHoldState,
  HOLD_APPROVED,
  HOLD_META_KEY,
  HOLD_PENDING,
  projectHold,
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
  const [override, currentSha] = await Promise.all([
    latestOverrideEvent(db, workspace, objectKey),
    contentHashForKey(db, workspace, objectKey),
  ]);
  return deriveHoldState(meta, override, currentSha ?? null);
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
  const candidates = keys.filter((key) => {
    const row = rows.get(key)?.[HOLD_META_KEY];
    return row === HOLD_PENDING || row === HOLD_APPROVED;
  });
  const [overrides, hashes] =
    candidates.length === 0
      ? [new Map(), new Map<string, string>()]
      : await Promise.all([
          latestOverridesForKeys(db, workspace, candidates),
          contentHashesForKeys(db, workspace, candidates),
        ]);
  for (const key of keys) {
    out.set(
      key,
      deriveHoldState(rows.get(key), overrides.get(key) ?? null, hashes.get(key) ?? null),
    );
  }
  return out;
}

/**
 * Every key in the workspace held for approval. A moved hold has no public
 * object to list, so the comment and `uploads approve` find held files
 * here. Seeks `file_metadata_ai_idx` through `aiRows`. Holds are rare, so
 * the result is small.
 */
export async function listHeldKeys(env: Env, workspaceName: string): Promise<string[]> {
  const rows = await loadHeld(env, { workspace: workspaceName });
  return rows.slice(0, 1000).map((row) => row.objectKey);
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
  const rows = await loadHeld(env, { workspace: opts.workspace });
  return rows.slice(0, opts.limit);
}

/** How many files are held, per workspace, for the operator view. */
export async function countHeldByWorkspace(
  env: Env,
): Promise<{ workspace: string; count: number }[]> {
  const rows = await loadHeld(env, {});
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.workspace, (counts.get(row.workspace) ?? 0) + 1);
  return [...counts.entries()]
    .map(([workspace, count]) => ({ workspace, count }))
    .sort((a, b) => b.count - a.count || a.workspace.localeCompare(b.workspace));
}

/**
 * Keys whose effective state is held. Candidates are the `ai.hold` rows
 * (`pending`, and legacy `approved` that a later hold override can re-hold).
 * `deriveHoldState` drops a pending row whose latest matching override is a
 * release. One index seek per value, the same shape `file_metadata_ai_idx`
 * already serves.
 */
async function loadHeld(env: Env, opts: { workspace?: string }): Promise<HeldFileRow[]> {
  const candidates = [
    ...(await holdRows(env, opts.workspace, HOLD_PENDING)),
    ...(await holdRows(env, opts.workspace, HOLD_APPROVED)),
  ];
  const byWorkspace = new Map<string, HeldFileRow[]>();
  for (const row of candidates) {
    const list = byWorkspace.get(row.workspace) ?? [];
    list.push(row);
    byWorkspace.set(row.workspace, list);
  }
  const held: HeldFileRow[] = [];
  for (const [workspace, rows] of byWorkspace) {
    const views = await holdViews(
      env,
      workspace,
      rows.map((row) => row.objectKey),
    );
    for (const row of rows) {
      if (views.get(row.objectKey)?.hold === "pending") held.push(row);
    }
  }
  held.sort(
    (a, b) => a.workspace.localeCompare(b.workspace) || a.objectKey.localeCompare(b.objectKey),
  );
  return held;
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
