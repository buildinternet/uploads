/**
 * Cloudflare Image Transformations wrapper for thumbnail-sized renders.
 *
 * Thumbnails used to inline the full-size original and let the browser
 * downscale it, which made text look jagged. For files served from hosts on
 * the uploads.sh zone (where Transformations is enabled) we rewrite to the
 * same-origin `/cdn-cgi/image/...` path form instead; any other host — BYO
 * buckets, custom embed bases — passes through untouched, as do SVGs
 * (already resolution-independent) and URLs that are already transforms.
 *
 * `fit=scale-down` never upscales small originals; `onerror=redirect` falls
 * back to the original bytes if the transform fails. Callers pass a width of
 * roughly 2× the CSS size so tiles stay crisp on retina displays.
 *
 * `format` defaults to `auto` (Cloudflare picks from the request's Accept
 * header). Unfurl cards pass `jpeg` or `png` instead: crawlers often omit
 * Accept, and `auto` can answer with a type they will not preview.
 */

// Only hosts on zones WE control, with Image Transformations enabled. Never
// add customer-controlled hosts (BYO-bucket publicBaseUrl domains) here: the
// `/cdn-cgi/image/` path and the `onerror=redirect` fallback both exist only
// on Cloudflare zones with Transformations turned on — on anyone else's zone
// the rewrite serves a 404 with no fallback to the original bytes.
const TRANSFORMABLE_HOSTS = new Set(["embed.uploads.sh", "storage.uploads.sh", "store.uploads.sh"]);

/** `auto` is the tile default. `jpeg` and `png` are the crawler-stable formats. */
export type ThumbFormat = "auto" | "jpeg" | "png";

export interface ThumbUrlOptions {
  format?: ThumbFormat;
}

export function thumbUrl(src: string, width: number, options?: ThumbUrlOptions): string;
export function thumbUrl(
  src: string | null,
  width: number,
  options?: ThumbUrlOptions,
): string | null;
export function thumbUrl(
  src: string | null,
  width: number,
  options?: ThumbUrlOptions,
): string | null {
  if (src === null) return null;
  let url: URL;
  try {
    url = new URL(src);
  } catch {
    return src;
  }
  if (!TRANSFORMABLE_HOSTS.has(url.hostname.toLowerCase())) return src;
  if (url.pathname.startsWith("/cdn-cgi/")) return src;
  if (url.pathname.toLowerCase().endsWith(".svg")) return src;
  const format = options?.format === "jpeg" || options?.format === "png" ? options.format : "auto";
  const transform = `width=${width},quality=82,fit=scale-down,format=${format},onerror=redirect`;
  return `${url.origin}/cdn-cgi/image/${transform}${url.pathname}${url.search}`;
}
