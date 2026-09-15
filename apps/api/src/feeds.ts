/**
 * Capability-URL repo change feeds. A feed is a durable opaque ID plus a
 * query (`gh.repo`, optional `path`) — not a curated item list. Items are
 * resolved at read time from `file_metadata`. Privacy matches galleries:
 * anyone who knows the URL can view the feed.
 */
import { type D1Queryable } from "./db-session";

export const MAX_FEEDS_PER_WORKSPACE = 50;
export const MAX_FEED_PAGE_SIZE = 100;
export const FEED_ITEM_LIMIT = 50;
export const FEED_ID_RE = /^feed_[A-Za-z0-9_-]{22}$/;
export const FEED_REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export interface FeedRecord {
  id: string;
  workspace: string;
  repo: string;
  path: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export type FeedMutationResult<T = undefined> =
  | { status: "ok"; value: T; created: boolean }
  | { status: "not_found" }
  | { status: "limit"; limit: number }
  | { status: "invalid"; field: string; message: string };

export interface FeedCursor {
  createdAt: string;
  id: string;
}

export interface FeedPage {
  feeds: FeedRecord[];
  nextCursor: FeedCursor | null;
}

function randomFeedId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `feed_${btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")}`;
}

function invalid(field: string, message: string): FeedMutationResult<never> {
  return { status: "invalid", field, message };
}

/** Lowercased `owner/repo`, or an invalid result. */
export function normalizeFeedRepo(raw: string | null | undefined): FeedMutationResult<string> {
  const repo = (raw ?? "").trim().toLowerCase();
  if (!FEED_REPO_RE.test(repo)) {
    return invalid("repo", "must be owner/repo (letters, digits, dot, underscore, hyphen)");
  }
  return { status: "ok", value: repo, created: false };
}

/**
 * Optional page-path filter. Empty / omitted → no filter (stored as "").
 * Matches the `path` metadata key exactly — the same equality `uploads find`
 * already supports. Not an object-key prefix.
 */
export function normalizeFeedPath(raw: string | null | undefined): FeedMutationResult<string> {
  if (raw == null) return { status: "ok", value: "", created: false };
  if (typeof raw !== "string") return invalid("path", "must be a string");
  const path = raw.trim();
  if (path.length === 0) return { status: "ok", value: "", created: false };
  if (path.length > 512) return invalid("path", "must be at most 512 characters");
  if (!/^[\x20-\x7E]+$/.test(path)) return invalid("path", "must contain printable ASCII");
  return { status: "ok", value: path, created: false };
}

export function feedTitle(repo: string, path: string): string {
  return path ? `${repo} · ${path}` : repo;
}

export function isFeedId(id: string): boolean {
  return FEED_ID_RE.test(id);
}

function row(record: FeedRecord): FeedRecord {
  return {
    id: record.id,
    workspace: record.workspace,
    repo: record.repo,
    path: record.path,
    created_at: record.created_at,
    updated_at: record.updated_at,
    deleted_at: record.deleted_at,
  };
}

export async function getFeed(
  db: D1Queryable,
  workspace: string,
  id: string,
): Promise<FeedRecord | null> {
  if (!isFeedId(id)) return null;
  const found = await db
    .prepare(
      `SELECT id, workspace, repo, path, created_at, updated_at, deleted_at
       FROM feeds WHERE id = ? AND workspace = ? AND deleted_at IS NULL`,
    )
    .bind(id, workspace)
    .first<FeedRecord>();
  return found ? row(found) : null;
}

export async function resolvePublicFeed(db: D1Queryable, id: string): Promise<FeedRecord | null> {
  if (!isFeedId(id)) return null;
  const found = await db
    .prepare(
      `SELECT id, workspace, repo, path, created_at, updated_at, deleted_at
       FROM feeds WHERE id = ? AND deleted_at IS NULL`,
    )
    .bind(id)
    .first<FeedRecord>();
  return found ? row(found) : null;
}

export async function findFeedByRepoPath(
  db: D1Queryable,
  workspace: string,
  repo: string,
  path: string,
): Promise<FeedRecord | null> {
  const found = await db
    .prepare(
      `SELECT id, workspace, repo, path, created_at, updated_at, deleted_at
       FROM feeds WHERE workspace = ? AND repo = ? AND path = ? AND deleted_at IS NULL`,
    )
    .bind(workspace, repo, path)
    .first<FeedRecord>();
  return found ? row(found) : null;
}

