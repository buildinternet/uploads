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
export type BillingCtaState = { kind: "unavailable" } | { kind: "upgrade" } | { kind: "manage" };

/**
 * Resolves which billing-tab CTA to render.
 *
 * - pro not yet available (today): unchanged disabled "coming soon" button.
 * - pro available and the workspace isn't on it: "Upgrade to Pro".
 * - pro available and the workspace is on it: "Manage billing" (portal).
 *
 * Doubles as the plan-comparison cards' state map (billing.astro): "upgrade"
 * and "unavailable" render on the Pro card's CTA when the workspace is on
 * free; "manage" renders as a standalone "Manage billing" button (the
 * downgrade/cancel path lives in the Stripe portal, not a card CTA) shown
 * alongside the Pro card once the workspace is on it.
 */
export function resolveBillingCta(input: { proAvailable: boolean; plan: string }): BillingCtaState {
  if (!input.proAvailable) return { kind: "unavailable" };
  if (input.plan === "pro") return { kind: "manage" };
  return { kind: "upgrade" };
}
