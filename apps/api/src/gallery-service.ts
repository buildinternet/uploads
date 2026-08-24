import {
  ConflictError,
  NotFoundError,
  ServiceUnavailableError,
  ValidationError,
} from "@uploads/errors";
import { publicObjectDateFields } from "./files-core";
import { getMetadataForKeys } from "./file-metadata";
import { VIDEO_TYPES } from "./guards";
import { videoPresentation, type VideoDimensions } from "./poster";
import {
  type GalleryCursor,
  type GalleryItemRecord,
  type GalleryExternalReferenceRecord,
  type GalleryRecord,
  type MutationResult,
  type PublicGallery,
  countItemsForGalleries,
  firstItemKeyForGalleries,
  itemKeysByIds,
  listExternalReferencesForGalleries,
  projectPublicGallery,
} from "./galleries";
import { createLaneResolver, objectPublicUrls, type LaneResolver } from "./storage";
import type { StorageConfig } from "@uploads/storage";
import { objectVisibility } from "./visibility";
import { webOrigin } from "./web-url";
import type { WorkspaceRecord } from "./workspace";
import { dbFor } from "./db-session";

/** Fields we read from a Files SDK head when hydrating gallery items. */
type GalleryObjectHead = {
  type?: string;
  size?: number;
  lastModified?: number;
  metadata?: Record<string, string>;
};

export interface GalleryItemDto {
  id: string;
  objectKey: string;
  position: number;
  caption: string | null;
  altText: string | null;
  createdAt: string;
  status: "available" | "missing" | "withheld";
  url: string | null;
  /** Same object on the embed host when dual-host policy applies; for GitHub markdown. */
  embedUrl: string | null;
  pageUrl: string;
  contentType: string | null;
  size: number | null;
  /** First-upload ISO when known from object head; null for missing items. */
  uploaded: string | null;
  /** Last-modified ISO when it meaningfully differs from uploaded; else null. */
  modified: string | null;
  /** Public URL of the derived poster frame (issue #299); videos with one only. */
  posterUrl?: string;
  /** Real video dimensions for reserving aspect ratio before playback. */
  videoDimensions?: VideoDimensions;
}
export interface PublicGalleryItemDto {
  id: string;
  filename: string;
  position: number;
  caption: string | null;
  altText: string | null;
  status: "available" | "missing" | "withheld";
  url: string | null;
  embedUrl: string | null;
  contentType: string | null;
  /** Byte size when available; null for missing/tombstone items. */
  size: number | null;
  /** First-upload time when known; omitted when unavailable. */
  uploaded?: string;
  /** Distinct last-modified when it differs from uploaded. */
  modified?: string;
  /** Public URL of the derived poster frame (issue #299); videos with one only. */
  posterUrl?: string;
  /** Real video dimensions for reserving aspect ratio before playback. */
  videoDimensions?: VideoDimensions;
}
export interface GalleryDto {
  id: string;
  url: string;
  workspace: string;
  title: string;
  description: string | null;
  visibility: "public";
  coverItemId: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  items: GalleryItemDto[];
}
export interface GallerySummaryDto {
  id: string;
  url: string;
  workspace: string;
  title: string;
  description: string | null;
  visibility: "public";
  coverItemId: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

/** List-row summary: base fields plus item count and linked PR/issue refs. */
export interface GalleryListSummaryDto extends GallerySummaryDto {
  itemCount: number;
  references: ExternalReferenceDto[];
  /**
   * Public URL of the gallery's cover image, for a list/grid thumbnail. Resolves
   * the explicit `cover_item_id`, else the first item. `null` when the gallery
   * is empty, its cover isn't a still image (videos/other are skipped — no head
   * or poster lookup on the list path), or the workspace has no public domain.
   * Additive: absent on the cheaper bearer `gallerySummary` projection.
   */
  previewUrl: string | null;
}
export type PublicGalleryDto = PublicGallery & {
  items: PublicGalleryItemDto[];
};
export interface ExternalReferenceDto {
  id: string;
  provider: string;
  resourceType: string;
  coordinate: string;
  canonicalUrl: string | null;
  createdAt: string;
}

function referenceCoordinate(record: GalleryExternalReferenceRecord): string {
  const locator = JSON.parse(record.locator_json) as {
    owner: string;
    repository: string;
    number: number;
  };
  return `${locator.owner}/${locator.repository}#${locator.number}`;
}

export function referenceDto(record: GalleryExternalReferenceRecord): ExternalReferenceDto {
  return {
    id: record.id,
    provider: record.provider,
    resourceType: record.resource_type,
    coordinate: referenceCoordinate(record),
    canonicalUrl: record.canonical_url,
    createdAt: record.created_at,
  };
}

export function mutationError(
  result: Exclude<MutationResult<unknown>, { status: "ok" | "unchanged" }>,
): never {
  switch (result.status) {
    case "not_found":
      throw new NotFoundError(
        result.entity === "item"
          ? "Gallery item not found."
          : result.entity === "reference"
            ? "Gallery reference not found."
            : "Gallery not found.",
        {
          code:
            result.entity === "item"
              ? "gallery_item_not_found"
              : result.entity === "reference"
                ? "gallery_reference_not_found"
                : "gallery_not_found",
        },
      );
    case "conflict":
      throw new ConflictError("Gallery was changed by another request.", {
        code: "gallery_version_conflict",
        details: { currentVersion: result.currentVersion },
      });
    case "limit":
      throw new ConflictError("Gallery limit reached.", {
        code: "gallery_limit_reached",
        details: { limit: result.limit },
      });
    case "invalid":
      throw new ValidationError(result.message, {
        code: "gallery_invalid_field",
        details: { field: result.field },
      });
  }
}

export function unwrapMutation<T>(result: MutationResult<T>): { value: T; unchanged: boolean } {
  if (result.status === "ok") return { value: result.value, unchanged: false };
  if (result.status === "unchanged") return { value: result.value, unchanged: true };
  return mutationError(result);
}

export function requireExpectedVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1)
    throw new ValidationError("expectedVersion must be a positive integer.", {
      details: { field: "expectedVersion" },
    });
  return value as number;
}

