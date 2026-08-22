# Two-lane workspace storage (layered read-fallback lanes)

**Date:** 2026-08-22
**Tracking:** supersedes the migration framing of #594; unblocks BYO attach for populated workspaces (#583 follow-up). #619 ships first as a standalone fix.
**Prior art:** `docs/superpowers/plans/2026-07-31-self-serve-byo-r2-bucket.md` (the v1 BYO ship this extends).

## Problem

BYO storage (#583) only attaches at workspace creation or to an empty workspace. The
constraint exists because storage is single-valued: `WorkspaceRecord` holds exactly one
bucket config, public URLs are derived at read time from that one config, and no D1
table records where a file physically lives. Switching the config would make the
platform re-derive every pre-switch file's URL and existence check against the new
bucket — 404s across file pages, lists, and downloads.

Published links themselves never break: `storage.uploads.sh` is an R2 custom domain on
the shared bucket and keeps serving copied-out URLs regardless. Only the platform's
derivation side needs fixing.

## Goals

- Attach BYO storage to a **populated** workspace with zero migration: old files keep
  resolving from the shared bucket, new uploads land in the customer bucket.
- Detach symmetrically: files uploaded during the BYO era keep resolving after a
  return to shared storage.
- Record shape generalizes to future storage profiles/routing (#630) without redesign:
  N saved lanes, per-project routing, and non-R2 providers must be reachable later by
  adding behavior, never by migrating the record or the API shape.

## Non-goals (deferred)

- Storage profiles UI, per-upload routing rules, >1 fallback lane exposed in product
  surfaces (#630).
- Physical migration / copy jobs between lanes (the residual scope of #594).
- Other S3 providers (#595), embed twin for BYO domains (#592), billing gating (#597).
- Constant hot-swapping. Attach/detach remain deliberate, verified transitions; the
  lanes list stays short (in practice 2: active + one fallback per direction).

## Design

### Record shape: active config + fallback lanes

The existing top-level storage fields on `WorkspaceRecord` (`provider`, `bucket`,
`binding`, `prefix`, `publicBaseUrl`, `accountId`, `accessKeyId`, `secretAccessKey`,
`jurisdiction`) remain **the active write lane** — every current consumer of
`storageConfig(env, ws)` keeps working unchanged.

New field:

```ts
/** All configured inactive lanes: saved-but-never-used configs and demoted former actives. */
storageLanes?: StorageLane[];

interface StorageLane {
  id: string;              // short opaque id, e.g. "lane_<8hex>"; stamped into new-upload provenance
  verifiedAt?: string;     // last successful verify run against this lane's config
  lastActiveAt?: string;   // set when the lane is demoted from active; absence = never held writes
  provider: string;        // "r2" is the only value accepted today; widened now so future
                           // files-sdk-supported providers need no record-shape migration
  bucket: string;
  binding?: string;        // shared lane uses the binding; BYO lanes are HTTP-credential mode
  prefix?: string;
  publicBaseUrl?: string;
  accountId?: string;
  accessKeyId?: string;    // sealed (enc:v1:), same KEK ring as active-lane creds
  secretAccessKey?: string; // sealed
  jurisdiction?: string;
}
```

- All writes go through `mutateWorkspaceRecord` (versioned KV writes — never bare
  `REGISTRY.put`).
- Lane credentials are sealed/resealed exactly like active-lane credentials
  (`sealCredentialFieldsStrict` when an HTTP-mode lane config is saved;
  `resealCredentialFields` covers rotation sweeps — the reseal walk must include
  `storageLanes`).
- Lane states, derived rather than stored as an enum: **standby** = configured and
  verified, `lastActiveAt` absent — a saved config that has never received writes;
  **fallback** = `lastActiveAt` set — a former active lane that may hold objects.
  Only fallback lanes participate in read resolution; standby lanes are pure
  configuration and cost nothing at read time.
- The active lane also gets a persisted `storageLaneId` (top-level field) so provenance
  stamping and future migration tooling can name it. On records that predate this
  design, absence of `storageLaneId` means the implicit original lane.

### N-lane readiness (cheap now, deliberately unexploited)

`storageLanes` is an array and every lane operation addresses a `laneId` — nothing in
the API shape assumes "the one BYO config". v1 product surfaces cap the experience at
one saved BYO config + the shared lane, but that cap lives in UI/validation, not in
the record, the endpoints, the cursor format, or the resolver. Adding a third saved
lane, or later a per-project routing rule that picks a write lane, is additive.
What we explicitly do NOT build now: routing rules, multi-config UI, per-lane budget
UI beyond the shared subset.

### files-sdk is the storage layer — no bespoke clients

Every lane resolves through `packages/storage`'s `createStorage`, which is a thin
wrapper over **files-sdk** (`Files` + the `r2` adapter; the config comment already
reads "provider selects the files-sdk adapter"). Lane-aware code composes N
`Storage` instances from that wrapper — it never talks S3/R2 directly. Future non-R2
providers are "whatever files-sdk supports" plus a `provider` value and a verify-
pipeline variant; the lane machinery itself stays provider-agnostic.

### Resolution: `storageConfigs(env, ws)`

New resolver beside `storageConfig`:

```ts
storageConfigs(env, ws): StorageConfig[]  // [active, ...fallbacks], each tagged with laneId
```

Same 503 semantics per lane (`storage_misconfigured`, `storage_credentials_unreadable`)
— but a _fallback_ lane that fails to resolve degrades to a logged skip rather than a
request-fatal 503, so a stale fallback can never take down the active lane. (Active
lane failures stay fatal, as today.)

### Read path: lane-aware object resolution

New helper in `apps/api` (thin layer over `packages/storage`):

```ts
resolveObjectLane(env, ws, key): Promise<{ store, config, laneId } | null>
```

Tries lanes in order: `exists(key)` on active, then each fallback. First hit wins.
Worst case for a pre-switch file: one extra R2 HEAD (bounded by lane count, which is
1–2 extra in practice).

Call sites that change from "current store only" to lane-aware:

- `resolvePublicObject` in `apps/api/src/routes/public-files.ts` — the /f/ page and
  `/public/files/*` JSON + download. Public URL must be derived from **the lane the
  object was found in**, not the active lane.
- `files-core` head/download/exists paths and the shared handlers in
  `routes/files-shared-handlers.ts`.
- `workspace-files.ts` single-file URL resolution (public URL else signed URL — the
  signed URL must sign against the owning lane's credentials/binding).
- URL derivation in `gallery-service.ts`, `poster.ts`, `github-comment.ts`: these
  derive URLs for known keys; they route through the same lane-aware URL helper.
- Deletion: delete must target the owning lane (delete from the lane that has the
  object; if the key exists in multiple lanes — possible after detach/re-attach —
  delete from all lanes that hold it, so the file actually disappears).
- Metadata writes (`file_metadata`, `file_content_hash`) are keyed on
  `(workspace, object_key)` and are lane-agnostic — unchanged.

Single-lane workspaces (no fallback lanes) take the exact current code path; the
helper short-circuits. **No behavior change until a second lane exists.**

### Listing: merged fan-out

List endpoints fan out the same prefix query across lanes and merge by key; the
**active lane wins on key collision** (a re-uploaded filename shadows the old lane's
copy, matching write-lane reality).

Pagination uses a composite cursor: base64url JSON of per-lane cursors
(`{ v: 1, lanes: { [laneId]: cursor } }`). Merge is a k-way merge on key order per
page. `listAll` (reconcile, teardown) concatenates lane walks with the same
active-wins dedupe.

Thumbnails: `thumb-url.ts` wraps by host; shared-lane files keep getting cdn-cgi
thumbs, BYO-lane files keep the existing BYO behavior (no thumbs) — per-file now
instead of per-workspace.

### Configure, then switch (decoupled activation)

Saving a BYO configuration and routing uploads to it are **two separate actions**
(Zach, 2026-08-22). Verification sits between them, and switching is explicit,
re-verified, and instantly reversible. Nothing changes about where uploads go until
the user says so.

**Save** (`PUT /me/workspaces/:name/storage`):

1. Verify pipeline unchanged (shape/auth/round-trip/not-empty + public-URL probe;
   `adoptExistingContents` still bypasses the **bucket**-not-empty check).
2. On success the config is written as a **standby lane** in `storageLanes` with
   `verifiedAt` — the active lane is untouched. The `workspace_storage_not_empty`
   409 disappears from this path entirely (saving a config is always safe).
3. Saving again replaces the standby lane for that bucket (credential rotation is a
   re-save). Re-verify on demand stamps a fresh `verifiedAt`.

**Switch** (`POST /me/workspaces/:name/storage/activate`, body `{ laneId }`):

1. Re-run verify against the target lane if it's HTTP-credential mode and
   `verifiedAt` is stale (older than a short window) — a switch never lands on a
   config that has silently rotted.
2. Swap: the target lane's config becomes the top-level active fields; the outgoing
   active config is written into `storageLanes` with `lastActiveAt` stamped (it may
   hold objects, so it becomes a read fallback). If the workspace ledger is empty at
   switch time, the outgoing lane is stored without read-fallback weight (nothing to
   resolve) but the config is kept.
3. Switching back is the same call with the other lane's `laneId` — the shared lane
   is always present as a lane entry once any switch has happened. No separate
   detach semantics needed for the common case.

**Remove** (`DELETE /me/workspaces/:name/storage`, now takes a `laneId` for saved
configs):

1. #619 fix (ships first, standalone): allow removal/switch-back whenever the record
   is currently BYO-configured, regardless of `byoBucketEnabled`.
2. Removing a standby lane (never active) is always allowed — it's just saved config.
3. Removing a fallback lane that still holds objects gets the
   `workspace_storage_not_empty` 409 (the code moves here, where it's genuinely
   protective), bypassed by `force=true` — the "my bucket is gone" escape hatch,
   which orphans that lane's objects knowingly.
4. Removing the _active_ BYO lane = switch back to shared first (or `force`).

Lane hygiene: a fallback lane whose objects have all been deleted (reconcile finds
zero keys) drops its read-fallback role automatically; a BYO lane the user removed
is gone entirely. Re-saving a config for the _same bucket_ as an existing lane
updates that lane in place rather than appending a duplicate.

### Usage / budget attribution

`workspace_usage` gains two columns: `shared_bytes INTEGER NOT NULL DEFAULT 0`,
`shared_objects INTEGER NOT NULL DEFAULT 0` — the subset of totals living in
shared-bucket lanes (binding-mode lanes).

- `applyUsageDelta` learns which lane a mutation touched (put → active lane; delete →
  owning lane) and updates the shared subset when that lane is binding-mode.
- `reconcileWorkspaceUsage` walks all lanes and rebuilds both totals and the shared
  subset.
- Budget enforcement: `enforcedMaxStorageBytes` compares against `shared_bytes` when
  the workspace's **active** lane is BYO (`storageBudgetApplies` false today becomes
  "applies to the shared residue"), and against total bytes when the active lane is
  shared. Net effect: customers can't park unlimited data on our bucket by attaching
  BYO, and BYO bytes stay unmetered — same policy as v1, now correct across lanes.
- Upload rate limits and size caps: unchanged, lane-independent.

### Provenance stamping (cheap forward hook)

New uploads write `storageLaneId` into the existing R2 provenance bag
(customMetadata) at put time. Zero D1 schema, no read-path dependency — resolution
stays fallback-based. The stamp exists for debugging and as the seed for any future
per-file routing or physical migration tooling (#630/#594 residue). Absence of a
stamp = uploaded before this design.

### Errors, UI, docs

- `workspace_storage_not_empty` stays registered but moves from the save path to
  lane removal. Web client's 409 branch copy updates.
- Settings Storage panel (`storage.astro`): remove `applySharedUsageGate` disable +
  the "only available for an empty workspace" note. The wizard ends at **"Save &
  verify"** — saving never changes where uploads go. The saved config renders as a
  card with verify status and a **"Use this bucket"** action; once switched, the
  panel shows which lane is active with a **"Switch back to uploads.sh storage"**
  action. Transition copy on switch: "existing files stay where they are and keep
  working; new uploads go to <target>."
- `/docs/byo-bucket` empty-workspace note replaced with the two-lane explanation;
  serving matrix gains a "files uploaded before connecting" row. Sitemap/llms.txt
  untouched (page exists).
- Admin storage panel: show lane list read-only.
- Doctor: the honest storage line reports active lane + fallback count.

### Testing

- Unit: lane resolution order (standby lanes skipped), composite cursor round-trip,
  merge/dedupe collision (active wins), fallback-lane resolve-failure degradation,
  seal/reseal walk over `storageLanes`, budget shared-subset math, stale-verify
  re-check before activate.
- Integration (vitest + in-process fakes, two fake R2 stores): save config on a
  populated workspace → uploads still land in shared store; activate → old key
  resolves with shared-lane URL, new put lands in BYO store with lane stamp, list
  merges, delete targets owning lane; switch back → symmetric; re-activate reuses
  the existing lane; reconcile rebuilds shared subset; force-remove drops the lane;
  remove-with-objects 409s without force.
- Contract: /f/ page + /public/files for a pre-switch key returns the shared-bucket
  URL after the switch (the headline behavior).

## Phases / PR breakdown

1. **PR A — #619 detach gate fix** (standalone, first): allow detach when
   `storageConfiguredAt` is set even if `byoBucketAllowed` is false. Test: flag
   revoked → detach 200.
2. **PR B — lanes primitive, no behavior change**: `StorageLane` type +
   `storageLanes`/`storageLaneId` on `WorkspaceRecord`, `storageConfigs`,
   `resolveObjectLane`, seal/reseal coverage, provenance stamp on put. All existing
   tests green; new unit tests. Nothing writes `storageLanes` yet.
3. **PR C — lane-aware read paths**: public-files, files-core, shared handlers,
   workspace-files, gallery/poster/comment URL derivation, delete-owning-lane,
   merged listing + composite cursor. Behavior still identical for single-lane
   records (the entire fleet).
4. **PR D — save/activate/remove transitions + usage + UI + docs**: standby save
   path, activate endpoint with stale-verify re-check, removal guards, lane pruning,
   `shared_bytes` migration + delta/reconcile/budget wiring, settings + admin UI,
   /docs/byo-bucket, doctor line. Closes the attach constraint; update #594 (reduce
   to physical-migration residue or close in favor of a new tracking issue).

Each PR bases on main (no stacking — stacked PRs skip CI in this repo).

## Decisions log

- Read-fallback over per-file lane stamping for resolution (Zach, 2026-08-22):
  stamping adds a D1 sidecar and backfill semantics but cannot replace list fan-out
  (there is no D1 file index), so it buys little until per-file routing exists.
  Provenance stamping of new uploads is kept as the zero-cost forward hook.
- Two-lane only; profiles/routing deferred to #630 (Zach, 2026-08-22).
- #619 first as its own PR; #597 billing not bundled (Zach, 2026-08-22).
- Configuration decoupled from activation (Zach, 2026-08-22): saving a BYO config
  never changes routing; an explicit, re-verified switch does, and switching back is
  the same primitive pointed at the other lane. Chosen for safety (a bad config
  can't break uploads by merely being saved) at negligible added complexity — the
  read/list/budget design is unchanged.
- Keep N-lane / multi-provider options open where free (Zach, 2026-08-22): lanes are
  an id-addressed array, `provider` is a widened string validated to "r2" today, and
  all storage IO goes through the files-sdk-backed `packages/storage` wrapper. The
  one-saved-config limit is UI/validation only. Per-project routing and non-R2
  providers stay future work (#630, #595) but require no schema or API migration.
