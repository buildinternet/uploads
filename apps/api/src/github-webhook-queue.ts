/**
 * Queue consumer for GitHub webhook ingestion (issue #287), matching the
 * house `releases/workers/webhooks` shape: `uploads-github-webhook` (6
 * retries) → `uploads-github-webhook-dlq` (log-and-ack). Messages are the
 * compact `WebhookEvent`s produced by handleWebhook — never raw GitHub
 * payloads. Per-message ack/retry (not batch-level): one poisoned event must
 * not re-run its batchmates, whose KV deletes are idempotent but whose
 * promote/comment work costs GitHub API calls.
 */
import { processWebhookEvent, type WebhookEvent } from "./github-webhook";

export const GITHUB_WEBHOOK_QUEUE = "uploads-github-webhook";
export const GITHUB_WEBHOOK_DLQ = "uploads-github-webhook-dlq";

/** Handle one consumer batch from either queue. Never throws. */
export async function handleGithubWebhookBatch(
  batch: MessageBatch<WebhookEvent>,
  env: Env,
): Promise<void> {
  const isDlq = batch.queue === GITHUB_WEBHOOK_DLQ;
  for (const msg of batch.messages) {
    if (isDlq) {
      // Terminal: every retry burned. Log the compact event (it carries no
      // secrets) so the loss is visible and manually replayable, then ack.
      console.error(
        JSON.stringify({ message: "github webhook event dead-lettered", event: msg.body }),
      );
      msg.ack();
      continue;
    }
    try {
      await processWebhookEvent(env, msg.body);
      msg.ack();
    } catch (err) {
      console.error(
        JSON.stringify({
          message: "github webhook event failed; retrying",
          attempts: msg.attempts,
          promote: msg.body?.promote ?? null,
          reconcile: msg.body?.reconcile ?? null,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
      msg.retry();
    }
  }
}
