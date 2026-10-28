import { contentHashForKey } from "./content-hash";
import { dbFor, type D1Queryable } from "./db-session";
import { contentSha256Hex } from "./provenance";
import { overrideApplies, type HoldOverride } from "./upload-hold";

const INSERT_SQL = `INSERT INTO file_events (
  workspace, object_key, content_sha256, kind, classifier_version, model,
  reason, action, actor,
  rating, rating_confidence, content_flag, content_confidence,
  secret, secret_confidence, pii, pii_confidence, created_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

export type ClassificationEventKind =
  | "classified"
  | "reused_exact"
  | "reused_perceptual"
  | "skipped"
  | "failed";

function ignorable(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes("no such table") || message.includes("unsupported ");
}

async function insertEvent(
  env: Env,
  row: {
    workspace: string;
    objectKey: string;
    contentSha256: string | null;
    kind: string;
    classifierVersion?: string | null;
    model?: string | null;
    reason?: string | null;
    action?: string | null;
    actor?: string | null;
    safety?: Record<string, string>;
    at: string;
  },
): Promise<void> {
  const meta = row.safety;
  const read = (key: string) => meta?.[key] ?? null;
  try {
    await dbFor(env)
      .prepare(INSERT_SQL)
      .bind(
        row.workspace,
        row.objectKey,
        row.contentSha256,
        row.kind,
        row.classifierVersion ?? null,
        row.model ?? null,
        row.reason ?? null,
        row.action ?? null,
        row.actor ?? null,
        read("ai.rating"),
        read("ai.rating.confidence"),
        read("ai.content"),
        read("ai.content.confidence"),
        read("ai.secret"),
        read("ai.secret.confidence"),
        read("ai.pii"),
        read("ai.pii.confidence"),
        row.at,
      )
      .run();
  } catch (err) {
    if (ignorable(err)) return;
    console.error({ event: "file_event_append_failed", workspace: row.workspace, err });
  }
}

export async function appendClassificationEvent(
  env: Env,
  input: {
    workspace: string;
    objectKey: string;
    bytes: Uint8Array;
    kind: ClassificationEventKind;
    classifierVersion?: string | null;
    model?: string | null;
    reason?: string | null;
    safety?: Record<string, string>;
  },
): Promise<void> {
  let contentSha256: string | null = null;
  try {
    contentSha256 = await contentSha256Hex(input.bytes);
  } catch {
    contentSha256 = null;
  }
  await insertEvent(env, {
    workspace: input.workspace,
    objectKey: input.objectKey,
    contentSha256,
    kind: input.kind,
    classifierVersion: input.classifierVersion,
    model: input.model,
    reason: input.reason,
    safety: input.safety,
    at: new Date().toISOString(),
  });
}

export async function appendOverrideEvent(
  env: Env,
  input: {
    workspace: string;
    objectKey: string;
    action: "release" | "hold";
    actor?: string | null;
    reason?: string | null;
    safety?: Record<string, string>;
    at: string;
  },
): Promise<void> {
  const contentSha256 = await contentHashForKey(dbFor(env), input.workspace, input.objectKey);
  await insertEvent(env, {
    workspace: input.workspace,
    objectKey: input.objectKey,
    contentSha256: contentSha256 ?? null,
    kind: "override",
    action: input.action,
    actor: input.actor,
    reason: input.reason,
    safety: input.safety,
    at: input.at,
  });
}

export async function latestOverridesForKeys(
  db: D1Queryable,
  workspace: string,
  keys: string[],
): Promise<Map<string, HoldOverride>> {
  const found = new Map<string, HoldOverride>();
  if (keys.length === 0) return found;
  try {
    const chunkSize = 80;
    for (let i = 0; i < keys.length; i += chunkSize) {
      const chunk = keys.slice(i, i + chunkSize);
      const placeholders = chunk.map(() => "?").join(", ");
      const result = await db
        .prepare(
          `SELECT object_key, action, actor, content_sha256, created_at
           FROM file_events
           WHERE workspace = ? AND kind = 'override' AND object_key IN (${placeholders})
           ORDER BY id DESC`,
        )
        .bind(workspace, ...chunk)
        .all<{
          object_key: string;
          action: string;
          actor: string | null;
          content_sha256: string | null;
          created_at: string;
        }>();
      for (const row of result.results ?? []) {
        if (found.has(row.object_key)) continue;
        found.set(row.object_key, {
          action: row.action,
          actor: row.actor,
          contentSha256: row.content_sha256,
          createdAt: row.created_at,
        });
      }
    }
  } catch (err) {
    if (ignorable(err)) return found;
    console.error({ event: "file_event_read_failed", workspace, err });
    return found;
  }
  return found;
}

export async function latestOverrideEvent(
  db: D1Queryable,
  workspace: string,
  objectKey: string,
): Promise<HoldOverride | null> {
  try {
    const row = await db
      .prepare(
        `SELECT action, actor, content_sha256, created_at
         FROM file_events
         WHERE workspace = ? AND object_key = ? AND kind = 'override'
         ORDER BY id DESC
         LIMIT 1`,
      )
      .bind(workspace, objectKey)
      .first<{
        action: string;
        actor: string | null;
        content_sha256: string | null;
        created_at: string;
      }>();
    if (!row) return null;
    return {
      action: row.action,
      actor: row.actor,
      contentSha256: row.content_sha256,
      createdAt: row.created_at,
    };
  } catch (err) {
    if (ignorable(err)) return null;
    console.error({ event: "file_event_read_failed", workspace, err });
    return null;
  }
}

/**
 * Copy the source key's latest matching override onto `destKey`. Promote
 * and attach copy the `ai.hold` row but not the log; without this, a
 * released file's copy would look held.
 */
export async function copyApplicableOverride(
  env: Env,
  workspace: string,
  sourceKey: string,
  destKey: string,
): Promise<void> {
  const db = dbFor(env);
  const [override, sourceSha, destSha] = await Promise.all([
    latestOverrideEvent(db, workspace, sourceKey),
    contentHashForKey(db, workspace, sourceKey),
    contentHashForKey(db, workspace, destKey),
  ]);
  if (!override) return;
  const action =
    override.action === "hold" || override.action === "release" ? override.action : null;
  if (!action) return;
  if (!overrideApplies(override.contentSha256, sourceSha ?? null)) return;
  if ((sourceSha ?? null) !== (destSha ?? null)) return;
  await appendOverrideEvent(env, {
    workspace,
    objectKey: destKey,
    action,
    actor: override.actor,
    at: override.createdAt,
  });
}

async function runDelete(
  db: D1Queryable,
  workspace: string,
  sql: string,
  binds: unknown[],
): Promise<void> {
  try {
    await db
      .prepare(sql)
      .bind(...binds)
      .run();
  } catch (err) {
    if (ignorable(err)) return;
    console.error({ event: "file_event_delete_failed", workspace, err });
  }
}

export async function deleteFileEvents(
  db: D1Queryable,
  workspace: string,
  objectKey: string,
): Promise<void> {
  await runDelete(db, workspace, `DELETE FROM file_events WHERE workspace = ? AND object_key = ?`, [
    workspace,
    objectKey,
  ]);
}

export async function deleteFileEventsForKeys(
  db: D1Queryable,
  workspace: string,
  keys: string[],
): Promise<void> {
  if (keys.length === 0) return;
  const chunkSize = 90;
  for (let i = 0; i < keys.length; i += chunkSize) {
    const chunk = keys.slice(i, i + chunkSize);
    const placeholders = chunk.map(() => "?").join(", ");
    await runDelete(
      db,
      workspace,
      `DELETE FROM file_events WHERE workspace = ? AND object_key IN (${placeholders})`,
      [workspace, ...chunk],
    );
  }
}

export async function deleteFileEventsForWorkspace(
  db: D1Queryable,
  workspace: string,
): Promise<void> {
  await runDelete(db, workspace, `DELETE FROM file_events WHERE workspace = ?`, [workspace]);
}
