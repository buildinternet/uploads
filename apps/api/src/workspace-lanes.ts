/**
 * Pure `WorkspaceRecord`/`StorageLane` transformations for two-lane storage
 * transitions (spec: docs/superpowers/specs/2026-08-22-two-lane-storage-design.md,
 * "Configure, then switch"). No HTTP concerns — the route handlers in
 * `routes/workspace-settings.ts` do parse → call these → respond; everything
 * here is a plain data transformation a test can call directly with no
 * `Context`/`Env`.
 */
import {
  newLaneId,
  type StorageLane,
  type StorageLaneFields,
  type WorkspaceRecord,
} from "./workspace";

/**
 * Builds the `StorageLane` object for demoting the record's *current*
 * top-level (active-lane) fields — the outgoing active config becomes a
 * fallback lane the moment a new one takes over, so pre-switch objects keep
 * resolving. Reuses the record's own `storageLaneId` as the demoted lane's id
 * when one exists (a record that has switched before); mints a fresh one for
 * a record on its first-ever switch (the implicit original/shared lane never
 * had an id).
 */
export function demoteActiveLane(current: WorkspaceRecord, nowIso: string): StorageLane {
  return {
    id: current.storageLaneId ?? newLaneId(),
    provider: "r2",
    bucket: current.bucket,
    binding: current.binding,
    prefix: current.prefix,
    publicBaseUrl: current.publicBaseUrl,
    accountId: current.accountId,
    accessKeyId: current.accessKeyId,
    secretAccessKey: current.secretAccessKey,
    jurisdiction: current.jurisdiction,
    lastActiveAt: nowIso,
    verifiedAt: current.storageVerifiedAt,
    storageConfiguredAt: current.storageConfiguredAt,
    storageConfiguredBy: current.storageConfiguredBy,
    storageAccessKeyIdLast4: current.storageAccessKeyIdLast4,
  };
}

/**
 * A lane's connection fields plus the *optional* display/id bookkeeping
 * `promoteLane` cares about. Looser than `StorageLane` (whose `id` is
 * required) so a laneless shared target — built straight from
 * `selfServeWorkspaceRecord(...)`, never saved as a `StorageLane` — can be
 * promoted through the exact same field list as a real saved lane (legacy
 * detach path, `storageDeleteHandler`).
 */
export type PromotableLane = StorageLaneFields &
  Partial<
    Pick<
      StorageLane,
      "id" | "storageConfiguredAt" | "storageConfiguredBy" | "storageAccessKeyIdLast4"
    >
  >;

/**
 * Promotes `lane`'s fields onto `next`'s top level (the active-lane fields).
 * Deletes fields the incoming lane doesn't carry so a switch between a
 * binding-mode and an HTTP-credential-mode lane never leaves the other
 * mode's stale fields behind (e.g. switching shared → BYO must drop
 * `binding`/`prefix`; BYO → shared must drop the credential fields). A
 * `lane.id` of `undefined` (the laneless shared target) clears
 * `next.storageLaneId` instead of setting it — the restored shared lane has
 * no id until a future activate demotes it again.
 */
export function promoteLane(
  next: WorkspaceRecord,
  lane: PromotableLane,
  verifiedAt: string | undefined,
): void {
  next.provider = "r2";
  next.bucket = lane.bucket;
  if (lane.binding) next.binding = lane.binding;
  else delete next.binding;
  if (lane.prefix) next.prefix = lane.prefix;
  else delete next.prefix;
  if (lane.publicBaseUrl) next.publicBaseUrl = lane.publicBaseUrl;
  else delete next.publicBaseUrl;
  if (lane.accountId) next.accountId = lane.accountId;
  else delete next.accountId;
  if (lane.accessKeyId) next.accessKeyId = lane.accessKeyId;
  else delete next.accessKeyId;
  if (lane.secretAccessKey) next.secretAccessKey = lane.secretAccessKey;
  else delete next.secretAccessKey;
  if (lane.jurisdiction) next.jurisdiction = lane.jurisdiction;
  else delete next.jurisdiction;
  if (lane.id) next.storageLaneId = lane.id;
  else delete next.storageLaneId;
  if (lane.storageConfiguredAt) next.storageConfiguredAt = lane.storageConfiguredAt;
  else delete next.storageConfiguredAt;
  if (lane.storageConfiguredBy) next.storageConfiguredBy = lane.storageConfiguredBy;
  else delete next.storageConfiguredBy;
  if (lane.storageAccessKeyIdLast4) next.storageAccessKeyIdLast4 = lane.storageAccessKeyIdLast4;
  else delete next.storageAccessKeyIdLast4;
  if (verifiedAt) next.storageVerifiedAt = verifiedAt;
  else delete next.storageVerifiedAt;
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

/** Milliseconds a lane's `verifiedAt` may age before `activate` re-runs verify against it. */
export const LANE_VERIFY_STALE_MS = 10 * 60 * 1000;

/** True when `verifiedAt` is missing or older than {@link LANE_VERIFY_STALE_MS}. */
export function isLaneVerifyStale(verifiedAt: string | undefined, now = new Date()): boolean {
  if (!verifiedAt) return true;
  const verifiedMs = Date.parse(verifiedAt);
  if (!Number.isFinite(verifiedMs)) return true;
  return now.getTime() - verifiedMs > LANE_VERIFY_STALE_MS;
}
