/**
 * Slack messages for held uploads (`upload-hold-service.ts` places holds).
 *
 * When a hold lands, the people who can act on it get a Slack DM from the
 * uploads.sh app with **Approve** and **Keep held** buttons. uploads-slack
 * (apps/slack) renders and sends the message; this module only picks who
 * gets it and hands each one to the worker over the `SLACK` service binding.
 *
 * Recipients:
 *   - the uploader (`gh.uploader-id`), when the upload carries one and they
 *     are still a member of the workspace;
 *   - otherwise the workspace's admins and owners.
 * Each recipient must have connected Slack (`slack_user_links`, one row per
 * Slack workspace) and left `notify_slack_holds` on (/account/profile).
 *
 * Best effort, like the hold itself: no binding, no recipients, or a failed
 * send all leave the hold in place and never throw.
 */

import { dbFor, type D1Queryable } from "./db-session";
import { filePageUrl } from "./files-core";
import type { HoldReason } from "./upload-hold";

/** The host uploads-slack's internal routes answer on (apps/slack/src/index.ts). */
const SLACK_INTERNAL_ORIGIN = "https://slack.internal";

const UPLOADER_ID_KEY = "gh.uploader-id";

/** One Slack account to message. */
export interface SlackHoldRecipient {
  teamId: string;
  slackUserId: string;
  /** The uploads.sh user behind the link. */
  userId: string;
}

/**
 * Who hears about a hold on `workspaceName`. The uploader when known and
 * still a member, else admins and owners. Filtered to users with a Slack
 * link and the preference on; banned users never get one.
 */
export async function slackHoldRecipients(
  db: D1Queryable,
  workspaceName: string,
  uploaderId: string | undefined,
): Promise<SlackHoldRecipient[]> {
  const base = `SELECT l.team_id, l.slack_user_id, u.id AS user_id
       FROM slack_user_links l
       INNER JOIN user u ON u.id = l.user_id
       INNER JOIN member m ON m.user_id = u.id
       INNER JOIN organization o ON o.id = m.organization_id
      WHERE o.slug = ?
        AND COALESCE(u.notify_slack_holds, 1) = 1
        AND COALESCE(u.banned, 0) = 0`;
  type Row = { team_id: string; slack_user_id: string; user_id: string };
  const toRecipients = (rows: Row[] | undefined) =>
    (rows ?? []).map((r) => ({
      teamId: r.team_id,
      slackUserId: r.slack_user_id,
      userId: r.user_id,
    }));

  if (uploaderId) {
    // The uploader is a member: they hear about it and nobody else does,
    // even when they have no Slack link (they still see the hold in the PR
    // comment and the CLI).
    const isMember = await db
      .prepare(
        `SELECT 1 AS ok FROM member m
           INNER JOIN organization o ON o.id = m.organization_id
          WHERE o.slug = ? AND m.user_id = ?`,
      )
      .bind(workspaceName, uploaderId)
      .first<{ ok: number }>();
    if (isMember) {
      const { results } = await db
        .prepare(`${base} AND u.id = ?`)
        .bind(workspaceName, uploaderId)
        .all<Row>();
      return toRecipients(results);
    }
  }
  const { results } = await db
    .prepare(`${base} AND m.role IN ('admin', 'owner')`)
    .bind(workspaceName)
    .all<Row>();
  return toRecipients(results);
}

/** What uploads-slack's `/slack/internal/hold` takes. */
export interface SlackHoldMessage {
  teamId: string;
  slackUserId: string;
  workspace: string;
  key: string;
  reason: HoldReason;
  /** The flagged `ai.secret` or `ai.pii` value, such as `api_key`. */
  kind?: string;
  /** Signed-in `/f/` page; asks for sign-in while the file is held. */
  pageUrl: string;
  /** Whether this person uploaded it (changes the wording). */
  isUploader: boolean;
}

/**
 * DM everyone who should hear about the hold on `key`. Never throws.
 * Returns how many messages uploads-slack accepted (tests and logs).
 */
export async function notifySlackOfHold(
  env: Env,
  workspaceName: string,
  key: string,
  reason: HoldReason,
  meta: Record<string, string>,
): Promise<number> {
  const slack = (env as { SLACK?: Fetcher }).SLACK;
  if (!slack) return 0;
  try {
    const uploaderId = meta[UPLOADER_ID_KEY] || undefined;
    const recipients = await slackHoldRecipients(dbFor(env), workspaceName, uploaderId);
    if (recipients.length === 0) return 0;
    const pageUrl = filePageUrl(env, workspaceName, key);
    const kind = meta[reason === "pii" ? "ai.pii" : "ai.secret"] || undefined;
    const sent = await Promise.all(
      recipients.map(async (r) => {
        const body: SlackHoldMessage = {
          teamId: r.teamId,
          slackUserId: r.slackUserId,
          workspace: workspaceName,
          key,
          reason,
          kind,
          pageUrl,
          isUploader: r.userId === uploaderId,
        };
        try {
          const res = await slack.fetch(`${SLACK_INTERNAL_ORIGIN}/slack/internal/hold`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });
          return res.ok;
        } catch {
          return false;
        }
      }),
    );
    const accepted = sent.filter(Boolean).length;
    console.log({
      event: "upload_hold_slack_notified",
      workspace: workspaceName,
      recipients: recipients.length,
      accepted,
    });
    return accepted;
  } catch (err) {
    console.error({ event: "upload_hold_slack_failed", workspace: workspaceName, err });
    return 0;
  }
}
