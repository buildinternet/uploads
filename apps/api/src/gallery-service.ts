import {
  ConflictError,
  NotFoundError,
  ServiceUnavailableError,
  ValidationError,
} from "@uploads/errors";
import {
  type GalleryCursor,
  type GalleryItemRecord,
  type GalleryExternalReferenceRecord,
  type GalleryRecord,
  type MutationResult,
  type PublicGallery,
  projectPublicGallery,
} from "./galleries";
import { publicUrl, storage, storageConfig } from "./storage";
import type { WorkspaceRecord } from "./workspace";

export interface GalleryItemDto {
  id: string;
  objectKey: string;
  position: number;
  caption: string | null;
  altText: string | null;
  createdAt: string;
  status: "available" | "missing";
  url: string | null;
  contentType: string | null;
  size: number | null;
}
export interface PublicGalleryItemDto {
  id: string;
  filename: string;
  position: number;
  caption: string | null;
  altText: string | null;
  status: "available" | "missing";
  url: string | null;
  contentType: string | null;
}
export interface GalleryDto {
  id: string;
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
  workspace: string;
  title: string;
  description: string | null;
  visibility: "public";
  coverItemId: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}
export type PublicGalleryDto = PublicGallery & { items: PublicGalleryItemDto[] };
export interface ExternalReferenceDto {
  id: string;
  provider: string;
  resourceType: string;
  coordinate: string;
  canonicalUrl: string | null;
  createdAt: string;
}

export function referenceDto(record: GalleryExternalReferenceRecord): ExternalReferenceDto {
  const locator = JSON.parse(record.locator_json) as {
    owner: string;
    repository: string;
    number: number;
  };
  return {
    id: record.id,
    provider: record.provider,
    resourceType: record.resource_type,
    coordinate: `${locator.owner}/${locator.repository}#${locator.number}`,
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
): Promise<GalleryItemDto[]> {
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
    let meta: { type?: string; size?: number } | null;
    try {
      meta = (await store.exists(item.object_key))
        ? ((await store.head(item.object_key)) as { type?: string; size?: number })
        : null;
    } catch (cause) {
      throw new ServiceUnavailableError("Gallery storage unavailable.", {
        code: "gallery_storage_unavailable",
        cause,
      });
    }
    const url = meta ? publicUrl(config, item.object_key) : null;
    if (meta && url === null)
      throw new ServiceUnavailableError("Gallery object is not publicly served.", {
        code: "gallery_object_not_public",
      });
    return {
      id: item.id,
      objectKey: item.object_key,
      position: item.position,
      caption: item.caption,
      altText: item.alt_text,
      createdAt: item.created_at,
      status: meta ? "available" : "missing",
      url,
      contentType: meta?.type ?? null,
      size: meta?.size ?? null,
    };
  });
}

export function gallerySummary(record: GalleryRecord): GallerySummaryDto {
  return {
    id: record.id,
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
    workspace: record.workspace,
    title: record.title,
    description: record.description,
    visibility: record.visibility,
    coverItemId: record.cover_item_id,
    version: record.version,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
    items: await hydrateGalleryItems(env, workspace, items),
  };
}

export async function hydratePublicGallery(
  env: Env,
  workspace: WorkspaceRecord,
  record: GalleryRecord,
  items: GalleryItemRecord[],
): Promise<PublicGalleryDto> {
  const hydrated = await hydrateGalleryItems(env, workspace, items);
  return {
    ...projectPublicGallery(record),
    items: hydrated.map((item) => ({
      id: item.id,
      filename: item.objectKey.split("/").at(-1) ?? item.objectKey,
      position: item.position,
      caption: item.caption,
      altText: item.altText,
      status: item.status,
      url: item.url,
      contentType: item.contentType,
    })),
  };
}
