import { reportHandledError } from "@uploads/observability";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { createAuth, directAuthOrigins, type AuthEnv } from "./auth";
import { internal } from "./internal-routes";
import { isInternalRequest } from "./internal";
import { localDemoEnabled } from "./local-demo";
import { isTrustedOrigin } from "./trusted-origins";
import { runAuthRetentionSweep } from "./retention-sweep";
import { sweepOauthClients } from "./oauth-client-reaper";
import { BILLING_OUTBOX_CRON, drainBillingOutbox } from "./billing-outbox";
import { applyDigestUnsubscribe, unsubscribePage } from "./notify-weekly-digest";
import { applyUpdatesUnsubscribe, updatesUnsubscribePage } from "./notify-product-updates";
import { signingSecret } from "./digest-token";
import * as schema from "./schema";
import { billingPricesResponseBody } from "./billing-prices";
import { ROBOTS_TXT } from "./robots";

// Credentialed CORS for the web origin (+ dev origins), scoped to /api/auth/*
// only — this worker has no other public surface (D1: "CORS becomes trivial").
const authCors = cors({
  origin: (origin, c) => (origin && isTrustedOrigin(origin, c.env as AuthEnv) ? origin : null),
  credentials: true,
  allowMethods: ["GET", "POST", "OPTIONS"],
  allowHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
  maxAge: 86400,
});

/** Signing secret missing. 503, and an Error so Issues records the outage. */
function authUnavailable(): Response {
  reportHandledError(new Error("Auth is not configured yet"));
  return Response.json(
    { error: { code: "auth_unavailable", message: "Auth is not configured yet." } },
    { status: 503 },
  );
}

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
  if (!auth) return authUnavailable();
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
 * The same pass sets `token_endpoint_auth_methods_supported` to
 * `["none", "private_key_jwt"]` and `grant_types_supported` to
 * `authorization_code` + `refresh_token`. Better Auth 1.7's oauth-provider
 * also lists `client_secret_*` and `client_credentials`. Unauthenticated DCR
 * persists public PKCE only (`sanitizeDcrRegistrationBody`, #990) and
 * refuses `private_key_jwt`; CIMD persists public PKCE, or `private_key_jwt`
 * when the document's `jwks_uri` is HTTPS on the `client_id` origin
 * (`sanitizeCimdMetadataDocument`, for Vercel Connect). No
 * self-registered client gets a secret or `client_credentials`; the token
 * endpoint rejects that grant for a public client and for a client whose row
 * lacks it. RFC 8414's defaults (omitted auth methods →
 * `client_secret_basic`; omitted grants → `authorization_code` + `implicit`)
 * are wrong for this server, so both fields are always set. Revocation gets
 * the same two methods: the plugin accepts a bare `client_id` there for a
 * public client and verifies an assertion for a `private_key_jwt` one. RFC
 * 8414 requires the `*_auth_signing_alg_values_supported` list next to a
 * `*_jwt` method, so the token, revocation, and introspection lists are kept
 * (or filled in) with the algorithms oauth-provider's `verifyClientAssertion`
 * accepts. Introspection's method list stays as the plugin emits it: that
 * endpoint requires a secret or an assertion, so `none` would be false. The `client_credentials`
 * handler stays registered for a non-discovery client; discovery describes
 * what a self-registered client can do. Seeded `uploads-cli` uses the
 * device-code plugin, not this list.
 *
 * The origin rewrite no-ops unless `AUTH_DIRECT_ORIGIN` is set and differs
 * from the issuer origin — dev/preview reach the worker directly. The
 * metadata clamps still run. Only the two discovery documents are read;
 * every other `/api/auth/*` response passes straight through (the path
 * check short-circuits before the body is ever read).
 */
const FORM_POST_ENDPOINT_KEYS = [
  "token_endpoint",
  "introspection_endpoint",
  "revocation_endpoint",
] as const;

/**
 * Methods a self-registered client can use: `none` (DCR and CIMD) and
 * `private_key_jwt` (CIMD with a same-origin `jwks_uri` only).
 */
const SELF_REGISTERED_TOKEN_ENDPOINT_AUTH_METHODS = ["none", "private_key_jwt"] as const;

/**
 * Grants a self-registered client can use. Matches `DCR_GRANT_TYPES`.
 * `client_credentials` stays out: public clients cannot use it, and open
 * registration strips it.
 */
const PUBLIC_GRANT_TYPES = ["authorization_code", "refresh_token"] as const;

/**
 * `PRIVATE_KEY_JWT_SIGNING_ALGORITHMS` from `@better-auth/core/oauth2` 1.7.7,
 * the list `verifyClientAssertion` checks `alg` against. Used only when the
 * plugin omits the field; the plugin's own list wins otherwise so the two
 * cannot drift.
 */
const PRIVATE_KEY_JWT_SIGNING_ALGS = [
  "RS256",
  "RS384",
  "RS512",
  "PS256",
  "PS384",
  "PS512",
  "ES256",
  "ES384",
  "ES512",
  "EdDSA",
] as const;

/**
 * Endpoints whose `*_auth_signing_alg_values_supported` RFC 8414 §2 requires
 * whenever their `*_auth_methods_supported` lists a `*_jwt` method.
 */
const JWT_AUTH_ENDPOINT_PREFIXES = [
  "token_endpoint",
  "revocation_endpoint",
  "introspection_endpoint",
] as const;

