/**
 * The one scope query behind live links (change feeds), the signed-in Files
 * views, and the live-link pager (spec
 * .context/2026-10-04-pr-first-workspace-and-live-links.md, "Shared scope
 * function"). Matches `gh.repo` exactly (every writer lowercases it),
 * optionally `gh.number` and `path`, drops `gh.status=promoted` shadows, and
 * never requires `path`. Newest first; keyset cursor on (updated_at, key).
 *
 * The type filter matches the key suffix with `substr`, never `LIKE`: D1
 * caps LIKE/GLOB patterns at 50 bytes (`fileTypeSql`, file-type-sql.ts, built
 * from the `@uploads/comment-render/scope` lists so SQL and
 * `fileTypeClassFromKey` agree).
 * `file_metadata_gh_repo_recent_idx` (partial, `meta_key = 'gh.repo'`)
 * serves the ORDER BY without a temp sort; keep the literal `'gh.repo'` in
 * the SQL or SQLite cannot use that partial index.
 */
import { ValidationError } from "@uploads/errors";
import { FEED_ITEM_ID_RE, feedItemIdFor, type FileTypeClass } from "@uploads/comment-render/scope";
import { type D1Queryable } from "./db-session";
import type { FeedRecord } from "./feeds";
import { getMetadataForKeys, PROMOTED_SHADOW_STATUS_SQL } from "./file-metadata";
import { fileTypeSql } from "./file-type-sql";
import { b64urlDecode, b64urlEncode } from "./secrets";

export const SCOPE_DEFAULT_LIMIT = 50;
export const SCOPE_MAX_LIMIT = 100;
/** Hard cap on a whole-scope scan (pager, private count). */
export const SCOPE_SCAN_CAP = 2000;

export interface ScopeCursor {
  updatedAt: string;
  key: string;
}

/**
 * Where a page resumes. A null `key` means "strictly older than `updatedAt`"
 * (no tie-break among rows sharing that timestamp).
 */
export interface ScopeResume {
  updatedAt: string;
  key: string | null;
}

export interface ScopeQuery {
  workspace: string;
  /** Lowercased `owner/repo`. */
  repo: string;
  number?: number;
  path?: string;
  /** Signed-in views only; live links never pass it. */
  type?: FileTypeClass;
  cursor?: ScopeResume | null;
  /** Default 50, max 100. */
  limit?: number;
}

export interface ScopeItem {
  key: string;
  updatedAt: string;
  metadata: Record<string, string>;
}

interface ScopeRow {
  object_key: string;
  updated_at: string;
}

/** A live link's scope: repo, plus `path` and `number` when the feed has them. */
export function feedRecordScope(
  record: Pick<FeedRecord, "workspace" | "repo" | "path" | "number">,
): Omit<ScopeQuery, "cursor" | "limit"> {
  return {
    workspace: record.workspace,
    repo: record.repo,
    ...(record.path ? { path: record.path } : {}),
    ...(record.number > 0 ? { number: record.number } : {}),
  };
}

function scopeFrom(q: Omit<ScopeQuery, "cursor" | "limit">): { sql: string; params: unknown[] } {
  const params: unknown[] = [q.workspace, q.repo];
  let sql = `FROM file_metadata r
             WHERE r.workspace = ? AND r.meta_key = 'gh.repo' AND r.meta_value = ?
               AND NOT EXISTS (
                 SELECT 1 FROM file_metadata s
                 WHERE s.workspace = r.workspace AND s.object_key = r.object_key
                   AND ${PROMOTED_SHADOW_STATUS_SQL}
               )`;
  if (q.number !== undefined && q.number > 0) {
    sql += ` AND EXISTS (
               SELECT 1 FROM file_metadata n
               WHERE n.workspace = r.workspace AND n.object_key = r.object_key
                 AND n.meta_key = 'gh.number' AND n.meta_value = ?
             )`;
    params.push(String(q.number));
  }
  if (q.path) {
    sql += ` AND EXISTS (
               SELECT 1 FROM file_metadata p
               WHERE p.workspace = r.workspace AND p.object_key = r.object_key
                 AND p.meta_key = 'path' AND p.meta_value = ?
             )`;
    params.push(q.path);
  }
  if (q.type) sql += ` AND ${fileTypeSql("r.object_key", q.type)}`;
  return { sql, params };
}

