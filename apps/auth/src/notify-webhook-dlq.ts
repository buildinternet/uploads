import { sendAuthEmail, type SendAuthEmailEnv } from "./email";

const OPERATOR_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isWebhookEvent(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Array.isArray((value as { keys?: unknown }).keys);
}

/** A non-empty list of compact webhook events, or null. */
export function parseWebhookDlqEvents(raw: unknown): unknown[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  for (const item of raw) {
    if (!isWebhookEvent(item)) return null;
  }
  return raw;
}

/**
 * Email OPERATOR_ALERT_EMAIL once for a dead-letter batch. The events are
 * the compact queue bodies (no secrets). Unset or invalid address skips the
 * mail. Never throws.
 */
export async function notifyOperatorOfWebhookDlq(
  env: SendAuthEmailEnv,
  events: readonly unknown[],
): Promise<{ sent: boolean }> {
  const to = env.OPERATOR_ALERT_EMAIL?.trim() ?? "";
  if (!OPERATOR_EMAIL_RE.test(to)) {
    console.warn(
      JSON.stringify({
        message: "github_webhook_dlq_alert_skipped",
        reason: to ? "invalid" : "unset",
        count: events.length,
      }),
    );
    return { sent: false };
  }
  await sendAuthEmail(env, {
    to,
    template: "webhook-dlq-alert",
    context: { events },
  });
  return { sent: true };
}
