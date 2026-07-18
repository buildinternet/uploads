/**
 * Session verification over the `AUTH` service binding (plan D1 Phase 2).
 * Forwards Cookie/Authorization to the auth worker's `get-session` endpoint —
 * no public hop, no CORS. Does not replace `workspaceAuth`/`adminAuth`
 * (bearer tokens); this is the seam for session-authenticated admin UI
 * endpoints later phases build on.
 */
import { ForbiddenError, ServiceUnavailableError, UnauthorizedError } from "@uploads/errors";
import type { MiddlewareHandler } from "hono";

/** Minimal shape of Better Auth's `get-session` response body. */
export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role?: string | null;
  [key: string]: unknown;
}

interface GetSessionResponse {
  session: unknown;
  user: SessionUser;
}

export type SessionVars = {
  Variables: {
    sessionUser: SessionUser | null;
  };
  Bindings: Env;
};

// Host is unused for routing on a direct service-binding fetch() call — it
// just needs to be a valid absolute URL. Matches the convention already used
// for auth.uploads.sh callers elsewhere in this repo's plan (D1).
const AUTH_INTERNAL_ORIGIN = "https://auth.internal";

/**
 * Resolves the caller's session via the AUTH binding and sets `sessionUser`
 * (null only when there is genuinely no valid session). Auth binding outages
 * and malformed successful responses stay distinct as 503s: treating either
 * as signed out would make an unavailable account surface look like a user
 * lost access to every workspace.
 */
export const sessionAuth: MiddlewareHandler<SessionVars> = async (c, next) => {
  c.set("sessionUser", await resolveSessionUser(c.env, c.req.raw));
  await next();
};

async function resolveSessionUser(env: Env, req: Request): Promise<SessionUser | null> {
  const headers = new Headers();
  const cookie = req.headers.get("cookie");
  const authorization = req.headers.get("authorization");
  if (cookie) headers.set("cookie", cookie);
  if (authorization) headers.set("authorization", authorization);

  try {
    const response = await env.AUTH.fetch(`${AUTH_INTERNAL_ORIGIN}/api/auth/get-session`, {
      headers,
    });
    // Better Auth returns a normal no-session result as 200 + null. An
    // explicitly unauthorized response also remains a normal signed-out case.
    if (response.status === 401) return null;
    if (!response.ok) {
      throw new ServiceUnavailableError("auth service is unavailable", {
        code: "auth_session_unavailable",
        details: { status: response.status },
      });
    }
    const body = (await response.json().catch(() => undefined)) as
      | GetSessionResponse
      | null
      | undefined;
    if (body === null) return null;
    if (!body || typeof body !== "object" || !body.user) {
      throw new ServiceUnavailableError("auth service returned a malformed session", {
        code: "auth_session_unavailable",
      });
    }
    return body.user;
  } catch (err) {
    if (err instanceof ServiceUnavailableError) throw err;
    throw new ServiceUnavailableError("auth service is unavailable", {
      code: "auth_session_unavailable",
    });
  }
}

/** 401s unless `sessionAuth` found a valid session. */
export const requireSessionUser: MiddlewareHandler<SessionVars> = async (c, next) => {
  if (!c.get("sessionUser")) throw new UnauthorizedError();
  await next();
};

/**
 * Better Auth supports comma-separated multi-role strings (e.g.
 * `"admin,support"`); mirrors `hasAdminRole` in apps/auth/src/auth.ts.
 */
export function userHasAdminRole(user: SessionUser | null | undefined): boolean {
  if (!user?.role) return false;
  return user.role
    .split(",")
    .map((r) => r.trim())
    .includes("admin");
}

/** 403s unless the session user has the global `admin` role (D3's admin plugin). */
export const requireAdminUser: MiddlewareHandler<SessionVars> = async (c, next) => {
  const user = c.get("sessionUser");
  if (!user) throw new UnauthorizedError();
  if (!userHasAdminRole(user)) throw new ForbiddenError("admin role required");
  await next();
};
