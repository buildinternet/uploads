import { CF_RUM_CONNECT_SRC, CF_RUM_SCRIPT_SRC, STYLE_SRC_SELF_AND_INLINE } from "./csp";

export interface PublicGalleryItem {
  id: string;
  filename: string;
  position: number;
  caption: string | null;
  altText: string | null;
  status: "available" | "missing";
  url: string | null;
  /** Embed-host URL when the dual-host policy applies; null otherwise. Always present (see gallery-service.ts). */
  embedUrl: string | null;
  contentType: string | null;
}

export interface PublicGalleryReference {
  provider: string;
  resourceType: string;
  coordinate: string;
  canonicalUrl: string | null;
}

export interface PublicGallery {
  id: string;
  title: string;
  description: string | null;
  visibility: "public";
  coverItemId: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  items: PublicGalleryItem[];
  references: PublicGalleryReference[];
}

export type GalleryFetchResult =
  | { status: "ok"; gallery: PublicGallery }
  | { status: "not_found" }
  | { status: "unavailable" };

export type MediaKind = "image" | "video" | "file" | "unsupported" | "missing";

const imageTypes = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"]);
const videoTypes = new Set(["video/mp4", "video/webm"]);

export function mediaKind(item: PublicGalleryItem): MediaKind {
  if (item.status === "missing") return "missing";
  if (imageTypes.has(item.contentType ?? "")) return "image";
  if (videoTypes.has(item.contentType ?? "")) return "video";
  if (item.contentType === "image/svg+xml") return "unsupported";
  return "file";
}

export function galleryPath(galleryId: string): string {
  return `/g/${encodeURIComponent(galleryId)}`;
}

export function galleryItemPath(galleryId: string, itemId: string): string {
  return `${galleryPath(galleryId)}/${encodeURIComponent(itemId)}`;
}

/**
 * Public gallery CSP.
 *
 * - style-src 'self' for Astro-extracted `/_astro/*.css` (not only 'unsafe-inline')
 * - script/connect for Cloudflare Web Analytics (RUM) beacon injection
 * - otherwise locked down: no default-src, no framing, no plugins
 */
export const PUBLIC_GALLERY_CSP = [
  "default-src 'none'",
  "img-src https: data:",
  "media-src https:",
  // Self-hosted Geist Pixel woff2 for the <Brand /> wordmark.
  "font-src 'self'",
  `style-src ${STYLE_SRC_SELF_AND_INLINE}`,
  // Widened for the copy button + "Copy as" control on the item page (design
  // spec §4.5); the gallery index page shares this constant and inherits the
  // widening even though it adds no script of its own.
  `script-src 'self' 'unsafe-inline' ${CF_RUM_SCRIPT_SRC}`,
  `connect-src ${CF_RUM_CONNECT_SRC}`,
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join("; ");

/** Shared security posture for the public gallery pages: strict CSP, noindex, no-store. */
export function applyPublicGalleryHeaders(headers: Headers): void {
  headers.set("Content-Security-Policy", PUBLIC_GALLERY_CSP);
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  headers.set("Cache-Control", "no-store");
}

function text(value: unknown, max: number): value is string {
  if (typeof value !== "string" || value.length > max) return false;
  return Array.from(value).every((character) => {
    const code = character.codePointAt(0) ?? 0;
    if (code === 9 || code === 10 || code === 13) return true;
    if (code < 32 || code === 127 || (code >= 0x80 && code <= 0x9f)) return false;
    return !/\p{Cf}/u.test(character);
  });
}

function nullableText(value: unknown, max: number): value is string | null {
  return value === null || text(value, max);
}

function safeUrl(value: unknown): value is string | null {
  if (value === null) return true;
  if (typeof value !== "string" || value.length > 4096) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

export function isPublicGallery(value: unknown): value is PublicGallery {
  if (typeof value !== "object" || value === null) return false;
  const gallery = value as Record<string, unknown>;
  if (
    !text(gallery.id, 64) ||
    !/^gal_[A-Za-z0-9_-]{22}$/.test(gallery.id) ||
    !text(gallery.title, 120) ||
    !nullableText(gallery.description, 2000) ||
    gallery.visibility !== "public" ||
    !nullableText(gallery.coverItemId, 64) ||
    !Number.isSafeInteger(gallery.version) ||
    !text(gallery.createdAt, 64) ||
    !Number.isFinite(Date.parse(gallery.createdAt)) ||
    !text(gallery.updatedAt, 64) ||
    !Number.isFinite(Date.parse(gallery.updatedAt)) ||
    !Array.isArray(gallery.items) ||
    gallery.items.length > 100
  )
    return false;

  // Older API deployments omit references; fetchPublicGallery normalizes to [].
  if (gallery.references !== undefined) {
    if (!Array.isArray(gallery.references) || gallery.references.length > 20) return false;
    const referencesValid = gallery.references.every((entry) => {
      if (typeof entry !== "object" || entry === null) return false;
      const reference = entry as Record<string, unknown>;
      return (
        text(reference.provider, 40) &&
        text(reference.resourceType, 40) &&
        text(reference.coordinate, 200) &&
        safeUrl(reference.canonicalUrl)
      );
    });
    if (!referencesValid) return false;
  }

  return gallery.items.every((entry) => {
    if (typeof entry !== "object" || entry === null) return false;
    const item = entry as Record<string, unknown>;
    return (
      text(item.id, 64) &&
      text(item.filename, 1024) &&
      Number.isSafeInteger(item.position) &&
      (item.position as number) > 0 &&
      nullableText(item.caption, 500) &&
      nullableText(item.altText, 300) &&
      (item.status === "available" || item.status === "missing") &&
      safeUrl(item.url) &&
      safeUrl(item.embedUrl) &&
      nullableText(item.contentType, 128) &&
      (item.status === "missing" ? item.url === null : item.url !== null)
    );
  });
}

export async function fetchPublicGallery(
  id: string,
  options: { origin: string; fetch?: typeof globalThis.fetch; timeoutMs?: number },
): Promise<GalleryFetchResult> {
  if (!/^gal_[A-Za-z0-9_-]{22}$/.test(id)) return { status: "not_found" };

  let origin: URL;
  try {
    origin = new URL(options.origin);
  } catch {
    return { status: "unavailable" };
  }
  const loopback =
    origin.hostname === "localhost" ||
    origin.hostname === "127.0.0.1" ||
    origin.hostname === "[::1]";
  if (origin.protocol !== "https:" && !(origin.protocol === "http:" && loopback))
    return { status: "unavailable" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 4000);
  try {
    const endpoint = new URL("/public/galleries/" + encodeURIComponent(id), origin);
    const response = await (options.fetch ?? globalThis.fetch)(endpoint, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });
    if (response.status === 404) return { status: "not_found" };
    if (!response.ok) return { status: "unavailable" };
    const value: unknown = await response.json();
    return isPublicGallery(value)
      ? { status: "ok", gallery: { ...value, references: value.references ?? [] } }
      : { status: "unavailable" };
  } catch {
    return { status: "unavailable" };
  } finally {
    clearTimeout(timer);
  }
}
