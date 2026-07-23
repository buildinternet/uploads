/**
 * Small "Pro" badge shown outside the billing tab (issue #365 follow-up) —
 * pure logic kept separate from the DOM glue in workspaces-nav.ts and
 * workspaces.astro, the way billing-cta.ts is split out from billing.astro.
 *
 * Free workspaces get no badge at all (absence = free — nothing labels
 * every row). `plan` here is expected to already carry the fail-open-to-
 * "free" contract `planResponse`/`getMyWorkspaces` use, so a legacy or
 * `planApplied === false` workspace record reads as "free" before it ever
 * reaches this function — this is just the last "is it literally 'pro'?"
 * check, kept as its own function so callers don't inline a string compare.
 */
export function shouldShowProBadge(plan: string | undefined): boolean {
  return plan === "pro";
}
