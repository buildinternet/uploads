/**
 * Resolves an uploads.sh share link into a Preview: what the link is, its
 * image, and the facts worth a line in Slack.
 *
 * Data comes only from uploads-api's public read endpoints
 * (`/public/files|feeds|galleries/…`), the same ones the share pages render
 * from. They never sign URLs and return 404 for private, held, missing, and
 * expired objects, so a preview can't show more than the share page itself.
 * Items a collection marks `missing` or `withheld` are skipped.
 */

export const PUBLIC_API_USER_AGENT = "uploads-slack (+https://uploads.sh; unfurl)";
const FETCH_TIMEOUT_MS = 5_000;

const WORKSPACE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const GALLERY_ID_PATTERN = /^gal_[A-Za-z0-9_-]{22}$/;
const FEED_ID_PATTERN = /^feed_[A-Za-z0-9_-]{22}$/;
const ITEM_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export type ShareTarget =
  | { kind: "file"; workspace: string; key: string }
  | { kind: "gallery"; id: string; itemId?: string }
  | { kind: "feed"; id: string; itemId?: string };

/**
 * Parses a share page URL on `webOrigin`. Mirrors the routes in
 * apps/web/src/lib/oembed.ts (`/f/<workspace>/<key>`, `/g/<id>[/<item>]`,
 * `/c|feed/<id>[/<item>]`); anything else is null.
 */
export function parseShareUrl(rawUrl: string, webOrigin: string): ShareTarget | null {
  let page: URL;
  try {
    page = new URL(rawUrl);
    if (page.origin !== new URL(webOrigin).origin) return null;
  } catch {
    return null;
  }
  const parts: string[] = [];
  for (const segment of page.pathname.split("/").filter(Boolean)) {
    try {
      parts.push(decodeURIComponent(segment));
    } catch {
      return null;
    }
  }
  const [route, id, ...rest] = parts;
  if (route === "f" && id && rest.length > 0) {
    const key = rest.join("/");
    if (!WORKSPACE_PATTERN.test(id) || key.includes("..") || key.length > 1024) return null;
    return { kind: "file", workspace: id, key };
  }
  if (rest.length > 1 || !id) return null;
  const itemId = rest[0];
  if (itemId !== undefined && !ITEM_ID_PATTERN.test(itemId)) return null;
  if (route === "g" && GALLERY_ID_PATTERN.test(id)) return { kind: "gallery", id, itemId };
  if ((route === "c" || route === "feed") && FEED_ID_PATTERN.test(id)) {
    return { kind: "feed", id, itemId };
  }
  return null;
}

/** Text pieces are plain (unescaped); blocks.ts escapes them. */
export interface PreviewLink {
  text: string;
  url?: string;
}

export interface Preview {
  url: string;
  title: string;
  /** Second line under the title, e.g. the PR a screenshot is attached to. */
  subtitle?: PreviewLink[];
  /** Full-width media, or a small thumbnail beside the title. */
  image?: { url: string; alt: string; size: "large" | "thumb" };
  /** Shown as "video" next to the title. */
  isVideo?: boolean;
  /** Facts for the muted context line, in order. */
  facts: PreviewFact[];
  entity: PreviewEntity;
}

export type PreviewFact = { text: string } | { date: string };

/**
 * What a Slack Work Object needs beyond the Block Kit preview (entities.ts).
 * Built from the same public responses, so it can't carry anything the
 * share page doesn't show.
 */
export interface PreviewEntity {
  /** File-like links are `file`; feeds and galleries are `content_item`. */
  type: "file" | "content_item";
  /** Stable id for Slack's related-conversations tracking; never changes for a link. */
  ref: { id: string; type: "file" | "feed" | "gallery" | "feed_item" | "gallery_item" };
  /** Shown in the Work Object header, e.g. "Change feed". */
  displayType: string;
  /** The share page without query or fragment. */
  canonicalUrl: string;
  description?: string;
  contentType?: string | null;
  size?: number | null;
  created?: string | null;
  updated?: string | null;
  /** Extra labelled values for the Work Object body, in order. */
  fields: EntityField[];
}

export interface EntityField {
  key: string;
  label: string;
  value: string;
  url?: string;
  tag?: "red" | "yellow" | "green" | "gray" | "blue";
}

