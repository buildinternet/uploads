/**
 * Same-origin api proxy (#731 phase D): `uploads.sh/api/<path>` forwards to
 * the api worker's `/<path>` (the `/api` prefix stripped, query string kept).
 * Mirrors `auth-proxy.ts`'s transport shape — see that file for the binding
 * vs. HTTP-fallback rationale — but carries no cookie-clearing logic; that's
 * an auth-worker-only concern.
 *
 * `/api/auth/*` never legitimately reaches this route (Astro prefers the
 * more specific `/api/auth/[...path]` static segment), but the guard below
 * 404s it anyway rather than trusting routing order — the api worker has its
 * own unrelated `/auth/enrollments/*` surface (console enroll codes) that a
 * misrouted `/api/auth/*` request must never reach. The guard checks the
 * percent-decoded pathname (see `decodedStrippedPathForGuard`) so an
 * encoded `/auth` (`/api/%61uth/...`, `/api%2Fauth/...`) can't slip past it
 * only to be decoded and routed to `/auth/...` by the api worker's Hono
 * router upstream.
 */

import {
  ServerTiming,
  serverTimingDisabled,
  slowOpThresholdMs,
  timeOp,
  type TimingEnv,
} from "@uploads/observability";
import { rewriteOrigin, withInheritedCookie } from "./proxy-transport";

export interface ApiProxyEnv extends TimingEnv {
  API?: { fetch(req: Request): Promise<Response> };
  UPLOADS_API_ORIGIN?: string;
}

const LOCAL_API_ORIGIN_DEFAULT = "http://127.0.0.1:8787";

/** Strips a leading `/api` from `pathname`, keeping the rest (including a bare `/api` → `/`). */
function stripApiPrefix(pathname: string): string {
  const stripped = pathname.replace(/^\/api(?=\/|$)/, "");
  return stripped === "" ? "/" : stripped;
}

/**
 * Decodes the FULL pathname (not just the part after `/api`) for the
 * `/auth` guard check below — a bypass can hide in the `/api` boundary
 * itself (`/api%2Fauth/...`, the encoded slash decoding to the one
 * `stripApiPrefix`'s regex expects) just as easily as further down the path
 * (`/api/%61uth/...`). Hono (the api worker's router) decodes
 * percent-escapes when matching routes, so either shape reaches `/auth/...`
 * upstream even though the raw, still-encoded pathname doesn't literally
 * contain it. Guarding on the fully-decoded, then re-stripped form closes
 * both. Returns `null` for a malformed escape sequence — treated as 404 by
 * the caller rather than guessing.
 */
function decodedStrippedPathForGuard(pathname: string): string | null {
  try {
    return stripApiPrefix(decodeURIComponent(pathname));
  } catch {
    return null;
  }
}

/**
 * Shared transport for both `/api/*` proxy entry points below: rewrites
 * `request`'s pathname to `targetPathname`, forwards it to the api worker
 * (binding, else HTTP fallback), and applies Server-Timing. `routeLabel` is
 * the Server-Timing route tag — the guarded, decoded path for
 * `proxyApiRequest`, the fixed target for `proxyEnrollmentJoinRequest`.
 *
 * Structural choke point (issue #812): the one upstream hop every `/api/*`
 * proxy request makes, api-worker-bound rather than auth-bound — see
 * auth-proxy.ts's proxyAuthRequest for the "auth" counterpart.
 */
async function forwardToApi(
  env: ApiProxyEnv,
  request: Request,
  targetPathname: string,
  routeLabel: string,
): Promise<Response> {
  const url = new URL(request.url);
  const manual = new Request(request, { redirect: "manual" });
  url.pathname = targetPathname;
  const forwarded = new Request(url.toString(), manual);

  const timing = new ServerTiming();
  const upstream = await timeOp(
    () =>
      env.API
        ? env.API.fetch(forwarded)
        : fetch(rewriteOrigin(forwarded, env.UPLOADS_API_ORIGIN ?? LOCAL_API_ORIGIN_DEFAULT)),
    { name: "api", timing, route: routeLabel, thresholdMs: slowOpThresholdMs(env) },
  );
  return timing.applyTo(upstream, { disabled: serverTimingDisabled(env) });
}

/** Forwards `request` to the api worker (binding, else HTTP fallback), `/api` prefix stripped. */
export async function proxyApiRequest(env: ApiProxyEnv, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const decodedPath = decodedStrippedPathForGuard(url.pathname);
  if (decodedPath === null || decodedPath === "/auth" || decodedPath.startsWith("/auth/")) {
    return new Response("Not found", { status: 404 });
  }

  // The guard runs on the decoded form above; the request forwarded
  // upstream keeps the original (still-encoded where applicable) pathname
  // unchanged, `/api` prefix stripped literally rather than re-encoded.
  return forwardToApi(env, request, stripApiPrefix(url.pathname), decodedPath);
}

/**
 * Dedicated same-origin proxy for `POST /auth/enrollments/join` (issue #869
 * phase B) — the one apps/api route under `/auth/*` a signed-in browser
 * legitimately needs to reach cookie-authenticated. `proxyApiRequest`'s
 * `/api/[...path]` catch-all deliberately 404s every `/api/auth/*` path (see
 * its docblock) because that prefix is reserved for the Better Auth proxy
 * (`/api/auth/[...path].ts`, a distinct, more specific route Astro matches
 * first) — so this join call needs its own fixed-target route instead of
 * going through either of those. Mounted at `/api/enrollments/join`
 * (`pages/api/enrollments/join.ts`), forwarding straight to the api worker's
 * `/auth/enrollments/join`, cookie included exactly like `proxyApiRequest`
 * (same-origin browser request, cookie already rides along).
 */
export async function proxyEnrollmentJoinRequest(
  env: ApiProxyEnv,
  request: Request,
): Promise<Response> {
  return forwardToApi(env, request, "/auth/enrollments/join", "/auth/enrollments/join");
}

/**
 * SSR helper (Task D2): resolves one api call from Astro frontmatter over the
 * same transport as `proxyApiRequest`, forwarding the incoming request's
 * `cookie` header when `init` doesn't already carry one (see
 * `withInheritedCookie` in `proxy-transport.ts` — the same rule
 * `serverAuthFetch` applies) — a server-to-server fetch has no cookie jar of
 * its own. `pathAndQuery` is the same `/api/...`-prefixed path the browser
 * would hit (e.g. `/api/v1/workspaces/acme/summary`); `init` carries
 * method/body/etc.
 */
export async function serverApiFetch(
  env: ApiProxyEnv,
  request: Request,
  pathAndQuery: string,
  init: RequestInit = {},
): Promise<Response> {
  const target = new URL(pathAndQuery, request.url);
  const headers = withInheritedCookie(new Headers(init.headers), request);
  return proxyApiRequest(env, new Request(target, { ...init, headers }));
}

/**
 * A `fetch`-shaped adapter over {@link serverApiFetch}, for api-client.ts's
 * `opts.fetchImpl` — every api-client URL is already the same
 * `"/api/..."`-prefixed string `serverApiFetch` expects (api-client's
 * `apiOrigin` is `resolveSignedInOrigins`'s `"/api"` sentinel in this same
 * request), so no path translation is needed here.
 */
export function serverApiFetchImpl(env: ApiProxyEnv, request: Request): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) =>
    serverApiFetch(env, request, String(input), init)) as typeof fetch;
}
