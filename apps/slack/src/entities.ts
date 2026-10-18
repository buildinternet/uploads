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
  type EntityItemRef,
  type PagerPage,
  type Preview,
  type ShareDeps,
} from "./share";
import { entityPresentDetails, type SlackApiOptions } from "./slack/api";

/** Flexpane pager buttons; the value is the item id to show. */
export const PAGE_PREV_ACTION = "uploads_wo_page_prev";
export const PAGE_NEXT_ACTION = "uploads_wo_page_next";
/** URL buttons in the overflow menu; Slack opens the URL, so the press needs no handling. */
export const OPEN_LINK_ACTION = "uploads_wo_open";
/** Slack allows up to five overflow actions. */
const MAX_OVERFLOW = 5;

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

/** `iconBase` is where the field icons are served; without it, fields carry no icon. */
function customField(field: EntityField, iconBase?: string): Json {
  return {
    key: field.key,
    label: field.label,
    value: clamp(field.value, FIELD_MAX),
    type: "string",
    ...(field.url ? { link: field.url } : {}),
    ...(field.tag
      ? { tag_color: field.tag }
      : field.icon && iconBase
        ? { icon: { url: `${iconBase}/${field.icon}.png`, alt_text: field.label } }
        : {}),
  };
}

/** The header icon for each kind of link, in place of the app icon. */
const TYPE_ICONS: Record<string, string> = {
  Image: "type-image",
  Video: "type-video",
  PDF: "type-pdf",
  Audio: "type-audio",
  Text: "type-text",
  File: "type-file",
  // Feeds and galleries share one icon: it says "several items", nothing more.
  "Change feed": "type-collection",
  Gallery: "type-collection",
};

function productIcon(displayType: string, iconBase: string | undefined): Json | null {
  const name = TYPE_ICONS[displayType];
  return name && iconBase ? { url: `${iconBase}/${name}.png`, alt_text: displayType } : null;
}

function imageField(image: { url: string; alt: string } | undefined): Json | null {
  if (!image || !isSlackImage(image.url)) return null;
  return { type: "slack#/types/image", image_url: image.url, alt_text: clamp(image.alt, 100) };
}

function dateField(seconds: number | null): Json | null {
  return seconds === null ? null : { value: seconds };
}

/**
 * Slack only accepts `external_ref.id` matching `^[0-9a-zA-Z\-_:!\/=]+$`
 * and rejects the whole Work Object (`error_processing_metadata`) otherwise.
 * Our ids are file keys, so dots, spaces, and other characters get escaped
 * as `!` plus their UTF-8 bytes in hex; `!` itself is escaped so the
 * mapping stays one-to-one, and ids that are already valid don't change.
 */
export function slackRef<T extends { id: string }>(ref: T): T {
  const id = ref.id.replace(/[^0-9a-zA-Z\-_:/=]/gu, (char) =>
    [...new TextEncoder().encode(char)]
      .map((byte) => `!${byte.toString(16).padStart(2, "0")}`)
      .join(""),
  );
  return { ...ref, id };
}

/** uploads.sh's mark, for unfurl context lines and as the default Work Object creator. */
export const PROVIDER_ICON_URL = "https://uploads.sh/apple-touch-icon.png";

/**
 * The entity's creator, which Slack shows as the avatar and name on the
 * card's viewer: the repo owner's GitHub account (public: it's in the repo
 * name), or uploads.sh itself when there's no repo (galleries, plain files),
 * since the public API carries no uploader.
 */
function creatorField(owner: string | undefined, withImages: boolean): Json {
  const user = owner
    ? {
        text: owner,
        url: `https://github.com/${owner}`,
        icon: `https://avatars.githubusercontent.com/${owner}`,
      }
    : { text: "uploads.sh", url: "https://uploads.sh", icon: PROVIDER_ICON_URL };
  return {
    type: "slack#/types/user",
    user: {
      text: user.text,
      url: user.url,
      ...(withImages ? { icon: { url: user.icon, alt_text: user.text } } : {}),
    },
  };
}

/** A collection's items as `entity_ref`s, so each opens as its own Work Object. */
function itemsField(items: EntityItemRef[] | undefined, label: string, withImages: boolean) {
  if (!items?.length) return null;
  return {
    key: "items_list",
    label,
    type: "array",
    item_type: "slack#/types/entity_ref",
    value: items.map((item) => ({
      type: "slack#/types/entity_ref",
      entity_ref: {
        entity_url: item.url,
        external_ref: slackRef(item.ref),
        title: clamp(item.title, TITLE_MAX),
        display_type: item.displayType,
        ...(withImages && item.image && isSlackImage(item.image)
          ? { icon: { url: item.image, alt_text: clamp(item.title, 100) } }
          : {}),
      },
    })),
  };
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
  /** false leaves out every image (preview, icons, full size): the fallback when Slack rejects one. */
  images?: boolean;
  /** Building the side panel (`entity.presentDetails`) rather than the card. */
  details?: boolean;
  /** Where the field and header icons are served, e.g. https://agents.uploads.sh/slack/icons. */
  iconBase?: string;
}

