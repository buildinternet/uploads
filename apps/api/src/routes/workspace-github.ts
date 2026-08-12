/**
 * Canonical GitHub vertical (issue #613 phase 3): `/:workspace/github/*`,
 * mounted at `/v1/workspaces` in `index.ts` so its public paths are
 * `/v1/workspaces/:workspace/github/*`. Dual-auth (`dualWorkspaceAuth`) —
 * either a session cookie or a bearer token reaches the same handlers below.
 *
 * Collapses the six sub-routers previously mounted separately at
 * `/v1/:workspace/github` (`github-comment.ts`, `github-promote.ts`,
 * `github-link.ts`, `github-health.ts`, `github-activity.ts`,
 * `github-private-prefix.ts`) into one router — issue #613 names "five
 * separate sub-routers sharing one mount prefix" as its own wart, on top of
 * the missing dual-auth surface (issue #631's `private-prefix` route landed
 * after that count and joins the canonical vertical here on the same terms).
 * Handler bodies are the exact same functions those old routers call
 * (extracted to named exports there), same "response shape can't drift"
 * guarantee phase 2 established for galleries. The old bearer paths at
 * `/v1/:workspace/github/*` are UNCHANGED — still six separate `.route()`
 * mounts in `index.ts`, still calling the same handler functions with their
 * own pre-existing scope requirements.
 *
 * Authorization posture per route (issue #613 phase 3 plan,
 * `.context/613-api-consolidation-plan.md`, "github" section):
 *  - `comment`/`promote`/`private-prefix`/`private-prefix/rotate` (POST,
 *    mutating + GitHub-API-calling/bot-posting or D1/R2-mutating): token-only
 *    on this canonical surface. A session caller who is a member gets a 403
 *    `github_requires_token` — mirrors `workspace-usage.ts`'s
 *    `requireToken`/`usage_requires_token` guard exactly (membership already
 *    proven by `dualWorkspaceAuth`, so refusal here is "not allowed", not
 *    "doesn't exist"). Canonical `comment` requires `files:write` (NOT the
 *    old path's `files:read` — issue #613 flags a write op scoped as a read
 *    as a wart; fixed here, left untouched on the old bearer path).
 *    `private-prefix`/`private-prefix/rotate` already require `files:write`
 *    on the old bearer path too (issue #631) — no scope change here, just
 *    the same token-only posture as their `comment`/`promote` siblings.
 *  - `link` (GET/POST/DELETE)/`repo-link` (GET)/`health` (GET)/`activity`
 *    (GET): dual-auth with a session-admin-tier gate layered on top
 *    (`requireSessionAdmin`, `../dual-workspace-auth.ts`) — bearer keeps
 *    whatever scope the old path already required; a session caller must be
 *    workspace admin/owner (matching `routes/me.ts`'s `adminWorkspaceOr403`
 *    posture for the pre-existing admin-gated `GET
 *    /me/workspaces/:name/repo-links`). Non-member session -> 404 (from
 *    `dualWorkspaceAuth`); member-but-not-admin -> 403
 *    `workspace_admin_required`.
 *
 *  - `titles`/`status` (GET, issue #613 final phase): session-only,
 *    member-tier. A bearer 403s `github_requires_session` — no bearer
 *    capability exists for either read today and this PR mints none (giving
 *    a workspace token access to batch title resolution or install status
 *    would be a new capability, out of scope). Moved verbatim from
 *    `routes/me.ts`; `/me` now forwards.
 *  - `repo-links` (GET, issue #613 final phase): session-only, admin/owner
 *    tier, its own coded error (`github_repo_links_requires_session`) since
 *    it's a stricter tier than `titles`/`status` above. Its stripped
 *    `{repos: string[]}` projection is kept EXACTLY as-is — deliberately
 *    distinct from the dual-auth `linkResponse` shape at `GET
 *    /:workspace/github/repo-link` (singular, `{repo, linked, workspace,
 *    source, createdAt}`) above, so this is a new route at a new path, not a
 *    reuse of that one. Moved verbatim from `routes/me.ts`; `/me` now
 *    forwards.
 */
