# Deletion policy

How deletions behave across uploads.sh, per surface: which are soft (recoverable
for a grace window), which are hard (immediate and permanent), and why.
Follow-up to the admin workspace delete (#244) and the soft-delete evaluation
(#247).

## The rule

**Member-facing deletes are soft; break-glass and finalization are hard.**

Anything a workspace member (or admin acting routinely) can trigger should be
reversible for a grace window. Hard deletion happens only as an explicit
break-glass action or as the automated finalization of an already-expired soft
delete.

## Per-surface policy

| Surface                                                       | Mode                              | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workspace deletion (`DELETE /admin/workspaces/:name`)         | **Soft** by default, 14-day grace | Tombstones the `ws:<name>` KV record; access denied immediately; data (R2, metadata, galleries) retained; `POST /admin/workspaces/:name/restore` undeletes within the window. The daily retention cron finalizes past `purgeAt` with the full hard teardown.                                                                                                                                                                                                           |
| Workspace deletion, break-glass (`?hard=1`)                   | **Hard**                          | Immediate permanent teardown (R2 objects, file_metadata, galleries, auth org, KV record). Non-empty workspaces additionally require `force=1`. The only path that frees a slug.                                                                                                                                                                                                                                                                                        |
| Slug reuse                                                    | **Never freed by finalization**   | After finalization the `ws:<name>` key retains a permanent `{ status: "purged" }` tombstone, so registration keeps rejecting the name. This closes the squatting vector where old public `storage.uploads.sh/<name>/…` URLs embedded in merged PRs could be re-registered by a different owner. Admin hard delete is the deliberate escape hatch.                                                                                                                      |
| Galleries (`DELETE /v1/:ws/galleries/:id`)                    | **Soft** (`deleted_at`)           | Existing behavior; all reads filter `deleted_at IS NULL`. Workspace teardown hard-deletes galleries via `deleteGalleriesForWorkspace` — that is finalization, consistent with the rule.                                                                                                                                                                                                                                                                                |
| File deletion (`files:delete` via API/MCP)                    | **Hard**                          | Object-storage semantics; kept intentionally. No trash tier.                                                                                                                                                                                                                                                                                                                                                                                                           |
| Retention purge (per-workspace `retentionDays`)               | **Hard**                          | Automated expiry is finalization by definition.                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Auth org deletion                                             | **Hard, best-effort**             | Runs during workspace teardown; multi-member orgs are left behind (logged as orphaned) and are inert without a KV record. Swept daily — see "Orphaned auth-org sweep" below.                                                                                                                                                                                                                                                                                           |
| Self-serve workspace deletion (`DELETE /v1/workspaces/:name`) | **Soft** by default, 14-day grace | Session-authed; owner-only (`selfServe === true` and `createdByUserId` matches the caller). Same stamp/grace mechanics as the admin path above via a shared helper (`stampSoftDelete`/`stampRestore` in `apps/api/src/workspace.ts`) — the two can't drift. `POST /v1/workspaces/:name/restore` mirrors the admin restore semantics exactly (409 `not_deleted`, 410 `grace_expired`). Never a hard/force mode; never frees the slug. No web console UI yet — API only. |

## Grace window mechanics

- Soft delete stamps `deletedAt` and `purgeAt = deletedAt + 14 days` on the
  workspace KV record.
- Access denial is immediate at the record layer (lookups treat soft-deleted
  workspaces as not found), subject to two propagation tails:
  - workspace record reads use a 60s KV `cacheTtl`, so token auth may succeed
    for up to a minute after deletion;
  - already-cached public bytes can keep serving from the edge/Camo for up to
    the cache window (app-pinned 60s; R2 custom-domain default is 4h for
    objects served before the pin). Deletion of any kind — soft, hard, or
    per-file — does not purge edge caches.
- Restore is available until `purgeAt`; after that the restore endpoint returns
  410 even if the sweep hasn't finalized yet, so recoverability never depends
  on cron timing.
- Finalization runs in the daily retention sweep (06:00 UTC): full hard
  teardown, then the permanent purged tombstone.

## Self-serve workspace deletion (#249)

Implemented on this model: soft delete + grace window only, never direct hard
teardown, no ability to free a slug. `DELETE /v1/workspaces/:name` and
`POST /v1/workspaces/:name/restore` are session-authed and owner-gated
(`selfServe === true` and `createdByUserId` matching the caller); the
communal workspace is excluded. They share the admin path's stamp/grace
logic (`stampSoftDelete`, `isPastGrace`, `stampRestore` in
`apps/api/src/workspace.ts`) so the two surfaces can't drift.

## Orphaned auth-org sweep (#250)

The daily retention sweep (`apps/api/src/retention-sweep.ts`) also lists
every auth-side org (`GET /internal/orgs` on the auth worker) and deletes
(force) any whose slug has no `ws:<slug>` KV key at all, or only a purged
tombstone. A soft-deleted-but-still-in-grace workspace is NOT an orphan —
restore must bring the org back intact, so it's left alone. The communal
workspace slug is skipped defensively, and an AUTH-fetch failure or a
per-org delete failure is isolated (logged, sweep continues) rather than
failing the whole run. Results land in the sweep's `orgsSwept` array and log
line.
