/**
 * Writes for held uploads (`upload-hold.ts` has the rules). The classifier
 * calls `applyUploadHold` after it stores a decision; the approve route
 * calls `approveUpload`. Both re-sync the managed PR comment when the file
 * is a PR or issue attachment, so a held image leaves the comment, and an
 * approved one returns to it, without waiting for the next upload.
 */

import { dbFor } from "./db-session";
import { getFileMetadata, setServerFileMetadata } from "./file-metadata";
import { parseAttachmentKey } from "./github-attachment-index";
import { postManagedComment } from "./github-comment-service";
import type { GhTarget } from "./github-comment-render";
import {
  HOLD_APPROVED,
  HOLD_META_KEY,
  HOLD_PENDING,
  holdPolicyEnabled,
  holdReason,
} from "./upload-hold";
import type { WorkspaceRecord } from "./workspace";

/**
 * Hold `key` when `decided` (the rows the classifier just stored) flags it
 * and the workspace policy is on. An existing `ai.hold` row wins: identical
 * bytes keep an approval, and a pending hold is not re-announced.
 *
 * Returns `true` when this call placed the hold. Never throws; a hold is
 * best-effort like the rest of the classifier.
 */
export async function applyUploadHold(
  env: Env,
  ws: WorkspaceRecord,
  workspaceName: string,
  key: string,
  decided: Record<string, string>,
): Promise<boolean> {
  try {
    if (!holdPolicyEnabled(ws)) return false;
    const reason = holdReason(decided);
    if (!reason) return false;
    const db = dbFor(env);
    const existing = await getFileMetadata(db, workspaceName, key);
    if (existing[HOLD_META_KEY] !== undefined) return false;
    await setServerFileMetadata(db, workspaceName, key, { [HOLD_META_KEY]: HOLD_PENDING });
    console.log({ event: "upload_held", workspace: workspaceName, reason });
    await resyncAttachmentComment(env, ws, workspaceName, key, existing);
    return true;
  } catch (err) {
    console.error({ event: "upload_hold_failed", workspace: workspaceName, err });
    return false;
  }
}

export type ApproveUploadResult = { approved: true } | { approved: false; reason: "not_held" };

/**
 * Release a held file. A file that is not held (never flagged, already
 * approved, or no row for this key) is `not_held`, which the route reports
 * as a 200 so a retried approve is harmless.
 */
export async function approveUpload(
  env: Env,
  ws: WorkspaceRecord,
  workspaceName: string,
  key: string,
): Promise<ApproveUploadResult> {
  const db = dbFor(env);
  const existing = await getFileMetadata(db, workspaceName, key);
  if (existing[HOLD_META_KEY] !== HOLD_PENDING) return { approved: false, reason: "not_held" };
  await setServerFileMetadata(db, workspaceName, key, { [HOLD_META_KEY]: HOLD_APPROVED });
  console.log({ event: "upload_approved", workspace: workspaceName });
  await resyncAttachmentComment(env, ws, workspaceName, key, existing);
  return { approved: true };
}

/**
 * The PR or issue a key is attached to. A private-prefix key (#631) does not
 * name its repo, so the repo comes from the file's `gh.repo` row.
 */
export function attachmentTargetFor(
  key: string,
  meta: Record<string, string>,
): GhTarget | undefined {
  const parsed = parseAttachmentKey(key);
  if (!parsed) return undefined;
  const repo = parsed.repo ?? meta["gh.repo"]?.toLowerCase();
  if (!repo) return undefined;
  return { repo, kind: parsed.kind, num: parsed.num };
}

/** Best-effort. `postManagedComment` already degrades instead of throwing. */
async function resyncAttachmentComment(
  env: Env,
  ws: WorkspaceRecord,
  workspaceName: string,
  key: string,
  meta: Record<string, string>,
): Promise<void> {
  const target = attachmentTargetFor(key, meta);
  if (!target) return;
  try {
    const result = await postManagedComment(env, ws, workspaceName, null, target);
    if (!result.posted) {
      console.log({ event: "upload_hold_comment_skipped", reason: result.reason });
    }
  } catch (err) {
    console.error({ event: "upload_hold_comment_failed", workspace: workspaceName, err });
  }
}
