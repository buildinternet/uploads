/**
 * Billing-provider seam (spec 2026-07-22's "future iteration" section). No
 * live billing exists yet — `NullBillingProvider` is the only implementation
 * today, always reporting "free, no subscription". A future
 * `StripeBillingProvider` implements the same interface inside this
 * package; no Stripe SDK dependency exists anywhere yet.
 */
import type { PlanId } from "./plans";

/** A workspace's live subscription state, as reported by the provider. */
export interface Subscription {
  plan: PlanId;
  status: "active" | "canceled" | "past_due";
  /** ISO timestamp of the current billing period's end, if known. */
  currentPeriodEnd?: string;
}

export interface BillingProvider {
  /** The workspace's current subscription, or `null` if it has none
   * (e.g. it's on the free plan with nothing to bill). */
  getSubscription(workspace: string): Promise<Subscription | null>;
  /** Starts a checkout flow for upgrading `workspace` to `plan`. Rejects
   * until a real provider is wired up. */
  createCheckoutSession(workspace: string, plan: PlanId): Promise<never>;
  /** Starts a customer-portal session for `workspace`. Rejects until a
   * real provider is wired up. */
  createPortalSession(workspace: string): Promise<never>;
}

/**
 * The only `BillingProvider` implementation today. Every workspace reports
 * no subscription; checkout/portal are unavailable. Honest placeholder —
 * apps/web's billing tab renders a disabled "Upgrade — coming soon"
 * affordance rather than calling these.
 */
export class NullBillingProvider implements BillingProvider {
  async getSubscription(_workspace: string): Promise<Subscription | null> {
    return null;
  }

  async createCheckoutSession(_workspace: string, _plan: PlanId): Promise<never> {
    throw new Error("checkout is not available yet");
  }

  async createPortalSession(_workspace: string): Promise<never> {
    throw new Error("the billing portal is not available yet");
  }
}
