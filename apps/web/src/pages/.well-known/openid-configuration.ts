/**
 * Same-origin RFC 8414 discovery proxy (#731 phase A):
 * `uploads.sh/.well-known/openid-configuration` forwards to the auth worker.
 * See `.well-known/oauth-authorization-server/[...path].ts` for the sibling
 * discovery route and rationale.
 */
import type { APIRoute } from "astro";
import { proxyAuthRequest } from "../../lib/auth-proxy";
import { env } from "../../lib/worker-env";

export const prerender = false;

export const ALL: APIRoute = ({ request }) => proxyAuthRequest(env, request);
