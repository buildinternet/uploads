/**
 * Stripe phase 2, task 5: mounts `@better-auth/stripe`, gated on ALL of the
 * bridge's prerequisites resolving — STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET,
 * the `API` service binding, and BILLING_INTERNAL_KEY. Until then,
 * `stripePluginOrNone` returns `[]` and the plugin (and its `subscription`
 * table writes, webhook route, etc.) is entirely absent from the Better Auth
 * instance. A checkout that can't sync the resulting plan to the workspace
 * record (billing-bridge.ts) must not be sellable in the first place — hence
 * gating on the bridge deps too, not just the two Stripe secrets.
 * `stripePlans(env)` (Task 2) itself degrades to `[]` when
 * STRIPE_PRO_PRICE_ID is unset, so a secrets-only-partial deploy still mounts
 * a plugin with zero purchasable plans rather than throwing.
 *
 * Orgs are the billing entity (workspaces are 1:1 orgs, see schema.ts) —
 * `organization: { enabled: true }` gives each org its own Stripe customer.
 * No `createCustomerOnSignUp`: customers are created lazily at first
 * checkout, since most accounts never buy.
 *
 * The plan-sync side effects (subscription complete/update/cancel/deleted →
 * `syncWorkspacePlan`, Task 4) never throw — see billing-bridge.ts — so a KV/
 * service-binding hiccup can't turn into a failed webhook response; Stripe's
 * own retry behavior isn't what's relied on here for correctness, the
 * `subscription` table row this plugin itself persists is the source of
 * truth.
 */
import { stripe } from "@better-auth/stripe";
import Stripe from "stripe";
import { and, eq } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/d1";
import {
  checkoutConsentParams,
  stripePlans,
  type CheckoutConsentEnv,
  type CheckoutConsentParams,
} from "@uploads/billing";
import * as schema from "./schema";
import { syncWorkspacePlan } from "./billing-bridge";
import type { AuthEnv } from "./auth";

type Db = ReturnType<typeof drizzle<typeof schema>>;
export type StripePluginEnv = AuthEnv &
  Pick<Env, "STRIPE_SECRET_KEY" | "STRIPE_WEBHOOK_SECRET" | "API" | "BILLING_INTERNAL_KEY"> &
  Pick<Env, "STRIPE_CHECKOUT_TOS_CONSENT">;

/**
 * Downgrade/upgrade decision for a `subscription.update` webhook: `active`
 * and `trialing` are the only statuses that keep a workspace on `pro`.
 * Extracted as a pure function so it's directly unit-testable without
 * standing up the plugin (see stripe-plugin.test.ts).
 */
export function desiredPlanForStatus(status: string): "pro" | "free" {
  return status === "active" || status === "trialing" ? "pro" : "free";
}

/**
 * The plugin's `getCheckoutSessionParams` return shape, whose `params` are
 * merged into `checkout.sessions.create`. Carries only the Terms-checkbox
 * consent block today, and only when enabled — see
 * `@uploads/billing`'s stripe-checkout.ts for why that is gated.
 *
 * Exported so the wiring is directly testable: the configured plugin object
 * does not expose its subscription options for inspection.
 */
export function checkoutSessionParamsFor(env: CheckoutConsentEnv): {
  params: CheckoutConsentParams;
} {
  return { params: checkoutConsentParams(env) };
}

/**
 * True when `userId` is an `owner` or `admin` member of the org identified
 * by `referenceId` — the only roles allowed to start/manage a subscription.
 * Same select-then-check style as auth.ts's other org-role guards
 * (lastAdminGuardHook). Exported for direct unit testing.
 */
export async function isOrgBillingAdmin(
  db: Db,
  userId: string,
  referenceId: string,
): Promise<boolean> {
  const [m] = await db
    .select({ role: schema.member.role })
    .from(schema.member)
    .where(and(eq(schema.member.userId, userId), eq(schema.member.organizationId, referenceId)))
    .limit(1);
  return m?.role === "owner" || m?.role === "admin";
}

/**
 * The four subscription lifecycle handlers, extracted (like
 * `checkoutSessionParamsFor`) so the plan-flip wiring is directly
 * unit-testable — the configured plugin object doesn't expose its
 * subscription options for inspection. `sync` is injectable for tests;
 * production callers use the default `syncWorkspacePlan`.
 */
export function subscriptionLifecycleHandlers(
  env: StripePluginEnv,
  db: Db,
  sync: typeof syncWorkspacePlan = syncWorkspacePlan,
) {
  return {
    onSubscriptionComplete: async ({ subscription }: { subscription: { referenceId: string } }) => {
      await sync(env, db, subscription.referenceId, "pro");
    },
    onSubscriptionUpdate: async ({
      subscription,
    }: {
      subscription: { referenceId: string; status: string };
    }) => {
      await sync(env, db, subscription.referenceId, desiredPlanForStatus(subscription.status));
    },
    onSubscriptionCancel: async ({
      subscription,
    }: {
      subscription: { referenceId: string; status: string };
    }) => {
      // cancel_at_period_end keeps status "active"/"trialing" until the
      // period actually ends — the eventual `subscription.deleted` event
      // (onSubscriptionDeleted below) does that downgrade. Only an
      // immediate (non-period-end) cancel, which lands here with a
      // terminal status already, downgrades now.
      if (desiredPlanForStatus(subscription.status) === "free") {
        await sync(env, db, subscription.referenceId, "free");
      }
    },
    onSubscriptionDeleted: async ({ subscription }: { subscription: { referenceId: string } }) => {
      await sync(env, db, subscription.referenceId, "free");
    },
  };
}

/**
 * `[]` unless `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, the `API` service
 * binding, and `BILLING_INTERNAL_KEY` all resolve — otherwise a single
 * configured `stripe()` plugin. Spread into auth.ts's `plugins` array right
 * after `organization()`.
 */
export function stripePluginOrNone(env: StripePluginEnv, db: Db) {
  if (
    !env.STRIPE_SECRET_KEY ||
    !env.STRIPE_WEBHOOK_SECRET ||
    !env.API ||
    !env.BILLING_INTERNAL_KEY
  ) {
    return [];
  }

  const stripeClient = new Stripe(env.STRIPE_SECRET_KEY, {
    apiVersion: "2026-06-24.dahlia",
    // Workers has no Node `http`/`https` module — force the fetch-based
    // client rather than relying on the SDK's "workerd" export-condition
    // auto-selection, which isn't guaranteed under every bundler/test
    // resolution this repo runs (e.g. vitest's default Node resolution).
    httpClient: Stripe.createFetchHttpClient(),
  });

  return [
    stripe({
      stripeClient,
      stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET,
      organization: { enabled: true },
      subscription: {
        enabled: true,
        plans: stripePlans(env),
        authorizeReference: async ({ user, referenceId }) =>
          isOrgBillingAdmin(db, user.id, referenceId),
        // Merged into `checkout.sessions.create` by the plugin. Empty unless
        // STRIPE_CHECKOUT_TOS_CONSENT is "true" — see stripe-checkout.ts for
        // why this is gated rather than simply on (it needs a Dashboard field
        // set first, or Stripe rejects the session and the upgrade button
        // dies).
        getCheckoutSessionParams: () => checkoutSessionParamsFor(env),
        ...subscriptionLifecycleHandlers(env, db),
      },
    }),
  ];
}
