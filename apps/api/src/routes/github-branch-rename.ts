/**
 * POST /v1/workspaces/:workspace/github/branch-rename (#920). Workspace-authed
 * (canonical dual-auth surface, mounted from `routes/workspace-github.ts`).
 * Registers one `old -> new` branch-name pair the CLI read out of the new
 * branch's reflog, so a later promote for `new` also sweeps everything staged
 * under `old`. Pure workspace-data write — no GitHub API call.
 *
 * Canonical-only, like `github/attach` (issue #702): this route is new, so it
 * has no legacy `/v1/:workspace/github/*` twin to preserve.
 */
import type { Context } from "hono";
import { dbFor } from "../db-session";
import { recordBranchRename, type BranchRenameRequest } from "../github-branch-renames";
import type { WorkspaceVars } from "../workspace";
import { validateBranch, validateRepo } from "./github-target-validation";
import { jsonBody } from "./json-body";

function parseBody(body: Record<string, unknown>): BranchRenameRequest {
  return {
    repo: validateRepo(body.repo),
    from: validateBranch(body.from, "from"),
    to: validateBranch(body.to, "to"),
  };
}

/**
 * Handler body extracted the same way `githubPromoteHandler` is, so the
 * canonical vertical mounts the function itself rather than a sub-router.
 * `recordBranchRename` throws `ValidationError` (`same_branch`) when `from`
 * and `to` differ only by case — that rule has one home, the access layer.
 */
export async function githubBranchRenameHandler(c: Context<WorkspaceVars>) {
  const { repo, from, to } = parseBody(await jsonBody(c));
  const result = await recordBranchRename(dbFor(c.env), {
    workspace: c.get("workspaceName"),
    repo,
    from,
    to,
    source: "cli-reflog",
  });
  return c.json(result);
}
