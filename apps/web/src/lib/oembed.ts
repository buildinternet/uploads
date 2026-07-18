/**
 * oEmbed 1.0 for public shareable pages (`/f/…`, `/g/…`).
 *
 * Pages advertise discovery via
 *   <link rel="alternate" type="application/json+oembed" href="/oembed?url=…">
 * The endpoint re-fetches the public API so private/missing objects never leak.
 * Pages set `X-Frame-Options: DENY`, so responses never iframe the page —
 * images use `photo`, videos use an inline `<video>` snippet, else `link`.
 */

import { fetchPublicFile, fileKind, filePath, isSafeKey } from "./public-file";
import {
  fetchPublicGallery,
  galleryItemPath,
  galleryPath,
  mediaKind as galleryMediaKind,
  type PublicGallery,
  type PublicGalleryItem,
} from "./public-gallery";

export const OEMBED_VERSION = "1.0" as const;
export const OEMBED_PROVIDER_NAME = "uploads.sh";
export const OEMBED_PROVIDER_URL = "https://uploads.sh";

/** Default photo edge when dimensions are unknown. */
export const DEFAULT_PHOTO_SIZE = 1200;
/** Default video frame when dimensions are unknown. */
export const DEFAULT_VIDEO_WIDTH = 1280;
export const DEFAULT_VIDEO_HEIGHT = 720;
/** Cap when the consumer omits maxwidth / maxheight. */
export const ABSOLUTE_MAX_EDGE = 4096;

const WORKSPACE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const GALLERY_ID_PATTERN = /^gal_[A-Za-z0-9_-]{22}$/;
/** Opaque item ids (UUIDs in production; tests use short tokens). */
const ITEM_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export type ShareTarget =
  | { kind: "file"; workspace: string; key: string }
  | { kind: "gallery"; id: string }
  | { kind: "gallery-item"; id: string; itemId: string };

export type OEmbedType = "photo" | "video" | "link";

export interface OEmbedBase {
  version: typeof OEMBED_VERSION;
  type: OEmbedType;
  title?: string;
  provider_name: typeof OEMBED_PROVIDER_NAME;
  provider_url: typeof OEMBED_PROVIDER_URL;
  cache_age?: number;
  thumbnail_url?: string;
  thumbnail_width?: number;
  thumbnail_height?: number;
}

export interface OEmbedPhoto extends OEmbedBase {
  type: "photo";
  url: string;
  width: number;
  height: number;
}

export interface OEmbedVideo extends OEmbedBase {
  type: "video";
  html: string;
  width: number;
  height: number;
}

export interface OEmbedLink extends OEmbedBase {
  type: "link";
}

export type OEmbedResponse = OEmbedPhoto | OEmbedVideo | OEmbedLink;

export type OEmbedResult =
  | { status: "ok"; body: OEmbedResponse }
  | { status: "bad_request"; message: string }
  | { status: "not_found" }
  | { status: "unavailable" }
  | { status: "not_implemented"; message: string };

export interface OEmbedRequest {
  /** Absolute shareable page URL from the `url` query param. */
  url: string;
  /** Origin of the oEmbed request (must match the share page origin). */
  requestOrigin: string;
  /** API origin used to resolve public file/gallery DTOs. */
  apiOrigin: string;
  maxwidth?: number;
  maxheight?: number;
  /** Only `json` is supported; omit or `json` is fine. */
  format?: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

/** Absolute discovery href for a shareable page's canonical URL. */
export function oembedDiscoveryHref(pageUrl: string, siteOrigin: string): string {
  const endpoint = new URL("/oembed", siteOrigin);
  endpoint.searchParams.set("url", pageUrl);
  endpoint.searchParams.set("format", "json");
  return endpoint.href;
}

/** Positive integer query param; rejects non-integers and non-positives. */
export function parsePositiveInt(raw: string | null | undefined): number | undefined {
  if (raw == null || raw === "" || !/^\d+$/.test(raw)) return undefined;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n <= 0) return undefined;
  return Math.min(n, ABSOLUTE_MAX_EDGE);
}

/**
 * Parse a shareable page URL into a target when its origin matches
 * `requestOrigin` (blocks using this endpoint as an open proxy).
 */
