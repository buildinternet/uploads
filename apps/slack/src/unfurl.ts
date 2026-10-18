/**
 * Link unfurling: turns uploads.sh share links (`/f/…`, `/g/…`, `/c/…`) into
 * Slack previews. share.ts decides what a link is and what may be shown;
 * this module renders that as Block Kit and calls chat.unfurl.
 *
 * Layout follows the convention GitHub, Linear, and Loom unfurls use: a bold
 * title, a second line for what it belongs to, then either one full-width
 * image (a file) or a small thumbnail beside the title (a collection), and a
 * muted context line of facts.
 */
import { isSlackImage, PROVIDER_ICON_URL, unfurlEntity, type EntityOptions } from "./entities";
import { resolvePreview, type Preview, type PreviewLink, type ShareDeps } from "./share";
import { chatUnfurl, type Block, type UnfurlTarget } from "./slack/api";
import type { LinkSharedEvent } from "./slack/types";

/** Slack sends at most a handful of links per event; this bounds the fan-out regardless. */
const MAX_LINKS_PER_EVENT = 5;
const TITLE_MAX = 150;
const SUBTITLE_MAX = 200;
/** chat.unfurl errors that mean Slack couldn't use an image block. */
const IMAGE_ERRORS = new Set(["invalid_blocks", "downloading_image_failed", "invalid_unfurls"]);

export interface UnfurlDeps extends ShareDeps, EntityOptions {
  /** Reaches slack.com. */
  slackFetch?: typeof globalThis.fetch;
  botToken: string;
  /** Also send Work Object metadata (entities.ts) alongside the blocks. */
  workObjects?: boolean;
}

/** Escapes text for Slack mrkdwn: https://api.slack.com/reference/surfaces/formatting#escaping */
export function escapeMrkdwn(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function clamp(value: string, max: number): string {
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

function link(url: string, label: string): string {
  return `<${url}|${escapeMrkdwn(label)}>`;
}

function subtitleText(parts: PreviewLink[]): string {
  return parts
    .map((part) => {
      const label = clamp(part.text, SUBTITLE_MAX);
      return part.url ? link(part.url, label) : escapeMrkdwn(label);
    })
    .join(" · ");
}

/** Slack date token: renders in the viewer's timezone as "2 hours ago". */
function slackDate(iso: string): string {
  const seconds = Math.floor(Date.parse(iso) / 1000);
  return `<!date^${seconds}^{ago}|${escapeMrkdwn(iso.slice(0, 10))}>`;
}

/** Block Kit for one preview. `images: false` is the text-only fallback. */
export function previewBlocks(preview: Preview, options: { images?: boolean } = {}): Block[] {
  const images = options.images ?? true;
  const title = clamp(preview.title, TITLE_MAX);
  let text = `*${link(preview.url, title)}*${preview.isVideo ? " · video" : ""}`;
  if (preview.subtitle?.length) text += `\n${subtitleText(preview.subtitle)}`;

  const image = images && preview.image && isSlackImage(preview.image.url) ? preview.image : null;
  const section: Block = { type: "section", text: { type: "mrkdwn", text } };
  if (image?.size === "thumb") {
    section.accessory = { type: "image", image_url: image.url, alt_text: image.alt || title };
  }

  const facts = preview.facts.map((fact) =>
    "date" in fact ? slackDate(fact.date) : escapeMrkdwn(fact.text),
  );
  const context: Block = {
    type: "context",
    elements: [
      ...(images ? [{ type: "image", image_url: PROVIDER_ICON_URL, alt_text: "uploads.sh" }] : []),
      { type: "mrkdwn", text: ["uploads.sh", ...facts].join(" · ") },
    ],
  };

  return image?.size === "large"
    ? [section, { type: "image", image_url: image.url, alt_text: image.alt || title }, context]
    : [section, context];
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

/** Handles a `link_shared` event: resolve each link, then one `chat.unfurl` for all that resolved. */
export async function handleLinkShared(
  event: LinkSharedEvent,
  deps: UnfurlDeps,
): Promise<UnfurlOutcome> {
  const urls = [...new Set((event.links ?? []).map((entry) => entry.url))].slice(
    0,
    MAX_LINKS_PER_EVENT,
  );
  const resolved = await Promise.all(urls.map((url) => resolvePreview(url, deps)));
  const previews = resolved.filter((preview) => preview !== null);
  const unfurledUrls = previews.map((preview) => preview.url);
  if (unfurledUrls.length === 0) return { status: "skipped", reason: "no_links" };

  const build = (images: boolean) =>
    Object.fromEntries(
      previews.map((preview) => [preview.url, { blocks: previewBlocks(preview, { images }) }]),
    );
  const entities = (images: boolean) => ({
    entities: previews.map((preview) => unfurlEntity(preview, { ...deps, images })),
  });
  const api = { token: deps.botToken, fetch: deps.slackFetch };
  let result = await chatUnfurl(
    unfurlTarget(event),
    build(true),
    api,
    deps.workObjects ? entities(true) : undefined,
  );
  // Slack answers `error_processing_metadata` when it can't use the Work
  // Object, and an image it can't fetch is one cause. Try the Work Object
  // without images, then the blocks alone, which always preview.
  if (!result.ok && deps.workObjects) {
    console.warn("slack.unfurl: Work Object rejected, retrying without images", {
      error: result.error,
      detail: result.response_metadata,
      links: previews.map((preview) => `${preview.entity.ref.type} ${preview.url}`).join(", "),
    });
    result = await chatUnfurl(unfurlTarget(event), build(true), api, entities(false));
    if (!result.ok) {
      console.warn("slack.unfurl: Work Object rejected again, sending blocks only", {
        error: result.error,
        detail: result.response_metadata,
      });
      result = await chatUnfurl(unfurlTarget(event), build(true), api);
    }
  }
  // Slack fetches every image before accepting the call, and one image it
  // can't fetch rejects the whole batch. Retry once without images.
  if (!result.ok && result.error && IMAGE_ERRORS.has(result.error)) {
    result = await chatUnfurl(unfurlTarget(event), build(false), api);
  }
  if (!result.ok) {
    return { status: "failed", urls: unfurledUrls, error: result.error ?? "unknown_error" };
  }
  return { status: "unfurled", urls: unfurledUrls };
}
