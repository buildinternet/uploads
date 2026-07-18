import { ForbiddenError, UnauthorizedError } from "@uploads/errors";
import type { MiddlewareHandler } from "hono";
import { findActiveToken, isOperatorScope } from "./auth-db";
import { hexToBytes, sha256Hex, workspaceNameFromToken } from "./workspace";

const READ_METHODS = new Set(["GET", "HEAD"]);

/**
 * Gates /admin/* on either the static ADMIN_TOKEN secret (break-glass, fails
 * closed if unset/empty — unchanged behavior) or a D1-backed operator token
 * minted via POST /v1/tokens with an operator:* scope (issue #257). The
 * ADMIN_TOKEN check runs first and is timing-safe; scoped-token auth is
 * attempted only after it fails, and works even when ADMIN_TOKEN is unset
 * (the fail-closed rule applies to the static-secret path only).
 *
 * Scope rule: `operator:write` is a superset that also grants read access;
 * `operator:read` only grants GET/HEAD.
 */
export const adminAuth: MiddlewareHandler<{
  Bindings: Env;
  Variables: { adminTokenId?: string };
}> = async (c, next) => {
  const secret = c.env.ADMIN_TOKEN ?? "";
  const header = c.req.header("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";

  const providedHash = await sha256Hex(token);
  const expectedHash = secret ? await sha256Hex(secret) : providedHash.replace(/./g, "0");
  const staticOk =
    secret.length > 0 &&
    token.length > 0 &&
    crypto.subtle.timingSafeEqual(hexToBytes(providedHash), hexToBytes(expectedHash));

  if (staticOk) {
    await next();
    return;
  }

  const workspace = token ? workspaceNameFromToken(token) : undefined;
  if (!workspace) throw new UnauthorizedError();

  const record = await findActiveToken(c.env.DB, workspace, token);
  if (!record) throw new UnauthorizedError();

  // record.scopes is operator-token-or-file-token JSON; parseScopes (auth-db.ts)
  // is file-scope-only, so parse directly here and keep just the operator ones.
  let parsed: unknown;
  try {
    parsed = JSON.parse(record.scopes);
  } catch {
    parsed = [];
  }
  const scopes = new Set(Array.isArray(parsed) ? parsed.filter(isOperatorScope) : []);
  const requiresWrite = !READ_METHODS.has(c.req.method);
  const hasAccess = requiresWrite
    ? scopes.has("operator:write")
    : scopes.has("operator:read") || scopes.has("operator:write");
  if (!hasAccess) throw new ForbiddenError();

  c.set("adminTokenId", record.id);
  await next();
};
