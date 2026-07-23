/**
 * Plan catalog for workspace subscription plans (spec 2026-07-22). `free`
 * is available in perpetuity; `pro` is purchasable via Stripe Checkout
 * through the @better-auth/stripe plugin on apps/auth.
 *
 * Free `defaultLimits` are the single source of truth for self-serve
 * provisioning: `apps/api/src/self-serve-defaults.ts` imports
 * `PLANS.free.defaultLimits` into `SELF_SERVE_LIMITS` (do not re-hardcode).
 */

import type { LimitField } from "./limits";

export type PlanId = "free" | "pro";

/** The four budget-limit fields a plan can default — same shape as
 * `apps/api/src/budget.ts`'s `WorkspaceBudgetLimits` plus the two
 * per-upload caps from `WorkspaceRecord`, kept here as an independent type
 * so this package has no dependency on `@uploads/api`. Field set is the
 * canonical `LIMIT_FIELDS` list from `./limits`. */
export type WorkspacePlanLimits = {
  [K in LimitField]?: number;
};

export interface PlanDefinition {
  id: PlanId;
  /** Display name shown in the workspace billing tab and admin panel. */
  name: string;
  /** One-sentence description of the plan. */
  blurb: string;
  /** Whether a workspace/user can actually be on this plan today. */
  available: boolean;
  defaultLimits: WorkspacePlanLimits;
}

export const PLANS: Record<PlanId, PlanDefinition> = {
  free: {
    id: "free",
    name: "Free",
    blurb: "Everything you need to host screenshots and files for your projects.",
    available: true,
    defaultLimits: {
      maxStorageBytes: 250_000_000,
      maxUploadsPerPeriod: 3000,
      maxUploadBytes: 25_000_000,
      maxVideoUploadBytes: 8_000_000,
    },
  },
  pro: {
    id: "pro",
    name: "Pro",
    blurb: "10 GB of storage and files up to 100 MB.",
    available: true,
    // Decided 2026-07-22 (first-paid-plan memo): two marketed meters —
    // storage and one unified file cap (video ceiling = upload ceiling on
    // pro; only free carves video out). maxUploadsPerPeriod is an internal
    // abuse guard, not a marketed limit.
    defaultLimits: {
      maxStorageBytes: 10_000_000_000,
      maxUploadsPerPeriod: 100_000,
      maxUploadBytes: 100_000_000,
      maxVideoUploadBytes: 100_000_000,
    },
  },
};

/** All valid plan ids, in catalog order. */
export const PLAN_IDS = Object.keys(PLANS) as PlanId[];

function isPlanId(value: unknown): value is PlanId {
  return typeof value === "string" && Object.hasOwn(PLANS, value);
}

/**
 * The catalog entry for `id`. Fails open to `PLANS.free` for any
 * unrecognized or missing value — legacy/unknown plan strings found in KV
 * must never lock a workspace out, per the spec's error-handling section.
 */
export function getPlan(id: unknown): PlanDefinition {
  return isPlanId(id) ? PLANS[id] : PLANS.free;
}
