import {
  ConflictError,
  NotFoundError,
  ServiceUnavailableError,
  ValidationError,
} from "@uploads/errors";
import { publicObjectDateFields } from "./files-core";
import { displayTitle } from "./file-metadata";
import {
  type GalleryCursor,
  type GalleryItemRecord,
  type GalleryExternalReferenceRecord,
  type GalleryRecord,
  type MutationResult,
  type PublicGallery,
  projectPublicGallery,
} from "./galleries";
import { resolveTitles, withPublicTitleBudget, type TitleInfo } from "./github-titles";
import { objectPublicUrls, storage, storageConfig } from "./storage";
import { webOrigin } from "./web-url";
import type { WorkspaceRecord } from "./workspace";

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
  status: "available" | "missing";
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
}
export interface PublicGalleryItemDto {
  id: string;
  filename: string;
  position: number;
  caption: string | null;
  altText: string | null;
  status: "available" | "missing";
  url: string | null;
  embedUrl: string | null;
  contentType: string | null;
  /** Byte size when available; null for missing/tombstone items. */
  size: number | null;
  /** First-upload time when known; omitted when unavailable. */
  uploaded?: string;
  /** Distinct last-modified when it differs from uploaded. */
  modified?: string;
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
export type PublicGalleryDto = PublicGallery & {
  items: PublicGalleryItemDto[];
  references: PublicGalleryReferenceDto[];
};
export interface PublicGalleryReferenceDto {
  provider: string;
  resourceType: string;
  coordinate: string;
  canonicalUrl: string | null;
  /** Live-resolved (or cached) GitHub title when available. */
  title?: string;
  /** pull vs issue when title resolve (or URL path) knows; drives the chip glyph. */
  kind?: "pull" | "issue";
}
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

export function publicReferenceDto(
  record: GalleryExternalReferenceRecord,
): PublicGalleryReferenceDto {
  return {
    provider: record.provider,
    resourceType: record.resource_type,
    coordinate: referenceCoordinate(record),
    canonicalUrl: record.canonical_url,
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
): Promise<Omit<GalleryItemDto, "pageUrl">[]> {
  let store: Awaited<ReturnType<typeof storage>>;
  let config: Awaited<ReturnType<typeof storageConfig>>;
  try {
    [store, config] = await Promise.all([storage(env, workspace), storageConfig(env, workspace)]);
  } catch (cause) {
    throw new ServiceUnavailableError("Gallery storage unavailable.", {
      code: "gallery_storage_unavailable",
      cause,
    });
  }
  return mapBounded(items, 8, async (item) => {
    let meta: GalleryObjectHead | null;
    try {
      meta = (await store.exists(item.object_key))
        ? ((await store.head(item.object_key)) as GalleryObjectHead)
        : null;
    } catch (cause) {
      throw new ServiceUnavailableError("Gallery storage unavailable.", {
        code: "gallery_storage_unavailable",
        cause,
      });
    }
    const urls = meta
      ? objectPublicUrls(env, config, item.object_key)
      : { url: null, embedUrl: null };
    if (meta && urls.url === null)
      throw new ServiceUnavailableError("Gallery object is not publicly served.", {
        code: "gallery_object_not_public",
      });
    const dates = meta ? publicObjectDateFields(meta) : {};
    return {
      id: item.id,
      objectKey: item.object_key,
      position: item.position,
      caption: item.caption,
      altText: item.alt_text,
      createdAt: item.created_at,
      status: meta ? "available" : "missing",
      url: urls.url,
      embedUrl: urls.embedUrl,
      contentType: meta?.type ?? null,
      size: meta?.size ?? null,
      uploaded: dates.uploaded ?? null,
      modified: dates.modified ?? null,
    };
  });
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
    items: (await hydrateGalleryItems(env, workspace, items)).map((item) => ({
      ...item,
      pageUrl: galleryItemUrl(env, record.id, item.id),
    })),
  };
}

/** Rewrite `owner/repo#N` to a pull URL when title resolve says it's a PR. */
function githubPullUrl(coordinate: string): string | null {
  const match = /^([^/]+)\/([^#]+)#([1-9][0-9]*)$/.exec(coordinate);
  if (!match) return null;
  return `https://github.com/${match[1]}/${match[2]}/pull/${match[3]}`;
}

/**
 * Overlay live/cached GitHub titles onto public gallery references.
 * Failures and budget timeouts never fail the public gallery response.
 */
export async function enrichPublicReferences(
  env: Env,
  references: GalleryExternalReferenceRecord[],
): Promise<PublicGalleryReferenceDto[]> {
  const base = references.map(publicReferenceDto);
  const githubRefs = [
    ...new Set(
      base
        .filter((ref) => ref.provider.toLowerCase() === "github")
        .map((ref) => ref.coordinate.toLowerCase()),
    ),
  ];
  if (githubRefs.length === 0) return base;

  // Missing GITHUB_CACHE / App misconfig / transient / budget — keep bare refs.
  const titles: Record<string, TitleInfo | null> =
    (await withPublicTitleBudget(resolveTitles(env, githubRefs)).catch(() => null)) ?? {};

  return base.map((ref) => {
    if (ref.provider.toLowerCase() !== "github") return ref;
    const info = titles[ref.coordinate.toLowerCase()];
    if (!info) return ref;
    const title = displayTitle(info.title);
    // Prefer pull URL when resolve knows it's a PR (API always stamps /issues/).
    const pullUrl = info.kind === "pull" ? githubPullUrl(ref.coordinate) : null;
    return {
      ...ref,
      ...(title ? { title } : {}),
      kind: info.kind,
      canonicalUrl: pullUrl ?? ref.canonicalUrl,
    };
  });
}

export async function hydratePublicGallery(
  env: Env,
  workspace: WorkspaceRecord,
  record: GalleryRecord,
  items: GalleryItemRecord[],
  references: GalleryExternalReferenceRecord[] = [],
): Promise<PublicGalleryDto> {
  const [hydrated, publicReferences] = await Promise.all([
    hydrateGalleryItems(env, workspace, items),
    enrichPublicReferences(env, references),
  ]);
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
    })),
    references: publicReferences,
  };
}
