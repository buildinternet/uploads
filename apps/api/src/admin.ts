import { ForbiddenError, UnauthorizedError } from "@uploads/errors";
import {
  d1ExecMs,
  ServerTiming,
  serverTimingDisabled,
  slowOpThresholdMs,
  timeOp,
} from "@uploads/observability";
import type { MiddlewareHandler } from "hono";
import { findActiveToken, isOperatorScope, touchTokenLastUsed } from "./auth-db";
import { hexToBytes, sha256Hex, workspaceNameFromToken } from "./workspace";
import { dbFor } from "./db-session";
import { writeSlowOpPoint } from "./slow-op-analytics";

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

  // Instrumented per issue #814's noted follow-up: this bearer guard runs
  // the same two D1 calls as workspace.ts's workspaceAuthWith, just not on
  // the file-plane's highest-traffic path — same op names/shape so a
  // "d1"/"d1_touch" slow-op line or Analytics Engine row means the same
  // thing regardless of which guard produced it.
  const thresholdMs = slowOpThresholdMs(c.env);
  const timing = new ServerTiming();
  let record: Awaited<ReturnType<typeof findActiveToken>>;
  try {
    record = await timeOp(() => findActiveToken(dbFor(c.env), workspace, token), {
      name: "d1",
      timing,
      route: c.req.path,
      thresholdMs,
      onSlowOp: (event) => writeSlowOpPoint(c.env, event),
    });
  } finally {
    if (!serverTimingDisabled(c.env)) {
      const value = timing.header();
      if (value) c.header("Server-Timing", value, { append: true });
    }
  }
  if (!record) throw new UnauthorizedError();
  const touchTiming = new ServerTiming();
  try {
    await timeOp(() => touchTokenLastUsed(dbFor(c.env), record.id), {
      name: "d1_touch",
      timing: touchTiming,
      route: c.req.path,
      thresholdMs,
      execMs: d1ExecMs,
      onSlowOp: (event) => writeSlowOpPoint(c.env, event),
    });
  } finally {
    if (!serverTimingDisabled(c.env)) {
      const value = touchTiming.header();
      if (value) c.header("Server-Timing", value, { append: true });
    }
  }

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
