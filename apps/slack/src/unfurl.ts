/**
 * Link unfurling: turns uploads.sh share links (`/f/…`, `/g/…`, `/c/…`) into
 * Slack previews.
 *
 * The preview data comes from uploads-web's public oEmbed endpoint, not from
 * the API or storage directly. That endpoint already decides what a stranger
 * may see: private, held, missing, and expired objects all come back 404, and
 * a 404 here means no unfurl. This worker holds no storage credentials and
 * never resolves a private object, so an unfurl can't show more than the
 * share page itself would.
 */
import { chatUnfurl, type Block, type UnfurlTarget } from "./slack/api";
import type { LinkSharedEvent } from "./slack/types";

export const UNFURL_USER_AGENT = "uploads-slack (+https://uploads.sh; unfurl)";
/** Slack sends at most a handful of links per event; this bounds the fan-out regardless. */
export const MAX_LINKS_PER_EVENT = 5;
const OEMBED_TIMEOUT_MS = 5_000;
const TITLE_MAX = 150;
/** chat.unfurl errors that mean Slack couldn't use an image block. */
const IMAGE_ERRORS = new Set(["invalid_blocks", "downloading_image_failed", "invalid_unfurls"]);

/** The oEmbed fields this module reads. See apps/web/src/lib/oembed.ts for the producer. */
export interface OEmbed {
  type: "photo" | "video" | "link" | "rich";
  title?: string;
  url?: string;
  thumbnail_url?: string;
}

export interface UnfurlDeps {
  /** Origin of uploads-web; only links on this origin unfurl. */
  webOrigin: string;
  /** Reaches uploads-web: the WEB service binding, or global fetch in dev. */
  webFetch: typeof globalThis.fetch;
  /** Reaches slack.com. */
  slackFetch?: typeof globalThis.fetch;
  botToken: string;
}

/** True when `url` is an https link on the configured web origin. */
export function isUnfurlableUrl(url: string, webOrigin: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.origin === new URL(webOrigin).origin;
  } catch {
    return false;
  }
}

/** Looks up oEmbed for a share link. Null on 404, error, or timeout. */
export async function fetchOEmbed(
  pageUrl: string,
  deps: Pick<UnfurlDeps, "webOrigin" | "webFetch">,
): Promise<OEmbed | null> {
  const endpoint = new URL("/oembed", deps.webOrigin);
  endpoint.searchParams.set("url", pageUrl);
  endpoint.searchParams.set("format", "json");
  try {
    const response = await deps.webFetch(endpoint.href, {
      headers: { Accept: "application/json", "User-Agent": UNFURL_USER_AGENT },
      signal: AbortSignal.timeout(OEMBED_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as Partial<OEmbed> | null;
    if (!body || typeof body !== "object" || typeof body.type !== "string") return null;
    return body as OEmbed;
  } catch {
    return null;
  }
}

/** Escapes text for Slack mrkdwn: https://api.slack.com/reference/surfaces/formatting#escaping */
export function escapeMrkdwn(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function clampTitle(title: string | undefined, fallback: string): string {
  const value = (title ?? "").trim() || fallback;
  return value.length > TITLE_MAX ? `${value.slice(0, TITLE_MAX - 1)}…` : value;
}

function isHttpsUrl(value: string | undefined): value is string {
  if (!value) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

/** Slack's image blocks take PNG, JPEG, and GIF; an SVG or other type fails the whole chat.unfurl call. */
function isSlackImage(value: string | undefined): value is string {
  if (!isHttpsUrl(value)) return false;
  const path = new URL(value).pathname.toLowerCase();
  return !/\.(svg|svgz|avif|heic|heif|tiff?|bmp|ico)$/.test(path);
}

function fallbackTitle(pageUrl: string): string {
  try {
    const last = new URL(pageUrl).pathname.replace(/\/+$/, "").split("/").pop();
    return last ? decodeURIComponent(last) : "uploads.sh";
  } catch {
    return "uploads.sh";
  }
}

/**
 * Block Kit for one link. Images show inline; videos show their poster frame
 * (Slack's video block needs the extra `links.embed:write` scope, so it is
 * left for later); everything else is a titled link with a thumbnail when
 * the oEmbed has one.
 */
export function unfurlBlocks(
  pageUrl: string,
  oembed: OEmbed,
  options: { images?: boolean } = {},
): Block[] {
  const images = options.images ?? true;
  const title = clampTitle(oembed.title, fallbackTitle(pageUrl));
  const titleLine = `*<${pageUrl}|${escapeMrkdwn(title)}>*`;
  const context: Block = {
    type: "context",
    elements: [{ type: "mrkdwn", text: "uploads.sh" }],
  };

  const image = !images
    ? undefined
    : oembed.type === "photo" && isSlackImage(oembed.url)
      ? oembed.url
      : oembed.type === "video" && isSlackImage(oembed.thumbnail_url)
        ? oembed.thumbnail_url
        : undefined;
  if (image) {
    const label = oembed.type === "video" ? `${titleLine} · video` : titleLine;
    return [
      { type: "section", text: { type: "mrkdwn", text: label } },
      { type: "image", image_url: image, alt_text: title },
      context,
    ];
  }

  const section: Block = { type: "section", text: { type: "mrkdwn", text: titleLine } };
  if (images && isSlackImage(oembed.thumbnail_url)) {
    section.accessory = { type: "image", image_url: oembed.thumbnail_url, alt_text: title };
  }
  return [section, context];
}

function unfurlTarget(event: LinkSharedEvent): UnfurlTarget {
  if (event.unfurl_id && event.source) {
    return { unfurl_id: event.unfurl_id, source: event.source };
  }
  return { channel: event.channel, ts: event.message_ts };
}

export type UnfurlOutcome =
  | { status: "unfurled"; urls: string[] }
  | { status: "skipped"; reason: "no_links" }
  | { status: "failed"; urls: string[]; error: string };

/** Handles a `link_shared` event: look up each link, then one `chat.unfurl` for all that resolved. */
export async function handleLinkShared(
  event: LinkSharedEvent,
  deps: UnfurlDeps,
): Promise<UnfurlOutcome> {
  const urls = [...new Set((event.links ?? []).map((link) => link.url))]
    .filter((url) => isUnfurlableUrl(url, deps.webOrigin))
    .slice(0, MAX_LINKS_PER_EVENT);

  const resolved = await Promise.all(
    urls.map(async (url) => {
      const oembed = await fetchOEmbed(url, deps);
      return oembed ? ([url, oembed] as const) : null;
    }),
  );
  const found = resolved.filter((entry) => entry !== null);
  const unfurledUrls = found.map(([url]) => url);
  if (unfurledUrls.length === 0) return { status: "skipped", reason: "no_links" };

  const build = (images: boolean) =>
    Object.fromEntries(
      found.map(([url, oembed]) => [url, { blocks: unfurlBlocks(url, oembed, { images }) }]),
    );
  const api = { token: deps.botToken, fetch: deps.slackFetch };
  let result = await chatUnfurl(unfurlTarget(event), build(true), api);
  // Slack fetches every image before accepting the call, and one image it
  // can't fetch rejects the whole batch. Retry once as plain titled links.
  if (!result.ok && result.error && IMAGE_ERRORS.has(result.error)) {
    result = await chatUnfurl(unfurlTarget(event), build(false), api);
  }
  if (!result.ok) {
    return { status: "failed", urls: unfurledUrls, error: result.error ?? "unknown_error" };
  }
  return { status: "unfurled", urls: unfurledUrls };
}
