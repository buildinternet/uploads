/**
 * `/v1/:workspace/github/link` (phase 4b). Explicit claim/inspect for the
 * workspace<->repo binding (`github_repo_links`, see ../github-repo-links.ts)
 * that has, until now, only ever been created implicitly as a side effect of
 * a successful `/github/comment` or `/github/promote` call. Same
 * first-claim-wins semantics as those implicit claims: `recordRepoLink` is
 * `INSERT OR IGNORE`, so a POST from a workspace that doesn't already own the
 * binding never steals it — the response reports who actually owns it
 * (`claimed: false`, `owner`) rather than silently pretending to succeed.
 */
import { ValidationError, ForbiddenError } from "@uploads/errors";
import { Hono } from "hono";
import {
  deleteRepoLinkForWorkspace,
  findRepoLink,
  findRepoLinkStrict,
  recordRepoLink,
  type RepoLink,
} from "../github-repo-links";
import { writeRateLimit } from "../guards";
import { requireScope, type WorkspaceVars } from "../workspace";
import { jsonBody } from "./json-body";

// Same owner/name grammar + dot-only-segment guard as routes/github-comment.ts's
// parseTarget (this repo string is looked up/stored, not interpolated into an
// api.github.com path here, but the same shape is worth validating consistently).
const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const DOTS_ONLY_RE = /^\.+$/;

function parseRepo(repo: unknown): string {
  if (
    typeof repo !== "string" ||
    !REPO_RE.test(repo) ||
    repo.split("/").some((seg) => DOTS_ONLY_RE.test(seg))
  ) {
    throw new ValidationError("repo must be owner/name.", { code: "invalid_repo" });
  }
  return repo;
}

function linkResponse(repo: string, link: RepoLink | null) {
  return {
    repo,
    linked: link !== null,
    workspace: link?.workspaceName ?? null,
    source: link?.source ?? null,
    createdAt: link?.createdAt ?? null,
  };
}

export const githubLink = new Hono<WorkspaceVars>()
  .get("/link", requireScope("files:read"), async (c) => {
    const repo = parseRepo(c.req.query("repo"));
    const link = await findRepoLink(c.env.DB, repo);
    return c.json(linkResponse(repo, link));
  })
  .post("/link", writeRateLimit, requireScope("files:write"), async (c) => {
    const repo = parseRepo((await jsonBody(c)).repo);
    const workspaceName = c.get("workspaceName");

    const before = await findRepoLink(c.env.DB, repo);
    if (before) {
      // Already bound — honestly report the owner rather than claiming
      // success. First-claim-wins: this call never overwrites it, whether
      // the owner is this workspace or another one.
      return c.json({
        claimed: before.workspaceName === workspaceName,
        ...linkResponse(repo, before),
      });
    }

    await recordRepoLink(c.env.DB, repo, workspaceName, "cli");
    const after = await findRepoLink(c.env.DB, repo);
    return c.json({
      claimed: after?.workspaceName === workspaceName,
      ...linkResponse(repo, after),
    });
  })
  // Self-serve unlink (issue #318): a workspace can only remove a binding it
  // owns — this never lets one workspace unclaim another's repo. Use the
  // admin-gated route (routes/admin-ui.ts) to reassign or remove someone
  // else's stuck/abandoned binding.
  .delete("/link", writeRateLimit, requireScope("files:write"), async (c) => {
    const repo = parseRepo(c.req.query("repo"));
    const workspaceName = c.get("workspaceName");

    // Strict lookup: unlike the GET/POST handlers above (where a D1 blip
    // degrading to "unclaimed" is an acceptable inspect-only fallback), a
    // D1 read failure here must surface as a 5xx, not silently report
    // `{unlinked: false, reason: "not_linked"}` (CodeRabbit, issue #318).
    const before = await findRepoLinkStrict(c.env.DB, repo);
    if (!before) {
      return c.json({ repo, unlinked: false, reason: "not_linked" as const });
    }
    if (before.workspaceName !== workspaceName) {
      throw new ForbiddenError(
        `${repo} is bound to a different workspace ("${before.workspaceName}") — ask an operator to reassign it`,
        { code: "not_link_owner" },
      );
    }
    const removed = await deleteRepoLinkForWorkspace(c.env.DB, repo, workspaceName);
    return c.json({ repo, unlinked: removed });
  });
