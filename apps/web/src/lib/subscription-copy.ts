/**
 * Workspace billing tab subscription status line — issue #445's remaining
 * billing-tab surface. Pure render-state logic, kept separate from
 * billing.astro's DOM glue the same way billing-cta.ts and plan-prices.ts
 * are, so the plan/subscription → copy mapping is unit-testable without a
 * DOM.
 *
 * Inputs are exactly what billing.astro already has in hand: the parsed
 * `WorkspaceBilling.planSource` + `.subscription` (api-client.ts) and the
 * `formatPrice(proPrice)` string already fetched for the plan cards
 * (plan-prices.ts) — no new fetch, no new endpoint.
 */

export type SubscriptionCopyTone = "muted" | "alert";

export interface SubscriptionCopyState {
  text: string;
  tone: SubscriptionCopyTone;
}

export interface SubscriptionCopyInput {
  planSource: "stripe" | "admin" | "none";
  subscription: { status: string; periodEnd: string | null; cancelAtPeriodEnd: boolean } | null;
  priceText: string | null;
}

/**
 * Formats an ISO date string as e.g. "July 23, 2026". Returns `null` for a
 * missing or unparseable value — callers drop the date from the copy
 * entirely rather than render "Invalid Date".
 */
export function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  }).format(date);
}

/**
 * Resolves the subscription status line shown near the current-plan card.
 *
 * - No subscription at all (free, or `planSource: "none"`) → `null`, no line.
 * - `planSource: "admin"` (comped paid plan, no Stripe subscription behind
 *   it) → muted "included with your workspace" copy, never a renewal date
 *   (there is nothing to renew).
 * - `status: "past_due"` → alert-toned copy pointing at the billing portal,
 *   regardless of `cancelAtPeriodEnd` (a past-due sub isn't safely "renewing").
 * - `cancelAtPeriodEnd: true` (still active) → honest "ends on <date>" copy
 *   — the workspace stays on pro until then, this is not an immediate
 *   downgrade.
 * - Otherwise, an active Stripe subscription → "Renews on <date>", with the
 *   live price appended when known.
 * - Any other/unrecognized status, or a missing/unparseable `periodEnd` →
 *   `null` rather than a misleading or malformed line.
 */
export function resolveSubscriptionCopy(
  input: SubscriptionCopyInput,
): SubscriptionCopyState | null {
  const { planSource, subscription, priceText } = input;

  if (planSource === "admin") {
    return { text: "Included with your workspace.", tone: "muted" };
  }

  if (planSource !== "stripe" || !subscription) return null;

  if (subscription.status === "past_due") {
    return {
      text: "Payment past due — update your payment method in the billing portal.",
      tone: "alert",
    };
  }

  const date = formatDate(subscription.periodEnd);
  if (!date) return null;

  if (subscription.cancelAtPeriodEnd) {
    return { text: `Your plan ends on ${date}.`, tone: "muted" };
  }

  if (subscription.status === "active") {
    const priceSuffix = priceText ? ` · ${priceText}` : "";
    return { text: `Renews on ${date}${priceSuffix}`, tone: "muted" };
  }

  return null;
}
