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

/** Which server-side path wrote (or last updated) an index row. */
export type AttachmentSource =
  | "put"
  | "attach"
  | "promote"
  | "adopt"
  | "rotate"
  | "backfill"
  | "reconcile";

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
    if (!parsed) return undefined;
    return { kind: parsed.kind, num: parsed.num, prefixId: parsed.prefixId, repo: null };
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
