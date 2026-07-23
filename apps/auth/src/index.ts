import { Hono } from "hono";
import { cors } from "hono/cors";
import { createAuth, type AuthEnv } from "./auth";
import { internal } from "./internal-routes";
import { isInternalRequest } from "./internal";
import { localDemoEnabled } from "./local-demo";
import { isTrustedOrigin } from "./trusted-origins";
import { runAuthRetentionSweep } from "./retention-sweep";
import { sweepOauthClients } from "./oauth-client-reaper";
import { billingPricesResponseBody } from "./billing-prices";

// Credentialed CORS for the web origin (+ dev origins), scoped to /api/auth/*
// only — this worker has no other public surface (D1: "CORS becomes trivial").
const authCors = cors({
  origin: (origin, c) => (origin && isTrustedOrigin(origin, c.env as AuthEnv) ? origin : null),
  credentials: true,
  allowMethods: ["GET", "POST", "OPTIONS"],
  allowHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
  maxAge: 86400,
});

/**
 * Rewrite the request path to `pathname` and run it through the Better Auth
 * handler, stamping `Access-Control-Allow-Origin: *` on the response — issue
 * #224, Lane A's root `/.well-known/*` discovery aliases below. Clients that
 * discover from the issuer origin (not `/api/auth`) hit these; this rewrites
 * to the plugin's actual paths under the basePath. Public metadata only, so
 * CORS is wide open (unlike the credentialed `authCors` on `/api/auth/*`).
 * Mirrors `~/Code/sunny/apps/auth/src/index.ts`'s `runBetterAuth`.
 */
async function discoveryAlias(
  c: { env: AuthEnv; req: { raw: Request } },
  pathname: string,
): Promise<Response> {
  const auth = await createAuth(c.env);
  if (!auth) {
    return Response.json(
      { error: { code: "auth_unavailable", message: "Auth is not configured yet." } },
      { status: 503 },
    );
  }
  const url = new URL(c.req.raw.url);
  url.pathname = pathname;
  const res = await auth.handler(new Request(url.toString(), c.req.raw));
  const headers = new Headers(res.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  return new Response(res.body, { status: res.status, headers });
}

// Public, non-credentialed CORS for /billing/prices — the web app fetches
// this cross-origin with a plain `fetch`, no cookies involved, so this is
// intentionally looser than `authCors` (no `credentials: true`).
const billingPricesCors = cors({
  origin: (origin, c) => (origin && isTrustedOrigin(origin, c.env as AuthEnv) ? origin : null),
  allowMethods: ["GET", "OPTIONS"],
  maxAge: 86400,
});

export const app = new Hono<{ Bindings: AuthEnv }>()
  .get("/health", (c) => c.json({ ok: true }))
  .use("/billing/prices", billingPricesCors)
  .get("/billing/prices", async (c) => {
    const body = await billingPricesResponseBody(c.env);
    return c.json(body, 200, { "Cache-Control": "public, max-age=300" });
  })
  // RFC 8414 path-inserted form: /.well-known/oauth-authorization-server{issuer-path}.
  // Issuer is `${BETTER_AUTH_URL}/api/auth`, so both the bare and `/*` forms
  // rewrite to the same plugin path.
  .get("/.well-known/oauth-authorization-server", (c) =>
    discoveryAlias(c, "/api/auth/.well-known/oauth-authorization-server"),
  )
  .get("/.well-known/oauth-authorization-server/*", (c) =>
    discoveryAlias(c, "/api/auth/.well-known/oauth-authorization-server"),
  )
  .get("/.well-known/openid-configuration", (c) =>
    discoveryAlias(c, "/api/auth/.well-known/openid-configuration"),
  )
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
    if (!localDemoEnabled(c.env) || c.req.header("origin") !== c.env.WEB_ORIGIN) {
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
    // Issue #224, Lane A: nightly sweep of stale, never-used dynamically
    // registered OAuth clients. Observe-only until OAUTH_CLIENT_REAPER_ENABLED
    // is set (see src/oauth-client-reaper.ts).
    ctx.waitUntil(
      sweepOauthClients(env).catch((err) => {
        console.error(
          JSON.stringify({
            message: "oauth_client_reaper_failed",
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      }),
    );
  },
};
