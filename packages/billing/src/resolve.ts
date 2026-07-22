/**
 * Precedence resolution between a workspace's plan defaults and its
 * explicit per-workspace overrides (the admin-editable budget fields on
 * `WorkspaceRecord` — see PR #280 / `apps/api/src/workspace-limits.ts`).
 * Pure — no I/O — so `apps/api/src/budget.ts` and the admin/user routes can
 * all call through this single chokepoint without drifting on precedence.
 */
import { getPlan, type PlanId, type WorkspacePlanLimits } from "./plans";

const LIMIT_KEYS: (keyof WorkspacePlanLimits)[] = [
  "maxStorageBytes",
  "maxUploadsPerPeriod",
  "maxUploadBytes",
  "maxVideoUploadBytes",
];

/**
 * Resolves effective limits for a workspace: an explicit (defined) override
 * field always wins; otherwise falls back to the resolved plan's
 * `defaultLimits` for that field. `plan` fails open to `free` via `getPlan`
 * for any unrecognized/missing value, so a legacy or malformed plan string
 * never locks a workspace out.
 */
export function resolvePlanLimits(
  plan: PlanId | string | undefined,
  overrides: WorkspacePlanLimits,
): WorkspacePlanLimits {
  const defaults = getPlan(plan).defaultLimits;
  const resolved: WorkspacePlanLimits = {};
  for (const key of LIMIT_KEYS) {
    const override = overrides[key];
    resolved[key] = override !== undefined ? override : defaults[key];
  }
  return resolved;
}
