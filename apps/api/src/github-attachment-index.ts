/**
 * Server-written index of PR/issue attachments (`github_attachments` D1
 * table, issue #934). One row per attachment object, keyed by
 * (workspace, object_key).
 *
 * TRUST BOUNDARY: every row is derived from the FINAL OBJECT KEY plus a
 * server-resolved repo — never from `gh.*` file_metadata, which is
 * client-settable (see file-metadata.ts). A writer that shortcut to
 * `opts.metadata["gh.ref"]` would let any files:write token stamp one row
 * and have an arbitrary object rendered in a public PR comment. The repo
 * comes from the key's own owner/name segments (plain keys) or from the
 * `github_private_prefixes` row that minted the prefix id (private keys) —
 * a prefix id is minted server-side for exactly one repo, so that lookup is
 * authoritative.
 *
 * Phase 1 is write-only: nothing reads this table yet.
 */
import { GH_PRIVATE_ROOT, parseGhPrivateKey } from "@uploads/comment-render";
import { type D1Queryable } from "./db-session";
import { D1_MAX_BOUND_PARAMS } from "./file-metadata";
import { normalizeRepo, repoForPrefixId } from "./github-private-prefixes";

/** Which server-side path wrote (or last updated) an index row. */
export type AttachmentSource = "put" | "attach" | "promote" | "adopt" | "backfill" | "reconcile";

export interface ParsedAttachmentKey {
  kind: "pull" | "issues";
  num: number;
  /** 32-hex private prefix id, or null for a plain `gh/<owner>/<name>/…` key. */
  prefixId: string | null;
  /**
   * Lowercased owner/name recovered from a plain key, or null for a private
   * key (which deliberately omits the repo). NOTE: the key's segments are
   * the SANITIZED spelling (`sanitizeKeySegment`), which is lossy — a caller
   * that knows the real repo should pass it rather than trust this.
   */
  repo: string | null;
}

/** `gh/<owner>/<name>/<pull|issues>/<num>/<filename>` — the plain layout built by `ghKeyPrefix`. */
const PLAIN_ATTACHMENT_RE = /^gh\/([^/]+)\/([^/]+)\/(pull|issues)\/([1-9][0-9]*)\/(.+)$/;

/**
 * Parses an attachment key back into its target coordinates, or undefined
 * for any key that is not a managed attachment.
 *
 * Deliberately undefined for GitHub-native INGEST keys
 * (`gh/<owner>-<name>/<kind>-<num>/…` and
 * `gh/private/<id>/ingest/<kind>-<num>/…`, see github-ingest.ts): ingested
 * assets are an index only and live outside the comment's prefix on
 * purpose. Also undefined for branch-staged keys
 * (`gh/<owner>/<name>/branch/<branch>/…`, `gh/private/<id>/branch/…`),
 * which are not attachments until promoted.
 */
export function parseAttachmentKey(key: string): ParsedAttachmentKey | undefined {
  if (key.startsWith(GH_PRIVATE_ROOT)) {
    const parsed = parseGhPrivateKey(key);
    if (parsed) {
      return { kind: parsed.kind, num: parsed.num, prefixId: parsed.prefixId, repo: null };
    }
    // Not a real private key (e.g. the 32-hex id slot didn't match) — fall
    // through to the plain parse, since `private` is a legal GitHub owner
    // login and `gh/private/web/...` is that owner's plain-key shape, not a
    // malformed private key.
  }
  const match = PLAIN_ATTACHMENT_RE.exec(key);
  if (!match) return undefined;
  const [, owner, name, kind, num] = match;
  return {
    kind: kind as "pull" | "issues",
    num: Number(num),
    prefixId: null,
    repo: `${owner}/${name}`.toLowerCase(),
  };
}

export interface AttachmentIndexRow {
  workspace: string;
  repo: string;
  kind: "pull" | "issues";
  num: number;
  objectKey: string;
  prefixId: string | null;
  laneId: string | null;
  source: AttachmentSource;
  createdAt: string;
  updatedAt: string;
  detachedAt: string | null;
}

interface AttachmentDbRow {
  workspace: string;
  repo: string;
  kind: "pull" | "issues";
  num: number;
  object_key: string;
  prefix_id: string | null;
  lane_id: string | null;
  source: AttachmentSource;
  created_at: string;
  updated_at: string;
  detached_at: string | null;
}

