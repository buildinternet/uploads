/**
 * Same-origin proxy for `POST /auth/enrollments/join` (issue #869 phase B).
 * Route stays thin — see `proxyEnrollmentJoinRequest` in `../../../lib/api-proxy`
 * for why this needs its own route rather than going through `/api/[...path]`.
 */
import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { proxyEnrollmentJoinRequest } from "../../../lib/api-proxy";

export const prerender = false;

export const POST: APIRoute = ({ request }) => proxyEnrollmentJoinRequest(env, request);
