/**
 * Writes for held uploads (`upload-hold.ts` has the rules). The classifier
 * calls `applyUploadHold` after it stores a decision; the approve route
 * calls `approveUpload`. Both re-sync the managed PR comment when the file
 * is a PR or issue attachment, so a held image leaves the comment, and an
 * approved one returns to it, without waiting for the next upload. A new
 * hold also DMs the people who can approve it in Slack
 * (`slack-hold-notify.ts`), and emails those who opted in
 * (`hold-email-notify.ts`).
 */

import { ServiceUnavailableError } from "@uploads/errors";
import { classifierEvaluationContext } from "./classifier";
import { dbFor } from "./db-session";
import {
  deleteServerFileMetadataKeys,
  getFileMetadata,
  setServerFileMetadata,
} from "./file-metadata";
import { parseAttachmentKey } from "./github-attachment-index";
import { moveToHeld, restoreFromHeld } from "./held-storage";
import { emailHold } from "./hold-email-notify";
import { notifySlackHoldResolved, notifySlackOfHold } from "./slack-hold-notify";
import { postManagedComment } from "./github-comment-service";
import type { GhTarget } from "./github-comment-render";
import {
  HOLD_APPROVED,
  HOLD_AT_KEY,
  HOLD_BY_KEY,
  HOLD_META_KEY,
  HOLD_MOVED_KEY,
  HOLD_PENDING,
  holdPolicyEnabled,
  holdReason,
} from "./upload-hold";
import type { UploaderIdentity } from "./uploader-identity";
import { loadWorkspaceRecord, type WorkspaceRecord } from "./workspace";
import { countHeldByWorkspace, listHeldAcrossWorkspaces } from "./upload-hold-read";

/**
 * Hold `key` when `decided` (the rows the classifier just stored) flags it
 * and the workspace policy is on. An existing `ai.hold` row wins: identical
 * bytes keep an approval, and a pending hold is not re-announced.
 *
 * `opts.enforce` is false for an upload from a client that cannot approve
 * (`clientCanApprove`): the would-be hold is logged and nothing changes.
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
  opts: { enforce?: boolean } = {},
): Promise<boolean> {
  try {
    if (!holdPolicyEnabled(ws)) return false;
    const reason = holdReason(decided);
    if (!reason) return false;
    const skip = !opts.enforce
      ? "client" // the uploading client cannot approve (`clientCanApprove`)
      : !(await holdsAllowed(env, ws, workspaceName))
        ? "flag" // operator kill switch (`UPLOAD_HOLD_FLAG`)
        : null;
    if (skip) {
      // Record what would have been held and leave the file alone.
      console.log({ event: "upload_hold_skipped", workspace: workspaceName, reason, skip });
      return false;
    }
    const db = dbFor(env);
    const existing = await getFileMetadata(db, workspaceName, key);
    if (existing[HOLD_META_KEY] !== undefined) return false;
    // The row lands first: a move that fails part way leaves the public
    // object in place, still held on every surface.
    await setServerFileMetadata(db, workspaceName, key, { [HOLD_META_KEY]: HOLD_PENDING });
    const moved = await moveToHeld(env, ws, workspaceName, key).catch((err: unknown) => {
      console.error({ event: "upload_hold_move_failed", workspace: workspaceName, err });
      return false;
    });
    console.log({ event: "upload_held", workspace: workspaceName, reason, moved });
    await Promise.all([
      resyncAttachmentComment(env, ws, workspaceName, key, existing),
      notifySlackOfHold(env, workspaceName, key, reason, existing),
      emailHold(env, workspaceName, key, reason, existing),
    ]);
    return true;
  } catch (err) {
    console.error({ event: "upload_hold_failed", workspace: workspaceName, err });
    return false;
  }
}

/**
 * Operator kill switch for new holds. Flagship `upload-holds`, evaluated
 * with the classifier's `{ org, workspace }` context, so it can be turned
 * off everywhere or for one workspace without a deploy. Fails closed: a
 * missing binding, a flag served off, or a thrown evaluation all mean no
 * new holds. Existing holds stay until approved.
 */
export const UPLOAD_HOLD_FLAG = "upload-holds";

