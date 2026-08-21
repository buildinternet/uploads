/**
 * Same-origin api proxy (#731 phase D): `uploads.sh/api/<path>` forwards to
 * the api worker's `/<path>`. Route stays thin — all logic lives in
 * `../../lib/api-proxy`.
 */
import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { proxyApiRequest } from "../../lib/api-proxy";

export const prerender = false;

export const ALL: APIRoute = ({ request }) => proxyApiRequest(env, request);
