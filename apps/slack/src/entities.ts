/**
 * Slack Work Objects for uploads.sh share links
 * (https://docs.slack.dev/messaging/work-objects-overview).
 *
 * A Work Object is the structured card Slack draws from `metadata` on
 * `chat.unfurl`, plus a flexpane that opens beside the conversation when
 * someone clicks it. Files (and single items of a feed or gallery) are
 * `slack#/entities/file`; feeds and galleries are
 * `slack#/entities/content_item`.
 *
 * The flexpane for a feed or gallery is a pager: it shows one item at a
 * time with Newer/Older (feeds) or Previous/Next (galleries) buttons. Each
 * press re-renders the flexpane with `entity.presentDetails`.
 *
 * Everything here comes from the same public endpoints as the Block Kit
 * preview (share.ts), so a Work Object can't show more than the share page.
 * Slack shows the unfurl to everyone in the conversation and the flexpane
 * to whoever opens it; both carry the same public data.
 */
import {
  formatBytes,
  parseShareUrl,
  resolvePagerPage,
  resolvePreview,
  type EntityField,
  type PagerPage,
  type Preview,
  type ShareDeps,
} from "./share";
import { entityPresentDetails, type SlackApiOptions } from "./slack/api";

/** Flexpane pager buttons; the value is the item id to show. */
export const PAGE_PREV_ACTION = "uploads_wo_page_prev";
export const PAGE_NEXT_ACTION = "uploads_wo_page_next";

const TITLE_MAX = 150;
const FIELD_MAX = 300;

type Json = Record<string, unknown>;

/** Slack's image blocks take PNG, JPEG, GIF, and WebP; an SVG or other type fails the whole chat.unfurl call. */
export function isSlackImage(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return false;
    return !/\.(svg|svgz|avif|heic|heif|tiff?|bmp|ico)$/.test(url.pathname.toLowerCase());
  } catch {
    return false;
  }
}

/** What `chat.unfurl` (inside `metadata.entities`) and `entity.presentDetails` take. */
export type EntityMetadata = {
  entity_type: string;
  url: string;
  external_ref: { id: string; type: string };
  entity_payload: Json;
  app_unfurl_url?: string;
};

function clamp(value: string, max: number): string {
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

/** ISO date → UNIX seconds, or null. */
function unixSeconds(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

function customField(field: EntityField): Json {
  return {
    key: field.key,
    label: field.label,
    value: clamp(field.value, FIELD_MAX),
    type: "string",
    ...(field.url ? { link: field.url } : {}),
    ...(field.tag ? { tag_color: field.tag } : {}),
  };
}

function imageField(image: { url: string; alt: string } | undefined): Json | null {
  if (!image || !isSlackImage(image.url)) return null;
  return { type: "slack#/types/image", image_url: image.url, alt_text: clamp(image.alt, 100) };
}

function dateField(seconds: number | null): Json | null {
  return seconds === null ? null : { value: seconds };
}

/** Drops null entries so Slack never sees an empty field. */
function compact(fields: Record<string, Json | null>): Json {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== null));
}

/** The pager's current item, as extra body fields and buttons for a feed or gallery flexpane. */
function pagerParts(page: PagerPage, kind: "feed" | "gallery") {
  const position =
    kind === "feed"
      ? `${page.index + 1} of ${page.total}, newest first`
      : `${page.index + 1} of ${page.total}`;
  const uploaded = unixSeconds(page.item.uploaded);
  const fields: Json[] = [
    {
      key: "showing",
      label: "Showing",
      value: clamp(page.item.title, FIELD_MAX),
      type: "string",
      link: page.item.url,
    },
    { key: "position", label: "Position", value: position, type: "string" },
    ...(page.item.path
      ? [
          {
            key: "page_path",
            label: "Page",
            value: clamp(page.item.path, FIELD_MAX),
            type: "string",
          },
        ]
      : []),
    ...(uploaded !== null
      ? [{ key: "uploaded", label: "Uploaded", value: uploaded, type: "slack#/types/timestamp" }]
      : []),
  ];
  const [prevLabel, nextLabel] = kind === "feed" ? ["Newer", "Older"] : ["Previous", "Next"];
  const actions: Json[] = [];
  if (page.prev) actions.push({ text: prevLabel, action_id: PAGE_PREV_ACTION, value: page.prev });
  if (page.next) actions.push({ text: nextLabel, action_id: PAGE_NEXT_ACTION, value: page.next });
  return { fields, actions, image: page.item.image };
}

/** Options that depend on deployment config rather than the link. */
export interface EntityOptions {
  /**
   * Hosts whose image URLs answer CORS for https://app.slack.com, which
   * Slack's full-size viewer needs (`attributes.full_size_preview`). Images
   * elsewhere (BYO buckets, other lanes) get the thumbnail only.
   */
  fullSizeHosts?: readonly string[];
  /** false leaves out every image (preview, strip, full size): the fallback when Slack rejects one. */
  images?: boolean;
}

/** Parses SLACK_FULL_SIZE_HOSTS ("a.example, b.example"). */
export function parseHosts(raw: string | null | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
}

/** Slack's full-size viewer takes images and PDFs; we only send images it can draw. */
const FULL_SIZE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

