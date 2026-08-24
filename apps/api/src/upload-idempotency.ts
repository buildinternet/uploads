/**
 * Retry-safe object `PUT` (issue #829).
 *
 * Unlike gallery/token creation, a `PUT` writes bytes to R2 and *then* does
 * D1 usage/metadata work, and R2 has no transaction with D1 — so claim, do
 * the work, and complete can't be one atomic `db.batch`. This reuses the
 * same `idempotency_requests` table and claim/replay shape as
 * `gallery-idempotency.ts` / `token-idempotency.ts`, split into three
 * separate statements gated by `owner_nonce` instead of one batch, plus a
 * short `pending` TTL (`PENDING_TTL_MS`) distinct from the 24h completed
 * retention — so a crash between the R2 write and the completing `UPDATE`
 * doesn't strand every retry behind a day-long `idempotency_request_in_progress`.
 *
 * The replay body carries no secret (an upload response has nothing to
 * protect), so — unlike `token-idempotency.ts` — it is stored as plain JSON:
 * no encryption, no key-ring, no fail-closed path.
 */
import { ConflictError } from "@uploads/errors";
import { boundedRead, type DataReadEnv } from "./data-read-bounds";
import type { D1Queryable } from "./db-session";
import {
  conflictFor,
  IDEMPOTENCY_RETENTION_HOURS,
  validateIdempotencyKey,
  type StoredRequest,
} from "./idempotency-core";
import { sha256Hex } from "./workspace";

export const UPLOAD_PUT_OPERATION = "upload.put.v1";

/** Crash-mid-flight window: long enough for the slowest single-shot upload, short enough that a stall doesn't strand retries behind `idempotency_request_in_progress` for a day. */
export const PENDING_TTL_MS = 5 * 60 * 1000;

/** Request fields that must match for a retry to replay rather than conflict. */
export interface UploadFingerprintInput {
  finalKey: string;
  contentSha256: string;
  visibility: string | undefined;
  replace: boolean;
  metadata: Record<string, string> | undefined;
}

export type IdempotentUploadResult<T> = { value: T; replayed: boolean };

/** Stable stringify: sorts object keys so header ordering never trips a false `idempotency_key_reused`. */
function stableStringify(value: Record<string, string> | undefined): string {
  if (!value) return "null";
  const sorted: Record<string, string> = {};
  for (const key of Object.keys(value).sort()) sorted[key] = value[key]!;
  return JSON.stringify(sorted);
}

function fingerprintFor(input: UploadFingerprintInput): Promise<string> {
  return sha256Hex(
    JSON.stringify({
      operation: UPLOAD_PUT_OPERATION,
      finalKey: input.finalKey,
      contentSha256: input.contentSha256,
      visibility: input.visibility ?? null,
      replace: input.replace,
      metadata: stableStringify(input.metadata),
    }),
  );
}

/**
 * Claims `key`, runs `run()` (the real `putObject`), and stores the plain-JSON
 * 201 body. `db` must be primary-constrained (see `primaryDbFor`) so the claim
 * observes concurrent writers.
 *
 * - On `run()` throwing `ConflictError` `key_exists` (the crash-window case —
 *   a prior attempt's bytes already landed but the claim never completed),
 *   calls `reconcile()`; a non-null result is treated as our own earlier
 *   upload and completes the claim. A null result means a genuine conflict:
 *   the claim is released and `key_exists` is rethrown.
 * - Any other `run()` failure releases the claim and rethrows — errors are
 *   never cached.
 * - Losing the claim race replays the winner's stored response (bounded read
 *   only; `run()`/`reconcile()` are never deadline-raced), or throws
 *   `idempotency_key_reused` / `idempotency_request_in_progress`.
 */
export async function putObjectIdempotently<T>(
  db: D1Queryable,
  input: {
    workspace: string;
    principal: string;
    key: string;
    fingerprint: UploadFingerprintInput;
    run: () => Promise<T>;
    reconcile: () => Promise<T | null>;
    readEnv?: DataReadEnv;
    now?: Date;
  },
): Promise<IdempotentUploadResult<T>> {
  validateIdempotencyKey(input.key);

  const now = input.now ?? new Date();
  const keyHash = await sha256Hex(input.key);
  const fp = await fingerprintFor(input.fingerprint);
  const ownerNonce = crypto.randomUUID();
  const createdAt = now.toISOString();
  const pendingExpires = new Date(now.getTime() + PENDING_TTL_MS).toISOString();
  const completedExpires = new Date(
    now.getTime() + IDEMPOTENCY_RETENTION_HOURS * 60 * 60 * 1000,
  ).toISOString();
  const scope = [input.workspace, input.principal, UPLOAD_PUT_OPERATION, keyHash] as const;

  // Claim: identical shape to token/gallery idempotency's claim INSERT, but
  // the pending row carries the short PENDING_TTL deadline rather than the
  // 24h retention — a completed row's expires_at is always 24h out, so this
  // predicate re-claims an expired pending row but never a live completed one.
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
    .bind(...scope, fp, ownerNonce, createdAt, pendingExpires);
  await claim.run();

  const owner = await db
    .prepare(
      `SELECT owner_nonce, state FROM idempotency_requests
       WHERE workspace = ? AND principal = ? AND operation = ? AND key_hash = ?`,
    )
    .bind(...scope)
    .first<{ owner_nonce: string | null; state: "pending" | "completed" }>();

  if (owner?.owner_nonce === ownerNonce && owner.state === "pending") {
    const complete = (responseBody: string) =>
      db
        .prepare(
          `UPDATE idempotency_requests
           SET state = 'completed', owner_nonce = NULL, response_status = 201,
               response_body = ?, expires_at = ?
           WHERE workspace = ? AND principal = ? AND operation = ? AND key_hash = ?
             AND owner_nonce = ? AND state = 'pending'`,
        )
        .bind(responseBody, completedExpires, ...scope, ownerNonce)
        .run();
    const release = () =>
      db
        .prepare(
          `DELETE FROM idempotency_requests
           WHERE workspace = ? AND principal = ? AND operation = ? AND key_hash = ?
             AND owner_nonce = ? AND state = 'pending'`,
        )
        .bind(...scope, ownerNonce)
        .run();

    try {
      const value = await input.run();
      await complete(JSON.stringify(value));
      return { value, replayed: false };
    } catch (err) {
      if (err instanceof ConflictError && err.code === "key_exists") {
        const reconciled = await input.reconcile();
        if (reconciled) {
          await complete(JSON.stringify(reconciled));
          return { value: reconciled, replayed: true };
        }
      }
      await release();
      throw err;
    }
  }

  // Did not win the claim: replay the winner's response, or conflict. Bound
  // only this standalone read; run()/reconcile() above are never raced.
  const replayLookup = db
    .prepare(
      `SELECT fingerprint, owner_nonce, state, response_status, response_body, expires_at
       FROM idempotency_requests
       WHERE workspace = ? AND principal = ? AND operation = ? AND key_hash = ?`,
    )
    .bind(...scope);
  const row = await boundedRead(input.readEnv ?? {}, () => replayLookup.first<StoredRequest>(), {
    name: "d1_upload_idempotency_replay",
  });

  const settled: StoredRequest = row ?? {
    fingerprint: fp,
    owner_nonce: null,
    state: "pending",
    response_status: null,
    response_body: null,
    expires_at: pendingExpires,
  };
  if (settled.fingerprint !== fp || settled.state !== "completed" || !settled.response_body) {
    conflictFor(settled, fp);
  }
  return { value: JSON.parse(settled.response_body) as T, replayed: true };
}
