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
import { Hono, type Context } from "hono";
import { postManagedComment } from "../github-comment-service";
import type { GhTargetKind } from "../github-comment-render";
import { writeRateLimit } from "../guards";
import { requireScope, type WorkspaceVars } from "../workspace";
import { validateRepo } from "./github-target-validation";
import { jsonBody } from "./json-body";

function parseTarget(body: Record<string, unknown>): {
  repo: string;
  num: number;
  kind: GhTargetKind;
  resync: boolean;
} {
  // Shared owner/name grammar + dot-only-segment guard (routes/github-target-validation.ts):
  // this repo string is interpolated into a server-side api.github.com path,
  // where "../" would traverse.
  const repo = validateRepo(body.repo);
  const num = typeof body.num === "number" ? body.num : NaN;
  const kind = body.kind;
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

/**
 * Handler body (issue #613 phase 3): extracted to a named function so the
 * canonical dual-auth vertical (`routes/workspace-github.ts`) can reuse it
 * verbatim instead of copy-pasting — same "response shape can't drift"
 * guarantee `routes/workspace-galleries.ts` established for phase 2. The old
 * bearer path below keeps its own `requireScope("files:read")` UNCHANGED
 * (issue #613 flags this as a wart — a write op scoped as a read — but the
 * fix only applies to the canonical surface, see workspace-github.ts).
 */
export async function githubCommentHandler(c: Context<WorkspaceVars>) {
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
}

export const githubComment = new Hono<WorkspaceVars>().post(
  "/comment",
  writeRateLimit,
  requireScope("files:read"),
  githubCommentHandler,
);
