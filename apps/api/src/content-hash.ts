/**
 * Content-identical re-uploads inherit the earlier object's derived metadata
 * (issue #479).
 *
 * #469 closed the capture-then-attach seam two ways: `screenshot` now stages on
 * a branch (#475), and a sidecar manifest carries derived metadata into a later
 * `put`/`attach` of the same bytes (#473). Neither reaches a path where the
 * sidecar cannot exist — the hosted MCP has no local filesystem to write one,
 * and a CI step or second machine never sees it. This closes that remainder
 * server-side: when an upload's stored bytes match an object the workspace
 * already holds, the earlier object's derived tags are copied onto the new one.
 *
 * Design: `.context/479-content-hash-inheritance.md`.
 */

import { addMissingFileMetadata, getFileMetadata } from "./file-metadata";

/**
 * The closed set of keys inheritance may copy — a restatement of
 * `CANONICAL_META_KEYS` from `packages/uploads/src/metadata-vocab.ts`.
 *
 * Restated rather than imported, and deliberately so. The vocabulary lives in
 * `@buildinternet/uploads`, which is **published** and carries no `@uploads/*`
 * workspace dependencies — extracting the list to a shared private package
 * would make the published package
 * depend on a private one, and importing the CLI package here would invert the
 * dependency and drag CLI deps toward a Worker bundle. This follows the other
 * in-repo precedent instead: `packages/billing/src/workspace-cap.ts`, which
 * restates the shape it needs to keep its package independent.
 *
 * Drift is caught by a parity test (`content-hash-vocab-parity.test.ts`) that
 * imports the CLI list as a dev-only dependency and asserts the two agree.
 *
 * Note what is absent: `gh.*`. A repo/PR association is a claim about *this*
 * upload's context, not a property of the bytes, so it is not inheritable by
 * construction — which is also what keeps inherited metadata from minting
 * phantom PR activity through `recordPrActivityFromMetadata`.
 */
export const INHERITABLE_META_KEYS = [
  "url",
  "path",
  "env",
  "theme",
  "viewport",
  "device",
  "software",
  "captured",
  "state",
  "app",
] as const;

const INHERITABLE_KEY_SET: ReadonlySet<string> = new Set(INHERITABLE_META_KEYS);

interface HashRow {
  object_key: string;
}

/**
 * Record this object's stored-body hash, replacing any prior hash for the same
 * key (an overwrite changes the bytes a key points at).
 *
 * Never throws: the object is already durably stored by the time this runs, and
 * a missing index row costs a future inheritance, not correctness.
 */
export async function recordContentHash(
  db: D1Database,
  workspace: string,
  objectKey: string,
  contentSha256: string,
): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT INTO file_content_hash (workspace, object_key, content_sha256, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(workspace, object_key)
         DO UPDATE SET content_sha256 = excluded.content_sha256, updated_at = excluded.updated_at`,
      )
      .bind(workspace, objectKey, contentSha256, new Date().toISOString())
      .run();
  } catch {
    // Index maintenance is best-effort by design — see the doc comment.
  }
}

/**
 * Derived metadata to inherit for `contentSha256`, or `{}` when there is
 * nothing to inherit.
 *
 * Workspace membership is the trust boundary, with no workspace excluded.
 * Issue #479 originally carved out `default` because it was the communal
 * tenant every account belonged to, where "same workspace" said nothing about
 * whether two uploaders were related. That concept is retired (#505): every
 * workspace is now an ordinary one whose members are there deliberately. Since
 * members can already read each other's files, inheriting metadata from a file
 * the caller could simply open discloses nothing new — so the rule is uniform,
 * in both cloud and self-hosted.
 */
export async function inheritableMetaForHash(
  db: D1Database,
  workspace: string,
  contentSha256: string,
  selfKey: string,
): Promise<Record<string, string>> {
  // Fail-soft, deliberately. This runs *after* the bytes are durably stored, so
  // a D1 blip here must cost the convenience (metadata the caller can re-state)
  // rather than the upload (bytes the caller would have to re-send). The same
  // reasoning as recordContentHash, and the opposite of getFileMetadata's
  // throw-on-error, which serves reads where an empty result would be a lie.
  try {
    const row = await db
      .prepare(
        `SELECT object_key FROM file_content_hash
         WHERE workspace = ? AND content_sha256 = ? AND object_key != ?
         ORDER BY updated_at ASC, object_key ASC
         LIMIT 1`,
      )
      .bind(workspace, contentSha256, selfKey)
      .first<HashRow>();
    const donorKey = row?.object_key;
    if (!donorKey) return {};

    const donorMeta = await getFileMetadata(db, workspace, donorKey);
    const inheritable: Record<string, string> = {};
    for (const [key, value] of Object.entries(donorMeta)) {
      if (INHERITABLE_KEY_SET.has(key)) inheritable[key] = value;
    }
    return inheritable;
  } catch {
    return {};
  }
}

/**
 * Apply inheritance for an upload that supplied no explicit metadata.
 *
 * A put with no `X-Uploads-Meta-*` headers deliberately leaves an existing
 * object's tags untouched (see `putObject`), so this must not route through
 * `replaceFileMetadata` — that is delete-then-insert and would wipe tags the
 * caller never asked to change. `addMissingFileMetadata` is the additive,
 * overflow-dropping counterpart.
 *
 * Fail-soft for the same reason as the rest of this module: it runs after the
 * bytes are stored, so a D1 blip must cost the metadata rather than the upload.
 *
 * Returns the object's resulting tag set when something was written, else
 * `undefined` — so the caller can echo what actually landed (#511) without a
 * second read.
 */
export async function applyInheritedMetaAdditively(
  db: D1Database,
  workspace: string,
  objectKey: string,
  inherited: Record<string, string>,
): Promise<Record<string, string> | undefined> {
  try {
    return await addMissingFileMetadata(db, workspace, objectKey, inherited);
  } catch {
    return undefined;
  }
}
