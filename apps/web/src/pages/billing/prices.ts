/**
 * Same-origin proxy for the auth worker's public `/billing/prices` (#731
 * phase B). `plan-prices.ts`'s `fetchProPrice` hits this relative path (its
 * `authOrigin` sentinel is `""`) rather than `auth.uploads.sh` directly.
 *
 * This route lives outside `.well-known` (unlike the discovery proxies), so
 * it can import `cloudflare:workers`'s `env` directly instead of going
 * through `lib/worker-env` — see that module's comment for the oxlint
 * dot-directory quirk this route doesn't hit.
 */
import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { proxyAuthRequest } from "../../lib/auth-proxy";

export const prerender = false;

export const ALL: APIRoute = ({ request }) => proxyAuthRequest(env, request);
