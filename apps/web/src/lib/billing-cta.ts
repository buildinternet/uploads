/**
 * Workspace billing tab upgrade/manage CTA — Stripe phase 2, task 6.
 *
 * Pure render-state logic, kept separate from billing.astro's DOM glue so
 * it's unit-testable the way the rest of this app's account-shell modules
 * are (see workspace-ui.ts / workspaces-nav.ts).
 *
 * Gated on `PLANS.pro.available` (the catalog's static "can anyone buy
 * this today" flag), NOT the `/me/workspaces/:name/billing` response's own
 * `available` field — that field describes whether the workspace's
 * *current* plan is still a valid self-serve plan (planResponse in
 * apps/api/src/workspace-plan.ts), which is `true` for a free workspace
 * regardless of whether pro is purchasable yet. Callers pass
 * `PLANS.pro.available` in as `proAvailable` (rather than this module
 * reading the catalog itself) so the three states are each independently
 * testable without mocking the catalog.
 */
export type BillingCtaState =
  | { kind: "unavailable" }
  | { kind: "upgrade" }
  | { kind: "manage" }
  | { kind: "comped" };

/**
 * Resolves which billing-tab CTA to render.
 *
 * - pro not yet available (today): unchanged disabled "coming soon" button.
 * - pro available and the workspace isn't on it: "Upgrade to Pro".
 * - pro available, on pro, backed by a live Stripe subscription:
 *   "Manage billing" (opens the Stripe customer portal).
 * - pro available, on pro, but the plan is comped/admin-set (`planSource`
 *   is "admin", no Stripe customer behind it): "comped" — NO portal button.
 *   The Stripe portal 404s for a workspace with no Stripe customer (there's
 *   nothing to build a portal session from), so offering it would only ever
 *   produce an opaque error. The "Included with your workspace." status line
 *   (subscription-copy.ts) already explains the state.
 *
 * Doubles as the plan-comparison cards' state map (billing.astro): "upgrade"
 * and "unavailable" render on the Pro card's CTA when the workspace is on
 * free; "manage" renders as a standalone "Manage billing" button (the
 * downgrade/cancel path lives in the Stripe portal, not a card CTA) shown
 * alongside the Pro card once a real subscription backs it; "comped" renders
 * neither button, only a clarifying note.
 */
export function resolveBillingCta(input: {
  proAvailable: boolean;
  plan: string;
  planSource: "stripe" | "admin" | "none";
}): BillingCtaState {
  if (!input.proAvailable) return { kind: "unavailable" };
  if (input.plan === "pro") {
    return input.planSource === "stripe" ? { kind: "manage" } : { kind: "comped" };
  }
  return { kind: "upgrade" };
}
