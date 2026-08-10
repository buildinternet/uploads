/**
 * Dual-auth workspace guard for the canonical `/v1/workspaces/:workspace/*`
 * surface (issue #613 phase 1). Resolves "who is this + can they touch this
 * workspace" from EITHER credential type and sets the same `WorkspaceVars`
 * either way, so downstream handlers — including `requireScope` — never need
 * to know which one arrived. See `routes/workspace-files.ts` for the first
 * vertical built on this.
 */
import { ForbiddenError, NotFoundError, UnauthorizedError } from "@uploads/errors";
import type { Context, MiddlewareHandler } from "hono";
import { type WorkspaceScope } from "./auth-db";
import { FILE_SCOPES } from "./auth-db";
import { membershipsForUser, workspacesFromMembership } from "./org-workspaces";
import {
  requireSessionUser,
  sessionAuth,
  type SessionUser,
  type SessionVars,
} from "./session-auth";
import {
  loadWorkspaceRecord,
  workspaceAuth,
  workspaceGovernanceAuth,
  type GovernanceVars,
  type WorkspaceVars,
} from "./workspace";

/** Combined context vars for routes reachable by either auth path. */
export type DualAuthVars = {
  Variables: WorkspaceVars["Variables"] & SessionVars["Variables"];
  Bindings: Env;
};

/**
 * In-process handoff for a session `userId` already resolved upstream of
 * `dualWorkspaceAuth` (issue #613 phase 1 follow-up, CodeRabbit finding on
 * PR #615). Keyed on the exact `Request` object so it can never leak across
 * requests. Trust argument: this map is only ever populated from inside this
 * process by `presetResolvedSessionUser` — an external caller has no way to
 * insert into it, so a request reaching `dualWorkspaceAuth` from outside
 * (e.g. the public `/v1/workspaces/...` mount) can never carry a forged
 * pre-resolved identity. This is why the handoff is a WeakMap and not a
 * header: a header on an inbound request is indistinguishable from one an
 * external caller sent themselves.
 */
const PRERESOLVED_USER = new WeakMap<Request, string>();

/**
 * Records that `request`'s session user was already resolved (its `userId`)
 * by an in-process caller — e.g. `me.ts`'s `forwardToWorkspaceFiles`, which
 * re-dispatches a request whose session was already verified by `me.ts`'s
 * own `sessionAuth` middleware. Call this on the exact `Request` instance
 * that will reach `dualWorkspaceAuth`, before dispatching it.
 */
export function presetResolvedSessionUser(request: Request, userId: string): void {
  PRERESOLVED_USER.set(request, userId);
}

/**
 * Caller's membership for `name`, or a uniform 404 (never a 403 — no
 * existence probe). Deliberately a small standalone duplicate of
 * `memberWorkspaceOr404` in `routes/me.ts` rather than an import: this file
 * needs to stay free of any `routes/me.ts` dependency so `routes/me.ts` can
 * import `routes/workspace-files.ts` (which imports this file) for its old-
 * path aliases without an import cycle.
 */
async function requireMembership(env: Env, userId: string, name: string): Promise<void> {
  const [membership] = await membershipsForUser(env, userId, { slug: name });
  if (!membership || !workspacesFromMembership(membership).includes(name)) {
    throw new NotFoundError("workspace not found", { code: "workspace_not_found" });
  }
}

/**
 * Resolves the calling session's `userId`, honoring the `presetResolvedUser`
 * WeakMap handoff (see above) before falling back to a real `sessionAuth` +
 * `requireSessionUser` round trip. Shared by `dualWorkspaceAuth` and
 * `dualGovernanceAuth` (and any session-only-but-bearer-aware guard a
 * canonical vertical wants to build) so "resolve the session exactly once
 * per forwarded request" stays true everywhere, not just on the files
 * vertical. Throws (via `requireSessionUser`) on no session — same as before
 * this was extracted.
 */
export async function resolveSessionUserId(c: Context<SessionVars>): Promise<string> {
  const preresolvedUserId = PRERESOLVED_USER.get(c.req.raw);
  if (preresolvedUserId !== undefined) return preresolvedUserId;
  await sessionAuth(c, async () => {});
  await requireSessionUser(c, async () => {});
  return (c.get("sessionUser") as SessionUser).id;
}

/**
 * Guards a `/…/:workspace/…` route with EITHER a bearer token (resolution
 * identical to `workspaceAuth`) OR a session cookie (membership check
 * identical to `me.ts`'s `memberWorkspaceOr404`).
 *
 * A presented bearer credential is authoritative — mirrors
 * `workspaceManageAuth` (`routes/workspaces.ts`): an explicit token is judged
 * on its own merits and never silently falls back to a session cookie that
 * might also ride the request. A session caller is granted every
 * `FILE_SCOPES`: membership is all-or-nothing on the file plane, same as
 * every existing `/me` file route, none of which consult `authScopes`.
 * `authSource: "session"` distinguishes the path taken without changing how
 * `requireScope` behaves (it only ever reads `authScopes`).
 */
export function dualWorkspaceAuth(): MiddlewareHandler<DualAuthVars> {
  return async (c, next) => {
    const authorization = c.req.header("Authorization");
    if (authorization?.startsWith("Bearer ")) {
      return workspaceAuth(c as unknown as Parameters<typeof workspaceAuth>[0], next);
    }

    const userId = await resolveSessionUserId(c as unknown as Context<SessionVars>);

    const name = c.req.param("workspace");
    if (!name) throw new UnauthorizedError();
    await requireMembership(c.env, userId, name);

    const record = await loadWorkspaceRecord(c.env, name);
    if (!record) throw new NotFoundError("workspace not found", { code: "workspace_not_found" });

    c.set("workspace", record);
    c.set("workspaceName", name);
    c.set("authScopes", [...FILE_SCOPES]);
    c.set("authSource", "session");
    c.set("mintingUserId", null);
    await next();
  };
}