export function parseShareableUrl(rawUrl: string, requestOrigin: string): ShareTarget | null {
  let page: URL;
  let expected: URL;
  try {
    page = new URL(rawUrl);
    expected = new URL(requestOrigin);
  } catch {
    return null;
  }
  if (page.origin !== expected.origin) return null;
  if (page.protocol !== "https:" && page.protocol !== "http:") return null;

  const parts: string[] = [];
  for (const segment of page.pathname.split("/").filter(Boolean)) {
    try {
      parts.push(decodeURIComponent(segment));
    } catch {
      return null;
    }
  }

  if (parts[0] === "f" && parts.length >= 3) {
    const workspace = parts[1]!;
    const key = parts.slice(2).join("/");
    if (!WORKSPACE_PATTERN.test(workspace) || !isSafeKey(key)) return null;
    return { kind: "file", workspace, key };
  }

  if (parts[0] === "g" && parts.length === 2) {
    const id = parts[1]!;
    if (!GALLERY_ID_PATTERN.test(id)) return null;
    return { kind: "gallery", id };
  }

  if (parts[0] === "g" && parts.length === 3) {
    const id = parts[1]!;
    const itemId = parts[2]!;
    if (!GALLERY_ID_PATTERN.test(id) || !ITEM_ID_PATTERN.test(itemId)) return null;
    return { kind: "gallery-item", id, itemId };
  }

  return null;
}

