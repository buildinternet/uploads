/**
 * Per-file queryable metadata (`file_metadata` D1 table).
 *
 * The queryable-tag tier for uploads.sh objects (see
 * `.context/2026-07-13-file-metadata-design.md`): capped, mutable key-value
 * pairs stored one row per pair, scoped by `(workspace, object_key)`. Distinct
 * from R2 custom metadata (`provenance.ts`), which stays unqueryable and
 * server/allowlist-controlled.
 */

import { ValidationError } from "@uploads/errors";

/** Lowercase key, optionally namespaced with dots (e.g. `gh.repo`). */
export const META_KEY_RE = /^[a-z][a-z0-9._-]{0,63}$/;

/** Cap applied both to a single write request and to a file's total keys post-merge. */
export const META_MAX_KEYS = 24;

/** Sum of key+value UTF-8 bytes, enforced per file (and, defensively, per request). */
export const META_MAX_TOTAL_BYTES = 8192;

/** Max value length in characters. */
export const META_VALUE_MAX = 512;

// Printable ASCII only — same rule as provenance.ts's VALUE_SAFE_RE.
const VALUE_SAFE_RE = /^[\x20-\x7E]+$/;

const encoder = new TextEncoder();

/**
 * Throws a `ValidationError` (AppError, type "validation") if `meta` violates
 * key format, value format/length, the per-map key-count cap, or the total
 * key+value byte cap. Callers use this both on the raw request payload and
 * on the post-merge map so a write can never silently exceed the caps.
 */
export function validateMetadataEntries(meta: Record<string, string>): void {
  const keys = Object.keys(meta);
  if (keys.length > META_MAX_KEYS) {
    throw new ValidationError(`metadata must have at most ${META_MAX_KEYS} keys.`, {
      code: "file_metadata_limit_exceeded",
      details: { limit: META_MAX_KEYS, count: keys.length },
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
  const result = await db
    .prepare(
      `SELECT meta_key, meta_value FROM file_metadata WHERE workspace = ? AND object_key = ?`,
    )
    .bind(workspace, objectKey)
    .all<MetaRow>();
  const metadata: Record<string, string> = {};
  for (const row of result.results) metadata[row.meta_key] = row.meta_value;
  return metadata;
}

/**
 * Merge `set` into the object's metadata and drop `remove` keys, enforcing
 * caps against the post-merge state. Rejects (no write) if the caps would be
 * violated; otherwise upserts/deletes atomically and returns the final map.
 * `remove` is applied before `set`, so a key present in both ends up set.
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

  const current = await getFileMetadata(db, workspace, objectKey);
  const next: Record<string, string> = { ...current };
  for (const key of remove) delete next[key];
  Object.assign(next, set);

  validateMetadataEntries(next);

  const now = new Date().toISOString();
  const statements = [];
  for (const [key, value] of Object.entries(set)) {
    statements.push(
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

const FIND_DEFAULT_LIMIT = 50;
const FIND_MAX_LIMIT = 500;

/**
 * Finds objects whose metadata matches ALL `filters` (ANDed equality), with
 * an optional key-prefix and result limit. Returns each match's key plus its
 * full metadata map (not just the matched pairs).
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

  const conditions = entries.map(() => `(meta_key = ? AND meta_value = ?)`).join(" OR ");
  const params: unknown[] = [workspace];
  for (const [key, value] of entries) params.push(key, value);

  let sql = `SELECT object_key FROM file_metadata WHERE workspace = ? AND (${conditions})`;
  if (opts.prefix) {
    sql += ` AND object_key LIKE ? || '%'`;
    params.push(opts.prefix);
  }
  sql += ` GROUP BY object_key HAVING COUNT(DISTINCT meta_key) = ? ORDER BY object_key LIMIT ?`;
  params.push(entries.length, limit);

  const matched = await db
    .prepare(sql)
    .bind(...params)
    .all<{ object_key: string }>();
  const keys = matched.results.map((row) => row.object_key);
  if (keys.length === 0) return [];

  const placeholders = keys.map(() => "?").join(", ");
  const hydrated = await db
    .prepare(
      `SELECT object_key, meta_key, meta_value FROM file_metadata
       WHERE workspace = ? AND object_key IN (${placeholders})`,
    )
    .bind(workspace, ...keys)
    .all<{ object_key: string; meta_key: string; meta_value: string }>();

  const byKey = new Map<string, Record<string, string>>(keys.map((key) => [key, {}]));
  for (const row of hydrated.results) {
    byKey.get(row.object_key)![row.meta_key] = row.meta_value;
  }
  return keys.map((key) => ({ key, metadata: byKey.get(key)! }));
}
