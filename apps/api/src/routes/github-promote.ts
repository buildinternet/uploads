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
import { Hono } from "hono";
import { promoteBranchAttachments } from "../github-promote";
import { recordRepoLink } from "../github-repo-links";
import { writeRateLimit } from "../guards";
import { requireScope, type WorkspaceVars } from "../workspace";
import { jsonBody } from "./json-body";

// Same repo grammar as routes/github-comment.ts's parseTarget, plus the same
// dot-only-segment guard (this repo string ends up interpolated into R2 key
// segments here, not a GitHub API path, but the same traversal-shaped input
// is worth rejecting up front).
const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const DOTS_ONLY_RE = /^\.+$/;

// Printable ASCII only, matching file-metadata.ts's META_VALUE_MAX/VALUE_SAFE_RE
// — the branch name is stored verbatim as the `gh.branch` D1 metadata value.
const BRANCH_VALUE_RE = /^[\x20-\x7E]+$/;
const BRANCH_VALUE_MAX = 512;

interface PromoteBody {
  repo: string;
  num: number;
  branch: string;
}

function parseBody(body: Record<string, unknown>): PromoteBody {
  const repo = typeof body.repo === "string" ? body.repo : "";
  const num = typeof body.num === "number" ? body.num : NaN;
  const branch = typeof body.branch === "string" ? body.branch : "";

  if (!REPO_RE.test(repo) || repo.split("/").some((seg) => DOTS_ONLY_RE.test(seg))) {
    throw new ValidationError("repo must be owner/name.", { code: "invalid_repo" });
  }
  if (!Number.isSafeInteger(num) || num < 1) {
    throw new ValidationError("num must be a positive integer.");
  }
  if (branch.length === 0 || branch.length > BRANCH_VALUE_MAX || !BRANCH_VALUE_RE.test(branch)) {
    throw new ValidationError("branch must be a non-empty printable-ASCII string.", {
      code: "invalid_branch",
    });
  }
  return { repo, num, branch };
}

export const githubPromote = new Hono<WorkspaceVars>().post(
  "/promote",
  writeRateLimit,
  requireScope("files:write"),
  async (c) => {
    const target = parseBody(await jsonBody(c));
    const result = await promoteBranchAttachments(
      c.env,
      c.get("workspace"),
      c.get("workspaceName"),
      target,
    );

    // Implicit claim (phase 3): reaching a 2xx response means this workspace
    // has proven authenticated write access to this repo's branch-staged
    // attachments — best-effort record it as the repo's bound workspace.
    // First-claim-wins (recordRepoLink) and never affects this response.
    await recordRepoLink(c.env.DB, target.repo, c.get("workspaceName"), "promote");

    return c.json(result);
  },
);
