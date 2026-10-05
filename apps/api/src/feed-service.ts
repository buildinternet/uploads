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
  encodePublicFeedCursor,
  feedRecordScope,
  prScopeQuery,
  scanScopeKeys,
  type ScopeItem,
  type ScopeResume,
} from "./pr-scope";
import {
  FEED_ID_RE,
  FEED_ITEM_LIMIT,
  feedTitle,
  type FeedCursor,
  type FeedMutationResult,
  type FeedRecord,
  type FeedSource,
} from "./feeds";
import { isDerivedPosterContentType, videoPresentation } from "./poster";
import type {
  FeedItemDto,
  FeedSummaryDto,
  PublicFeedItemDto,
  PublicFeedItemPage,
} from "./scope-wire";
import { createLaneResolver, objectPublicUrls, type LaneResolver } from "./storage";
import type { StorageConfig } from "@uploads/storage";
import { objectVisibility } from "./visibility";
import { webOrigin } from "./web-url";
import { FEED_ITEM_ID_RE, feedItemIdFor } from "@uploads/comment-render/scope";
import { type WorkspaceRecord } from "./workspace";
import { dbFor, type D1Queryable } from "./db-session";

type FeedObjectHead = {
  type?: string;
  size?: number;
  lastModified?: number;
  metadata?: Record<string, string>;
};

export type { FeedItemDto, FeedSummaryDto, PublicFeedItemDto };

export interface FeedDto {
  id: string;
  url: string;
  workspace: string;
  repo: string;
  path: string | null;
  number: number | null;
  kind: "pull" | "issue" | null;
  title: string;
  source: FeedSource | null;
  createdAt: string;
  updatedAt: string;
  items: FeedItemDto[];
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
  /** Opaque cursor for the next 50 items, or null on the last page. */
  nextCursor: string | null;
};

export function feedUrl(env: Env, id: string): string {
  return webOrigin(env) + "/c/" + encodeURIComponent(id);
}

