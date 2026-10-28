/**
 * Rows the hosted read-gate Worker checks. Keys are the public object key
 * (`<prefix><key>`), not a workspace plus a hash. BYO lanes are skipped:
 * those URLs are on the customer's domain, and the Worker never sees them.
 */

import type { D1Queryable } from "./db-session";
import { posterKeyFor } from "./poster-presentation";
import { isSharedLane } from "./storage";
import type { WorkspaceRecord } from "./workspace";

/** Lane value stored for every hosted-bucket key. The three public hosts share it. */
export const HOSTED_READ_LANE = "hosted";

export function hostedGateObjectKeys(
  ws: WorkspaceRecord,
  workspaceName: string,
  keys: string[],
): string[] {
  if (!isSharedLane(ws)) return [];
  const prefix = ws.prefix ?? `${workspaceName}/`;
  const out = new Set<string>();
  for (const key of keys) {
    out.add(`${prefix}${key}`);
    out.add(`${prefix}${posterKeyFor(key)}`);
  }
  return [...out];
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
  db: D1Queryable,
  ws: WorkspaceRecord,
  workspaceName: string,
  keys: string[],
): Promise<void> {
  const objectKeys = hostedGateObjectKeys(ws, workspaceName, keys);
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
  db: D1Queryable,
  ws: WorkspaceRecord,
  workspaceName: string,
  keys: string[],
): Promise<void> {
  const objectKeys = hostedGateObjectKeys(ws, workspaceName, keys);
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
