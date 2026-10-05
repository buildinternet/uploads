/**
 * Item lookup for public live-link item pages (`/c/<id>/<item>`, issue #1072).
 *
 * An item id is `sha256(key)` (`feedItemIdFor`), so there is no id-to-key
 * table. Finding an item means listing the scope (cap 2,000 rows) and hashing
 * every key until one matches. This module keeps that list, already hashed,
 * in a named Workers Cache API cache for `LIVE_LINK_INDEX_TTL_SECONDS`, keyed
 * by the live link's id and scope. The cache is per data center and is never
 * served to a client: only this module reads it.
 *
 * A cached list is a hint, never the authority:
 *
 * - The caller resolves the live link in D1 before it calls this module, so a
 *   revoked link 404s even while its list is still cached.
 * - An id found in the cached list is served only after `scopeHasKey`
 *   confirms its key is still in scope (one indexed row lookup). A deleted or
 *   re-scoped file fails that check, and the lookup rebuilds the list.
 * - An id not in the cached list costs one query for scope rows stamped at or
 *   after the list's newest row. Only when one of those rows hashes to the id
 *   does the lookup rebuild the list. A random or stale id never causes a
 *   full scan while the list is cached.
 *
 * A file that joins the scope without a new `gh.repo` timestamp (for example,
 * a `path` row added later) can miss until the cached list expires.
 *
 * With no Cache API (unit tests, a `workers.dev` preview) every lookup scans,
 * as it did before this module existed.
 */
import { feedItemIdFor } from "@uploads/comment-render/scope";
import type { D1Queryable } from "./db-session";
import type { FeedRecord } from "./feeds";
import { feedRecordScope, scanScopeKeys, scopeHasKey, type ScopeQuery } from "./pr-scope";
import { sha256Hex } from "./workspace";

export const LIVE_LINK_INDEX_TTL_SECONDS = 60;
export const LIVE_LINK_INDEX_CACHE_NAME = "live-link-index";
/** Cache keys only. Nothing ever requests this host. */
const CACHE_ORIGIN = "https://live-link-index.internal";

/** One scope row: its item id, object key, and `gh.repo` `updated_at`. */
export interface LiveLinkIndexEntry {
  id: string;
  key: string;
  updatedAt: string;
}

type Scope = Omit<ScopeQuery, "cursor" | "limit">;

interface IndexCache {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

/** Stored shape: compact tuples, plus the build time for the TTL check. */
interface StoredIndex {
  v: 1;
  builtAt: number;
  entries: Array<[id: string, key: string, updatedAt: string]>;
}

async function openIndexCache(): Promise<IndexCache | null> {
  try {
    if (typeof caches === "undefined" || typeof caches.open !== "function") return null;
    return await caches.open(LIVE_LINK_INDEX_CACHE_NAME);
  } catch {
    return null;
  }
}

/** Distinct per live link and per scope, so no list is shared across links. */
async function indexCacheRequest(record: FeedRecord, scope: Scope): Promise<Request> {
  const fingerprint = await sha256Hex(
    JSON.stringify([scope.workspace, scope.repo, scope.path ?? "", scope.number ?? 0]),
  );
  return new Request(`${CACHE_ORIGIN}/v1/${encodeURIComponent(record.id)}/${fingerprint}`);
}

function isStoredIndex(value: unknown): value is StoredIndex {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record.v === 1 &&
    typeof record.builtAt === "number" &&
    Array.isArray(record.entries) &&
    record.entries.every(
      (entry: unknown) =>
        Array.isArray(entry) &&
        entry.length === 3 &&
        entry.every((part: unknown) => typeof part === "string"),
    )
  );
}

async function readIndex(
  cache: IndexCache,
  request: Request,
): Promise<LiveLinkIndexEntry[] | null> {
  try {
    const response = await cache.match(request);
    if (!response) return null;
    const stored: unknown = await response.json();
    if (!isStoredIndex(stored)) return null;
    // The Cache API honours max-age. This check bounds the age even if it
    // does not (or the clock moved backwards).
    const age = Date.now() - stored.builtAt;
    if (age < 0 || age > LIVE_LINK_INDEX_TTL_SECONDS * 1000) return null;
    return stored.entries.map(([id, key, updatedAt]) => ({ id, key, updatedAt }));
  } catch {
    return null;
  }
}

async function writeIndex(
  cache: IndexCache,
  request: Request,
  entries: LiveLinkIndexEntry[],
): Promise<void> {
  const stored: StoredIndex = {
    v: 1,
    builtAt: Date.now(),
    entries: entries.map((entry) => [entry.id, entry.key, entry.updatedAt]),
  };
  try {
    await cache.put(
      request,
      new Response(JSON.stringify(stored), {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": `max-age=${LIVE_LINK_INDEX_TTL_SECONDS}`,
        },
      }),
    );
  } catch {
    // A failed write only costs the next request a scan.
  }
}

/** Scan the scope (cap 2,000) and hash every key. */
async function buildIndex(db: D1Queryable, scope: Scope): Promise<LiveLinkIndexEntry[]> {
  const rows = await scanScopeKeys(db, scope);
  return Promise.all(
    rows.map(async (row) => ({
      id: await feedItemIdFor(row.key),
      key: row.key,
      updatedAt: row.updatedAt,
    })),
  );
}

/** Whether a scope row stamped at or after the cached list's newest row has `itemId`. */
async function newerRowsHave(
  db: D1Queryable,
  scope: Scope,
  cached: LiveLinkIndexEntry[],
  itemId: string,
): Promise<boolean> {
  const since = cached[0]?.updatedAt;
  const rows = await scanScopeKeys(db, scope, since === undefined ? {} : { since });
  for (const row of rows) {
    if ((await feedItemIdFor(row.key)) === itemId) return true;
  }
  return false;
}

/**
 * The live link's scope list (newest first) and the position of `itemId` in
 * it, or null when the id is not in scope. The caller must already have
 * resolved `record` as a live (not revoked) link.
 */
export async function findLiveLinkItem(
  db: D1Queryable,
  record: FeedRecord,
  itemId: string,
): Promise<{ entries: LiveLinkIndexEntry[]; position: number } | null> {
  const scope = feedRecordScope(record);
  const cache = await openIndexCache();
  const request = cache ? await indexCacheRequest(record, scope) : null;
  const cached = cache && request ? await readIndex(cache, request) : null;

  if (cached) {
    const position = cached.findIndex((entry) => entry.id === itemId);
    if (position >= 0) {
      if (await scopeHasKey(db, scope, cached[position].key)) return { entries: cached, position };
      // The key left the scope (deleted or re-scoped): rebuild below.
    } else if (!(await newerRowsHave(db, scope, cached, itemId))) {
      return null;
    }
  }

  const entries = await buildIndex(db, scope);
  if (cache && request) await writeIndex(cache, request, entries);
  const position = entries.findIndex((entry) => entry.id === itemId);
  return position >= 0 ? { entries, position } : null;
}
