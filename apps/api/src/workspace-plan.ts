/**
 * Validates the plan-change body accepted by the admin panel's
 * PATCH /admin-ui/workspaces/:name/plan endpoint, and builds the response
 * shared by that route's GET/PATCH — mirrors workspace-limits.ts's
 * validateLimitsPatch / admin-ui.ts's limitsResponse pattern (spec
 * 2026-07-22, billing infrastructure).
 */
import {
  getPlan,
  isStripeBackingStatus,
  PLAN_IDS,
  resolveEffectiveLimits,
  type PlanId,
  type WorkspacePlanLimits,
} from "@uploads/billing";
import { ValidationError } from "@uploads/errors";
import type { AuthSubscription } from "./org-workspaces";
import type { WorkspaceRecord } from "./workspace";
import { LIMIT_FIELDS } from "./workspace-limits";

export type PlanSource = "stripe" | "admin" | "none";

/**
 * Derives `planSource` from (workspace record plan + auth subscription) live,
 * on every read — issue #445's last paragraph explicitly asks NOT to add a
 * stored marker to the workspace record when this is computable, since a
 * stored marker could drift from the two systems it's derived from. This is
 * the single shared helper both `/me/workspaces/:name/billing` and the
 * admin-ui subscription view call (see routes/me.ts and routes/admin-ui.ts);
 * issue #388's reconciliation sweep can reuse it too rather than
 * reimplementing the same three-way logic.
 *
 * - "stripe": the plan is paid AND a Stripe subscription in an
 *   active/trialing/past_due state backs it.
 * - "admin": the plan is paid but no such subscription exists (comped/
 *   admin-set via PATCH /admin-ui/workspaces/:name/plan).
 * - "none": the plan is free (regardless of subscription state — a stray
 *   subscription row with no live workspace plan to match isn't "stripe" from
 *   this workspace's point of view).
 */
export function planSourceFor(
  record: WorkspaceRecord,
  subscription: AuthSubscription | null,
): PlanSource {
  const plan = getPlan(record.plan).id;
  if (plan === "free") return "none";
  return subscription && isStripeBackingStatus(subscription.status) ? "stripe" : "admin";
}

export function validatePlanPatch(body: unknown): { plan: PlanId } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ValidationError("plan body must be a JSON object", { code: "invalid_plan" });
  }
  const record = body as Record<string, unknown>;
  const plan = record.plan;
  if (typeof plan !== "string" || !PLAN_IDS.includes(plan as PlanId)) {
    throw new ValidationError(`plan must be one of: ${PLAN_IDS.join(", ")}`, {
      code: "invalid_plan",
    });
  }
  return { plan: plan as PlanId };
}

/**
 * Response body shared by GET and PATCH /admin-ui/workspaces/:name/plan.
 *
 * `plan`/`available` always fail open to the `free` catalog entry for
 * display (`getPlan`'s contract) — but `limits` must not silently apply
 * `free`'s numeric defaults to a record with no `plan` field: budget.ts's
 * enforcement path treats an absent `plan` as legacy/unlimited (explicit
 * overrides only, no plan defaults — see budget.ts's early-return branch),
 * and this response would otherwise lie about a workspace's real caps
 * (e.g. showing "250MB" for a workspace that's actually unlimited).
 * `planApplied` is the honest signal distinguishing the two states:
 * `false` means `limits` reflects raw overrides only (unlimited where
 * unset, mirroring the null-for-unlimited convention `limitsResponse`
 * uses above); `true` means `limits` reflects plan-aware resolution via
 * the shared `resolveEffectiveLimits` seam (overrides layered onto the
 * plan's defaults — see `@uploads/billing`'s `resolve.ts`; issue #388).
 */
export function planResponse(name: string, record: WorkspaceRecord) {
  const definition = getPlan(record.plan);
  const overrides = LIMIT_FIELDS.filter(
    (field) => record[field as keyof WorkspacePlanLimits] !== undefined,
  );
  const planApplied = record.plan !== undefined;
  const resolved = resolveEffectiveLimits(record);
  const limits = planApplied
    ? resolved
    : Object.fromEntries(
        LIMIT_FIELDS.map((field) => [field, resolved[field as keyof WorkspacePlanLimits] ?? null]),
      );
  return {
    workspace: name,
    plan: definition.id,
    available: definition.available,
    planApplied,
    limits,
    overrides,
  };
}
