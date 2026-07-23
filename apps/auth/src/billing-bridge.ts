/**
 * Stripe phase 2, task 4: bridges a subscription-driven plan change (Task 5's
 * webhook handler, not yet mounted) to the workspace plan record over the
 * service binding to apps/api — `POST /internal/billing/plan`
 * (routes/internal-billing.ts), authed with the shared
 * `x-internal-billing-key` secret.
 *
 * Deliberately never throws: a webhook handler calling this must not 500
 * because the KV bridge hiccuped. The entire body — including the org-slug
 * lookup — runs inside a single try/catch so a D1 failure can't escape as a
 * rejected promise either. Every failure path here is `console.error` +
 * return, not a thrown error.
 *
 * Because failures are swallowed, the webhook returns 2xx and Stripe will
 * NOT retry a failed sync. The auth-side `subscription` table remains the
 * source of truth either way, but a dropped sync used to leave the workspace
 * `plan` stale with no recovery. Every failure path now enqueues the org in
 * `billing_plan_outbox` (billing-outbox.ts) so the cron drain retries it —
 * issue #451, ahead of opening signups.
 */
import { eq } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/d1";
import type { AuthEnv } from "./auth";
import * as schema from "./schema";
import { enqueuePlanSync } from "./billing-outbox";

/**
 * `AuthEnv` (auth.ts) doesn't itself declare `API`/`BILLING_INTERNAL_KEY` —
 * both are optional secrets that only need to exist on the ambient `Env`
 * (see env.d.ts) and are read through this intersection, the same pattern
 * apps/api's routes/internal-billing.ts uses for its own env access.
 */
type BillingBridgeEnv = AuthEnv & Pick<Env, "API" | "BILLING_INTERNAL_KEY">;

export async function syncWorkspacePlan(
  env: BillingBridgeEnv,
  db: ReturnType<typeof drizzle<typeof schema>>,
  referenceId: string,
  plan: "free" | "pro",
): Promise<void> {
  try {
    const rows = await db
      .select({ slug: schema.organization.slug })
      .from(schema.organization)
      .where(eq(schema.organization.id, referenceId))
      .limit(1);
    const slug = rows[0]?.slug;
    if (!slug) {
      console.error(`syncWorkspacePlan: unknown organization id ${referenceId}`);
      return;
    }

    if (!env.API) {
      console.error("syncWorkspacePlan: env.API service binding is not configured");
      await enqueuePlanSync(db, referenceId, "env.API service binding is not configured");
      return;
    }
    if (!env.BILLING_INTERNAL_KEY) {
      console.error("syncWorkspacePlan: BILLING_INTERNAL_KEY is not configured");
      await enqueuePlanSync(db, referenceId, "BILLING_INTERNAL_KEY is not configured");
      return;
    }

    const response = await env.API.fetch("https://internal/internal/billing/plan", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-internal-billing-key": env.BILLING_INTERNAL_KEY,
      },
      body: JSON.stringify({ workspace: slug, plan }),
    });
    if (!response.ok) {
      console.error(
        `syncWorkspacePlan: POST /internal/billing/plan for workspace ${slug} failed with status ${response.status}`,
      );
      await enqueuePlanSync(db, referenceId, `status ${response.status}`);
    }
  } catch (error) {
    console.error(`syncWorkspacePlan: failed for organization ${referenceId}`, error);
    // Also covers a failed org-slug lookup: the D1 read above is inside this
    // try, and a transient D1 error there is exactly the kind of failure the
    // queue exists to survive.
    await enqueuePlanSync(db, referenceId, error instanceof Error ? error.message : String(error));
  }
}
