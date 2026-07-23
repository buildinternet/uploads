/**
 * Durable retry for the billing plan bridge (issue #451).
 *
 * `syncWorkspacePlan` (billing-bridge.ts) never throws, so a failed bridge
 * call used to leave the workspace's `plan` stale with no recovery: the Stripe
 * webhook had already returned 2xx, so Stripe would not redeliver. Someone
 * could pay and stay on the free plan until a human noticed.
 *
 * This module closes that gap. Every failure path in the bridge enqueues the
 * affected organization here; the cron drain retries with backoff until the
 * plan lands or the attempt cap is hit.
 *
 * Two design decisions worth keeping:
 *
 * 1. The queue records only WHICH organization needs syncing, never which
 *    plan. `desiredPlanFor` recomputes that from the `subscription` table at
 *    retry time, so a row queued before a cancellation can't resurrect `pro`
 *    minutes later. The subscription table is already the source of truth
 *    (see billing-bridge.ts) — this keeps it that way.
 *
 * 2. It only ever touches organizations whose bridge call actually failed.
 *    That is what keeps it clear of the comped-workspace problem in #451: a
 *    workspace an operator put on `pro` by hand never goes through the bridge,
 *    so it is never enqueued, so this can never downgrade it. A general
 *    "compare everything to Stripe" sweep could not make that promise without
 *    a comp marker.
 *
 * Known limit: the queue lives in the same D1 database the bridge reads, so a
 * D1 outage takes the enqueue down with the sync it was meant to rescue. That
 * failure is logged (`billing_outbox_enqueue_failed`) and is the one case
 * still needing an operator re-post through the idempotent internal route.
 * Covering it would mean queueing somewhere other than D1, which is not worth
 * the second system at this volume.
 */
import { asc, eq, lte } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { AuthEnv } from "./auth";
import * as schema from "./schema";
import { isStripeBackingStatus } from "@uploads/billing";

type Db = ReturnType<typeof drizzle<typeof schema>>;
type OutboxEnv = AuthEnv & Pick<Env, "API" | "BILLING_INTERNAL_KEY">;

/** Rows processed per drain — a ceiling on cron runtime, not a queue cap. */
const DRAIN_BATCH = 50;

/**
 * Give up after this many failed attempts. At the backoff below that is a bit
 * over a day of retrying, which comfortably outlives a deploy, a bad secret,
 * or an apps/api outage. A row at the cap stays in the table (it is the
 * operator's record of what never landed) but is no longer retried.
 */
export const MAX_ATTEMPTS = 12;

/** Exponential backoff, capped at an hour: 1m, 2m, 4m … 60m. */
export function backoffSeconds(attempts: number): number {
  return Math.min(60 * 2 ** Math.max(0, attempts - 1), 3600);
}

/**
 * Queue (or requeue) an organization for retry. Never throws — it is called
 * from the bridge's failure paths, which must not turn a swallowed sync error
 * into a rejected promise inside a webhook handler.
 *
 * A repeat failure for the same org updates the existing row and resets its
 * attempt count: the newest failure restarts the backoff rather than
 * inheriting an older row's exhausted budget.
 */
