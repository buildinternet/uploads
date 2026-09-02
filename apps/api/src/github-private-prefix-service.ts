/**
 * Resolves the GitHub-key mode a caller should use when staging an
 * attachment for a repo (issue #631) — behind `POST
 * /v1/:workspace/github/private-prefix`. A private repo's attachments live
 * under a randomized per-branch prefix id (`github-private-prefixes.ts`)
 * instead of the plain `gh/<repo>/<branch-or-target>/...` key, so an
 * unauthenticated `/public/files/...` fetch can't be walked to discover a
 * private repo's staged attachments.
 *
 * Fail-open by design: every unknown/unauthorized/error step degrades to
 * `{ mode: "plain" }`, exactly today's (pre-#631) behavior — this endpoint
 * must never block an upload. It's also the no-oracle guarantee: an
 * unauthorized caller's response is indistinguishable from a public repo's,
 * and no row is minted along that path.
 */
import { ForbiddenError } from "@uploads/errors";
import { githubAppConfig, installationForRepo, prHeadBranch, repoIsPrivate } from "./github-app";
import { checkRepoAuthorization, postManagedComment } from "./github-comment-service";
import { GH_PRIVATE_ROOT, type GhTargetKind, parseGhPrivateKey } from "./github-comment-render";
import { deleteObject, putObject, putOptsFromStoredObject } from "./files-core";
import { deleteFileMetadata } from "./file-metadata";
import {
  getActivePrefixId,
  getOrMintPrefixId,
  listRetiredPrefixIds,
  retirePrefixId,
} from "./github-private-prefixes";
import { storage } from "./storage";
import type { WorkspaceRecord } from "./workspace";
import { dbFor } from "./db-session";

export type GhKeyMode = { mode: "plain" } | { mode: "private"; prefixId: string };

export interface ResolveGhKeyRequest {
  repo: string;
  branch?: string;
  target?: { kind: "pull" | "issues"; num: number };
}

/**
 * Decision flow (see the module doc for the fail-open rationale):
 * 1. App not configured → plain.
 * 2. App not installed on `req.repo` → plain.
 * 3. `req.repo` not private (or privacy can't be determined) → plain.
 * 4. `checkRepoAuthorization` declines (cross-tenant gate, same as the
 *    comment/promote routes) → plain, no row minted.
 * 5. Branch pick: explicit `req.branch` wins; else a `pull` target resolves
 *    its head branch (a lookup failure → plain); else the repo-level ""
 *    sentinel (issues targets and branch-less calls).
 * 6. `getOrMintPrefixId` → `{ mode: "private", prefixId }`.
 */
