/**
 * Rows the hosted read-gate Worker checks. Keys are the public object key
 * (`<prefix><key>`), not a workspace plus a hash. Whether a key is hosted,
 * and which prefix it uses, comes from `resolveObjectLane` — the same lookup
 * a legacy move into the held bucket uses — so a key left in the shared
 * bucket after a switch to BYO still gets a row. A key that resolves on a
 * BYO lane does not.
 */

import type { D1Queryable } from "./db-session";
import { posterKeyFor } from "./poster-presentation";
import { createLaneResolver, isSharedLane } from "./storage";
import type { WorkspaceRecord } from "./workspace";

/** Lane value stored for every hosted-bucket key. The three public hosts share it. */
export const HOSTED_READ_LANE = "hosted";

export async function hostedGateObjectKeys(
  env: Env,
  ws: WorkspaceRecord,
  keys: string[],
): Promise<string[]> {
  const resolver = createLaneResolver(env, ws);
  let activePrefix: string | null | undefined;
  const out = new Set<string>();
  for (const key of keys) {
    const lane = await resolver.resolve(key);
    // A moved hold is gone from every public lane. The URL it had is the
    // active lane's prefix, which is where delete and a re-hold must look.
    const prefix = lane
      ? isSharedLane(lane.config)
        ? (lane.config.prefix ?? "")
        : null
      : await sharedActivePrefix();
    if (prefix === null) continue;
    out.add(`${prefix}${key}`);
    out.add(`${prefix}${posterKeyFor(key)}`);
  }
  return [...out];

  async function sharedActivePrefix(): Promise<string | null> {
    if (activePrefix === undefined) {
      const config = await resolver.activeConfig();
      activePrefix = isSharedLane(config) ? (config.prefix ?? "") : null;
    }
    return activePrefix;
  }
}

/** Public keys for objects just written to `config`. No storage probe. */
export function gateObjectKeysOnLane(
  config: Parameters<typeof isSharedLane>[0] & { prefix?: string },
  keys: string[],
): string[] {
  if (!isSharedLane(config)) return [];
  const prefix = config.prefix ?? "";
  const out: string[] = [];
  for (const key of keys) out.push(`${prefix}${key}`, `${prefix}${posterKeyFor(key)}`);
  return out;
}

export function readGateInserts(db: D1Queryable, objectKeys: string[]) {
  return objectKeys.map((objectKey) =>
    db
      .prepare(
        `INSERT INTO read_gate (lane, object_key) VALUES (?, ?)
         ON CONFLICT(lane, object_key) DO NOTHING`,
      )
      .bind(HOSTED_READ_LANE, objectKey),
  );
}

export function readGateDeletes(db: D1Queryable, objectKeys: string[]) {
  return objectKeys.map((objectKey) =>
    db
      .prepare(`DELETE FROM read_gate WHERE lane = ? AND object_key = ?`)
      .bind(HOSTED_READ_LANE, objectKey),
  );
}

function missingTable(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes("no such table");
}

/** Best-effort insert used when a write lands on a key that is already held. */
export async function insertHostedReadGate(
  env: Env,
  db: D1Queryable,
  ws: WorkspaceRecord,
  keys: string[],
): Promise<void> {
  const objectKeys = await hostedGateObjectKeys(env, ws, keys);
  if (objectKeys.length === 0) return;
  try {
    await db.batch(readGateInserts(db, objectKeys));
  } catch (err) {
    if (missingTable(err)) return;
    throw err;
  }
}

/** Drop the gate rows for these keys and their posters. */
export async function deleteHostedReadGate(
  env: Env,
  db: D1Queryable,
  ws: WorkspaceRecord,
  keys: string[],
): Promise<void> {
  await deleteReadGateKeys(db, await hostedGateObjectKeys(env, ws, keys));
}

/** Drop these public object keys. Each delete is a primary-key lookup. */
export async function deleteReadGateKeys(db: D1Queryable, objectKeys: string[]): Promise<void> {
  if (objectKeys.length === 0) return;
  try {
    await db.batch(readGateDeletes(db, objectKeys));
  } catch (err) {
    if (missingTable(err)) return;
    throw err;
  }
}

/** Prefix delete for workspace teardown. The bound is the primary key, not a scan. */
export async function deleteReadGateForWorkspace(
  db: D1Queryable,
  workspaceName: string,
): Promise<void> {
  const prefix = `${workspaceName}/`;
  const upper = prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1);
  try {
    await db
      .prepare(`DELETE FROM read_gate WHERE lane = ? AND object_key >= ? AND object_key < ?`)
      .bind(HOSTED_READ_LANE, prefix, upper)
      .run();
  } catch (err) {
    if (missingTable(err)) return;
    console.error({ event: "read_gate_delete_failed", workspace: workspaceName, err });
  }
}
