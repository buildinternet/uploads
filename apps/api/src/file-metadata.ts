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
import { type D1Queryable } from "./db-session";

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
 * output. `image.*` (issue #365 follow-up) carries the server-detected pixel
 * dimensions the managed comment sizes embeds with — same spoofable-input
 * rationale. Reserved as *prefixes* rather than exact keys so future derived
 * facts can't collide.
 */
export const SERVER_META_PREFIXES = ["video.", "image."] as const;

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

/**
 * Prepared upsert statements for `entries`, one `INSERT ... ON CONFLICT DO
 * UPDATE` per key/value pair. Shared by `setFileMetadata`,
 * `replaceFileMetadata`, and `setServerFileMetadata` so the SQL lives in
 * exactly one place; does not change SQL semantics for any of them.
 */
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
  db: D1Queryable,
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
 * Targeted single-key value update. Exists because `replaceFileMetadata` is
 * delete-then-insert over the whole key set and would wipe server-owned
 * `video.*` rows — never use replace to flip one flag. Used by the GitHub
 * attachment ingest reconciler to stamp `gh.detached` without disturbing any
 * other row. No-op (no row created) if the key isn't already present.
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
    .bind(value, new Date().toISOString(), workspace, objectKey, metaKey)
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

/**
 * Deletes all metadata rows for a set of objects in one pass (e.g. the
 * retention purge's delete batches). Chunked like `getMetadataForKeys` to
 * stay under D1's bound-parameter limit. No-op on an empty list.
 */
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

/**
 * Fully replaces an object's metadata: validates `metadata` once (there's no
 * prior state to merge against, so unlike `setFileMetadata` there's nothing
 * to re-read first), then deletes any existing rows and inserts the new set
 * in a single `db.batch` — atomic, and without the wasted
 * guaranteed-empty-map SELECT that `deleteFileMetadata` + `setFileMetadata`
 * would otherwise incur. Used by `putObject`'s full-replace-on-upload path.
 */
export async function replaceFileMetadata(
  db: D1Queryable,
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
 * Prefix filter as a plain substring equality, NOT `LIKE ? || '%'`: D1 caps
 * LIKE/GLOB patterns at 50 bytes, and real prefixes exceed that — a
 * `gh/private/<32-hex>/pull/<n>/` attachment prefix is ~54 bytes and made
 * every counterpart lookup (and with it the whole public file page) throw
 * `D1_ERROR: LIKE or GLOB pattern too complex`. substr has no such cap and
 * needs no wildcard escaping (`_`/`%` in the prefix stay literal). Binds the
 * prefix twice: once for `length(?)`, once for the comparison.
 */
const PREFIX_FILTER_SQL = `substr(object_key, 1, length(?)) = ?`;

/**
 * Predicate matching a branch-staged screenshot that has been promoted
 * (`gh.status=promoted`). Promotion copies such a shot to a canonical
 * `pull/<n>/` key — which inherits its `path`/`state` via content-hash
 * inheritance — and never deletes the branch original, so a promoted shot
 * carries the same `path` under both keys. The screenshots surfaces collapse
 * the branch original (`groupObjectsByPath`, and the opt-in `collapsePromotedShadows`
 * search below) so it isn't listed twice. General metadata search leaves it
 * in — `find_files({ "gh.status": "promoted" })` must still return it. Written
 * against a subquery alias `s`; the caller supplies how to reach the outer row.
 */
const PROMOTED_SHADOW_STATUS_SQL = `s.meta_key = 'gh.status' AND s.meta_value = 'promoted'`;

/**
 * Predicate matching an object stamped `gh.merged=true` — written by
 * github-webhook.ts's `pull_request` `closed` handling when the PR's
 * `merged` field is true. A merge is a terminal, durable fact (unlike
 * open/closed, which stay transient and are already resolved live by the KV
 * title cache in github-titles.ts), so `gh.merged` is the only PR
 * lifecycle fact this codebase persists as metadata — there is deliberately
 * no `gh.pr-state` key that would imply the full lifecycle is tracked.
 * Mirrors `PROMOTED_SHADOW_STATUS_SQL`'s shape but as an EXISTS (not NOT
 * EXISTS) predicate; written against a subquery alias `s2` (distinct from
 * `PROMOTED_SHADOW_STATUS_SQL`'s `s` so both can be composed in one query,
 * as `groupObjectsByPath`'s opt-in `mergedOnly` filter does) — the caller
 * supplies how to reach the outer row.
 */
const MERGED_STATUS_SQL = `s2.meta_key = 'gh.merged' AND s2.meta_value = 'true'`;

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
 *
 * `collapsePromotedShadows` (opt-in, off by default) drops promoted branch
 * originals (`PROMOTED_SHADOW_STATUS_SQL`) so the screenshots drill-in doesn't
 * show a shot twice; general search keeps them.
 *
 * `after` is a keyset continuation: rows are already ordered by `object_key`,
 * so resuming at `object_key > :after` skips the consumed window without an
 * OFFSET scan and stays stable when objects are added or removed between
 * pages (issue #829 §4).
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
  // Wrap once (after prefix, before ORDER BY/LIMIT) so the exclusion applies to
  // both the single-leg and INTERSECT forms. The derived set projects only
  // `object_key`, so the correlated NOT EXISTS binds the workspace explicitly.
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

/**
 * Distinct values for one metadata key, most common first. Fetched lazily by
 * the UI when a key is selected, so a workspace with forty keys costs one
 * grouped query on open rather than forty.
 *
 * Rides the same index as an exact prefix seek (workspace + meta_key), so
 * rows-read is proportional to the one key rather than the whole workspace.
 */
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
/**
 * Recent object keys returned per catalog entry — a shorter strip than the
 * groups', so every path can render thumbs without the page fetching one
 * search per group.
 */
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
  path: string;
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
  uploadedAt: string;
};

export type ProjectSummary = { label: string; count: number; lastUpdated: string };

/**
 * Recent uploads grouped by (project, path) — the screenshots page's one
 * query (spec: docs/superpowers/specs/2026-08-11-screenshots-project-grouping-design.md).
 * Groups come back most-recently-active first, each carrying its newest
 * BY_PATH_RECENT_LIMIT keys and total count. `catalog` is the same unique
 * pairs, up to BY_PATH_CATALOG_LIMIT, with a shorter
 * BY_PATH_CATALOG_RECENT_LIMIT strip — so the page can filter by path AND
 * render thumbs for every group off this one query, with no per-group
 * follow-up search. `projects` summarizes the catalog by project label,
 * most-recent first.
 *
 * One flat scan of the `path` rows (seeked via `file_metadata_lookup_idx
 * (workspace, meta_key, meta_value)`), with the three project-label keys
 * pulled per object via correlated subselects on the same (workspace,
 * object_key) index. Rows-read still scales with path-tagged files, not the
 * whole metadata table. Grouping/windowing moves to JS because the group key
 * (project label) is a coalesce SQL can't express cleanly — rows arrive
 * newest-first, so first-seen order is the recency order.
 *
 * A branch-staged original that has been promoted (`gh.status=promoted`) is
 * excluded: promotion copies it to the canonical `pull/<n>/` key (which
 * inherits its `path`/`state` via content-hash inheritance), and the promoted
 * original is never deleted, so without this filter every promoted shot would
 * show twice — once from `branch/<b>/` and once from `pull/<n>/`. Still-staged
 * (`gh.status=staged`) branch shots have no pull twin yet and are kept.
 *
 * `opts.mergedOnly` (opt-in, off by default — issue "persisted PR merge-state
 * tagging") adds an EXISTS counterpart to the NOT EXISTS promoted-shadow
 * clause above, keeping only objects stamped `gh.merged=true`
 * (`MERGED_STATUS_SQL`). Applies to the single underlying query, so `groups`,
 * `catalog`, `projects`, and `latest` all reflect the same filtered rows.
 *
 * Section `count` is files in the last BY_PATH_COUNT_WINDOW_MS, capped at
 * BY_PATH_COUNT_DISPLAY_CAP + 1 so the overview can say "100+" instead of
 * echoing the list page size. A group with nothing in the window falls
 * back to its capped all-time total rather than "0 files". `opts.now` is
 * the window's right edge; tests freeze it.
 */
export async function groupObjectsByPath(
  db: D1Queryable,
  workspace: string,
  opts: { mergedOnly?: boolean; now?: Date } = {},
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
  const result = await db
    .prepare(
      `SELECT p.meta_value AS path, p.object_key AS object_key, p.updated_at AS updated_at,
              (SELECT meta_value FROM file_metadata m WHERE m.workspace = p.workspace AND m.object_key = p.object_key AND m.meta_key = 'repo') AS repo,
              (SELECT meta_value FROM file_metadata m WHERE m.workspace = p.workspace AND m.object_key = p.object_key AND m.meta_key = 'gh.repo') AS gh_repo,
              (SELECT meta_value FROM file_metadata m WHERE m.workspace = p.workspace AND m.object_key = p.object_key AND m.meta_key = 'url') AS url,
              (SELECT meta_value FROM file_metadata m WHERE m.workspace = p.workspace AND m.object_key = p.object_key AND m.meta_key = 'app') AS app
       FROM file_metadata p
       WHERE p.workspace = ? AND p.meta_key = 'path'
         AND NOT EXISTS (
           SELECT 1 FROM file_metadata s
           WHERE s.workspace = p.workspace AND s.object_key = p.object_key
             AND ${PROMOTED_SHADOW_STATUS_SQL}
         )
         ${mergedFilterSql}
       ORDER BY p.updated_at DESC, p.object_key ASC`,
    )
    .bind(workspace)
    .all<{
      path: string;
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
    const groupKey = `${project}\0${row.path}`;

    // Rows arrive newest-first, so the first N are the flat recent feed.
    if (latest.length < BY_PATH_LATEST_LIMIT) {
      latest.push({ key: row.object_key, project, path: row.path, uploadedAt: row.updated_at });
    }

    let entry = catalogByKey.get(groupKey);
    if (!entry) {
      if (catalog.length === BY_PATH_CATALOG_LIMIT) {
        catalogTruncated = true;
      } else {
        entry = { project, path: row.path, count: 0, lastUpdated: row.updated_at, recent: [] };
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
      group = { project, path: row.path, count: 0, lastUpdated: row.updated_at, recent: [] };
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
 * Project label for the screenshots page (spec:
 * docs/superpowers/specs/2026-08-11-screenshots-project-grouping-design.md).
 * Coalesces repo → gh.repo → url origin → app → "Other". Local origins
 * (localhost and friends) never label a group by host — the host says which
 * dev server was up, not which app it was (#692) — so they fall through to
 * `app` metadata, else a shared "local dev" bucket. Display/grouping only —
 * never stored. Mirrored (with identical cases) by
 * apps/web/src/lib/workspace-screenshots.ts.
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
      // fall through — an unparseable url is just "no url"
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
 * Facet discovery shared by token `/files/facets`, session `/me/.../files/facets`,
 * and hosted MCP `list_metadata_keys`. No `key` → workspace key list; with
 * `key` → that key's values (validated against `META_KEY_RE`).
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
 * D1's hard cap on bound parameters per query. Not SQLite's ~999 host-parameter
 * limit — D1 rejects anything over 100 with "too many SQL variables", which is
 * how the screenshots by-path route came to 500 in production once a workspace
 * had enough path groups to send 100 keys plus the workspace and meta-key binds.
 * The test fake (test/helpers/sqlite-d1.ts) enforces the same ceiling.
 */
export const D1_MAX_BOUND_PARAMS = 100;

/**
 * Max object keys bound into one `object_key IN (...)` statement, given how
 * many parameters the rest of the statement already spends. Always at least 1,
 * so a caller with an outsized fixed prefix chunks slowly rather than looping
 * forever on an empty slice.
 */
function metadataLookupChunk(reservedParams: number): number {
  return Math.max(1, D1_MAX_BOUND_PARAMS - reservedParams);
}

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
 * Newest `updated_at` per object key (its `MAX(updated_at)` across all metadata
 * rows) — a stand-in for "when this object was last written". A screenshot
 * writes all its metadata in one shot at capture (and promotion rewrites its
 * `path`/`state`/`gh.*` rows together), so this matches the `path`-row time the
 * by-path `latest` feed already reports as `uploadedAt`. Keys with no metadata
 * rows are simply absent. Chunked like `getMetadataForKeys` to stay under D1's
 * bound-parameter limit.
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
 * Upsert server-owned metadata (`video.*`) without touching user rows.
 * Deliberately not `replaceFileMetadata`: that is delete-then-insert, and this
 * runs *after* it on the upload path — a full replace here would wipe the
 * request's own custom metadata.
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
