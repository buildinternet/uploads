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
    // "" is the repo-level sentinel `resolveGhKeyContext`/`getOrMintPrefixId`
    // use internally for issues/branch-less targets (see
    // github-private-prefixes.ts's module doc) — it must stay
    // server-derived, never caller-supplied, or a client could collide two
    // logically distinct scopes (an explicit "no branch" vs. a real branch
    // literally named "") onto the same minted prefix id.
    if (body.branch === "") throw new ValidationError("branch must not be empty.");
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
  // Best-effort: `activePrefixIds` is a convenience add-on for the CLI
  // gh-fallback comment gather, not load-bearing for the mode the caller
  // just resolved. A transient D1 failure here must not turn an otherwise-
  // successful resolve into a 500 (same fail-open posture as
  // `resolveGhKeyContext` itself) — degrade to an empty list instead.
  let activePrefixIds: string[] = [];
  try {
    activePrefixIds = await listActivePrefixIds(c.env.DB, req.repo);
  } catch (err) {
    console.error(
      JSON.stringify({
        message: "private-prefix: listActivePrefixIds failed, degrading to empty list",
        repo: req.repo,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
  return c.json({ mode: "private" as const, prefixId: result.prefixId, activePrefixIds });
}

export const githubPrivatePrefix = new Hono<WorkspaceVars>().post(
  "/private-prefix",
  writeRateLimit,
  // files:write, not files:read (CodeRabbit-style review finding): the
  // private path mints a `github_private_prefixes` row (a real mutation),
  // and this resolve call sits in the same upload flow as `PUT
  // /:workspace/files/:key`, which itself requires files:write
  // (routes/files.ts) — match that, unlike `routes/github-comment.ts`'s
  // files:read (a deliberately-unfixed pre-existing wart on a route that
  // predates this one and never mints its own row on the read-scoped path).
  requireScope("files:write"),
  githubPrivatePrefixHandler,
);