const SELECT_COLUMNS =
  "workspace, repo, kind, num, object_key, prefix_id, lane_id, source, created_at, updated_at, detached_at";

/**
 * Every `github_attachments` statement this module issues, in one place.
 * The route/webhook tests' in-memory stand-in
 * (test/helpers/fake-attachment-index-table.ts) matches on these exact
 * strings rather than on re-typed copies, so a reworded statement can never
 * silently desync the fake into dropping writes.
 */
export const ATTACHMENT_INDEX_SQL = {
  upsert: `INSERT INTO github_attachments
         (workspace, repo, kind, num, object_key, prefix_id, lane_id, source, created_at, updated_at, detached_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT(workspace, object_key) DO UPDATE SET
         repo = excluded.repo,
         kind = excluded.kind,
         num = excluded.num,
         prefix_id = excluded.prefix_id,
         lane_id = excluded.lane_id,
         source = excluded.source,
         updated_at = excluded.updated_at,
         detached_at = CASE WHEN excluded.source = 'put' THEN github_attachments.detached_at ELSE NULL END`,
  listForTarget: `SELECT ${SELECT_COLUMNS} FROM github_attachments
       WHERE workspace = ? AND repo = ? AND kind = ? AND num = ? AND detached_at IS NULL
       ORDER BY object_key`,
  selectOne: `SELECT ${SELECT_COLUMNS} FROM github_attachments
       WHERE workspace = ? AND object_key = ?`,
  detach: `UPDATE github_attachments SET detached_at = ?, updated_at = ?
       WHERE workspace = ? AND object_key = ?`,
  reattach: `UPDATE github_attachments SET detached_at = NULL, updated_at = ?
       WHERE workspace = ? AND object_key = ?`,
  rekey: `UPDATE github_attachments SET object_key = ?, prefix_id = ?, lane_id = ?, updated_at = ?
       WHERE workspace = ? AND object_key = ?`,
  deleteOne: `DELETE FROM github_attachments WHERE workspace = ? AND object_key = ?`,
  /** `placeholders` is the comma-joined `?` list for one chunk of keys. */
  deleteForKeys: (placeholders: string) =>
    `${ATTACHMENT_INDEX_SQL.deleteForKeysPrefix}${placeholders})`,
  /** The invariant head of `deleteForKeys`, for matchers that can't know the chunk size. */
  deleteForKeysPrefix: `DELETE FROM github_attachments WHERE workspace = ? AND object_key IN (`,
  deleteForWorkspace: `DELETE FROM github_attachments WHERE workspace = ?`,
} as const;

function fromRow(row: AttachmentDbRow): AttachmentIndexRow {
  return {
    workspace: row.workspace,
    repo: row.repo,
    kind: row.kind,
    num: row.num,
    objectKey: row.object_key,
    prefixId: row.prefix_id,
    laneId: row.lane_id,
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    detachedAt: row.detached_at,
  };
}

/**
 * Upserts one attachment row. `ON CONFLICT(workspace, object_key)` makes a
 * re-put, a re-attach, and a webhook redelivery all converge on the same
 * row rather than duplicating; `created_at` is preserved. `detached_at` is
 * cleared for every source EXCEPT `"put"`: attaching, promoting, adopting,
 * backfilling, or reconciling a key IS a (re-)attachment and should
 * reappear in the comment, but `putObject`'s own best-effort index write
 * fires on every object write — including a plain re-upload of bytes at an
 * already-detached key (e.g. `gh.detached` metadata never round-trips
 * through `putObject`) — so a `"put"` alone must never resurrect a row the
 * caller deliberately detached.
 */
export async function recordAttachment(
  db: D1Queryable,
  row: Omit<AttachmentIndexRow, "createdAt" | "updatedAt" | "detachedAt">,
  now = new Date(),
): Promise<void> {
  const nowIso = now.toISOString();
  await db
    .prepare(ATTACHMENT_INDEX_SQL.upsert)
    .bind(
      row.workspace,
      normalizeRepo(row.repo),
      row.kind,
      row.num,
      row.objectKey,
      row.prefixId,
      row.laneId,
      row.source,
      nowIso,
      nowIso,
    )
    .run();
}

/**
 * The active (non-detached) rows for one PR/issue target, sorted by key —
 * the read the phase-3 render will switch to, served by
 * `github_attachments_target_idx`. Phase 2 runs it in the shadow of the R2
 * fan-out (see github-attachment-shadow.ts). `repo` is normalized the same
 * way the writers store it.
 */
