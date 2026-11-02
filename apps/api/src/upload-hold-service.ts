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

import { ConflictError, ValidationError } from "@uploads/errors";
import { classifierEvaluationContext } from "./classifier";
import { dbFor } from "./db-session";
import { appendOverrideEvent, blobHoldsFor, claimHeldBlob } from "./file-events";
import { contentHashForKey } from "./content-hash";
import { getFileMetadata, getMetadataForKeys } from "./file-metadata";
import { parseAttachmentKey } from "./github-attachment-index";
import { objectContentSha256 } from "./hosted-hold";
import {
  hostedGateObjectKeys,
  readGateDeletesForRelease,
  readGateInsertsForHold,
  readGateInsertsUnlessReleased,
} from "./read-gate";
import { emailHold } from "./hold-email-notify";
import { notifySlackHoldResolved, notifySlackOfHold } from "./slack-hold-notify";
import { postManagedComment } from "./github-comment-service";
import type { GhTarget } from "./github-comment-render";
import { HOLD_META_KEY, HOLD_PENDING, holdPolicyEnabled, holdReason } from "./upload-hold";
import type { UploaderIdentity } from "./uploader-identity";
import { loadWorkspaceRecord, type WorkspaceRecord } from "./workspace";
import {
  countHeldByWorkspace,
  effectiveHold,
  holdKeysForHash,
  keysCopiedFrom,
  listHeldAcrossWorkspaces,
} from "./upload-hold-read";

/**
 * Hold `key` when `decided` (the rows the classifier just stored) flags it
 * and the workspace policy is on. An existing `ai.hold` row wins: identical
 * bytes keep a release, and a pending hold is not re-announced.
 *
 * `opts.enforce` is false for an upload from a client that cannot approve
 * (`clientCanApprove`): the would-be hold is logged and nothing changes.
 *
 * Returns `true` when this call placed the hold. Never throws; a hold is
 * best-effort like the rest of the classifier.
 */
/**
 * Stamp `ai.hold=pending` only while the blob row is held. The WHERE is on
 * the SELECT, so a release that won the race does not gain a pending row.
 */
function holdPendingIfBlobHeld(
  db: ReturnType<typeof dbFor>,
  workspace: string,
  objectKey: string,
  contentSha256: string,
  now: string,
) {
  return db
    .prepare(
      `INSERT INTO file_metadata (workspace, object_key, meta_key, meta_value, updated_at)
       SELECT ?, ?, ?, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM blob_hold
         WHERE workspace = ? AND content_sha256 = ? AND state = 'held'
       )
       ON CONFLICT(workspace, object_key, meta_key) DO UPDATE SET
         meta_value = excluded.meta_value, updated_at = excluded.updated_at`,
    )
    .bind(workspace, objectKey, HOLD_META_KEY, HOLD_PENDING, now, workspace, contentSha256);
}