function listEquals(value: unknown, expected: readonly string[]): boolean {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    expected.every((item, i) => value[i] === item)
  );
}

function isNonEmptyStringList(value: unknown): boolean {
  return (
    Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string")
  );
}

export async function rewriteDiscoveryEndpoints(
  requestUrl: string,
  res: Response,
  env: AuthEnv,
): Promise<Response> {
  if (!res.ok) return res;
  if (!isDiscoveryMetadataPath(new URL(requestUrl).pathname)) return res;

  let json: Record<string, unknown>;
  try {
    const parsed: unknown = await res.clone().json();
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) return res;
    json = parsed as Record<string, unknown>;
  } catch {
    return res;
  }

  let changed = false;
  if (
    !listEquals(
      json.token_endpoint_auth_methods_supported,
      SELF_REGISTERED_TOKEN_ENDPOINT_AUTH_METHODS,
    )
  ) {
    json.token_endpoint_auth_methods_supported = [...SELF_REGISTERED_TOKEN_ENDPOINT_AUTH_METHODS];
    changed = true;
  }
  if (!listEquals(json.grant_types_supported, PUBLIC_GRANT_TYPES)) {
    json.grant_types_supported = [...PUBLIC_GRANT_TYPES];
    changed = true;
  }
  if (
    "revocation_endpoint" in json &&
    !listEquals(
      json.revocation_endpoint_auth_methods_supported,
      SELF_REGISTERED_TOKEN_ENDPOINT_AUTH_METHODS,
    )
  ) {
    json.revocation_endpoint_auth_methods_supported = [
      ...SELF_REGISTERED_TOKEN_ENDPOINT_AUTH_METHODS,
    ];
    changed = true;
  }
  for (const prefix of JWT_AUTH_ENDPOINT_PREFIXES) {
    const methods = json[`${prefix}_auth_methods_supported`];
    const listsJwtMethod =
      Array.isArray(methods) &&
      methods.some((method) => typeof method === "string" && method.endsWith("_jwt"));
    const algKey = `${prefix}_auth_signing_alg_values_supported`;
    if (listsJwtMethod && !isNonEmptyStringList(json[algKey])) {
      json[algKey] = [...PRIVATE_KEY_JWT_SIGNING_ALGS];
      changed = true;
    }
  }

  const origins = directAuthOrigins(env);
  if (origins) {
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
      if (endpoint.origin === origins.issuerOrigin) {
        json[key] = `${origins.directOrigin}${endpoint.pathname}${endpoint.search}${endpoint.hash}`;
        changed = true;
      }
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
  // Public unsubscribe from the weekly digest. The token is the credential;
  // the visitor does not need a session. GET is the link in the mail, POST
  // is the one-click List-Unsubscribe action.
  .on(["GET", "POST"], "/digest/unsubscribe", async (c) => {
    const url = new URL(c.req.url);
    let token = url.searchParams.get("token") ?? "";
    if (!token && c.req.method === "POST") {
      const form = await c.req.raw
        .clone()
        .formData()
        .catch(() => null);
      const fromForm = form?.get("token");
      if (typeof fromForm === "string") token = fromForm;
    }
    const secret = await signingSecret(c.env);
    if (!secret) {
      reportHandledError(new Error("digest unsubscribe signing secret is not configured"));
      return c.html(unsubscribePage(false), 503);
    }
    const result = await applyDigestUnsubscribe(drizzle(c.env.DB, { schema }), secret, token);
    return c.html(
      unsubscribePage(result.ok, result.ok ? result.workspaceName : null),
      result.ok ? 200 : 400,
    );
  })
  // Public unsubscribe from product update emails. Same token-as-credential
  // shape as the digest route above.
  .on(["GET", "POST"], "/updates/unsubscribe", async (c) => {
    const url = new URL(c.req.url);
    let token = url.searchParams.get("token") ?? "";
    if (!token && c.req.method === "POST") {
      const form = await c.req.raw
        .clone()
        .formData()
        .catch(() => null);
      const fromForm = form?.get("token");
      if (typeof fromForm === "string") token = fromForm;
    }
    const secret = await signingSecret(c.env);
    if (!secret) {
      reportHandledError(new Error("updates unsubscribe signing secret is not configured"));
      return c.html(updatesUnsubscribePage(false), 503);
    }
    const ok = await applyUpdatesUnsubscribe(drizzle(c.env.DB, { schema }), secret, token);
    return c.html(updatesUnsubscribePage(ok), ok ? 200 : 400);
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
      return authUnavailable();
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
    // The discovery-metadata rewrite (#749, #1117) advertises the OAuth
    // form-POST endpoints on AUTH_DIRECT_ORIGIN and sets token auth methods
    // to ["none", "private_key_jwt"] and grant_types_supported to
    // authorization_code + refresh_token. It no-ops for every non-metadata path (the path check
    // short-circuits before the body is read), so it doesn't touch the
    // actual /oauth2/token request itself.
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
          reportHandledError(err);
        }),
      );
      return;
    }

    ctx.waitUntil(
      runAuthRetentionSweep(env).catch((err) => {
        reportHandledError(err);
      }),
    );
    // Issue #224, Lane A: nightly sweep of stale, never-used dynamically
    // registered OAuth clients. Observe-only until OAUTH_CLIENT_REAPER_ENABLED
    // is set (see src/oauth-client-reaper.ts).
    ctx.waitUntil(
      sweepOauthClients(env).catch((err) => {
        reportHandledError(err);
      }),
    );
  },
};
