/**
 * Send a weekly digest and turn the matching preference off from its link.
 * Sending lives here because the EMAIL binding's allowed sender and the
 * signing secret both live on this worker.
 */
import { and, eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import {
  digestDeliveryId,
  renderWeeklyDigestEmail,
  type WeeklyDigestKind,
  type WeeklyDigestMessage,
} from "@uploads/email";
import {
  digestUnsubscribeBase,
  signDigestUnsubscribe,
  unsubscribeUrl,
  verifyDigestUnsubscribe,
  type DigestUnsubscribeKind,
} from "./digest-token";
import * as schema from "./schema";

const FROM = { name: "uploads.sh", email: "noreply@uploads.sh" } as const;

export interface DigestEmailBinding {
  send: (message: {
    to: string;
    from: { name: string; email: string };
    subject: string;
    text?: string;
    html?: string;
    headers?: Record<string, string>;
  }) => Promise<unknown>;
}

export interface DigestSendEnv {
  EMAIL?: DigestEmailBinding;
  WEB_ORIGIN?: string;
  AUTH_DIRECT_ORIGIN?: string;
  ENVIRONMENT?: string;
  BETTER_AUTH_SECRET?: string;
}

export interface DigestSendResult {
  sent: string[];
  failed: string[];
}

function listUnsubscribe(urls: string[]): Record<string, string> {
  return {
    "List-Unsubscribe": urls.map((url) => `<${url}>`).join(", "),
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
}

export async function sendWeeklyDigests(
  env: DigestSendEnv,
  secret: string,
  messages: WeeklyDigestMessage[],
  now = new Date(),
): Promise<DigestSendResult> {
  const result: DigestSendResult = { sent: [], failed: [] };
  const base = digestUnsubscribeBase(env);
  const webOrigin = env.WEB_ORIGIN || "https://uploads.sh";

  for (const message of messages) {
    const hasBody = Boolean(message.user) || message.pulses.length > 0;
    const deliveryId = digestDeliveryId(message);
    if (!message.userId || !message.to || !hasBody || !deliveryId) {
      result.failed.push(deliveryId || message.userId || "");
      continue;
    }
    const kinds = message.unsubscribes.filter(
      (kind): kind is WeeklyDigestKind => kind === "digest" || kind === "workspace",
    );
    const workspace = message.user?.workspaceSlug || message.pulses[0]?.slug || "";
    if (kinds.length === 0 || !workspace) {
      result.failed.push(deliveryId);
      continue;
    }
    try {
      const links = new Map<WeeklyDigestKind, string>();
      for (const kind of kinds) {
        const token = await signDigestUnsubscribe(secret, message.userId, [kind], workspace, now);
        links.set(kind, unsubscribeUrl(base, token));
      }
      const combined = await signDigestUnsubscribe(secret, message.userId, kinds, workspace, now);
      const rendered = renderWeeklyDigestEmail({
        weekLabel: message.weekLabel,
        user: message.user,
        pulses: message.pulses,
        unsubscribeDigestUrl: links.get("digest"),
        unsubscribeWorkspaceUrl: links.get("workspace"),
        webOrigin,
      });
      if (!env.EMAIL) {
        console.warn(
          `[auth email] no EMAIL binding — weekly digest not sent. To: ${message.to}. "${rendered.subject}".`,
        );
        result.failed.push(deliveryId);
        continue;
      }
      await env.EMAIL.send({
        to: message.to,
        from: FROM,
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
        headers: listUnsubscribe([unsubscribeUrl(base, combined)]),
      });
      result.sent.push(deliveryId);
    } catch (err) {
      console.error(
        `[auth email] weekly digest failed for ${message.to}`,
        err instanceof Error ? err.message : String(err),
      );
      result.failed.push(deliveryId);
    }
  }
  return result;
}

export async function applyDigestUnsubscribe(
  db: DrizzleD1Database<typeof schema>,
  secret: string,
  token: string,
  now = new Date(),
): Promise<
  { ok: true; kinds: DigestUnsubscribeKind[]; workspaceName: string | null } | { ok: false }
> {
  const claims = await verifyDigestUnsubscribe(secret, token, now);
  if (!claims) return { ok: false };
  const patch: Partial<typeof schema.member.$inferInsert> = {};
  if (claims.kinds.includes("digest")) patch.notifyWeeklyDigest = false;
  if (claims.kinds.includes("workspace")) patch.notifyWeeklyWorkspaceDigest = false;

  if (!claims.workspace) {
    await db.update(schema.member).set(patch).where(eq(schema.member.userId, claims.userId));
    return { ok: true, kinds: claims.kinds, workspaceName: null };
  }

  const [org] = await db
    .select({ id: schema.organization.id, name: schema.organization.name })
    .from(schema.organization)
    .where(eq(schema.organization.slug, claims.workspace))
    .limit(1);
  if (!org) return { ok: true, kinds: claims.kinds, workspaceName: null };
  await db
    .update(schema.member)
    .set(patch)
    .where(and(eq(schema.member.userId, claims.userId), eq(schema.member.organizationId, org.id)));
  return { ok: true, kinds: claims.kinds, workspaceName: org.name };
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] ?? ch,
  );
}

export function unsubscribePage(ok: boolean, workspaceName?: string | null): string {
  const title = ok ? "You're unsubscribed" : "This link doesn't work";
  const where = workspaceName ? ` for ${escapeHtml(workspaceName)}` : "";
  const body = ok
    ? `You won't get that weekly digest${where} anymore. You can turn it back on from Account, under Email notifications.`
    : "This unsubscribe link is invalid or expired. You can change the setting from Account, under Email notifications.";
  return unsubscribeShell(title, body);
}

/** The bare confirmation page every unsubscribe link lands on. `body` is escaped HTML. */
export function unsubscribeShell(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title></head>
<body style="margin:0;background:#0a0a0b;color:#ececea;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <main style="max-width:32rem;margin:0 auto;padding:4rem 1.25rem;">
    <p style="font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:14px;margin:0 0 1.5rem;">uploads.sh</p>
    <h1 style="font-size:1.6rem;font-weight:600;margin:0 0 0.75rem;">${title}</h1>
    <p style="color:#b3b3ad;line-height:1.6;margin:0;">${body}</p>
  </main>
</body>
</html>`;
}
