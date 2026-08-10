/**
 * Dual-auth workspace guard for the canonical `/v1/workspaces/:workspace/*`
 * surface (issue #613 phase 1). Resolves "who is this + can they touch this
 * workspace" from EITHER credential type and sets the same `WorkspaceVars`
 * either way, so downstream handlers — including `requireScope` — never need
 * to know which one arrived. See `routes/workspace-files.ts` for the first
 * vertical built on this.
 */
import { ForbiddenError, NotFoundError, UnauthorizedError } from "@uploads/errors";
import type { MiddlewareHandler } from "hono";
import { FILE_SCOPES } from "./auth-db";
import { membershipsForUser, workspacesFromMembership } from "./org-workspaces";
import {
  requireSessionUser,
  sessionAuth,
  type SessionUser,
  type SessionVars,
} from "./session-auth";
import { loadWorkspaceRecord, workspaceAuth, type WorkspaceVars } from "./workspace";

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

    const preresolvedUserId = PRERESOLVED_USER.get(c.req.raw);
    let userId: string;
    if (preresolvedUserId !== undefined) {
      // Session already resolved upstream (e.g. `me.ts`'s own `sessionAuth`
      // middleware, for a forwarded old-path alias) — skip the redundant
      // `get-session` round trip. Membership is still checked below: that
      // lookup hasn't run yet for this request.
      userId = preresolvedUserId;
    } else {
      const sessionC = c as unknown as Parameters<typeof sessionAuth>[0];
      await sessionAuth(sessionC, async () => {});
      await requireSessionUser(sessionC, async () => {});
      userId = (c.get("sessionUser") as SessionUser).id;
    }

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
