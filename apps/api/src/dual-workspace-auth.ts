/**
 * Dual-auth guards for `/v1/workspaces/:workspace/*`: accept either a bearer
 * token or a session and set the same `WorkspaceVars`, so handlers and
 * `requireScope` never need to know which one arrived.
 */
import { ForbiddenError, NotFoundError, UnauthorizedError } from "@uploads/errors";
import { setIssueContext } from "@uploads/observability/issues";
import type { Context, MiddlewareHandler } from "hono";
import { type WorkspaceScope } from "./auth-db";
import { FILE_SCOPES } from "./auth-db";
import { adminWorkspaceOr403, memberWorkspaceOr404, membershipsForUser } from "./org-workspaces";
import {
  requireSessionUser,
  sessionAuth,
  type SessionUser,
  type SessionVars,
} from "./session-auth";
import { userUploaderIdentity } from "./uploader-identity";
import {
  loadWorkspaceRecord,
  workspaceAuth,
  workspaceGovernanceAuth,
  type GovernanceVars,
  type WorkspaceVars,
  isWorkspaceTokenShaped,
} from "./workspace";

/** Combined context vars for routes reachable by either auth path. */
export type DualAuthVars = {
  Variables: WorkspaceVars["Variables"] &
    SessionVars["Variables"] & {
      /**
       * Session `userId`, set only when `authSource === "session"`. Lets
       * `requireSessionAdmin` skip a second `get-session` round trip.
       */
      sessionUserId?: string;
    };
  Bindings: Env;
};

/**
 * In-process handoff for a session `userId` already resolved upstream,
 * keyed on the exact `Request`. Only `presetResolvedSessionUser` writes it,
 * so an external request can never carry a forged identity. That is why
 * this is a WeakMap and not a header.
 */
const PRERESOLVED_USER = new WeakMap<Request, string>();

/**
 * Records that `request`'s session was already verified in-process (e.g.
 * `me.ts`'s `forwardToWorkspaceFiles`). Call it on the exact `Request` that
 * will reach `dualWorkspaceAuth`.
 */
export function presetResolvedSessionUser(request: Request, userId: string): void {
  PRERESOLVED_USER.set(request, userId);
}

/**
 * A preset takes priority over any `Authorization` header still riding on a
 * forwarded `/me` request, so an already-validated bearer-session caller is
 * never sent down the token path and rejected a second time.
 */
export function hasPreresolvedSession(request: Request): boolean {
  return PRERESOLVED_USER.has(request);
}

/**
 * Resolves the session `userId` once per request: the preset handoff if
 * present, otherwise a real `sessionAuth` round trip. Throws on no session.
 */
export async function resolveSessionUserId(c: Context<SessionVars>): Promise<string> {
  const preresolvedUserId = PRERESOLVED_USER.get(c.req.raw);
  if (preresolvedUserId !== undefined) return preresolvedUserId;
  await sessionAuth(c, async () => {});
  await requireSessionUser(c, async () => {});
  return (c.get("sessionUser") as SessionUser).id;
}

/**
 * Guards a workspace route with either a bearer token (as `workspaceAuth`)
 * or a session (member check as `memberWorkspaceOr404`).
 *
 * A presented bearer is authoritative and never falls back to a cookie.
 * A session caller gets every `FILE_SCOPES`: membership is all-or-nothing on
 * the file plane. A preset session always wins over the bearer check. The
 * bearer branch can't be narrowed to `up_`-shaped tokens (unlike
 * `dualGovernanceAuth`) because it still accepts legacy hash tokens.
 */
export function dualWorkspaceAuth(): MiddlewareHandler<DualAuthVars> {
  return async (c, next) => {
    const authorization = c.req.header("Authorization");
    if (!hasPreresolvedSession(c.req.raw) && authorization?.startsWith("Bearer ")) {
      return workspaceAuth(c as unknown as Parameters<typeof workspaceAuth>[0], next);
    }

    const userId = await resolveSessionUserId(c as unknown as Context<SessionVars>);

    const name = c.req.param("workspace");
    if (!name) throw new UnauthorizedError();
    await memberWorkspaceOr404(c.env, userId, name);

    const record = await loadWorkspaceRecord(c.env, name);
    if (!record) throw new NotFoundError("workspace not found", { code: "workspace_not_found" });

    c.set("workspace", record);
    c.set("workspaceName", name);
    c.set("authScopes", [...FILE_SCOPES]);
    c.set("authSource", "session");
    c.set("authPrincipal", `session-user:${userId}`);
    // `isEntitledToClaimRepo` treats a null minting user as not entitled, so a
    // session caller must carry their own identity or repo claims fail.
    c.set("uploaderIdentity", userUploaderIdentity(userId));
    c.set("sessionUserId", userId);
    setIssueContext({ userId, workspace: name });
    await next();
  };
}

/**
 * Session-only admin/owner gate, layered after `dualWorkspaceAuth()`. A no-op
 * for bearer callers, whose gate stays the route's `requireScope`.
 *
 * Membership is already proven, so a non-admin member gets 403, not 404. The
 * role is looked up again here rather than carried in `WorkspaceVars`, to
 * keep a session-only concept out of the shared type.
 *
 * Reads `sessionUserId` rather than `sessionUser`, which is unset on the
 * preset fast path.
 */
export function requireSessionAdmin(): MiddlewareHandler<DualAuthVars> {
  return async (c, next) => {
    if (c.get("authSource") === "session") {
      const userId = c.get("sessionUserId");
      const name = c.get("workspaceName");
      if (!userId || !name) throw new UnauthorizedError();
      const [membership] = await membershipsForUser(c.env, userId, { slug: name });
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
 * Dual-auth guard for workspace governance scopes (`workspace:invite`,
 * `workspace:manage`, ...). Unlike `dualWorkspaceAuth`, a session caller is
 * not granted scopes; they must be an org admin/owner.
 *
 * A preset session wins over any bearer. Otherwise only an `up_`-shaped
 * bearer is treated as a governance token and delegated to
 * `workspaceGovernanceAuth`; any other bearer is a Better Auth session
 * bearer and goes through `resolveSessionUserId` like a cookie.
 *
 * The session path sets `governanceMintingUserId` to the session user, so
 * handlers written against `GovernanceVars` work from either path.
 */
export function dualGovernanceAuth(
  requiredScope: WorkspaceScope,
): MiddlewareHandler<GovernanceSessionVars> {
  return async (c, next) => {
    const authorization = c.req.header("Authorization");
    const rawToken = authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined;
    if (!hasPreresolvedSession(c.req.raw) && isWorkspaceTokenShaped(rawToken)) {
      return workspaceGovernanceAuth(requiredScope)(
        c as unknown as Parameters<ReturnType<typeof workspaceGovernanceAuth>>[0],
        next,
      );
    }

    const userId = await resolveSessionUserId(c as unknown as Context<SessionVars>);
    const name = c.req.param("name") ?? c.req.param("workspace");
    if (!name) throw new UnauthorizedError();

    await adminWorkspaceOr403(c.env, userId, name);

    c.set("governanceMintingUserId", userId);
    setIssueContext({ userId, workspace: name });
    await next();
  };
}