async function holdsAllowed(
  env: Env,
  ws: WorkspaceRecord,
  workspaceName: string,
): Promise<boolean> {
  if (!env.FLAGS) return false;
  try {
    return await env.FLAGS.getBooleanValue(
      UPLOAD_HOLD_FLAG,
      false,
      classifierEvaluationContext(ws, workspaceName),
    );
  } catch {
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
  by?: string | null,
): Promise<ApproveUploadResult> {
  const db = dbFor(env);
  const existing = await getFileMetadata(db, workspaceName, key);
  if (existing[HOLD_META_KEY] !== HOLD_PENDING) return { approved: false, reason: "not_held" };
  if (existing[HOLD_MOVED_KEY] === "1") {
    // Bytes first: approving a file whose bytes cannot come back would
    // leave its links broken with no hold left to explain why.
    if (!(await restoreFromHeld(env, ws, workspaceName, key))) {
      throw new ServiceUnavailableError("the held copy of this file could not be restored", {
        code: "held_restore_failed",
      });
    }
    await deleteServerFileMetadataKeys(db, workspaceName, key, [HOLD_MOVED_KEY]);
  }
  await setServerFileMetadata(db, workspaceName, key, {
    [HOLD_META_KEY]: HOLD_APPROVED,
    [HOLD_AT_KEY]: new Date().toISOString(),
    ...(by ? { [HOLD_BY_KEY]: by } : {}),
  });
  console.log({ event: "upload_approved", workspace: workspaceName });
  await Promise.all([
    resyncAttachmentComment(env, ws, workspaceName, key, existing),
    notifySlackHoldResolved(env, workspaceName, key, "approved", by),
  ]);
  return { approved: true };
}

export type HoldAgainResult = { held: true } | { held: false; reason: "not_approved" };

/**
 * Hold an approved file again, for a member who approved by mistake. Only
 * an approved file: a pending one is already held, and one the classifier
 * never flagged has no reason to show. Bytes move back to the held bucket
 * and the PR comment drops the file, as for a new hold, without the Slack
 * and email alerts (the member asked for it). The public URL may already
 * be cached or copied, so this is no substitute for rotating a credential.
 */
export async function holdAgain(
  env: Env,
  ws: WorkspaceRecord,
  workspaceName: string,
  key: string,
): Promise<HoldAgainResult> {
  const db = dbFor(env);
  const existing = await getFileMetadata(db, workspaceName, key);
  if (existing[HOLD_META_KEY] !== HOLD_APPROVED) return { held: false, reason: "not_approved" };
  // The row lands first, as in `applyUploadHold`.
  await setServerFileMetadata(db, workspaceName, key, { [HOLD_META_KEY]: HOLD_PENDING });
  await deleteServerFileMetadataKeys(db, workspaceName, key, [HOLD_BY_KEY, HOLD_AT_KEY]);
  const moved = await moveToHeld(env, ws, workspaceName, key);
  console.log({ event: "upload_held_again", workspace: workspaceName, moved });
  await resyncAttachmentComment(env, ws, workspaceName, key, existing);
  return { held: true };
}

/**
 * The label stored as `ai.hold.by`: a member's name, or a service token's
 * label. Best-effort; `null` leaves the approval unattributed.
 */
export async function approverLabel(
  env: Env,
  identity: UploaderIdentity | undefined,
): Promise<string | null> {
  if (identity?.kind === "service") return `${identity.label} (service token)`;
  if (identity?.kind === "user") return memberName(env, identity.userId);
  return null;
}

/** A user's display name, or `null` when it can't be read. */
export async function memberName(env: Env, userId: string): Promise<string | null> {
  try {
    const row = await dbFor(env)
      .prepare("SELECT name FROM user WHERE id = ?")
      .bind(userId)
      .first<{ name: string | null }>();
    const name = row?.name?.trim();
    return name ? name.slice(0, 80) : null;
  } catch {
    return null;
  }
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

/** Most holds one operator release call handles. The page calls again. */
export const RELEASE_HOLDS_BATCH = 25;

export interface ReleaseHoldsResult {
  released: number;
  failed: number;
  /** Holds still pending after this call (0 when done). */
  remaining: number;
}

/**
 * Operator release of pending holds, every workspace or one, in batches of
 * `RELEASE_HOLDS_BATCH`. Each file goes through `approveUpload`, so bytes
 * move back and comments re-sync exactly as a member approval would. A
 * file that fails (its workspace is gone, its held copy cannot be
 * restored) is counted and stays held, so a caller looping until
 * `remaining` is 0 must also stop when a batch releases nothing.
 */
export async function releaseHolds(
  env: Env,
  opts: { workspace?: string } = {},
): Promise<ReleaseHoldsResult> {
  const rows = await listHeldAcrossWorkspaces(env, {
    workspace: opts.workspace,
    limit: RELEASE_HOLDS_BATCH,
  });
  let released = 0;
  let failed = 0;
  const records = new Map<string, WorkspaceRecord | null>();
  for (const row of rows) {
    if (!records.has(row.workspace)) {
      records.set(row.workspace, await loadWorkspaceRecord(env, row.workspace));
    }
    const ws = records.get(row.workspace);
    try {
      if (!ws) throw new Error("workspace not found");
      const result = await approveUpload(env, ws, row.workspace, row.objectKey, "uploads.sh");
      if (result.approved) released += 1;
    } catch (err) {
      failed += 1;
      console.error({ event: "hold_release_failed", workspace: row.workspace, err });
    }
  }
  console.log({ event: "holds_released", workspace: opts.workspace ?? null, released, failed });
  const counts = await countHeldByWorkspace(env);
  const remaining = counts
    .filter((row) => !opts.workspace || row.workspace === opts.workspace)
    .reduce((sum, row) => sum + row.count, 0);
  return { released, failed, remaining };
}
