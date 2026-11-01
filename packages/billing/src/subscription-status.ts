/**
 * Which Stripe subscription statuses count as "backing" a paid plan — the
 * single copy of this business rule, shared by apps/api's `planSourceFor`
 * and apps/auth's `/internal/orgs/:slug/subscription` row selection.
 *
 * `past_due` is deliberately included: a past-due subscription still exists
 * and backs the plan (the customer should fix payment, not silently look
 * comped). This is a different question from which plan the workspace should
 * be on. `planForStripeStatus` answers that one, and only `active` and
 * `trialing` stay on pro. The webhook and the billing retry both use it.
 * A `cancel_at_period_end` cancellation stays `active`/`trialing` until the
 * period actually ends, so it's covered here without a separate check.
 */
export const STRIPE_BACKING_STATUSES: ReadonlySet<string> = new Set([
  "active",
  "trialing",
  "past_due",
]);

/** Statuses that keep a workspace on the pro plan. */
export const STRIPE_PRO_PLAN_STATUSES: ReadonlySet<string> = new Set(["active", "trialing"]);

/** Whether `status` is one of the `STRIPE_BACKING_STATUSES`. */
export function isStripeBackingStatus(status: string | null | undefined): boolean {
  return status != null && STRIPE_BACKING_STATUSES.has(status);
}

/**
 * The plan a workspace should be on for this subscription status. `past_due`
 * is backing (the subscription still exists) and free (the webhook already
 * downgrades it). A retry that used the backing set would put the workspace
 * back on pro.
 */
export function planForStripeStatus(status: string | null | undefined): "pro" | "free" {
  return status != null && STRIPE_PRO_PLAN_STATUSES.has(status) ? "pro" : "free";
}
