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