/** One item of a feed or gallery, as the flexpane pager shows it. */
export interface PagerPage {
  item: {
    id: string;
    title: string;
    url: string;
    image?: { url: string; alt: string };
    isVideo: boolean;
    contentType: string | null;
    size: number | null;
    uploaded: string | null;
    path: string | null;
  };
  /** Item ids either side; for a feed `prev` is newer (feeds list newest first). */
  prev: string | null;
  next: string | null;
  /** Zero-based. */
  index: number;
  total: number;
}

// --- API wire shapes (the fields this module reads) ---

interface GithubContext {
  repo: string;
  kind: "pull" | "issue";
  number: number;
  url: string;
  title?: string;
}

interface PublicFile {
  key: string;
  url: string;
  size: number;
  contentType: string;
  uploaded: string | null;
  metadata?: Record<string, string>;
  github?: GithubContext;
  posterUrl?: string | null;
}

interface CollectionItem {
  id: string;
  filename: string;
  status: "available" | "missing" | "withheld";
  url: string | null;
  contentType: string | null;
  size: number | null;
  uploaded?: string | null;
  posterUrl?: string | null;
  path?: string | null;
  state?: string | null;
  caption?: string | null;
  altText?: string | null;
  position?: number;
}

interface PublicFeed {
  id: string;
  title: string;
  repo: string;
  number: number | null;
  kind: "pull" | "issue" | null;
  updatedAt: string;
  items: CollectionItem[];
  github?: { title: string | null; state: "open" | "closed" | "merged" | null } | null;
}

interface PublicFeedItemPage {
  feed: { id: string; title: string; repo: string; number: number | null; kind: string | null };
  item: CollectionItem;
  prev: string | null;
  next: string | null;
  index: number;
  total: number;
}

interface PublicGallery {
  id: string;
  title: string;
  description: string | null;
  coverItemId: string | null;
  updatedAt: string;
  items: CollectionItem[];
}

export interface ShareDeps {
  webOrigin: string;
  /** Origin the public API answers on; requests go through `apiFetch`. */
  apiOrigin: string;
  apiFetch: typeof globalThis.fetch;
}