export function clampScopeLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return SCOPE_DEFAULT_LIMIT;
  return Math.max(1, Math.min(SCOPE_MAX_LIMIT, Math.floor(limit)));
}

/** One newest-first page of the scope, with metadata for each item. */
export async function prScopeQuery(
  db: D1Queryable,
  q: ScopeQuery,
): Promise<{ items: ScopeItem[]; nextCursor: ScopeCursor | null }> {
  const limit = clampScopeLimit(q.limit);
  const { sql, params } = scopeFrom(q);
  let select = `SELECT r.object_key AS object_key, r.updated_at AS updated_at ${sql}`;
  if (q.cursor && q.cursor.key === null) {
    select += ` AND r.updated_at < ?`;
    params.push(q.cursor.updatedAt);
  } else if (q.cursor) {
    select += ` AND (r.updated_at < ? OR (r.updated_at = ? AND r.object_key > ?))`;
    params.push(q.cursor.updatedAt, q.cursor.updatedAt, q.cursor.key);
  }
  select += ` ORDER BY r.updated_at DESC, r.object_key ASC LIMIT ?`;
  params.push(limit + 1);

  const { results } = await db
    .prepare(select)
    .bind(...params)
    .all<ScopeRow>();
  const rows = results ?? [];
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const byKey =
    page.length > 0
      ? await getMetadataForKeys(
          db,
          q.workspace,
          page.map((row) => row.object_key),
        )
      : new Map<string, Record<string, string>>();
  const last = page.at(-1);
  return {
    items: page.map((row) => ({
      key: row.object_key,
      updatedAt: row.updated_at,
      metadata: byKey.get(row.object_key) ?? {},
    })),
    nextCursor: hasMore && last ? { updatedAt: last.updated_at, key: last.object_key } : null,
  };
}

/**
 * The whole scope, newest first, up to `cap` keys. No metadata (`{}`): the
 * pager and the private count need only keys. `at` keeps only rows stamped
 * exactly that `updated_at` (in tie-break order), for resolving a public cursor.
 */
export async function scanScopeKeys(
  db: D1Queryable,
  q: Omit<ScopeQuery, "cursor" | "limit">,
  opts: { cap?: number; at?: string } = {},
): Promise<ScopeItem[]> {
  const bounded = Math.max(1, Math.min(SCOPE_SCAN_CAP, Math.floor(opts.cap ?? SCOPE_SCAN_CAP)));
  const { sql, params } = scopeFrom(q);
  let select = `SELECT r.object_key AS object_key, r.updated_at AS updated_at ${sql}`;
  if (opts.at !== undefined) {
    select += ` AND r.updated_at = ?`;
    params.push(opts.at);
  }
  select += ` ORDER BY r.updated_at DESC, r.object_key ASC LIMIT ?`;
  params.push(bounded);
  const { results } = await db
    .prepare(select)
    .bind(...params)
    .all<ScopeRow>();
  return (results ?? []).map((row) => ({
    key: row.object_key,
    updatedAt: row.updated_at,
    metadata: {},
  }));
}

/**
 * Distinct `gh.repo` values with their newest upload time, newest first.
 * Drops `gh.status=promoted` shadows the same way `scopeFrom` does, so a repo
 * holding only shadows does not list and a shadow never sets `lastUpdatedAt`.
 */
