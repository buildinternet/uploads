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
  buildClaimStatement,
  buildReplayLookup,
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
  /** The effective declared type (`resolveDeclaredContentType`), since it can change the stored type for the same bytes. */
  declaredContentType: string | undefined;
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
      declaredContentType: input.declaredContentType ?? null,
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

  // Claim the key. The pending row carries the short PENDING_TTL deadline rather
  // than the 24h retention a completed row gets, so `buildClaimStatement`'s
  // `expires_at <= created_at` predicate re-claims an expired pending row but
  // never a live completed one. `meta.changes > 0` means we own the claim — the
  // same signal gallery/token read off their batched insert.
  const claim = buildClaimStatement(db, scope, fp, ownerNonce, createdAt, pendingExpires);
  const claimed = await claim.run();

  if ((claimed.meta.changes ?? 0) > 0) {
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
      const done = await complete(JSON.stringify(value));
      // A 0-row completion means our pending claim was stolen (its TTL expired
      // mid-`run()` and another request re-claimed). We still answer 201 — the
      // upload landed — but the stored row now belongs to the other owner, so a
      // racing retry may briefly see `pending`. Log it so that stays diagnosable.
      if ((done.meta.changes ?? 0) === 0) {
        console.warn({
          event: "upload_idempotency_completion_lost",
          workspace: input.workspace,
          finalKey: input.fingerprint.finalKey,
        });
      }
      return { value, replayed: false };
    } catch (err) {
      if (err instanceof ConflictError && err.code === "key_exists") {
        // A prior attempt's bytes already landed but its claim never completed.
        // `reconcile()` re-drives the write only when the stored content hash
        // matches — our own interrupted upload — and returns null on a genuine
        // key collision, which surfaces as `key_exists`.
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
  const replayLookup = buildReplayLookup(db, scope);
  const row = await boundedRead(input.readEnv ?? {}, () => replayLookup.first<StoredRequest>(), {
    name: "d1_upload_idempotency_replay",
  });

  // A missing row means the winner's claim is still settling — treat as
  // in-progress so the caller retries.
  if (!row) {
    throw new ConflictError("A request with this Idempotency-Key is still in progress.", {
      code: "idempotency_request_in_progress",
    });
  }
  if (row.fingerprint !== fp || row.state !== "completed" || !row.response_body) {
    conflictFor(row, fp);
  }
  return { value: JSON.parse(row.response_body) as T, replayed: true };
}
