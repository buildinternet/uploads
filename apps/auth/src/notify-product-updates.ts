/**
 * Send product update emails for an operator-run campaign, and turn the
 * preference off from their link. The API worker picks the recipients
 * (apps/api/src/cli-upgrade-campaign.ts); sending lives here because the
 * EMAIL binding's allowed sender and the signing secret both live on this
 * worker, same as the weekly digest.
 */
import { eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { renderCliUpgradeEmail } from "@uploads/email";
import {
  digestUnsubscribeBase,
  signUpdatesUnsubscribe,
  updatesUnsubscribeUrl,
  verifyUpdatesUnsubscribe,
} from "./digest-token";
import { unsubscribeShell, type DigestSendEnv } from "./notify-weekly-digest";
import * as schema from "./schema";

const FROM = { name: "uploads.sh", email: "noreply@uploads.sh" } as const;

export interface CliUpgradeMessage {
  userId: string;
  to: string;
  currentVersion: string | null;
  minimumVersion: string;
}

/** User ids the binding accepted, and the ones it didn't. */
export interface ProductUpdateSendResult {
  sent: string[];
  failed: string[];
}

export async function sendCliUpgradeEmails(
  env: DigestSendEnv,
  secret: string,
  messages: CliUpgradeMessage[],
  now = new Date(),
): Promise<ProductUpdateSendResult> {
  const result: ProductUpdateSendResult = { sent: [], failed: [] };
  const base = digestUnsubscribeBase(env);
  for (const message of messages) {
    try {
      const url = updatesUnsubscribeUrl(
        base,
        await signUpdatesUnsubscribe(secret, message.userId, now),
      );
      const rendered = renderCliUpgradeEmail({
        currentVersion: message.currentVersion,
        minimumVersion: message.minimumVersion,
        unsubscribeUrl: url,
        webOrigin: env.WEB_ORIGIN,
      });
      if (!env.EMAIL) {
        console.warn(
          `[auth email] no EMAIL binding — product update not sent. To: ${message.to}. "${rendered.subject}".`,
        );
        result.failed.push(message.userId);
        continue;
      }
      await env.EMAIL.send({
        to: message.to,
        from: FROM,
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
        headers: {
          "List-Unsubscribe": `<${url}>`,
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        },
      });
      result.sent.push(message.userId);
    } catch (err) {
      console.error(
        `[auth email] product update failed for ${message.to}`,
        err instanceof Error ? err.message : String(err),
      );
      result.failed.push(message.userId);
    }
  }
  return result;
}

export async function applyUpdatesUnsubscribe(
  db: DrizzleD1Database<typeof schema>,
  secret: string,
  token: string,
  now = new Date(),
): Promise<boolean> {
  const claims = await verifyUpdatesUnsubscribe(secret, token, now);
  if (!claims) return false;
  await db
    .update(schema.user)
    .set({ notifyProductUpdates: false })
    .where(eq(schema.user.id, claims.userId));
  return true;
}

export function updatesUnsubscribePage(ok: boolean): string {
  return ok
    ? unsubscribeShell(
        "You're unsubscribed",
        "You won't get product update emails anymore. You can turn them back on from Account, under Email notifications.",
      )
    : unsubscribeShell(
        "This link doesn't work",
        "This unsubscribe link is invalid or expired. You can change the setting from Account, under Email notifications.",
      );
}
