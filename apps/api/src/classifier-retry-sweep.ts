/**
 * Daily retry of files stuck at `ai.classifier=failed`. A provider timeout
 * fails open and leaves that marker. This sweep is what looks at it again.
 * Invoked from the Worker scheduled handler alongside the retention sweep.
 *
 * Each retry calls `classifyAndStore`, the same path as an upload, so a
 * decision that should hold the file places a hold. The run is capped so a
 * backlog cannot spend the cron's wall clock: a call can use the resize
 * budget, the Decisions budget, and a hold-area budget.
 */
import { CLASSIFIER_FAILED, classificationAllowed, classifyAndStore } from "./classifier";
import { dbFor, type D1Queryable } from "./db-session";
import { storage } from "./storage";
import { isPurgedTombstone, type PurgedTombstone, type WorkspaceRecord } from "./workspace";

/**
 * Model calls per daily run. 25 stays inside the cron wall clock when each
 * call spends its 8s budgets.
 */
export const CLASSIFIER_RETRY_CAP = 25;

/**
 * Failed rows read per run. Rows this run cannot classify are deferred, so
 * a dead row does not pin the cap. The rest wait for a later day.
 */
const CLASSIFIER_RETRY_SCAN = 100;

export interface ClassifierRetrySweepResult {
  /** Failed rows read this run, before the attempt cap. */
  scanned: number;
  /** `classifyAndStore` calls. */
  attempted: number;
  /** Rows that no longer have `ai.classifier=failed`. */
  resolved: number;
  /** Rows left failed without a model call, and moved behind the queue. */
  deferred: number;
  errors: Array<{ workspace: string; key: string; error: string }>;
}

type OpenedStore = Awaited<ReturnType<typeof storage>>;

function isNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "NotFound"
  );
}

/** Move a still-failed row behind the ones this run has not touched yet. */
async function deferFailed(db: D1Queryable, workspace: string, objectKey: string): Promise<void> {
  await db
    .prepare(
      `UPDATE file_metadata SET updated_at = ?
       WHERE workspace = ? AND object_key = ? AND meta_key = 'ai.classifier' AND meta_value = ?`,
    )
    .bind(new Date().toISOString(), workspace, objectKey, CLASSIFIER_FAILED)
    .run();
}

async function loadWorkspace(
  env: Env,
  cache: Map<string, WorkspaceRecord | null>,
  name: string,
): Promise<WorkspaceRecord | null> {
  const cached = cache.get(name);
  if (cached !== undefined) return cached;
  let record: WorkspaceRecord | PurgedTombstone | null;
  try {
    record = await env.REGISTRY.get<WorkspaceRecord | PurgedTombstone>(`ws:${name}`, "json");
  } catch (err) {
    cache.set(name, null);
    throw err;
  }
  if (!record || isPurgedTombstone(record) || record.deletedAt) {
    cache.set(name, null);
    return null;
  }
  const ws = { ...record, name };
  cache.set(name, ws);
  return ws;
}

async function openStore(
  env: Env,
  cache: Map<string, OpenedStore | "error">,
  ws: WorkspaceRecord,
  name: string,
): Promise<OpenedStore | "error"> {
  const cached = cache.get(name);
  if (cached !== undefined) return cached;
  try {
    const store = await storage(env, ws);
    cache.set(name, store);
    return store;
  } catch (err) {
    cache.set(name, "error");
    throw err;
  }
}

async function readObject(
  store: OpenedStore,
  key: string,
): Promise<{ bytes: Uint8Array; contentType: string } | null> {
  try {
    const downloaded = await store.download(key);
    return {
      bytes: new Uint8Array(await downloaded.arrayBuffer()),
      contentType: downloaded.type || "application/octet-stream",
    };
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

export async function runClassifierRetrySweep(env: Env): Promise<ClassifierRetrySweepResult> {
  const db = dbFor(env);
  const listed = await db
    .prepare(
      `SELECT workspace, object_key
       FROM file_metadata
       WHERE meta_key = 'ai.classifier' AND meta_value = ?
       ORDER BY updated_at ASC, workspace ASC, object_key ASC
       LIMIT ?`,
    )
    .bind(CLASSIFIER_FAILED, CLASSIFIER_RETRY_SCAN)
    .all<{ workspace: string; object_key: string }>();
  const rows = listed.results ?? [];

  const result: ClassifierRetrySweepResult = {
    scanned: rows.length,
    attempted: 0,
    resolved: 0,
    deferred: 0,
    errors: [],
  };
  const workspaces = new Map<string, WorkspaceRecord | null>();
  const allowed = new Map<string, boolean>();
  const stores = new Map<string, OpenedStore | "error">();

  for (const row of rows) {
    if (result.attempted >= CLASSIFIER_RETRY_CAP) break;
    const { workspace, object_key: key } = row;
    try {
      const ws = await loadWorkspace(env, workspaces, workspace);
      if (!ws) {
        result.deferred += 1;
        await deferFailed(db, workspace, key);
        continue;
      }
      let canClassify = allowed.get(workspace);
      if (canClassify === undefined) {
        canClassify = await classificationAllowed(env, ws, workspace);
        allowed.set(workspace, canClassify);
      }
      if (!canClassify) {
        result.deferred += 1;
        await deferFailed(db, workspace, key);
        continue;
      }
      const store = await openStore(env, stores, ws, workspace);
      if (store === "error") {
        result.deferred += 1;
        await deferFailed(db, workspace, key);
        continue;
      }
      const object = await readObject(store, key);
      if (!object) {
        result.deferred += 1;
        await deferFailed(db, workspace, key);
        continue;
      }
      result.attempted += 1;
      // The original upload failed open before a hold could be decided.
      // A successful retry applies the normal hold rules.
      const stored = await classifyAndStore(
        env,
        ws,
        workspace,
        key,
        object.bytes,
        object.contentType,
        {
          enforceHold: true,
        },
      );
      if (stored?.["ai.classifier"] && stored["ai.classifier"] !== CLASSIFIER_FAILED) {
        result.resolved += 1;
      } else {
        // A failed call already rewrote the row. Touching it again is harmless,
        // and a call that wrote nothing still has to leave the front of the queue.
        await deferFailed(db, workspace, key);
      }
    } catch (err) {
      result.errors.push({
        workspace,
        key,
        error: err instanceof Error ? err.message : String(err),
      });
      await deferFailed(db, workspace, key).catch(() => {
        // The row stays where it is. The next run tries it again.
      });
    }
  }

  console.log(
    JSON.stringify({
      message: "classifier_retry_sweep",
      scanned: result.scanned,
      attempted: result.attempted,
      resolved: result.resolved,
      deferred: result.deferred,
      errors: result.errors.length,
    }),
  );
  return result;
}
