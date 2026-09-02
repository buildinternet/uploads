/**
 * Helpers for the self-serve BYO-bucket storage routes on `/me` (issue #583
 * Task 1.1). The routes themselves live in `me.ts` alongside the
 * comment-settings triple they're modeled on (same audience: `sessionAuth` +
 * `requireSessionUser` + `adminWorkspaceOr403`, writes behind `allowWrite`) —
 * this file holds the pure/reusable pieces so that file doesn't grow a second
 * copy of masking and projection logic.
 */
import {
  listR2Buckets,
  type ListBucketsCredentials,
  type ListBucketsResult,
} from "../r2-list-buckets";
import {
  ACTIVE_CONTENT_PROBE_SVG,
  checkActiveContentHeaders,
  defaultStorageClientFactory,
  PROBE_PREFIX,
  verifyStorageConfig,
  type StorageProbeClient,
  type StorageVerifyCandidate,
  type StorageVerifyCheck,
  type StorageVerifyOptions,
  type StorageVerifyResult,
} from "../storage-verify";
import { storageBudgetApplies } from "../budget";
import { healthFromFields, storageHealth, type StorageHealth } from "../storage-health";
import { reconcileWorkspaceUsage } from "../reconcile";
import { isSharedLane, storageConfig } from "../storage";
import type { StorageLane, WorkspaceRecord } from "../workspace";
import { providerCredentialFields } from "../workspace-lanes";

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
  record: Pick<
    WorkspaceRecord,
    "binding" | "accountId" | "accessKeyId" | "secretAccessKey" | "endpoint"
  >,
): boolean {
  return !storageBudgetApplies(record);
}

/** A saved-but-inactive lane, projected for the settings/admin UI — never a credential value. */
export interface StorageLaneStatus {
  laneId: string;
  /** "standby" = saved, never active (no `lastActiveAt`); "fallback" = a former active lane that may hold objects. */
  role: "standby" | "fallback";
  /** "shared" = platform-owned binding lane; "byo" = customer HTTP-credential lane. Explicit, never inferred from field absence — a client picking the shared lane by "no accountId" would be wrong the moment a masked field is added. */
  mode: "shared" | "byo";
  /** "r2" (default) or "s3". Absent only for the never-populated shared lane shape predating this field. */
  provider?: "r2" | "s3";
  bucket: string;
  publicBaseUrl?: string;
  verifiedAt?: string;
  /** Last successful `active-content-headers` verify check against this lane's public host (issue #929) — gates SVG/XML acceptance while this lane is active. */
  activeContentVerifiedAt?: string;
  lastActiveAt?: string;
  accountIdMasked?: string;
  accessKeyIdLast4?: string;
  /** s3-only. Service endpoint origin. Never present on an r2 lane. */
  endpoint?: string;
  /** s3-only. SigV4 signing region. Never present on an r2 lane. */
  region?: string;
  /** s3-only, advanced. Path-style addressing (`endpoint/bucket`) instead of virtual-hosted-style. Never present on an r2 lane. */
  forcePathStyle?: boolean;
  /** Set when this lane was demoted while flagged unhealthy (issue #826). */
  unhealthyAt?: string;
  /**
   * The same normalized health the active lane reports, for a lane that was
   * demoted while flagged (issue #826). Carries the validated code and its
   * sentence, so a client can say *what* broke on a fallback lane rather than
   * only that something did. Absent on a healthy lane — no `{ ok: true }`
   * noise on every entry.
   */
  health?: StorageHealth;
}

export interface StorageStatusResponse {
  mode: "shared" | "byo";
  byoBucketEnabled: boolean;
  bucket?: string;
  /** "r2" or "s3", only ever present in byo mode. */
  provider?: "r2" | "s3";
  accountIdMasked?: string;
  accessKeyIdLast4?: string;
  publicBaseUrl?: string;
  configuredAt?: string;
  verifiedAt?: string;
  /** Active lane's last successful `active-content-headers` verify check (issue #929) — gates SVG/XML acceptance. */
  activeContentVerifiedAt?: string;
  jurisdiction?: string;
  /** s3-only. Service endpoint origin of the active lane. */
  endpoint?: string;
  /** s3-only. SigV4 signing region of the active lane. */
  region?: string;
  /** s3-only, advanced. Path-style addressing (`endpoint/bucket`) of the active lane. */
  forcePathStyle?: boolean;
  /** Id of the active lane (the top-level fields above). Absent on a record that predates lanes. */
  activeLaneId?: string;
  /** Every other configured lane: saved-but-never-used configs and demoted former actives. */
  lanes: StorageLaneStatus[];
  /**
   * Whether the *active* lane's storage is currently working (issue #826).
   * Always `{ ok: true }` in shared mode — a platform-binding failure is not
   * a workspace-level state and never asks a workspace to fix anything.
   */
  health: StorageHealth;
}

