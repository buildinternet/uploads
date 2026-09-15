/**
 * Hydration + public/owner DTOs for repo change feeds. The feed record is
 * just a query; this module runs it against `file_metadata` (newest first)
 * and resolves public URLs the same way galleries do.
 */
import {
  ConflictError,
  NotFoundError,
  ServiceUnavailableError,
  ValidationError,
} from "@uploads/errors";
import { publicObjectDateFields } from "./files-core";
import { getMetadataForKeys } from "./file-metadata";
import {
  FEED_ID_RE,
  FEED_ITEM_LIMIT,
  feedTitle,
  type FeedCursor,
  type FeedMutationResult,
  type FeedRecord,
} from "./feeds";
import { VIDEO_TYPES } from "./guards";
import { videoPresentation, type VideoDimensions } from "./poster";
import { createLaneResolver, objectPublicUrls, type LaneResolver } from "./storage";
import type { StorageConfig } from "@uploads/storage";
import { objectVisibility } from "./visibility";
import { webOrigin } from "./web-url";
import { sha256Hex, type WorkspaceRecord } from "./workspace";
import { dbFor, type D1Queryable } from "./db-session";

type FeedObjectHead = {
  type?: string;
  size?: number;
  lastModified?: number;
  metadata?: Record<string, string>;
};

export interface FeedItemDto {
  id: string;
  objectKey: string;
  filename: string;
  status: "available" | "missing" | "withheld";
  url: string | null;
  embedUrl: string | null;
  contentType: string | null;
  size: number | null;
  uploaded: string | null;
  modified: string | null;
  path: string | null;
  state: string | null;
  posterUrl?: string;
  videoDimensions?: VideoDimensions;
}

export interface PublicFeedItemDto {
  id: string;
  filename: string;
  status: "available" | "missing" | "withheld";
  url: string | null;
  embedUrl: string | null;
  contentType: string | null;
  size: number | null;
  uploaded?: string;
  modified?: string;
  path: string | null;
  state: string | null;
  posterUrl?: string;
  videoDimensions?: VideoDimensions;
}

export interface FeedDto {
  id: string;
  url: string;
  workspace: string;
  repo: string;
  path: string | null;
  number: number | null;
  kind: "pull" | "issue" | null;
  title: string;
  createdAt: string;
  updatedAt: string;
  items: FeedItemDto[];
}

export interface FeedSummaryDto {
  id: string;
  url: string;
  workspace: string;
  repo: string;
  path: string | null;
  number: number | null;
  kind: "pull" | "issue" | null;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export type PublicFeedDto = {
  id: string;
  title: string;
  repo: string;
  path: string | null;
  number: number | null;
  kind: "pull" | "issue" | null;
  createdAt: string;
  updatedAt: string;
  items: PublicFeedItemDto[];
};

export function feedUrl(env: Env, id: string): string {
  return webOrigin(env) + "/feed/" + encodeURIComponent(id);
}

export function feedSummary(env: Env, record: FeedRecord): FeedSummaryDto {
  return {
    id: record.id,
    url: feedUrl(env, record.id),
    workspace: record.workspace,
    repo: record.repo,
    path: record.path || null,
    number: record.number > 0 ? record.number : null,
    kind: record.kind === "pull" || record.kind === "issue" ? record.kind : null,
    title: feedTitle(record.repo, record.path, record.number),
    createdAt: record.created_at,
    updatedAt: record.updated_at,
  };
}

export function encodeFeedCursor(cursor: FeedCursor): string {
  return btoa(JSON.stringify({ v: 1, createdAt: cursor.createdAt, id: cursor.id }))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function decodeFeedCursor(value: string | undefined): FeedCursor | undefined {
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
      !FEED_ID_RE.test(record.id)
    )
      throw new Error();
    return { createdAt: record.createdAt, id: record.id };
  } catch {
    throw new ValidationError("Invalid feed cursor.", { code: "feed_invalid_cursor" });
  }
}

export function feedMutationError(
  result: Exclude<FeedMutationResult<unknown>, { status: "ok" }>,
): never {
  switch (result.status) {
    case "not_found":
      throw new NotFoundError("Feed not found.", { code: "feed_not_found" });
    case "limit":
      throw new ConflictError("Feed limit reached.", {
        code: "feed_limit_reached",
        details: { limit: result.limit },
      });
    case "invalid":
      throw new ValidationError(result.message, {
        code: "feed_invalid_field",
        details: { field: result.field },
      });
  }
}

export function unwrapFeedMutation<T>(result: FeedMutationResult<T>): {
  value: T;
  created: boolean;
} {
  if (result.status === "ok") return { value: result.value, created: result.created };
  return feedMutationError(result);
}

export function feedItemFilename(objectKey: string): string {
  return objectKey.split("/").at(-1) ?? objectKey;
}

/**
 * Newest-first objects tagged `gh.repo=<repo>`, optionally also `gh.number`
 * and `path`. Drops promoted branch shadows so a promoted shot is not listed
 * twice. Does not require `gh.merged` — merge signal is out of scope for v1.
 * Kind is display-only; GitHub numbers are unique per repo.
 */
