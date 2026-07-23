/**
 * POST /v1/:workspace/github/comment (phase 2 PR B). Workspace-authed. Renders
 * the calling workspace's own attachments + galleries for a PR/issue and, when
 * the App is installed with write, upserts the managed comment as the bot.
 * Never 5xxs on an integration failure — a bot-post problem returns
 * { posted: false, reason } so the CLI falls back to its local-gh path.
 *
 * The actual gather/check/upsert logic lives in `../github-comment-service`
 * (`postManagedComment`), shared with the hosted MCP server's `put`/`comment`
 * tools (issue #392) — this route is just the HTTP wrapper.
 */
import { ValidationError } from "@uploads/errors";
import { Hono } from "hono";
import { postManagedComment } from "../github-comment-service";
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
  resync: boolean;
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
  // Optional (older clients omit it): marks an explicit resync, which forces
  // the marker hunt + duplicate dedupe instead of the cached-id fast path
  // (issue #480).
  if (body.resync !== undefined && typeof body.resync !== "boolean")
    throw new ValidationError("resync must be a boolean.");
  return { repo, num, kind, resync: body.resync === true };
}

export const githubComment = new Hono<WorkspaceVars>().post(
  "/comment",
  writeRateLimit,
  requireScope("files:read"),
  async (c) => {
    const { resync, ...target } = parseTarget(await jsonBody(c));
    const result = await postManagedComment(
      c.env,
      c.get("workspace"),
      c.get("workspaceName"),
      c.get("mintingUserId"),
      target,
      { resync },
    );
    return c.json(result);
  },
);
