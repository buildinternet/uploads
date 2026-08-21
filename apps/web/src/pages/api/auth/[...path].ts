/**
 * Same-origin auth proxy (#731 phase A): `uploads.sh/api/auth/*` forwards
 * unchanged to the auth worker. Route stays thin — all logic lives in
 * `../../../lib/auth-proxy`.
 */
import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { proxyAuthRequest } from "../../../lib/auth-proxy";

export const prerender = false;

export const ALL: APIRoute = ({ request }) => proxyAuthRequest(env, request);