import { ForbiddenError, NotFoundError, ValidationError } from "@uploads/errors";
import { Hono, type Context, type Handler, type MiddlewareHandler } from "hono";
import {
  dualWorkspaceAuth,
  hasPreresolvedSession,
  requireSessionAdmin,
  resolveSessionUserId,
  type DualAuthVars,
} from "../dual-workspace-auth";
import { parseExternalReference } from "../external-references";
import { respondError } from "../error-response";
import { githubInstallStatus, type GithubInstallStatus } from "../github-install-status";
import { reconcileIngestTarget } from "../github-ingest";
import { deriveRepoBinding, findRepoLink, listRepoLinksForWorkspace } from "../github-repo-links";
import { resolveTitles } from "../github-titles";
import { writeRateLimit } from "../guards";
import { adminWorkspaceOr403, memberWorkspaceOr404 } from "../org-workspaces";
import type { SessionVars } from "../session-auth";
import { requireScope } from "../workspace";
import { githubActivityHandler } from "./github-activity";
import { githubCommentHandler } from "./github-comment";
import {
  githubLinkDeleteHandler,
  githubLinkGetHandler,
  githubLinkPostHandler,
  githubRepoLinkGetHandler,
} from "./github-link";
import { githubHealthHandler } from "./github-health";
import {
  githubPrivatePrefixHandler,
  githubPrivatePrefixRotateHandler,
} from "./github-private-prefix";
import { githubPromoteHandler } from "./github-promote";

// Same owner/name grammar as routes/github-comment.ts's `REPO_RE` — repeated
// here rather than imported since that copy is module-private (deliberately
// not exported to avoid coupling this handler to that route's file).
const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/**
 * POST /:workspace/github/ingest (Task 6, manual/backfill entry point). Dual-
 * auth, `files:write`-scoped, rate-limited — unlike `comment`/`promote` this
 * is NOT token-only, since it doesn't post to GitHub on the caller's behalf.
 *
 * Deliberately bypasses the `ingestGithubAttachments` per-repo/per-workspace
 * knob (`reconcileIngestTarget` doesn't consult it) — an explicit manual
 * ingest is opt-in by construction, same reasoning as a manual backfill
 * command ignoring an automation on/off switch.
 *
 * `reconcileIngestTarget` throws `NotFoundError` (`code:
 * "github_app_not_installed"`) when the GitHub App isn't configured or isn't
 * installed on the repo — that's allowed to propagate here and maps to a 404
 * via `respondError`.
 */
const githubIngestHandler: Handler<DualAuthVars> = async (c) => {
  const ws = c.get("workspace");
  const workspaceName = c.get("workspaceName");
  const body = await c.req.json().catch(() => ({}));
  const repo = typeof body.repo === "string" ? body.repo : "";
  const pr = typeof body.pr === "number" ? body.pr : undefined;
  const issue = typeof body.issue === "number" ? body.issue : undefined;
  if (!REPO_RE.test(repo) || (pr === undefined) === (issue === undefined)) {
    throw new ValidationError("repo plus exactly one of pr or issue required", {
      code: "github_ingest_target",
    });
  }
  const link = await findRepoLink(c.env.DB, repo);
  if (deriveRepoBinding(link, workspaceName) !== "self") {
    // 404 (not 403) so an "other"-bound repo can't be told apart from an
    // unlinked one — never leaks whether/where it's linked (issue #398).
    throw new NotFoundError("repo is not linked to this workspace", { code: "repo_not_linked" });
  }
  const target = {
    repo,
    kind: pr !== undefined ? ("pull" as const) : ("issues" as const),
    num: (pr ?? issue) as number,
  };
  const summary = await reconcileIngestTarget(c.env, ws, workspaceName, target);
  return c.json({ repo: repo.toLowerCase(), kind: target.kind, num: target.num, ...summary });
};

// Same cross-cast pattern as `routes/workspace-galleries.ts`'s `scoped`:
// these helpers/handlers are typed against `WorkspaceVars`, a strict subset
// of this router's `DualAuthVars`, so a Context for one is always a valid
// Context for the other.
function scoped(scope: Parameters<typeof requireScope>[0]): MiddlewareHandler<DualAuthVars> {
  return requireScope(scope) as unknown as MiddlewareHandler<DualAuthVars>;
}
const rateLimited = writeRateLimit as unknown as MiddlewareHandler<DualAuthVars>;
const adminForSession = requireSessionAdmin();

/**
 * `comment`/`promote` are token-only on the canonical surface — see the
 * module docblock. Mirrors `workspace-usage.ts`'s `requireToken` exactly,
 * down to the error code convention (`<vertical>_requires_token`).
 */
const requireToken: MiddlewareHandler<DualAuthVars> = async (c, next) => {
  if (c.get("authSource") === "session") {
    throw new ForbiddenError("requires an API token", { code: "github_requires_token" });
  }
  await next();
};

