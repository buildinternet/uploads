/**
 * Who may delete one object (issue #1124).
 *
 * `files:delete` deletes any key, including bulk retention purge. A token
 * with only `files:write` may delete a `gh/…` object it uploaded: the
 * server-stamped `gh.uploader-id` matches the caller's user id. Service
 * tokens and legacy tokens have no user id on the object, so they still
 * need `files:delete`. A client cannot mint that id — `setFileMetadata`
 * rejects the uploader keys — so a write token cannot claim someone else's
 * file and then delete it.
 */
import { InsufficientScopeError } from "@uploads/errors";
import type { D1Queryable } from "./db-session";
import { getFileMetadata } from "./file-metadata";
import { isManagedGithubKey } from "./files-core";
import { insufficientScopeMessage } from "./scope-message";
import type { UploaderIdentity } from "./uploader-identity";

const UPLOADER_ID = "gh.uploader-id";

export function callerOwnsGithubObject(
  key: string,
  metadata: Record<string, string>,
  identity: UploaderIdentity | undefined,
): boolean {
  if (!identity || identity.kind !== "user") return false;
  if (!isManagedGithubKey(key)) return false;
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
  const metadata = opts.metadata ?? (await getFileMetadata(opts.db, opts.workspaceName, opts.key));
  if (callerOwnsGithubObject(opts.key, metadata, opts.identity)) return;
  throw new InsufficientScopeError("files:delete", needed);
}
