/**
 * Shared service behind `POST /v1/:workspace/github/promote` and the hosted
 * MCP `promote` tool (and optional post-`put` promote when a branch is
 * supplied with pr). Copies this workspace's branch-staged attachments into
 * the PR prefix, then best-effort records the repo binding the same way the
 * REST route does (issue #297 claim gate on *new* bindings only).
 *
 * Pure workspace-data copy — no GitHub API call for the promote itself.
 * Claim entitlement may call GitHub; failure to claim never fails the promote.
 */
import { isEntitledToClaimRepo } from "./github-claim-authz";
import { promoteBranchAttachments, type PromoteResult, type PromoteTarget } from "./github-promote";
import { findRepoLink, recordRepoLink } from "./github-repo-links";
import type { WorkspaceRecord } from "./workspace";

export type { PromoteResult, PromoteTarget };

/**
 * Promote branch-staged objects, then attempt the same implicit
 * repo-link claim the REST route performs after a 2xx promote.
 */
export async function postPromoteBranchAttachments(
  env: Env,
  ws: WorkspaceRecord,
  workspaceName: string,
  mintingUserId: string | null,
  target: PromoteTarget,
): Promise<PromoteResult> {
  const result = await promoteBranchAttachments(env, ws, workspaceName, target);

  // Implicit claim (phase 3): first-claim-wins; never affects the promote
  // result. Cross-tenant gate on NEW claims only (issue #297) — already-bound
  // repos re-record via INSERT OR IGNORE (no-op).
  const existingLink = await findRepoLink(env.DB, target.repo);
  const canClaim =
    existingLink !== null || (await isEntitledToClaimRepo(env, target.repo, mintingUserId));
  if (canClaim) {
    await recordRepoLink(env.DB, target.repo, workspaceName, "promote");
  }

  return result;
}