export async function applyUploadHold(
  env: Env,
  ws: WorkspaceRecord,
  workspaceName: string,
  key: string,
  decided: Record<string, string>,
  opts: { enforce?: boolean; contentSha256?: string } = {},
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
    const sha = opts.contentSha256;
    if (!sha) {
      console.log({ event: "upload_hold_skipped", workspace: workspaceName, reason, skip: "hash" });
      return false;
    }
    const db = dbFor(env);
    const existing = await getFileMetadata(db, workspaceName, key);
    const prior = await blobHoldsFor(db, workspaceName, [sha]).catch(() => new Map());
    const state = prior.get(sha)?.state;
    if (state === "released") return false;
    if (state === "held" || existing[HOLD_META_KEY] !== undefined) {
      const now = new Date().toISOString();
      const markingPending = existing[HOLD_META_KEY] === undefined;
      const gateKeys =
        markingPending || existing[HOLD_META_KEY] === HOLD_PENDING
          ? await hostedGateObjectKeys(env, ws, [key])
          : [];
      const statements = [
        ...(markingPending ? [holdPendingIfBlobHeld(db, workspaceName, key, sha, now)] : []),
        ...readGateInsertsUnlessReleased(db, gateKeys, workspaceName, sha),
      ];
      if (statements.length > 0) await db.batch(statements);
      return false;
    }
    const now = new Date().toISOString();
    const siblings = await holdKeysForHash(db, workspaceName, sha);
    // A lookup failure must not drop the hold on the key just classified.
    const copies = await keysCopiedFrom(db, workspaceName, key, sha).catch((err: unknown) => {
      console.error({ event: "upload_hold_copies_failed", workspace: workspaceName, err });
      return [];
    });
    const covered = [...new Set([key, ...siblings, ...copies])];
    const gateKeys = await hostedGateObjectKeys(env, ws, covered);
    const already = new Set(siblings);
    const toMark = [key, ...copies.filter((copy) => !already.has(copy))];
    // The claim is first. A release that landed after the read leaves the
    // row released (`DO NOTHING`), and the stamps and gates then no-op.
    const claimed = await db.batch([
      claimHeldBlob(db, workspaceName, sha, now),
      ...toMark.map((objectKey) => holdPendingIfBlobHeld(db, workspaceName, objectKey, sha, now)),
      ...readGateInsertsUnlessReleased(db, gateKeys, workspaceName, sha),
    ]);
    if ((claimed[0]?.meta.changes ?? 0) === 0) return false;
    console.log({
      event: "upload_held",
      workspace: workspaceName,
      reason,
      copies: copies.length,
    });
    const copyMeta =
      copies.length > 0
        ? await getMetadataForKeys(db, workspaceName, copies, { metaKeys: ["gh.repo"] })
        : new Map<string, Record<string, string>>();
    await Promise.all([
      resyncAttachmentComment(env, ws, workspaceName, key, existing),
      ...copies.map((copy) =>
        resyncAttachmentComment(env, ws, workspaceName, copy, copyMeta.get(copy) ?? {}),
      ),
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
 * released, or no row for this key) is `not_held`, which the route reports
 * as a 200 so a retried approve is harmless. Safety flags stay as
 * classified. The release is an override event plus a `blob_hold` row.
 * `ai.hold` stays `pending`. A failed write throws. It does not fall
 * back to `ai.hold`.
 */
export async function approveUpload(
  env: Env,
  ws: WorkspaceRecord,
  workspaceName: string,
  key: string,
  by?: string | null,
  expectedSha?: string | null,
): Promise<ApproveUploadResult> {
  const db = dbFor(env);
  const existing = await getFileMetadata(db, workspaceName, key);
  const before = await effectiveHold(env, workspaceName, key, existing);
  if (before.hold !== "pending") return { approved: false, reason: "not_held" };
  // Captured before the hash read. A re-hold that lands in that window has
  // a new `at`, so the compare-and-set below loses.
  const generation = await holdGeneration(env, ws, workspaceName, key);
  if (generation.state === "released") return { approved: false, reason: "not_held" };
  const contentSha256 = await objectContentSha256(env, ws, workspaceName, key);
  if (!contentSha256) {
    throw new ValidationError(
      "this file has no content hash, so the hold change cannot be recorded",
      { code: "content_hash_unknown" },
    );
  }
  if (expectedSha && expectedSha !== contentSha256) {
    throw new ConflictError("the file changed since it was reviewed", {
      code: "content_hash_mismatch",
    });
  }
  // Same hash: use the generation captured above. A different hash is a
  // different blob, so the guard is that blob's current row.
  let expectedAt = generation.at;
  if (generation.sha !== contentSha256) {
    const blob = (await blobHoldsFor(db, workspaceName, [contentSha256])).get(contentSha256);
    if (blob?.state === "released") return { approved: false, reason: "not_held" };
    expectedAt = blob?.state === "held" ? blob.at : null;
  }
  const at = new Date().toISOString();
  const keys = await keysSharingHold(db, workspaceName, contentSha256, key);
  const metas = await getMetadataForKeys(db, workspaceName, keys, { metaKeys: ["gh.repo"] });
  const won = await appendOverrideEvent(
    env,
    {
      workspace: workspaceName,
      objectKey: key,
      contentSha256,
      action: "release",
      actor: by ?? null,
      safety: existing,
      at,
      expectedState: "held",
      expectedAt,
    },
    readGateDeletesForRelease(
      db,
      await hostedGateObjectKeys(env, ws, keys),
      workspaceName,
      contentSha256,
      at,
    ),
  );
  if (!won) {
    const current = (await blobHoldsFor(db, workspaceName, [contentSha256])).get(contentSha256);
    if (current?.state === "held") {
      throw new ConflictError("this file's hold changed while it was being released", {
        code: "hold_conflict",
      });
    }
    return { approved: false, reason: "not_held" };
  }
  console.log({ event: "upload_approved", workspace: workspaceName });
  await Promise.all([
    ...keys.map((heldKey) =>
      resyncAttachmentComment(
        env,
        ws,
        workspaceName,
        heldKey,
        heldKey === key ? existing : (metas.get(heldKey) ?? {}),
      ),
    ),
    notifySlackHoldResolved(env, workspaceName, key, "approved", by),
  ]);
  return { approved: true };
}

/**
 * The blob row for `key` before the release. `at` is the generation a
 * later compare-and-set must still see.
 */
async function holdGeneration(
  env: Env,
  ws: WorkspaceRecord,
  workspaceName: string,
  key: string,
): Promise<{ sha: string | null; at: string | null; state: "held" | "released" | null }> {
  const db = dbFor(env);
  const sha =
    (await contentHashForKey(db, workspaceName, key)) ??
    (await objectContentSha256(env, ws, workspaceName, key)) ??
    null;
  if (!sha) return { sha: null, at: null, state: null };
  const blob = (await blobHoldsFor(db, workspaceName, [sha])).get(sha);
  if (!blob) return { sha, at: null, state: null };
  return { sha, at: blob.at, state: blob.state };
}

async function keysSharingHold(
  db: ReturnType<typeof dbFor>,
  workspaceName: string,
  contentSha256: string,
  key: string,
): Promise<string[]> {
  const siblings = await holdKeysForHash(db, workspaceName, contentSha256);
  return [...new Set([key, ...siblings])];
}

export type HoldAgainResult = { held: true } | { held: false; reason: "not_approved" };

/**
 * Hold a released file again, for a member who approved by mistake. Only
 * a released file: a pending one is already held, and one the classifier
 * never flagged has no reason to show. The re-hold is an override event.
 * The gate rows go back on and the PR comment drops the file, as for a
 * new hold, without the Slack and email alerts (the member asked for it).
 * The public URL may already be cached or copied, so this is no substitute
 * for rotating a credential.
 */
export async function holdAgain(
  env: Env,
  ws: WorkspaceRecord,
  workspaceName: string,
  key: string,
  by?: string | null,
  expectedSha?: string | null,
): Promise<HoldAgainResult> {
  const db = dbFor(env);
  const existing = await getFileMetadata(db, workspaceName, key);
  const before = await effectiveHold(env, workspaceName, key, existing);
  if (before.hold !== "approved") return { held: false, reason: "not_approved" };
  const contentSha256 = await objectContentSha256(env, ws, workspaceName, key);
  if (!contentSha256) {
    throw new ValidationError(
      "this file has no content hash, so the hold change cannot be recorded",
      { code: "content_hash_unknown" },
    );
  }
  if (expectedSha && expectedSha !== contentSha256) {
    throw new ConflictError("the file changed since it was reviewed", {
      code: "content_hash_mismatch",
    });
  }
  const at = new Date().toISOString();
  const keys = await keysSharingHold(db, workspaceName, contentSha256, key);
  const won = await appendOverrideEvent(
    env,
    {
      workspace: workspaceName,
      objectKey: key,
      contentSha256,
      action: "hold",
      actor: by ?? null,
      safety: existing,
      at,
      expectedState: "released",
      expectedAt: before.at,
    },
    readGateInsertsForHold(
      db,
      await hostedGateObjectKeys(env, ws, keys),
      workspaceName,
      contentSha256,
      at,
    ),
  );
  if (!won) {
    const current = (await blobHoldsFor(db, workspaceName, [contentSha256])).get(contentSha256);
    if (current?.state === "held") return { held: true };
    return { held: false, reason: "not_approved" };
  }
  console.log({ event: "upload_held_again", workspace: workspaceName });
  const metas = await getMetadataForKeys(db, workspaceName, keys, { metaKeys: ["gh.repo"] });
  await Promise.all(
    keys.map((heldKey) =>
      resyncAttachmentComment(
        env,
        ws,
        workspaceName,
        heldKey,
        heldKey === key ? existing : (metas.get(heldKey) ?? {}),
      ),
    ),
  );
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

/**
 * Re-sync the PR comment for a before or after file whose classification
 * finished after the comment last rendered, so the `check.ai` notes read its
 * new labels. Other files change nothing the comment shows. Never throws.
 */
export async function resyncCommentAfterClassification(
  env: Env,
  ws: WorkspaceRecord,
  workspaceName: string,
  key: string,
): Promise<void> {
  if (!parseAttachmentKey(key)) return;
  try {
    const meta = await getFileMetadata(dbFor(env), workspaceName, key);
    if (meta.state !== "before" && meta.state !== "after") return;
    await resyncAttachmentComment(env, ws, workspaceName, key, meta);
  } catch (err) {
    console.error({ event: "classifier_comment_resync_failed", workspace: workspaceName, err });
  }
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
 * `RELEASE_HOLDS_BATCH`. Each file goes through `approveUpload`, so
 * comments re-sync exactly as a member approval would. A file that fails
 * (its workspace is gone) is counted and stays held, so a caller looping until
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
