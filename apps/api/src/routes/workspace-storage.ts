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
import { storageConfig } from "../storage";
import type { StorageLane, WorkspaceRecord } from "../workspace";

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

/** A saved-but-inactive lane, projected for the settings/admin UI — never a credential value. */
export interface StorageLaneStatus {
  laneId: string;
  /** "standby" = saved, never active (no `lastActiveAt`); "fallback" = a former active lane that may hold objects. */
  role: "standby" | "fallback";
  bucket: string;
  publicBaseUrl?: string;
  verifiedAt?: string;
  lastActiveAt?: string;
  accountIdMasked?: string;
  accessKeyIdLast4?: string;
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
  /** Id of the active lane (the top-level fields above). Absent on a record that predates lanes. */
  activeLaneId?: string;
  /** Every other configured lane: saved-but-never-used configs and demoted former actives. */
  lanes: StorageLaneStatus[];
}

/** Masked projection of one `StorageLane` for `storageStatusResponse` — never a credential value. */
function laneStatus(lane: StorageLane): StorageLaneStatus {
  return {
    laneId: lane.id,
    role: lane.lastActiveAt ? "fallback" : "standby",
    bucket: lane.bucket,
    publicBaseUrl: lane.publicBaseUrl,
    verifiedAt: lane.verifiedAt,
    lastActiveAt: lane.lastActiveAt,
    accountIdMasked: maskTrailing(lane.accountId),
    accessKeyIdLast4: lane.storageAccessKeyIdLast4,
  };
}

/**
 * Projection shared by `GET /me/workspaces/:name/storage` and the success
 * response of `PUT`/`POST .../activate`/`DELETE` — never includes credential
 * values (precedent: `GET /admin/workspaces/:name` in `admin.ts`, which
 * projects presence booleans only). `byoBucketEnabled` is always reported,
 * even in shared mode, because the settings UI needs it to decide whether to
 * show the "connect your own bucket" panel at all. `lanes` covers every
 * *other* configured lane (standby saves + demoted former actives) — the
 * active lane itself is the top-level fields, not a `lanes` entry.
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
    activeLaneId: record.storageLaneId,
    lanes: (record.storageLanes ?? []).map(laneStatus),
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

/**
 * Re-verify candidate for a lane about to be activated. Opens its (possibly
 * sealed) credentials the same way `storageConfig` does for the active lane
 * — `StorageLane`'s field shape matches `StorageLaneFields`, the same bag
 * `storageConfig` resolves, so it can stand in for a `WorkspaceRecord` here.
 * `adoptExistingContents: true` because a lane being reactivated (or an
 * activate-back-to-shared lane) may already hold objects — the verify
 * pipeline's `not-empty` check must not treat that as a failure.
 */
export async function laneVerifyCandidate(
  env: Env,
  lane: StorageLane,
): Promise<StorageVerifyCandidate> {
  const config = await storageConfig(env, lane as unknown as WorkspaceRecord);
  return {
    bucket: config.bucket,
    accountId: config.accountId ?? "",
    accessKeyId: config.accessKeyId ?? "",
    secretAccessKey: config.secretAccessKey ?? "",
    publicBaseUrl: config.publicBaseUrl,
    adoptExistingContents: true,
    jurisdiction: config.jurisdiction,
  };
}

/**
 * `POST .../storage/activate`'s stale-verify re-check — opens the target
 * lane's credentials into a candidate (`laneVerifyCandidate`) and runs it
 * through the same `storageVerify` seam `PUT` uses, so route tests
 * substitute a fake verify implementation once for both routes.
 */
export async function verifyLaneForActivate(
  env: Env,
  lane: StorageLane,
): Promise<StorageVerifyResult> {
  return storageVerify(await laneVerifyCandidate(env, lane));
}

/** Milliseconds a lane's `verifiedAt` may age before `activate` re-runs verify against it. */
export const LANE_VERIFY_STALE_MS = 10 * 60 * 1000;

/** True when `verifiedAt` is missing or older than {@link LANE_VERIFY_STALE_MS}. */
export function isLaneVerifyStale(verifiedAt: string | undefined, now = new Date()): boolean {
  if (!verifiedAt) return true;
  const verifiedMs = Date.parse(verifiedAt);
  if (!Number.isFinite(verifiedMs)) return true;
  return now.getTime() - verifiedMs > LANE_VERIFY_STALE_MS;
}

/**
 * Upsert `lane` into `lanes` keyed by bucket+accountId identity, preserving
 * an existing match's `id` and `lastActiveAt` — re-saving a standby config
 * (credential rotation) refreshes creds/verification without minting a new
 * lane id or silently clearing fallback status.
 */
export function upsertStandbyLane(
  lanes: StorageLane[] | undefined,
  lane: StorageLane,
): StorageLane[] {
  const existing = lanes ?? [];
  const idx = existing.findIndex(
    (l) => l.bucket === lane.bucket && (l.accountId ?? null) === (lane.accountId ?? null),
  );
  if (idx === -1) return [...existing, lane];
  const prior = existing[idx]!;
  const next = [...existing];
  next[idx] = { ...lane, id: prior.id, lastActiveAt: prior.lastActiveAt };
  return next;
}

/**
 * Upsert a freshly-demoted (just-deactivated) lane into `lanes` keyed by
 * bucket+accountId, replacing any stale entry outright — the demoted lane's
 * id (derived from the record's own `storageLaneId`) is always authoritative
 * here, unlike `upsertStandbyLane`'s "preserve the existing id" rule.
 */
export function upsertDemotedLane(
  lanes: StorageLane[] | undefined,
  lane: StorageLane,
): StorageLane[] {
  const existing = (lanes ?? []).filter(
    (l) => !(l.bucket === lane.bucket && (l.accountId ?? null) === (lane.accountId ?? null)),
  );
  return [...existing, lane];
}
