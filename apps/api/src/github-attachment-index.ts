/**
 * Server-written index of PR/issue attachments (`github_attachments` D1
 * table, issue #934). One row per attachment object, keyed by
 * (workspace, object_key).
 *
 * TRUST BOUNDARY: every row is derived from the FINAL OBJECT KEY plus a
 * server-resolved repo — never from `gh.*` file_metadata, which is
 * client-settable (see file-metadata.ts). A writer that shortcut to
 * `opts.metadata["gh.ref"]` would let any files:write token stamp one row
 * and have an arbitrary object rendered in a public PR comment. The repo
 * comes from the key's own owner/name segments (plain keys) or from the
 * `github_private_prefixes` row that minted the prefix id (private keys) —
 * a prefix id is minted server-side for exactly one repo, so that lookup is
 * authoritative.
 *
 * Phase 1 is write-only: nothing reads this table yet.
 */
import { GH_PRIVATE_ROOT, parseGhPrivateKey } from "@uploads/comment-render";
import { type D1Queryable } from "./db-session";

/** Which server-side path wrote (or last updated) an index row. */
export type AttachmentSource =
  | "put"
  | "attach"
  | "promote"
  | "adopt"
  | "rotate"
  | "backfill"
  | "reconcile";

export interface ParsedAttachmentKey {
  kind: "pull" | "issues";
  num: number;
  /** 32-hex private prefix id, or null for a plain `gh/<owner>/<name>/…` key. */
  prefixId: string | null;
  /**
   * Lowercased owner/name recovered from a plain key, or null for a private
   * key (which deliberately omits the repo). NOTE: the key's segments are
   * the SANITIZED spelling (`sanitizeKeySegment`), which is lossy — a caller
   * that knows the real repo should pass it rather than trust this.
   */
  repo: string | null;
}

/** `gh/<owner>/<name>/<pull|issues>/<num>/<filename>` — the plain layout built by `ghKeyPrefix`. */
const PLAIN_ATTACHMENT_RE = /^gh\/([^/]+)\/([^/]+)\/(pull|issues)\/([1-9][0-9]*)\/(.+)$/;

/**
 * Parses an attachment key back into its target coordinates, or undefined
 * for any key that is not a managed attachment.
 *
 * Deliberately undefined for GitHub-native INGEST keys
 * (`gh/<owner>-<name>/<kind>-<num>/…` and
 * `gh/private/<id>/ingest/<kind>-<num>/…`, see github-ingest.ts): ingested
 * assets are an index only and live outside the comment's prefix on
 * purpose. Also undefined for branch-staged keys
 * (`gh/<owner>/<name>/branch/<branch>/…`, `gh/private/<id>/branch/…`),
 * which are not attachments until promoted.
 */
export function parseAttachmentKey(key: string): ParsedAttachmentKey | undefined {
  if (key.startsWith(GH_PRIVATE_ROOT)) {
    const parsed = parseGhPrivateKey(key);
    if (!parsed) return undefined;
    return { kind: parsed.kind, num: parsed.num, prefixId: parsed.prefixId, repo: null };
  }
  const match = PLAIN_ATTACHMENT_RE.exec(key);
  if (!match) return undefined;
  const [, owner, name, kind, num] = match;
  return {
    kind: kind as "pull" | "issues",
    num: Number(num),
    prefixId: null,
    repo: `${owner}/${name}`.toLowerCase(),
  };
}

export interface AttachmentIndexRow {
  workspace: string;
  repo: string;
  kind: "pull" | "issues";
  num: number;
  objectKey: string;
  prefixId: string | null;
  laneId: string | null;
  source: AttachmentSource;
  createdAt: string;
  updatedAt: string;
  detachedAt: string | null;
}

interface AttachmentDbRow {
  workspace: string;
  repo: string;
  kind: "pull" | "issues";
  num: number;
  object_key: string;
  prefix_id: string | null;
  lane_id: string | null;
  source: AttachmentSource;
  created_at: string;
  updated_at: string;
  detached_at: string | null;
}

const SELECT_COLUMNS =
  "workspace, repo, kind, num, object_key, prefix_id, lane_id, source, created_at, updated_at, detached_at";

function fromRow(row: AttachmentDbRow): AttachmentIndexRow {
  return {
    workspace: row.workspace,
    repo: row.repo,
    kind: row.kind,
    num: row.num,
    objectKey: row.object_key,
    prefixId: row.prefix_id,
    laneId: row.lane_id,
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    detachedAt: row.detached_at,
  };
}

/**
 * Upserts one attachment row. `ON CONFLICT(workspace, object_key)` makes a
 * re-put, a re-attach, and a webhook redelivery all converge on the same
 * row rather than duplicating; `created_at` is preserved and `detached_at`
 * is cleared, since writing an object at a key IS a re-attachment.
 */
