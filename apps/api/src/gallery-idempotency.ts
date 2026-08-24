import { ConflictError, ValidationError } from "@uploads/errors";
import { MAX_GALLERIES_PER_WORKSPACE, prepareGalleryInsert, type GalleryRecord } from "./galleries";
import { sha256Hex } from "./workspace";
import type { D1Queryable } from "./db-session";

export const IDEMPOTENCY_RETENTION_HOURS = 24;
const GALLERY_CREATE_OPERATION = "gallery.create.v1";
const IDEMPOTENCY_KEY_RE = /^[\x21-\x7e]{1,255}$/;

interface StoredRequest {
  fingerprint: string;
  owner_nonce: string | null;
  state: "pending" | "completed";
  response_status: number | null;
  response_body: string | null;
  expires_at: string;
}

export type IdempotentGalleryResult<T> =
  | { status: "ok"; value: T; replayed: boolean }
  | { status: "limit"; limit: number };

export function validateIdempotencyKey(value: string): void {
  if (!IDEMPOTENCY_KEY_RE.test(value)) {
    throw new ValidationError("Idempotency-Key must contain 1 to 255 visible ASCII characters.", {
      code: "idempotency_key_invalid",
    });
  }
}

function conflictFor(row: StoredRequest, fingerprint: string): never {
  if (row.fingerprint !== fingerprint) {
    throw new ConflictError("Idempotency-Key was already used for a different request.", {
      code: "idempotency_key_reused",
    });
  }
  throw new ConflictError("A request with this Idempotency-Key is still in progress.", {
    code: "idempotency_request_in_progress",
  });
}

/**
 * Atomically claims a key, creates the gallery, and stores the exact 201 JSON.
 * The canonical and compatibility routes both use the same logical operation.
 */
export async function createGalleryIdempotently<T>(
  db: D1Queryable,
  input: {
    workspace: string;
    principal: string;
    key: string;
    record: GalleryRecord;
    response: T;
    now?: Date;
  },
): Promise<IdempotentGalleryResult<T>> {
  validateIdempotencyKey(input.key);
  const now = input.now ?? new Date();
  const createdAt = now.toISOString();
  const expiresAt = new Date(
    now.getTime() + IDEMPOTENCY_RETENTION_HOURS * 60 * 60 * 1000,
  ).toISOString();
  const keyHash = await sha256Hex(input.key);
  const fingerprint = await sha256Hex(
    JSON.stringify({
      operation: GALLERY_CREATE_OPERATION,
      title: input.record.title,
      description: input.record.description,
    }),
  );
  const ownerNonce = crypto.randomUUID();
  const responseBody = JSON.stringify(input.response);
  const scope = [input.workspace, input.principal, GALLERY_CREATE_OPERATION, keyHash] as const;

  const claim = db
    .prepare(
      `INSERT INTO idempotency_requests
       (workspace, principal, operation, key_hash, fingerprint, owner_nonce, state,
        response_status, response_body, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, ?, ?)
       ON CONFLICT (workspace, principal, operation, key_hash) DO UPDATE SET
         fingerprint = excluded.fingerprint,
         owner_nonce = excluded.owner_nonce,
         state = 'pending',
         response_status = NULL,
         response_body = NULL,
         created_at = excluded.created_at,
         expires_at = excluded.expires_at
       WHERE idempotency_requests.expires_at <= excluded.created_at`,
    )
    .bind(...scope, fingerprint, ownerNonce, createdAt, expiresAt);

  const ownsClaim = {
    sql: `EXISTS (
      SELECT 1 FROM idempotency_requests
      WHERE workspace = ? AND principal = ? AND operation = ? AND key_hash = ?
        AND owner_nonce = ? AND state = 'pending'
    )`,
    values: [...scope, ownerNonce],
  };
  const insertGallery = prepareGalleryInsert(db, input.record, ownsClaim);
  const complete = db
    .prepare(
      `UPDATE idempotency_requests
       SET state = 'completed', owner_nonce = NULL, response_status = 201, response_body = ?
       WHERE workspace = ? AND principal = ? AND operation = ? AND key_hash = ?
         AND owner_nonce = ? AND state = 'pending'
         AND EXISTS (SELECT 1 FROM galleries WHERE id = ? AND workspace = ?)`,
    )
    .bind(responseBody, ...scope, ownerNonce, input.record.id, input.workspace);
  // A quota refusal is not cached and must not leave a pending claim behind.
  const releaseFailedClaim = db
    .prepare(
      `DELETE FROM idempotency_requests
       WHERE workspace = ? AND principal = ? AND operation = ? AND key_hash = ?
         AND owner_nonce = ? AND state = 'pending'
         AND NOT EXISTS (SELECT 1 FROM galleries WHERE id = ? AND workspace = ?)`,
    )
    .bind(...scope, ownerNonce, input.record.id, input.workspace);

  const results = await db.batch([claim, insertGallery, complete, releaseFailedClaim]);
  if ((results[1]?.meta.changes ?? 0) > 0) {
    return { status: "ok", value: input.response, replayed: false };
  }

  const row = await db
    .prepare(
      `SELECT fingerprint, owner_nonce, state, response_status, response_body, expires_at
       FROM idempotency_requests
       WHERE workspace = ? AND principal = ? AND operation = ? AND key_hash = ?`,
    )
    .bind(...scope)
    .first<StoredRequest>();

  if (!row) return { status: "limit", limit: MAX_GALLERIES_PER_WORKSPACE };
  if (row.fingerprint !== fingerprint || row.state !== "completed" || !row.response_body) {
    return conflictFor(row, fingerprint);
  }
  return { status: "ok", value: JSON.parse(row.response_body) as T, replayed: true };
}

/** Bounded daily cleanup. Expiry is also enforced when a key is claimed. */
export async function purgeExpiredIdempotencyRequests(
  db: D1Queryable,
  now = new Date(),
): Promise<{ deleted: number; truncated: boolean }> {
  const batchSize = 500;
  const maxBatches = 20;
  let deleted = 0;
  for (let batch = 0; batch < maxBatches; batch++) {
    const result = await db
      .prepare(
        `DELETE FROM idempotency_requests
         WHERE rowid IN (
           SELECT rowid FROM idempotency_requests WHERE expires_at <= ? LIMIT ?
         )`,
      )
      .bind(now.toISOString(), batchSize)
      .run();
    const changes = result.meta.changes ?? 0;
    deleted += changes;
    if (changes < batchSize) return { deleted, truncated: false };
  }
  return { deleted, truncated: true };
}