export function feedItemUrl(env: Env, feedId: string, itemId: string): string {
  return feedUrl(env, feedId) + "/" + encodeURIComponent(itemId);
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
    source: record.source,
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
 * The newest (at most `FEED_ITEM_LIMIT`) items in a feed's scope. Thin
 * wrapper over the shared scope query (`pr-scope.ts`), kept for the
 * owner-feed call site.
 */
export async function findLatestRepoScreenshots(
  db: D1Queryable,
  workspace: string,
  opts: { repo: string; path?: string; number?: number; limit?: number },
): Promise<ScopeItem[]> {
  const limit = Math.max(1, Math.min(opts.limit ?? FEED_ITEM_LIMIT, FEED_ITEM_LIMIT));
  const page = await prScopeQuery(db, {
    workspace,
    repo: opts.repo,
    ...(opts.number ? { number: opts.number } : {}),
    ...(opts.path ? { path: opts.path } : {}),
    limit,
  });
  return page.items;
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

/**
 * HEAD each match (lane-aware) and build its DTO. `privateKeys`, when given,
 * collects every key whose object is private, so a caller can reuse these
 * HEADs (see `countPrivateScopeItems`).
 *
 * A live link only works when its objects have public URLs, so by default an
 * available object without one is a 503 `feed_object_not_public`. The
 * signed-in Files view passes `requirePublicUrls: false` and gets `url: null`
 * instead; its tiles open through a signed URL.
 */
export async function hydrateFeedItems(
  env: Env,
  workspace: WorkspaceRecord,
  matches: Array<{ key: string; metadata: Record<string, string> }>,
  opts: {
    audience: "owner" | "public";
    privateKeys?: Set<string>;
    requirePublicUrls?: boolean;
  },
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
    if (isPrivate) opts.privateKeys?.add(match.key);
    const withheld = opts.audience === "public" && isPrivate;
    const urls =
      meta && !withheld && itemConfig
        ? objectPublicUrls(env, itemConfig, match.key)
        : { url: null, embedUrl: null };
    if (opts.requirePublicUrls !== false && meta && !withheld && urls.url === null)
      throw new ServiceUnavailableError("Feed object is not publicly served.", {
        code: "feed_object_not_public",
      });
    const dates = meta && !withheld ? publicObjectDateFields(meta) : {};
    const id = await feedItemIdFor(match.key);
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

  const posterKeys = hydrated
    .filter((item) => item.url !== null && isDerivedPosterContentType(item.contentType ?? ""))
    .map((item) => item.objectKey);
  if (posterKeys.length > 0 && workspace.name) {
    try {
      const metadataByKey = await getMetadataForKeys(dbFor(env), workspace.name, posterKeys, {
        metaKeys: [
          "video.poster",
          "video.width",
          "video.height",
          "pdf.poster",
          "pdf.width",
          "pdf.height",
        ],
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
          item.contentType ?? undefined,
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

/**
 * Most keys `countPrivateScopeItems` will probe beyond the ones the page
 * already HEADed. Each probe costs at least 2 R2 operations, so 300 probes
 * stay inside the Workers ceiling of 1,000 subrequests per request
 * (github-promote.ts) next to the page's own hydration.
 */
export const PRIVATE_COUNT_PROBE_CAP = 300;

/**
 * How many of `keys` are private: objects whose R2 custom metadata says
 * `visibility: private`. A live link renders the same objects as `withheld`.
 * Visibility lives only in R2 custom metadata (`visibility.ts`; D1 rejects
 * the key), so the count needs storage reads:
 *
 * - Keys the page already HEADed (`seen.checked`) are free. They count from
 *   `seen.privateKeys`.
 * - Every other key costs one `exists` per lane tried (active lane first,
 *   then each fallback lane until a hit), then one HEAD on the lane that has
 *   it. That is 2 R2 operations for a key in the active lane, and more for a
 *   key in a fallback lane.
 *
 * When more than `PRIVATE_COUNT_PROBE_CAP` keys need a probe, this returns
 * `null` without probing any of them: the count is unknown, and the share
 * confirm is skipped. `keys` is itself capped at `SCOPE_SCAN_CAP` by the
 * caller's scan.
 */
export async function countPrivateScopeItems(
  env: Env,
  workspace: WorkspaceRecord,
  keys: string[],
  seen: { checked: Set<string>; privateKeys: Set<string> },
): Promise<number | null> {
  const known = keys.filter((key) => seen.privateKeys.has(key)).length;
  const unchecked = keys.filter((key) => !seen.checked.has(key));
  if (unchecked.length === 0) return known;
  if (unchecked.length > PRIVATE_COUNT_PROBE_CAP) return null;
  const resolver = createLaneResolver(env, workspace);
  let flags: boolean[];
  try {
    flags = await mapBounded(unchecked, 8, async (key) => {
      const lane = await resolver.resolve(key);
      if (!lane) return false;
      const head = (await lane.store.head(key)) as FeedObjectHead | null;
      return objectVisibility(head?.metadata) === "private";
    });
  } catch (cause) {
    throw new ServiceUnavailableError("Feed storage unavailable.", {
      code: "feed_storage_unavailable",
      cause,
    });
  }
  return known + flags.filter(Boolean).length;
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
  for (const item of items) {
    item.pageUrl = feedItemUrl(env, record.id, item.id);
  }
  return {
    ...feedSummary(env, record),
    items,
  };
}

export async function hydratePublicFeed(
  env: Env,
  workspace: WorkspaceRecord,
  record: FeedRecord,
  opts: { cursor?: ScopeResume | null } = {},
): Promise<PublicFeedDto> {
  const page = await prScopeQuery(dbFor(env), {
    ...feedRecordScope(record),
    cursor: opts.cursor ?? null,
    limit: FEED_ITEM_LIMIT,
  });
  const items = await hydrateFeedItems(env, workspace, page.items, { audience: "public" });
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
    nextCursor: page.nextCursor ? await encodePublicFeedCursor(page.nextCursor) : null,
  };
}

/**
 * One public item plus its neighbours, for the `/c/<id>/<item>` pager. Scans
 * the scope's keys (cap 2,000) and hashes them until one matches: item ids
 * are `sha256(key)`, so there is no id-to-key table to keep in step with
 * every upload. Null when the id is malformed or not in scope.
 */
export async function publicFeedItemPage(
  env: Env,
  workspace: WorkspaceRecord,
  record: FeedRecord,
  itemId: string,
): Promise<PublicFeedItemPage | null> {
  if (!FEED_ITEM_ID_RE.test(itemId)) return null;
  const db = dbFor(env);
  const scope = await scanScopeKeys(db, feedRecordScope(record));
  let prevId: string | null = null;
  let index = -1;
  for (const [i, entry] of scope.entries()) {
    const id = await feedItemIdFor(entry.key);
    if (id === itemId) {
      index = i;
      break;
    }
    prevId = id;
  }
  if (index < 0) return null;

  const match = scope[index];
  const metadata =
    (await getMetadataForKeys(db, record.workspace, [match.key])).get(match.key) ?? {};
  const [item] = await hydrateFeedItems(env, workspace, [{ key: match.key, metadata }], {
    audience: "public",
  });
  const summary = feedSummary(env, record);
  return {
    feed: {
      id: record.id,
      title: summary.title,
      repo: record.repo,
      number: summary.number,
      // The summary's kind (null for a repo scope), same as GET /public/feeds/:id.
      kind: summary.kind,
    },
    item: toPublicItem(item),
    prev: prevId,
    next: index + 1 < scope.length ? await feedItemIdFor(scope[index + 1].key) : null,
    index,
    total: scope.length,
  };
}
