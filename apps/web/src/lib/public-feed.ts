import { FEED_ITEM_ID_RE } from "@uploads/comment-render/scope";
import { applyPublicGalleryHeaders } from "./public-gallery";
import { fileKind, isVideoDimensions, nullableHttpsUrl } from "./public-file";
import { SSR_USER_AGENT } from "./ssr-fetch";

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
  nextCursor?: string | null;
  /** Public-audience PR/issue label; null for a repo-wide live link. */
  github?: { title: string | null; state: "open" | "closed" | "merged" | null } | null;
}

export type FeedFetchResult =
  | { status: "ok"; feed: PublicFeed }
  | { status: "not_found" }
  | { status: "unavailable" };

export interface PublicFeedItemPage {
  feed: {
    id: string;
    title: string;
    repo: string;
    number: number | null;
    kind: "pull" | "issue" | null;
  };
  item: PublicFeedItem;
  /** Neighbour item ids in newest-first order: `prev` is newer, `next` older. */
  prev: string | null;
  next: string | null;
  index: number;
  total: number;
}

export type FeedItemFetchResult =
  | { status: "ok"; page: PublicFeedItemPage }
  | { status: "not_found" }
  | { status: "unavailable" };

/** The API's pager scan cap (`scanScopeKeys`): `total` stops counting here. */
export const PUBLIC_FEED_SCAN_CAP = 2000;

/** Opaque API cursor: bounded, URL-safe-ish; anything else was never issued. */
const FEED_CURSOR_RE = /^[A-Za-z0-9._~+/=-]{1,512}$/;

interface PublicFetchOptions {
  origin: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

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
  return `/c/${encodeURIComponent(feedId)}`;
}

export function feedItemPath(feedId: string, itemId: string): string {
  return `${feedPath(feedId)}/${encodeURIComponent(itemId)}`;
}

/** Map a legacy `/feed` or `/feed/…` pathname to its `/c/…` equivalent. */
export function legacyFeedRedirectPath(pathname: string): string | null {
  if (pathname === "/feed" || pathname === "/feed/") return "/c";
  if (!pathname.startsWith("/feed/")) return null;
  return `/c/${pathname.slice("/feed/".length)}`;
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
      feed.kind === "issue"
        ? "Live link · issue"
        : scoped
          ? "Live link · pull request"
          : "Live link · repo",
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
    feed.items.length > 100 ||
    !(
      feed.github === undefined ||
      feed.github === null ||
      (typeof feed.github === "object" &&
        nullableText((feed.github as Record<string, unknown>).title, 800) &&
        [null, "open", "closed", "merged"].includes(
          (feed.github as Record<string, unknown>).state as string | null,
        ))
    ) ||
    !(
      feed.nextCursor === undefined ||
      feed.nextCursor === null ||
      (typeof feed.nextCursor === "string" && FEED_CURSOR_RE.test(feed.nextCursor))
    )
  )
    return false;

  return feed.items.every(isPublicFeedItem);
}

export function isPublicFeedItem(entry: unknown): entry is PublicFeedItem {
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
}

export function isPublicFeedItemPage(value: unknown): value is PublicFeedItemPage {
  if (typeof value !== "object" || value === null) return false;
  const page = value as Record<string, unknown>;
  if (typeof page.feed !== "object" || page.feed === null) return false;
  const feed = page.feed as Record<string, unknown>;
  const neighbour = (id: unknown) =>
    id === null || (typeof id === "string" && FEED_ITEM_ID_RE.test(id));
  return (
    text(feed.id, 64) &&
    FEED_ID_RE.test(feed.id) &&
    text(feed.title, 800) &&
    text(feed.repo, 200) &&
    (feed.number === null || (Number.isSafeInteger(feed.number) && (feed.number as number) >= 1)) &&
    (feed.kind === null || feed.kind === "pull" || feed.kind === "issue") &&
    isPublicFeedItem(page.item) &&
    neighbour(page.prev) &&
    neighbour(page.next) &&
    Number.isSafeInteger(page.index) &&
    Number.isSafeInteger(page.total) &&
    (page.index as number) >= 0 &&
    (page.index as number) < (page.total as number)
  );
}

type PublicJson =
  | { status: "ok"; value: unknown }
  | { status: "not_found" }
  | { status: "bad_request" }
  | { status: "unavailable" };

async function fetchPublicJson(path: string, options: PublicFetchOptions): Promise<PublicJson> {
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
    const response = await (options.fetch ?? globalThis.fetch)(new URL(path, origin), {
      signal: controller.signal,
      headers: { Accept: "application/json", "User-Agent": SSR_USER_AGENT },
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });
    if (response.status === 404) return { status: "not_found" };
    if (response.status === 400) return { status: "bad_request" };
    if (!response.ok) return { status: "unavailable" };
    return { status: "ok", value: (await response.json()) as unknown };
  } catch {
    return { status: "unavailable" };
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchPublicFeed(
  id: string,
  options: PublicFetchOptions & { cursor?: string },
): Promise<FeedFetchResult> {
  if (!FEED_ID_RE.test(id)) return { status: "not_found" };
  // A cursor the API never issued reads as a missing page; /c/ then falls
  // back to the newest page instead of an error.
  if (options.cursor !== undefined && !FEED_CURSOR_RE.test(options.cursor))
    return { status: "not_found" };
  const query = options.cursor ? `?cursor=${encodeURIComponent(options.cursor)}` : "";
  const res = await fetchPublicJson(`/public/feeds/${encodeURIComponent(id)}${query}`, options);
  if (res.status === "bad_request")
    return options.cursor ? { status: "not_found" } : { status: "unavailable" };
  if (res.status !== "ok") return res;
  return isPublicFeed(res.value) ? { status: "ok", feed: res.value } : { status: "unavailable" };
}

export async function fetchPublicFeedItem(
  id: string,
  itemId: string,
  options: PublicFetchOptions,
): Promise<FeedItemFetchResult> {
  if (!FEED_ID_RE.test(id) || !FEED_ITEM_ID_RE.test(itemId)) return { status: "not_found" };
  const res = await fetchPublicJson(
    `/public/feeds/${encodeURIComponent(id)}/items/${encodeURIComponent(itemId)}`,
    options,
  );
  if (res.status === "bad_request") return { status: "not_found" };
  if (res.status !== "ok") return res;
  return isPublicFeedItemPage(res.value)
    ? { status: "ok", page: res.value }
    : { status: "unavailable" };
}
