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
 */

const TRANSFORMABLE_HOSTS = new Set(["embed.uploads.sh", "storage.uploads.sh", "store.uploads.sh"]);

export function thumbUrl(src: string, width: number): string;
export function thumbUrl(src: string | null, width: number): string | null;
export function thumbUrl(src: string | null, width: number): string | null {
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
  const options = `width=${width},quality=82,fit=scale-down,format=auto,onerror=redirect`;
  return `${url.origin}/cdn-cgi/image/${options}${url.pathname}${url.search}`;
}