async function getJson<T>(path: string, deps: ShareDeps): Promise<T | null> {
  try {
    const response = await deps.apiFetch(new URL(path, deps.apiOrigin).href, {
      headers: { Accept: "application/json", "User-Agent": PUBLIC_API_USER_AGENT },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as T | null;
    return body && typeof body === "object" ? body : null;
  } catch {
    return null;
  }
}

function encodeKey(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

function filenameOf(key: string): string {
  return key.slice(key.lastIndexOf("/") + 1) || key;
}

const TYPE_LABELS: Record<string, string> = {
  "image/png": "PNG",
  "image/jpeg": "JPEG",
  "image/gif": "GIF",
  "image/webp": "WebP",
  "image/avif": "AVIF",
  "image/svg+xml": "SVG",
  "video/mp4": "MP4",
  "video/webm": "WebM",
  "video/quicktime": "MOV",
  "application/pdf": "PDF",
};

function typeLabel(contentType: string | null | undefined): string | null {
  if (!contentType) return null;
  const base = contentType.split(";")[0]!.trim().toLowerCase();
  return TYPE_LABELS[base] ?? null;
}

/** 138352 → "138 kB" (decimal units, like Slack's own file sizes). */
export function formatBytes(bytes: number | null | undefined): string | null {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return null;
  if (bytes < 1000) return `${bytes} B`;
  const units = ["kB", "MB", "GB"];
  let value = bytes / 1000;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function isVideoType(contentType: string | null | undefined): boolean {
  return Boolean(contentType?.toLowerCase().startsWith("video/"));
}

function isImageType(contentType: string | null | undefined): boolean {
  return Boolean(contentType?.toLowerCase().startsWith("image/"));
}

/** The image to show for one object: itself when it's an image, its poster when it's a video. */
function mediaImage(item: {
  url: string | null;
  contentType: string | null;
  posterUrl?: string | null;
}): string | undefined {
  if (isImageType(item.contentType) && item.url) return item.url;
  if (isVideoType(item.contentType) && item.posterUrl) return item.posterUrl;
  return undefined;
}

function prRef(repo: string, number: number): string {
  return `${repo}#${number}`;
}

function githubUrl(repo: string, kind: string | null, number: number): string {
  return `https://github.com/${repo}/${kind === "issue" ? "issues" : "pull"}/${number}`;
}

const STATE_LABELS = { open: "Open", closed: "Closed", merged: "Merged" } as const;

function present(...facts: Array<PreviewFact | null | undefined | false>): PreviewFact[] {
  return facts.filter((fact): fact is PreviewFact => Boolean(fact));
}

function text(value: string | null | undefined): PreviewFact | null {
  return value ? { text: value } : null;
}

function date(value: string | null | undefined): PreviewFact | null {
  return value && !Number.isNaN(Date.parse(value)) ? { date: value } : null;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** The share page URL without query or fragment: the Work Object's canonical `url`. */
function canonical(pageUrl: string): string {
  const url = new URL(pageUrl);
  return `${url.origin}${url.pathname}`;
}

/** "Image", "Video", or "File": the Work Object header's type label. */
function mediaKind(contentType: string | null | undefined): string {
  if (isVideoType(contentType)) return "Video";
  if (isImageType(contentType)) return "Image";
  return "File";
}

const STATE_TAGS = { open: "green", closed: "red", merged: "blue" } as const;

function threadField(gh: { repo: string; number: number; url: string }): EntityField {
  return { key: "github", label: "GitHub", value: prRef(gh.repo, gh.number), url: gh.url };
}

function pathField(path: string | null | undefined): EntityField[] {
  return path ? [{ key: "page_path", label: "Page", value: path }] : [];
}

async function filePreview(
  pageUrl: string,
  target: Extract<ShareTarget, { kind: "file" }>,
  deps: ShareDeps,
): Promise<Preview | null> {
  const file = await getJson<PublicFile>(
    `/public/files/${encodeURIComponent(target.workspace)}/${encodeKey(target.key)}`,
    deps,
  );
  if (!file) return null;
  const title = filenameOf(file.key);
  const image = mediaImage(file);
  const gh = file.github;
  return {
    url: pageUrl,
    title,
    isVideo: isVideoType(file.contentType),
    ...(image ? { image: { url: image, alt: title, size: "large" as const } } : {}),
    ...(gh
      ? {
          subtitle: [
            { text: prRef(gh.repo, gh.number), url: gh.url },
            ...(gh.title ? [{ text: gh.title }] : []),
          ],
        }
      : {}),
    facts: present(
      text(typeLabel(file.contentType)),
      text(formatBytes(file.size)),
      text(file.metadata?.path),
      date(file.uploaded),
    ),
    entity: {
      type: "file",
      ref: { id: `${target.workspace}/${target.key}`, type: "file" },
      displayType: mediaKind(file.contentType),
      canonicalUrl: canonical(pageUrl),
      contentType: file.contentType,
      size: file.size,
      created: file.uploaded,
      updated: file.uploaded,
      ...(gh?.title ? { description: gh.title } : {}),
      fields: [...(gh ? [threadField(gh)] : []), ...pathField(file.metadata?.path)],
    },
  };
}

async function feedPreview(
  pageUrl: string,
  target: Extract<ShareTarget, { kind: "feed" }>,
  deps: ShareDeps,
): Promise<Preview | null> {
  const id = encodeURIComponent(target.id);
  const feedPage = new URL(`/c/${id}`, deps.webOrigin).href;
  if (target.itemId) {
    const page = await getJson<PublicFeedItemPage>(
      `/public/feeds/${id}/items/${encodeURIComponent(target.itemId)}`,
      deps,
    );
    if (!page || page.item.status !== "available") return null;
    const { feed, item } = page;
    const image = mediaImage(item);
    return {
      url: pageUrl,
      title: item.filename,
      isVideo: isVideoType(item.contentType),
      ...(image ? { image: { url: image, alt: item.filename, size: "large" as const } } : {}),
      // No position here: feeds list newest first, so "1 of 334" reads as
      // the first of 334 rather than the latest.
      subtitle: [{ text: feed.title, url: feedPage }, { text: "Change feed" }],
      facts: present(text(item.path), date(item.uploaded)),
      entity: {
        type: "file",
        ref: { id: `${target.id}/${item.id}`, type: "feed_item" },
        displayType: mediaKind(item.contentType),
        canonicalUrl: canonical(pageUrl),
        contentType: item.contentType,
        size: item.size,
        created: item.uploaded ?? null,
        updated: item.uploaded ?? null,
        fields: [
          { key: "change_feed", label: "Change feed", value: feed.title, url: feedPage },
          ...pathField(item.path),
        ],
      },
    };
  }

  const feed = await getJson<PublicFeed>(`/public/feeds/${id}?limit=1`, deps);
  if (!feed) return null;
  const latest = feed.items.find((item) => item.status === "available");
  // The list endpoint pages without a total; the item page carries one.
  const page = latest
    ? await getJson<PublicFeedItemPage>(
        `/public/feeds/${id}/items/${encodeURIComponent(latest.id)}`,
        deps,
      )
    : null;
  const image = latest ? mediaImage(latest) : undefined;
  const isThread = feed.number !== null && feed.kind !== null;
  const title =
    isThread && feed.github?.title
      ? `${prRef(feed.repo, feed.number!)}: ${feed.github.title}`
      : feed.title;
  const state = feed.github?.state ? STATE_LABELS[feed.github.state] : null;
  const ghUrl = isThread ? githubUrl(feed.repo, feed.kind, feed.number!) : null;
  return {
    url: pageUrl,
    title,
    ...(image ? { image: { url: image, alt: latest!.filename, size: "thumb" as const } } : {}),
    subtitle: isThread
      ? [{ text: feed.repo, url: ghUrl! }, ...(state ? [{ text: state }] : [])]
      : [{ text: "Change feed" }],
    facts: present(
      page ? text(plural(page.total, "file")) : null,
      date(latest?.uploaded ?? feed.updatedAt),
    ),
    entity: {
      type: "content_item",
      ref: { id: target.id, type: "feed" },
      displayType: "Change feed",
      canonicalUrl: canonical(pageUrl),
      updated: latest?.uploaded ?? feed.updatedAt,
      fields: [
        ...(isThread
          ? [threadField({ repo: feed.repo, number: feed.number!, url: ghUrl! })]
          : [{ key: "repo", label: "Repository", value: feed.repo }]),
        ...(state && feed.github?.state
          ? [{ key: "state", label: "State", value: state, tag: STATE_TAGS[feed.github.state] }]
          : []),
        ...(page ? [{ key: "files", label: "Files", value: String(page.total) }] : []),
      ],
    },
  };
}

async function loadGallery(
  id: string,
  deps: ShareDeps,
): Promise<{ gallery: PublicGallery; items: CollectionItem[] } | null> {
  const gallery = await getJson<PublicGallery>(`/public/galleries/${encodeURIComponent(id)}`, deps);
  if (!gallery) return null;
  const items = gallery.items
    .filter((item) => item.status === "available")
    // filter() already copied the array, so sorting in place is safe.
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0) || a.id.localeCompare(b.id));
  return { gallery, items };
}

async function galleryPreview(
  pageUrl: string,
  target: Extract<ShareTarget, { kind: "gallery" }>,
  deps: ShareDeps,
): Promise<Preview | null> {
  const loaded = await loadGallery(target.id, deps);
  if (!loaded) return null;
  const { gallery, items } = loaded;
  const galleryPage = new URL(`/g/${gallery.id}`, deps.webOrigin).href;

  if (target.itemId) {
    const index = items.findIndex((item) => item.id === target.itemId);
    const item = items[index];
    if (!item) return null;
    const title = item.caption?.trim() || item.filename;
    const image = mediaImage(item);
    const position = `${index + 1} of ${items.length}`;
    return {
      url: pageUrl,
      title,
      isVideo: isVideoType(item.contentType),
      ...(image
        ? { image: { url: image, alt: item.altText || title, size: "large" as const } }
        : {}),
      subtitle: [{ text: gallery.title, url: galleryPage }],
      facts: present(text(position), date(item.uploaded)),
      entity: {
        type: "file",
        ref: { id: `${gallery.id}/${item.id}`, type: "gallery_item" },
        displayType: mediaKind(item.contentType),
        canonicalUrl: canonical(pageUrl),
        contentType: item.contentType,
        size: item.size,
        created: item.uploaded ?? null,
        updated: item.uploaded ?? null,
        fields: [
          { key: "gallery", label: "Gallery", value: gallery.title, url: galleryPage },
          { key: "position", label: "Position", value: position },
        ],
      },
    };
  }

  const cover =
    items.find((item) => item.id === gallery.coverItemId && mediaImage(item)) ??
    items.find((item) => mediaImage(item));
  const image = cover ? mediaImage(cover) : undefined;
  const description = gallery.description?.trim();
  return {
    url: pageUrl,
    title: gallery.title,
    ...(image
      ? { image: { url: image, alt: cover!.altText || gallery.title, size: "thumb" as const } }
      : {}),
    subtitle: description ? [{ text: description }] : [{ text: "Gallery" }],
    facts: present(text(plural(items.length, "item")), date(gallery.updatedAt)),
    entity: {
      type: "content_item",
      ref: { id: gallery.id, type: "gallery" },
      displayType: "Gallery",
      canonicalUrl: canonical(pageUrl),
      updated: gallery.updatedAt,
      ...(description ? { description } : {}),
      fields: [{ key: "items", label: "Items", value: String(items.length) }],
    },
  };
}

/** Preview for a share link, or null when it isn't public (or isn't a share link). */
export async function resolvePreview(pageUrl: string, deps: ShareDeps): Promise<Preview | null> {
  const target = parseShareUrl(pageUrl, deps.webOrigin);
  if (!target) return null;
  if (target.kind === "file") return filePreview(pageUrl, target, deps);
  if (target.kind === "feed") return feedPreview(pageUrl, target, deps);
  return galleryPreview(pageUrl, target, deps);
}

function pagerItem(
  item: CollectionItem,
  url: string,
  title: string,
  alt: string,
): PagerPage["item"] {
  const image = mediaImage(item);
  return {
    id: item.id,
    title,
    url,
    ...(image ? { image: { url: image, alt } } : {}),
    isVideo: isVideoType(item.contentType),
    contentType: item.contentType,
    size: item.size,
    uploaded: item.uploaded ?? null,
    path: item.path ?? null,
  };
}

/**
 * One page of the flexpane pager for a feed or gallery link: the item
 * `itemId`, or the starting item (a feed's latest, a gallery's first) when
 * it's absent. Same public endpoints and rules as the unfurl; null when the
 * item isn't public.
 */
export async function resolvePagerPage(
  target: Extract<ShareTarget, { kind: "feed" | "gallery" }>,
  itemId: string | undefined,
  deps: ShareDeps,
): Promise<PagerPage | null> {
  if (itemId !== undefined && !ITEM_ID_PATTERN.test(itemId)) return null;
  const id = encodeURIComponent(target.id);

  if (target.kind === "feed") {
    let start = itemId;
    if (!start) {
      const feed = await getJson<PublicFeed>(`/public/feeds/${id}?limit=1`, deps);
      start = feed?.items.find((item) => item.status === "available")?.id;
      if (!start) return null;
    }
    const page = await getJson<PublicFeedItemPage>(
      `/public/feeds/${id}/items/${encodeURIComponent(start)}`,
      deps,
    );
    if (!page || page.item.status !== "available") return null;
    const url = new URL(`/c/${id}/${encodeURIComponent(page.item.id)}`, deps.webOrigin).href;
    return {
      item: pagerItem(page.item, url, page.item.filename, page.item.filename),
      prev: page.prev,
      next: page.next,
      index: page.index,
      total: page.total,
    };
  }

  const loaded = await loadGallery(target.id, deps);
  if (!loaded) return null;
  const { items } = loaded;
  const index = itemId ? items.findIndex((item) => item.id === itemId) : 0;
  const item = items[index];
  if (!item) return null;
  const title = item.caption?.trim() || item.filename;
  const url = new URL(`/g/${id}/${encodeURIComponent(item.id)}`, deps.webOrigin).href;
  return {
    item: pagerItem(item, url, title, item.altText || title),
    prev: items[index - 1]?.id ?? null,
    next: items[index + 1]?.id ?? null,
    index,
    total: items.length,
  };
}
