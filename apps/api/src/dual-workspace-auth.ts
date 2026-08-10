/**
 * Dual-auth workspace guard for the canonical `/v1/workspaces/:workspace/*`
 * surface (issue #613 phase 1). Resolves "who is this + can they touch this
 * workspace" from EITHER credential type and sets the same `WorkspaceVars`
 * either way, so downstream handlers — including `requireScope` — never need
 * to know which one arrived. See `routes/workspace-files.ts` for the first
 * vertical built on this.
 */
import { NotFoundError, UnauthorizedError } from "@uploads/errors";
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

    const sessionC = c as unknown as Parameters<typeof sessionAuth>[0];
    await sessionAuth(sessionC, async () => {});
    await requireSessionUser(sessionC, async () => {});
    const user = c.get("sessionUser") as SessionUser;

    const name = c.req.param("workspace");
    if (!name) throw new UnauthorizedError();
    await requireMembership(c.env, user.id, name);

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
