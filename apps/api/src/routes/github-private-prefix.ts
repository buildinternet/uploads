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
import {
  resolveGhKeyContext,
  rotatePrivatePrefix,
  type ResolveGhKeyRequest,
} from "../github-private-prefix-service";
import {
  listActivePrefixIds,
  listBranchPrefixIds,
  listPrefixIdsForTarget,
} from "../github-private-prefixes";
import { writeRateLimit } from "../guards";
import { requireScope, type WorkspaceVars } from "../workspace";
import { jsonBody } from "./json-body";
import { dbFor } from "../db-session";
import { mintingUserIdOf } from "../uploader-identity";

// Same grammar as routes/github-comment.ts's REPO_RE/DOTS_ONLY_RE.
const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const DOTS_ONLY_RE = /^\.+$/;

/** Shared `repo` shape validation for both request bodies below: `owner/name`, no dots-only segment. */
function validateRepoShape(body: Record<string, unknown>): string {
  const repo = typeof body.repo === "string" ? body.repo : "";
  if (!REPO_RE.test(repo) || repo.split("/").some((seg) => DOTS_ONLY_RE.test(seg)))
    throw new ValidationError("repo must be owner/name.", { code: "invalid_repo" });
  return repo;
}

function parseRequest(body: Record<string, unknown>): ResolveGhKeyRequest {
  const repo = validateRepoShape(body);

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
    mintingUserIdOf(c.get("uploaderIdentity")),
    req,
  );
  if (result.mode === "plain") return c.json({ mode: "plain" as const });
  // Best-effort: `activePrefixIds` is a convenience add-on for the CLI
  // gh-fallback comment gather, not load-bearing for the mode the caller
  // just resolved. A transient D1 failure here must not turn an otherwise-
  // successful resolve into a 500 (same fail-open posture as
  // `resolveGhKeyContext` itself). Degrade to the id just resolved — an
  // empty list makes installed CLIs skip the private prefix entirely
  // (`activePrefixIds ?? [prefixId]` does not treat `[]` as missing).
  //
  // A branch with no target is what `uploads staged` resolves. The private
  // staged key drops the branch name (`gh/private/<id>/branch/<file>`), and
  // the id is per branch, so a repo-wide id list mixes every branch's files
  // (issue #1122). `branchPrefixIds` and `activePrefixIds` are both that
  // branch only (active id, then retired ids). Installed CLIs read
  // `activePrefixIds`; newer ones prefer `branchPrefixIds` and ignore a
  // repo-wide `activePrefixIds` from an older worker.
  const db = dbFor(c.env);
  let activePrefixIds: string[] = [result.prefixId];
  let branchPrefixIds: string[] | undefined;
  try {
    if (req.target) {
      // Only the prefixes that can hold that target's objects (issue #934).
      // The CLI's fallback gather lists each id it gets back, so a repo-wide
      // list here fanned out one R2 list per branch.
      activePrefixIds = await listPrefixIdsForTarget(
        db,
        c.get("workspaceName"),
        req.repo,
        req.target,
        {
          headBranch: req.branch,
        },
      );
    } else if (req.branch !== undefined) {
      branchPrefixIds = await listBranchPrefixIds(db, req.repo, req.branch, result.prefixId);
      activePrefixIds = branchPrefixIds;
    } else {
      // No branch and no target: the repo-level sentinel. Issue attachments
      // and branch-less callers still need every active id.
      activePrefixIds = await listActivePrefixIds(db, req.repo);
    }
  } catch (err) {
    console.error(
      JSON.stringify({
        message: "private-prefix: listing prefix ids failed, degrading to the resolved id",
        repo: req.repo,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    activePrefixIds = [result.prefixId];
    if (req.branch !== undefined && req.target === undefined) branchPrefixIds = activePrefixIds;
  }
  return c.json({
    mode: "private" as const,
    prefixId: result.prefixId,
    activePrefixIds,
    ...(branchPrefixIds ? { branchPrefixIds } : {}),
  });
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

interface RotateRequest {
  repo: string;
  /** "" is the repo-level sentinel (`repoLevel: true`), same meaning as
   * `resolveGhKeyContext`'s internal branch="" — but here it's expressed as
   * an explicit boolean rather than an empty string, so a caller can't
   * silently trip the same "branch must not be empty" guard the resolve
   * route uses to keep the sentinel server-internal. */
  branch: string;
}

function parseRotateRequest(body: Record<string, unknown>): RotateRequest {
  const repo = validateRepoShape(body);

  const repoLevel = body.repoLevel === true;
  const hasBranch = body.branch !== undefined;
  if (repoLevel && hasBranch) {
    throw new ValidationError("pass either branch or repoLevel, not both.");
  }
  if (!repoLevel && !hasBranch) {
    throw new ValidationError("branch or repoLevel is required.");
  }
  if (repoLevel) return { repo, branch: "" };

  if (typeof body.branch !== "string" || body.branch === "") {
    throw new ValidationError("branch must be a non-empty string.");
  }
  return { repo, branch: body.branch };
}

export async function githubPrivatePrefixRotateHandler(c: Context<WorkspaceVars>) {
  const req = parseRotateRequest(await jsonBody(c));
  const result = await rotatePrivatePrefix(
    c.env,
    c.get("workspace"),
    c.get("workspaceName"),
    mintingUserIdOf(c.get("uploaderIdentity")),
    req.repo,
    req.branch,
  );
  return c.json(result);
}

githubPrivatePrefix.post(
  "/private-prefix/rotate",
  writeRateLimit,
  // files:write — rotation moves objects (copy+delete) and rewrites D1
  // rows, same mutation class as the resolve route above.
  requireScope("files:write"),
  githubPrivatePrefixRotateHandler,
);