export async function recordAttachment(
  db: D1Queryable,
  row: Omit<AttachmentIndexRow, "createdAt" | "updatedAt" | "detachedAt">,
  now = new Date(),
): Promise<void> {
  const nowIso = now.toISOString();
  await db
    .prepare(
      `INSERT INTO github_attachments
         (workspace, repo, kind, num, object_key, prefix_id, lane_id, source, created_at, updated_at, detached_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT(workspace, object_key) DO UPDATE SET
         repo = excluded.repo,
         kind = excluded.kind,
         num = excluded.num,
         prefix_id = excluded.prefix_id,
         lane_id = excluded.lane_id,
         source = excluded.source,
         updated_at = excluded.updated_at,
         detached_at = NULL`,
    )
    .bind(
      row.workspace,
      row.repo.toLowerCase(),
      row.kind,
      row.num,
      row.objectKey,
      row.prefixId,
      row.laneId,
      row.source,
      nowIso,
      nowIso,
    )
    .run();
}

/** One index row, or null. Test/ops read helper — NOT the phase-3 hot read. */
export async function attachmentRow(
  db: D1Queryable,
  workspace: string,
  objectKey: string,
): Promise<AttachmentIndexRow | null> {
  const row = await db
    .prepare(
      `SELECT ${SELECT_COLUMNS} FROM github_attachments
       WHERE workspace = ? AND object_key = ?`,
    )
    .bind(workspace, objectKey)
    .first<AttachmentDbRow>();
  return row ? fromRow(row) : null;
}

/**
 * Hides an attachment from the managed comment without deleting the object
 * or the row (issue #709's doctrine: detach means "removed from the
 * comment", never "deleted"). Mirrors the `gh.detached='true'` metadata
 * stamp the adopt path already writes.
 */
export async function detachAttachment(
  db: D1Queryable,
  workspace: string,
  objectKey: string,
  now = new Date(),
): Promise<void> {
  const nowIso = now.toISOString();
  await db
    .prepare(
      `UPDATE github_attachments SET detached_at = ?, updated_at = ?
       WHERE workspace = ? AND object_key = ?`,
    )
    .bind(nowIso, nowIso, workspace, objectKey)
    .run();
}

/** Inverse of `detachAttachment`: the link reappeared, so the row renders again. */
export async function reattachAttachment(
  db: D1Queryable,
  workspace: string,
  objectKey: string,
  now = new Date(),
): Promise<void> {
  await db
    .prepare(
      `UPDATE github_attachments SET detached_at = NULL, updated_at = ?
       WHERE workspace = ? AND object_key = ?`,
    )
    .bind(now.toISOString(), workspace, objectKey)
    .run();
}

/**
 * D1's hard cap on bound parameters per query (100 — not SQLite's ~999);
 * `test/helpers/sqlite-d1.ts` enforces the same ceiling. Same constant and
 * same reasoning as file-metadata.ts's `D1_MAX_BOUND_PARAMS`.
 */
const D1_MAX_BOUND_PARAMS = 100;

/** Removes an object's index row (e.g. on object delete). */
export async function deleteAttachment(
  db: D1Queryable,
  workspace: string,
  objectKey: string,
): Promise<void> {
  await db
    .prepare(`DELETE FROM github_attachments WHERE workspace = ? AND object_key = ?`)
    .bind(workspace, objectKey)
    .run();
}

/**
 * Removes index rows for a set of objects in one pass (the retention
 * purge's delete batches). Chunked to stay under D1's bound-parameter
 * limit, exactly like `deleteFileMetadataForKeys`. No-op on an empty list.
 */
export async function deleteAttachmentsForKeys(
  db: D1Queryable,
  workspace: string,
  keys: string[],
): Promise<void> {
  const chunkSize = Math.max(1, D1_MAX_BOUND_PARAMS - 1); // the workspace bind
  for (let i = 0; i < keys.length; i += chunkSize) {
    const chunk = keys.slice(i, i + chunkSize);
    const placeholders = chunk.map(() => "?").join(", ");
    await db
      .prepare(
        `DELETE FROM github_attachments WHERE workspace = ? AND object_key IN (${placeholders})`,
      )
      .bind(workspace, ...chunk)
      .run();
  }
}

/** Removes every index row for a workspace being torn down. */
export async function deleteAttachmentsForWorkspace(
  db: D1Queryable,
  workspace: string,
): Promise<void> {
  await db.prepare(`DELETE FROM github_attachments WHERE workspace = ?`).bind(workspace).run();
}

/**
 * Follows an object through a private-prefix rotation. Destination-first
 * wipe then UPDATE, mirroring how rotation re-keys `file_metadata`
 * (github-private-prefix-service.ts): rotation's own `putObject` at the new
 * key has already inserted a row there, and a second source id in the same
 * sweep can produce the same tail — either way the OLD row is the sole
 * source of truth for the new key, and a plain UPDATE onto an occupied
 * (workspace, object_key) would throw a UNIQUE constraint violation.
 */
export async function rekeyAttachment(
  db: D1Queryable,
  workspace: string,
  fromKey: string,
  toKey: string,
  newPrefixId: string | null,
  now = new Date(),
): Promise<void> {
  await deleteAttachment(db, workspace, toKey);
  await db
    .prepare(
      `UPDATE github_attachments SET object_key = ?, prefix_id = ?, updated_at = ?
       WHERE workspace = ? AND object_key = ?`,
    )
    .bind(toKey, newPrefixId, now.toISOString(), workspace, fromKey)
    .run();
}
