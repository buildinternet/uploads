/**
 * Same-origin RFC 8414 discovery proxy (#731 phase A): forwards
 * `uploads.sh/.well-known/oauth-authorization-server[/...]` (e.g. the
 * `/api/auth`-suffixed variant) to the auth worker, which already rewrites
 * these well-known aliases to Better Auth's real paths (see
 * apps/auth/src/index.ts). The issuer value in the response follows
 * `BETTER_AUTH_URL` and is correct both before and after the phase C flip.
 *
 * A sibling `index.ts` handles the bare (no sub-path) route in case Astro's
 * rest-param matching doesn't cover it.
 */
import type { APIRoute } from "astro";
import { proxyAuthRequest } from "../../../lib/auth-proxy";
import { env } from "../../../lib/worker-env";

export const prerender = false;

export const ALL: APIRoute = ({ request }) => proxyAuthRequest(env, request);
