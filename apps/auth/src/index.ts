import { Hono } from "hono";
import { cors } from "hono/cors";
import { createAuth, type AuthEnv } from "./auth";
import { internal } from "./internal-routes";
import { isInternalRequest } from "./internal";
import { localDemoEnabled } from "./local-demo";
import { isTrustedOrigin } from "./trusted-origins";
import { runAuthRetentionSweep } from "./retention-sweep";
import { sweepOauthClients } from "./oauth-client-reaper";
import { BILLING_OUTBOX_CRON, drainBillingOutbox } from "./billing-outbox";
import { billingPricesResponseBody } from "./billing-prices";
import { ROBOTS_TXT } from "./robots";

// Durable Object backing Better Auth's rate limiter (see src/rate-limit-do.ts
// and the `durable_objects` block in wrangler.jsonc). Wrangler resolves the
// binding's class_name against the entrypoint's named exports, so this
// re-export is load-bearing even though nothing in this file calls it.
export { RateLimitCounter } from "./rate-limit-do";

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
  const aliasReq = new Request(url.toString(), c.req.raw);
  const res = await rewriteDiscoveryEndpoints(url.toString(), await auth.handler(aliasReq), c.env);
  const headers = new Headers(res.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  return new Response(res.body, { status: res.status, headers });
}

/**
 * OAuth discovery metadata paths whose form-POST endpoints need the direct
 * auth origin (see `rewriteDiscoveryEndpoints`).
 */
function isDiscoveryMetadataPath(pathname: string): boolean {
  return (
    pathname.endsWith("/.well-known/oauth-authorization-server") ||
    pathname.endsWith("/.well-known/openid-configuration")
  );
}

/**
 * The OAuth 2.1 token, introspection, and revocation endpoints are
 * machine-to-machine, non-cookie form POSTs (RFC 6749 §3.2 / 7662 / 7009). When
 * this worker is reached through the web origin's same-origin `/api` proxy
 * (#731), Astro's `checkOrigin` CSRF guard 403s those cross-site form POSTs
 * ("Cross-site POST form submissions are forbidden"). So we advertise them on
 * the worker's DIRECT origin (`AUTH_DIRECT_ORIGIN`, e.g. https://auth.uploads.sh),
 * which bypasses the proxy entirely. Browser-facing (`authorization_endpoint`)
 * and JSON/GET endpoints (`registration_endpoint`, `jwks_uri`, `issuer`) stay on
 * the same-origin issuer so session cookies and discovery are unaffected. See
 * issue #749.
 *
 * No-op unless `AUTH_DIRECT_ORIGIN` is set and differs from the issuer origin —
 * dev/preview reach the worker directly, so they skip this. Only rewrites the
 * two discovery documents; every other `/api/auth/*` response passes straight
 * through (the path check short-circuits before the body is ever read).
 */
const FORM_POST_ENDPOINT_KEYS = [
  "token_endpoint",
  "introspection_endpoint",
  "revocation_endpoint",
] as const;

export async function rewriteDiscoveryEndpoints(
  requestUrl: string,
  res: Response,
  env: AuthEnv,
): Promise<Response> {
  const authOrigin = env.AUTH_DIRECT_ORIGIN;
  if (!authOrigin || !res.ok) return res;
  if (!isDiscoveryMetadataPath(new URL(requestUrl).pathname)) return res;

  let issuerOrigin: string;
  let directOrigin: string;
  try {
    issuerOrigin = new URL(env.BETTER_AUTH_URL || "https://auth.uploads.sh").origin;
    directOrigin = new URL(authOrigin).origin;
  } catch {
    return res;
  }
  if (issuerOrigin === directOrigin) return res;

  let json: Record<string, unknown>;
  try {
    json = (await res.clone().json()) as Record<string, unknown>;
  } catch {
    return res;
  }

  let changed = false;
  for (const key of FORM_POST_ENDPOINT_KEYS) {
    const value = json[key];
    if (typeof value !== "string") continue;
    let endpoint: URL;
    try {
      endpoint = new URL(value);
    } catch {
      continue; // preserve malformed / non-URL values unchanged
    }
    // Exact origin match — a `startsWith` prefix check would also rewrite a
    // lookalike host like `https://uploads.sh.evil/…` (CodeRabbit, #750).
    if (endpoint.origin === issuerOrigin) {
      json[key] = `${directOrigin}${endpoint.pathname}${endpoint.search}${endpoint.hash}`;
      changed = true;
    }
  }
  if (!changed) return res;

  const headers = new Headers(res.headers);
  headers.delete("content-length");
  return new Response(JSON.stringify(json), { status: res.status, headers });
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
  .get("/robots.txt", (c) =>
    c.text(ROBOTS_TXT, 200, {
      "Cache-Control": "public, max-age=86400",
      "Content-Type": "text/plain; charset=utf-8",
    }),
  )
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
      // Signing secret unresolved (BETTER_AUTH_SECRET not set, and the
      // transitional Secrets Store fallback is also empty/unpopulated) —
      // never boot Better Auth on an ephemeral secret (D7). Fail closed
      // instead of 500ing.
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
    //
    // The discovery-metadata rewrite (#749) advertises the OAuth form-POST
    // endpoints on AUTH_DIRECT_ORIGIN; it no-ops for every non-metadata path
    // (the path check short-circuits before the body is read), so it doesn't
    // touch the actual /oauth2/token request itself.
    return rewriteDiscoveryEndpoints(c.req.raw.url, await auth.handler(c.req.raw), c.env);
  })
  .notFound((c) => c.json({ error: { code: "not_found", message: "Not found" } }, 404));

export default {
  fetch: app.fetch.bind(app),
  // Two schedules (see wrangler.jsonc `triggers.crons`), dispatched on
  // `controller.cron`: the every-5-minutes billing outbox drain must not drag
  // the daily sweeps along with it.
  async scheduled(controller: ScheduledController, env: AuthEnv, ctx: ExecutionContext) {
    if (controller.cron === BILLING_OUTBOX_CRON) {
      // Issue #451: retry plan syncs whose bridge call to apps/api failed.
      ctx.waitUntil(
        drainBillingOutbox(env).catch((err) => {
          console.error(
            JSON.stringify({
              message: "billing_outbox_drain_failed",
              error: err instanceof Error ? err.message : String(err),
            }),
          );
        }),
      );
      return;
    }

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
