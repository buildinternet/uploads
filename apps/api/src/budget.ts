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
  /** Name of an R2 binding, when I/O uses one. See `storageBudgetApplies`. */
  binding?: string;
  /** HTTP credentials — presence (with no `binding`) is the BYO signal. See `storageBudgetApplies`. */
  accountId?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
}

/**
 * Whether the active lane's bytes count toward the platform storage budget.
 * False for a self-serve BYO/customer-credential record — their disk, their
 * bill. The cap still applies to shared-lane residue through
 * `enforcedStorageUsageBytes`. Upload size and monthly-count protections stay
 * enforced for everyone, BYO included.
 *
 * The precise signal is deliberately **not** `isUnprefixedDedicatedBucket`
 * (`workspace.ts`) — that predicate answers a layout question ("does this
 * record's I/O span an entire bucket, or a confined shared-bucket prefix?"),
 * which matters for lifecycle jobs (teardown/retention) but says nothing
 * about who owns the storage: an unprefixed *binding*-mode record is still a
 * platform-owned dedicated bucket, wrangler-provisioned and platform-billed.
 * Storage ownership is the question here, so the signal is customer HTTP
 * credentials with no binding — `binding` always means Workers-provisioned,
 * platform-owned storage regardless of prefix, and a bound record is never
 * customer-billed even if it also happens to carry stray credential fields.
 *
 * Usage is still recorded on BYO records either way — see `usage.ts`'s
 * header comment. This predicate selects total usage or shared-lane usage as
 * the enforcement baseline.
 */
export function storageBudgetApplies(record: WorkspaceBudgetLimits): boolean {
  const isCustomerCredentialStorage =
    !record.binding &&
    Boolean(record.accountId) &&
    Boolean(record.accessKeyId) &&
    Boolean(record.secretAccessKey);
  return !isCustomerCredentialStorage;
}

/** Resolved storage cap, regardless of which lane is active. */
export function enforcedMaxStorageBytes(record: WorkspaceBudgetLimits): number | undefined {
  return resolveBudgetLimits(record).maxStorageBytes;
}

/** Usage baseline enforced by the storage cap for the active lane. */
export function enforcedStorageUsageBytes(
  record: WorkspaceBudgetLimits,
  usage: WorkspaceUsage,
): number | undefined {
  if (enforcedMaxStorageBytes(record) === undefined) return undefined;
  return storageBudgetApplies(record) ? usage.bytes : usage.sharedBytes;
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
  //
  // Built field-by-field rather than spread from `record`: enforcement only
  // consumes the two budget caps, so naming them explicitly keeps a future
  // field on `WorkspaceBudgetLimits` from silently becoming an override
  // input to the shared seam.
  const sanitized = {
    plan: record.plan,
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
  usageBytes = usage.bytes,
): BudgetDenial {
  return {
    code: "storage_quota_exceeded",
    status: 507,
    message: `storage quota exceeded (${usageBytes} + ${deltaBytes} > ${maxStorageBytes} bytes)`,
    detail: {
      bytes: usageBytes,
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
  const { maxUploadsPerPeriod } = resolveBudgetLimits(limits);
  const maxStorageBytes = enforcedMaxStorageBytes(limits);
  const usageBytes = enforcedStorageUsageBytes(limits, usage);
  const storageDeltaBytes = storageBudgetApplies(limits) ? delta.bytes : 0;

  if (maxUploadsPerPeriod !== undefined && delta.uploads > 0) {
    if (usage.uploadsInPeriod + delta.uploads > maxUploadsPerPeriod) {
      return uploadBudgetDenial(usage, maxUploadsPerPeriod);
    }
  }

  if (
    maxStorageBytes !== undefined &&
    usageBytes !== undefined &&
    (storageDeltaBytes > 0 || !storageBudgetApplies(limits)) &&
    usageBytes + storageDeltaBytes > maxStorageBytes
  ) {
    return storageBudgetDenial(usage, maxStorageBytes, storageDeltaBytes, usageBytes);
  }

  return null;
}

/**
 * Wire shape of `usageWithLimits` — the usage snapshot plus resolved limits
 * and remaining headroom when capped. Exported so consumers (apps/web via
 * `@uploads/api/workspace-usage`) import the shape the route actually sends
 * instead of re-declaring it.
 */
export interface UsageWithLimits {
  workspace: string;
  bytes: number;
  objects: number;
  sharedBytes: number;
  sharedObjects: number;
  uploadsInPeriod: number;
  periodStart: string;
  updatedAt: string;
  storageBudgetBasis: "total" | "shared";
  maxStorageBytes?: number;
  storageRemainingBytes?: number;
  maxUploadsPerPeriod?: number;
  uploadsRemaining?: number;
}

/** Fields for GET /usage — limits + remaining when capped. */
export function usageWithLimits(usage: WorkspaceUsage, limits: WorkspaceBudgetLimits) {
  const resolved = resolveBudgetLimits(limits);
  const maxStorageBytes = enforcedMaxStorageBytes(limits);
  const usageBytes = enforcedStorageUsageBytes(limits, usage);
  // Typed literal (not Record<string, unknown>) so the response shape is
  // inferable — apps/web imports it via @uploads/api/workspace-usage.
  const out: UsageWithLimits = {
    workspace: usage.workspace,
    bytes: usage.bytes,
    objects: usage.objects,
    sharedBytes: usage.sharedBytes,
    sharedObjects: usage.sharedObjects,
    uploadsInPeriod: usage.uploadsInPeriod,
    periodStart: usage.periodStart,
    updatedAt: usage.updatedAt,
    // Which usage number the storage cap is enforced against: "total" for a
    // shared/hosted lane, "shared" for a BYO-active workspace where only
    // hosted-storage residue is metered (BYO bytes are the customer's own
    // bill). Lets clients render an honest meter + "your bucket is
    // unmetered" note instead of comparing total bytes to a cap that
    // doesn't apply to them.
    storageBudgetBasis: storageBudgetApplies(limits) ? "total" : "shared",
  };

  if (maxStorageBytes !== undefined && usageBytes !== undefined) {
    out.maxStorageBytes = maxStorageBytes;
    out.storageRemainingBytes = Math.max(0, maxStorageBytes - usageBytes);
  }
  if (resolved.maxUploadsPerPeriod !== undefined) {
    out.maxUploadsPerPeriod = resolved.maxUploadsPerPeriod;
    out.uploadsRemaining = Math.max(0, resolved.maxUploadsPerPeriod - usage.uploadsInPeriod);
  }

  return out;
}
