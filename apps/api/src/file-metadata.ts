/**
 * Per-file queryable metadata (`file_metadata` D1 table).
 *
 * The queryable-tag tier for uploads.sh objects (see
 * `.context/2026-07-13-file-metadata-design.md`): capped, mutable key-value
 * pairs stored one row per pair, scoped by `(workspace, object_key)`. Distinct
 * from R2 custom metadata (`provenance.ts`), which stays unqueryable and
 * server/allowlist-controlled.
 */

import { InternalError, ValidationError } from "@uploads/errors";
import { PROVENANCE_SERVER_KEYS } from "./provenance";

/** Lowercase key, optionally namespaced with dots (e.g. `gh.repo`). */
export const META_KEY_RE = /^[a-z][a-z0-9._-]{0,63}$/;

/**
 * Server-set provenance keys (e.g. `content-sha256`) are reserved: a custom
 * metadata row with the same name would be a spoofable shadow of a value the
 * server computes and vouches for. Enforced here — the single choke point for
 * upload capture, the PATCH endpoint, and any future setFileMetadata caller.
 * `gh.*` keys are NOT reserved: system-managed by convention only (design doc).
 */
// `visibility` is reserved too: it names the R2-backed public/private gate
// (visibility.ts's VISIBILITY_META_KEY), not a piece of D1 custom metadata. A
// custom row with this name would render on the public /f/ panel looking
// like an access-control setting when it's just an unrelated user tag.
const RESERVED_META_KEYS = new Set<string>([...PROVENANCE_SERVER_KEYS, "visibility"]);

/**
 * Namespaces the server owns outright (issue #299). A client must never write
 * these: `video.poster` decides whether a poster `<img>` renders in a public
 * PR comment, so a user-settable row would be a spoofable input to public
 * output. Reserved as a *prefix* rather than four exact keys so future derived
 * facts can't collide.
 */
export const SERVER_META_PREFIXES = ["video."] as const;

