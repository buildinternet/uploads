/**
 * Shared service behind `POST /v1/workspaces/:workspace/github/attach` and
 * the hosted MCP `promote` tool's explicit `keys` argument (issue #702).
 * Copies one existing object into a PR/issue's attachment prefix
 * (`github-attach.ts`), then — unlike branch-staged promote, which leaves
 * comment sync to a separate CLI call — runs the normal managed-comment sync
 * itself, so one API call both attaches and refreshes the comment. Also
 * performs the same implicit repo-link claim `github-promote-service.ts`
 * does after a 2xx promote (issue #297 claim gate on *new* bindings only).
 */
import { isEntitledToClaimRepo } from "./github-claim-authz";
import {
  attachExistingObject,
  type AttachExistingRequest,
  type AttachExistingResult,
} from "./github-attach";
import { postManagedComment, type PostCommentResult } from "./github-comment-service";
import { findRepoLink, recordRepoLink } from "./github-repo-links";
import type { WorkspaceRecord } from "./workspace";
import { dbFor } from "./db-session";

export type { AttachExistingRequest, AttachExistingResult };

export interface AttachExistingResponse extends AttachExistingResult {
  comment: PostCommentResult;
}

export async function postAttachExisting(
  env: Env,
  ws: WorkspaceRecord,
  workspaceName: string,
  mintingUserId: string | null,
  req: AttachExistingRequest,
): Promise<AttachExistingResponse> {
  const result = await attachExistingObject(env, ws, workspaceName, req);

  // Implicit claim (mirrors postPromoteBranchAttachments): first-claim-wins,
  // never affects the attach result. Cross-tenant gate on NEW claims only
  // (issue #297) — already-bound repos re-record via INSERT OR IGNORE (no-op).
  const existingLink = await findRepoLink(dbFor(env), req.target.repo);
  const canClaim =
    existingLink !== null || (await isEntitledToClaimRepo(env, req.target.repo, mintingUserId));
  if (canClaim) {
    await recordRepoLink(dbFor(env), req.target.repo, workspaceName, "attach");
  }

  // Comment sync (the piece promote leaves to a separate CLI call) — never
  // throws; postManagedComment degrades to { posted: false, reason } on any
  // integration failure, same contract the CLI already handles.
  const comment = await postManagedComment(env, ws, workspaceName, mintingUserId, req.target, {});

  return { ...result, comment };
}
