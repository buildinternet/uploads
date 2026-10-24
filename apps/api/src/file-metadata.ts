/**
 * Per-file queryable metadata (`file_metadata` D1 table): capped, mutable
 * key-value pairs, one row per pair, scoped by `(workspace, object_key)`.
 * Distinct from R2 custom metadata (`provenance.ts`), which isn't queryable.
 */

import { CLASSIFIER_SAFETY_FIELDS } from "./classifier-admin-wire";
import { InternalError, ValidationError } from "@uploads/errors";
import { UPLOADER_KEYS, UPLOADER_PROOF_KEY } from "./uploader-identity";
import type { FileSurface, FileTypeClass } from "@uploads/comment-render/scope";
import { fileSurfaceSql, fileTypeSql } from "./file-type-sql";
import { PROVENANCE_SERVER_KEYS } from "./provenance";
import { type D1Queryable } from "./db-session";

/** Lowercase key, optionally namespaced with dots (e.g. `gh.repo`). */
export const META_KEY_RE = /^[a-z][a-z0-9._-]{0,63}$/;

/**
 * Metadata keys whose value is stored lowercased, on every write and search
 * filter. `gh.repo` is matched exactly by the live-link scope.
 */
export const LOWERCASED_META_KEYS: readonly string[] = ["gh.repo"];

/** Stored spelling of a metadata value; keys outside the list keep their value as written. */
export function canonicalMetaValue(key: string, value: string): string {
  return LOWERCASED_META_KEYS.includes(key) ? value.toLowerCase() : value;
}

/**
 * Reserved keys: server-set provenance (a custom row would be a spoofable
 * shadow of a server-vouched value) and `visibility` (would look like an
 * access setting on the public /f/ panel). `gh.*` is not reserved.
 */
const RESERVED_META_KEYS = new Set<string>([...PROVENANCE_SERVER_KEYS, "visibility"]);

/**
 * Namespaces only the server writes. These are server-derived facts that
 * drive public output (`video.poster` and `pdf.poster` decide whether an
 * `<img>` renders in a public PR comment, `image.*` sizes embeds) or the
 * classifier's `ai.*` labels and safety flags, so a client must not spoof
 * them. Public responses strip `ai.*`. Prefixes, so future keys can't collide.
 */
export const SERVER_META_PREFIXES = ["video.", "image.", "pdf.", "ai."] as const;

/**
 * The four internal safety flags. Each stored answer also has
 * `ai.<field>.confidence`.
 */
export const SAFETY_FLAG_FIELDS = CLASSIFIER_SAFETY_FIELDS;

/**
 * The eight internal safety-flag rows and their lifetime rule.
 *
 * `putObject` compares the previous `file_content_hash`. Identical bytes
 * keep these rows; new bytes (or no stored hash) delete them before
 * classification is scheduled. A classification that writes a value
 * (including a confident `none`) replaces that key; one that omits a key
 * leaves the old value. Object delete removes them. They don't bump
 * `ai.classifier`.
 */
export const SAFETY_FLAG_KEYS: ReadonlySet<string> = new Set(
  SAFETY_FLAG_FIELDS.flatMap((field) => [`ai.${field}`, `ai.${field}.confidence`]),
);

/** 63-bit DCT hash for a PNG or JPEG. Server-owned, like the other `ai.*` rows. */
export const PHASH_META_KEY = "ai.phash";

/**
 * Every row the classifier writes. They all describe one set of bytes, so
 * they share the `SAFETY_FLAG_KEYS` lifetime; otherwise a failed run on new
 * bytes would leave the old bytes' labels behind.
 */
export const CLASSIFIER_ROW_KEYS: ReadonlySet<string> = new Set([
  "ai.classifier",
  "ai.skip",
  "ai.error",
  "ai.kind",
  "ai.surface",
  "ai.screen",
  "ai.ready",
  "ai.tags",
  "ai.summary",
  "ai.hold",
  "ai.hold.moved",
  "ai.hold.area",
  "ai.hold.by",
  "ai.hold.at",
  PHASH_META_KEY,
  ...SAFETY_FLAG_KEYS,
]);

