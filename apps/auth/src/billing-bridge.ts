/**
 * Stripe phase 2, task 4: bridges a subscription-driven plan change (Task 5's
 * webhook handler, not yet mounted) to the workspace plan record over the
 * service binding to apps/api — `POST /internal/billing/plan`
 * (routes/internal-billing.ts), authed with the shared
 * `x-internal-billing-key` secret.
 *
 * Deliberately never throws: a webhook handler calling this must not 500
 * because the KV bridge hiccuped. Stripe retries the webhook on failure, and
 * the `subscription` table (Task 1's schema) remains the source of truth
 * regardless of whether this sync landed — so every failure path here is
 * `console.error` + return, not a thrown error.
 */
import { eq } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/d1";
import type { AuthEnv } from "./auth";
import * as schema from "./schema";

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
    return;
  }
  if (!env.BILLING_INTERNAL_KEY) {
    console.error("syncWorkspacePlan: BILLING_INTERNAL_KEY is not configured");
    return;
  }

  try {
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
    }
  } catch (error) {
    console.error(
      `syncWorkspacePlan: POST /internal/billing/plan for workspace ${slug} threw`,
      error,
    );
  }
}
