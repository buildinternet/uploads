/**
 * Shared primitives for `Idempotency-Key` support across operations.
 *
 * The per-operation modules (`gallery-idempotency.ts`, `token-idempotency.ts`)
 * own their transaction shape and response projection; this module owns the
 * pieces that must stay identical between them: key validation, the stored-row
 * type, the conflict semantics, and the retention sweep. All records live in
 * one `idempotency_requests` table keyed by
 * `(workspace, principal, operation, key_hash)`, so a single cron sweep and a
 * single key format cover every operation.
 */
import { ConflictError, ValidationError } from "@uploads/errors";
import type { D1Queryable } from "./db-session";

/** Successful replay records are retained this long, then swept. */
export const IDEMPOTENCY_RETENTION_HOURS = 24;

/** 1–255 visible ASCII characters, matching the documented contract. */
export const IDEMPOTENCY_KEY_RE = /^[\x21-\x7e]{1,255}$/;

/** One row of `idempotency_requests`. `response_body` may be ciphertext. */
export interface StoredRequest {
  fingerprint: string;
  owner_nonce: string | null;
  state: "pending" | "completed";
  response_status: number | null;
  response_body: string | null;
  expires_at: string;
}

/** `(workspace, principal, operation, key_hash)` — the primary key every op scopes by. */
export type IdempotencyScope = readonly [
  workspace: string,
  principal: string,
  operation: string,
  keyHash: string,
];

/**
 * The claim upsert shared by every idempotent op. Inserts a fresh `pending`
 * row, or re-claims an existing one only when it has expired
 * (`expires_at <= created_at`) — a live pending or completed row is never
 * clobbered. `meta.changes > 0` after `.run()` (or on the batched result) means
 * this caller owns the claim. Callers bind their own `expires_at`: a short
 * pending TTL for the two-phase upload op, the 24h retention for the
 * single-batch gallery/token ops.
 */
export function buildClaimStatement(
  db: D1Queryable,
  scope: IdempotencyScope,
  fingerprint: string,
  ownerNonce: string,
  createdAt: string,
  expiresAt: string,
): D1PreparedStatement {
  return db
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
}

/** The scoped replay lookup shared by the replay/conflict tail of every op. */
export function buildReplayLookup(db: D1Queryable, scope: IdempotencyScope): D1PreparedStatement {
  return db
    .prepare(
      `SELECT fingerprint, owner_nonce, state, response_status, response_body, expires_at
       FROM idempotency_requests
       WHERE workspace = ? AND principal = ? AND operation = ? AND key_hash = ?`,
    )
    .bind(...scope);
}

export function validateIdempotencyKey(value: string): void {
  if (!IDEMPOTENCY_KEY_RE.test(value)) {
    throw new ValidationError("Idempotency-Key must contain 1 to 255 visible ASCII characters.", {
      code: "idempotency_key_invalid",
    });
  }
}

/**
 * Turns a losing/mismatched claim into the caller-facing 409. A different
 * fingerprint means the key was reused for a different request; anything else
 * (still pending, or missing the stored body) means a concurrent request holds
 * the claim. Never distinguishes another user's/workspace's key — the lookup is
 * already scoped to the caller, so a foreign key simply looks absent.
 */
export function conflictFor(row: StoredRequest, fingerprint: string): never {
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
 * Bounded daily cleanup for every operation's records. Expiry is also enforced
 * when a key is re-claimed, so this only reclaims space. D1 writes stay
 * unbounded (no per-statement deadline); the batch cap keeps a single cron
 * tick from running away.
 */
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
