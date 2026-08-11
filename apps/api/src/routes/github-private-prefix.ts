/**
 * POST /v1/:workspace/github/private-prefix (issue #631). Workspace-authed,
 * same base path as `routes/github-comment.ts` — distinct sub-route
 * "/private-prefix". Resolves the GitHub-key mode (plain vs. randomized
 * private prefix) a caller should stage an attachment under for a repo.
 *
 * The decision logic lives in `../github-private-prefix-service`
 * (`resolveGhKeyContext`); this route is the HTTP wrapper plus the
 * `activePrefixIds` add-on (only surfaced to authorized callers — a `mode:
 * "private"` response already proves the caller passed the cross-tenant
 * gate, so no extra check is needed here). Never leaks ids or the existence
 * of privacy to an unauthorized/unknown caller: the `{ mode: "plain" }`
 * response is identical whether the repo is public, unlinked, or the
 * caller was declined.
 */
import { ValidationError } from "@uploads/errors";
import { Hono, type Context } from "hono";
import { resolveGhKeyContext, type ResolveGhKeyRequest } from "../github-private-prefix-service";
import { listActivePrefixIds } from "../github-private-prefixes";
import { writeRateLimit } from "../guards";
import { requireScope, type WorkspaceVars } from "../workspace";
import { jsonBody } from "./json-body";

// Same grammar as routes/github-comment.ts's REPO_RE/DOTS_ONLY_RE.
const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const DOTS_ONLY_RE = /^\.+$/;

function parseRequest(body: Record<string, unknown>): ResolveGhKeyRequest {
  const repo = typeof body.repo === "string" ? body.repo : "";
  if (!REPO_RE.test(repo) || repo.split("/").some((seg) => DOTS_ONLY_RE.test(seg)))
    throw new ValidationError("repo must be owner/name.", { code: "invalid_repo" });

  let branch: string | undefined;
  if (body.branch !== undefined) {
    if (typeof body.branch !== "string") throw new ValidationError("branch must be a string.");
    branch = body.branch;
  }

  let target: ResolveGhKeyRequest["target"];
  if (body.target !== undefined) {
    if (typeof body.target !== "object" || body.target === null || Array.isArray(body.target))
      throw new ValidationError("target must be an object.");
    const t = body.target as Record<string, unknown>;
    if (t.kind !== "pull" && t.kind !== "issues")
      throw new ValidationError('target.kind must be "pull" or "issues".');
    if (!Number.isSafeInteger(t.num) || (t.num as number) < 1)
      throw new ValidationError("target.num must be a positive integer.");
    target = { kind: t.kind, num: t.num as number };
  }

  return { repo, branch, target };
}

export async function githubPrivatePrefixHandler(c: Context<WorkspaceVars>) {
  const req = parseRequest(await jsonBody(c));
  const result = await resolveGhKeyContext(
    c.env,
    c.get("workspaceName"),
    c.get("mintingUserId"),
    req,
  );
  if (result.mode === "plain") return c.json({ mode: "plain" as const });
  const activePrefixIds = await listActivePrefixIds(c.env.DB, req.repo);
  return c.json({ mode: "private" as const, prefixId: result.prefixId, activePrefixIds });
}

export const githubPrivatePrefix = new Hono<WorkspaceVars>().post(
  "/private-prefix",
  writeRateLimit,
  requireScope("files:read"),
  githubPrivatePrefixHandler,
);
