/**
 * Canonical list of workspace budget-limit fields. Single source of truth
 * for field names/order — `apps/api/src/workspace-limits.ts` (admin PATCH
 * validation) and `packages/billing/src/plans.ts` (plan defaults / display)
 * both derive from this instead of maintaining their own copies (issue
 * #388, deferred from PR #386 review).
 */
export const LIMIT_FIELDS = [
  "maxStorageBytes",
  "maxUploadsPerPeriod",
  "maxUploadBytes",
  "maxVideoUploadBytes",
] as const;

export type LimitField = (typeof LIMIT_FIELDS)[number];
