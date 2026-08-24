/**
 * Retry-safe `POST /v1/tokens` (issue #829).
 *
 * A workspace token is shown exactly once: the `auth_tokens` row keeps only a
 * hash, so a naive retry either mints a second token or — worse — loses the
 * only plaintext copy when the response never reaches the client. This claims
 * an `Idempotency-Key`, mints the token, and stores the *encrypted* 201 body in
 * one D1 batch, so an identical retry replays the original plaintext token.
 *
 * The replay body carries the plaintext token, so unlike gallery idempotency it
 * is sealed with AES-GCM via the workspace secrets key ring (`secrets.ts`)
 * before it touches D1, and minting fails closed (`secrets_key_unconfigured`,
 * 503) when no key is configured — no token row, no replay row.
 *
 * Authorization is *not* re-checked here: the route runs full session +
 * membership + role + scope gating before calling this, on every request
 * including retries, so a revoked or downgraded caller is rejected before any
 * replay can occur. See routes/tokens.ts.
 */
import { ServiceUnavailableError } from "@uploads/errors";
import { type AuthTokenRecord, prepareTokenInsert } from "./auth-db";
import { boundedRead, type DataReadEnv } from "./data-read-bounds";
import type { D1Queryable } from "./db-session";
import {
  conflictFor,
  IDEMPOTENCY_RETENTION_HOURS,
  validateIdempotencyKey,
  type StoredRequest,
} from "./idempotency-core";
import { decryptSecret, encryptSecret, type SecretsKeyRing } from "./secrets";
import { sha256Hex } from "./workspace";

export const TOKEN_CREATE_OPERATION = "token.create.v1";

/** Request fields that must match for a retry to replay rather than conflict. */
export interface TokenFingerprintInput {
  scopes: readonly string[];
  label: string | null;
  /** `null` = never expires; a number = the requested TTL in seconds. */
  ttlSeconds: number | null;
}

export type IdempotentTokenResult<T> = { value: T; replayed: boolean };

/**
 * Normalize the effective request into a stable fingerprint. Scopes are sorted
 * so caller ordering never changes the result; the computed absolute expiry is
 * deliberately excluded (it drifts by wall-clock between retries) — the
 * requested `ttlSeconds` is what the caller controls.
 */
function fingerprintFor(input: TokenFingerprintInput): Promise<string> {
  return sha256Hex(
    JSON.stringify({
      operation: TOKEN_CREATE_OPERATION,
      scopes: [...input.scopes].sort(),
      label: input.label,
      ttlSeconds: input.ttlSeconds,
    }),
  );
}

/**
 * Atomically claim `key`, insert `record`, and store the encrypted `response`.
 * `db` must be primary-constrained (see `primaryDbFor`) so the claim observes
 * concurrent writers. Returns the (decrypted) original response on replay.
 *
 * @throws ServiceUnavailableError `secrets_key_unconfigured` when no encryption
 *   key is configured — before any row is written.
 * @throws ConflictError `idempotency_key_reused` / `idempotency_request_in_progress`.
 */
export async function createTokenIdempotently<T>(
  db: D1Queryable,
  input: {
    workspace: string;
    principal: string;
    key: string;
    record: AuthTokenRecord;
    fingerprint: TokenFingerprintInput;
    response: T;
    masterSecret: string | undefined;
    ring: SecretsKeyRing;
    readEnv?: DataReadEnv;
    now?: Date;
  },
): Promise<IdempotentTokenResult<T>> {
  validateIdempotencyKey(input.key);

  // Fail closed BEFORE any write: without a key we can neither seal the replay
  // body nor honor a future retry, and a plaintext token must never hit D1.
  if (!input.masterSecret) {
    throw new ServiceUnavailableError(
      "WORKSPACE_SECRETS_KEY is not configured; tokens cannot be minted idempotently",
      { code: "secrets_key_unconfigured" },
    );
  }

  const now = input.now ?? new Date();
  const createdAt = now.toISOString();
  const expiresAt = new Date(
    now.getTime() + IDEMPOTENCY_RETENTION_HOURS * 60 * 60 * 1000,
  ).toISOString();
  const keyHash = await sha256Hex(input.key);
  const fingerprint = await fingerprintFor(input.fingerprint);
  const ownerNonce = crypto.randomUUID();
  // Sealed here, before the batch: an encryption failure means nothing is
  // written (fail closed), and the stored row never contains the raw token.
  const responseBody = await encryptSecret(input.masterSecret, JSON.stringify(input.response));
  const scope = [input.workspace, input.principal, TOKEN_CREATE_OPERATION, keyHash] as const;

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
  const insertToken = prepareTokenInsert(db, input.record, ownsClaim);
  const complete = db
    .prepare(
      `UPDATE idempotency_requests
       SET state = 'completed', owner_nonce = NULL, response_status = 201, response_body = ?
       WHERE workspace = ? AND principal = ? AND operation = ? AND key_hash = ?
         AND owner_nonce = ? AND state = 'pending'
         AND EXISTS (SELECT 1 FROM auth_tokens WHERE id = ? AND workspace = ?)`,
    )
    .bind(responseBody, ...scope, ownerNonce, input.record.id, input.workspace);
  // If we lost the claim race the token was not inserted; drop our pending
  // claim so it can never mask the winner's completed row.
  const releaseFailedClaim = db
    .prepare(
      `DELETE FROM idempotency_requests
       WHERE workspace = ? AND principal = ? AND operation = ? AND key_hash = ?
         AND owner_nonce = ? AND state = 'pending'
         AND NOT EXISTS (SELECT 1 FROM auth_tokens WHERE id = ? AND workspace = ?)`,
    )
    .bind(...scope, ownerNonce, input.record.id, input.workspace);

  const results = await db.batch([claim, insertToken, complete, releaseFailedClaim]);
  if ((results[1]?.meta.changes ?? 0) > 0) {
    return { value: input.response, replayed: false };
  }

  // We did not mint — either a completed row already exists (replay) or another
  // request holds a pending claim (conflict). Bound only this standalone read;
  // the write batch above is never deadline-raced.
  const replayLookup = db
    .prepare(
      `SELECT fingerprint, owner_nonce, state, response_status, response_body, expires_at
       FROM idempotency_requests
       WHERE workspace = ? AND principal = ? AND operation = ? AND key_hash = ?`,
    )
    .bind(...scope);
  const row = await boundedRead(input.readEnv ?? {}, () => replayLookup.first<StoredRequest>(), {
    name: "d1_token_idempotency_replay",
  });

  // A missing row means the winner's claim is still settling; a pending
  // synthetic row makes `conflictFor` raise `idempotency_request_in_progress`.
  const settled: StoredRequest = row ?? {
    fingerprint,
    owner_nonce: null,
    state: "pending",
    response_status: null,
    response_body: null,
    expires_at: expiresAt,
  };
  if (
    settled.fingerprint !== fingerprint ||
    settled.state !== "completed" ||
    !settled.response_body
  ) {
    conflictFor(settled, fingerprint);
  }
  const opened = await decryptSecret(input.ring, settled.response_body);
  return { value: JSON.parse(opened.plaintext) as T, replayed: true };
}
