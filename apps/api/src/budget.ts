/**
 * Per-workspace cumulative budgets (storage + monthly uploads).
 *
 * Limits ride on `WorkspaceRecord` (KV) — same place as `maxUploadBytes` —
 * so operators can change them with a KV put / set-workspace-limits script
 * without redeploying. Omit a field (or set null via the script) for unlimited.
 */

import { InsufficientStorageError, RateLimitedError } from "@uploads/errors";
import type { WorkspaceUsage } from "./usage";

/** Cumulative caps from the workspace registry record. */
export interface WorkspaceBudgetLimits {
  /** Hard cap on net stored bytes. */
  maxStorageBytes?: number;
  /** Cap on successful puts in the current UTC calendar month. */
  maxUploadsPerPeriod?: number;
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
  return {
    maxStorageBytes: positiveLimit(record.maxStorageBytes),
    maxUploadsPerPeriod: positiveLimit(record.maxUploadsPerPeriod),
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
    const next = usage.bytes + delta.bytes;
    if (next > maxStorageBytes) {
      return {
        code: "storage_quota_exceeded",
        status: 507,
        message: `storage quota exceeded (${usage.bytes} + ${delta.bytes} > ${maxStorageBytes} bytes)`,
        detail: {
          bytes: usage.bytes,
          deltaBytes: delta.bytes,
          maxStorageBytes,
          objects: usage.objects,
        },
      };
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
