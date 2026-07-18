/**
 * oEmbed 1.0 endpoint for public shareable pages.
 *
 *   GET /oembed?url=<absolute page url>&format=json&maxwidth=&maxheight=
 *
 * Discovery links on `/f/…` and `/g/…` point here. Only same-origin shareable
 * page URLs are accepted (no open-proxy). See `src/lib/oembed.ts`.
 */
import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import {
  oembedHttpResponse,
  oembedOptionsResponse,
  parsePositiveInt,
  resolveOEmbed,
} from "../lib/oembed";

export const prerender = false;

export const OPTIONS: APIRoute = () => oembedOptionsResponse();

export const GET: APIRoute = async ({ url }) => {
  const apiOrigin =
    env.UPLOADS_API_ORIGIN ?? import.meta.env.PUBLIC_UPLOADS_API_ORIGIN ?? "https://api.uploads.sh";

  const result = await resolveOEmbed({
    url: url.searchParams.get("url") ?? "",
    requestOrigin: url.origin,
    apiOrigin,
    maxwidth: parsePositiveInt(url.searchParams.get("maxwidth")),
    maxheight: parsePositiveInt(url.searchParams.get("maxheight")),
    format: url.searchParams.get("format") ?? "json",
  });

  return oembedHttpResponse(result);
};