export function encodeGalleryCursor(cursor: GalleryCursor): string {
  return btoa(JSON.stringify({ v: 1, createdAt: cursor.createdAt, id: cursor.id }))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function decodeGalleryCursor(value: string | undefined): GalleryCursor | undefined {
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(atob(value.replace(/-/g, "+").replace(/_/g, "/")));
    if (typeof parsed !== "object" || parsed === null) throw new Error();
    const record = parsed as Record<string, unknown>;
    if (
      record.v !== 1 ||
      typeof record.createdAt !== "string" ||
      !Number.isFinite(Date.parse(record.createdAt)) ||
      typeof record.id !== "string" ||
      !/^gal_[A-Za-z0-9_-]{22}$/.test(record.id)
    )
      throw new Error();
    return { createdAt: record.createdAt, id: record.id };
  } catch {
    throw new ValidationError("Invalid gallery cursor.", { code: "gallery_invalid_cursor" });
  }
}

/** The filename shown/used on public gallery surfaces: the object key's basename. */
export function galleryItemFilename(objectKey: string): string {
  return objectKey.split("/").at(-1) ?? objectKey;
}

async function mapBounded<T, R>(
  values: T[],
  concurrency: number,
  fn: (value: T) => Promise<R>,
): Promise<R[]> {
  const result = Array.from<R>({ length: values.length });
  let next = 0;
  async function worker() {
    for (;;) {
      const index = next++;
      if (index >= values.length) return;
      result[index] = await fn(values[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return result;
}

export async function hydrateGalleryItems(
  env: Env,
  workspace: WorkspaceRecord,
  items: GalleryItemRecord[],
  opts: { audience: "owner" | "public" } = { audience: "owner" },
): Promise<Omit<GalleryItemDto, "pageUrl">[]> {
  // Two-lane storage (PR C audit): each item resolves its OWN lane via a
  // shared `LaneResolver` — a gallery can reference objects uploaded before
  // a storage switch, and the resolver caches each lane's store/config
  // across all of this gallery's items instead of re-resolving (and
  // re-decrypting a fallback lane's credentials) per item. Confirm the
  // active lane itself resolves up front so a misconfigured workspace still
  // fails fast with the same error as before, rather than failing per-item
  // deep inside `mapBounded`.
  const resolver = createLaneResolver(env, workspace);
  try {
    await resolver.activeConfig();
  } catch (cause) {
    throw new ServiceUnavailableError("Gallery storage unavailable.", {
      code: "gallery_storage_unavailable",
      cause,
    });
  }
  const laneConfigByKey = new Map<string, StorageConfig>();
  const hydrated = await mapBounded(
    items,
    8,
    async (item): Promise<Omit<GalleryItemDto, "pageUrl">> => {
      let meta: GalleryObjectHead | null;
      let itemConfig: StorageConfig | null = null;
      try {
        const lane = await resolver.resolve(item.object_key);
        if (lane) {
          itemConfig = lane.config;
          laneConfigByKey.set(item.object_key, lane.config);
          meta = (await lane.store.head(item.object_key)) as GalleryObjectHead;
        } else {
          meta = null;
        }
      } catch (cause) {
        throw new ServiceUnavailableError("Gallery storage unavailable.", {
          code: "gallery_storage_unavailable",
          cause,
        });
      }
      const isPrivate = meta ? objectVisibility(meta.metadata) === "private" : false;
      const withheld = opts.audience === "public" && isPrivate;
      const urls =
        meta && !withheld && itemConfig
          ? objectPublicUrls(env, itemConfig, item.object_key)
          : { url: null, embedUrl: null };
      if (meta && !withheld && urls.url === null)
        throw new ServiceUnavailableError("Gallery object is not publicly served.", {
          code: "gallery_object_not_public",
        });
      const dates = meta && !withheld ? publicObjectDateFields(meta) : {};
      return {
        id: item.id,
        objectKey: item.object_key,
        position: item.position,
        caption: item.caption,
        altText: item.alt_text,
        createdAt: item.created_at,
        status: withheld ? "withheld" : meta ? "available" : "missing",
        url: urls.url,
        embedUrl: urls.embedUrl,
        contentType: withheld ? null : (meta?.type ?? null),
        size: withheld ? null : (meta?.size ?? null),
        uploaded: dates.uploaded ?? null,
        modified: dates.modified ?? null,
      };
    },
  );

  // Poster + real dimensions for videos (issue #299): the `video.*` sentinel
  // rows live in D1 (server-owned, stamped at poster generation), so the
  // object heads above can't tell us. One batched D1 read for all video items;
  // failures degrade to bare <video> elements rather than failing the gallery.
  const videoKeys = hydrated
    .filter((item) => item.url !== null && VIDEO_TYPES.has(item.contentType ?? ""))
    .map((item) => item.objectKey);
  if (videoKeys.length > 0 && workspace.name) {
    try {
      const metadataByKey = await getMetadataForKeys(dbFor(env), workspace.name, videoKeys, {
        metaKeys: ["video.poster", "video.width", "video.height"],
      });
      for (const item of hydrated) {
        const metadata = metadataByKey.get(item.objectKey);
        // Same lane the primary object resolved from above — posters are
        // written alongside their video at upload time, so they live in the
        // same lane by construction.
        const itemConfig = laneConfigByKey.get(item.objectKey);
        if (!metadata || !itemConfig) continue;
        const { posterUrl, videoDimensions } = videoPresentation(
          env,
          itemConfig,
          item.objectKey,
          metadata,
        );
        if (posterUrl) item.posterUrl = posterUrl;
        if (videoDimensions) item.videoDimensions = videoDimensions;
      }
    } catch {
      // D1 blip — render the videos without posters.
    }
  }
  return hydrated;
}

export function galleryUrl(env: Env, id: string): string {
  return webOrigin(env) + "/g/" + encodeURIComponent(id);
}

export function galleryItemUrl(env: Env, galleryId: string, itemId: string): string {
  return galleryUrl(env, galleryId) + "/" + encodeURIComponent(itemId);
}

export function gallerySummary(env: Env, record: GalleryRecord): GallerySummaryDto {
  return {
    id: record.id,
    url: galleryUrl(env, record.id),
    workspace: record.workspace,
    title: record.title,
    description: record.description,
    visibility: record.visibility,
    coverItemId: record.cover_item_id,
    version: record.version,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
  };
}

/** Still-image extensions we'll preview inline; videos/other fall back to a placeholder tile. */
const PREVIEW_IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif"]);

/** True when `key`'s extension is a still image safe to render as an `<img>` thumbnail. */
function isPreviewImageKey(key: string): boolean {
  const dot = key.lastIndexOf(".");
  if (dot < 0) return false;
  return PREVIEW_IMAGE_EXTS.has(key.slice(dot + 1).toLowerCase());
}

/**
 * Cover URL for one gallery, or `null` unless it's a still image the caller
 * can actually resolve to a lane. Two-lane storage (PR C audit): this now
 * resolves the cover key's owning lane via `resolver` — a cover uploaded
 * before a storage switch previously derived the wrong (active-lane) host.
 * `resolver` caches lane store/config across every gallery in one
 * `galleryListSummaries` call, so this costs one `exists` probe per
 * *distinct* cover key, not a re-decrypt per gallery. The list endpoint
 * historically needed no storage existence check at all — a
 * misconfigured/undecryptable workspace, or a lane resolve failure, must
 * still degrade to no thumbnail rather than 503 the whole list (unlike
 * `hydrateGalleryItems`, which hard-fails).
 */
async function previewUrlForKey(
  env: Env,
  resolver: LaneResolver,
  key: string | null,
): Promise<string | null> {
  if (!key || !isPreviewImageKey(key)) return null;
  let lane: Awaited<ReturnType<LaneResolver["resolve"]>>;
  try {
    lane = await resolver.resolve(key);
  } catch {
    return null;
  }
  if (!lane) return null;
  const { url, embedUrl } = objectPublicUrls(env, lane.config, key);
  return embedUrl ?? url;
}

/**
 * Attach item counts, external refs, and a cover preview URL via batch queries.
 * Takes the `WorkspaceRecord` (not just the name) so it can resolve storage for
 * the preview; the DB queries key off `workspace.name`, falling back to the
 * records' own workspace when a hand-built record omits it.
 */
export async function galleryListSummaries(
  env: Env,
  workspace: WorkspaceRecord,
  records: GalleryRecord[],
): Promise<GalleryListSummaryDto[]> {
  if (!records.length) return [];
  const name = workspace.name ?? records[0].workspace;
  const ids = records.map((record) => record.id);
  const coverIds = records
    .map((record) => record.cover_item_id)
    .filter((id): id is string => id !== null);
  const [itemCounts, refsByGallery, firstKeys, coverKeys] = await Promise.all([
    countItemsForGalleries(dbFor(env), name, ids),
    listExternalReferencesForGalleries(dbFor(env), name, ids),
    firstItemKeyForGalleries(dbFor(env), name, ids),
    itemKeysByIds(dbFor(env), name, coverIds),
  ]);
  const resolver = createLaneResolver(env, workspace);
  return Promise.all(
    records.map(async (record) => {
      const coverKey =
        (record.cover_item_id ? coverKeys.get(record.cover_item_id) : undefined) ??
        firstKeys.get(record.id) ??
        null;
      return {
        ...gallerySummary(env, record),
        itemCount: itemCounts.get(record.id) ?? 0,
        references: (refsByGallery.get(record.id) ?? []).map(referenceDto),
        previewUrl: await previewUrlForKey(env, resolver, coverKey),
      };
    }),
  );
}

export async function hydrateOwnerGallery(
  env: Env,
  workspace: WorkspaceRecord,
  record: GalleryRecord,
  items: GalleryItemRecord[],
): Promise<GalleryDto> {
  return {
    id: record.id,
    url: galleryUrl(env, record.id),
    workspace: record.workspace,
    title: record.title,
    description: record.description,
    visibility: record.visibility,
    coverItemId: record.cover_item_id,
    version: record.version,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
    items: (await hydrateGalleryItems(env, workspace, items, { audience: "owner" })).map(
      (item) => ({
        ...item,
        pageUrl: galleryItemUrl(env, record.id, item.id),
      }),
    ),
  };
}

export async function hydratePublicGallery(
  env: Env,
  workspace: WorkspaceRecord,
  record: GalleryRecord,
  items: GalleryItemRecord[],
): Promise<PublicGalleryDto> {
  const hydrated = await hydrateGalleryItems(env, workspace, items, { audience: "public" });
  return {
    ...projectPublicGallery(record),
    items: hydrated.map((item) => ({
      id: item.id,
      filename: galleryItemFilename(item.objectKey),
      position: item.position,
      caption: item.caption,
      altText: item.altText,
      status: item.status,
      url: item.url,
      embedUrl: item.embedUrl,
      contentType: item.contentType,
      size: item.size,
      ...(item.uploaded ? { uploaded: item.uploaded } : {}),
      ...(item.modified ? { modified: item.modified } : {}),
      ...(item.posterUrl ? { posterUrl: item.posterUrl } : {}),
      ...(item.videoDimensions ? { videoDimensions: item.videoDimensions } : {}),
    })),
  };
}
