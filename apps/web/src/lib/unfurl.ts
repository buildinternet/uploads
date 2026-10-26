/**
 * Open Graph + Twitter card tags for public share pages, and the minimal
 * iframe player those cards point at.
 *
 * Video bytes are included only when the caller already resolved a public
 * object (the public API 401s private files and 404s missing or expired
 * ones). This module still refuses anything that is not an https media URL
 * of a known video type, so a bad caller cannot emit a private or non-video
 * target into `og:video`.
 *
 * Share pages themselves stay unframeable (`X-Frame-Options: DENY`). The
 * player document is a separate response that allows framing.
 */

import { OG_DEFAULT_IMAGE, OG_SITE_NAME } from "./og";
import { thumbUrl, type ThumbFormat } from "./thumb-url";

export const DEFAULT_VIDEO_WIDTH = 1280;
export const DEFAULT_VIDEO_HEIGHT = 720;
/** Card image width. Large enough for Discord/Slack/X, small enough to fetch quickly. */
const UNFURL_IMAGE_WIDTH = 1200;

/** Declared frame cap. Larger stored values fall back to the default frame. */
const MAX_DECLARED_DIMENSION = 8192;

const VIDEO_TYPES = new Set(["video/mp4", "video/webm", "video/quicktime"]);

export type UnfurlKind = "image" | "video" | "other";

export interface UnfurlInput {
  /** Canonical absolute URL of the share page being unfurled. */
  pageUrl: string;
  /** Origin that serves `/player` (the share page's own origin). */
  siteOrigin: string;
  title: string;
  description: string;
  kind: UnfurlKind;
  /** Public storage URL of the file. Null when the object is not public. */
  mediaUrl?: string | null;
  contentType?: string | null;
  /** Derived poster frame. Same public storage host as a video's bytes. */
  posterUrl?: string | null;
  /** Stored display width (`video.width`). Omitted when unknown. */
  width?: number | null;
  /** Stored display height (`video.height`). Omitted when unknown. */
  height?: number | null;
  /** Image used when the file has no public image or poster. */
  fallbackImage?: string;
}

export interface UnfurlTag {
  attr: "property" | "name";
  name: string;
  content: string;
}

export interface CollectionPreviewItem {
  id?: string;
  kind: string;
  url?: string | null;
  posterUrl?: string | null;
}

export interface VideoFrame {
  width: number;
  height: number;
}

/** https URL with no embedded credentials. http and other schemes are rejected. */
export function isPublicMediaUrl(value: string | null | undefined): value is string {
  if (!value || value.length > 2048) return false;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return false;
    if (url.username || url.password) return false;
    return true;
  } catch {
    return false;
  }
}

/** Content type Discord/Slack/X will treat as a playable video, or null. */
export function videoContentType(contentType: string | null | undefined): string | null {
  if (!contentType) return null;
  const base = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return VIDEO_TYPES.has(base) ? base : null;
}

/**
 * Stored dimensions when both are positive and within the declared cap.
 * Otherwise the 16:9 default frame.
 */
export function videoFrame(
  width: number | null | undefined,
  height: number | null | undefined,
): VideoFrame {
  const w = declaredDimension(width);
  const h = declaredDimension(height);
  if (w != null && h != null) return { width: w, height: h };
  return { width: DEFAULT_VIDEO_WIDTH, height: DEFAULT_VIDEO_HEIGHT };
}

function declaredDimension(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) return null;
  if (value <= 0 || value > MAX_DECLARED_DIMENSION) return null;
  return value;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Absolute URL of the iframe player for a share page.
 * Returns null when the player would not live on the same origin as the page.
 */
export function playerPageUrl(siteOrigin: string, pageUrl: string): string | null {
  let endpoint: URL;
  let page: URL;
  try {
    endpoint = new URL("/player", siteOrigin);
    page = new URL(pageUrl);
  } catch {
    return null;
  }
  if (endpoint.origin !== page.origin) return null;
  if (endpoint.protocol !== "https:" && endpoint.protocol !== "http:") return null;
  endpoint.searchParams.set("url", pageUrl);
  const href = endpoint.href;
  // Discord drops the whole preview when any meta URL exceeds 2048 characters.
  if (href.length > 2048) return null;
  return href;
}

/** First public image, else the first public poster. Cover id wins when set. */
export function collectionPreview(
  items: CollectionPreviewItem[],
  preferredId?: string | null,
): { url: string; source: "image" | "poster" } | null {
  const preferred = preferredId ? items.filter((item) => item.id === preferredId) : [];
  const rest = preferredId ? items.filter((item) => item.id !== preferredId) : items;
  const ordered = [...preferred, ...rest];
  for (const item of ordered) {
    if (item.kind === "image" && isPublicMediaUrl(item.url)) {
      return { url: item.url, source: "image" };
    }
  }
  for (const item of ordered) {
    if (isPublicMediaUrl(item.posterUrl)) return { url: item.posterUrl, source: "poster" };
  }
  return null;
}

function meta(attr: "property" | "name", name: string, content: string): UnfurlTag {
  return { attr, name, content };
}

const ALPHA_IMAGE_TYPES = new Set(["image/png", "image/gif", "image/webp", "image/avif"]);