/**
 * Session-only admin|owner tier gate, layered AFTER `dualWorkspaceAuth()` for
 * verticals whose bearer analog is scope-gated but whose SESSION analog needs
 * a stricter tier than plain membership — first built for the github vertical
 * (issue #613 phase 3: link/health/activity require admin/owner for a session
 * caller, matching `routes/me.ts`'s `adminWorkspaceOr403` posture for the
 * pre-existing `/me/workspaces/:name/repo-links` route). Reusable as-is by
 * any later vertical with the same "bearer keeps its scope, session needs
 * admin/owner" posture — e.g. invites/members (see
 * `.context/613-api-consolidation-plan.md`).
 *
 * A no-op for a bearer credential (`authSource !== "session"`): bearer's only
 * gate stays whatever `requireScope` the route already applies — this
 * middleware never tightens or loosens bearer behavior.
 *
 * For a session caller, `dualWorkspaceAuth` has already proven membership
 * (non-member 404s before this middleware is ever reached), so a member who
 * isn't admin/owner gets a 403 here, not a 404 — "not allowed", not "doesn't
 * exist", same reasoning as `workspace-usage.ts`'s `requireToken` guard.
 * Deliberately re-resolves the membership role via its own `membershipsForUser`
 * call rather than threading a role through `DualAuthVars` — `dualWorkspaceAuth`
 * only ever needed to prove membership existed, not carry the role forward,
 * and adding a role field to `WorkspaceVars` would leak a session-only concept
 * into the bearer-shared type. Costs one extra round trip on session admin
 * routes only, same as `me.ts`'s own `memberWorkspaceOr404` -> `adminWorkspaceOr403`
 * double-lookup shape.
 */
export function requireSessionAdmin(): MiddlewareHandler<DualAuthVars> {
  return async (c, next) => {
    if (c.get("authSource") === "session") {
      const user = c.get("sessionUser") as SessionUser | null;
      const name = c.get("workspaceName");
      if (!user || !name) throw new UnauthorizedError();
      const [membership] = await membershipsForUser(c.env, user.id, { slug: name });
      const role = membership?.role;
      if (role !== "admin" && role !== "owner") {
        throw new ForbiddenError("workspace admin or owner role required", {
          code: "workspace_admin_required",
        });
      }
    }
    await next();
  };
}

/** Combined context vars for a `dualGovernanceAuth`-guarded route. */
export type GovernanceSessionVars = {
  Variables: GovernanceVars["Variables"] & SessionVars["Variables"];
  Bindings: Env;
};

/**
 * Dual-auth guard for the workspace-*governance* scope namespace (issue #613
 * phase 3, invites/members vertical) — distinct from `dualWorkspaceAuth`,
 * which grants a session caller every `FILE_SCOPES`. Governance scopes
 * (`workspace:invite`/`workspace:manage`/etc., see `auth-db.ts`) are a
 * separate D1 token shape (`workspaceGovernanceAuth`) with no file-plane
 * analog, so a session caller here is never "granted a scope" — they're held
 * to the same admin/owner org-role tier the pre-existing `/me` governance-
 * adjacent routes (`adminWorkspaceOr403` in `routes/me.ts`) already require.
 *
 * A presented bearer credential is authoritative and delegates straight to
 * `workspaceGovernanceAuth(requiredScope)` — verbatim, so a governance-token
 * caller's behavior is provably unchanged by introducing this guard (see
 * `routes/workspace-governance-invite.test.ts`, still green against
 * `POST /v1/workspaces/:name/invites` after it was upgraded to use this
 * function in place of a bare `workspaceGovernanceAuth("workspace:invite")`).
 *
 * With no bearer: resolves the session (honoring the `presetResolvedUser`
 * WeakMap handoff via `resolveSessionUserId`), 404s a non-member (uniform,
 * no existence probe — same `requireMembership` shape as `dualWorkspaceAuth`),
 * then 403s `workspace_admin_required` for a member who isn't admin/owner —
 * identical codes/ordering to `me.ts`'s `adminWorkspaceOr403`
 * (`memberWorkspaceOr404` -> role check), so a session caller's behavior is
 * also provably unchanged by the swap. Sets `governanceMintingUserId` to the
 * session `userId` (mirroring what a bearer token's `minting_user_id`
 * represents — "who does this governance action act as") so a handler
 * written against `GovernanceVars` (e.g. the invite-creation handler in
 * `routes/workspaces.ts`) needs zero changes to work from either auth path.
 */
export function dualGovernanceAuth(
  requiredScope: WorkspaceScope,
): MiddlewareHandler<GovernanceSessionVars> {
  return async (c, next) => {
    const authorization = c.req.header("Authorization");
    if (authorization?.startsWith("Bearer ")) {
      return workspaceGovernanceAuth(requiredScope)(
        c as unknown as Parameters<ReturnType<typeof workspaceGovernanceAuth>>[0],
        next,
      );
    }

    const userId = await resolveSessionUserId(c as unknown as Context<SessionVars>);
    const name = c.req.param("name") ?? c.req.param("workspace");
    if (!name) throw new UnauthorizedError();

    const [membership] = await membershipsForUser(c.env, userId, { slug: name });
    if (!membership || !workspacesFromMembership(membership).includes(name)) {
      throw new NotFoundError("workspace not found", { code: "workspace_not_found" });
    }
    if (membership.role !== "admin" && membership.role !== "owner") {
      throw new ForbiddenError("workspace admin or owner role required", {
        code: "workspace_admin_required",
      });
    }

    c.set("governanceMintingUserId", userId);
    await next();
  };
}
