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
import { deleteObject, putObject } from "./files-core";
import { getActivePrefixId, getOrMintPrefixId, retirePrefixId } from "./github-private-prefixes";
import { storage } from "./storage";
import { objectVisibility } from "./visibility";
import type { WorkspaceRecord } from "./workspace";

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
    const prefixId = await getOrMintPrefixId(env.DB, req.repo, branch);
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

export type RotatePrivatePrefixResult =
  | { rotated: false; reason: string }
  | { rotated: true; prefixId: string; moved: number };

/**
 * Rotate the active prefix id for `(repo, branch)` (issue #631, Task 8):
 * mint a fresh id, move every object under the old id's key space to the
 * same tail under the new id (bytes + R2 custom metadata + the D1 rows that
 * point at the object key), delete the old objects (so old URLs 404 at
 * origin immediately), retire the old row, and re-sync the managed comment
 * for every PR/issue that had a moved object.
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

  const oldId = await getActivePrefixId(env.DB, repo, branch);
  if (oldId === null) return { rotated: false, reason: "no_prefix" };

  await retirePrefixId(env.DB, repo, branch, oldId);
  const newId = await getOrMintPrefixId(env.DB, repo, branch);

  const store = await storage(env, ws);
  const oldPrefix = `${GH_PRIVATE_ROOT}${oldId}/`;
  const newPrefixRoot = `${GH_PRIVATE_ROOT}${newId}/`;

  const targets = new Map<string, { kind: GhTargetKind; num: number }>();
  let moved = 0;

  let cursor: string | undefined;
  // Bounded pagination, same idiom (and same ceiling) as
  // `promoteBranchAttachments`'s sweep — a pathological prefix can't loop
  // forever.
  const MAX_LIST_PAGES = 50;
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const result = await store.list({ prefix: oldPrefix, limit: 1000, cursor });
    for (const item of result.items) {
      const tail = item.key.slice(oldPrefix.length);
      const newKey = `${newPrefixRoot}${tail}`;

      const source = await store.download(item.key);
      const bytes = new Uint8Array(await source.arrayBuffer());
      const visibility = objectVisibility(source.metadata);
      // Byte-for-byte copy: the R2 custom metadata (provenance/visibility)
      // is carried over as-is — unlike `promoteBranchAttachments`, this is
      // not a re-derivation with fresh `gh.*` tags, since nothing about the
      // attachment's identity (repo, kind, number) changed, only its key.
      await putObject(env, ws, newKey, bytes, workspaceName, {
        provenance: source.metadata,
        visibility,
        surface: "rotate",
      });

      // Rename in place: the queryable metadata and ingest-ledger rows keep
      // their values, they just now point at the new key. Done BEFORE the
      // delete below so `deleteObject`'s own `deleteFileMetadata` call finds
      // nothing left at the old key to (redundantly) clean up.
      await env.DB.prepare(
        `UPDATE file_metadata SET object_key = ? WHERE workspace = ? AND object_key = ?`,
      )
        .bind(newKey, workspaceName, item.key)
        .run();
      await env.DB.prepare(`UPDATE github_ingested_assets SET object_key = ? WHERE object_key = ?`)
        .bind(newKey, item.key)
        .run();

      // `deleteObject` (not a raw `store.delete`): it also releases the old
      // key's usage-ledger bytes/object count, so a rotation doesn't inflate
      // the workspace's storage usage by double-counting bytes that already
      // existed under the old key.
      await deleteObject(env, ws, item.key, workspaceName);
      moved++;

      const parsed = parseGhPrivateKey(newKey);
      if (parsed)
        targets.set(`${parsed.kind}:${parsed.num}`, { kind: parsed.kind, num: parsed.num });
    }
    cursor = result.cursor ?? undefined;
    if (!cursor) break;
  }

  for (const target of targets.values()) {
    await postManagedComment(
      env,
      ws,
      workspaceName,
      mintingUserId,
      { repo, kind: target.kind, num: target.num },
      { resync: true },
    );
  }

  return { rotated: true, prefixId: newId, moved };
}