/**
 * Session-only member gate for `titles`/`status` (issue #613 final phase):
 * mirrors `workspace-members.ts`'s `sessionMemberGate` and
 * `workspace-settings.ts`'s `sessionMemberGate` — a bearer `Authorization`
 * header 403s `github_requires_session` (neither route has a bearer analog
 * today and this PR mints none), otherwise resolves the session + membership
 * with a uniform 404 for non-members. A preset (`hasPreresolvedSession`,
 * e.g. a forwarded `/me` request) always wins over the bearer check, same
 * discrimination as every other session gate in this vertical migration.
 */
function sessionMemberGate(): MiddlewareHandler<DualAuthVars> {
  return async (c, next) => {
    if (!hasPreresolvedSession(c.req.raw) && c.req.header("Authorization")?.startsWith("Bearer ")) {
      throw new ForbiddenError("requires a session", { code: "github_requires_session" });
    }
    const userId = await resolveSessionUserId(c as unknown as Context<SessionVars>);
    const name = c.req.param("workspace") ?? "";
    if (!name) throw new NotFoundError("workspace not found", { code: "workspace_not_found" });
    await memberWorkspaceOr404(c.env, userId, name);
    await next();
  };
}

/**
 * Session-only admin/owner gate for `repo-links` (issue #613 final phase):
 * same bearer-403 posture as `sessionMemberGate` above, but its own coded
 * error (`github_repo_links_requires_session`) since it's a stricter
 * privilege tier than the member-gated routes in this same router —
 * mirrors `workspace-settings.ts`'s two-tier `sessionMemberGate`/
 * `sessionAdminGate` split. `adminWorkspaceOr403` produces the 404-then-403
 * ordering (non-member -> `workspace_not_found`, member-not-admin ->
 * `workspace_admin_required`), same as this route's pre-#613 `/me` handler.
 */
function sessionAdminGate(): MiddlewareHandler<DualAuthVars> {
  return async (c, next) => {
    if (!hasPreresolvedSession(c.req.raw) && c.req.header("Authorization")?.startsWith("Bearer ")) {
      throw new ForbiddenError("requires a session", {
        code: "github_repo_links_requires_session",
      });
    }
    const userId = await resolveSessionUserId(c as unknown as Context<SessionVars>);
    const name = c.req.param("workspace") ?? "";
    if (!name) throw new NotFoundError("workspace not found", { code: "workspace_not_found" });
    await adminWorkspaceOr403(c.env, userId, name);
    await next();
  };
}

/**
 * `GET /:workspace/github/titles` — batch PR/issue titles for the
 * connected-work rail (issue #267), moved verbatim from `routes/me.ts`
 * (issue #613 final phase). Member-gated: title text for private repos is
 * sensitive, and membership scoping keeps this from becoming a public title
 * oracle for whatever repos the App can read. Per-ref failures are nulls —
 * the endpoint never fails the batch wholesale.
 */
const githubTitlesHandler: Handler<DualAuthVars> = async (c) => {
  const raw = (c.req.query("refs") ?? "").split(",").filter((s) => s.length > 0);
  if (raw.length === 0) {
    throw new ValidationError("refs query parameter required", { code: "refs_required" });
  }
  if (raw.length > 20) {
    throw new ValidationError("at most 20 refs per request", { code: "too_many_refs" });
  }
  const normalized = raw.map((coordinate) => {
    const parsed = parseExternalReference("github", coordinate);
    if (!parsed.ok) {
      throw new ValidationError(`invalid ref: ${coordinate}`, { code: "invalid_ref" });
    }
    // normalizedKey carries a `github:item:` provider prefix — the gh.ref
    // metadata shape (and this response's keys) is bare `owner/repo#number`,
    // so derive it from the locator instead.
    const { owner, repository, number } = parsed.value.locator;
    return `${owner}/${repository}#${number}`;
  });

  const titles = await resolveTitles(c.env, [...new Set(normalized)]);
  return c.json({ refs: titles });
};

/**
 * `GET /:workspace/github/status` — whether this workspace already has the
 * GitHub App installed (issue #492), moved verbatim from `routes/me.ts`
 * (issue #613 final phase). Member-gated like `titles`: the answer is
 * derived from the workspace's repo bindings, which aren't public. Never
 * fails — see `githubInstallStatus` for the degrade-to-false rule.
 */
const githubStatusHandler: Handler<DualAuthVars> = async (c) => {
  const name = c.req.param("workspace") ?? "";
  return c.json<GithubInstallStatus>(await githubInstallStatus(c.env, name));
};

