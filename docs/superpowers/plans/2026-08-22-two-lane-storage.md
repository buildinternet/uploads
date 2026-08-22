# Two-Lane Workspace Storage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a populated workspace save, verify, and explicitly switch to a BYO R2 bucket — old files keep resolving from their original lane, new uploads go to the active lane, and switching back is the same primitive in reverse.

**Architecture:** `WorkspaceRecord` keeps its top-level storage fields as the active write lane and gains `storageLanes: StorageLane[]` for inactive lanes (standby = saved config, fallback = former active that may hold objects). Reads resolve through an ordered lane walk; lists fan out and merge; a new activate endpoint swaps lanes. All storage IO stays inside the files-sdk-backed `packages/storage` wrapper.

**Tech Stack:** Cloudflare Workers (Hono), KV workspace records via `mutateWorkspaceRecord`, D1 usage ledger, files-sdk 2.2.4 via `@uploads/storage`, vitest with in-process fakes.

**Spec:** `docs/superpowers/specs/2026-08-22-two-lane-storage-design.md` — read it first; every task argues from it.

## Global Constraints

- Four separate PRs, **each based on `main`** — stacked PRs skip Test/Lint CI in this repo. PR order: A (#619 fix) → B (primitive) → C (read paths) → D (transitions/UI). B, C, D each start from main after the previous merges.
- All KV workspace-record mutations go through `mutateWorkspaceRecord` (apps/api/src/workspace.ts) — never bare `REGISTRY.put`.
- All storage IO goes through `createStorage` / helpers in `packages/storage` (files-sdk). Never construct S3/R2 clients directly.
- Credentials seal with `sealCredentialFieldsStrict` (self-serve writes) and open with `openCredentialFields` (apps/api/src/secrets.ts). Plaintext credential fields must never be written to KV.
- `StorageLane.provider` is a `string` validated to `"r2"` at the boundary (spec: N-lane readiness). `packages/storage`'s `StorageProvider` union stays `"r2"`.
- PRs B and C must be **zero behavior change** for every record with no `storageLanes` (the entire fleet at merge time). Existing tests must pass unmodified.
- Tests: plain vitest with in-process fakes (`pnpm test` at root, or `pnpm --filter @uploads/api test`). Follow existing patterns in `apps/api/test/`. TypeScript check: `pnpm --filter @uploads/api exec tsc --noEmit` (repo `pnpm types` generates wrangler types, it is NOT a typecheck).
- Formatting: `.ts` via oxfmt (lint-staged handles it on commit); do not run prettier on TS files.
- Commit messages: conventional (`fix:`, `feat:`, `docs:`), no "comprehensive"/"world-class" superlatives.

---

## PR A — #619: detach must survive flag revocation

Branch: `claude/619-detach-after-flag-revoke`. One task. Ships first, independent of everything below.

### Task A1: allow storage detach when the record is already BYO

**Files:**

- Modify: `apps/api/src/routes/workspace-settings.ts:527-531` (`storageDeleteHandler` flag gate)
- Test: `apps/api/test/` — find the existing storage-route test file (`grep -rl "workspace_storage_not_empty\|storageDeleteHandler\|byo_bucket_disabled" apps/api/test/`) and add cases there.

**Interfaces:**

- Consumes: `byoBucketAllowed(record)` (apps/api/src/workspace.ts:200), `record.storageConfiguredAt` (set by every successful PUT, cleared on detach).
- Produces: no new exports; behavior change only.

- [ ] **Step 1: Write the failing test.** In the existing storage-route test file, add: seed a workspace record that is BYO-configured (`accountId`, sealed `accessKeyId`/`secretAccessKey`, `storageConfiguredAt` set, no `binding`) with `byoBucketEnabled: false` (or the flag field absent so `byoBucketAllowed` is false — match how neighboring tests build allowed records and invert it). Call `DELETE` on the storage route the way the file's existing detach tests do. Assert status 200 and response `mode: "shared"`. Add a companion test: same flag-off record but **shared-mode** (no BYO fields) still gets 403 `byo_bucket_disabled` on DELETE, so the gate isn't just deleted.
- [ ] **Step 2: Run to verify it fails.** `pnpm --filter @uploads/api test -- <testfile>` — expect the new test to fail with 403 `byo_bucket_disabled`.
- [ ] **Step 3: Implement.** In `storageDeleteHandler`, replace the gate with:

```ts
// Detach must stay available after the flag is revoked, otherwise the
// workspace is stranded on the customer bucket (#619).
if (!byoBucketAllowed(record) && !record.storageConfiguredAt) {
  throw new ForbiddenError("BYO storage is not enabled for this workspace", {
    code: "byo_bucket_disabled",
  });
}
```

- [ ] **Step 4: Run the full api test suite + typecheck.** `pnpm --filter @uploads/api test` and `pnpm --filter @uploads/api exec tsc --noEmit` — all green.
- [ ] **Step 5: Commit + PR.** `fix(api): allow BYO storage detach after byoBucketEnabled is revoked (#619)`. PR body links #619 and quotes the stranding scenario. This is auth-adjacent but tiny and pre-reviewed by CodeRabbit on #617 — do not request a CodeRabbit review.

---

## PR B — lanes primitive (zero behavior change)

Branch: `claude/two-lane-storage-primitive`.

### Task B1: `StorageLane` type + record fields + seal/reseal coverage

**Files:**

- Modify: `apps/api/src/workspace.ts` (WorkspaceRecord fields, near the existing storage fields at :36-53)
- Modify: `apps/api/src/secrets.ts` (reseal walk) — read `resealCredentialFields` (:201) first; also check `scripts/reencrypt-workspace-secrets.mjs` and `apps/api/src/reencrypt-registry.ts` for the sweep that must now include lanes.
- Test: `apps/api/test/secrets.test.ts` (or wherever `resealCredentialFields` is tested — `grep -rl resealCredentialFields apps/api/test/`)

**Interfaces:**

- Produces:

```ts
// workspace.ts
export interface StorageLane {
  id: string; // "lane_" + 8 lowercase hex chars
  verifiedAt?: string; // ISO — last successful verify against this config
  lastActiveAt?: string; // ISO — set at demotion; absence = never held writes (standby)
  provider: string; // validated to "r2" at every boundary today
  bucket: string;
  binding?: string;
  prefix?: string;
  publicBaseUrl?: string;
  accountId?: string;
  accessKeyId?: string; // sealed enc:v1:
  secretAccessKey?: string; // sealed enc:v1:
  jurisdiction?: string;
  // Display/provenance mirrors of the top-level fields:
  storageAccessKeyIdLast4?: string;
  storageConfiguredAt?: string;
  storageConfiguredBy?: string;
}
export function newLaneId(): string; // "lane_" + crypto.getRandomValues-derived 8 hex
// WorkspaceRecord gains:
//   storageLanes?: StorageLane[];
//   storageLaneId?: string;   // id of the active lane; absent = pre-lanes record
```

- [ ] **Step 1: Failing test for reseal.** Build a record with one HTTP-mode lane in `storageLanes` whose `accessKeyId`/`secretAccessKey` are sealed under an old key; run the reseal path the existing tests use; assert the lane's fields decrypt under the new key afterward.
- [ ] **Step 2: Run to verify fail.**
- [ ] **Step 3: Implement.** Add the interface + fields + `newLaneId()` to `workspace.ts`. Extend the reseal walk(s) so any `storageLanes[i].accessKeyId/secretAccessKey` are re-sealed alongside the top-level pair. Search for every place that reseals or strips credentials (`grep -rn "accessKeyId" apps/api/src --include=*.ts -l`) and audit each for lane coverage — in particular any admin/status projection that must NOT leak lane credentials (mirror the masking posture of `storageStatusResponse`).
- [ ] **Step 4: Suite + typecheck green.**
- [ ] **Step 5: Commit** `feat(api): StorageLane record shape with sealed-credential reseal coverage`.

### Task B2: `storageConfigs` resolver + `resolveObjectLane`

**Files:**

- Modify: `apps/api/src/storage.ts` (beside `storageConfig`)
- Test: `apps/api/test/` new file `storage-lanes.test.ts`

**Interfaces:**

- Consumes: `storageConfig(env, ws)` (storage.ts:27), `createStorage`, `openCredentialFields`.
- Produces:

```ts
// storage.ts
export interface LaneConfig {
  laneId: string | null; // null = pre-lanes implicit active lane
  role: "active" | "fallback";
  config: StorageConfig;
}
/** Active lane first, then fallback lanes (lastActiveAt set) in array order.
 *  Standby lanes (no lastActiveAt) are excluded. A fallback lane that fails
 *  to resolve (bad binding name, undecryptable creds) is logged and skipped —
 *  never throws; active-lane failures still throw exactly as storageConfig does. */
export async function storageConfigs(env: Env, ws: WorkspaceRecord): Promise<LaneConfig[]>;

export interface ResolvedLane {
  store: Files;
  config: StorageConfig;
  laneId: string | null;
  role: "active" | "fallback";
}
/** Walk lanes in order, first store.exists(key) hit wins. Null = nowhere.
 *  Single-lane records short-circuit to the current behavior (one exists call). */
export async function resolveObjectLane(
  env: Env,
  ws: WorkspaceRecord,
  key: string,
): Promise<ResolvedLane | null>;
```

- [ ] **Step 1: Failing tests.** Use the repo's existing fake-R2 pattern (`grep -rn "FakeR2Bucket" apps/api/test | head` — reuse it). Cases: (a) record with no lanes → `storageConfigs` returns one entry, role active, laneId null; (b) record with one fallback lane bound to a second FakeR2Bucket → two entries in order; (c) standby lane (no `lastActiveAt`) excluded; (d) `resolveObjectLane` finds a key present only in the fallback bucket and returns that lane's config; returns active lane when present in both; null when in neither; (e) fallback lane naming a nonexistent binding is skipped without throwing while active still resolves.
- [ ] **Step 2: Run to verify fail.**
- [ ] **Step 3: Implement.** Extract the body of `storageConfig` into a helper that takes the storage-field bag (top-level record or a `StorageLane`) so both paths share binding lookup + credential opening; `storageConfig` keeps its exact signature and error behavior. `storageConfigs` maps lanes through it with try/catch → `console.error` + skip for fallbacks. Validate `lane.provider === "r2"` before use; skip+log otherwise.
- [ ] **Step 4: Suite + typecheck green** (existing storage tests untouched).
- [ ] **Step 5: Commit** `feat(api): lane-aware storage resolution (storageConfigs, resolveObjectLane)`.

### Task B3: provenance lane stamp on upload

**Files:**

- Modify: `apps/api/src/files-core.ts` `putObject` (:318) — find where the R2 customMetadata/provenance bag is assembled (search `metadata` within putObject) and add the stamp.
- Test: extend the existing putObject test file (`grep -rln "putObject" apps/api/test | head -3`).

**Interfaces:**

- Consumes: `ws.storageLaneId` from Task B1.
- Produces: provenance key `"storage-lane"` in object customMetadata; value = `ws.storageLaneId ?? "lane_origin"`.

- [ ] **Step 1: Failing test.** Upload via `putObject` against a record with `storageLaneId: "lane_ab12cd34"`; head the object through the fake store; assert `metadata["storage-lane"] === "lane_ab12cd34"`. Second case: record without `storageLaneId` stamps `"lane_origin"`.
- [ ] **Step 2: Verify fail.**
- [ ] **Step 3: Implement** (one line in the provenance bag; follow the naming style of the neighboring provenance keys — check whether they're kebab or dotted and match).
- [ ] **Step 4: Suite + typecheck green.**
- [ ] **Step 5: Commit** `feat(api): stamp storage lane id into upload provenance`. Open PR B: `feat(api): storage-lane primitive (no behavior change)` — body states the zero-behavior-change contract and cites the spec path.

---

## PR C — lane-aware read paths (still zero behavior change for single-lane records)

Branch: `claude/two-lane-read-paths`. Every task's tests build a two-lane record (active BYO-style FakeR2 + fallback shared-style FakeR2) plus a single-lane control record.

### Task C1: public files resolve across lanes

**Files:**

- Modify: `apps/api/src/routes/public-files.ts` `resolvePublicObject` (:94-122)
- Test: the existing public-files test file.

**Interfaces:**

- Consumes: `resolveObjectLane` (B2).
- Produces: `ResolvedPublicObject` unchanged in shape — but `store`/`cfg`/`urls` now come from the owning lane.

- [ ] **Step 1: Failing test.** Two-lane record; key exists only in fallback store with fallback `publicBaseUrl: "https://storage.uploads.sh"`; GET the public file JSON; assert 200 and `url` starts with the fallback base, not the active one. Control: single-lane behavior byte-identical to today (reuse an existing test unchanged).
- [ ] **Step 2: Verify fail.**
- [ ] **Step 3: Implement.** Replace the storageConfig/exists/head block with `resolveObjectLane`; derive `urls` via `objectPublicUrls(env, lane.config, key)`. Keep the "no public URL ⇒ 404" gate per-lane: a lane hit whose config lacks `publicBaseUrl` still 404s exactly as today. `?download=1` streams from the owning lane's store automatically (same `store`).
- [ ] **Step 4: Suite + typecheck green.**
- [ ] **Step 5: Commit** `feat(api): public file pages resolve objects across storage lanes`.

### Task C2: authenticated head/download/URL paths

**Files:**

- Modify: `apps/api/src/files-core.ts` — `downloadResponse` callers, `headObjectJson` (:741) call sites; `apps/api/src/routes/files-shared-handlers.ts` (:103,116,160,228); `apps/api/src/routes/workspace-files.ts` (:274-291 signed-URL fallback).
- Test: existing files-route test files for head/download.

**Interfaces:**

- Consumes: `resolveObjectLane`, `signedDownloadUrl` (packages/storage).
- Produces: no signature changes; handlers accept a `ResolvedLane` where they previously built `store`+`cfg` themselves.

- [ ] **Step 1: Failing tests.** (a) HEAD on a fallback-only key returns 200 with the fallback lane's URL fields; (b) authenticated download streams fallback bytes; (c) `workspace-files` single-file URL resolution: fallback-only key on a lane with `publicBaseUrl` → that public URL; fallback lane _without_ `publicBaseUrl` but with HTTP creds → signed URL minted from the **fallback** lane's store (assert host/params differ from active).
- [ ] **Step 2: Verify fail.**
- [ ] **Step 3: Implement.** Thread lane resolution through the shared handlers. Where a handler previously did `storage(env, ws)` + `exists`, call `resolveObjectLane` once and pass the resolved store/config down.
- [ ] **Step 4: Suite + typecheck green.**
- [ ] **Step 5: Commit** `feat(api): lane-aware head, download, and file URL resolution`.

### Task C3: deletion targets every owning lane

**Files:**

- Modify: `apps/api/src/files-core.ts` `deleteObject` (:848)
- Test: existing delete tests.

**Interfaces:**

- Consumes: `storageConfigs` (B2).
- Produces: `deleteObject` deletes the key from **every** lane whose store has it (active + fallbacks); returns as deleted if any lane had it. Usage delta counts the object once (bytes from the first lane hit, matching what list/reads report).

- [ ] **Step 1: Failing test.** Key present in both active and fallback stores → delete → gone from both; key present only in fallback → delete succeeds (no 404) and fallback store is empty.
- [ ] **Step 2: Verify fail.**
- [ ] **Step 3: Implement.** Iterate `storageConfigs`, `exists` → `delete` per lane. Preserve the existing delete-usage-claim flow (`claimDeleteUsageSafe`) unchanged.
- [ ] **Step 4: Suite + typecheck green.**
- [ ] **Step 5: Commit** `feat(api): delete removes an object from every storage lane that holds it`.

### Task C4: merged listing with composite cursor

**Files:**

- Modify: `apps/api/src/files-core.ts` `listObjects` (:800-846)
- Create: `apps/api/src/lane-list.ts` (merge + cursor codec, pure functions)
- Test: new `apps/api/test/lane-list.test.ts` + extend list-route tests.

**Interfaces:**

- Produces:

```ts
// lane-list.ts
export interface LaneCursorMap {
  v: 1;
  lanes: Record<string, string>;
} // laneId ("active" for null) → provider cursor
export function encodeLaneCursor(map: LaneCursorMap): string; // base64url(JSON)
export function decodeLaneCursor(raw: string | undefined): LaneCursorMap | null; // null on garbage
/** k-way merge by key asc; on duplicate key keep the entry from the earliest lane in `order`. */
export function mergeLaneListings<T extends { key: string }>(
  pages: Array<{ laneOrder: number; items: T[] }>,
): T[];
```

- `listObjects` behavior: single-lane record → exactly today's path and today's opaque provider cursor (no envelope — **backward compatible with in-flight cursors**). Multi-lane record → fan out the same prefix/limit to each lane, merge, trim to limit, emit composite cursor; accept either cursor form (composite detected by successful decode with `v: 1`).
- [ ] **Step 1: Failing unit tests** for the codec (round-trip, garbage → null) and merge (interleave, duplicate key keeps lower laneOrder, stable within lane).
- [ ] **Step 2: Verify fail; implement lane-list.ts; unit tests green.**
- [ ] **Step 3: Failing integration test.** Two-lane record, 3 keys in active + 3 in fallback with interleaved names + 1 duplicated key, page size 4: first page = first 4 merged keys with the duplicate appearing once (active copy — compare a distinguishing metadata field); second page via returned cursor = remaining keys; single-lane control returns today's shape.
- [ ] **Step 4: Implement in `listObjects`; suite + typecheck green.** Also audit `reconcile.ts` `listAll` walk (:38+) — it must walk **only the active lane** until PR D makes it lane-aware (leave a `// PR D:` marker comment referencing the plan).
- [ ] **Step 5: Commit** `feat(api): merged multi-lane listing with composite cursors`. Open PR C: `feat(api): lane-aware read paths` — body restates single-lane-unchanged contract. Galleries/posters/github-comment URL derivation (spec §read path) work on keys they just uploaded or already-resolved URLs — audit each call site listed in the spec (gallery-service.ts:313,423; poster.ts:77; github-comment.ts:191), convert any that resolves _pre-existing_ keys to `resolveObjectLane`, and note per-site in the PR body whether it changed or why not. **Request a CodeRabbit review on PR C** (`coderabbit:review` label) — it touches the serving path.

---

## PR D — save/activate/remove transitions, usage attribution, UI, docs

Branch: `claude/two-lane-transitions`.

### Task D1: shared-lane usage subset (D1 migration + ledger)

**Files:**

- Create: `apps/api/migrations/<timestamp>_workspace_usage_shared_subset.sql`
- Modify: `apps/api/src/usage.ts` (`WorkspaceUsage`, `getWorkspaceUsage` :71, `applyUsageDelta` :93, `recordUsageSafe` :332, reservation helpers only if they write totals), `apps/api/src/reconcile.ts` (walk all lanes, rebuild both totals and shared subset), `apps/api/src/budget.ts` (`enforcedMaxStorageBytes` :65).
- Test: usage/budget/reconcile test files.

**Interfaces:**

- Migration:

```sql
ALTER TABLE workspace_usage ADD COLUMN shared_bytes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE workspace_usage ADD COLUMN shared_objects INTEGER NOT NULL DEFAULT 0;
```

- `WorkspaceUsage` gains `sharedBytes: number; sharedObjects: number`.
- `applyUsageDelta(db, workspace, delta, opts?: { sharedLane?: boolean })` — when `sharedLane` (the mutated lane is binding-mode), the delta also applies to the shared subset. Callers: putObject passes `sharedLane: !!ws.binding` (active lane); deleteObject passes the owning lane's binding-mode per lane hit.
- Budget: active lane BYO (`!storageBudgetApplies(record)`) → enforce `maxStorageBytes` against `sharedBytes`; active lane shared → against `bytes` (today's behavior). Implement as a new `enforcedStorageUsageBytes(record, usage): number` in budget.ts used by `checkPutBudget`/`storageBudgetDenial` call sites.
- Backfill: existing rows get `shared_bytes = bytes`, `shared_objects = objects` **only for shared-mode workspaces**; BYO workspaces get 0s. This can't be expressed in the SQL migration (mode lives in KV) — reconcile is the backfill: extend `reconcileWorkspaceUsage` to write the subset, and note in the PR body that BYO workspaces (a handful) need a one-time reconcile; defaults of 0 are safe in the meantime because today's BYO enforcement is "none".
- [ ] **Step 1: Failing tests** for delta bookkeeping (shared vs non-shared deltas), reconcile rebuilding both numbers across two fake lanes, and budget: BYO-active record with `sharedBytes` over `maxStorageBytes` denies a put; same record with big `bytes` but small `sharedBytes` allows.
- [ ] **Step 2: Verify fail. Step 3: Implement. Step 4: Suite + typecheck green.** (Migrations auto-apply to prod on merge to main — no manual step.)
- [ ] **Step 5: Commit** `feat(api): shared-lane usage subset with lane-aware budget enforcement`.

### Task D2: save-as-standby (PUT), activate endpoint, lane-aware remove (DELETE)

**Files:**

- Modify: `apps/api/src/routes/workspace-settings.ts` (`storagePutHandler` :421, `storageDeleteHandler` :522, mount block :789-792 gains the activate route), `apps/api/src/routes/workspace-storage.ts` (`storageStatusResponse` gains lanes projection), `apps/api/src/routes/me.ts` (:446-457 forwards the new route).
- Test: the storage-route test file (same one as PR A).

**Interfaces:**

- `PUT /:workspace/storage` — verify (unchanged pipeline via `storageVerify`), then write a **standby lane**: seal creds, build a `StorageLane` with `id: newLaneId()`, `verifiedAt: nowIso`, `storageConfiguredBy: userId`, no `lastActiveAt`. Upsert by bucket+accountId (replace an existing standby/fallback lane for the same bucket in place, preserving its `id` and `lastActiveAt`). **Top-level fields untouched. The `workspace_storage_not_empty` 409 and the `getWorkspaceUsage` pre-check are deleted from this handler.** Response: `{ ...storageStatusResponse(updated, true), verify: result }`.
- `POST /:workspace/storage/activate` body `{ laneId: string }` — gates: `byoBucketAllowed` unless target lane is binding-mode (switching back must survive flag revocation, same #619 posture), `allowWrite` rate limit. If target lane is HTTP-mode and `verifiedAt` older than 10 minutes, re-run `storageVerify` against the opened (decrypted) lane credentials; 422 with the verify result on fail. Then inside one `mutateWorkspaceRecord`: demote current top-level fields into a lane (reuse existing `storageLaneId` as its id, else `newLaneId()`; stamp `lastActiveAt: nowIso`; upsert by bucket), promote target lane's fields to top-level (delete it from `storageLanes`), set `storageLaneId` to the promoted lane's id. Log event `workspace_storage_lane_activated`.
- `DELETE /:workspace/storage` body/query gains optional `laneId`. With `laneId`: remove that lane from `storageLanes`; if it has `lastActiveAt`, first check emptiness — run a `store.list({ limit: 1 })` against that lane (build via the shared config helper from B2); non-empty → 409 `workspace_storage_not_empty` unless `force`. Without `laneId` (legacy shape): if active lane is BYO → behave as today's detach (restore `selfServeWorkspaceRecord` fields) but **keep** the BYO config as a fallback lane when the D1 ledger has objects, drop it when `force`. Keep the PR A gate exactly (`!byoBucketAllowed && !record.storageConfiguredAt` → 403).
- `storageStatusResponse` gains `lanes: Array<{ laneId: string; role: "standby" | "fallback"; bucket: string; publicBaseUrl?: string; verifiedAt?: string; lastActiveAt?: string; accountIdMasked?: string; accessKeyIdLast4?: string }>` and `activeLaneId?: string`. Never credential values.
- [ ] **Step 1: Failing tests.** (a) PUT on a populated workspace (usage.objects > 0) → 200, top-level fields unchanged, response lanes contains one standby; (b) activate → top-level = lane config, old config now a fallback lane with `lastActiveAt`; (c) activate with stale `verifiedAt` re-runs verify (assert via `setStorageVerifyForTests` call count) and 422s on fail without mutating; (d) activate back to the shared lane by its laneId → shared fields restored, BYO lane is a fallback; (e) DELETE laneId on an objects-holding fallback lane → 409; with force → lane gone; (f) legacy DELETE (no laneId) with empty ledger → today's behavior (config dropped).
- [ ] **Step 2: Verify fail. Step 3: Implement. Step 4: Suite + typecheck green.**
- [ ] **Step 5: Commit** `feat(api): decoupled storage save/activate/remove with lane transitions`.

### Task D3: web client + settings UI

**Files:**

- Modify: `apps/web/src/lib/api-client.ts` (:1893-1960 storage methods; add `activateWorkspaceStorage(name, laneId)`; PUT loses its 409 branch; DELETE gains optional laneId)
- Modify: `apps/web/src/pages/account/workspaces/[name]/settings/storage.astro` (remove `applySharedUsageGate` :739-748 and the `#storage-connect-note` at :77; wizard CTA becomes "Save & verify"; render saved-config card with "Use this bucket" / active-state card with "Switch back to uploads.sh storage"; a "previous storage" line listing fallback lanes)
- Modify: `apps/web/src/pages/docs/byo-bucket.astro` (:72 empty-workspace note → two-lane explanation; serving matrix :76-115 gains "files uploaded before switching" row)
- Modify: admin storage panel (`grep -rln "admin-ui/workspaces" apps/web/src | head`) — read-only lanes list.
- Test: whatever component/route tests exist for these pages (`grep -rln "storage" apps/web/test 2>/dev/null || true`); otherwise browser-verify (Step 4).

**Interfaces:**

- Consumes: D2's `StorageStatusResponse.lanes` / `activeLaneId`, new activate endpoint.
- Copy (verbatim, per spec): switch confirmation — "Existing files stay where they are and keep working. New uploads go to your bucket." Saved-card status line — "Saved · not in use". Buttons — "Save & verify", "Use this bucket", "Switch back to uploads.sh storage". Docs stay "in preview" phrasing; never say "flag".
- [ ] **Step 1: Implement client methods + UI states.** Follow the page's existing vanilla-JS + `applyStatus()` pattern; no framework JS on this page beyond what exists.
- [ ] **Step 2: Typecheck + unit tests green.** `pnpm --filter @uploads/web exec tsc --noEmit` (if web is still blocked on TS7/#610, run the repo's web check task instead — `grep '"check"' apps/web/package.json`).
- [ ] **Step 3: Browser verification** against the local stack (memory: only the stack-raw 127.0.0.1 recipe gives a signed-in in-app-browser session — see `uploads-local-browser-verify-recipe`): populated workspace → Save & verify (fake/verify seam or real test bucket) → card shows saved-not-in-use → activate → old file page still renders with storage.uploads.sh URL → new upload lands on the BYO base URL → switch back. Screenshot the storage panel states for the PR (use the `/github-screenshots` skill — this is a visual settings change).
- [ ] **Step 4: Commit** `feat(web): two-lane storage settings — save, verify, switch, switch back`.

### Task D4: doctor line, docs page, issue hygiene

**Files:**

- Modify: CLI doctor storage line (`grep -rln "doctor" packages/cli/src | head`, find the storage/honesty line from PR #590) — report active lane + fallback count ("storage: your bucket (1 previous lane still serving old files)").
- Modify: `apps/web/src/pages/docs/byo-bucket.astro` if not fully covered in D3.
- Test: CLI doctor test file if one exists.

- [ ] **Step 1: Implement + test.**
- [ ] **Step 2: Commit** `feat(cli): doctor reports storage lanes`. Open PR D: `feat: two-lane workspace storage — save, switch, and fall back without migration`. **Request CodeRabbit review** (storage transitions + auth-gated routes). PR body: spec path, behavior contract, screenshots from D3.
- [ ] **Step 3: After merge:** comment on #594 scoping it down to physical migration residue (link the spec; do not close without Zach), close #619 (PR A), update #630/#595 with a pointer to the N-lane-ready record shape. Reminder: never include user/upload counts in public issue comments.

---

## Self-review notes (already applied)

- Spec §"Configure, then switch" maps to D2; §"N-lane readiness" is carried by B1/B2 types (id-addressed array, provider string); §"files-sdk" is a global constraint; §usage → D1; §listing → C4; §read path → C1–C3; §UI/docs/doctor → D3/D4; §testing cases distributed into each task's Step 1.
- Type consistency: `StorageLane`, `LaneConfig`, `ResolvedLane`, `LaneCursorMap`, `newLaneId`, `storageConfigs`, `resolveObjectLane`, `encodeLaneCursor`/`decodeLaneCursor`/`mergeLaneListings`, `enforcedStorageUsageBytes` — defined once each, consumed by name in later tasks.
- Known judgment calls left to implementers _with the spec as tiebreaker_: exact provenance key casing (match neighbors, B3); which gallery/poster/comment sites truly need lane resolution (C-final audit, reported per-site in the PR body).
