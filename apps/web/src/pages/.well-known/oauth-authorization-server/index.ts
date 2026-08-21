/**
 * Bare `/.well-known/oauth-authorization-server` (no sub-path). See the
 * sibling `[...path].ts` for the general case and rationale.
 */
import type { APIRoute } from "astro";
import { proxyAuthRequest } from "../../../lib/auth-proxy";
import { env } from "../../../lib/worker-env";

export const prerender = false;

export const ALL: APIRoute = ({ request }) => proxyAuthRequest(env, request);