/**
 * The classifier rows in `meta`. A server-side copy of the same bytes
 * (promote, attach) carries these over, because the copy is not classified
 * again and a hold (`ai.hold`) must follow the file.
 */
export function classifierRowsOf(meta: Record<string, string> | undefined): Record<string, string> {
  if (!meta) return {};
  return Object.fromEntries(Object.entries(meta).filter(([key]) => CLASSIFIER_ROW_KEYS.has(key)));
}

export function isServerMetaKey(key: string): boolean {
  return SERVER_META_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/**
 * Public queryable tags only. Collections omit GitHub tags because their titles
 * and state follow a separate public-audience check; standalone files retain
 * their existing raw GitHub metadata contract.
 */
export function publicFileMetadata(
  metadata: Record<string, string>,
  { includeGithub = true }: { includeGithub?: boolean } = {},
): Record<string, string> | undefined {
  const entries = Object.entries(metadata).filter(
    ([key]) =>
      !RESERVED_META_KEYS.has(key) &&
      !isServerMetaKey(key) &&
      (includeGithub || !key.startsWith("gh.")),
  );
  return entries.length ? Object.fromEntries(entries) : undefined;
}

/**
 * True when a client must not write or delete `key`: `RESERVED_META_KEYS`
 * always, and server-owned namespaces unless `opts.allowServerKeys`. Every
 * reserved-key check goes through here.
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

/** Total UTF-8 key+value bytes, the quantity `META_MAX_TOTAL_BYTES` caps. */
export function metadataByteLength(meta: Record<string, string>): number {
  let total = 0;
  for (const [key, value] of Object.entries(meta)) {
    total += encoder.encode(key).byteLength + encoder.encode(value).byteLength;
  }
  return total;
}

/** Keys that count against `META_MAX_KEYS` — server-owned keys are exempt. */
function countableKeys(meta: Record<string, string>): string[] {
  // Otherwise every video upload would cost several of the user's key slots.
  return Object.keys(meta).filter((key) => !isServerMetaKey(key));
}

/**
 * Merge `additions` under `base`, keeping each addition only while both caps
 * still hold. `base` always wins, and overflow is dropped rather than
 * thrown: derived facts must never fail an upload. Same rule as the CLI's
 * `mergeDerivedMeta`.
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
 * Shared body of the two validators below; `allowServerKeys` is their only
 * difference and stays private.
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
 * Throws a `ValidationError` for a bad key or value format, the key-count
 * cap, or the byte cap, and rejects reserved and server-owned keys. Every
 * client-facing write path calls this.
 */
export function validateMetadataEntries(meta: Record<string, string>): void {
  validateMetadataEntriesImpl(meta, {});
}

/**
 * `validateMetadataEntries` that allows server-owned namespaces. Only for
 * `setServerFileMetadata` and re-validating already-stored state. Never call
 * it with client-supplied keys: that would let a client spoof `video.poster`
 * on a public PR comment.
 */
export function validateStoredMetadataEntries(meta: Record<string, string>): void {
  validateMetadataEntriesImpl(meta, { allowServerKeys: true });
}

/**
 * Validates an equality-filter map (`meta.<key>=<value>` params, MCP
 * `find_files` filters): same count cap, key format, and error codes as
 * writes. Values aren't validated; a bad one just doesn't match.
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
  db: D1Queryable,
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

/** One `INSERT ... ON CONFLICT DO UPDATE` per pair, shared by the write paths. */
function upsertStatements(
  db: D1Queryable,
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
      .bind(workspace, objectKey, key, canonicalMetaValue(key, value), now),
  );
}

const CLIENT_LOCKED_UPLOADER_KEYS = new Set<string>([...UPLOADER_KEYS, UPLOADER_PROOF_KEY]);