async function countLiveFeeds(db: D1Queryable, workspace: string): Promise<number> {
  const found = await db
    .prepare(`SELECT COUNT(*) AS count FROM feeds WHERE workspace = ? AND deleted_at IS NULL`)
    .bind(workspace)
    .first<{ count: number }>();
  return found?.count ?? 0;
}

export async function createFeed(
  db: D1Queryable,
  input: { workspace: string; repo: string; path?: string | null; now?: Date },
): Promise<FeedMutationResult<FeedRecord>> {
  const repoResult = normalizeFeedRepo(input.repo);
  if (repoResult.status !== "ok") return repoResult;
  const pathResult = normalizeFeedPath(input.path);
  if (pathResult.status !== "ok") return pathResult;

  const existing = await findFeedByRepoPath(
    db,
    input.workspace,
    repoResult.value,
    pathResult.value,
  );
  if (existing) return { status: "ok", value: existing, created: false };

  if ((await countLiveFeeds(db, input.workspace)) >= MAX_FEEDS_PER_WORKSPACE) {
    return { status: "limit", limit: MAX_FEEDS_PER_WORKSPACE };
  }

  const now = (input.now ?? new Date()).toISOString();
  const record: FeedRecord = {
    id: randomFeedId(),
    workspace: input.workspace,
    repo: repoResult.value,
    path: pathResult.value,
    created_at: now,
    updated_at: now,
    deleted_at: null,
  };
  await db
    .prepare(
      `INSERT INTO feeds (id, workspace, repo, path, created_at, updated_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL)`,
    )
    .bind(
      record.id,
      record.workspace,
      record.repo,
      record.path,
      record.created_at,
      record.updated_at,
    )
    .run();
  return { status: "ok", value: record, created: true };
}

export function clampFeedPageLimit(requestedLimit: number | undefined): number {
  const limit = requestedLimit ?? 50;
  return Number.isFinite(limit) ? Math.max(1, Math.min(MAX_FEED_PAGE_SIZE, Math.floor(limit))) : 50;
}

export async function listFeeds(
  db: D1Queryable,
  workspace: string,
  opts: { limit?: number; cursor?: FeedCursor } = {},
): Promise<FeedPage> {
  const limit = clampFeedPageLimit(opts.limit);
  const params: unknown[] = [workspace];
  let sql = `SELECT id, workspace, repo, path, created_at, updated_at, deleted_at
             FROM feeds WHERE workspace = ? AND deleted_at IS NULL`;
  if (opts.cursor) {
    sql += ` AND (created_at < ? OR (created_at = ? AND id < ?))`;
    params.push(opts.cursor.createdAt, opts.cursor.createdAt, opts.cursor.id);
  }
  sql += ` ORDER BY created_at DESC, id DESC LIMIT ?`;
  params.push(limit + 1);

  const result = await db
    .prepare(sql)
    .bind(...params)
    .all<FeedRecord>();
  const rows = result.results.map(row);
  const hasMore = rows.length > limit;
  const feeds = hasMore ? rows.slice(0, limit) : rows;
  const last = feeds.at(-1);
  return {
    feeds,
    nextCursor: hasMore && last ? { createdAt: last.created_at, id: last.id } : null,
  };
}

export async function softDeleteFeed(
  db: D1Queryable,
  workspace: string,
  id: string,
): Promise<FeedMutationResult<FeedRecord>> {
  const current = await getFeed(db, workspace, id);
  if (!current) return { status: "not_found" };
  const now = new Date().toISOString();
  const result = await db
    .prepare(
      `UPDATE feeds SET deleted_at = ?, updated_at = ?
       WHERE id = ? AND workspace = ? AND deleted_at IS NULL`,
    )
    .bind(now, now, id, workspace)
    .run();
  if ((result.meta?.changes ?? 0) === 0) return { status: "not_found" };
  return { status: "ok", value: { ...current, deleted_at: now, updated_at: now }, created: false };
}

export async function deleteFeedsForWorkspace(
  db: D1Queryable,
  workspace: string,
): Promise<{ feeds: number }> {
  const result = await db.prepare(`DELETE FROM feeds WHERE workspace = ?`).bind(workspace).run();
  return { feeds: result.meta?.changes ?? 0 };
}