/** Fit a natural box into optional maxwidth/maxheight, preserving aspect ratio. */
export function fitDimensions(
  naturalWidth: number,
  naturalHeight: number,
  maxwidth?: number,
  maxheight?: number,
): { width: number; height: number } {
  const width = Math.max(1, Math.round(naturalWidth));
  const height = Math.max(1, Math.round(naturalHeight));
  const scale = Math.min(
    1,
    (maxwidth ?? ABSOLUTE_MAX_EDGE) / width,
    (maxheight ?? ABSOLUTE_MAX_EDGE) / height,
  );
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function escapeHtmlAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function provider(
  title?: string,
): Pick<OEmbedBase, "version" | "provider_name" | "provider_url" | "title" | "cache_age"> {
  return {
    version: OEMBED_VERSION,
    provider_name: OEMBED_PROVIDER_NAME,
    provider_url: OEMBED_PROVIDER_URL,
    cache_age: 300,
    ...(title ? { title } : {}),
  };
}

function forMedia(
  kind: "image" | "video" | "file" | "unsupported",
  mediaUrl: string,
  title: string,
  maxwidth?: number,
  maxheight?: number,
): OEmbedResponse {
  if (kind === "image") {
    const { width, height } = fitDimensions(
      DEFAULT_PHOTO_SIZE,
      DEFAULT_PHOTO_SIZE,
      maxwidth,
      maxheight,
    );
    return { ...provider(title), type: "photo", url: mediaUrl, width, height };
  }
  if (kind === "video") {
    const { width, height } = fitDimensions(
      DEFAULT_VIDEO_WIDTH,
      DEFAULT_VIDEO_HEIGHT,
      maxwidth,
      maxheight,
    );
    return {
      ...provider(title),
      type: "video",
      width,
      height,
      html: `<video src="${escapeHtmlAttr(mediaUrl)}" width="${width}" height="${height}" controls playsinline preload="metadata" style="max-width:100%;height:auto"></video>`,
    };
  }
  return { ...provider(title), type: "link" };
}

function filenameFromKey(key: string): string {
  const slash = key.lastIndexOf("/");
  return slash === -1 ? key : key.slice(slash + 1) || key;
}

function coverThumbnail(
  gallery: PublicGallery,
  maxwidth?: number,
  maxheight?: number,
): Pick<OEmbedLink, "thumbnail_url" | "thumbnail_width" | "thumbnail_height"> | undefined {
  const items = gallery.items.toSorted(
    (a, b) => a.position - b.position || a.id.localeCompare(b.id),
  );
  const prefer = gallery.coverItemId
    ? items.find((item) => item.id === gallery.coverItemId)
    : undefined;
  const cover: PublicGalleryItem | undefined =
    prefer && galleryMediaKind(prefer) === "image" && prefer.url
      ? prefer
      : items.find((item) => galleryMediaKind(item) === "image" && item.url);
  if (!cover?.url) return undefined;
  const { width, height } = fitDimensions(
    DEFAULT_PHOTO_SIZE,
    DEFAULT_PHOTO_SIZE,
    maxwidth,
    maxheight,
  );
  return { thumbnail_url: cover.url, thumbnail_width: width, thumbnail_height: height };
}

function fromFetchFailure(
  status: "not_found" | "auth_required" | "unavailable",
): Extract<OEmbedResult, { status: "not_found" | "unavailable" }> {
  return status === "unavailable" ? { status: "unavailable" } : { status: "not_found" };
}

async function resolveTarget(target: ShareTarget, options: OEmbedRequest): Promise<OEmbedResult> {
  const api = {
    origin: options.apiOrigin,
    fetch: options.fetch,
    timeoutMs: options.timeoutMs,
  };
  const { maxwidth, maxheight } = options;

  if (target.kind === "file") {
    const result = await fetchPublicFile(target.workspace, target.key, api);
    if (result.status !== "ok") return fromFetchFailure(result.status);
    const file = result.file;
    return {
      status: "ok",
      body: forMedia(
        fileKind(file.contentType),
        file.url,
        filenameFromKey(file.key),
        maxwidth,
        maxheight,
      ),
    };
  }

  const result = await fetchPublicGallery(target.id, api);
  if (result.status !== "ok") return fromFetchFailure(result.status);
  const gallery = result.gallery;

  if (target.kind === "gallery") {
    return {
      status: "ok",
      body: {
        ...provider(gallery.title),
        type: "link",
        ...coverThumbnail(gallery, maxwidth, maxheight),
      },
    };
  }

  const item = gallery.items.find((entry) => entry.id === target.itemId);
  if (!item) return { status: "not_found" };
  const kind = galleryMediaKind(item);
  if (kind === "missing" || !item.url) {
    return { status: "ok", body: { ...provider(item.filename), type: "link" } };
  }
  return {
    status: "ok",
    body: forMedia(kind, item.url, item.filename, maxwidth, maxheight),
  };
}

/** Validate format + share URL, fetch public data, return a typed result. */
export async function resolveOEmbed(options: OEmbedRequest): Promise<OEmbedResult> {
  if ((options.format ?? "json").toLowerCase() !== "json") {
    return { status: "not_implemented", message: "Only format=json is supported." };
  }
  if (!options.url || options.url.length > 4096) {
    return { status: "bad_request", message: "Missing or invalid url parameter." };
  }
  const target = parseShareableUrl(options.url, options.requestOrigin);
  if (!target) return { status: "not_found" };
  return resolveTarget(target, options);
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Accept",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
} as const;

/** Map an {@link OEmbedResult} to JSON + CORS. */
export function oembedHttpResponse(result: OEmbedResult): Response {
  if (result.status === "ok") {
    return new Response(JSON.stringify(result.body), {
      status: 200,
      headers: {
        ...CORS,
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "public, max-age=300",
      },
    });
  }

  const status =
    result.status === "bad_request"
      ? 400
      : result.status === "not_implemented"
        ? 501
        : result.status === "unavailable"
          ? 503
          : 404;
  const error =
    result.status === "bad_request" || result.status === "not_implemented"
      ? result.message
      : result.status === "unavailable"
        ? "Service unavailable"
        : "Not found";

  return new Response(JSON.stringify({ error }), {
    status,
    headers: {
      ...CORS,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

/** OPTIONS preflight for cross-origin oEmbed consumers. */
export function oembedOptionsResponse(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Accept",
      "Access-Control-Max-Age": "86400",
    },
  });
}

/** Canonical absolute URL for a share target — used by tests and callers. */
export function sharePageUrl(siteOrigin: string, target: ShareTarget): string {
  const path =
    target.kind === "file"
      ? filePath(target.workspace, target.key)
      : target.kind === "gallery"
        ? galleryPath(target.id)
        : galleryItemPath(target.id, target.itemId);
  return new URL(path, siteOrigin).href;
}