export async function resolveGhKeyContext(
  env: Env,
  workspaceName: string,
  mintingUserId: string | null,
  req: ResolveGhKeyRequest,
): Promise<GhKeyMode> {
  const cfg = githubAppConfig(env);
  if (!cfg) return { mode: "plain" };

  const installId = await installationForRepo(env, cfg, req.repo);
  if (installId === null) return { mode: "plain" };

  const isPrivate = await repoIsPrivate(env, cfg, installId, req.repo);
  if (isPrivate !== true) return { mode: "plain" };

  const decline = await checkRepoAuthorization(
    env,
    req.repo,
    workspaceName,
    mintingUserId,
    installId,
  );
  if (decline) return { mode: "plain" };

  let branch: string;
  if (req.branch !== undefined) {
    branch = req.branch;
  } else if (req.target?.kind === "pull") {
    const head = await prHeadBranch(env, cfg, installId, req.repo, req.target.num);
    if (head === null) return { mode: "plain" };
    branch = head;
  } else {
    branch = "";
  }

  // Fail-open on the DB tail too: a transient D1 error minting/reading the
  // row must degrade to plain, not propagate as a 500 — this resolve call
  // sits directly in front of an upload, and the "never block an upload"
  // invariant applies to every step, not just the lookups above it.
  try {
    const prefixId = await getOrMintPrefixId(dbFor(env), req.repo, branch);
    return { mode: "private", prefixId };
  } catch (err) {
    console.error(
      JSON.stringify({
        message: "resolveGhKeyContext: getOrMintPrefixId failed, degrading to plain",
        repo: req.repo,
        branch,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return { mode: "plain" };
  }
}

/**
 * `resolveGhKeyContext`, guarded for a server-side (no caller identity)
 * call: its own D1 tail (`checkRepoAuthorization` → `findRepoLinkStrict`)
 * deliberately PROPAGATES D1 errors rather than degrading — fine for its
 * direct HTTP route caller, but a background ingest/promote pass must never
 * abort just because the mode couldn't be determined. Same fail-open idiom
 * as the webhook's privacy-cache write-through. `mintingUserId` is always
 * `null` here — every current caller runs with no caller identity.
 * `callerLabel` tags the degrade log (e.g. "github-ingest", "promote") so
 * the two near-identical call sites this replaces stay distinguishable in
 * logs.
 */
export async function resolveGhKeyContextSafe(
  env: Env,
  workspaceName: string,
  req: ResolveGhKeyRequest,
  callerLabel: string,
): Promise<GhKeyMode> {
  try {
    return await resolveGhKeyContext(env, workspaceName, null, req);
  } catch (err) {
    console.error(
      JSON.stringify({
        message: `${callerLabel}: resolveGhKeyContext failed; degrading to plain`,
        repo: req.repo,
        ...(req.branch !== undefined ? { branch: req.branch } : {}),
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return { mode: "plain" };
  }
}

export type RotatePrivatePrefixResult =
  | { rotated: false; reason: string }
  | { rotated: true; prefixId: string; moved: number };

/**
 * Rotate the active prefix id for `(repo, branch)` (issue #631, Task 8):
 * mint a fresh id, move every object under the old id's key space (plus any
 * leftovers stranded under a PREVIOUS, interrupted rotation for the same
 * (repo, branch) — see the resumability note below) to the same tail under
 * the new id (bytes + R2 custom metadata + the D1 rows that point at the
 * object key), delete the old objects (so old URLs 404 at origin
 * immediately), retire the old row, and re-sync the managed comment for
 * every PR/issue that had a moved object.
 *
 * Authorization mirrors `resolveGhKeyContext`'s `checkRepoAuthorization`
 * call, but with the opposite failure posture: `resolveGhKeyContext` is an
 * implicit, best-effort resolve sitting in front of every upload, so it
 * fails open to `{ mode: "plain" }` on any decline. Rotation is an explicit,
 * caller-initiated action with no safe "do nothing" default that still
 * looks like success — so a decline here is a thrown `ForbiddenError`
 * (mapped to a 403 by the route), not a silent no-op.
 *
 * No `installId` is resolved up front here (unlike `resolveGhKeyContext`):
 * `checkRepoAuthorization` only dereferences one on the unbound-repo
 * entitlement path (`isEntitledToClaimRepo`, which does its own lazy
 * `installationForRepo` lookup when it isn't handed one), and a repo with an
 * active private prefix row was necessarily private+installed at some
 * point, so the already-bound case — the normal steady state for a rotate
 * call — never touches it at all. Passing `null` unconditionally avoids an
 * eager GitHub API round trip on the common path.
 *
 * Schema note: `github_private_prefixes_active_idx` allows at most one
 * un-rotated row per (repo, branch), so the old row is retired FIRST to
 * free that slot before `getOrMintPrefixId` inserts the new one — the two
 * calls can't be reordered without a duplicate-active-row race. Every
 * object is copied to the new id's key space (and the old copy still
 * exists) before the old object is deleted, so there is no window where a
 * moved attachment is unreachable at both keys.
 *
 * Resumability: a crash/timeout mid-sweep would otherwise strand objects
 * under a tombstoned id forever — a later `rotatePrivatePrefix` call only
 * discovers `getActivePrefixId`'s CURRENT row, never a retired one, so a
 * naive re-run would silently leave those objects unrevoked. Instead every
 * call sweeps `listRetiredPrefixIds` for this (repo, branch) — which
 * includes the id retired a few lines up PLUS any earlier tombstones a
 * previous interrupted rotation left mid-sweep — so a follow-up rotation
 * (even one that only fires because an operator noticed and retried) drains
 * every stranded object into the new id, not just the most recent old one.
 *
 * Partial-failure posture: a single object's copy can throw (e.g. an
 * `InsufficientStorageError`/`ValidationError` from `putObject`). That
 * propagates — the caller sees the failure — but the comment resync for
 * every target already moved before the failure still runs (`finally`), so
 * a partial rotation doesn't also leave a stale managed comment pointing at
 * now-half-migrated attachments. The failed object's OLD copy is left in
 * place (never reached the delete step), so nothing is lost; the next call
 * picks it up via the resumability sweep above.
 */
export async function rotatePrivatePrefix(
  env: Env,
  ws: WorkspaceRecord,
  workspaceName: string,
  mintingUserId: string | null,
  repo: string,
  branch: string,
): Promise<RotatePrivatePrefixResult> {
  const decline = await checkRepoAuthorization(env, repo, workspaceName, mintingUserId, null);
  if (decline) {
    throw new ForbiddenError(decline.message, { code: "not_authorized" });
  }

  const oldId = await getActivePrefixId(dbFor(env), repo, branch);
  if (oldId === null) return { rotated: false, reason: "no_prefix" };

  await retirePrefixId(dbFor(env), repo, branch, oldId);
  const newId = await getOrMintPrefixId(dbFor(env), repo, branch);

  // Includes `oldId` (just retired above) plus any tombstone left behind by
  // an earlier, interrupted rotation for this same (repo, branch) — see the
  // resumability note above.
  const sourceIds = await listRetiredPrefixIds(dbFor(env), repo, branch);

  const store = await storage(env, ws);
  const newPrefixRoot = `${GH_PRIVATE_ROOT}${newId}/`;

  const targets = new Map<string, { kind: GhTargetKind; num: number }>();
  let moved = 0;

  try {
    for (const sourceId of sourceIds) {
      const oldPrefix = `${GH_PRIVATE_ROOT}${sourceId}/`;
      let cursor: string | undefined;
      // Bounded pagination, same idiom (and same ceiling) as
      // `promoteBranchAttachments`'s sweep — a pathological prefix can't
      // loop forever.
      const MAX_LIST_PAGES = 50;
      for (let page = 0; page < MAX_LIST_PAGES; page++) {
        const result = await store.list({ prefix: oldPrefix, limit: 1000, cursor });
        for (const item of result.items) {
          const tail = item.key.slice(oldPrefix.length);
          const newKey = `${newPrefixRoot}${tail}`;

          const source = await store.download(item.key);
          const bytes = new Uint8Array(await source.arrayBuffer());
          // Not a byte-for-byte metadata copy: `putObject` runs its normal
          // write path on `provenance: source.metadata` — `sanitizeProvenance`
          // strips it to the client-safe subset, `content-sha256` is
          // recomputed fresh from the bytes (same value, since the bytes are
          // identical), and `uploaded-at` resets to now (no prior head exists
          // yet at `newKey`, so `resolveUploadedAtMeta` can't preserve the
          // original stamp). `putObject` also has its own additive
          // content-hash-inheritance side effect here (files-core.ts): since
          // these bytes already exist in the workspace under the OLD key,
          // this call's own donor lookup can find that old key (or any other
          // content-identical object) and write inheritable `file_metadata`
          // rows (`repo`, `path`, `url`, …) onto `newKey` before this
          // function's own rename below runs.
          await putObject(env, ws, newKey, bytes, workspaceName, {
            ...putOptsFromStoredObject(source),
            surface: "rotate",
          });

          // Wipe whatever's already at `newKey` before renaming onto it —
          // `putObject`'s inheritance above may have just written donor rows
          // there, and a second `sourceId` in this sweep can produce the same
          // tail as an id already processed. Either way the OLD key (the one
          // this iteration is actually moving) must be the sole source of
          // truth for `newKey`'s resulting rows; a plain `UPDATE` into an
          // already-occupied (workspace, object_key, meta_key) row would
          // otherwise throw a UNIQUE constraint violation.
          await deleteFileMetadata(dbFor(env), workspaceName, newKey);
          await dbFor(env)
            .prepare(
              `UPDATE file_metadata SET object_key = ? WHERE workspace = ? AND object_key = ?`,
            )
            .bind(newKey, workspaceName, item.key)
            .run();

          // `file_content_hash` needs no rename/collision guard: `putObject`
          // above already unconditionally upserted (INSERT ... ON CONFLICT
          // DO UPDATE) a correct row for `newKey` via its own
          // `recordContentHash` call, keyed by the same content hash (the
          // bytes are identical). This only removes the now-stale OLD row so
          // it can't linger as a dead inheritance donor pointing at a
          // shortly-to-be-deleted key.
          await dbFor(env)
            .prepare(`DELETE FROM file_content_hash WHERE workspace = ? AND object_key = ?`)
            .bind(workspaceName, item.key)
            .run();

          // Scoped to `workspace` (not just `object_key`): object keys are
          // R2-bucket-relative and can collide across workspaces sharing a
          // bucket prefix, so an unscoped match could rename another
          // workspace's row that merely happens to share this tail.
          await dbFor(env)
            .prepare(
              `UPDATE github_ingested_assets SET object_key = ? WHERE object_key = ? AND workspace = ?`,
            )
            .bind(newKey, item.key, workspaceName)
            .run();
          // Gallery items referencing this object follow the move too, so a
          // rotated attachment doesn't quietly break a public gallery page.
          // `gallery_items` has no `workspace` column of its own, so scope
          // through its parent `galleries` row instead — same
          // cross-workspace-collision reasoning as the ledger update above.
          await dbFor(env)
            .prepare(
              `UPDATE gallery_items SET object_key = ?
             WHERE object_key = ?
               AND gallery_id IN (SELECT id FROM galleries WHERE workspace = ?)`,
            )
            .bind(newKey, item.key, workspaceName)
            .run();

          // `deleteObject` (not a raw `store.delete`): it also releases the
          // old key's usage-ledger bytes/object count (and its poster, if
          // any — `putObject` above already regenerated one for the new key
          // when applicable), so a rotation doesn't inflate the workspace's
          // storage usage or orphan a video's poster frame.
          await deleteObject(env, ws, item.key, workspaceName);
          moved++;

          const parsed = parseGhPrivateKey(newKey);
          if (parsed)
            targets.set(`${parsed.kind}:${parsed.num}`, { kind: parsed.kind, num: parsed.num });
        }
        cursor = result.cursor ?? undefined;
        if (!cursor) break;
      }
    }
  } finally {
    // Runs even when the loop above threw partway through: every target
    // that was fully moved before the failure still gets its managed
    // comment pointed at the new prefix, rather than staying stale until
    // someone notices and retries the whole rotation. Each re-sync is
    // already best-effort and independent of the others, so they run
    // concurrently; `allSettled` (not `all`) so one target's rejection can't
    // throw from inside a `finally` and mask whatever error the try block
    // above was already propagating.
    await Promise.allSettled(
      Array.from(targets.values(), (target) =>
        postManagedComment(
          env,
          ws,
          workspaceName,
          mintingUserId,
          { repo, kind: target.kind, num: target.num },
          { resync: true },
        ),
      ),
    );
  }

  return { rotated: true, prefixId: newId, moved };
}
