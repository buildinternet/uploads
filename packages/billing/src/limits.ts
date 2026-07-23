/**
 * Canonical list of per-workspace plan-limit fields. Single source of truth
 * for field names/order — `apps/api/src/workspace-limits.ts` (admin PATCH
 * validation) and `packages/billing/src/plans.ts` (plan defaults / display)
 * both derive from this instead of maintaining their own copies (issue
 * #388, deferred from PR #386 review).
 *
 * The first four are storage/upload budgets enforced on the file plane
 * (`apps/api/src/budget.ts`). `maxMembers` (issue #450) is a member cap
 * enforced on the invite plane instead — it rides this list so it inherits
 * the same admin-editable override machinery, but budget.ts deliberately
 * only picks out the fields it enforces, so a new field here never leaks
 * into upload enforcement.
 */
export const LIMIT_FIELDS = [
  "maxStorageBytes",
  "maxUploadsPerPeriod",
  "maxUploadBytes",
  "maxVideoUploadBytes",
  "maxMembers",
] as const;

export type LimitField = (typeof LIMIT_FIELDS)[number];
