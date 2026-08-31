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
    // The outgoing active lane's own provider, never hardcoded — an s3
    // active lane demotes into an s3 fallback lane, not an r2 one.
    provider: current.provider,
    bucket: current.bucket,
    binding: current.binding,
    prefix: current.prefix,
    publicBaseUrl: current.publicBaseUrl,
    accountId: current.accountId,
    accessKeyId: current.accessKeyId,
    secretAccessKey: current.secretAccessKey,
    jurisdiction: current.jurisdiction,
    endpoint: current.endpoint,
    region: current.region,
    forcePathStyle: current.forcePathStyle,
    lastActiveAt: nowIso,
    verifiedAt: current.storageVerifiedAt,
    storageConfiguredAt: current.storageConfiguredAt,
    storageConfiguredBy: current.storageConfiguredBy,
    storageAccessKeyIdLast4: current.storageAccessKeyIdLast4,
    // Health travels with the lane (issue #826): switching away from a lane
    // because its credentials broke must not make it look fine in the lane
    // list the moment it stops being active.
    unhealthyAt: current.storageUnhealthyAt,
    unhealthyCode: current.storageUnhealthyCode,
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
  // The incoming lane's own provider, never hardcoded — promoting an s3
  // standby (or reactivating a demoted s3 fallback) must land as an s3
  // active lane, not silently become r2.
  next.provider = lane.provider === "s3" ? "s3" : "r2";
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
  if (lane.endpoint) next.endpoint = lane.endpoint;
  else delete next.endpoint;
  if (lane.region) next.region = lane.region;
  else delete next.region;
  // `!== undefined`, not truthy — `forcePathStyle: false` is a meaningful
  // explicit value (virtual-hosted addressing), not "absent".
  if (lane.forcePathStyle !== undefined) next.forcePathStyle = lane.forcePathStyle;
  else delete next.forcePathStyle;
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
  // A lane only ever becomes active after it has been proven to work — a
  // binding-mode (shared) lane needs no proof, and an HTTP-credential lane is
  // re-verified by `storageActivateHandler` before the swap (which forces a
  // re-verify for a lane carrying a health flag, however fresh its
  // `verifiedAt` looks). So promotion always clears the flag rather than
  // carrying the demoted lane's history onto the live one.
  delete next.storageUnhealthyAt;
  delete next.storageUnhealthyCode;
}

/**
 * Lane identity for dedupe: bucket plus whichever account-scoping field the
 * provider carries — `accountId` for r2, `endpoint` for s3 (an s3 lane never
 * has an `accountId`). Two r2 lanes on the same bucket under different
 * Cloudflare accounts are distinct; two s3 lanes on the same bucket name at
 * different endpoints are distinct too.
 */
export function laneIdentity(lane: Pick<StorageLane, "bucket" | "accountId" | "endpoint">): string {
  return `${lane.bucket} ${lane.accountId || lane.endpoint || ""}`;
}

/**
 * Upsert `lane` into `lanes` keyed by bucket+(accountId ?? endpoint)
 * identity, preserving an existing match's `id` and `lastActiveAt` —
 * re-saving a standby config (credential rotation) refreshes
 * creds/verification without minting a new lane id or silently clearing
 * fallback status.
 */
export function upsertStandbyLane(
  lanes: StorageLane[] | undefined,
  lane: StorageLane,
): StorageLane[] {
  const existing = lanes ?? [];
  const idx = existing.findIndex((l) => laneIdentity(l) === laneIdentity(lane));
  if (idx === -1) return [...existing, lane];
  const prior = existing[idx]!;
  const next = [...existing];
  next[idx] = { ...lane, id: prior.id, lastActiveAt: prior.lastActiveAt };
  return next;
}

/**
 * Upsert a freshly-demoted (just-deactivated) lane into `lanes` keyed by
 * bucket+(accountId ?? endpoint), replacing any stale entry outright — the
 * demoted lane's id (derived from the record's own `storageLaneId`) is
 * always authoritative here, unlike `upsertStandbyLane`'s "preserve the
 * existing id" rule.
 */
export function upsertDemotedLane(
  lanes: StorageLane[] | undefined,
  lane: StorageLane,
): StorageLane[] {
  const existing = (lanes ?? []).filter((l) => laneIdentity(l) !== laneIdentity(lane));
  return [...existing, lane];
}

/**
 * The r2-vs-s3 credential-field split shared by every candidate/lane builder
 * that hand-rolls a `StorageVerifyCandidate`/`StorageLane` shape:
 * `workspace-storage.ts`'s `candidateFromBody` and `laneVerifyCandidate`, and
 * `workspace-settings.ts`'s `storagePutHandler` (new-lane path). An s3
 * candidate/lane carries `endpoint`/`region`/`forcePathStyle`, never
 * `accountId`/`jurisdiction`; an r2 one carries the reverse — never both, so
 * one source of truth for the split keeps the three sites from drifting.
 */
export function providerCredentialFields<J = string>(
  isS3: boolean,
  fields: {
    accountId?: string;
    jurisdiction?: J;
    endpoint?: string;
    region?: string;
    forcePathStyle?: boolean;
  },
):
  | { accountId?: string; jurisdiction?: J }
  | { endpoint?: string; region?: string; forcePathStyle?: boolean } {
  return isS3
    ? { endpoint: fields.endpoint, region: fields.region, forcePathStyle: fields.forcePathStyle }
    : { accountId: fields.accountId, jurisdiction: fields.jurisdiction };
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
