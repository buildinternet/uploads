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
 *
 * The batch is an Effect program. `handleGithubWebhookBatch` is the worker
 * boundary: it builds the live processor and alerter from `env` and runs
 * the program with `Effect.runPromise`. Callers still pass `(batch, env)`.
 * This Effect port is an experiment and is not intended to merge.
 */
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { reportHandledError } from "@uploads/observability";
import { withSpan } from "@uploads/observability/tracing";
import { authInternalHeaders } from "./auth-internal";
import { processWebhookEvent, type WebhookEvent } from "./github-webhook";

export const GITHUB_WEBHOOK_QUEUE = "uploads-github-webhook";
export const GITHUB_WEBHOOK_DLQ = "uploads-github-webhook-dlq";

const AUTH_INTERNAL_ORIGIN = "https://auth.internal";

/**
 * One attempt per queue delivery. `Schedule.recurs(0)` does not sleep and
 * does not repeat. The queue already retries six times (`max_retries` in
 * wrangler.jsonc) and then dead-letters. Repeating inside this delivery
 * would run the event again and change that count.
 */
const oncePerQueueDelivery = Schedule.recurs(0);

/** `processWebhookEvent` threw. The queue should retry this message. */
export class WebhookProcessingFailed extends Data.TaggedError("WebhookProcessingFailed")<{
  readonly thrown: unknown;
}> {}

/** No operator alert was sent. The batch is still acked. */
export class AlertSkipped extends Data.TaggedError("AlertSkipped")<{
  readonly reason: "no_auth";
}> {}

/** The operator alert was attempted and failed. The batch is still acked. */
export class AlertFailed extends Data.TaggedError("AlertFailed")<{
  readonly status?: number;
  readonly error?: string;
}> {}

/** Runs one queued event. Tests replace this; production calls `processWebhookEvent`. */
export class WebhookProcessor extends Context.Tag("uploads/github-webhook/WebhookProcessor")<
  WebhookProcessor,
  {
    readonly process: (
      event: WebhookEvent,
      messageId: string,
    ) => Effect.Effect<void, WebhookProcessingFailed>;
  }
>() {}

/** Sends one dead-letter batch to the auth worker. Tests replace this. */
export class OperatorAlerts extends Context.Tag("uploads/github-webhook/OperatorAlerts")<
  OperatorAlerts,
  {
    readonly notify: (
      events: readonly WebhookEvent[],
    ) => Effect.Effect<void, AlertSkipped | AlertFailed>;
  }
>() {}

const WebhookProcessorLive = (env: Env): Layer.Layer<WebhookProcessor> =>
  Layer.succeed(WebhookProcessor, {
    process: (event, messageId) =>
      Effect.tryPromise({
        try: () =>
          withSpan(
            "uploads.github.webhook",
            {
              "uploads.github.webhook.work": webhookWork(event),
              "messaging.message.id": messageId,
            },
            () => processWebhookEvent(env, event),
          ),
        catch: (thrown) => new WebhookProcessingFailed({ thrown }),
      }),
  });

const OperatorAlertsLive = (env: Env): Layer.Layer<OperatorAlerts> =>
  Layer.succeed(OperatorAlerts, {
    notify: (events) =>
      Effect.gen(function* () {
        const auth = (env as { AUTH?: Fetcher }).AUTH;
        if (!auth) {
          return yield* Effect.fail(new AlertSkipped({ reason: "no_auth" }));
        }
        const response = yield* Effect.tryPromise({
          try: () =>
            auth.fetch(`${AUTH_INTERNAL_ORIGIN}/internal/webhook-dlq/notify`, {
              method: "POST",
              headers: authInternalHeaders(env, { "content-type": "application/json" }),
              body: JSON.stringify({ events }),
            }),
          catch: (cause) =>
            new AlertFailed({
              error: cause instanceof Error ? cause.message : String(cause),
            }),
        });
        if (!response.ok) {
          return yield* Effect.fail(new AlertFailed({ status: response.status }));
        }
      }),
  });

