/**
 * Who may delete one object (issue #1124).
 *
 * `files:delete` deletes any key, including bulk retention purge. A token
 * with only `files:write` may delete a `gh/…` object when two things match:
 * `gh.uploader-id` is the caller's user id, and `gh.uploader-proof` is the
 * sentinel this server writes beside that id. Service tokens and legacy
 * tokens have no user id, so they still need `files:delete`.
 *
 * The proof is what makes the id trustworthy. Upload strips client uploader
 * keys even when it has nothing to stamp, and `setFileMetadata` rejects
 * them, but rows written before the proof existed can still carry a
 * client-supplied id. Those rows are not backfilled. Without the proof,
 * own-delete is refused and `files:delete` is required.
 */
import { InsufficientScopeError } from "@uploads/errors";
import type { D1Queryable } from "./db-session";
import { getFileMetadata } from "./file-metadata";
import { badKey, isManagedGithubKey } from "./files-core";
import { insufficientScopeMessage } from "./scope-message";
import {
  UPLOADER_PROOF_KEY,
  UPLOADER_PROOF_VALUE,
  type UploaderIdentity,
} from "./uploader-identity";

const UPLOADER_ID = "gh.uploader-id";

export function callerOwnsGithubObject(
  key: string,
  metadata: Record<string, string>,
  identity: UploaderIdentity | undefined,
): boolean {
  if (!identity || identity.kind !== "user") return false;
  if (!isManagedGithubKey(key)) return false;
  if (metadata[UPLOADER_PROOF_KEY] !== UPLOADER_PROOF_VALUE) return false;
  const owner = metadata[UPLOADER_ID];
  return typeof owner === "string" && owner.length > 0 && owner === identity.userId;
}

/** The PR/issue a managed attachment belongs to, for a comment refresh after delete. */
export function attachmentCommentTarget(
  key: string,
  metadata: Record<string, string>,
): { repo: string; kind: "pull" | "issues"; num: number } | undefined {
  const priv = /^gh\/private\/[0-9a-f]{32}\/(pull|issues)\/([1-9][0-9]*)\//.exec(key);
  if (priv) {
    const repo = metadata["gh.repo"];
    if (!repo) return undefined;
    return { repo, kind: priv[1] as "pull" | "issues", num: Number(priv[2]) };
  }
  const plain = /^gh\/([^/]+)\/([^/]+)\/(pull|issues)\/([1-9][0-9]*)\//.exec(key);
  if (!plain) return undefined;
  return {
    repo: `${plain[1]}/${plain[2]}`.toLowerCase(),
    kind: plain[3] as "pull" | "issues",
    num: Number(plain[4]),
  };
}

export async function assertDeleteAllowed(opts: {
  db: D1Queryable;
  workspaceName: string;
  key: string;
  scopes: readonly string[];
  identity: UploaderIdentity | undefined;
  metadata?: Record<string, string>;
}): Promise<void> {
  if (opts.scopes.includes("files:delete")) return;
  const needed = insufficientScopeMessage("files:delete");
  if (!opts.scopes.includes("files:write")) {
    throw new InsufficientScopeError("files:delete", needed);
  }
  // A malformed key cannot name an object this caller uploaded, and neither
  // can a non-gh key. Decide that before any metadata read, and before the
  // handler's badKey 400, so a write token gets 403 instead of learning
  // that the key failed validation.
  if (badKey(opts.key) || !isManagedGithubKey(opts.key)) {
    throw new InsufficientScopeError("files:delete", needed);
  }
  const metadata = opts.metadata ?? (await getFileMetadata(opts.db, opts.workspaceName, opts.key));
  if (callerOwnsGithubObject(opts.key, metadata, opts.identity)) return;
  throw new InsufficientScopeError("files:delete", needed);
}