export async function listAttachmentsForTarget(
  db: D1Queryable,
  workspace: string,
  repo: string,
  target: { kind: "pull" | "issues"; num: number },
): Promise<AttachmentIndexRow[]> {
  const { results } = await db
    .prepare(ATTACHMENT_INDEX_SQL.listForTarget)
    .bind(workspace, normalizeRepo(repo), target.kind, target.num)
    .all<AttachmentDbRow>();
  return (results ?? []).map(fromRow);
}

/** One index row, or null. Test/ops read helper — NOT the phase-3 hot read. */
export async function attachmentRow(
  db: D1Queryable,
  workspace: string,
  objectKey: string,
): Promise<AttachmentIndexRow | null> {
  const row = await db
    .prepare(ATTACHMENT_INDEX_SQL.selectOne)
    .bind(workspace, objectKey)
    .first<AttachmentDbRow>();
  return row ? fromRow(row) : null;
}

/**
 * Hides an attachment from the managed comment without deleting the object
 * or the row (issue #709's doctrine: detach means "removed from the
 * comment", never "deleted"). Mirrors the `gh.detached='true'` metadata
 * stamp the adopt path already writes.
 */
export async function detachAttachment(
  db: D1Queryable,
  workspace: string,
  objectKey: string,
  now = new Date(),
): Promise<void> {
  const nowIso = now.toISOString();
  await db.prepare(ATTACHMENT_INDEX_SQL.detach).bind(nowIso, nowIso, workspace, objectKey).run();
}

/** Inverse of `detachAttachment`: the link reappeared, so the row renders again. */
export async function reattachAttachment(
  db: D1Queryable,
  workspace: string,
  objectKey: string,
  now = new Date(),
): Promise<void> {
  await db
    .prepare(ATTACHMENT_INDEX_SQL.reattach)
    .bind(now.toISOString(), workspace, objectKey)
    .run();
}

/** Removes an object's index row (e.g. on object delete). */
export async function deleteAttachment(
  db: D1Queryable,
  workspace: string,
  objectKey: string,
): Promise<void> {
  await db.prepare(ATTACHMENT_INDEX_SQL.deleteOne).bind(workspace, objectKey).run();
}

/**
 * Removes index rows for a set of objects in one pass (the retention
 * purge's delete batches). Chunked to stay under D1's bound-parameter
 * limit, exactly like `deleteFileMetadataForKeys`. No-op on an empty list.
 */
export async function deleteAttachmentsForKeys(
  db: D1Queryable,
  workspace: string,
  keys: string[],
): Promise<void> {
  const chunkSize = Math.max(1, D1_MAX_BOUND_PARAMS - 1); // the workspace bind
  for (let i = 0; i < keys.length; i += chunkSize) {
    const chunk = keys.slice(i, i + chunkSize);
    const placeholders = chunk.map(() => "?").join(", ");
    await db
      .prepare(ATTACHMENT_INDEX_SQL.deleteForKeys(placeholders))
      .bind(workspace, ...chunk)
      .run();
  }
}

/** Removes every index row for a workspace being torn down. */
export async function deleteAttachmentsForWorkspace(
  db: D1Queryable,
  workspace: string,
): Promise<void> {
  await db.prepare(ATTACHMENT_INDEX_SQL.deleteForWorkspace).bind(workspace).run();
}

/**
 * Follows an object through a private-prefix rotation. Destination-first
 * wipe then UPDATE, mirroring how rotation re-keys `file_metadata`
 * (github-private-prefix-service.ts): rotation's own `putObject` at the new
 * key has already inserted a row there, and a second source id in the same
 * sweep can produce the same tail — either way the OLD row is the sole
 * source of truth for the new key, and a plain UPDATE onto an occupied
 * (workspace, object_key) would throw a UNIQUE constraint violation. Both
 * statements go in one `db.batch`, so the delete-then-update is atomic and
 * costs a single round trip.
 */
export async function rekeyAttachment(
  db: D1Queryable,
  workspace: string,
  fromKey: string,
  toKey: string,
  newPrefixId: string | null,
  laneId: string | null,
  now = new Date(),
): Promise<void> {
  await db.batch([
    db.prepare(ATTACHMENT_INDEX_SQL.deleteOne).bind(workspace, toKey),
    db
      .prepare(ATTACHMENT_INDEX_SQL.rekey)
      .bind(toKey, newPrefixId, laneId, now.toISOString(), workspace, fromKey),
  ]);
}

