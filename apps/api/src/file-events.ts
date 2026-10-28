import { ValidationError } from "@uploads/errors";
import { dbFor, type D1Queryable } from "./db-session";
import { contentSha256Hex } from "./provenance";
import type { BlobHoldView } from "./upload-hold";

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
  return message.includes("no such table");
}

const SHA256_RE = /^[a-f0-9]{64}$/;

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
    contentSha256: string;
    action: "release" | "hold";
    actor?: string | null;
    reason?: string | null;
    safety?: Record<string, string>;
    at: string;
  },
): Promise<void> {
  if (!SHA256_RE.test(input.contentSha256)) {
    throw new ValidationError(
      "this file has no content hash, so the hold change cannot be recorded",
      {
        code: "content_hash_unknown",
      },
    );
  }
  const db = dbFor(env);
  const meta = input.safety;
  const read = (key: string) => meta?.[key] ?? null;
  const state = input.action === "release" ? "released" : "held";
  await db.batch([
    db
      .prepare(INSERT_SQL)
      .bind(
        input.workspace,
        input.objectKey,
        input.contentSha256,
        "override",
        null,
        null,
        input.reason ?? null,
        input.action,
        input.actor ?? null,
        read("ai.rating"),
        read("ai.rating.confidence"),
        read("ai.content"),
        read("ai.content.confidence"),
        read("ai.secret"),
        read("ai.secret.confidence"),
        read("ai.pii"),
        read("ai.pii.confidence"),
        input.at,
      ),
    db
      .prepare(
        `INSERT INTO blob_hold (workspace, content_sha256, state, actor, at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(workspace, content_sha256) DO UPDATE SET
           state = excluded.state, actor = excluded.actor, at = excluded.at`,
      )
      .bind(input.workspace, input.contentSha256, state, input.actor ?? null, input.at),
  ]);
}

export async function blobHoldsFor(
  db: D1Queryable,
  workspace: string,
  shas: string[],
): Promise<Map<string, BlobHoldView>> {
  const found = new Map<string, BlobHoldView>();
  if (shas.length === 0) return found;
  const chunkSize = 80;
  for (let i = 0; i < shas.length; i += chunkSize) {
    const chunk = shas.slice(i, i + chunkSize);
    const placeholders = chunk.map(() => "?").join(", ");
    const result = await db
      .prepare(
        `SELECT content_sha256, state, actor, at FROM blob_hold
         WHERE workspace = ? AND content_sha256 IN (${placeholders})`,
      )
      .bind(workspace, ...chunk)
      .all<{ content_sha256: string; state: string; actor: string | null; at: string | null }>();
    for (const row of result.results ?? []) {
      if (row.state !== "held" && row.state !== "released") continue;
      found.set(row.content_sha256, { state: row.state, actor: row.actor, at: row.at });
    }
  }
  return found;
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

export async function deleteFileEventsForWorkspace(
  db: D1Queryable,
  workspace: string,
): Promise<void> {
  await runDelete(db, workspace, `DELETE FROM file_events WHERE workspace = ?`, [workspace]);
  await runDelete(db, workspace, `DELETE FROM blob_hold WHERE workspace = ?`, [workspace]);
}
