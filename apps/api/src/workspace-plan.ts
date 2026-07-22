/**
 * Validates the plan-change body accepted by the admin panel's
 * PATCH /admin-ui/workspaces/:name/plan endpoint, and builds the response
 * shared by that route's GET/PATCH — mirrors workspace-limits.ts's
 * validateLimitsPatch / admin-ui.ts's limitsResponse pattern (spec
 * 2026-07-22, billing infrastructure).
 */
import { getPlan, PLAN_IDS, resolvePlanLimits, type PlanId } from "@uploads/billing";
import { ValidationError } from "@uploads/errors";
import type { WorkspaceRecord } from "./workspace";

const LIMIT_FIELDS_FOR_OVERRIDES = [
  "maxStorageBytes",
  "maxUploadsPerPeriod",
  "maxUploadBytes",
  "maxVideoUploadBytes",
] as const;

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

/** Response body shared by GET and PATCH /admin-ui/workspaces/:name/plan. */
export function planResponse(name: string, record: WorkspaceRecord) {
  const definition = getPlan(record.plan);
  const overrides = LIMIT_FIELDS_FOR_OVERRIDES.filter((field) => record[field] !== undefined);
  const limits = resolvePlanLimits(record.plan, {
    maxStorageBytes: record.maxStorageBytes,
    maxUploadsPerPeriod: record.maxUploadsPerPeriod,
    maxUploadBytes: record.maxUploadBytes,
    maxVideoUploadBytes: record.maxVideoUploadBytes,
  });
  return {
    workspace: name,
    plan: definition.id,
    available: definition.available,
    limits,
    overrides,
  };
}