function fullSizePreview(
  image: { url: string; mime?: string } | undefined,
  hosts: readonly string[],
): Json | null {
  if (!image?.mime || !FULL_SIZE_TYPES.has(image.mime) || !isSlackImage(image.url)) return null;
  if (!hosts.includes(new URL(image.url).hostname.toLowerCase())) return null;
  return { is_supported: true, preview_url: image.url, mime_type: image.mime };
}

/** A row of thumbnails: a feed's newest or a gallery's first few images. */
function stripField(images: Array<{ url: string; alt: string }> | undefined, label: string) {
  const usable = (images ?? []).filter((image) => isSlackImage(image.url));
  if (usable.length < 2) return null;
  return {
    key: "thumbnails",
    label,
    type: "array",
    item_type: "slack#/types/image",
    value: usable.map((image) => ({
      type: "slack#/types/image",
      image_url: image.url,
      alt_text: clamp(image.alt, 100),
    })),
  };
}

/**
 * The Work Object for one preview. With `page` (a feed or gallery
 * flexpane), the preview image and buttons follow the pager's item.
 */
export function entityMetadata(
  preview: Preview,
  page?: PagerPage,
  options: EntityOptions = {},
): EntityMetadata {
  const entity = preview.entity;
  const updated = unixSeconds(entity.updated);
  const created = unixSeconds(entity.created);
  const pager =
    page && entity.ref.type !== "file" && entity.type === "content_item"
      ? pagerParts(page, entity.ref.type === "feed" ? "feed" : "gallery")
      : null;
  const withImages = options.images ?? true;
  const image = !withImages ? undefined : pager ? pager.image : preview.image;
  const preview_ = imageField(image);

  const fields =
    entity.type === "file"
      ? compact({
          preview: preview_,
          date_created: dateField(created),
          date_updated: dateField(updated),
          file_size: entity.size != null ? { value: formatBytes(entity.size) ?? "" } : null,
          mime_type: entity.contentType ? { value: entity.contentType } : null,
        })
      : compact({
          // Slack draws a content item's preview as a full-width cover and
          // hides its fields, so the card leads with the thumbnail strip and
          // fields instead; the pager flexpane shows the current item.
          preview: pager ? preview_ : null,
          description: entity.description ? { value: clamp(entity.description, 1000) } : null,
          date_updated: dateField(updated),
        });

  // The strip leads on the card; in a pager flexpane the current item does.
  const thumbnails = stripField(
    withImages ? entity.strip : undefined,
    entity.ref.type === "feed" ? "Latest" : "Items",
  );
  const customFields = [
    ...(pager?.fields ?? []),
    ...(thumbnails && !pager ? [thumbnails] : []),
    ...entity.fields.map(customField),
  ];
  const fullSize =
    entity.type === "file" || pager ? fullSizePreview(image, options.fullSizeHosts ?? []) : null;
  const payload: Json = {
    attributes: {
      title: { text: clamp(preview.title, TITLE_MAX) },
      display_type: entity.displayType,
      ...(fullSize ? { full_size_preview: fullSize } : {}),
      ...(updated !== null ? { metadata_last_modified: updated } : {}),
    },
    fields,
    ...(customFields.length ? { custom_fields: customFields } : {}),
    ...(pager?.actions.length ? { actions: { primary_actions: pager.actions } } : {}),
  };

  return {
    entity_type: `slack#/entities/${entity.type}`,
    url: entity.canonicalUrl,
    external_ref: entity.ref,
    entity_payload: payload,
  };
}

/** `metadata.entities[n]` for `chat.unfurl`. */
export function unfurlEntity(preview: Preview, options: EntityOptions = {}): EntityMetadata {
  return { ...entityMetadata(preview, undefined, options), app_unfurl_url: preview.url };
}

export type DetailsOutcome = "presented" | "not_found" | "failed";

/**
 * Fills the flexpane for `link` (the URL that was unfurled) with
 * `entity.presentDetails`. `itemId` moves a feed or gallery pager to that
 * item; without it the pager starts at the feed's latest or the gallery's
 * first item. Anything that isn't public answers `not_found`.
 */
export async function presentDetails(
  input: { triggerId: string; link: string; itemId?: string },
  deps: ShareDeps & { slack: SlackApiOptions } & EntityOptions,
): Promise<DetailsOutcome> {
  const target = parseShareUrl(input.link, deps.webOrigin);
  const preview = target ? await resolvePreview(input.link, deps) : null;
  let page: PagerPage | null = null;
  if (target && preview && target.kind !== "file" && !target.itemId) {
    page = await resolvePagerPage(target, input.itemId, deps);
  }
  if (!preview || (input.itemId && !page)) {
    await entityPresentDetails(
      { trigger_id: input.triggerId, error: { status: "not_found" } },
      deps.slack,
    );
    return "not_found";
  }
  const result = await entityPresentDetails(
    {
      trigger_id: input.triggerId,
      metadata: entityMetadata(preview, page ?? undefined, { fullSizeHosts: deps.fullSizeHosts }),
    },
    deps.slack,
  );
  if (!result.ok) {
    console.error("slack.work_objects: entity.presentDetails failed", { error: result.error });
    return "failed";
  }
  return "presented";
}
