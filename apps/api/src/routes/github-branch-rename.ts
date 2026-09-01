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
import { ValidationError } from "@uploads/errors";
import type { Context } from "hono";
import { dbFor } from "../db-session";
import { recordBranchRename, type BranchRenameRequest } from "../github-branch-renames";
import type { WorkspaceVars } from "../workspace";
import { jsonBody } from "./json-body";

// Same repo grammar + dot-only-segment guard as github-promote.ts.
const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const DOTS_ONLY_RE = /^\.+$/;

// Same branch validation as github-promote.ts: printable ASCII, ≤512 — the
// name ends up in R2 key segments and `gh.branch` metadata values.
const BRANCH_VALUE_RE = /^[\x20-\x7E]+$/;
const BRANCH_VALUE_MAX = 512;

function isValidBranch(branch: string): boolean {
  return branch.length > 0 && branch.length <= BRANCH_VALUE_MAX && BRANCH_VALUE_RE.test(branch);
}

function parseBody(body: Record<string, unknown>): BranchRenameRequest {
  const repo = typeof body.repo === "string" ? body.repo : "";
  const from = typeof body.from === "string" ? body.from : "";
  const to = typeof body.to === "string" ? body.to : "";

  if (!REPO_RE.test(repo) || repo.split("/").some((seg) => DOTS_ONLY_RE.test(seg))) {
    throw new ValidationError("repo must be owner/name.", { code: "invalid_repo" });
  }
  if (!isValidBranch(from) || !isValidBranch(to)) {
    throw new ValidationError("from and to must be non-empty printable-ASCII strings.", {
      code: "invalid_branch",
    });
  }
  return { repo, from, to };
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
