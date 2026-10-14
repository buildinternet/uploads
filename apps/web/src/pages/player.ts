/**
 * Iframe player for a public video share page.
 *
 *   GET /player?url=<absolute share page url>
 *
 * Twitter player cards and oEmbed video iframes land here. Only same-origin
 * share URLs are accepted. The video URL is re-fetched from the public API.
 */
import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { embedHttpResponse, resolveEmbedPlayer } from "../lib/embed-player";
import { publicApiFetch } from "../lib/ssr-fetch";

export const prerender = false;

export const GET: APIRoute = async ({ url }) => {
  const apiOrigin =
    env.UPLOADS_API_ORIGIN ?? import.meta.env.PUBLIC_UPLOADS_API_ORIGIN ?? "https://api.uploads.sh";

  const result = await resolveEmbedPlayer({
    url: url.searchParams.get("url") ?? "",
    requestOrigin: url.origin,
    apiOrigin,
    fetch: publicApiFetch(env),
  });

  return embedHttpResponse(result);
};
