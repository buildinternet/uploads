/**
 * Shared service behind `POST /v1/:workspace/github/comment` (phase 2 PR B)
 * and the hosted MCP `put`/`comment` tools (issue #392). Workspace-authed
 * callers only — renders the calling workspace's own attachments + galleries
 * for a PR/issue and, when the App is installed with write, upserts the
 * managed comment as the bot. Never throws on an integration failure — a
 * bot-post problem returns `{ posted: false, reason }` so callers can fall
 * back (the CLI to its local-gh path; the hosted MCP surfaces the decline).
 */
import { gatherCommentBody, upsertBotComment } from "./github-comment";
import { githubAppConfig, installationForRepo } from "./github-app";
import { isEntitledToClaimRepo } from "./github-claim-authz";
import { findRepoLinkStrict, recordRepoLink } from "./github-repo-links";
import type { GhTarget } from "./github-comment-render";
import type { WorkspaceRecord } from "./workspace";

/**
 * Cross-tenant authorization gate (issue #297). The App is installed
 * org-wide, so every workspace's token can resolve an installation for *any*
 * org's repo — without this check, workspace A could post/deface
 * `uploads-sh[bot]` comments on workspace B's repo using A's own uploaded
 * images under a crafted `gh/<B's org>/...` key prefix, simply by being the
 * first to call this endpoint for that repo (the implicit-claim call below
 * has no entitlement check of its own).
 *
 * Uses the strict lookup (`findRepoLinkStrict`) deliberately: a D1 failure
 * here must propagate (5xx via the app's error handler) rather than degrade
 * to "unbound", which would silently allow posting during an outage.
 *
 * - Bound to this workspace → `null` (allowed).
 * - Bound to a different workspace → decline; never re-checked against
 *   entitlement (grandfathered — a legitimately-bound repo keeps working even
 *   if the binder's GitHub link later changes or lapses).
 * - Unbound → gated by `isEntitledToClaimRepo` (github-claim-authz.ts): only a
 *   caller whose linked GitHub identity has push/maintain/admin access to
 *   `repo` may make the first claim. This is also what closes the communal
 *   `default` workspace's exposure — its tokens have no minting user, so they
 *   can never claim a new repo (though they can still act on repos already
 *   bound to `default`).
 */
async function checkRepoAuthorization(
  env: Env,
  repo: string,
  workspaceName: string,
  mintingUserId: string | null,
  installId: number,
): Promise<{ posted: false; reason: "not_authorized"; message: string } | null> {
  const link = await findRepoLinkStrict(env.DB, repo);
  if (link) {
    if (link.workspaceName === workspaceName) return null;
    return {
      posted: false,
      reason: "not_authorized",
      message:
        `${repo} is bound to a different workspace ("${link.workspaceName}") — this ` +
        `workspace is not authorized to post the uploads-sh[bot] comment there.`,
    };
  }
  const entitled = await isEntitledToClaimRepo(env, repo, mintingUserId, fetch, installId);
  if (!entitled) {
    return {
      posted: false,
      reason: "not_authorized",
      message:
        `${repo} isn't linked to any workspace yet, and this workspace couldn't be ` +
        `verified as entitled to claim it. Link a GitHub account with push access ` +
        `to ${repo}, or ask an operator to bind the repo explicitly.`,
    };
  }
  return null;
}

/**
 * Actionable body for a `forbidden` (App installed, write not yet approved)
 * decline. `fixUrl` is the org install's permission-review page — this product
 * installs on orgs, so the org form is the right target; the message stands on
 * its own if an install is ever user-owned.
 */
function forbiddenDecline(repo: string, installId: number) {
  const owner = repo.split("/")[0];
  return {
    posted: false as const,
    reason: "forbidden" as const,
    message:
      `The uploads.sh GitHub App is installed on ${repo} but needs Issues and ` +
      `Pull requests write access approved before it can comment as ` +
      `uploads-sh[bot]. An org admin must approve the updated permissions.`,
    fixUrl: `https://github.com/organizations/${owner}/settings/installations/${installId}/permissions/update`,
    required: ["issues:write", "pull_requests:write"],
  };
}

export type PostCommentResult =
  | { posted: false; reason: "app_unconfigured" }
  | { posted: false; reason: "not_installed" }
  | { posted: false; reason: "not_authorized"; message: string }
  | { posted: false; reason: "unavailable" }
  | {
      posted: false;
      reason: "forbidden";
      message: string;
      fixUrl: string;
      required: string[];
    }
  | { posted: true; action: "skipped"; count: 0 }
  | { posted: true; action: "created" | "updated"; count: number; commentUrl: string };

/**
 * Gather + upsert the managed comment for `target` on behalf of
 * `workspaceName`. Same ordering as the REST route: app-config, then
 * installation lookup, then the cross-tenant gate, then gather, then upsert.
 * Gather always renders a body (the neutral empty state when nothing is
 * staged); the create-vs-patch decision is the upsert's `createIfMissing`
 * gate (`count > 0`), so an emptied PR rewrites an existing comment but never
 * creates one. On an actual post, best-effort records `target.repo` as bound
 * to `workspaceName` (first-claim-wins, never affects the return value).
 */
export async function postManagedComment(
  env: Env,
  ws: WorkspaceRecord,
  workspaceName: string,
  mintingUserId: string | null,
  target: GhTarget,
): Promise<PostCommentResult> {
  const cfg = githubAppConfig(env);
  if (!cfg) return { posted: false, reason: "app_unconfigured" };
  const installId = await installationForRepo(env, cfg, target.repo);
  if (installId === null) return { posted: false, reason: "not_installed" };

  const decline = await checkRepoAuthorization(
    env,
    target.repo,
    workspaceName,
    mintingUserId,
    installId,
  );
  if (decline) return decline;

  const gathered = await gatherCommentBody(env, ws, workspaceName, target);

  // Patch-only when empty: never create a comment just to say "empty" (see
  // upsertBotComment's createIfMissing). `gathered.body` already renders the
  // neutral empty state when count is 0.
  const result = await upsertBotComment(
    env,
    cfg,
    installId,
    target,
    gathered.body,
    workspaceName,
    fetch,
    {
      createIfMissing: gathered.count > 0,
    },
  );
  if ("degrade" in result) {
    // A 403 means the App is installed but lacks Issues/PR write (pending org
    // approval). Enrich that one reason with actionable guidance so callers
    // can tell the user instead of silently falling back. Mirrors the
    // IntegrationAuthorizationError vocabulary (@uploads/errors) for the soft,
    // never-throwing decline path.
    if (result.degrade === "forbidden") return forbiddenDecline(target.repo, installId);
    return { posted: false, reason: result.degrade };
  }
  // Empty + no existing comment: nothing posted, nothing to claim.
  if (result.action === "skipped") return { posted: true, action: "skipped", count: 0 };

  // Implicit claim (phase 3): the comment actually posted, so this
  // workspace has proven authenticated write access to this repo's
  // PR/issue thread — best-effort record it as the repo's bound workspace.
  // First-claim-wins (recordRepoLink) and never affects this response.
  await recordRepoLink(env.DB, target.repo, workspaceName, "comment", installId);

  return {
    posted: true,
    action: result.action,
    count: gathered.count,
    commentUrl: result.commentUrl,
  };
}
