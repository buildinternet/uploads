/**
 * Emails for held uploads, next to the Slack DM (`slack-hold-notify.ts`).
 * Off by default: a person turns `notify_email_holds` on at
 * /account/profile. Recipients follow the Slack rule: the uploader when they
 * are a member, otherwise the workspace's admins and owners.
 *
 * Best effort, like the hold itself: no binding, no recipients, or a failed
 * send leave the hold in place and never throw.
 */

import { renderUploadHeldEmail } from "@uploads/email";
import { dbFor, type D1Queryable } from "./db-session";
import { filePageUrl } from "./files-core";
import type { HoldReason } from "./upload-hold";

const FROM = { name: "uploads.sh", email: "noreply@uploads.sh" } as const;

const UPLOADER_ID_KEY = "gh.uploader-id";

/** Typed here so the module doesn't depend on either worker's generated Env. */
type EmailBinding = {
  send: (message: {
    to: string;
    from: { name: string; email: string };
    subject: string;
    text?: string;
    html?: string;
  }) => Promise<unknown>;
};

export interface EmailHoldRecipient {
  userId: string;
  email: string;
}

/** Who gets a hold email on `workspaceName`: opted in, not banned. */
export async function emailHoldRecipients(
  db: D1Queryable,
  workspaceName: string,
  uploaderId: string | undefined,
): Promise<EmailHoldRecipient[]> {
  const base = `SELECT u.id AS user_id, u.email
       FROM user u
       INNER JOIN member m ON m.user_id = u.id
       INNER JOIN organization o ON o.id = m.organization_id
      WHERE o.slug = ?
        AND COALESCE(u.notify_email_holds, 0) = 1
        AND COALESCE(u.banned, 0) = 0`;
  type Row = { user_id: string; email: string | null };
  const toRecipients = (rows: Row[] | undefined) =>
    (rows ?? [])
      .filter((r): r is Row & { email: string } => !!r.email)
      .map((r) => ({ userId: r.user_id, email: r.email }));

  if (uploaderId) {
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

/** Email everyone opted in to hear about the hold on `key`. Never throws. */
export async function emailHold(
  env: Env,
  workspaceName: string,
  key: string,
  reason: HoldReason,
  meta: Record<string, string>,
): Promise<number> {
  const email = (env as { EMAIL?: EmailBinding }).EMAIL;
  if (!email) return 0;
  try {
    const uploaderId = meta[UPLOADER_ID_KEY] || undefined;
    const recipients = await emailHoldRecipients(dbFor(env), workspaceName, uploaderId);
    if (recipients.length === 0) return 0;
    const pageUrl = filePageUrl(env, workspaceName, key);
    const fileName = key.split("/").pop() || key;
    const sent = await Promise.all(
      recipients.map(async (r) => {
        const { subject, text, html } = renderUploadHeldEmail({
          workspaceName,
          fileName,
          reason,
          pageUrl,
          isUploader: r.userId === uploaderId,
          webOrigin: env.WEB_ORIGIN,
        });
        try {
          await email.send({ to: r.email, from: FROM, subject, text, html });
          return true;
        } catch {
          return false;
        }
      }),
    );
    const accepted = sent.filter(Boolean).length;
    console.log({
      event: "upload_hold_emailed",
      workspace: workspaceName,
      recipients: recipients.length,
      accepted,
    });
    return accepted;
  } catch (err) {
    console.error({ event: "upload_hold_email_failed", workspace: workspaceName, err });
    return 0;
  }
}