export function isServerMetaKey(key: string): boolean {
  return SERVER_META_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/**
 * True when `key` must not be written (or deleted) by a client:
 * `RESERVED_META_KEYS` always, plus the server-owned `video.*` namespace
 * unless `opts.allowServerKeys` opts in. Single choke point for the
 * reserved-key check — every caller must go through this rather than
 * re-pairing `RESERVED_META_KEYS.has` with `isServerMetaKey` by hand, which
 * would silently reopen the hole this predicate exists to close.
 */
function isReservedMetaKey(key: string, opts: { allowServerKeys?: boolean } = {}): boolean {
  return RESERVED_META_KEYS.has(key) || (!opts.allowServerKeys && isServerMetaKey(key));
}

/** Cap applied both to a single write request and to a file's total keys post-merge. */
export const META_MAX_KEYS = 24;

/** Sum of key+value UTF-8 bytes, enforced per file (and, defensively, per request). */
export const META_MAX_TOTAL_BYTES = 8192;

/** Max value length in characters. */
export const META_VALUE_MAX = 512;

/**
 * Trim and cap a display string to META_VALUE_MAX.
 * Used for public GitHub titles (stamped or live-resolved).
 */
export function displayTitle(raw: string | undefined): string | undefined {
  const t = raw?.trim();
  if (!t) return undefined;
  return t.length > META_VALUE_MAX ? t.slice(0, META_VALUE_MAX) : t;
}

// Printable ASCII only — same rule as provenance.ts's VALUE_SAFE_RE.
const VALUE_SAFE_RE = /^[\x20-\x7E]+$/;

const encoder = new TextEncoder();

/**
 * Shared validation body for `validateMetadataEntries` and
 * `validateStoredMetadataEntries`: key format, value format/length, the
 * per-map key-count cap, and the total key+value byte cap.
 * `opts.allowServerKeys` is the one difference between the two exported
 * wrappers below — kept private so no other call site can pass it directly.
 */
function validateMetadataEntriesImpl(
  meta: Record<string, string>,
  opts: { allowServerKeys?: boolean },
): void {
  const keys = Object.keys(meta);
  // Server-owned keys don't consume the user's budget — otherwise every video
  // upload would silently cost four of their META_MAX_KEYS slots.
  const countable = keys.filter((key) => !isServerMetaKey(key));
  if (countable.length > META_MAX_KEYS) {
    throw new ValidationError(`metadata must have at most ${META_MAX_KEYS} keys.`, {
      code: "file_metadata_limit_exceeded",
      details: { limit: META_MAX_KEYS, count: countable.length },
    });
  }

  let totalBytes = 0;
  for (const key of keys) {
    if (!META_KEY_RE.test(key)) {
      throw new ValidationError(`invalid metadata key: ${key}`, {
        code: "file_metadata_invalid_key",
        details: { key },
      });
    }
    if (isReservedMetaKey(key, opts)) {
      throw new ValidationError(`reserved metadata key: ${key}`, {
        code: "file_metadata_reserved_key",
        details: { key },
      });
    }
    const value = meta[key];
    if (
      typeof value !== "string" ||
      value.length < 1 ||
      value.length > META_VALUE_MAX ||
      !VALUE_SAFE_RE.test(value)
    ) {
      throw new ValidationError(`invalid metadata value for key: ${key}`, {
        code: "file_metadata_invalid_value",
        details: { key },
      });
    }
    totalBytes += encoder.encode(key).byteLength + encoder.encode(value).byteLength;
  }

  if (totalBytes > META_MAX_TOTAL_BYTES) {
    throw new ValidationError(`metadata exceeds ${META_MAX_TOTAL_BYTES} total bytes.`, {
      code: "file_metadata_limit_exceeded",
      details: { limit: META_MAX_TOTAL_BYTES, bytes: totalBytes },
    });
  }
}

/**
 * Throws a `ValidationError` (AppError, type "validation") if `meta` violates
 * key format, value format/length, the per-map key-count cap, or the total
 * key+value byte cap — and rejects both `RESERVED_META_KEYS` and the
 * server-owned `video.*` namespace. Every client-facing path calls this: the
 * PATCH route, upload header capture, MCP tools, `replaceFileMetadata`, and
 * `setFileMetadata`'s pre-check on `set`.
 */
export function validateMetadataEntries(meta: Record<string, string>): void {
  validateMetadataEntriesImpl(meta, {});
}

/**
 * Same checks as `validateMetadataEntries`, except the server-owned
 * `video.*` namespace is allowed through (`RESERVED_META_KEYS` — provenance,
 * `visibility` — is still rejected). Used ONLY by `setServerFileMetadata` and
 * by `setFileMetadata`'s post-merge check, where `video.*` rows may already
 * be present in stored state that this call is re-validating, not writing.
 *
 * MUST NEVER be called with client-supplied key names — doing so would let a
 * client write the server-owned `video.*` namespace directly (e.g. spoof
 * `video.poster` to render an attacker-controlled image on a public PR
 * comment).
 */
export function validateStoredMetadataEntries(meta: Record<string, string>): void {
  validateMetadataEntriesImpl(meta, { allowServerKeys: true });
}

/**
 * Validates a `meta.*`-style equality-filter map (REST list endpoint's
 * `meta.<key>=<value>` query params, the MCP `find_files` tool's `filters`
 * argument): enforces the same count cap and key format as metadata writes,
 * using the same typed error codes so existing callers' error handling is
 * unaffected. Does not validate filter values (unlike write-side metadata,
 * an empty or arbitrary-length filter value is fine — it just won't match
 * anything) and does not check for duplicate/repeated params, which is
 * query-string-specific and stays in the REST route.
 */
export function validateMetadataFilters(filters: Record<string, string>): void {
  const keys = Object.keys(filters);
  if (keys.length > META_MAX_KEYS) {
    throw new ValidationError(`too many meta.* filters (max ${META_MAX_KEYS})`, {
      code: "file_metadata_too_many_filters",
      details: { limit: META_MAX_KEYS, count: keys.length },
    });
  }
  for (const key of keys) {
    if (!META_KEY_RE.test(key)) {
      throw new ValidationError(`invalid metadata key: ${key}`, {
        code: "file_metadata_invalid_key",
        details: { key },
      });
    }
  }
}

interface MetaRow {
  meta_key: string;
  meta_value: string;
}

/** All metadata for one object, keyed by `(workspace, object_key)`. */
export async function getFileMetadata(
  db: D1Database,
  workspace: string,
  objectKey: string,
): Promise<Record<string, string>> {
  try {
    const result = await db
      .prepare(
        `SELECT meta_key, meta_value FROM file_metadata WHERE workspace = ? AND object_key = ?`,
      )
      .bind(workspace, objectKey)
      .all<MetaRow>();
    const metadata: Record<string, string> = {};
    for (const row of result.results) metadata[row.meta_key] = row.meta_value;
    return metadata;
  } catch (err) {
    // Public /f/ hits this path — keep D1 blips as typed AppErrors for respondError.
    throw new InternalError("failed to load file metadata", { cause: err });
  }
}

/**
 * Prepared upsert statements for `entries`, one `INSERT ... ON CONFLICT DO
 * UPDATE` per key/value pair. Shared by `setFileMetadata`,
 * `replaceFileMetadata`, and `setServerFileMetadata` so the SQL lives in
 * exactly one place; does not change SQL semantics for any of them.
 */
function upsertStatements(
  db: D1Database,
  workspace: string,
  objectKey: string,
  entries: Record<string, string>,
  now: string,
): D1PreparedStatement[] {
  return Object.entries(entries).map(([key, value]) =>
    db
      .prepare(
        `INSERT INTO file_metadata (workspace, object_key, meta_key, meta_value, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(workspace, object_key, meta_key)
         DO UPDATE SET meta_value = excluded.meta_value, updated_at = excluded.updated_at`,
      )
      .bind(workspace, objectKey, key, value, now),
  );
}

/**
 * Merge `set` into the object's metadata and drop `remove` keys, enforcing
 * caps against the post-merge state. Rejects (no write) if the caps would be
 * violated; otherwise upserts/deletes atomically and returns the final map.
 * `remove` is applied before `set`, so a key present in both ends up set.
 *
 * `remove` is checked against the same reserved/server-owned key rules as
 * `set` (`isReservedMetaKey`) before any read or write: a
 * client that cannot set `video.*`, `visibility`, or a provenance key must
 * not be able to delete it by name either, since that would let it silently
 * blank a value the server owns (e.g. a video poster).
 *
 * Concurrency: the read → validate → batch write is not guarded, so two
 * concurrent merges on the same object can land a combined state slightly
 * over the caps (same accepted last-write-wins tradeoff as visibility
 * rewrites in files-core.ts; single-tenant writes sit behind the write
 * rate limiter). Caps are re-enforced on the next merge.
 */
export async function setFileMetadata(
  db: D1Database,
  workspace: string,
  objectKey: string,
  set: Record<string, string>,
  remove: string[] = [],
): Promise<Record<string, string>> {
  validateMetadataEntries(set);
  // Symmetry with the write path: a client that cannot SET a reserved or
  // server-owned key (RESERVED_META_KEYS / video.*) has no legitimate reason
  // to DELETE it either — otherwise it could silently blank a value like
  // video.poster or visibility by naming it in `remove`. Checked before any
  // read/write so a reserved key anywhere in the list blocks the whole call.
  for (const key of remove) {
    if (isReservedMetaKey(key)) {
      throw new ValidationError(`reserved metadata key: ${key}`, {
        code: "file_metadata_reserved_key",
        details: { key },
      });
    }
  }

  const current = await getFileMetadata(db, workspace, objectKey);
  const next: Record<string, string> = { ...current };
  for (const key of remove) delete next[key];
  Object.assign(next, set);

  // `current` may already carry server-owned video.* rows (e.g. a poster),
  // so this post-merge pass enforces the count/byte caps on the merged
  // result — it must not re-reject keys that were already validly stored.
  validateStoredMetadataEntries(next);

  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = upsertStatements(db, workspace, objectKey, set, now);
  for (const key of remove) {
    if (key in set) continue; // set wins when a key is both removed and set
    statements.push(
      db
        .prepare(
          `DELETE FROM file_metadata WHERE workspace = ? AND object_key = ? AND meta_key = ?`,
        )
        .bind(workspace, objectKey, key),
    );
  }
  if (statements.length > 0) await db.batch(statements);

  return next;
}

/** Deletes all metadata rows for an object (e.g. on object delete). */
export async function deleteFileMetadata(
  db: D1Database,
  workspace: string,
  objectKey: string,
): Promise<void> {
  await db
    .prepare(`DELETE FROM file_metadata WHERE workspace = ? AND object_key = ?`)
    .bind(workspace, objectKey)
    .run();
}

/** Deletes every metadata row for a workspace being torn down. */
export async function deleteFileMetadataForWorkspace(
  db: D1Database,
  workspace: string,
): Promise<void> {
  await db.prepare(`DELETE FROM file_metadata WHERE workspace = ?`).bind(workspace).run();
}

/**
 * Fully replaces an object's metadata: validates `metadata` once (there's no
 * prior state to merge against, so unlike `setFileMetadata` there's nothing
 * to re-read first), then deletes any existing rows and inserts the new set
 * in a single `db.batch` — atomic, and without the wasted
 * guaranteed-empty-map SELECT that `deleteFileMetadata` + `setFileMetadata`
 * would otherwise incur. Used by `putObject`'s full-replace-on-upload path.
 */
export async function replaceFileMetadata(
  db: D1Database,
  workspace: string,
  objectKey: string,
  metadata: Record<string, string>,
): Promise<void> {
  validateMetadataEntries(metadata);

  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [
    db
      .prepare(`DELETE FROM file_metadata WHERE workspace = ? AND object_key = ?`)
      .bind(workspace, objectKey),
    ...upsertStatements(db, workspace, objectKey, metadata, now),
  ];
  await db.batch(statements);
}

const FIND_DEFAULT_LIMIT = 50;
const FIND_MAX_LIMIT = 500;

/**
 * Escapes SQL LIKE metacharacters (`%`, `_`, and the escape character itself)
 * so a prefix like `my_app/` matches only literal underscores — paired with
 * `ESCAPE '\'` in the query. Without this, `_` and `%` in `opts.prefix` are
 * interpreted as single-char/any-run wildcards and over-match (e.g. `my_app/`
 * would also match `myXapp/`).
 */
function escapeLikePattern(raw: string): string {
  return raw.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * Finds objects whose metadata matches ALL `filters` (ANDed equality), with
 * an optional key-prefix and result limit. Returns each match's key plus its
 * full metadata map (not just the matched pairs).
 *
 * Index-aware against `file_metadata_lookup_idx (workspace, meta_key, meta_value)`:
 * - one filter → equality (+ optional prefix) + LIMIT
 * - multi-filter → INTERSECT of per-filter key sets (each leg uses the index)
 *   rather than OR + GROUP BY HAVING, which over-reads when any filter value
 *   is common (e.g. `gh.kind=pull`).
 */
export async function findObjectsByMetadata(
  db: D1Database,
  workspace: string,
  filters: Record<string, string>,
  opts: { prefix?: string; limit?: number } = {},
): Promise<Array<{ key: string; metadata: Record<string, string> }>> {
  const entries = Object.entries(filters);
  if (entries.length === 0) return [];

  const limit = Math.max(1, Math.min(opts.limit ?? FIND_DEFAULT_LIMIT, FIND_MAX_LIMIT));
  const params: unknown[] = [];
  const legs = entries.map(([key, value]) => {
    params.push(workspace, key, value);
    return `SELECT object_key FROM file_metadata WHERE workspace = ? AND meta_key = ? AND meta_value = ?`;
  });

  // Single filter: prefix in-leg so LIMIT applies to the narrowed set.
  // Multi-filter: INTERSECT first, then prefix/limit on the intersection.
  let sql: string;
  if (entries.length === 1) {
    sql = legs[0]!;
    if (opts.prefix) {
      sql += ` AND object_key LIKE ? || '%' ESCAPE '\\'`;
      params.push(escapeLikePattern(opts.prefix));
    }
  } else {
    sql = `SELECT object_key FROM (${legs.join(" INTERSECT ")})`;
    if (opts.prefix) {
      sql += ` WHERE object_key LIKE ? || '%' ESCAPE '\\'`;
      params.push(escapeLikePattern(opts.prefix));
    }
  }
  sql += ` ORDER BY object_key LIMIT ?`;
  params.push(limit);

  const matched = await db
    .prepare(sql)
    .bind(...params)
    .all<{ object_key: string }>();
  const keys = matched.results.map((row) => row.object_key);
  if (keys.length === 0) return [];

  const byKey = await getMetadataForKeys(db, workspace, keys);
  return keys.map((key) => ({ key, metadata: byKey.get(key) ?? {} }));
}

/** Max object keys bound into a single `object_key IN (...)` statement (SQLite's ~999 host-parameter limit, kept well under it). */
const METADATA_LOOKUP_CHUNK = 100;

/**
 * Batched, unfiltered lookup of D1 metadata for a set of object keys — e.g.
 * to hydrate `gh.*` metadata onto a workspace file listing. Unlike
 * `findObjectsByMetadata`, this doesn't filter by value: it returns whatever
 * metadata each key already has. Keys with no rows are simply absent from
 * the returned map (not present with an empty object). Chunks the `keys`
 * list to stay under D1/SQLite's bound-parameter limit per statement.
 *
 * `opts.metaKeys` narrows the SELECT to the named meta keys (issue #365).
 * Prefer it on hot paths: the filter rides the `(workspace, object_key,
 * meta_key)` primary-key index, so the read stays flat at ~3-5 D1 rows per
 * object key however many keys that object carries. An empty array is treated
 * as "no filter", not "select nothing" — a silently empty result map is the
 * worse failure mode for a caller that built the list dynamically.
 */
export async function getMetadataForKeys(
  db: D1Database,
  workspace: string,
  keys: string[],
  opts: { metaKeys?: string[] } = {},
): Promise<Map<string, Record<string, string>>> {
  const out = new Map<string, Record<string, string>>();
  if (keys.length === 0) return out;

  const metaKeys = opts.metaKeys?.length ? opts.metaKeys : undefined;
  const metaFilter = metaKeys ? ` AND meta_key IN (${metaKeys.map(() => "?").join(", ")})` : "";

  for (let i = 0; i < keys.length; i += METADATA_LOOKUP_CHUNK) {
    const chunk = keys.slice(i, i + METADATA_LOOKUP_CHUNK);
    const placeholders = chunk.map(() => "?").join(", ");
    const result = await db
      .prepare(
        `SELECT object_key, meta_key, meta_value FROM file_metadata
         WHERE workspace = ? AND object_key IN (${placeholders})${metaFilter}`,
      )
      .bind(workspace, ...chunk, ...(metaKeys ?? []))
      .all<{ object_key: string; meta_key: string; meta_value: string }>();
    for (const row of result.results) {
      let map = out.get(row.object_key);
      if (!map) {
        map = {};
        out.set(row.object_key, map);
      }
      map[row.meta_key] = row.meta_value;
    }
  }

  return out;
}

/**
 * Upsert server-owned metadata (`video.*`) without touching user rows.
 * Deliberately not `replaceFileMetadata`: that is delete-then-insert, and this
 * runs *after* it on the upload path — a full replace here would wipe the
 * request's own custom metadata.
 */
export async function setServerFileMetadata(
  db: D1Database,
  workspace: string,
  objectKey: string,
  metadata: Record<string, string>,
): Promise<void> {
  if (Object.keys(metadata).length === 0) return;
  validateStoredMetadataEntries(metadata);

  const now = new Date().toISOString();
  await db.batch(upsertStatements(db, workspace, objectKey, metadata, now));
}

/** Drop specific server-owned rows — used to clear a stale poster pointer. */
export async function deleteServerFileMetadataKeys(
  db: D1Database,
  workspace: string,
  objectKey: string,
  keys: string[],
): Promise<void> {
  if (keys.length === 0) return;
  const placeholders = keys.map(() => "?").join(", ");
  await db
    .prepare(
      `DELETE FROM file_metadata
       WHERE workspace = ? AND object_key = ? AND meta_key IN (${placeholders})`,
    )
    .bind(workspace, objectKey, ...keys)
    .run();
}