/**
 * Index writes are BEST-EFFORT, exactly like `recordUsageSafe` and
 * `recordPrActivityFromMetadata`: the object is already durably stored by
 * the time any of these runs, so a D1 failure must cost a stale index (which
 * the phase-2 shadow diff and the reconcile job repair) rather than a failed
 * upload.
 */
async function safely(message: string, context: Record<string, unknown>, run: () => Promise<void>) {
  try {
    await run();
  } catch (err) {
    console.error(
      JSON.stringify({
        message,
        ...context,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}

/**
 * Wraps one of the writers above in `safely`, logging with `message` on
 * failure. The log's `args` context mirrors what each hand-written wrapper
 * used to log by name — an array argument (a key list) collapses to its
 * length rather than dumping every key.
 */
function safeWriter<A extends unknown[]>(
  message: string,
  fn: (db: D1Queryable, ...args: A) => Promise<void>,
) {
  return (db: D1Queryable, ...args: A): Promise<void> =>
    safely(
      message,
      Object.fromEntries(args.map((a, i) => [i, Array.isArray(a) ? `${a.length} keys` : a])),
      () => fn(db, ...args),
    );
}

export const recordAttachmentSafe = safeWriter(
  "attachment index: record failed",
  (
    db: D1Queryable,
    row: Omit<AttachmentIndexRow, "createdAt" | "updatedAt" | "detachedAt">,
    now?: Date,
  ) => recordAttachment(db, row, now),
);

export const detachAttachmentSafe = safeWriter("attachment index: detach failed", detachAttachment);

export const reattachAttachmentSafe = safeWriter(
  "attachment index: reattach failed",
  reattachAttachment,
);

export const deleteAttachmentSafe = safeWriter("attachment index: delete failed", deleteAttachment);

export const deleteAttachmentsForKeysSafe = safeWriter(
  "attachment index: batch delete failed",
  deleteAttachmentsForKeys,
);

export const deleteAttachmentsForWorkspaceSafe = safeWriter(
  "attachment index: workspace delete failed",
  deleteAttachmentsForWorkspace,
);

export const rekeyAttachmentSafe = safeWriter("attachment index: rekey failed", rekeyAttachment);

/**
 * The one entry point every write path should use: parse the FINAL key,
 * resolve the repo server-side, upsert. Never throws.
 *
 * Repo resolution order, all server-side:
 *  1. `args.repo` — the caller already resolved the target (attach, promote,
 *     adopt know it from the request/webhook). Preferred, because a plain
 *     key's owner/name segments are the SANITIZED spelling, which is lossy.
 *  2. The plain key's own `gh/<owner>/<name>/…` segments.
 *  3. For a private key, the `github_private_prefixes` row that minted the
 *     id (`repoForPrefixId`) — a prefix id belongs to exactly one repo.
 *
 * `gh.repo`/`gh.ref` file_metadata is DELIBERATELY not consulted at any
 * step: it is client-settable, and trusting it would let any files:write
 * token pin an arbitrary object to someone else's PR comment.
 *
 * A key that parses but whose repo cannot be resolved (an orphaned private
 * prefix id) writes NO row — reconcile repairs it rather than this guessing.
 */
export async function recordAttachmentForKeySafe(
  db: D1Queryable,
  args: {
    workspace: string;
    objectKey: string;
    source: AttachmentSource;
    laneId: string | null;
    /** Server-resolved repo, when the caller already knows it. */
    repo?: string;
  },
  now = new Date(),
): Promise<void> {
  const parsed = parseAttachmentKey(args.objectKey);
  if (!parsed) return;
  await safely(
    "attachment index: record-for-key failed",
    { workspace: args.workspace, objectKey: args.objectKey },
    async () => {
      let repo = args.repo ?? parsed.repo;
      if (!repo && parsed.prefixId) {
        repo = await repoForPrefixId(db, parsed.prefixId);
      }
      if (!repo) return;
      await recordAttachment(
        db,
        {
          workspace: args.workspace,
          repo,
          kind: parsed.kind,
          num: parsed.num,
          objectKey: args.objectKey,
          prefixId: parsed.prefixId,
          laneId: args.laneId,
          source: args.source,
        },
        now,
      );
    },
  );
}
