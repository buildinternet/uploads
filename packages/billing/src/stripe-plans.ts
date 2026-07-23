import type { PlanId } from "./plans";

export interface StripePlan {
  name: PlanId;
  priceId: string;
}

/** Plugin `subscription.plans` for @better-auth/stripe. Only paid plans with
 * a configured live price id appear; empty array = mounted-but-dormant. */
export function stripePlans(env: { STRIPE_PRO_PRICE_ID?: string }): StripePlan[] {
  return env.STRIPE_PRO_PRICE_ID ? [{ name: "pro", priceId: env.STRIPE_PRO_PRICE_ID }] : [];
}
