/**
 * Per-workspace cumulative budgets (storage + monthly uploads).
 *
 * Limits ride on `WorkspaceRecord` (KV) — same place as `maxUploadBytes` —
 * so operators can change them with a KV put / set-workspace-limits script
 * without redeploying. Omit a field (or set null via the script) for unlimited.
 */

import { InsufficientStorageError, RateLimitedError } from "@uploads/errors";
import { resolveEffectiveLimits } from "@uploads/billing";
import type { WorkspaceUsage } from "./usage";

/** Cumulative caps from the workspace registry record. */
export interface WorkspaceBudgetLimits {
  /** Hard cap on net stored bytes. */
  maxStorageBytes?: number;
  /** Cap on successful puts in the current UTC calendar month. */
  maxUploadsPerPeriod?: number;
  /**
   * Subscription plan — see `@uploads/billing`'s `PlanId`. Absent means
   * legacy/unlimited enforcement (explicit limit fields only, no plan
   * defaults applied) — NOT a free-tier fallback. See `resolveBudgetLimits`.
   */
  plan?: string;
}

export type BudgetDenialCode = "storage_quota_exceeded" | "upload_budget_exceeded";

export interface BudgetDenial {
  code: BudgetDenialCode;
  message: string;
  /** HTTP status: 507 storage, 429 monthly upload budget. */
  status: 507 | 429;
  /** Structured fields for agents / CLI. */
  detail: Record<string, unknown>;
}

/** Positive finite number, else undefined (unlimited). */
export function positiveLimit(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

export function resolveBudgetLimits(record: WorkspaceBudgetLimits): {
  maxStorageBytes?: number;
  maxUploadsPerPeriod?: number;
} {
  // Sanitize the record's own fields before handing off to the shared
  // resolution seam: a zero/negative/non-finite value collapses to
  // "unset" here (matching the pre-existing `positiveLimit` contract),
  // *before* `resolveEffectiveLimits` decides whether that counts as an
  // explicit override or falls back to a plan default. This also
  // preserves the pre-existing quirk that an explicit `null` on this
  // record type is indistinguishable from "unset" (both become
  // `undefined`), unlike the richer null-means-"explicitly cleared"
  // handling `resolveEffectiveLimits`/`resolvePlanLimits` do for other
  // callers (e.g. `workspace-plan.ts`'s admin-set fields).
  const sanitized = {
    ...record,
    maxStorageBytes: positiveLimit(record.maxStorageBytes),
    maxUploadsPerPeriod: positiveLimit(record.maxUploadsPerPeriod),
  };
  // Plan defaults apply ONLY when a workspace has been explicitly placed on
  // a plan — the single `plan === undefined` gate lives in
  // `resolveEffectiveLimits` (issue #388). Absent `plan` must reproduce
  // today's (pre-billing) behavior byte-for-byte: an unset field is
  // unlimited, full stop — no free-tier fallback. This keeps every
  // legacy/admin-provisioned workspace unlimited as it is in production
  // today; only a record with `plan` set opts into plan-aware resolution.
  const resolved = resolveEffectiveLimits(sanitized);
  return {
    maxStorageBytes: positiveLimit(resolved.maxStorageBytes),
    maxUploadsPerPeriod: positiveLimit(resolved.maxUploadsPerPeriod),
  };
}

/** The 429 monthly-upload-budget denial, shared by the read-side check and
 * the atomic reservation path (usage.ts reserveUploads) so both reject with
 * identical shape. */
export function uploadBudgetDenial(
  usage: WorkspaceUsage,
  maxUploadsPerPeriod: number,
): BudgetDenial {
  return {
    code: "upload_budget_exceeded",
    status: 429,
    message: `upload budget exceeded (${usage.uploadsInPeriod}/${maxUploadsPerPeriod} this period)`,
    detail: {
      uploadsInPeriod: usage.uploadsInPeriod,
      maxUploadsPerPeriod,
      periodStart: usage.periodStart,
    },
  };
}

/** The 507 storage-quota denial, shared by the read-side check and
 * the atomic reservation path (usage.ts reserveStorageBytes). */
export function storageBudgetDenial(
  usage: WorkspaceUsage,
  maxStorageBytes: number,
  deltaBytes: number,
): BudgetDenial {
  return {
    code: "storage_quota_exceeded",
    status: 507,
    message: `storage quota exceeded (${usage.bytes} + ${deltaBytes} > ${maxStorageBytes} bytes)`,
    detail: {
      bytes: usage.bytes,
      deltaBytes,
      maxStorageBytes,
      objects: usage.objects,
    },
  };
}

/** Map a denial to the thrown error type: 507 storage, 429 upload budget. */
export function budgetDenialError(
  denial: BudgetDenial,
): InsufficientStorageError | RateLimitedError {
  const options = { code: denial.code, details: denial.detail };
  return denial.status === 507
    ? new InsufficientStorageError(denial.message, options)
    : new RateLimitedError(denial.message, options);
}

/**
 * Whether a put that would apply `delta` is allowed under the workspace limits.
 * `delta.bytes` is the net storage change (newSize − previousSize for overwrites).
 * Overwrites that shrink storage never trip the storage cap.
 */
export function checkPutBudget(
  usage: WorkspaceUsage,
  limits: WorkspaceBudgetLimits,
  delta: { bytes: number; uploads: number },
): BudgetDenial | null {
  const { maxStorageBytes, maxUploadsPerPeriod } = resolveBudgetLimits(limits);

  if (maxUploadsPerPeriod !== undefined && delta.uploads > 0) {
    if (usage.uploadsInPeriod + delta.uploads > maxUploadsPerPeriod) {
      return uploadBudgetDenial(usage, maxUploadsPerPeriod);
    }
  }

  if (maxStorageBytes !== undefined && delta.bytes > 0) {
    if (usage.bytes + delta.bytes > maxStorageBytes) {
      return storageBudgetDenial(usage, maxStorageBytes, delta.bytes);
    }
  }

  return null;
}

/** Fields for GET /usage — limits + remaining when capped. */
export function usageWithLimits(usage: WorkspaceUsage, limits: WorkspaceBudgetLimits) {
  const resolved = resolveBudgetLimits(limits);
  const out: Record<string, unknown> = {
    workspace: usage.workspace,
    bytes: usage.bytes,
    objects: usage.objects,
    uploadsInPeriod: usage.uploadsInPeriod,
    periodStart: usage.periodStart,
    updatedAt: usage.updatedAt,
  };

  if (resolved.maxStorageBytes !== undefined) {
    out.maxStorageBytes = resolved.maxStorageBytes;
    out.storageRemainingBytes = Math.max(0, resolved.maxStorageBytes - usage.bytes);
  }
  if (resolved.maxUploadsPerPeriod !== undefined) {
    out.maxUploadsPerPeriod = resolved.maxUploadsPerPeriod;
    out.uploadsRemaining = Math.max(0, resolved.maxUploadsPerPeriod - usage.uploadsInPeriod);
  }

  return out;
}
