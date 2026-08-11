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
 * Total UTF-8 key+value bytes — the quantity `META_MAX_TOTAL_BYTES` caps.
 * One implementation so the validator and the cap-aware merge below can never
 * disagree about what "metadata bytes" means.
 */
export function metadataByteLength(meta: Record<string, string>): number {
  let total = 0;
  for (const [key, value] of Object.entries(meta)) {
    total += encoder.encode(key).byteLength + encoder.encode(value).byteLength;
  }
  return total;
}

/** Keys that count against `META_MAX_KEYS` — server-owned keys are exempt. */
function countableKeys(meta: Record<string, string>): string[] {
  // Server-owned keys don't consume the user's budget — otherwise every video
  // upload would silently cost four of their META_MAX_KEYS slots.
  return Object.keys(meta).filter((key) => !isServerMetaKey(key));
}

/**
 * Merge `additions` under `base`, keeping each addition only while the result
 * still satisfies both caps. `base` keys always win and are never dropped, and
 * a full budget drops the overflow rather than throwing — a caller merging
 * *derived* facts must never fail an upload over them.
 *
 * Deliberately the same rule as the CLI's `mergeDerivedMeta`
 * (`packages/uploads/src/metadata-vocab.ts`), which applies it to capture-time
 * derived metadata. Server-side inheritance (#479) and capture-time derivation
 * are one feature to a user, so they share an overflow rule rather than each
 * inventing one.
 */
export function mergeWithinMetadataCaps(
  base: Record<string, string>,
  additions: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = { ...base };
  let keyCount = countableKeys(out).length;
  let bytes = metadataByteLength(out);

  for (const [key, value] of Object.entries(additions)) {
    if (key in out) continue;
    const addedKey = isServerMetaKey(key) ? 0 : 1;
    const addedBytes = encoder.encode(key).byteLength + encoder.encode(value).byteLength;
    if (keyCount + addedKey > META_MAX_KEYS) continue;
    if (bytes + addedBytes > META_MAX_TOTAL_BYTES) continue;
    out[key] = value;
    keyCount += addedKey;
    bytes += addedBytes;
  }
  return out;
}

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
  const countable = countableKeys(meta);
  if (countable.length > META_MAX_KEYS) {
    throw new ValidationError(`metadata must have at most ${META_MAX_KEYS} keys.`, {
      code: "file_metadata_limit_exceeded",
      details: { limit: META_MAX_KEYS, count: countable.length },
    });
  }

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
  }

  const totalBytes = metadataByteLength(meta);
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

/**
 * Add only the pairs an object does not already carry, dropping any that would
 * breach the caps (`mergeWithinMetadataCaps`) instead of throwing.
 *
 * The additive-and-lossy counterpart to `setFileMetadata`, which merges with
 * `set` winning and rejects the whole call on overflow. Callers supplying
 * *derived* pairs — facts the server inferred rather than the user typed — want
 * neither of those: an inferred value must never overwrite one the user stated,
 * and must never fail a request it was only decorating.
 *
 * One read and one batch: the merge happens here rather than by reading, diffing
 * outside, and handing the result to `setFileMetadata`, which would read the same
 * row a second time.
 *
 * Returns the object's resulting metadata when something was written, else
 * `undefined` so a caller can tell "nothing to do" from "wrote an empty map".
 */
export async function addMissingFileMetadata(
  db: D1Database,
  workspace: string,
  objectKey: string,
  candidates: Record<string, string>,
): Promise<Record<string, string> | undefined> {
  if (Object.keys(candidates).length === 0) return undefined;
  validateMetadataEntries(candidates);

  const current = await getFileMetadata(db, workspace, objectKey);
  const next = mergeWithinMetadataCaps(current, candidates);

  const additions: Record<string, string> = {};
  for (const key of Object.keys(candidates)) {
    if (!(key in current) && key in next) additions[key] = next[key]!;
  }
  if (Object.keys(additions).length === 0) return undefined;

  await db.batch(upsertStatements(db, workspace, objectKey, additions, new Date().toISOString()));
  return next;
}

/**
 * Targeted single-key value update. Exists because `replaceFileMetadata` is
 * delete-then-insert over the whole key set and would wipe server-owned
 * `video.*` rows — never use replace to flip one flag. Used by the GitHub
 * attachment ingest reconciler to stamp `gh.detached` without disturbing any
 * other row. No-op (no row created) if the key isn't already present.
 */