export async function findLatestRepoScreenshots(
  db: D1Queryable,
  workspace: string,
  opts: { repo: string; path?: string; number?: number; limit?: number },
): Promise<Array<{ key: string; updatedAt: string; metadata: Record<string, string> }>> {
  const limit = Math.max(1, Math.min(opts.limit ?? FEED_ITEM_LIMIT, FEED_ITEM_LIMIT));
  const params: unknown[] = [workspace, opts.repo];
  let sql = `SELECT r.object_key AS object_key, r.updated_at AS updated_at
             FROM file_metadata r
             WHERE r.workspace = ? AND r.meta_key = 'gh.repo' AND r.meta_value = ?
               AND NOT EXISTS (
                 SELECT 1 FROM file_metadata s
                 WHERE s.workspace = r.workspace AND s.object_key = r.object_key
                   AND s.meta_key = 'gh.status' AND s.meta_value = 'promoted'
               )`;
  if (opts.number) {
    sql += ` AND EXISTS (
               SELECT 1 FROM file_metadata n
               WHERE n.workspace = r.workspace AND n.object_key = r.object_key
                 AND n.meta_key = 'gh.number' AND n.meta_value = ?
             )`;
    params.push(String(opts.number));
  }
  if (opts.path) {
    sql += ` AND EXISTS (
               SELECT 1 FROM file_metadata p
               WHERE p.workspace = r.workspace AND p.object_key = r.object_key
                 AND p.meta_key = 'path' AND p.meta_value = ?
             )`;
    params.push(opts.path);
  }
  sql += ` ORDER BY r.updated_at DESC, r.object_key ASC LIMIT ?`;
  params.push(limit);

  const matched = await db
    .prepare(sql)
    .bind(...params)
    .all<{ object_key: string; updated_at: string }>();
  const keys = matched.results.map((row) => row.object_key);
  if (keys.length === 0) return [];
  const byKey = await getMetadataForKeys(db, workspace, keys);
  return matched.results.map((row) => ({
    key: row.object_key,
    updatedAt: row.updated_at,
    metadata: byKey.get(row.object_key) ?? {},
  }));
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

async function hydrateFeedItems(
  env: Env,
  workspace: WorkspaceRecord,
  matches: Array<{ key: string; metadata: Record<string, string> }>,
  opts: { audience: "owner" | "public" },
): Promise<FeedItemDto[]> {
  const resolver: LaneResolver = createLaneResolver(env, workspace);
  try {
    await resolver.activeConfig();
  } catch (cause) {
    throw new ServiceUnavailableError("Feed storage unavailable.", {
      code: "feed_storage_unavailable",
      cause,
    });
  }
  const laneConfigByKey = new Map<string, StorageConfig>();
  const hydrated = await mapBounded(matches, 8, async (match): Promise<FeedItemDto> => {
    let meta: FeedObjectHead | null;
    let itemConfig: StorageConfig | null = null;
    try {
      const lane = await resolver.resolve(match.key);
      if (lane) {
        itemConfig = lane.config;
        laneConfigByKey.set(match.key, lane.config);
        meta = (await lane.store.head(match.key)) as FeedObjectHead;
      } else {
        meta = null;
      }
    } catch (cause) {
      throw new ServiceUnavailableError("Feed storage unavailable.", {
        code: "feed_storage_unavailable",
        cause,
      });
    }
    const isPrivate = meta ? objectVisibility(meta.metadata) === "private" : false;
    const withheld = opts.audience === "public" && isPrivate;
    const urls =
      meta && !withheld && itemConfig
        ? objectPublicUrls(env, itemConfig, match.key)
        : { url: null, embedUrl: null };
    if (meta && !withheld && urls.url === null)
      throw new ServiceUnavailableError("Feed object is not publicly served.", {
        code: "feed_object_not_public",
      });
    const dates = meta && !withheld ? publicObjectDateFields(meta) : {};
    const id = (await sha256Hex(match.key)).slice(0, 32);
    return {
      id,
      objectKey: match.key,
      filename: feedItemFilename(match.key),
      status: withheld ? "withheld" : meta ? "available" : "missing",
      url: urls.url,
      embedUrl: urls.embedUrl,
      contentType: withheld ? null : (meta?.type ?? null),
      size: withheld ? null : (meta?.size ?? null),
      uploaded: dates.uploaded ?? null,
      modified: dates.modified ?? null,
      path: match.metadata.path ?? null,
      state: match.metadata.state ?? null,
    };
  });

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
      // D1 blip — render videos without posters.
    }
  }
  return hydrated;
}

function toPublicItem(item: FeedItemDto): PublicFeedItemDto {
  return {
    id: item.id,
    filename: item.filename,
    status: item.status,
    url: item.url,
    embedUrl: item.embedUrl,
    contentType: item.contentType,
    size: item.size,
    ...(item.uploaded ? { uploaded: item.uploaded } : {}),
    ...(item.modified ? { modified: item.modified } : {}),
    path: item.path,
    state: item.state,
    ...(item.posterUrl ? { posterUrl: item.posterUrl } : {}),
    ...(item.videoDimensions ? { videoDimensions: item.videoDimensions } : {}),
  };
}

export async function hydrateOwnerFeed(
  env: Env,
  workspace: WorkspaceRecord,
  record: FeedRecord,
): Promise<FeedDto> {
  const matches = await findLatestRepoScreenshots(dbFor(env), record.workspace, {
    repo: record.repo,
    path: record.path || undefined,
    number: record.number > 0 ? record.number : undefined,
  });
  const items = await hydrateFeedItems(env, workspace, matches, { audience: "owner" });
  return {
    ...feedSummary(env, record),
    items,
  };
}

export async function hydratePublicFeed(
  env: Env,
  workspace: WorkspaceRecord,
  record: FeedRecord,
): Promise<PublicFeedDto> {
  const matches = await findLatestRepoScreenshots(dbFor(env), record.workspace, {
    repo: record.repo,
    path: record.path || undefined,
    number: record.number > 0 ? record.number : undefined,
  });
  const items = await hydrateFeedItems(env, workspace, matches, { audience: "public" });
  const summary = feedSummary(env, record);
  return {
    id: record.id,
    title: summary.title,
    repo: record.repo,
    path: record.path || null,
    number: summary.number,
    kind: summary.kind,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
    items: items.map(toPublicItem),
  };
}
