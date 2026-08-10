/**
 * Canonical GitHub vertical (issue #613 phase 3): `/:workspace/github/*`,
 * mounted at `/v1/workspaces` in `index.ts` so its public paths are
 * `/v1/workspaces/:workspace/github/*`. Dual-auth (`dualWorkspaceAuth`) —
 * either a session cookie or a bearer token reaches the same handlers below.
 *
 * Collapses the five sub-routers previously mounted separately at
 * `/v1/:workspace/github` (`github-comment.ts`, `github-promote.ts`,
 * `github-link.ts`, `github-health.ts`, `github-activity.ts`) into one
 * router — issue #613 names "five separate sub-routers sharing one mount
 * prefix" as its own wart, on top of the missing dual-auth surface. Handler
 * bodies are the exact same functions those old routers call (extracted to
 * named exports there), same "response shape can't drift" guarantee phase 2
 * established for galleries. The old bearer paths at
 * `/v1/:workspace/github/*` are UNCHANGED — still five separate `.route()`
 * mounts in `index.ts`, still calling the same handler functions with their
 * own pre-existing scope requirements.
 *
 * Authorization posture per route (issue #613 phase 3 plan,
 * `.context/613-api-consolidation-plan.md`, "github" section):
 *  - `comment`/`promote` (POST, mutating + GitHub-API-calling/bot-posting):
 *    token-only on this canonical surface. A session caller who is a member
 *    gets a 403 `github_requires_token` — mirrors `workspace-usage.ts`'s
 *    `requireToken`/`usage_requires_token` guard exactly (membership already
 *    proven by `dualWorkspaceAuth`, so refusal here is "not allowed", not
 *    "doesn't exist"). Canonical `comment` requires `files:write` (NOT the
 *    old path's `files:read` — issue #613 flags a write op scoped as a read
 *    as a wart; fixed here, left untouched on the old bearer path).
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
 * `GET /me/workspaces/:name/repo-links` is deliberately NOT forwarded/aliased
 * here — its stripped `{repos: string[]}` projection diverges from the
 * bearer/canonical `linkResponse` shape (`{repo, linked, workspace, source,
 * createdAt}`), same "don't forward a shape that isn't a strict superset"
 * rule phase 2 applied to the galleries list alias.
 */
import { ForbiddenError } from "@uploads/errors";
import { Hono, type MiddlewareHandler } from "hono";
import { dualWorkspaceAuth, requireSessionAdmin, type DualAuthVars } from "../dual-workspace-auth";
import { respondError } from "../error-response";
import { writeRateLimit } from "../guards";
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
import { githubPromoteHandler } from "./github-promote";

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
  // `.fetch()`-ed directly by nothing today (no old-path alias forwards
  // through this router — see the module docblock's repo-links note), but
  // this still needs its own error boundary for consistency with the other
  // canonical verticals and in case a future alias does re-dispatch through
  // it directly.
  .onError((err, c) => respondError(c, err));