export async function updateFileMetadataValue(
  db: D1Database,
  workspace: string,
  objectKey: string,
  metaKey: string,
  value: string,
): Promise<void> {
  await db
    .prepare(
      "UPDATE file_metadata SET meta_value = ?, updated_at = ? WHERE workspace = ? AND object_key = ? AND meta_key = ?",
    )
    .bind(value, new Date().toISOString(), workspace, objectKey, metaKey)
    .run();
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
 * Deletes all metadata rows for a set of objects in one pass (e.g. the
 * retention purge's delete batches). Chunked like `getMetadataForKeys` to
 * stay under D1's bound-parameter limit. No-op on an empty list.
 */
export async function deleteFileMetadataForKeys(
  db: D1Database,
  workspace: string,
  keys: string[],
): Promise<void> {
  for (let i = 0; i < keys.length; i += METADATA_LOOKUP_CHUNK) {
    const chunk = keys.slice(i, i + METADATA_LOOKUP_CHUNK);
    const placeholders = chunk.map(() => "?").join(", ");
    await db
      .prepare(`DELETE FROM file_metadata WHERE workspace = ? AND object_key IN (${placeholders})`)
      .bind(workspace, ...chunk)
      .run();
  }
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
/** Allow one extra row so callers can probe truncation with `limit + 1`. */
const FIND_PROBE_MAX_LIMIT = FIND_MAX_LIMIT + 1;

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

  // FIND_PROBE_MAX_LIMIT lets callers request `pageSize + 1` for an exact
  // truncated signal (name search over-fetches the D1 window; see file-search.ts).
  const limit = Math.max(1, Math.min(opts.limit ?? FIND_DEFAULT_LIMIT, FIND_PROBE_MAX_LIMIT));
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

/** Max distinct meta keys returned by `facetKeys`. */
export const FACET_KEY_LIMIT = 50;
/** Max distinct values per key returned by `facetValues`. */
export const FACET_VALUE_LIMIT = 50;

/**
 * SQL fragment excluding server-owned namespaces from facet results. These
 * keys are not client-settable (`isServerMetaKey`), so offering them as
 * filters would advertise a filter the user cannot reproduce on upload.
 * Written as literal NOT LIKE legs rather than bound params because
 * SERVER_META_PREFIXES is a compile-time constant and D1 caps bound
 * parameters per query.
 */
const EXCLUDE_SERVER_KEYS = SERVER_META_PREFIXES.map(
  (prefix) => ` AND meta_key NOT LIKE '${prefix}%'`,
).join("");

/**
 * Distinct metadata keys in a workspace, with how many files carry each and
 * how many distinct values it has. `distinctValues` lets the UI tell a useful
 * facet (`app`, 3 values) from one that is effectively unique per file
 * (`path`, one value per object) before spending a round trip on it.
 *
 * Served by `file_metadata_lookup_idx (workspace, meta_key, meta_value)`.
 * Fetches one row beyond the cap so `truncated` is exact.
 */
export async function facetKeys(
  db: D1Database,
  workspace: string,
): Promise<{
  keys: Array<{ key: string; count: number; distinctValues: number }>;
  truncated: boolean;
}> {
  const result = await db
    .prepare(
      `SELECT meta_key, COUNT(*) AS count, COUNT(DISTINCT meta_value) AS distinct_values
       FROM file_metadata
       WHERE workspace = ?${EXCLUDE_SERVER_KEYS}
       GROUP BY meta_key
       ORDER BY count DESC, meta_key ASC
       LIMIT ?`,
    )
    .bind(workspace, FACET_KEY_LIMIT + 1)
    .all<{ meta_key: string; count: number; distinct_values: number }>();

  const truncated = result.results.length > FACET_KEY_LIMIT;
  const rows = truncated ? result.results.slice(0, FACET_KEY_LIMIT) : result.results;
  return {
    keys: rows.map((row) => ({
      key: row.meta_key,
      count: row.count,
      distinctValues: row.distinct_values,
    })),
    truncated,
  };
}

/**
 * Distinct values for one metadata key, most common first. Fetched lazily by
 * the UI when a key is selected, so a workspace with forty keys costs one
 * grouped query on open rather than forty.
 *
 * Rides the same index as an exact prefix seek (workspace + meta_key), so
 * rows-read is proportional to the one key rather than the whole workspace.
 */
export async function facetValues(
  db: D1Database,
  workspace: string,
  key: string,
): Promise<{ values: Array<{ value: string; count: number }>; truncated: boolean }> {
  if (isServerMetaKey(key)) return { values: [], truncated: false };

  const result = await db
    .prepare(
      `SELECT meta_value, COUNT(*) AS count
       FROM file_metadata
       WHERE workspace = ? AND meta_key = ?
       GROUP BY meta_value
       ORDER BY count DESC, meta_value ASC
       LIMIT ?`,
    )
    .bind(workspace, key, FACET_VALUE_LIMIT + 1)
    .all<{ meta_value: string; count: number }>();

  const truncated = result.results.length > FACET_VALUE_LIMIT;
  const rows = truncated ? result.results.slice(0, FACET_VALUE_LIMIT) : result.results;
  return {
    values: rows.map((row) => ({ value: row.meta_value, count: row.count })),
    truncated,
  };
}

/** Max path groups returned by `groupObjectsByPath`. */
export const BY_PATH_GROUP_LIMIT = 50;
/** Recent object keys returned per path group. */
export const BY_PATH_RECENT_LIMIT = 6;

export type PathGroup = {
  path: string;
  count: number;
  lastUpdated: string;
  recent: string[];
};

/**
 * Recent uploads grouped by their `path` metadata value — the screenshots
 * page's one query (spec: docs/superpowers/specs/2026-08-10-screenshots-by-path-design.md).
 * Groups come back most-recently-active first, each carrying its newest
 * BY_PATH_RECENT_LIMIT keys and total count.
 *
 * One windowed statement over the `path` rows only (seeked via
 * `file_metadata_lookup_idx (workspace, meta_key, meta_value)`), so rows-read
 * scales with path-tagged files, not the whole metadata table. For `path`
 * rows `updated_at` is effectively upload time — the key is written at
 * upload — which is what "recent" should mean here. The group cap is applied
 * while assembling (rows arrive grouped), keeping the newest groups.
 */
export async function groupObjectsByPath(
  db: D1Database,
  workspace: string,
): Promise<{ groups: PathGroup[]; truncated: boolean }> {
  const result = await db
    .prepare(
      `SELECT path, object_key, cnt, latest FROM (
         SELECT meta_value AS path, object_key,
                ROW_NUMBER() OVER (PARTITION BY meta_value ORDER BY updated_at DESC, object_key ASC) AS rn,
                COUNT(*) OVER (PARTITION BY meta_value) AS cnt,
                MAX(updated_at) OVER (PARTITION BY meta_value) AS latest
         FROM file_metadata
         WHERE workspace = ? AND meta_key = 'path'
       )
       WHERE rn <= ?
       ORDER BY latest DESC, path ASC, rn ASC`,
    )
    .bind(workspace, BY_PATH_RECENT_LIMIT)
    .all<{ path: string; object_key: string; cnt: number; latest: string }>();

  const groups: PathGroup[] = [];
  let truncated = false;
  for (const row of result.results) {
    const current = groups[groups.length - 1];
    if (current?.path === row.path) {
      current.recent.push(row.object_key);
      continue;
    }
    if (groups.length === BY_PATH_GROUP_LIMIT) {
      truncated = true;
      break;
    }
    groups.push({
      path: row.path,
      count: row.cnt,
      lastUpdated: row.latest,
      recent: [row.object_key],
    });
  }
  return { groups, truncated };
}

/**
 * Project label for the screenshots page (spec:
 * docs/superpowers/specs/2026-08-11-screenshots-project-grouping-design.md).
 * Coalesces repo → gh.repo → url origin → "Other". Display/grouping only —
 * never stored. Mirrored (with identical cases) by
 * apps/web/src/lib/workspace-screenshots.ts.
 */
export function projectLabelFromMeta(meta: {
  repo?: string | null;
  ghRepo?: string | null;
  url?: string | null;
}): string {
  if (meta.repo) return meta.repo;
  if (meta.ghRepo) return meta.ghRepo;
  if (meta.url) {
    try {
      const host = new URL(meta.url).host;
      if (host) return host;
    } catch {
      // fall through — an unparseable url is just "no url"
    }
  }
  return "Other";
}

export type FacetKeysResult = {
  keys: Array<{ key: string; count: number; distinctValues: number }>;
  truncated: boolean;
};

export type FacetValuesResult = {
  key: string;
  values: Array<{ value: string; count: number }>;
  truncated: boolean;
};

/**
 * Facet discovery shared by token `/files/facets`, session `/me/.../files/facets`,
 * and hosted MCP `list_metadata_keys`. No `key` → workspace key list; with
 * `key` → that key's values (validated against `META_KEY_RE`).
 */
export async function listFacets(
  db: D1Database,
  workspace: string,
  key?: string,
): Promise<FacetKeysResult | FacetValuesResult> {
  if (key === undefined) return facetKeys(db, workspace);
  if (!META_KEY_RE.test(key)) {
    throw new ValidationError(`invalid metadata key: ${key}`, {
      code: "file_metadata_invalid_key",
      details: { key },
    });
  }
  const { values, truncated } = await facetValues(db, workspace, key);
  return { key, values, truncated };
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
