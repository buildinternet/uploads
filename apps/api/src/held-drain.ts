/**
 * One-off drain of the legacy held bucket (`UPLOADS_HELD`). Holds placed
 * before #1335 moved bytes there and set `ai.hold.moved=1`. New holds leave
 * the bytes public and write `read_gate` rows instead. This moves every
 * legacy object onto that model so the held bucket and its code can go.
 *
 * Per key, in this order:
 * 1. While the key is still held, write its `read_gate` rows (key and
 *    poster), so the bytes are gated before they reach the public bucket.
 * 2. Copy the bytes (and poster) back to the public key, then delete the
 *    held copy (`restoreFromHeld`).
 * 3. Clear `ai.hold.moved`.
 *
 * A key whose hold was already released is restored without gate rows.
 * A re-run is safe: gate inserts ignore duplicates, and a key whose held
 * copy is gone but whose public object exists only has its flag cleared.
 * A key whose workspace is gone, or that has neither copy, is skipped and
 * reported. Run by hand from the admin route; repeat while `remaining` > 0.
 */

import { primaryDbFor, type D1Queryable } from "./db-session";
import { deleteServerFileMetadataKeys } from "./file-metadata";
import { heldBucket, restoreFromHeld } from "./held-storage";
import { readGateInserts, hostedGateObjectKeys } from "./read-gate";
import { resolveObjectLane } from "./storage";
import { HOLD_MOVED_KEY } from "./upload-hold";
import { isKeyHeld } from "./upload-hold-read";
import { loadWorkspaceRecord } from "./workspace";

export interface HeldDrainSkip {
  workspace: string;
  key: string;
  reason: "workspace_missing" | "no_copy" | "error";
  error?: string;
}

export interface HeldDrainResult {
  dryRun: boolean;
  /** Moved rows seen by this run. */
  scanned: number;
  /** Restored keys that were still held (gate rows written). */
  restoredHeld: number;
  /** Restored keys whose hold was already released (no gate rows). */
  restoredReleased: number;
  /** Keys whose held copy was already gone; only the flag was cleared. */
  flagCleared: number;
  skipped: HeldDrainSkip[];
  /** Pass as `after` to continue past skipped rows. */
  next: string | null;
  /** Moved rows left after `after`, including skipped ones. */
  remaining: number;
  /** Up to 20 keys still in the held bucket, so an operator can confirm it is empty. */
  bucketSample: string[];
}

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

// `substr(meta_key, 1, 3) = 'ai.'` lets SQLite use file_metadata_ai_idx.
const MOVED_ROWS_SQL = `SELECT workspace, object_key FROM file_metadata
  WHERE meta_key = ? AND meta_value = '1' AND substr(meta_key, 1, 3) = 'ai.'
    AND (workspace > ? OR (workspace = ? AND object_key > ?))
  ORDER BY workspace, object_key
  LIMIT ?`;

const MOVED_COUNT_SQL = `SELECT COUNT(*) AS n FROM file_metadata
  WHERE meta_key = ? AND meta_value = '1' AND substr(meta_key, 1, 3) = 'ai.'
    AND (workspace > ? OR (workspace = ? AND object_key > ?))`;

/** `after` is `<workspace>/<key>` as returned in `next`. */
function parseCursor(after: string | undefined): [string, string] {
  if (!after) return ["", ""];
  const slash = after.indexOf("/");
  return slash < 0 ? [after, ""] : [after.slice(0, slash), after.slice(slash + 1)];
}

async function movedRows(
  db: D1Queryable,
  [ws, key]: [string, string],
  limit: number,
): Promise<{ workspace: string; object_key: string }[]> {
  const result = await db
    .prepare(MOVED_ROWS_SQL)
    .bind(HOLD_MOVED_KEY, ws, ws, key, limit)
    .all<{ workspace: string; object_key: string }>();
  return result.results ?? [];
}

async function movedCount(db: D1Queryable, [ws, key]: [string, string]): Promise<number> {
  const row = await db
    .prepare(MOVED_COUNT_SQL)
    .bind(HOLD_MOVED_KEY, ws, ws, key)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

async function bucketSample(env: Env): Promise<string[]> {
  const held = heldBucket(env);
  if (!held) return [];
  const page = await held.list({ limit: 20 });
  return page.objects.map((object) => object.key);
}

type DrainOutcome =
  | "restoredHeld"
  | "restoredReleased"
  | "flagCleared"
  | "workspace_missing"
  | "no_copy";

async function drainKey(env: Env, workspaceName: string, key: string): Promise<DrainOutcome> {
  const db = primaryDbFor(env);
  const ws = await loadWorkspaceRecord(env, workspaceName);
  if (!ws) return "workspace_missing";
  const held = await isKeyHeld(env, workspaceName, key);
  if (held) {
    const objectKeys = await hostedGateObjectKeys(env, ws, [key]);
    if (objectKeys.length > 0) await db.batch(readGateInserts(db, objectKeys));
  }
  const sha = await restoreFromHeld(env, ws, workspaceName, key);
  if (!sha) {
    const lane = await resolveObjectLane(env, ws, key);
    if (!lane) return "no_copy";
  }
  await deleteServerFileMetadataKeys(db, workspaceName, key, [HOLD_MOVED_KEY]);
  if (!sha) return "flagCleared";
  return held ? "restoredHeld" : "restoredReleased";
}

export async function drainHeldBucket(
  env: Env,
  opts: { dryRun?: boolean; limit?: number; after?: string } = {},
): Promise<HeldDrainResult> {
  const dryRun = opts.dryRun === true;
  const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(opts.limit ?? DEFAULT_LIMIT)));
  const db = primaryDbFor(env);
  const cursor = parseCursor(opts.after);
  const result: HeldDrainResult = {
    dryRun,
    scanned: 0,
    restoredHeld: 0,
    restoredReleased: 0,
    flagCleared: 0,
    skipped: [],
    next: null,
    remaining: 0,
    bucketSample: [],
  };
  const rows = await movedRows(db, cursor, limit);
  result.scanned = rows.length;
  let last = cursor;
  if (!dryRun) {
    for (const row of rows) {
      last = [row.workspace, row.object_key];
      try {
        const outcome = await drainKey(env, row.workspace, row.object_key);
        if (outcome === "workspace_missing" || outcome === "no_copy") {
          result.skipped.push({ workspace: row.workspace, key: row.object_key, reason: outcome });
        } else {
          result[outcome] += 1;
        }
      } catch (err) {
        console.error({ event: "held_drain_failed", workspace: row.workspace, err });
        result.skipped.push({
          workspace: row.workspace,
          key: row.object_key,
          reason: "error",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
  // Drained rows no longer match, so only skipped rows need the cursor.
  const resumeAt: [string, string] = result.skipped.length > 0 ? last : cursor;
  result.next = result.skipped.length > 0 ? `${last[0]}/${last[1]}` : (opts.after ?? null);
  result.remaining = await movedCount(db, resumeAt);
  result.bucketSample = await bucketSample(env);
  console.log({ event: "held_drain", ...result, skipped: result.skipped.length });
  return result;
}