/** A file's size and content type, for the end of its side panel. */
function fileFacts(entity: Preview["entity"]): Json[] {
  const size = entity.size != null ? formatBytes(entity.size) : null;
  return [
    ...(size ? [customField({ key: "file_size", label: "Size", value: size })] : []),
    ...(entity.contentType
      ? [customField({ key: "content_type", label: "Type", value: entity.contentType })]
      : []),
  ];
}

/** Parses SLACK_FULL_SIZE_HOSTS ("a.example, b.example"). */
export function parseHosts(raw: string | null | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
}

/** Slack's full-size viewer takes images and PDFs (not video); these are the ones it can draw. */
const FULL_SIZE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
]);

function fullSizePreview(
  image: { url: string; mime?: string } | undefined,
  hosts: readonly string[],
): Json | null {
  if (!image?.mime || !FULL_SIZE_TYPES.has(image.mime) || !isSlackImage(image.url)) return null;
  if (!hosts.includes(new URL(image.url).hostname.toLowerCase())) return null;
  return { is_supported: true, preview_url: image.url, mime_type: image.mime };
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
  // The card leads with the PR and path; the creator (often the same org
  // for every link) only shows in the side panel.
  const details = options.details ?? false;
  // Icons are images too, so the imageless fallback leaves them out.
  const iconBase = withImages ? options.iconBase : undefined;
  const image = !withImages ? undefined : pager ? pager.image : preview.image;
  const preview_ = imageField(image);

  // A feed or gallery card is its image alone: Slack draws the cover full
  // width and clips whatever fields follow, so they live in the side panel.
  // Without an image (say, only videos with no poster) the fields stay.
  const imageOnly = entity.type === "content_item" && !details && preview_ !== null;

  const fields = imageOnly
    ? { preview: preview_ }
    : entity.type === "file"
      ? compact({
          preview: preview_,
          created_by: details ? creatorField(entity.owner, withImages) : null,
          date_created: dateField(created),
          // A file's update time is its upload time; one date is enough.
          date_updated: updated !== created ? dateField(updated) : null,
        })
      : compact({
          // In the side panel the preview follows the pager's item.
          preview: preview_,
          description: entity.description ? { value: clamp(entity.description, 1000) } : null,
          created_by: details ? creatorField(entity.owner, withImages) : null,
          date_updated: dateField(updated),
        });

  // The side panel lists the collection's items, each a link to its own
  // Work Object.
  const itemList = pager
    ? itemsField(entity.items, entity.ref.type === "feed" ? "Latest files" : "Items", withImages)
    : null;
  const customFields = imageOnly
    ? []
    : [
        ...(pager?.fields ?? []),
        ...(itemList ? [itemList] : []),
        ...entity.fields.map((field) => customField(field, iconBase)),
        // Size and type are trivia: the card leaves them out so the PR and page
        // path lead, and the side panel lists them last.
        ...(entity.type === "file" && details ? fileFacts(entity) : []),
      ];
  const overflow = (entity.links ?? []).slice(0, MAX_OVERFLOW).map((link, index) => ({
    text: link.text,
    action_id: `${OPEN_LINK_ACTION}_${index}`,
    url: link.url,
  }));
  const actions = {
    ...(pager?.actions.length ? { primary_actions: pager.actions } : {}),
    ...(overflow.length ? { overflow_actions: overflow } : {}),
  };
  // A PDF has no preview image, so the viewer opens the PDF itself.
  const fullSizeSource =
    entity.type === "file" && entity.pdfUrl && withImages
      ? { url: entity.pdfUrl, mime: "application/pdf" }
      : entity.type === "file" || pager
        ? image
        : undefined;
  const fullSize = fullSizePreview(fullSizeSource, options.fullSizeHosts ?? []);
  const payload: Json = {
    attributes: {
      title: { text: clamp(preview.title, TITLE_MAX) },
      display_type: entity.displayType,
      ...(productIcon(entity.displayType, iconBase)
        ? { product_icon: productIcon(entity.displayType, iconBase) }
        : {}),
      ...(fullSize ? { full_size_preview: fullSize } : {}),
      ...(updated !== null ? { metadata_last_modified: updated } : {}),
    },
    fields,
    ...(customFields.length ? { custom_fields: customFields } : {}),
    ...(Object.keys(actions).length ? { actions } : {}),
  };

  return {
    entity_type: `slack#/entities/${entity.type}`,
    url: entity.canonicalUrl,
    external_ref: slackRef(entity.ref),
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
      metadata: entityMetadata(preview, page ?? undefined, {
        fullSizeHosts: deps.fullSizeHosts,
        iconBase: deps.iconBase,
        details: true,
      }),
    },
    deps.slack,
  );
  if (!result.ok) {
    console.error("slack.work_objects: entity.presentDetails failed", { error: result.error });
    return "failed";
  }
  return "presented";
}
