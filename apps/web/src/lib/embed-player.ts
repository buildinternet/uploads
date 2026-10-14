/**
 * `/player` — the iframe target for Twitter player cards and oEmbed video.
 *
 * The share page URL is only a lookup key. The `<video src>` always comes
 * back from the public API, which 401s private files and 404s missing or
 * expired ones. This response allows framing; share pages do not.
 */

import { loadShareMedia, parseShareableUrl, type OEmbedRequest } from "./oembed";
import { renderPlayerDocument } from "./unfurl";

export const EMBED_PLAYER_CSP = [
  "default-src 'none'",
  "media-src https:",
  "img-src https:",
  "style-src 'unsafe-inline'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors *",
  "object-src 'none'",
].join("; ");

export type EmbedPlayerResult =
  | { status: "ok"; html: string }
  | { status: "not_found" }
  | { status: "unavailable" };

const EMPTY_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8" /><meta name="robots" content="noindex, nofollow, noarchive" /><title>Unavailable</title></head><body></body></html>`;

export async function resolveEmbedPlayer(
  options: Pick<OEmbedRequest, "url" | "requestOrigin" | "apiOrigin" | "fetch" | "timeoutMs">,
): Promise<EmbedPlayerResult> {
  if (!options.url || options.url.length > 4096) return { status: "not_found" };
  const target = parseShareableUrl(options.url, options.requestOrigin);
  if (!target) return { status: "not_found" };
  // Index pages are collections, not a single video.
  if (target.kind === "gallery" || target.kind === "feed") return { status: "not_found" };

  const loaded = await loadShareMedia(target, options);
  if (loaded.status !== "ok") return loaded;
  const media = loaded.media;
  if (media.presentation !== "video" || !media.mediaUrl) return { status: "not_found" };

  const html = renderPlayerDocument({
    title: media.title,
    videoUrl: media.mediaUrl,
    contentType: media.contentType,
    posterUrl: media.posterUrl,
  });
  if (!html) return { status: "not_found" };
  return { status: "ok", html };
}

/** HTML response. No `X-Frame-Options` — CSP `frame-ancestors *` is the allow. */
export function embedHttpResponse(result: EmbedPlayerResult): Response {
  const headers: Record<string, string> = {
    "Content-Security-Policy": EMBED_PLAYER_CSP,
    "Content-Type": "text/html; charset=utf-8",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Robots-Tag": "noindex, nofollow, noarchive",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Cache-Control": "no-store",
  };
  if (result.status === "ok") {
    return new Response(result.html, { status: 200, headers });
  }
  return new Response(EMPTY_PAGE, {
    status: result.status === "unavailable" ? 503 : 404,
    headers,
  });
}