/**
 * Uploader attribution is server-stamped. A client write of these keys would
 * let a `files:write` token claim someone else's object and then delete it.
 * Server copies that keep the source's stamp (attach) pass
 * `allowUploaderKeys`.
 */
function assertUploaderKeysLocked(keys: Iterable<string>): void {
  for (const key of keys) {
    if (!CLIENT_LOCKED_UPLOADER_KEYS.has(key)) continue;
    throw new ValidationError(`reserved metadata key: ${key}`, {
      code: "file_metadata_reserved_key",
      details: { key },
    });
  }
}

/**
 * Merge `set` into the object's metadata and drop `remove` keys (`set` wins
 * on overlap), enforcing caps on the merged state. Rejects without writing
 * on a violation. `remove` follows the same reserved-key rules as `set`.
 *
 * Read, validate and write aren't atomic, so concurrent merges can land
 * slightly over the caps; the next merge re-enforces them.
 */
export async function setFileMetadata(
  db: D1Queryable,
  workspace: string,
  objectKey: string,
  set: Record<string, string>,
  remove: string[] = [],
  opts?: { allowUploaderKeys?: boolean },
): Promise<Record<string, string>> {
  if (!opts?.allowUploaderKeys) {
    assertUploaderKeysLocked(Object.keys(set));
    assertUploaderKeysLocked(remove);
  }
  validateMetadataEntries(set);
  // A client that can't set a reserved key can't delete it either.
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
  for (const [key, value] of Object.entries(set)) next[key] = canonicalMetaValue(key, value);

  // `current` may already hold server-owned rows, so only enforce the caps
  // on the merged result.
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
 * Add only the pairs an object doesn't already carry, dropping any that would
 * breach the caps. For derived pairs: an inferred value must never overwrite
 * a stated one or fail the request. Returns the resulting metadata when
 * something was written, else `undefined`.
 */
export async function addMissingFileMetadata(
  db: D1Queryable,
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
 * Single-key value update. `replaceFileMetadata` would wipe server-owned
 * rows, so use this to flip one flag. No-op if the key isn't present.
 */
export async function updateFileMetadataValue(
  db: D1Queryable,
  workspace: string,
  objectKey: string,
  metaKey: string,
  value: string,
): Promise<void> {
  await db
    .prepare(
      "UPDATE file_metadata SET meta_value = ?, updated_at = ? WHERE workspace = ? AND object_key = ? AND meta_key = ?",
    )
    .bind(
      canonicalMetaValue(metaKey, value),
      new Date().toISOString(),
      workspace,
      objectKey,
      metaKey,
    )
    .run();
}

/** Deletes all metadata rows for an object (e.g. on object delete). */
export async function deleteFileMetadata(
  db: D1Queryable,
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
  db: D1Queryable,
  workspace: string,
): Promise<void> {
  await db.prepare(`DELETE FROM file_metadata WHERE workspace = ?`).bind(workspace).run();
}

/** Deletes all metadata rows for a set of objects, chunked under D1's bind limit. */
export async function deleteFileMetadataForKeys(
  db: D1Queryable,
  workspace: string,
  keys: string[],
): Promise<void> {
  const chunkSize = metadataLookupChunk(1); // the workspace bind
  for (let i = 0; i < keys.length; i += chunkSize) {
    const chunk = keys.slice(i, i + chunkSize);
    const placeholders = chunk.map(() => "?").join(", ");
    await db
      .prepare(`DELETE FROM file_metadata WHERE workspace = ? AND object_key IN (${placeholders})`)
      .bind(workspace, ...chunk)
      .run();
  }
}

/** Stable bind list for the classifier-row exclusion in `replaceFileMetadata`. */
const CLASSIFIER_ROW_KEY_LIST = [...CLASSIFIER_ROW_KEYS];

/**
 * Fully replaces an object's client metadata. See `CLASSIFIER_ROW_KEYS`
 * for when `keepClassifierRows` retains those rows. The incoming map is client
 * metadata, so `validateMetadataEntries` already rejects `ai.*` in it.
 */
export async function replaceFileMetadata(
  db: D1Queryable,
  workspace: string,
  objectKey: string,
  metadata: Record<string, string>,
  opts?: { keepClassifierRows?: boolean },
): Promise<void> {
  validateMetadataEntries(metadata);

  const now = new Date().toISOString();
  const keep = CLASSIFIER_ROW_KEY_LIST.map(() => "?").join(", ");
  const deleteStmt = opts?.keepClassifierRows
    ? db
        .prepare(
          `DELETE FROM file_metadata
           WHERE workspace = ? AND object_key = ? AND meta_key NOT IN (${keep})`,
        )
        .bind(workspace, objectKey, ...CLASSIFIER_ROW_KEY_LIST)
    : db
        .prepare(`DELETE FROM file_metadata WHERE workspace = ? AND object_key = ?`)
        .bind(workspace, objectKey);
  const statements: D1PreparedStatement[] = [
    deleteStmt,
    ...upsertStatements(db, workspace, objectKey, metadata, now),
  ];
  await db.batch(statements);
}

const FIND_DEFAULT_LIMIT = 50;
const FIND_MAX_LIMIT = 500;
/** Allow one extra row so callers can probe truncation with `limit + 1`. */
const FIND_PROBE_MAX_LIMIT = FIND_MAX_LIMIT + 1;

/**
 * Prefix filter via substr rather than `LIKE ? || '%'`: D1 caps LIKE
 * patterns at 50 bytes and private attachment prefixes are ~54. substr also
 * needs no wildcard escaping. Binds the prefix twice.
 */
const PREFIX_FILTER_SQL = `substr(object_key, 1, length(?)) = ?`;

/**
 * Matches a promoted branch-staged shot. Promotion copies it to a
 * `pull/<n>/` key and keeps the original, so the screenshots surfaces
 * collapse the original to avoid listing it twice. General search keeps it.
 * Written against subquery alias `s`.
 */
export const PROMOTED_SHADOW_STATUS_SQL = `s.meta_key = 'gh.status' AND s.meta_value = 'promoted'`;

/**
 * Matches an object stamped `gh.merged=true` by the webhook's PR-closed
 * handling. A merge is the only PR lifecycle fact persisted; open/closed
 * stay live in the title cache. Alias `s2` so it composes with
 * `PROMOTED_SHADOW_STATUS_SQL`.
 */
const MERGED_STATUS_SQL = `s2.meta_key = 'gh.merged' AND s2.meta_value = 'true'`;

/**
 * Objects whose metadata matches ALL `filters`, with optional key prefix and
 * limit. Returns each match's full metadata.
 *
 * Multiple filters INTERSECT per-filter key sets, each using
 * `file_metadata_lookup_idx`, rather than OR + GROUP BY, which over-reads on
 * common values. `collapsePromotedShadows` drops promoted branch originals.
 * `after` is a keyset continuation on `object_key`, stable across inserts.
 */
export async function findObjectsByMetadata(
  db: D1Queryable,
  workspace: string,
  filters: Record<string, string>,
  opts: {
    prefix?: string;
    limit?: number;
    collapsePromotedShadows?: boolean;
    after?: string;
  } = {},
): Promise<Array<{ key: string; metadata: Record<string, string> }>> {
  const entries = Object.entries(filters);
  if (entries.length === 0) return [];

  // Allows `pageSize + 1` for an exact truncation signal.
  const limit = Math.max(1, Math.min(opts.limit ?? FIND_DEFAULT_LIMIT, FIND_PROBE_MAX_LIMIT));
  const params: unknown[] = [];
  const legs = entries.map(([key, value]) => {
    params.push(workspace, key, canonicalMetaValue(key, value));
    return `SELECT object_key FROM file_metadata WHERE workspace = ? AND meta_key = ? AND meta_value = ?`;
  });

  // Single filter: prefix in-leg so LIMIT applies to the narrowed set.
  // Multi-filter: INTERSECT first, then prefix/limit on the intersection.
  let sql: string;
  if (entries.length === 1) {
    sql = legs[0]!;
    if (opts.prefix) {
      sql += ` AND ${PREFIX_FILTER_SQL}`;
      params.push(opts.prefix, opts.prefix);
    }
  } else {
    sql = `SELECT object_key FROM (${legs.join(" INTERSECT ")})`;
    if (opts.prefix) {
      sql += ` WHERE ${PREFIX_FILTER_SQL}`;
      params.push(opts.prefix, opts.prefix);
    }
  }
  // Wrap after the prefix so the exclusion covers both forms. The derived set
  // only has `object_key`, so the NOT EXISTS binds the workspace explicitly.
  if (opts.collapsePromotedShadows) {
    sql = `SELECT object_key FROM (${sql}) AS f
           WHERE NOT EXISTS (
             SELECT 1 FROM file_metadata s
             WHERE s.workspace = ? AND s.object_key = f.object_key
               AND ${PROMOTED_SHADOW_STATUS_SQL}
           )`;
    params.push(workspace);
  }
  // Keyset continuation wraps last so it applies uniformly to the single-leg,
  // INTERSECT, and collapse-wrapped forms.
  if (opts.after !== undefined) {
    sql = `SELECT object_key FROM (${sql}) AS page WHERE object_key > ?`;
    params.push(opts.after);
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
 * Excludes server-owned namespaces from facets: they aren't client-settable,
 * so they'd be filters a user can't reproduce. Literal NOT LIKE legs to save
 * D1 bind params.
 */
const EXCLUDE_SERVER_KEYS = SERVER_META_PREFIXES.map(
  (prefix) => ` AND meta_key NOT LIKE '${prefix}%'`,
).join("");

/**
 * Distinct metadata keys with file and value counts. `distinctValues` tells a
 * useful facet from an effectively unique one. Fetches one row past the cap
 * so `truncated` is exact.
 */
export async function facetKeys(
  db: D1Queryable,
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

/** Distinct values for one key, most common first. Fetched lazily per key. */
export async function facetValues(
  db: D1Queryable,
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
/** Recent keys per catalog entry; shorter than a group's strip. */
export const BY_PATH_CATALOG_RECENT_LIMIT = 3;
/**
 * Max unique (project, path) pairs in the screenshots catalog. Larger than
 * the thumbed-group cap so the filter bar can still name older paths.
 */
export const BY_PATH_CATALOG_LIMIT = 500;
/** Newest keys returned in the flat `latest` feed alongside the groups. */
export const BY_PATH_LATEST_LIMIT = 30;
/**
 * How far back section headings count files. The scan still returns older
 * paths and thumbs; only the number on each heading uses this window.
 */
export const BY_PATH_COUNT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * Display cap for section file counts. Count one past this so the UI can
 * render "100+" instead of a number that matches the list page size.
 */
export const BY_PATH_COUNT_DISPLAY_CAP = 100;

/** Increment `count` up to cap+1; the extra 1 is the "at least 101" signal. */
function bumpDisplayCount(entry: { count: number }): void {
  if (entry.count <= BY_PATH_COUNT_DISPLAY_CAP) entry.count += 1;
}

function inCountWindow(iso: string, nowMs: number): boolean {
  const ts = Date.parse(iso);
  return !Number.isNaN(ts) && ts >= nowMs - BY_PATH_COUNT_WINDOW_MS;
}

export type PathGroup = {
  project: string;
  /** The `path` value, or the `screen` value when `by` is "screen". */
  path: string;
  /** Set when the group is a `screen` name (an app view with no `path`). */
  by?: "screen";
  count: number;
  lastUpdated: string;
  recent: string[];
};

/**
 * Unique (project, path) — same fields as a group, with a shorter thumb strip
 * (BY_PATH_CATALOG_RECENT_LIMIT keys).
 */
export type PathCatalogEntry = PathGroup;

/** One entry in the flat newest-first feed (the "Recent" view). */
export type LatestPathObject = {
  key: string;
  project: string;
  path: string;
  by?: "screen";
  uploadedAt: string;
};

export type ProjectSummary = { label: string; count: number; lastUpdated: string };

/**
 * Recent uploads grouped by (project, path), the screenshots page's one
 * query. Groups come newest-active first with their newest keys and counts.
 * `catalog` has the same pairs (more of them, shorter strips) so the page can
 * filter and render thumbs without per-group follow-ups; `projects`
 * summarizes it by project label.
 *
 * One scan of the `path` rows with project-label keys pulled by correlated
 * subselects; grouping happens in JS because the project label is a
 * coalesce. Promoted branch originals are excluded (their pull copy is
 * listed). `mergedOnly`, `type` and `surface` filter the one query, so every
 * output reflects them.
 *
 * Files with a `screen` and no `path` group by screen name (`by: "screen"`).
 *
 * Section `count` covers BY_PATH_COUNT_WINDOW_MS, capped at
 * BY_PATH_COUNT_DISPLAY_CAP + 1 ("100+"); a group with nothing in the window
 * shows its capped all-time total.
 */
export async function groupObjectsByPath(
  db: D1Queryable,
  workspace: string,
  opts: {
    mergedOnly?: boolean;
    now?: Date;
    type?: FileTypeClass;
    surface?: FileSurface;
    /** ISO lower bound on upload time (`?since=`). */
    since?: string;
  } = {},
): Promise<{
  groups: PathGroup[];
  catalog: PathCatalogEntry[];
  projects: ProjectSummary[];
  latest: LatestPathObject[];
  truncated: boolean;
  catalogTruncated: boolean;
}> {
  const mergedFilterSql = opts.mergedOnly
    ? `AND EXISTS (
           SELECT 1 FROM file_metadata s2
           WHERE s2.workspace = p.workspace AND s2.object_key = p.object_key
             AND ${MERGED_STATUS_SQL}
         )`
    : "";
  // Signed-in only. Applies to every output of the one query.
  const typeFilterSql = opts.type ? `AND ${fileTypeSql("p.object_key", opts.type)}` : "";
  const surfaceFilterSql = opts.surface ? `AND ${fileSurfaceSql("p", opts.surface)}` : "";
  // Checked before the per-row subqueries, so a short window also skips their reads.
  const sinceFilterSql = opts.since ? `AND p.updated_at >= ?` : "";
  const result = await db
    .prepare(
      `SELECT p.meta_value AS path, p.meta_key AS group_by, p.object_key AS object_key, p.updated_at AS updated_at,
              (SELECT meta_value FROM file_metadata m WHERE m.workspace = p.workspace AND m.object_key = p.object_key AND m.meta_key = 'repo') AS repo,
              (SELECT meta_value FROM file_metadata m WHERE m.workspace = p.workspace AND m.object_key = p.object_key AND m.meta_key = 'gh.repo') AS gh_repo,
              (SELECT meta_value FROM file_metadata m WHERE m.workspace = p.workspace AND m.object_key = p.object_key AND m.meta_key = 'url') AS url,
              (SELECT meta_value FROM file_metadata m WHERE m.workspace = p.workspace AND m.object_key = p.object_key AND m.meta_key = 'app') AS app
       FROM file_metadata p
       WHERE p.workspace = ? AND p.meta_key IN ('path', 'screen')
         ${sinceFilterSql}
         AND (p.meta_key = 'path' OR NOT EXISTS (
           SELECT 1 FROM file_metadata pp
           WHERE pp.workspace = p.workspace AND pp.object_key = p.object_key
             AND pp.meta_key = 'path'
         ))
         AND NOT EXISTS (
           SELECT 1 FROM file_metadata s
           WHERE s.workspace = p.workspace AND s.object_key = p.object_key
             AND ${PROMOTED_SHADOW_STATUS_SQL}
         )
         ${mergedFilterSql}
         ${typeFilterSql}
         ${surfaceFilterSql}
       ORDER BY p.updated_at DESC, p.object_key ASC`,
    )
    .bind(...(opts.since ? [workspace, opts.since] : [workspace]))
    .all<{
      path: string;
      group_by: string;
      object_key: string;
      updated_at: string;
      repo: string | null;
      gh_repo: string | null;
      url: string | null;
      app: string | null;
    }>();

  const nowMs = (opts.now ?? new Date()).getTime();
  const groups: PathGroup[] = [];
  const byKey = new Map<string, PathGroup>();
  const catalog: PathCatalogEntry[] = [];
  const catalogByKey = new Map<string, PathCatalogEntry>();
  const projectByLabel = new Map<string, ProjectSummary>();
  const allTime = new Map<object, number>();
  const latest: LatestPathObject[] = [];
  let truncated = false;
  let catalogTruncated = false;

  const bump = (entry: { count: number }, updatedAt: string) => {
    allTime.set(entry, (allTime.get(entry) ?? 0) + 1);
    if (inCountWindow(updatedAt, nowMs)) bumpDisplayCount(entry);
  };
  const applyCountFallback = (entry: { count: number }) => {
    if (entry.count > 0) return;
    const total = allTime.get(entry) ?? 0;
    entry.count = Math.min(total, BY_PATH_COUNT_DISPLAY_CAP + 1);
  };

  for (const row of result.results) {
    const project = projectLabelFromMeta({
      repo: row.repo,
      ghRepo: row.gh_repo,
      url: row.url,
      app: row.app,
    });
    const by = row.group_by === "screen" ? ({ by: "screen" } as const) : {};
    const groupKey = `${project}\0${row.group_by}\0${row.path}`;

    // Rows arrive newest-first, so the first N are the flat recent feed.
    if (latest.length < BY_PATH_LATEST_LIMIT) {
      latest.push({
        key: row.object_key,
        project,
        path: row.path,
        ...by,
        uploadedAt: row.updated_at,
      });
    }

    let entry = catalogByKey.get(groupKey);
    if (!entry) {
      if (catalog.length === BY_PATH_CATALOG_LIMIT) {
        catalogTruncated = true;
      } else {
        entry = {
          project,
          path: row.path,
          ...by,
          count: 0,
          lastUpdated: row.updated_at,
          recent: [],
        };
        catalogByKey.set(groupKey, entry);
        catalog.push(entry);
      }
    }
    if (entry) {
      bump(entry, row.updated_at);
      if (entry.recent.length < BY_PATH_CATALOG_RECENT_LIMIT) entry.recent.push(row.object_key);
      if (!projectByLabel.has(project)) {
        projectByLabel.set(project, {
          label: project,
          count: 0,
          lastUpdated: row.updated_at,
        });
      }
    }
    const summary = projectByLabel.get(project);
    if (summary) bump(summary, row.updated_at);

    let group = byKey.get(groupKey);
    if (!group) {
      if (groups.length === BY_PATH_GROUP_LIMIT) {
        truncated = true;
        continue; // existing groups keep counting; new ones are dropped
      }
      group = {
        project,
        path: row.path,
        ...by,
        count: 0,
        lastUpdated: row.updated_at,
        recent: [],
      };
      byKey.set(groupKey, group);
      groups.push(group);
    }
    bump(group, row.updated_at);
    if (group.recent.length < BY_PATH_RECENT_LIMIT) group.recent.push(row.object_key);
  }

  for (const entry of catalog) applyCountFallback(entry);
  for (const group of groups) applyCountFallback(group);
  for (const summary of projectByLabel.values()) applyCountFallback(summary);
  const projects = [...projectByLabel.values()].sort((a, b) =>
    b.lastUpdated.localeCompare(a.lastUpdated),
  );
  return { groups, catalog, projects, latest, truncated, catalogTruncated };
}

/**
 * Project label for the screenshots page: repo, gh.repo, url origin, app,
 * else "Other". Local origins never label a group (the host names a dev
 * server, not an app), so they fall through to `app` or "local dev".
 * Mirrored by apps/web/src/lib/workspace-screenshots.ts.
 */
export function projectLabelFromMeta(meta: {
  repo?: string | null;
  ghRepo?: string | null;
  url?: string | null;
  app?: string | null;
}): string {
  if (meta.repo) return meta.repo;
  if (meta.ghRepo) return meta.ghRepo;
  let localOrigin = false;
  if (meta.url) {
    try {
      const parsed = new URL(meta.url);
      if (isLocalHostname(parsed.hostname)) localOrigin = true;
      else if (parsed.host) return parsed.host;
    } catch {
      // An unparseable url is just "no url".
    }
  }
  if (meta.app) return meta.app;
  return localOrigin ? "local dev" : "Other";
}

/** Hosts that identify a dev machine, not an app: any port counts the same. */
export function isLocalHostname(hostname: string): boolean {
  const bare = hostname.toLowerCase();
  return (
    bare === "localhost" ||
    bare.endsWith(".localhost") ||
    bare === "127.0.0.1" ||
    bare === "0.0.0.0" ||
    bare === "[::1]"
  );
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
 * Facet discovery shared by the token and session routes and the hosted MCP.
 * No `key` lists keys; with `key`, that key's values.
 */
export async function listFacets(
  db: D1Queryable,
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

/**
 * D1 rejects more than 100 bound parameters per query (not SQLite's ~999).
 * The test fake enforces the same ceiling.
 */
export const D1_MAX_BOUND_PARAMS = 100;

/**
 * Max keys per `object_key IN (...)` given the statement's other params.
 * At least 1, so an outsized prefix can't loop forever.
 */
function metadataLookupChunk(reservedParams: number): number {
  return Math.max(1, D1_MAX_BOUND_PARAMS - reservedParams);
}

/**
 * Batched lookup of whatever metadata each key has (no value filter). Keys
 * with no rows are absent from the map.
 *
 * `opts.metaKeys` narrows to named keys and keeps reads on the primary-key
 * index; prefer it on hot paths. An empty array means no filter.
 */
export async function getMetadataForKeys(
  db: D1Queryable,
  workspace: string,
  keys: string[],
  opts: { metaKeys?: string[] } = {},
): Promise<Map<string, Record<string, string>>> {
  const out = new Map<string, Record<string, string>>();
  if (keys.length === 0) return out;

  const metaKeys = opts.metaKeys?.length ? opts.metaKeys : undefined;
  const metaFilter = metaKeys ? ` AND meta_key IN (${metaKeys.map(() => "?").join(", ")})` : "";

  // The workspace bind plus one per meta key ride along with every chunk.
  const chunkSize = metadataLookupChunk(1 + (metaKeys?.length ?? 0));
  for (let i = 0; i < keys.length; i += chunkSize) {
    const chunk = keys.slice(i, i + chunkSize);
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
 * Newest `updated_at` per object key, a stand-in for when the object was
 * last written (screenshots write all metadata at once). Keys with no rows
 * are absent.
 */
export async function getObjectUpdatedAt(
  db: D1Queryable,
  workspace: string,
  keys: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (keys.length === 0) return out;

  const chunkSize = metadataLookupChunk(1); // workspace bind rides along
  for (let i = 0; i < keys.length; i += chunkSize) {
    const chunk = keys.slice(i, i + chunkSize);
    const placeholders = chunk.map(() => "?").join(", ");
    const result = await db
      .prepare(
        `SELECT object_key, MAX(updated_at) AS updated_at FROM file_metadata
         WHERE workspace = ? AND object_key IN (${placeholders})
         GROUP BY object_key`,
      )
      .bind(workspace, ...chunk)
      .all<{ object_key: string; updated_at: string }>();
    for (const row of result.results) out.set(row.object_key, row.updated_at);
  }

  return out;
}

/**
 * Upsert server-owned metadata without touching other rows. Not
 * `replaceFileMetadata`, which runs earlier on the upload path and would
 * wipe the request's own metadata.
 */
export async function setServerFileMetadata(
  db: D1Queryable,
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
  db: D1Queryable,
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
