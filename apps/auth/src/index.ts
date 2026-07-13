import { Hono } from "hono";
import { cors } from "hono/cors";
import { createAuth, type AuthEnv } from "./auth";
import { internal } from "./internal-routes";
import { isInternalRequest } from "./internal";
import { LOCAL_STACK_WEB_ORIGIN, localDemoEnabled } from "./local-demo";
import { isTrustedOrigin } from "./trusted-origins";
import { runAuthRetentionSweep } from "./retention-sweep";

// Credentialed CORS for the web origin (+ dev origins), scoped to /api/auth/*
// only — this worker has no other public surface (D1: "CORS becomes trivial").
const authCors = cors({
  origin: (origin, c) => (origin && isTrustedOrigin(origin, c.env as AuthEnv) ? origin : null),
  credentials: true,
  allowMethods: ["GET", "POST", "OPTIONS"],
  allowHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
  maxAge: 86400,
});

export const app = new Hono<{ Bindings: AuthEnv }>()
  .get("/health", (c) => c.json({ ok: true }))
  // Service-binding-only API (D1/D9): 404 rather than 403 for non-internal
  // callers so the route's existence isn't leaked to public probing.
  .use("/internal/*", async (c, next) => {
    if (!isInternalRequest(c.req.raw)) {
      return c.json({ error: { code: "not_found", message: "Not found" } }, 404);
    }
    await next();
  })
  .route("/internal", internal)
  // The demo-session endpoint must look absent unless the stack runner has
  // enabled the exact local configuration. Keep this guard before generic
  // Better Auth handling so its normal CSRF/origin machinery cannot leak a
  // different status for an endpoint that should not exist.
  .use("/api/auth/dev-session", async (c, next) => {
    if (!localDemoEnabled(c.env) || c.req.header("origin") !== LOCAL_STACK_WEB_ORIGIN) {
      return c.json({ error: { code: "not_found", message: "Not found" } }, 404);
    }
    await next();
  })
  .use("/api/auth/*", authCors)
  .on(["POST", "GET"], "/api/auth/*", async (c) => {
    const auth = await createAuth(c.env);
    if (!auth) {
      // Signing secret unresolved (Secrets Store entry not populated yet, or
      // no BETTER_AUTH_SECRET_DEV in dev) — never boot Better Auth on an
      // ephemeral secret (D7). Fail closed instead of 500ing.
      return c.json(
        { error: { code: "auth_unavailable", message: "Auth is not configured yet." } },
        503,
      );
    }
    // better-auth 1.6.23 has no `advanced.backgroundTasks`/`waitUntil` hook to
    // scope internal fire-and-forget writes to this request's execution
    // context (verified against the installed version — see plan D1, which
    // asked executing agents to re-check this against latest stable rather
    // than copying releases' pattern uncritically). The handler already
    // awaits its own DB writes before returning a response, so there is
    // nothing here that needs `c.executionCtx.waitUntil`; revisit if a future
    // better-auth version adds one.
    return auth.handler(c.req.raw);
  })
  .notFound((c) => c.json({ error: { code: "not_found", message: "Not found" } }, 404));

export default {
  fetch: app.fetch.bind(app),
  // Daily retention sweep (plan Phase 5, uploads#102 item 4): expired
  // `verification`/`device_code` rows that Better Auth doesn't proactively
  // clean up. See src/retention-sweep.ts.
  async scheduled(_controller: ScheduledController, env: AuthEnv, ctx: ExecutionContext) {
    ctx.waitUntil(
      runAuthRetentionSweep(env).catch((err) => {
        console.error(
          JSON.stringify({
            message: "auth_retention_sweep_failed",
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      }),
    );
  },
};
