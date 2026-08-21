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
 * misrouted `/api/auth/*` request must never reach.
 */

import { rewriteOrigin } from "./proxy-transport";

export interface ApiProxyEnv {
  API?: { fetch(req: Request): Promise<Response> };
  UPLOADS_API_ORIGIN?: string;
}

const LOCAL_API_ORIGIN_DEFAULT = "http://127.0.0.1:8787";

/** Strips a leading `/api` from `pathname`, keeping the rest (including a bare `/api` → `/`). */
function stripApiPrefix(pathname: string): string {
  const stripped = pathname.replace(/^\/api(?=\/|$)/, "");
  return stripped === "" ? "/" : stripped;
}

/** Forwards `request` to the api worker (binding, else HTTP fallback), `/api` prefix stripped. */
export async function proxyApiRequest(env: ApiProxyEnv, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const strippedPath = stripApiPrefix(url.pathname);
  if (strippedPath === "/auth" || strippedPath.startsWith("/auth/")) {
    return new Response("Not found", { status: 404 });
  }

  const manual = new Request(request, { redirect: "manual" });
  url.pathname = strippedPath;
  const forwarded = new Request(url.toString(), manual);

  return env.API
    ? env.API.fetch(forwarded)
    : fetch(rewriteOrigin(forwarded, env.UPLOADS_API_ORIGIN ?? LOCAL_API_ORIGIN_DEFAULT));
}

/**
 * SSR helper (Task D2): resolves one api call from Astro frontmatter over the
 * same transport as `proxyApiRequest`, forwarding the incoming request's
 * `cookie` header — a server-to-server fetch has no cookie jar of its own.
 * `pathAndQuery` is the same `/api/...`-prefixed path the browser would hit
 * (e.g. `/api/v1/workspaces/acme/summary`); `init` carries method/body/etc.
 */
export async function serverApiFetch(
  env: ApiProxyEnv,
  request: Request,
  pathAndQuery: string,
  init: RequestInit = {},
): Promise<Response> {
  const target = new URL(pathAndQuery, request.url);
  const headers = new Headers(init.headers);
  headers.set("cookie", request.headers.get("cookie") ?? "");
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