/**
 * The r2-vs-s3 field split shared by every masked storage projection: an s3
 * lane/record carries `endpoint`/`region`/`forcePathStyle`, never an
 * `accountId`; an r2 one carries a masked `accountId`, never those three.
 * One source of truth for that split so `laneStatus` and
 * `storageStatusResponse` can't drift on which fields are omitted per
 * provider.
 */
function providerFields(
  isS3: boolean,
  fields: {
    accountId: string | undefined;
    endpoint: string | undefined;
    region: string | undefined;
    forcePathStyle: boolean | undefined;
  },
): {
  accountIdMasked?: string;
  endpoint?: string;
  region?: string;
  forcePathStyle?: boolean;
} {
  if (isS3) {
    return {
      endpoint: fields.endpoint,
      region: fields.region,
      forcePathStyle: fields.forcePathStyle,
    };
  }
  return { accountIdMasked: maskTrailing(fields.accountId) };
}

/** Masked projection of one `StorageLane` for `storageStatusResponse` — never a credential value. */
function laneStatus(lane: StorageLane): StorageLaneStatus {
  const health = healthFromFields(lane.unhealthyAt, lane.unhealthyCode);
  const isS3 = lane.provider === "s3";
  const shared = isSharedLane(lane);
  return {
    // Only present on an actually-flagged lane; see `StorageLaneStatus.health`.
    ...(health.ok ? {} : { health }),
    laneId: lane.id,
    role: lane.lastActiveAt ? "fallback" : "standby",
    mode: shared ? "shared" : "byo",
    provider: shared ? undefined : isS3 ? "s3" : "r2",
    bucket: lane.bucket,
    publicBaseUrl: lane.publicBaseUrl,
    verifiedAt: lane.verifiedAt,
    activeContentVerifiedAt: lane.activeContentVerifiedAt,
    lastActiveAt: lane.lastActiveAt,
    // Never both — an s3 lane carries endpoint/region, never an accountId.
    ...providerFields(isS3, {
      accountId: lane.accountId,
      endpoint: lane.endpoint,
      region: lane.region,
      forcePathStyle: lane.forcePathStyle,
    }),
    accessKeyIdLast4: lane.storageAccessKeyIdLast4,
    unhealthyAt: lane.unhealthyAt,
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
  const isS3 = byo && record.provider === "s3";
  return {
    mode: byo ? "byo" : "shared",
    byoBucketEnabled,
    bucket: record.bucket,
    provider: byo ? (isS3 ? "s3" : "r2") : undefined,
    publicBaseUrl: record.publicBaseUrl,
    // Never both — an s3 record carries endpoint/region, never an accountId
    // or jurisdiction. Only projected at all when `byo` (a shared-mode
    // record has neither field populated, but `providerFields` alone can't
    // express the outer `byo` gate).
    ...(byo
      ? providerFields(isS3, {
          accountId: record.accountId,
          endpoint: record.endpoint,
          region: record.region,
          forcePathStyle: record.forcePathStyle,
        })
      : {}),
    // Never derived from `record.accessKeyId` — after a self-serve save that
    // field holds the sealed `enc:v1:` blob, so its last 4 characters would
    // be ciphertext. The PUT route stamps the plaintext fragment at seal time.
    accessKeyIdLast4: byo ? record.storageAccessKeyIdLast4 : undefined,
    configuredAt: record.storageConfiguredAt,
    verifiedAt: record.storageVerifiedAt,
    activeContentVerifiedAt: record.storageActiveContentVerifiedAt,
    jurisdiction: byo && !isS3 ? record.jurisdiction : undefined,
    activeLaneId: record.storageLaneId,
    lanes: (record.storageLanes ?? []).map(laneStatus),
    health: byo ? storageHealth(record) : { ok: true },
  };
}

/**
 * Compact, bearer-safe lane summary for `GET /:workspace/usage` (issue
 * #775). Deliberately smaller than `storageStatusResponse`: usage is
 * readable by any member session or workspace bearer token (`files:read`),
 * so this projects no bucket names, domains, or masked credential
 * fragments — just which mode is active, how many former lanes still serve
 * old files, and whether the active lane is healthy. The full projection
 * stays admin/owner-session-gated on the settings routes.
 */
export function storageUsageSummary(record: WorkspaceRecord): {
  mode: "shared" | "byo";
  fallbackLanes: number;
  health: StorageHealth;
} {
  const byo = isByoRecord(record);
  return {
    mode: byo ? "byo" : "shared",
    // Fallback = a demoted former active (`lastActiveAt` set) that still
    // participates in read resolution. Standby saves don't serve anything,
    // so they don't count.
    fallbackLanes: (record.storageLanes ?? []).filter((lane) => lane.lastActiveAt).length,
    health: byo ? storageHealth(record) : { ok: true },
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

/**
 * Derives the active-content verification stamp from a verify pipeline
 * result (issue #929): `nowIso` when the recommended `active-content-headers`
 * check ran and passed, `undefined` otherwise — an absent check (no
 * `publicBaseUrl`, or the public-url check itself failed) counts the same as
 * a failing one. Callers stamp `StorageLane.activeContentVerifiedAt` /
 * `WorkspaceRecord.storageActiveContentVerifiedAt` with the result.
 */
export function activeContentStampFromVerify(
  result: StorageVerifyResult,
  nowIso: string,
): string | undefined {
  const check = result.checks.find((c) => c.id === "active-content-headers");
  return check?.ok ? nowIso : undefined;
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

/**
 * `listR2Buckets` entry point `storageBucketsHandler` calls, indirected
 * through this mutable binding for the same reason as `storageVerify` above
 * — route tests need to substitute a fake instead of hitting the network.
 * Restore the default with `setListBucketsForTests(undefined)` in an
 * `afterEach`/`finally`.
 */
let runListBuckets: (creds: ListBucketsCredentials) => Promise<ListBucketsResult> = listR2Buckets;

export function listBuckets(creds: ListBucketsCredentials): Promise<ListBucketsResult> {
  return runListBuckets(creds);
}

/** Test-only: swap the ListBuckets implementation. Pass `undefined` to restore the real one. */
export function setListBucketsForTests(
  fn: ((creds: ListBucketsCredentials) => Promise<ListBucketsResult>) | undefined,
): void {
  runListBuckets = fn ?? listR2Buckets;
}

/** Parses the request body into a `StorageVerifyCandidate` shape (no validation — `verifyStorageConfig`'s `shape` check does that). */
export function candidateFromBody(body: unknown): StorageVerifyCandidate {
  const b = (body ?? {}) as Record<string, unknown>;
  const provider = b.provider === "s3" ? "s3" : "r2";
  const isS3 = provider === "s3";
  return {
    provider,
    bucket: typeof b.bucket === "string" ? b.bucket : "",
    accessKeyId: typeof b.accessKeyId === "string" ? b.accessKeyId : "",
    secretAccessKey: typeof b.secretAccessKey === "string" ? b.secretAccessKey : "",
    publicBaseUrl: typeof b.publicBaseUrl === "string" ? b.publicBaseUrl : undefined,
    adoptExistingContents: b.adoptExistingContents === true,
    // s3 lanes never carry an accountId — leaving it undefined (rather than
    // "") keeps `laneIdentity` falling through to `endpoint` for s3
    // candidates, matching how a stored s3 lane's identity is computed.
    ...providerCredentialFields(isS3, {
      accountId: typeof b.accountId === "string" ? b.accountId : "",
      jurisdiction:
        typeof b.jurisdiction === "string" && b.jurisdiction !== "" ? b.jurisdiction : undefined,
      endpoint: typeof b.endpoint === "string" ? b.endpoint : undefined,
      region: typeof b.region === "string" ? b.region : undefined,
      forcePathStyle: b.forcePathStyle === true,
    }),
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
  if (config.provider === "s3") {
    return {
      provider: "s3",
      bucket: config.bucket,
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      publicBaseUrl: config.publicBaseUrl,
      adoptExistingContents: true,
      ...providerCredentialFields(true, {
        endpoint: config.endpoint,
        region: config.region,
        forcePathStyle: config.forcePathStyle,
      }),
    };
  }
  return {
    provider: "r2",
    bucket: config.bucket,
    accessKeyId: config.accessKeyId ?? "",
    secretAccessKey: config.secretAccessKey ?? "",
    publicBaseUrl: config.publicBaseUrl,
    adoptExistingContents: true,
    ...providerCredentialFields(false, {
      accountId: config.accountId ?? "",
      jurisdiction: config.jurisdiction,
    }),
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

/**
 * Runs *only* the active-content probe against `lane` (issue #929,
 * `POST .../storage/lanes/:laneId/verify-active-content`) — unlike
 * `verifyLaneForActivate`, this never runs the full shape/auth/round-trip
 * pipeline, just: open the lane's (possibly sealed) credentials into a real
 * client (`laneVerifyCandidate` + `defaultStorageClientFactory` — same
 * client-building steps `verifyLaneForActivate` uses, minus the
 * `verifyStorageConfig` wrapper), upload `ACTIVE_CONTENT_PROBE_SVG` under
 * `PROBE_PREFIX`, ask `checkActiveContentHeaders`, and delete the probe
 * object in `finally` regardless of the outcome. The caller is responsible
 * for confirming `lane.publicBaseUrl` is set before calling this — it is not
 * re-checked here.
 *
 * Everything from opening the lane's credentials through the probe upload is
 * wrapped in one try/catch (review follow-up, issue #929): bad/rotated
 * credentials, an unreachable bucket, or any other storage-client error
 * would otherwise escape as an unhandled rejection (a 500 at the route
 * layer) instead of the same "unknown, not broken" `inconclusive` outcome
 * `checkActiveContentHeaders` itself already returns for a thrown fetch —
 * the route leaves the stamp untouched either way.
 */
async function defaultLaneActiveContentCheck(
  env: Env,
  lane: StorageLane,
  fetchImpl: typeof fetch,
): Promise<StorageVerifyCheck> {
  const probeKey = `${PROBE_PREFIX}${crypto.randomUUID()}.svg`;
  let client: StorageProbeClient | undefined;
  try {
    const candidate = await laneVerifyCandidate(env, lane);
    client = defaultStorageClientFactory(candidate);
    await client.upload(probeKey, ACTIVE_CONTENT_PROBE_SVG, { contentType: "image/svg+xml" });
    return await checkActiveContentHeaders(candidate.publicBaseUrl ?? "", probeKey, fetchImpl);
  } catch {
    return {
      id: "active-content-headers",
      ok: false,
      required: false,
      inconclusive: true,
      hint: "could not write the SVG probe to this bucket — check the lane's credentials, then check again",
    };
  } finally {
    if (client) await client.delete(probeKey).catch(() => {});
  }
}

/**
 * Indirected through this mutable binding for the same reason as
 * `storageVerify`/`storageReconcile` above: building a real client resolves
 * (possibly sealed) credentials and would otherwise hit the network, so
 * route tests substitute a fake here instead. Restore the default with
 * `setLaneActiveContentCheckForTests(undefined)` in an `afterEach`/`finally`.
 */
let runLaneActiveContentCheck: (
  env: Env,
  lane: StorageLane,
  fetchImpl: typeof fetch,
) => Promise<StorageVerifyCheck> = defaultLaneActiveContentCheck;

export function laneActiveContentCheck(
  env: Env,
  lane: StorageLane,
  fetchImpl: typeof fetch = fetch,
): Promise<StorageVerifyCheck> {
  return runLaneActiveContentCheck(env, lane, fetchImpl);
}

/** Test-only: swap the lane active-content check implementation. Pass `undefined` to restore the real one. */
export function setLaneActiveContentCheckForTests(
  fn:
    | ((env: Env, lane: StorageLane, fetchImpl: typeof fetch) => Promise<StorageVerifyCheck>)
    | undefined,
): void {
  runLaneActiveContentCheck = fn ?? defaultLaneActiveContentCheck;
}
