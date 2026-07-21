/**
 * POST /v1/:workspace/github/comment (phase 2 PR B). Workspace-authed. Renders
 * the calling workspace's own attachments + galleries for a PR/issue and, when
 * the App is installed with write, upserts the managed comment as the bot.
 * Never 5xxs on an integration failure — a bot-post problem returns
 * { posted: false, reason } so the CLI falls back to its local-gh path.
 */
import { ValidationError } from "@uploads/errors";
import { Hono } from "hono";
import { gatherCommentBody, upsertBotComment } from "../github-comment";
import { githubAppConfig, installationForRepo } from "../github-app";
import { isEntitledToClaimRepo } from "../github-claim-authz";
import { findRepoLinkStrict, recordRepoLink } from "../github-repo-links";
import type { GhTargetKind } from "../github-comment-render";
import { writeRateLimit } from "../guards";
import { requireScope, type WorkspaceVars } from "../workspace";
import { jsonBody } from "./json-body";

// Same owner/name grammar as public-files.ts's deriveGithubContext, plus a guard
// against dot-only segments (".", "..") — unlike public-files this repo string is
// interpolated into a server-side api.github.com path, where "../" would traverse.
const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const DOTS_ONLY_RE = /^\.+$/;

function parseTarget(body: Record<string, unknown>): {
  repo: string;
  num: number;
  kind: GhTargetKind;
} {
  const repo = typeof body.repo === "string" ? body.repo : "";
  const num = typeof body.num === "number" ? body.num : NaN;
  const kind = body.kind;
  if (!REPO_RE.test(repo) || repo.split("/").some((seg) => DOTS_ONLY_RE.test(seg)))
    throw new ValidationError("repo must be owner/name.", { code: "invalid_repo" });
  if (!Number.isSafeInteger(num) || num < 1)
    throw new ValidationError("num must be a positive integer.");
  if (kind !== "pull" && kind !== "issues")
    throw new ValidationError('kind must be "pull" or "issues".');
  return { repo, num, kind };
}

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

export const githubComment = new Hono<WorkspaceVars>().post(
  "/comment",
  writeRateLimit,
  requireScope("files:read"),
  async (c) => {
    const target = parseTarget(await jsonBody(c));
    const workspaceName = c.get("workspaceName");

    // App-configuration/installation checks come before the cross-tenant
    // gate: they're unconditionally true facts about `target.repo` (not
    // gated on who's asking), and surfacing them first keeps the more
    // specific `not_installed`/`app_unconfigured` reasons from being masked
    // by a generic `not_authorized` when a repo is simply not reachable yet
    // by any workspace.
    const cfg = githubAppConfig(c.env);
    if (!cfg) return c.json({ posted: false, reason: "app_unconfigured" });
    const installId = await installationForRepo(c.env, cfg, target.repo);
    if (installId === null) return c.json({ posted: false, reason: "not_installed" });

    const decline = await checkRepoAuthorization(
      c.env,
      target.repo,
      workspaceName,
      c.get("mintingUserId"),
      installId,
    );
    if (decline) return c.json(decline);

    const gathered = await gatherCommentBody(
      c.env,
      c.get("workspace"),
      c.get("workspaceName"),
      target,
    );
    if (gathered.skip) return c.json({ posted: true, action: "skipped", count: 0 });

    const result = await upsertBotComment(
      c.env,
      cfg,
      installId,
      target,
      gathered.body,
      c.get("workspaceName"),
    );
    if ("degrade" in result) {
      // A 403 means the App is installed but lacks Issues/PR write (pending org
      // approval). Enrich that one reason with actionable guidance so the CLI
      // can tell the user instead of silently falling back to gh. Mirrors the
      // IntegrationAuthorizationError vocabulary (@uploads/errors) for the soft,
      // never-5xx decline path.
      if (result.degrade === "forbidden") return c.json(forbiddenDecline(target.repo, installId));
      return c.json({ posted: false, reason: result.degrade });
    }

    // Implicit claim (phase 3): the comment actually posted, so this
    // workspace has proven authenticated write access to this repo's
    // PR/issue thread — best-effort record it as the repo's bound workspace.
    // First-claim-wins (recordRepoLink) and never affects this response.
    await recordRepoLink(c.env.DB, target.repo, c.get("workspaceName"), "comment", installId);

    return c.json({
      posted: true,
      action: result.action,
      count: gathered.count,
      commentUrl: result.commentUrl,
    });
  },
);