/** PNG when the image can carry transparency. JPEG for posters and everything else. */
function cardFormat(
  url: string,
  contentType: string | null | undefined,
): Exclude<ThumbFormat, "auto"> {
  const base = contentType?.split(";")[0]?.trim().toLowerCase() ?? "";
  if (ALPHA_IMAGE_TYPES.has(base)) return "png";
  if (base === "image/jpeg" || base === "image/jpg") return "jpeg";
  try {
    if (/\.(png|gif|webp|avif)$/i.test(new URL(url).pathname)) return "png";
  } catch {
    // Unparseable URL: jpeg is the crawler-safe default.
  }
  return "jpeg";
}

/**
 * Resize a card image on hosts `thumbUrl` already transforms. Other hosts,
 * and a result that would exceed Discord's 2048-character URL cap, stay raw.
 */
function cardImage(url: string, contentType: string | null | undefined): string {
  const transformed = thumbUrl(url, UNFURL_IMAGE_WIDTH, { format: cardFormat(url, contentType) });
  return transformed.length <= 2048 ? transformed : url;
}

/** Tags for one share page. Video tags are omitted unless the file is a public video. */
export function unfurlTags(input: UnfurlInput): UnfurlTag[] {
  const fallback = input.fallbackImage ?? OG_DEFAULT_IMAGE;
  const fileImage =
    input.kind === "image" && isPublicMediaUrl(input.mediaUrl) ? input.mediaUrl : null;
  const rawImage = fileImage ?? (isPublicMediaUrl(input.posterUrl) ? input.posterUrl : fallback);
  // Posters are derived JPEGs. The file content type belongs to the video or PDF, not the poster.
  const imageUrl = cardImage(rawImage, fileImage ? input.contentType : null);
  const videoType = input.kind === "video" ? videoContentType(input.contentType) : null;
  const videoUrl = videoType && isPublicMediaUrl(input.mediaUrl) ? input.mediaUrl : null;
  const frame = videoFrame(input.width, input.height);
  const player = videoUrl ? playerPageUrl(input.siteOrigin, input.pageUrl) : null;

  const tags: UnfurlTag[] = [
    meta("property", "og:type", videoUrl ? "video.other" : "website"),
    meta("property", "og:title", input.title),
    meta("property", "og:description", input.description),
    meta("property", "og:url", input.pageUrl),
    meta("property", "og:site_name", OG_SITE_NAME),
    meta("property", "og:image", imageUrl),
    meta("property", "og:image:alt", input.title),
  ];

  if (videoUrl && videoType) {
    tags.push(
      meta("property", "og:video", videoUrl),
      meta("property", "og:video:secure_url", videoUrl),
      meta("property", "og:video:type", videoType),
      meta("property", "og:video:width", String(frame.width)),
      meta("property", "og:video:height", String(frame.height)),
    );
  }

  tags.push(
    meta("name", "twitter:card", videoUrl && player ? "player" : "summary_large_image"),
    meta("name", "twitter:title", input.title),
    meta("name", "twitter:description", input.description),
    meta("name", "twitter:image", imageUrl),
    meta("name", "twitter:image:alt", input.title),
  );

  if (videoUrl && videoType && player) {
    tags.push(
      meta("name", "twitter:player", player),
      meta("name", "twitter:player:width", String(frame.width)),
      meta("name", "twitter:player:height", String(frame.height)),
      meta("name", "twitter:player:stream", videoUrl),
      meta("name", "twitter:player:stream:content_type", videoType),
    );
  }

  return tags;
}

/** HTML meta tags. Attribute values are escaped. */
export function renderUnfurlMeta(input: UnfurlInput): string {
  return unfurlTags(input)
    .map(
      (entry) =>
        `<meta ${entry.attr}="${escapeHtml(entry.name)}" content="${escapeHtml(entry.content)}" />`,
    )
    .join("\n");
}

export function renderPlayerIframe(options: {
  siteOrigin: string;
  pageUrl: string;
  width: number;
  height: number;
  title: string;
}): string | null {
  const src = playerPageUrl(options.siteOrigin, options.pageUrl);
  if (!src) return null;
  const width = declaredDimension(options.width);
  const height = declaredDimension(options.height);
  if (width == null || height == null) return null;
  return `<iframe src="${escapeHtml(src)}" width="${width}" height="${height}" title="${escapeHtml(options.title)}" frameborder="0" allow="autoplay; fullscreen; picture-in-picture" allowfullscreen></iframe>`;
}

/**
 * Minimal player document: one `<video>` and no other origin content.
 * Returns null unless `videoUrl` is a public https video.
 */
export function renderPlayerDocument(options: {
  title: string;
  videoUrl: string;
  contentType: string | null | undefined;
  posterUrl?: string | null;
}): string | null {
  if (!isPublicMediaUrl(options.videoUrl) || !videoContentType(options.contentType)) return null;
  const poster = isPublicMediaUrl(options.posterUrl)
    ? ` poster="${escapeHtml(cardImage(options.posterUrl, null))}"`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow, noarchive" />
<title>${escapeHtml(options.title)}</title>
<style>html,body{margin:0;height:100%;background:#000}video{display:block;width:100%;height:100%;object-fit:contain;background:#000}</style>
</head>
<body>
<video src="${escapeHtml(options.videoUrl)}"${poster} controls playsinline preload="metadata"></video>
</body>
</html>`;
}
