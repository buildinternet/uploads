import type { MiddlewareHandler } from "hono";
import { createDbSession } from "./db-session";
import type { WorkspaceVars } from "./workspace";

/** One D1 session per HTTP request, shared by the API and viewer entrypoints.
 * Test doubles and local setups without withSession keep dbFor's raw fallback. */
export const requestDbSession: MiddlewareHandler<WorkspaceVars> = async (c, next) => {
  if (c.env?.DB && typeof c.env.DB.withSession === "function") {
    c.env.DB_SESSION = createDbSession(c.env.DB);
  }
  await next();
};
