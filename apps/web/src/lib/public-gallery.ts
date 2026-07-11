export interface PublicGalleryItem {
  id: string;
  filename: string;
  position: number;
  caption: string | null;
  altText: string | null;
  status: "available" | "missing";
  url: string | null;
  contentType: string | null;
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
}

export type GalleryFetchResult =
  | { status: "ok"; gallery: PublicGallery }
  | { status: "not_found" }
  | { status: "unavailable" };

function text(value: unknown, max: number): value is string {
  if (typeof value !== "string" || value.length > max) return false;
  return Array.from(value).every((character) => {
    const code = character.codePointAt(0) ?? 0;
    return (code >= 32 || code === 9 || code === 10 || code === 13) && code !== 127;
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
    origin.hostname === "localhost" || origin.hostname === "127.0.0.1" || origin.hostname === "::1";
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
    return isPublicGallery(value) ? { status: "ok", gallery: value } : { status: "unavailable" };
  } catch {
    return { status: "unavailable" };
  } finally {
    clearTimeout(timer);
  }
}
