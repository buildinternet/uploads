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
