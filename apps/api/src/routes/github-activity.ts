/**
 * `/v1/:workspace/github/activity` (issue #338). Read-only feed of the
 * workspace's PRs that recently received media, backed by the
 * `github_pr_activity` rollup (see ../github-pr-activity.ts — upserted from
 * putObject whenever `gh.kind=pull` metadata lands). Strict read: a D1
 * failure surfaces as a 5xx rather than an empty-looking feed.
 */
import { ValidationError } from "@uploads/errors";
import { Hono, type Context } from "hono";
import { listPrActivityForWorkspace } from "../github-pr-activity";
import { requireScope, type WorkspaceVars } from "../workspace";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

function parseLimit(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_LIMIT;
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new ValidationError(`limit must be an integer between 1 and ${MAX_LIMIT}.`, {
      code: "invalid_limit",
    });
  }
  return limit;
}

/**
 * Handler body (issue #613 phase 3): extracted to a named function so the
 * canonical dual-auth vertical (`routes/workspace-github.ts`) can reuse it
 * verbatim — same pattern as the other four GitHub sub-routers.
 */
export async function githubActivityHandler(c: Context<WorkspaceVars>) {
  const limit = parseLimit(c.req.query("limit"));
  const workspaceName = c.get("workspaceName");
  const activity = await listPrActivityForWorkspace(c.env.DB, workspaceName, limit);
  return c.json({ workspace: workspaceName, activity });
}

export const githubActivity = new Hono<WorkspaceVars>().get(
  "/activity",
  requireScope("files:read"),
  githubActivityHandler,
);
