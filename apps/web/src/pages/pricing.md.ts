/**
 * /pricing.md — raw Markdown twin of /pricing for agents and crawlers that
 * probe for it. Prerendered; headers come from public/_headers.
 */
import type { APIRoute } from "astro";
import { PRICING_MARKDOWN } from "../lib/pricing";

export const prerender = true;

export const GET: APIRoute = () =>
  new Response(PRICING_MARKDOWN, {
    headers: { "content-type": "text/markdown; charset=utf-8" },
  });
