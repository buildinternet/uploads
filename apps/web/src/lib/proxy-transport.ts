/**
 * Shared transport bit for the same-origin proxies (#731): `auth-proxy.ts`
 * (phase A) and `api-proxy.ts` (phase D) both rebuild an incoming request
 * against a different origin for their astro-dev HTTP fallback. Pulled out
 * once both existed rather than duplicated.
 */

/** Rebuilds `request` against `origin`, keeping method/headers/body/redirect. */
export function rewriteOrigin(request: Request, origin: string): Request {
  const url = new URL(request.url);
  const target = new URL(origin.replace(/\/$/, ""));
  url.protocol = target.protocol;
  url.host = target.host;
  return new Request(url.toString(), request);
}

/**
 * The one cookie-forwarding rule both `serverApiFetch` (api-proxy.ts) and
 * `serverAuthFetch` (auth-proxy.ts) apply when building a server-to-server
 * request from Astro frontmatter: fill the `cookie` header from the
 * incoming request only when `init` doesn't already carry one — a caller
 * that already set its own `cookie` header (e.g. api-client.ts's
 * `sessionFetchInit(opts.cookie)`) is left alone rather than overwritten.
 * Behavior-neutral for every current caller: every SSR call site passes the
 * same `Astro.request.headers.get("cookie")` value both as its own
 * `opts.cookie` and as the incoming request's header, so filling vs.
 * overwriting produces an identical header either way.
 */
export function withInheritedCookie(headers: Headers, request: Request): Headers {
  if (!headers.has("cookie")) {
    headers.set("cookie", request.headers.get("cookie") ?? "");
  }
  return headers;
}
