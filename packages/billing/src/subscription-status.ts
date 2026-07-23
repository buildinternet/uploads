/**
 * Which Stripe subscription statuses count as "backing" a paid plan — the
 * single copy of this business rule, shared by apps/api's `planSourceFor`
 * and apps/auth's `/internal/orgs/:slug/subscription` row selection.
 *
 * `past_due` is deliberately included: a past-due subscription still exists
 * and backs the plan (the customer should fix payment, not silently look
 * comped). This is a different question from stripe-plugin.ts's
 * `desiredPlanForStatus` ("which plan should the workspace be moved to"),
 * which treats only active/trialing as pro — keep the two rules distinct.
 * A `cancel_at_period_end` cancellation stays `active`/`trialing` until the
 * period actually ends, so it's covered here without a separate check.
 */
export const STRIPE_BACKING_STATUSES: ReadonlySet<string> = new Set([
  "active",
  "trialing",
  "past_due",
]);

/** Whether `status` is one of the `STRIPE_BACKING_STATUSES`. */
export function isStripeBackingStatus(status: string | null | undefined): boolean {
  return status != null && STRIPE_BACKING_STATUSES.has(status);
}
