/**
 * Queue consumer for GitHub webhook ingestion (issue #287), matching the
 * house `releases/workers/webhooks` shape: `uploads-github-webhook` (6
 * retries) → `uploads-github-webhook-dlq`. Messages are the compact
 * `WebhookEvent`s produced by handleWebhook — never raw GitHub payloads.
 * Per-message ack/retry (not batch-level): one poisoned event must not
 * re-run its batchmates, whose KV deletes are idempotent but whose
 * promote/comment work costs GitHub API calls.
 *
 * A dead letter is terminal. The consumer logs the full event (including
 * the GitHub delivery id), acks it, and sends one operator email per batch.
 */
import { reportHandledError } from "@uploads/observability";
import { processWebhookEvent, type WebhookEvent } from "./github-webhook";

export const GITHUB_WEBHOOK_QUEUE = "uploads-github-webhook";
export const GITHUB_WEBHOOK_DLQ = "uploads-github-webhook-dlq";

const AUTH_INTERNAL_ORIGIN = "https://auth.internal";

/** Handle one consumer batch from either queue. Never throws. */
export async function handleGithubWebhookBatch(
  batch: MessageBatch<WebhookEvent>,
  env: Env,
): Promise<void> {
  const isDlq = batch.queue === GITHUB_WEBHOOK_DLQ;
  const dead: WebhookEvent[] = [];
  for (const msg of batch.messages) {
    if (isDlq) {
      // Terminal: every retry burned. The Error is what Issues groups. The
      // structured line is the replay source (Workers logs keep the body).
      dead.push(msg.body);
      console.log(
        JSON.stringify({
          message: "github webhook event dead-lettered",
          deliveryId: msg.body.deliveryId ?? null,
          event: msg.body,
        }),
      );
      reportHandledError(new Error("github webhook event dead-lettered"));
      msg.ack();
      continue;
    }
    try {
      await processWebhookEvent(env, msg.body);
      msg.ack();
    } catch (err) {
      reportHandledError(
        err instanceof Error ? err : new Error("github webhook event failed; retrying"),
      );
      msg.retry();
    }
  }
  if (dead.length > 0) await alertDeadLetters(env, dead);
}

/**
 * One FYI per dead-letter batch, via the auth worker's OPERATOR_ALERT_EMAIL.
 * Never throws: the events are already acked, and the log line is the replay
 * source. A missing AUTH binding (or a failed send) only warns.
 */
async function alertDeadLetters(env: Env, events: WebhookEvent[]): Promise<void> {
  const auth = (env as { AUTH?: Fetcher }).AUTH;
  if (!auth) {
    console.warn(
      JSON.stringify({
        message: "github_webhook_dlq_alert_skipped",
        reason: "no_auth",
        count: events.length,
      }),
    );
    return;
  }
  try {
    const res = await auth.fetch(`${AUTH_INTERNAL_ORIGIN}/internal/webhook-dlq/notify`, {
      method: "POST",
      headers: { "x-uploads-internal": "1", "content-type": "application/json" },
      body: JSON.stringify({ events }),
    });
    if (!res.ok) {
      console.warn(
        JSON.stringify({
          message: "github_webhook_dlq_alert_failed",
          status: res.status,
          count: events.length,
        }),
      );
    }
  } catch (err) {
    console.warn(
      JSON.stringify({
        message: "github_webhook_dlq_alert_failed",
        error: err instanceof Error ? err.message : String(err),
        count: events.length,
      }),
    );
  }
}
