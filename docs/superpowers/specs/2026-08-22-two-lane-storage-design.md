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
- Record shape generalizes to future storage profiles/routing (#630) without redesign.

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
/** Ordered read-only fallback lanes, most recent demotion first. */
fallbackLanes?: StorageLane[];

interface StorageLane {
  id: string;              // short opaque id, e.g. "lane_<8hex>"; stamped into new-upload provenance
  demotedAt: string;       // ISO timestamp of the transition that demoted it
  provider: "r2";
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
- Fallback-lane credentials are sealed/resealed exactly like active-lane credentials
  (`sealCredentialFieldsStrict` on demotion of an HTTP-mode lane; `resealCredentialFields`
  covers rotation sweeps — the reseal walk must include `fallbackLanes`).
- The active lane also gets a persisted `storageLaneId` (top-level field) so provenance
  stamping and future migration tooling can name it. On records that predate this
  design, absence of `storageLaneId` means the implicit original lane.

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

Single-lane workspaces (no `fallbackLanes`) take the exact current code path; the
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

### Attach / detach flow changes

Attach (`PUT /me/workspaces/:name/storage`, handler in `workspace-settings.ts`):

1. Verify pipeline unchanged (shape/auth/round-trip/not-empty + public-URL probe;
   `adoptExistingContents` still bypasses the **bucket**-not-empty check).
2. The `workspace_storage_not_empty` 409 (**workspace** ledger check) is **removed**.
   Instead, when `workspace_usage.objects > 0`, the current active config is demoted
   into `fallbackLanes` before the BYO config is written as active.
   When the ledger is empty, behave exactly as today (overwrite, no fallback lane).
3. Reconcile after attach becomes lane-aware (see Usage below).

Detach (`DELETE /me/workspaces/:name/storage`):

1. #619 fix (ships first, standalone): allow detach whenever the record is currently
   BYO-configured, regardless of `byoBucketEnabled`.
2. Two-lane detach: if the BYO era produced objects (any object resolves only in the
   BYO lane), demote the BYO lane to a fallback instead of dropping it; restore the
   shared config as active. If the shared config is already present in `fallbackLanes`,
   **promote it back** (remove from fallbacks) rather than duplicating it.
3. `force=true` keeps its meaning of "drop without ceremony": it discards the BYO
   config entirely (current behavior) — the escape hatch when the customer bucket is
   gone or credentials are dead.

Lane hygiene: a fallback lane whose objects have all been deleted (reconcile finds
zero keys) is pruned automatically during reconcile. Re-attach while a fallback BYO
lane exists for the _same bucket_ promotes it instead of appending a duplicate.

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

- `workspace_storage_not_empty` stays registered (detach-side and older clients) but
  the attach path stops emitting it. Web client's 409 branch copy updates.
- Settings Storage panel (`storage.astro`): remove `applySharedUsageGate` disable +
  the "only available for an empty workspace" note; replace with transition copy
  ("existing files stay on uploads.sh storage and keep working; new uploads go to
  your bucket"). BYO-details view shows a small "previous storage" line when
  `fallbackLanes` is non-empty. Detach copy gains the symmetric explanation.
- `/docs/byo-bucket` empty-workspace note replaced with the two-lane explanation;
  serving matrix gains a "files uploaded before connecting" row. Sitemap/llms.txt
  untouched (page exists).
- Admin storage panel: show lane list read-only.
- Doctor: the honest storage line reports active lane + fallback count.

### Testing

- Unit: lane resolution order, composite cursor round-trip, merge/dedupe collision
  (active wins), fallback-lane resolve-failure degradation, seal/reseal walk over
  `fallbackLanes`, budget shared-subset math.
- Integration (vitest + in-process fakes, two fake R2 stores): attach-to-populated →
  old key resolves with shared-lane URL, new put lands in BYO store with lane stamp,
  list merges, delete targets owning lane; detach → symmetric; re-attach promotes
  existing lane; reconcile rebuilds shared subset; force-detach drops lane.
- Contract: /f/ page + /public/files for a pre-switch key returns the shared-bucket
  URL after attach (the headline behavior).

## Phases / PR breakdown

1. **PR A — #619 detach gate fix** (standalone, first): allow detach when
   `storageConfiguredAt` is set even if `byoBucketAllowed` is false. Test: flag
   revoked → detach 200.
2. **PR B — lanes primitive, no behavior change**: `StorageLane` type +
   `fallbackLanes`/`storageLaneId` on `WorkspaceRecord`, `storageConfigs`,
   `resolveObjectLane`, seal/reseal coverage, provenance stamp on put. All existing
   tests green; new unit tests. Nothing writes `fallbackLanes` yet.
3. **PR C — lane-aware read paths**: public-files, files-core, shared handlers,
   workspace-files, gallery/poster/comment URL derivation, delete-owning-lane,
   merged listing + composite cursor. Behavior still identical for single-lane
   records (the entire fleet).
4. **PR D — two-lane transitions + usage + UI + docs**: attach demotion, detach
   promotion, lane pruning, `shared_bytes` migration + delta/reconcile/budget wiring,
   settings + admin UI, /docs/byo-bucket, doctor line. Closes the attach constraint;
   update #594 (reduce to physical-migration residue or close in favor of a new
   tracking issue).

Each PR bases on main (no stacking — stacked PRs skip CI in this repo).

## Decisions log

- Read-fallback over per-file lane stamping for resolution (Zach, 2026-08-22):
  stamping adds a D1 sidecar and backfill semantics but cannot replace list fan-out
  (there is no D1 file index), so it buys little until per-file routing exists.
  Provenance stamping of new uploads is kept as the zero-cost forward hook.
- Two-lane only; profiles/routing deferred to #630 (Zach, 2026-08-22).
- #619 first as its own PR; #597 billing not bundled (Zach, 2026-08-22).