export async function enqueuePlanSync(
  db: Db,
  referenceId: string,
  reason: string,
  now: Date = new Date(),
): Promise<void> {
  try {
    const nextAttemptAt = new Date(now.getTime() + backoffSeconds(1) * 1000);
    await db
      .insert(schema.billingPlanOutbox)
      .values({
        referenceId,
        attempts: 0,
        lastError: reason,
        nextAttemptAt,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: schema.billingPlanOutbox.referenceId,
        set: { attempts: 0, lastError: reason, nextAttemptAt, updatedAt: now },
      });
  } catch (error) {
    console.error(
      JSON.stringify({
        message: "billing_outbox_enqueue_failed",
        referenceId,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

/**
 * The plan an organization should be on right now, derived from its
 * subscription rows: `pro` if any row is in a backing status
 * (active/trialing/past_due), `free` otherwise — including when there are no
 * rows at all, which is how a fully deleted subscription reads.
 *
 * Any-row rather than newest-row because `subscription` has no reliable
 * ordering key (ids are opaque, and the timestamp columns are Stripe period
 * bounds rather than write times). "Is anything currently paying for this
 * org" is the question that matters and it is order-independent.
 *
 * `isStripeBackingStatus` rather than `desiredPlanForStatus`: the two
 * deliberately differ on `past_due`, and a retry should not downgrade someone
 * mid-dunning when the live webhook path would have kept them on `pro`.
 */
export async function desiredPlanFor(db: Db, referenceId: string): Promise<"free" | "pro"> {
  const rows = await db
    .select({ status: schema.subscription.status })
    .from(schema.subscription)
    .where(eq(schema.subscription.referenceId, referenceId));
  return rows.some((row) => isStripeBackingStatus(row.status)) ? "pro" : "free";
}

export interface OutboxDrainResult {
  /** Rows that were due and attempted this pass. */
  attempted: number;
  /** Rows whose plan landed and were removed from the queue. */
  synced: number;
  /** Rows that failed again and were rescheduled. */
  rescheduled: number;
  /** Rows that hit MAX_ATTEMPTS this pass and will not be retried again. */
  exhausted: number;
}

/**
 * One drain pass. Returns counts for logging. Business-logic failures are
 * absorbed per row (a poisoned row can't stall the queue); a D1 failure on the
 * initial select propagates so the caller's cron logging sees it.
 */
export async function runPlanSyncOutbox(
  env: OutboxEnv,
  db: Db,
  now: Date = new Date(),
): Promise<OutboxDrainResult> {
  const result: OutboxDrainResult = { attempted: 0, synced: 0, rescheduled: 0, exhausted: 0 };

  if (!env.API || !env.BILLING_INTERNAL_KEY) {
    // Same fail-quiet posture as the bridge: without the binding or the shared
    // secret there is nothing to retry against, and rows stay queued for a
    // later, properly configured deploy.
    console.error(
      JSON.stringify({
        message: "billing_outbox_drain_skipped",
        reason: env.API ? "missing_billing_internal_key" : "missing_api_binding",
      }),
    );
    return result;
  }

  const due = await db
    .select()
    .from(schema.billingPlanOutbox)
    .where(lte(schema.billingPlanOutbox.nextAttemptAt, now))
    .orderBy(asc(schema.billingPlanOutbox.nextAttemptAt))
    .limit(DRAIN_BATCH);

  for (const row of due) {
    if (row.attempts >= MAX_ATTEMPTS) continue;
    result.attempted += 1;

    let failure: string | null = null;
    try {
      const [org] = await db
        .select({ slug: schema.organization.slug })
        .from(schema.organization)
        .where(eq(schema.organization.id, row.referenceId))
        .limit(1);

      if (!org?.slug) {
        // The org is gone — nothing to sync to, ever. Drop the row rather than
        // retrying it until the attempt cap.
        await db
          .delete(schema.billingPlanOutbox)
          .where(eq(schema.billingPlanOutbox.referenceId, row.referenceId));
        console.error(
          JSON.stringify({
            message: "billing_outbox_dropped_unknown_org",
            referenceId: row.referenceId,
          }),
        );
        continue;
      }

      const plan = await desiredPlanFor(db, row.referenceId);
      const response = await env.API.fetch("https://internal/internal/billing/plan", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-internal-billing-key": env.BILLING_INTERNAL_KEY,
        },
        body: JSON.stringify({ workspace: org.slug, plan }),
      });
      if (!response.ok) failure = `status ${response.status}`;
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }

    if (failure === null) {
      await db
        .delete(schema.billingPlanOutbox)
        .where(eq(schema.billingPlanOutbox.referenceId, row.referenceId));
      result.synced += 1;
      continue;
    }

    const attempts = row.attempts + 1;
    await db
      .update(schema.billingPlanOutbox)
      .set({
        attempts,
        lastError: failure,
        nextAttemptAt: new Date(now.getTime() + backoffSeconds(attempts) * 1000),
        updatedAt: now,
      })
      .where(eq(schema.billingPlanOutbox.referenceId, row.referenceId));

    if (attempts >= MAX_ATTEMPTS) {
      result.exhausted += 1;
      console.error(
        JSON.stringify({
          message: "billing_outbox_exhausted",
          referenceId: row.referenceId,
          attempts,
          lastError: failure,
        }),
      );
    } else {
      result.rescheduled += 1;
    }
  }

  return result;
}

/**
 * The cron expression that runs the drain (wrangler.jsonc `triggers.crons`).
 * Exported so src/index.ts dispatches on the same string the config declares
 * rather than a copy of it.
 */
export const BILLING_OUTBOX_CRON = "*/5 * * * *";

/**
 * Cron entry point, mirroring `runAuthRetentionSweep`: builds the db from
 * `env` and logs the pass. Quiet when the queue is empty — the common case —
 * so the logs only carry passes that did something.
 */
export async function drainBillingOutbox(env: AuthEnv): Promise<OutboxDrainResult> {
  const db = drizzle(env.DB, { schema });
  // The scheduled handler is typed `AuthEnv`, which doesn't declare the two
  // optional billing bindings — same intersection the bridge and the Stripe
  // plugin use to reach them. `runPlanSyncOutbox` treats both as possibly
  // absent, so widening here can't assert away a real missing binding.
  const result = await runPlanSyncOutbox(env as OutboxEnv, db);

  if (result.attempted > 0) {
    console.log(JSON.stringify({ message: "billing_outbox_drain", ...result }));
  }

  return result;
}
