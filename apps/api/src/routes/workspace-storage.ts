/**
 * Helpers for the self-serve BYO-bucket storage routes on `/me` (issue #583
 * Task 1.1). The routes themselves live in `me.ts` alongside the
 * comment-settings triple they're modeled on (same audience: `sessionAuth` +
 * `requireSessionUser` + `adminWorkspaceOr403`, writes behind `allowWrite`) —
 * this file holds the pure/reusable pieces so that file doesn't grow a second
 * copy of masking and projection logic.
 */
import {
  verifyStorageConfig,
  type StorageVerifyCandidate,
  type StorageVerifyOptions,
  type StorageVerifyResult,
} from "../storage-verify";
import { storageBudgetApplies } from "../budget";
import { reconcileWorkspaceUsage } from "../reconcile";
import type { WorkspaceRecord } from "../workspace";

/** Last 4 chars only, prefixed with an ellipsis (e.g. `"…abcd"`). `undefined` for an empty/missing value. */
export function maskTrailing(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return `…${value.slice(-4)}`;
}

/**
 * True when `record` is customer-credential (BYO) storage: HTTP credentials
 * with no R2 binding. Delegates to `storageBudgetApplies` (budget.ts) rather
 * than re-deriving the signal, so the two surfaces can't drift on what counts
 * as BYO — `storageBudgetApplies` returns `false` for exactly this shape.
 */
export function isByoRecord(
  record: Pick<WorkspaceRecord, "binding" | "accountId" | "accessKeyId" | "secretAccessKey">,
): boolean {
  return !storageBudgetApplies(record);
}

export interface StorageStatusResponse {
  mode: "shared" | "byo";
  byoBucketEnabled: boolean;
  bucket?: string;
  accountIdMasked?: string;
  accessKeyIdLast4?: string;
  publicBaseUrl?: string;
  configuredAt?: string;
  verifiedAt?: string;
  jurisdiction?: string;
}

/**
 * Projection shared by `GET /me/workspaces/:name/storage` and the success
 * response of `PUT` — never includes credential values (precedent: `GET
 * /admin/workspaces/:name` in `admin.ts`, which projects presence booleans
 * only). `byoBucketEnabled` is always reported, even in shared mode, because
 * the settings UI needs it to decide whether to show the "connect your own
 * bucket" panel at all.
 */
export function storageStatusResponse(
  record: WorkspaceRecord,
  byoBucketEnabled: boolean,
): StorageStatusResponse {
  const byo = isByoRecord(record);
  return {
    mode: byo ? "byo" : "shared",
    byoBucketEnabled,
    bucket: record.bucket,
    publicBaseUrl: record.publicBaseUrl,
    accountIdMasked: byo ? maskTrailing(record.accountId) : undefined,
    // Never derived from `record.accessKeyId` — after a self-serve save that
    // field holds the sealed `enc:v1:` blob, so its last 4 characters would
    // be ciphertext. The PUT route stamps the plaintext fragment at seal time.
    accessKeyIdLast4: byo ? record.storageAccessKeyIdLast4 : undefined,
    configuredAt: record.storageConfiguredAt,
    verifiedAt: record.storageVerifiedAt,
    jurisdiction: byo ? record.jurisdiction : undefined,
  };
}

/**
 * Verify pipeline entry point the storage routes call, indirected through
 * this mutable binding so tests can substitute a fake without hitting the
 * network. Candidate storage is always HTTP-credential mode (no R2 binding
 * to fake the way other routes fake R2 with `FakeR2Bucket`), so route tests
 * need this seam instead — restore the default with
 * `setStorageVerifyForTests(undefined)` in an `afterEach`/`finally`.
 */
let runStorageVerify: (
  candidate: StorageVerifyCandidate,
  opts?: StorageVerifyOptions,
) => Promise<StorageVerifyResult> = verifyStorageConfig;

export function storageVerify(
  candidate: StorageVerifyCandidate,
  opts?: StorageVerifyOptions,
): Promise<StorageVerifyResult> {
  return runStorageVerify(candidate, opts);
}

/** Test-only: swap the verify implementation. Pass `undefined` to restore the real pipeline. */
export function setStorageVerifyForTests(
  fn:
    | ((
        candidate: StorageVerifyCandidate,
        opts?: StorageVerifyOptions,
      ) => Promise<StorageVerifyResult>)
    | undefined,
): void {
  runStorageVerify = fn ?? verifyStorageConfig;
}

/**
 * Usage-ledger rebuild the storage routes call after a guard-bypassed
 * backing-storage transition (`adoptExistingContents` on attach, `force` on
 * detach) — same test-seam rationale as `storageVerify` above: the real
 * `reconcileWorkspaceUsage` walks the (possibly remote) bucket.
 */
let runStorageReconcile: (env: Env, ws: WorkspaceRecord, name: string) => Promise<unknown> =
  reconcileWorkspaceUsage;

export function storageReconcile(env: Env, ws: WorkspaceRecord, name: string): Promise<unknown> {
  return runStorageReconcile(env, ws, name);
}

/** Test-only: swap the reconcile implementation. Pass `undefined` to restore the real one. */
export function setStorageReconcileForTests(
  fn: ((env: Env, ws: WorkspaceRecord, name: string) => Promise<unknown>) | undefined,
): void {
  runStorageReconcile = fn ?? reconcileWorkspaceUsage;
}

/** Parses the request body into a `StorageVerifyCandidate` shape (no validation — `verifyStorageConfig`'s `shape` check does that). */
export function candidateFromBody(body: unknown): StorageVerifyCandidate {
  const b = (body ?? {}) as Record<string, unknown>;
  return {
    bucket: typeof b.bucket === "string" ? b.bucket : "",
    accountId: typeof b.accountId === "string" ? b.accountId : "",
    accessKeyId: typeof b.accessKeyId === "string" ? b.accessKeyId : "",
    secretAccessKey: typeof b.secretAccessKey === "string" ? b.secretAccessKey : "",
    publicBaseUrl: typeof b.publicBaseUrl === "string" ? b.publicBaseUrl : undefined,
    adoptExistingContents: b.adoptExistingContents === true,
    jurisdiction:
      typeof b.jurisdiction === "string" && b.jurisdiction !== "" ? b.jurisdiction : undefined,
  };
}
