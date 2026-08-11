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
import { githubAppConfig, installationForRepo, prHeadBranch, repoIsPrivate } from "./github-app";
import { checkRepoAuthorization } from "./github-comment-service";
import { getOrMintPrefixId } from "./github-private-prefixes";

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

  const prefixId = await getOrMintPrefixId(env.DB, req.repo, branch);
  return { mode: "private", prefixId };
}