/**
 * `GET /:workspace/github/repo-links` — repos this workspace has linked
 * (issue #307, Task 7), moved verbatim from `routes/me.ts` (issue #613 final
 * phase). Admin/owner-gated — same audience as the comment-settings/preview
 * routes: whoever can edit the defaults is whoever should see which repos
 * they apply to. Repo names only: trimmed projection, distinct from the
 * dual-auth `linkResponse` shape at `GET /:workspace/github/repo-link`
 * (singular) above — deliberately not aliased to that route (see the module
 * docblock's `/me/workspaces/:name/repo-links` note).
 */
const githubRepoLinksHandler: Handler<DualAuthVars> = async (c) => {
  const name = c.req.param("workspace") ?? "";
  const links = await listRepoLinksForWorkspace(c.env.DB, name);
  return c.json({ repos: links.map((link) => link.repo) });
};

export const workspaceGithub = new Hono<DualAuthVars>()
  .post(
    "/:workspace/github/comment",
    dualWorkspaceAuth(),
    rateLimited,
    // Canonical wart fix (issue #613): this is a write op, scoped as such
    // here. The old bearer path keeps `files:read` untouched — see
    // `routes/github-comment.ts`.
    scoped("files:write"),
    requireToken,
    githubCommentHandler as unknown as MiddlewareHandler<DualAuthVars>,
  )
  .post(
    "/:workspace/github/promote",
    dualWorkspaceAuth(),
    rateLimited,
    scoped("files:write"),
    requireToken,
    githubPromoteHandler as unknown as MiddlewareHandler<DualAuthVars>,
  )
  .post(
    "/:workspace/github/private-prefix",
    dualWorkspaceAuth(),
    rateLimited,
    scoped("files:write"),
    requireToken,
    githubPrivatePrefixHandler as unknown as MiddlewareHandler<DualAuthVars>,
  )
  .post(
    "/:workspace/github/private-prefix/rotate",
    dualWorkspaceAuth(),
    rateLimited,
    scoped("files:write"),
    requireToken,
    githubPrivatePrefixRotateHandler as unknown as MiddlewareHandler<DualAuthVars>,
  )
  .get(
    "/:workspace/github/link",
    dualWorkspaceAuth(),
    scoped("files:read"),
    adminForSession,
    githubLinkGetHandler as unknown as MiddlewareHandler<DualAuthVars>,
  )
  .get(
    "/:workspace/github/repo-link",
    dualWorkspaceAuth(),
    scoped("files:read"),
    adminForSession,
    githubRepoLinkGetHandler as unknown as MiddlewareHandler<DualAuthVars>,
  )
  .post(
    "/:workspace/github/link",
    dualWorkspaceAuth(),
    rateLimited,
    scoped("files:write"),
    adminForSession,
    githubLinkPostHandler as unknown as MiddlewareHandler<DualAuthVars>,
  )
  .delete(
    "/:workspace/github/link",
    dualWorkspaceAuth(),
    rateLimited,
    scoped("files:write"),
    adminForSession,
    githubLinkDeleteHandler as unknown as MiddlewareHandler<DualAuthVars>,
  )
  .get(
    "/:workspace/github/health",
    dualWorkspaceAuth(),
    scoped("files:read"),
    adminForSession,
    githubHealthHandler as unknown as MiddlewareHandler<DualAuthVars>,
  )
  .get(
    "/:workspace/github/activity",
    dualWorkspaceAuth(),
    scoped("files:read"),
    adminForSession,
    githubActivityHandler as unknown as MiddlewareHandler<DualAuthVars>,
  )
  .post(
    "/:workspace/github/ingest",
    dualWorkspaceAuth(),
    rateLimited,
    scoped("files:write"),
    githubIngestHandler,
  )
  // Issue #613 final phase: session-only routes moved verbatim from
  // `routes/me.ts` — see each handler's docblock and the module docblock's
  // updated posture note.
  .get("/:workspace/github/titles", sessionMemberGate(), githubTitlesHandler)
  .get("/:workspace/github/status", sessionMemberGate(), githubStatusHandler)
  .get("/:workspace/github/repo-links", sessionAdminGate(), githubRepoLinksHandler)
  // `.fetch()`-ed directly by `routes/me.ts`'s `forwardToWorkspaceGithub`
  // (issue #613 final phase, `titles`/`status` — see the module docblock's
  // repo-links note for why `repo-links` itself is NOT aliased), so this
  // needs its own error boundary the same way `workspace-files.ts` does.
  .onError((err, c) => respondError(c, err));
