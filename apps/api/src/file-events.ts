/**
 * Append-only classifier attempts and hold overrides (`file_events`).
 *
 * Current safety flags stay on `ai.*` rows. This log is the history that
 * an overwrite does not erase, and the member release that must not edit
 * those rows. `content_sha256` is the bytes the event describes, so a
 * later blob id can use the same column without a rewrite.
 *
 * Writes are best-effort. A missing table (a database that has not migrated)
 * or a test double that does not model it must not fail a classify or an
 * approve. The `ai.*` rows remain the current result.
 */

import { contentHashForKey } from "./content-hash";
import { dbFor, type D1Queryable } from "./db-session";
import { contentSha256Hex } from "./provenance";

export const CLASSIFICATION_EVENT_KINDS = [
  "classified",
  "reused_exact",
  "reused_perceptual",
  "skipped",
  "failed",
] as const;

export type ClassificationEventKind = (typeof CLASSIFICATION_EVENT_KINDS)[number];

export type OverrideAction = "release" | "hold";

export interface FileEvent {
  id: number;
  contentSha256: string | null;
  kind: string;
  classifierVersion: string | null;
  model: string | null;
  reason: string | null;
  action: string | null;
  actor: string | null;
  rating: string | null;
  ratingConfidence: string | null;
  contentFlag: string | null;
  contentConfidence: string | null;
  secret: string | null;
  secretConfidence: string | null;
  pii: string | null;
  piiConfidence: string | null;
  createdAt: string;
}

export interface OverrideEvent {
  action: string;
  actor: string | null;
  reason: string | null;
  contentSha256: string | null;
  createdAt: string;
}

