import { applyPublicGalleryHeaders } from "./public-gallery";
import { fileKind, isVideoDimensions, nullableHttpsUrl } from "./public-file";

export interface PublicFeedItem {
  id: string;
  filename: string;
  status: "available" | "missing" | "withheld";
  url: string | null;
  embedUrl: string | null;
  contentType: string | null;
  size: number | null;
  uploaded?: string | null;
  modified?: string | null;
  path: string | null;
  state: string | null;
  posterUrl?: string | null;
  videoDimensions?: { width: number; height: number };
}

export interface PublicFeed {
  id: string;
  title: string;
  repo: string;
  path: string | null;
  number: number | null;
  kind: "pull" | "issue" | null;
  createdAt: string;
  updatedAt: string;
  items: PublicFeedItem[];
}

export type FeedFetchResult =
  | { status: "ok"; feed: PublicFeed }
  | { status: "not_found" }
  | { status: "unavailable" };

export { applyPublicGalleryHeaders as applyPublicFeedHeaders };

export type MediaKind = "image" | "video" | "file" | "missing";

export function mediaKind(item: PublicFeedItem): MediaKind {
  if (item.status === "missing" || item.status === "withheld") return "missing";
  return fileKind(item.contentType ?? "");
}

const FEED_ID_RE = /^feed_[A-Za-z0-9_-]{22}$/;

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

function optionalIsoDate(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  return text(value, 64) && Number.isFinite(Date.parse(value));
}

export function feedPath(feedId: string): string {
  return `/feed/${encodeURIComponent(feedId)}`;
}

export function feedPageCopy(feed: Pick<PublicFeed, "repo" | "number" | "kind">): {
  eyebrow: string;
  scopeLabel: string;
  scopeNoun: string;
} {
  const scoped = feed.number != null;
  return {
    scopeLabel: scoped ? `${feed.repo}#${feed.number}` : feed.repo,
    scopeNoun: feed.kind === "issue" ? "issue" : scoped ? "pull request" : "repo",
    eyebrow:
      feed.kind === "issue" ? "Issue feed" : scoped ? "Pull request feed" : "Repo change feed",
  };
}

export function isPublicFeed(value: unknown): value is PublicFeed {
  if (typeof value !== "object" || value === null) return false;
  const feed = value as Record<string, unknown>;
  if (
    !text(feed.id, 64) ||
    !FEED_ID_RE.test(feed.id) ||
    !text(feed.title, 800) ||
    !text(feed.repo, 200) ||
    !nullableText(feed.path, 512) ||
    !(
      feed.number === undefined ||
      feed.number === null ||
      (Number.isSafeInteger(feed.number) && (feed.number as number) >= 1)
    ) ||
    !(
      feed.kind === undefined ||
      feed.kind === null ||
      feed.kind === "pull" ||
      feed.kind === "issue"
    ) ||
    !text(feed.createdAt, 64) ||
    !Number.isFinite(Date.parse(feed.createdAt)) ||
    !text(feed.updatedAt, 64) ||
    !Number.isFinite(Date.parse(feed.updatedAt)) ||
    !Array.isArray(feed.items) ||
    feed.items.length > 100
  )
    return false;

  return feed.items.every((entry) => {
    if (typeof entry !== "object" || entry === null) return false;
    const item = entry as Record<string, unknown>;
    const sizeOk =
      item.size === undefined ||
      item.size === null ||
      (Number.isSafeInteger(item.size) && (item.size as number) >= 0);
    const posterUrlOk = item.posterUrl === undefined || nullableHttpsUrl(item.posterUrl);
    const videoDimensionsOk =
      item.videoDimensions === undefined || isVideoDimensions(item.videoDimensions);
    return (
      posterUrlOk &&
      videoDimensionsOk &&
      text(item.id, 64) &&
      text(item.filename, 1024) &&
      (item.status === "available" || item.status === "missing" || item.status === "withheld") &&
      nullableHttpsUrl(item.url) &&
      nullableHttpsUrl(item.embedUrl) &&
      nullableText(item.contentType, 128) &&
      nullableText(item.path, 512) &&
      nullableText(item.state, 64) &&
      sizeOk &&
      optionalIsoDate(item.uploaded) &&
      optionalIsoDate(item.modified) &&
      (item.status === "missing" || item.status === "withheld"
        ? item.url === null
        : item.url !== null)
    );
  });
}

export async function fetchPublicFeed(
  id: string,
  options: { origin: string; fetch?: typeof globalThis.fetch; timeoutMs?: number },
): Promise<FeedFetchResult> {
  if (!FEED_ID_RE.test(id)) return { status: "not_found" };

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
    const endpoint = new URL("/public/feeds/" + encodeURIComponent(id), origin);
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
    return isPublicFeed(value) ? { status: "ok", feed: value } : { status: "unavailable" };
  } catch {
    return { status: "unavailable" };
  } finally {
    clearTimeout(timer);
  }
}
