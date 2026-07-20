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
    const cfg = githubAppConfig(c.env);
    if (!cfg) return c.json({ posted: false, reason: "app_unconfigured" });
    const installId = await installationForRepo(c.env, cfg, target.repo);
    if (installId === null) return c.json({ posted: false, reason: "not_installed" });

    const gathered = await gatherCommentBody(
      c.env,
      c.get("workspace"),
      c.get("workspaceName"),
      target,
    );
    if (gathered.skip) return c.json({ posted: true, action: "skipped", count: 0 });

    const result = await upsertBotComment(c.env, cfg, installId, target, gathered.body);
    if ("degrade" in result) {
      // A 403 means the App is installed but lacks Issues/PR write (pending org
      // approval). Enrich that one reason with actionable guidance so the CLI
      // can tell the user instead of silently falling back to gh. Mirrors the
      // IntegrationAuthorizationError vocabulary (@uploads/errors) for the soft,
      // never-5xx decline path.
      if (result.degrade === "forbidden") return c.json(forbiddenDecline(target.repo, installId));
      return c.json({ posted: false, reason: result.degrade });
    }
    return c.json({
      posted: true,
      action: result.action,
      count: gathered.count,
      commentUrl: result.commentUrl,
    });
  },
);
