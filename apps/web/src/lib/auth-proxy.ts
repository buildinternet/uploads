/**
 * Same-origin auth proxy (#731 phase A).
 *
 * Web serves `uploads.sh/api/auth/*` and forwards to the auth worker, so a
 * later phase can move browser auth traffic off `auth.uploads.sh` onto this
 * origin (killing the cross-subdomain cookie). This phase only stands the
 * transport up — nothing calls it yet, so the deploy is inert.
 *
 * Two transports:
 *  - `env.AUTH` service binding (production/preview): a direct worker-to-
 *    worker call, no public network hop.
 *  - HTTP fallback against `UPLOADS_AUTH_ORIGIN` (astro dev, which has no
 *    service bindings to sibling wrangler processes).
 *
 * Both transports use `redirect: "manual"` — Better Auth's OAuth callback
 * 302s must reach the browser unfollowed, not be resolved inside the worker.
 */

import { rewriteOrigin } from "./proxy-transport";

export interface AuthProxyEnv {
  AUTH?: { fetch(req: Request): Promise<Response> };
  UPLOADS_AUTH_ORIGIN?: string;
}

const LOCAL_AUTH_ORIGIN_DEFAULT = "http://127.0.0.1:8788";

/**
 * Appended when a same-origin (host-only) session cookie is set for
 * `uploads.sh` — clears the pre-Phase-C wide `Domain=.uploads.sh` cookie so
 * the browser's jar doesn't carry both. Before Phase C the upstream
 * `Set-Cookie` still carries `Domain=.uploads.sh`, so the guard below never
 * fires; this is dead code until the auth worker's `BETTER_AUTH_URL` flips.
 */
const LEGACY_CLEAR_COOKIE =
  "__Secure-better-auth.session_token=; Path=/; Domain=.uploads.sh; Max-Age=0; Secure; HttpOnly; SameSite=Lax";

/** Forwards `request` to the auth worker (binding, else HTTP fallback). */
export async function proxyAuthRequest(env: AuthProxyEnv, request: Request): Promise<Response> {
  const forwarded = new Request(request, { redirect: "manual" });
  const upstream = env.AUTH
    ? await env.AUTH.fetch(forwarded)
    : await fetch(rewriteOrigin(forwarded, env.UPLOADS_AUTH_ORIGIN ?? LOCAL_AUTH_ORIGIN_DEFAULT));
  return withLegacyCookieCleared(upstream, request);
}

/**
 * Appends the legacy-cookie clearing header only when BOTH hold: the
 * request's host is exactly `uploads.sh`, AND the upstream response sets a
 * `*session_token` cookie with no `Domain=` attribute (host-only — the
 * Phase-C shape). Never fires for `uploads.localhost` or any other host.
 */
function withLegacyCookieCleared(upstream: Response, request: Request): Response {
  if (new URL(request.url).hostname !== "uploads.sh") return upstream;

  const setCookies = upstream.headers.getSetCookie();
  const setsHostOnlySessionCookie = setCookies.some((cookie) => {
    const nameValue = cookie.split(";")[0] ?? "";
    const name = nameValue.split("=")[0]?.trim() ?? "";
    return name.endsWith("session_token") && !/;\s*domain=/i.test(cookie);
  });
  if (!setsHostOnlySessionCookie) return upstream;

  const response = new Response(upstream.body, upstream);
  response.headers.append("Set-Cookie", LEGACY_CLEAR_COOKIE);
  return response;
}

/**
 * SSR helper (consumed starting Phase B): resolves the current session by
 * forwarding the incoming request's `cookie` header to `/api/auth/get-
 * session` on the request's own origin, over the same transport as
 * `proxyAuthRequest`. A server-to-server fetch has no cookie jar of its own,
 * so the header must be forwarded explicitly.
 */
export async function serverGetSession(env: AuthProxyEnv, request: Request): Promise<Response> {
  const getSessionRequest = new Request(new URL("/api/auth/get-session", request.url), {
    headers: { cookie: request.headers.get("cookie") ?? "" },
  });
  return proxyAuthRequest(env, getSessionRequest);
}

/**
 * SSR helper (#731 phase D follow-up): resolves one auth-client call from
 * Astro frontmatter over the same transport as `proxyAuthRequest`.
 * `pathAndQuery` is resolved against the incoming request's own origin, so a
 * relative auth-client URL (`authOrigin("")` → `/api/auth/...`) becomes an
 * absolute one a Worker can actually fetch — plain `fetch("/api/auth/...")`
 * has no ambient origin to resolve against outside a browser.
 *
 * Forwards the incoming request's `cookie` header only when `init` doesn't
 * already carry one — auth-client's `opts.cookie` callers already set it
 * themselves (mirrors `getSession`'s own conditional-header shape), so this
 * only fills the gap for a caller that didn't.
 */
export async function serverAuthFetch(
  env: AuthProxyEnv,
  request: Request,
  pathAndQuery: string,
  init: RequestInit = {},
): Promise<Response> {
  const target = new URL(pathAndQuery, request.url);
  const headers = new Headers(init.headers);
  if (!headers.has("cookie")) {
    headers.set("cookie", request.headers.get("cookie") ?? "");
  }
  return proxyAuthRequest(env, new Request(target, { ...init, headers }));
}

/**
 * A `fetch`-shaped adapter over {@link serverAuthFetch}, for auth-client.ts's
 * `opts.fetchImpl` (mirrors `api-proxy.ts`'s `serverApiFetchImpl`) — every
 * auth-client URL is already the same relative `"/api/auth/..."` string
 * `serverAuthFetch` expects when `authOrigin("")` resolves to `""`, so no
 * path translation is needed here.
 */
export function serverAuthFetchImpl(env: AuthProxyEnv, request: Request): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) =>
    serverAuthFetch(env, request, String(input), init)) as typeof fetch;
}