function liveLayer(env: Env): Layer.Layer<WebhookProcessor | OperatorAlerts> {
  return Layer.mergeAll(WebhookProcessorLive(env), OperatorAlertsLive(env));
}

const deliverMessage = (message: Message<WebhookEvent>) =>
  Effect.gen(function* () {
    const processor = yield* WebhookProcessor;
    yield* processor.process(message.body, message.id);
  }).pipe(
    Effect.retry(oncePerQueueDelivery),
    Effect.as("ack" as const),
    Effect.catchTag("WebhookProcessingFailed", (failure) =>
      Effect.sync(() => {
        const thrown = failure.thrown;
        reportHandledError(
          thrown instanceof Error ? thrown : new Error("github webhook event failed; retrying"),
        );
        return "retry" as const;
      }),
    ),
  );

/**
 * One FYI per dead-letter batch, via the auth worker's OPERATOR_ALERT_EMAIL.
 * Never fails the program: the events are already acked, and the log line is
 * the replay source. A missing AUTH binding (or a failed send) only warns.
 */
const alertDeadLetters = (events: readonly WebhookEvent[]) =>
  Effect.gen(function* () {
    const alerts = yield* OperatorAlerts;
    yield* alerts.notify(events);
  }).pipe(
    Effect.catchTags({
      AlertSkipped: (failure) =>
        Effect.sync(() => {
          console.warn(
            JSON.stringify({
              message: "github_webhook_dlq_alert_skipped",
              reason: failure.reason,
              count: events.length,
            }),
          );
        }),
      AlertFailed: (failure) =>
        Effect.sync(() => {
          console.warn(
            JSON.stringify({
              message: "github_webhook_dlq_alert_failed",
              ...(failure.status !== undefined ? { status: failure.status } : {}),
              ...(failure.error !== undefined ? { error: failure.error } : {}),
              count: events.length,
            }),
          );
        }),
    }),
  );

const handleBatch = (batch: MessageBatch<WebhookEvent>) =>
  Effect.gen(function* () {
    const isDlq = batch.queue === GITHUB_WEBHOOK_DLQ;
    const dead: WebhookEvent[] = [];
    for (const message of batch.messages) {
      if (isDlq) {
        // Terminal: every retry burned. The Error is what Issues groups. The
        // structured line is the replay source (Workers logs keep the body).
        dead.push(message.body);
        console.log(
          JSON.stringify({
            message: "github webhook event dead-lettered",
            deliveryId: message.body.deliveryId ?? null,
            event: message.body,
          }),
        );
        reportHandledError(new Error("github webhook event dead-lettered"));
        message.ack();
        continue;
      }
      const decision = yield* deliverMessage(message);
      if (decision === "ack") message.ack();
      else message.retry();
    }
    if (dead.length > 0) yield* alertDeadLetters(dead);
  });

/** Handle one consumer batch from either queue. Never throws. */
export function handleGithubWebhookBatch(
  batch: MessageBatch<WebhookEvent>,
  env: Env,
): Promise<void> {
  return runGithubWebhookBatch(batch, liveLayer(env));
}

/**
 * Runs one batch with the given services. The worker entry uses the live
 * layer; tests pass a layer so they can replace the processor and the alerter.
 */
export function runGithubWebhookBatch(
  batch: MessageBatch<WebhookEvent>,
  layer: Layer.Layer<WebhookProcessor | OperatorAlerts>,
): Promise<void> {
  return Effect.runPromise(handleBatch(batch).pipe(Effect.provide(layer)));
}

/** Which parts of a queued event carry work, e.g. `promote,ingest`. Never ids or text. */
function webhookWork(event: WebhookEvent): string {
  const parts = Object.entries(event)
    .filter(([key, value]) => key !== "keys" && key !== "deliveryId" && value != null)
    .map(([key]) => key);
  return parts.length > 0 ? parts.sort().join(",") : "cache";
}
