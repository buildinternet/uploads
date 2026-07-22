/**
 * `/openapi.json` — the conventional path agent-facing crawlers probe for an
 * OpenAPI document (integrations.sh checks it before `/swagger.json`,
 * `/api/openapi.json`, …). The canonical file stays at
 * `public/.well-known/openapi.json` (referenced from the RFC 9727 api-catalog,
 * llms.txt, and auth.md); this route re-serves those same bytes so both paths
 * resolve without a second copy drifting out of date.
 *
 * Prerendered: Astro emits `dist/openapi.json` at build time, so it is served
 * off the ASSETS binding like the rest of the discovery documents. Response
 * headers come from `public/_headers`.
 */
import type { APIRoute } from "astro";
import spec from "../../public/.well-known/openapi.json";

export const prerender = true;

export const GET: APIRoute = () =>
  new Response(`${JSON.stringify(spec, null, 2)}\n`, {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
