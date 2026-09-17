/**
 * User-Agent for server-side (SSR) fetches the `uploads-web` worker makes to
 * sibling origins (`api.uploads.sh`, `storage.uploads.sh`, …).
 *
 * Cloudflare Workers' `fetch()` sends no `User-Agent` by default, and the API
 * zone's WAF blocks empty-UA requests as bot traffic — which silently 503'd
 * every `/f/`, `/g/`, and `/c/` page because their SSR subrequest was rejected
 * at the edge before reaching the API worker. Identifying ourselves keeps the
 * bot defense intact for real empty-UA traffic while letting our own
 * server-to-server calls through.
 */
export const SSR_USER_AGENT = "uploads-web (+https://uploads.sh; SSR)";

/** Narrow shape {@link publicApiFetch} needs — the optional `API` service binding. */
export interface PublicApiFetchEnv {
  API?: Fetcher;
}

/**
 * `fetch` impl for public, unauthenticated SSR reads of the api worker
 * (`/public/files|galleries|feeds/...`).
 *
 * Prefers the `API` service binding (production/preview): a direct
 * worker-to-worker call that never leaves the account, so it is faster, saves
 * a billable edge subrequest, and — the reason for #998 — bypasses the public
 * edge entirely, immune to WAF/bot rules like the empty-`User-Agent` block
 * that 503'd every `/f/`, `/g/`, and `/c/` page. Falls back to global `fetch`
 * against the public origin when the binding is absent, which is the case
 * under `astro dev` (no service bindings to sibling wrangler processes) —
 * mirroring the binding-else-HTTP pattern in `api-proxy.ts`/`auth-proxy.ts`.
 *
 * The `SSR_USER_AGENT` header the callers set stays load-bearing only on that
 * dev/HTTP fallback path (and on storage-origin fetches, which have no
 * binding); over the binding it is harmless belt-and-suspenders.
 */
export function publicApiFetch(env: PublicApiFetchEnv): typeof globalThis.fetch {
  const api = env.API;
  if (!api) return globalThis.fetch;
  // Fetcher.fetch is fetch-shaped (RequestInfo | URL, init) but carries
  // Cloudflare's CfProperties init variant, so cast through unknown.
  return api.fetch.bind(api) as unknown as typeof globalThis.fetch;
}