export async function listWorkspaceRepos(
  db: D1Queryable,
  workspace: string,
  opts: { cursor?: ScopeCursor | null; limit: number },
): Promise<{
  repos: Array<{ repo: string; lastUpdatedAt: string }>;
  nextCursor: ScopeCursor | null;
}> {
  const params: unknown[] = [workspace];
  let sql = `SELECT r.meta_value AS repo, MAX(r.updated_at) AS last_updated_at
             FROM file_metadata r
             WHERE r.workspace = ? AND r.meta_key = 'gh.repo'
               AND NOT EXISTS (
                 SELECT 1 FROM file_metadata s
                 WHERE s.workspace = r.workspace AND s.object_key = r.object_key
                   AND ${PROMOTED_SHADOW_STATUS_SQL}
               )
             GROUP BY r.meta_value`;
  if (opts.cursor) {
    sql += ` HAVING MAX(r.updated_at) < ? OR (MAX(r.updated_at) = ? AND r.meta_value > ?)`;
    params.push(opts.cursor.updatedAt, opts.cursor.updatedAt, opts.cursor.key);
  }
  sql += ` ORDER BY last_updated_at DESC, repo ASC LIMIT ?`;
  params.push(opts.limit + 1);

  const { results } = await db
    .prepare(sql)
    .bind(...params)
    .all<{ repo: string; last_updated_at: string }>();
  const rows = results ?? [];
  const hasMore = rows.length > opts.limit;
  const page = hasMore ? rows.slice(0, opts.limit) : rows;
  const last = page.at(-1);
  return {
    repos: page.map((row) => ({ repo: row.repo, lastUpdatedAt: row.last_updated_at })),
    nextCursor: hasMore && last ? { updatedAt: last.last_updated_at, key: last.repo } : null,
  };
}

function invalidCursor(): ValidationError {
  return new ValidationError("cursor is not valid for this query", { code: "invalid_cursor" });
}

function encodeCursorEnvelope(body: Record<string, unknown>): string {
  return b64urlEncode(new TextEncoder().encode(JSON.stringify(body)));
}

/**
 * The `{ v: 1, u: updatedAt, ... }` envelope both cursors share. Malformed
 * input (bad base64url, bad UTF-8, non-object JSON, wrong version, unparseable
 * `u`) is a 400 `invalid_cursor`; each decoder checks its own fields.
 */
function parseCursorEnvelope(raw: string): Record<string, unknown> & { u: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(b64urlDecode(raw)),
    );
  } catch {
    throw invalidCursor();
  }
  if (typeof parsed !== "object" || parsed === null) throw invalidCursor();
  const record = parsed as Record<string, unknown>;
  if (record.v !== 1 || typeof record.u !== "string" || !Number.isFinite(Date.parse(record.u))) {
    throw invalidCursor();
  }
  return record as Record<string, unknown> & { u: string };
}

/** Opaque keyset cursor. Also carries the `/pulls` (ref) and `/repos` (repo) cursors. */
export function encodeScopeCursor(cursor: ScopeCursor): string {
  return encodeCursorEnvelope({ v: 1, u: cursor.updatedAt, k: cursor.key });
}

export function decodeScopeCursor(raw: string | undefined): ScopeCursor | null {
  if (raw === undefined || raw === "") return null;
  const record = parseCursorEnvelope(raw);
  if (typeof record.k !== "string" || record.k.length === 0) throw invalidCursor();
  return { updatedAt: record.u, key: record.k };
}

/**
 * Public live-link cursor. Public pages must not expose object keys (a
 * withheld item's key can be a capability URL), so it carries the item id
 * (`sha256(key)` prefix) instead of the key: `{ v: 1, u: updatedAt, h: itemId }`.
 * Signed-in routes keep `encodeScopeCursor`.
 */
export async function encodePublicFeedCursor(cursor: ScopeCursor): Promise<string> {
  return encodeCursorEnvelope({ v: 1, u: cursor.updatedAt, h: await feedItemIdFor(cursor.key) });
}

/**
 * Decode a public cursor and resolve its tie-break key from the scope rows
 * stamped `updatedAt`. If no row matches (the item was deleted or re-scoped
 * since the cursor was issued), resume strictly older than `updatedAt`
 * (`key: null`): same-timestamp rows past the vanished item are skipped
 * rather than risking a duplicate. Malformed input is a 400 `invalid_cursor`.
 */
export async function decodePublicFeedCursor(
  db: D1Queryable,
  scope: Omit<ScopeQuery, "cursor" | "limit">,
  raw: string | undefined,
): Promise<ScopeResume | null> {
  if (raw === undefined || raw === "") return null;
  const record = parseCursorEnvelope(raw);
  if (typeof record.h !== "string" || !FEED_ITEM_ID_RE.test(record.h)) throw invalidCursor();
  for (const { key } of await scanScopeKeys(db, scope, { at: record.u })) {
    if ((await feedItemIdFor(key)) === record.h) return { updatedAt: record.u, key };
  }
  return { updatedAt: record.u, key: null };
}