const INSERT_SQL = `INSERT INTO file_events (
  workspace, object_key, content_sha256, kind, classifier_version, model,
  reason, action, actor,
  rating, rating_confidence, content_flag, content_confidence,
  secret, secret_confidence, pii, pii_confidence, created_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

interface SafetyColumns {
  rating: string | null;
  ratingConfidence: string | null;
  contentFlag: string | null;
  contentConfidence: string | null;
  secret: string | null;
  secretConfidence: string | null;
  pii: string | null;
  piiConfidence: string | null;
}

function text(value: string | null | undefined): string | null {
  return value ?? null;
}

function safetyOf(meta: Record<string, string> | undefined): SafetyColumns {
  const read = (key: string) => text(meta?.[key]);
  return {
    rating: read("ai.rating"),
    ratingConfidence: read("ai.rating.confidence"),
    contentFlag: read("ai.content"),
    contentConfidence: read("ai.content.confidence"),
    secret: read("ai.secret"),
    secretConfidence: read("ai.secret.confidence"),
    pii: read("ai.pii"),
    piiConfidence: read("ai.pii.confidence"),
  };
}

function safetyBinds(safety: SafetyColumns): Array<string | null> {
  return [
    safety.rating,
    safety.ratingConfidence,
    safety.contentFlag,
    safety.contentConfidence,
    safety.secret,
    safety.secretConfidence,
    safety.pii,
    safety.piiConfidence,
  ];
}

/** A missing table or an unmodeled test double. Real SQL errors still log. */
function ignorableEventError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes("no such table") || message.includes("unsupported ");
}

function logEventError(event: string, workspace: string, err: unknown): void {
  if (ignorableEventError(err)) return;
  console.error({ event, workspace, err });
}

async function insertEvent(
  env: Env,
  workspace: string,
  objectKey: string,
  contentSha256: string | null,
  kind: string,
  fields: {
    classifierVersion?: string | null;
    model?: string | null;
    reason?: string | null;
    action?: string | null;
    actor?: string | null;
    safety?: Record<string, string>;
    at: string;
  },
): Promise<void> {
  const safety = safetyOf(fields.safety);
  try {
    await dbFor(env)
      .prepare(INSERT_SQL)
      .bind(
        workspace,
        objectKey,
        contentSha256,
        kind,
        text(fields.classifierVersion),
        text(fields.model),
        text(fields.reason),
        text(fields.action),
        text(fields.actor),
        ...safetyBinds(safety),
        fields.at,
      )
      .run();
  } catch (err) {
    logEventError("file_event_append_failed", workspace, err);
  }
}

/**
 * One classifier attempt. `bytes` are the object body, so the stored hash
 * matches `file_content_hash` for this put. Never throws.
 */
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
  await insertEvent(env, input.workspace, input.objectKey, contentSha256, input.kind, {
    classifierVersion: input.classifierVersion,
    model: input.model,
    reason: input.reason,
    safety: input.safety,
    at: new Date().toISOString(),
  });
}

/**
 * A member release or a hold-again. Copies the safety flags in force and
 * does not write them. The hash is the key's current `file_content_hash`,
 * so the override stops applying when those bytes change. Never throws.
 */
export async function appendOverrideEvent(
  env: Env,
  input: {
    workspace: string;
    objectKey: string;
    action: OverrideAction;
    actor?: string | null;
    reason?: string | null;
    safety?: Record<string, string>;
    at: string;
  },
): Promise<void> {
  const contentSha256 = await contentHashForKey(dbFor(env), input.workspace, input.objectKey);
  await insertEvent(env, input.workspace, input.objectKey, contentSha256 ?? null, "override", {
    action: input.action,
    actor: input.actor,
    reason: input.reason,
    safety: input.safety,
    at: input.at,
  });
}

interface EventRow {
  id: number;
  content_sha256: string | null;
  kind: string;
  classifier_version: string | null;
  model: string | null;
  reason: string | null;
  action: string | null;
  actor: string | null;
  rating: string | null;
  rating_confidence: string | null;
  content_flag: string | null;
  content_confidence: string | null;
  secret: string | null;
  secret_confidence: string | null;
  pii: string | null;
  pii_confidence: string | null;
  created_at: string;
}

function eventFromRow(row: EventRow): FileEvent {
  return {
    id: Number(row.id),
    contentSha256: row.content_sha256,
    kind: row.kind,
    classifierVersion: row.classifier_version,
    model: row.model,
    reason: row.reason,
    action: row.action,
    actor: row.actor,
    rating: row.rating,
    ratingConfidence: row.rating_confidence,
    contentFlag: row.content_flag,
    contentConfidence: row.content_confidence,
    secret: row.secret,
    secretConfidence: row.secret_confidence,
    pii: row.pii,
    piiConfidence: row.pii_confidence,
    createdAt: row.created_at,
  };
}

/** Oldest first. Empty when the table is missing. */
export async function listFileEvents(
  db: D1Queryable,
  workspace: string,
  objectKey: string,
): Promise<FileEvent[]> {
  try {
    const result = await db
      .prepare(
        `SELECT id, content_sha256, kind, classifier_version, model, reason, action, actor,
                rating, rating_confidence, content_flag, content_confidence,
                secret, secret_confidence, pii, pii_confidence, created_at
         FROM file_events
         WHERE workspace = ? AND object_key = ?
         ORDER BY id ASC
         LIMIT 500`,
      )
      .bind(workspace, objectKey)
      .all<EventRow>();
    return (result.results ?? []).map(eventFromRow);
  } catch (err) {
    logEventError("file_event_read_failed", workspace, err);
    return [];
  }
}

/**
 * The newest override for this key, or null. Callers compare
 * `contentSha256` to the key's current hash before treating it as current.
 */
export async function latestOverrideEvent(
  db: D1Queryable,
  workspace: string,
  objectKey: string,
): Promise<OverrideEvent | null> {
  try {
    const row = await db
      .prepare(
        `SELECT action, actor, reason, content_sha256, created_at
         FROM file_events
         WHERE workspace = ? AND object_key = ? AND kind = 'override'
         ORDER BY id DESC
         LIMIT 1`,
      )
      .bind(workspace, objectKey)
      .first<{
        action: string;
        actor: string | null;
        reason: string | null;
        content_sha256: string | null;
        created_at: string;
      }>();
    if (!row) return null;
    return {
      action: row.action,
      actor: row.actor,
      reason: row.reason,
      contentSha256: row.content_sha256,
      createdAt: row.created_at,
    };
  } catch (err) {
    logEventError("file_event_read_failed", workspace, err);
    return null;
  }
}

/**
 * An override describes the bytes in `eventSha`. It applies while the key
 * still points at those bytes. Null matches only a key with no hash.
 */
export function overrideApplies(eventSha: string | null, currentSha: string | null): boolean {
  if (eventSha === null) return currentSha === null;
  return eventSha === currentSha;
}

async function deleteWhere(db: D1Queryable, sql: string, binds: unknown[]): Promise<void> {
  await db
    .prepare(sql)
    .bind(...binds)
    .run();
}

/** Best-effort. Object delete drops the log for that key. */
export async function deleteFileEvents(
  db: D1Queryable,
  workspace: string,
  objectKey: string,
): Promise<void> {
  try {
    await deleteWhere(db, `DELETE FROM file_events WHERE workspace = ? AND object_key = ?`, [
      workspace,
      objectKey,
    ]);
  } catch (err) {
    logEventError("file_event_delete_failed", workspace, err);
  }
}

/** Best-effort. Retention passes the keys it just removed from the bucket. */
export async function deleteFileEventsForKeys(
  db: D1Queryable,
  workspace: string,
  keys: string[],
): Promise<void> {
  if (keys.length === 0) return;
  try {
    const chunkSize = 90;
    for (let i = 0; i < keys.length; i += chunkSize) {
      const chunk = keys.slice(i, i + chunkSize);
      const placeholders = chunk.map(() => "?").join(", ");
      await deleteWhere(
        db,
        `DELETE FROM file_events WHERE workspace = ? AND object_key IN (${placeholders})`,
        [workspace, ...chunk],
      );
    }
  } catch (err) {
    logEventError("file_event_delete_failed", workspace, err);
  }
}

/** Best-effort. Workspace teardown must not leave another tenant's judgments. */
export async function deleteFileEventsForWorkspace(
  db: D1Queryable,
  workspace: string,
): Promise<void> {
  try {
    await deleteWhere(db, `DELETE FROM file_events WHERE workspace = ?`, [workspace]);
  } catch (err) {
    logEventError("file_event_delete_failed", workspace, err);
  }
}
