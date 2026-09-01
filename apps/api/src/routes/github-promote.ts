/**
 * POST /v1/:workspace/github/promote (phase 2a). Workspace-authed. Copies the
 * calling workspace's own branch-staged attachments
 * (`gh/<owner>/<name>/branch/<branch>/<filename>`) into the target PR's
 * stable attachment prefix (`gh/<owner>/<name>/pull/<num>/<filename>`) so the
 * managed-comment gatherer (routes/github-comment.ts) picks them up
 * unchanged. Pure workspace-data operation — no GitHub API call, no
 * installation lookup. See github-promote.ts for the copy logic.
 */
import { ValidationError } from "@uploads/errors";
import { Hono, type Context } from "hono";
import { postPromoteBranchAttachments } from "../github-promote-service";
import { writeRateLimit } from "../guards";
import { requireScope, type WorkspaceVars } from "../workspace";
import { validateBranch, validateRepo } from "./github-target-validation";
import { jsonBody } from "./json-body";

interface PromoteBody {
  repo: string;
  num: number;
  /** Caller-selected source branch; it does not need to match the PR's current head ref. */
  branch: string;
}

function parseBody(body: Record<string, unknown>): PromoteBody {
  const repo = validateRepo(body.repo);
  const num = typeof body.num === "number" ? body.num : NaN;
  if (!Number.isSafeInteger(num) || num < 1) {
    throw new ValidationError("num must be a positive integer.");
  }
  return { repo, num, branch: validateBranch(body.branch) };
}

/**
 * Handler body (issue #613 phase 3): extracted to a named function so the
 * canonical dual-auth vertical (`routes/workspace-github.ts`) can reuse it
 * verbatim — same pattern as `githubCommentHandler` above.
 */
export async function githubPromoteHandler(c: Context<WorkspaceVars>) {
  const target = parseBody(await jsonBody(c));
  const workspaceName = c.get("workspaceName");
  // Promote + gated claim live in github-promote-service so the hosted MCP
  // promote tool reuses the same path (no drift with this route).
  const result = await postPromoteBranchAttachments(
    c.env,
    c.get("workspace"),
    workspaceName,
    c.get("mintingUserId"),
    target,
  );
  return c.json(result);
}

export const githubPromote = new Hono<WorkspaceVars>().post(
  "/promote",
  writeRateLimit,
  requireScope("files:write"),
  githubPromoteHandler,
);
