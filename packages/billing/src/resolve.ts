/**
 * Precedence resolution between a workspace's plan defaults and its
 * explicit per-workspace overrides (the admin-editable budget fields on
 * `WorkspaceRecord` — see PR #280 / `apps/api/src/workspace-limits.ts`).
 * Pure — no I/O — so `apps/api/src/budget.ts` and the admin/user routes can
 * all call through this single chokepoint without drifting on precedence.
 */
import { LIMIT_FIELDS } from "./limits";
import { getPlan, type PlanId, type WorkspacePlanLimits } from "./plans";

const LIMIT_KEYS = LIMIT_FIELDS as unknown as (keyof WorkspacePlanLimits)[];

/**
 * Per-field override input. Mirrors the real-world tri-state on
 * `WorkspaceRecord`/`WorkspaceBudgetLimits`: a `number` sets an explicit
 * cap, `null` is an explicit clear ("unlimited", wins over the plan
 * default), and `undefined`/absent means "no override — use the plan
 * default".
 */
export type WorkspacePlanLimitOverrides = {
  [K in keyof WorkspacePlanLimits]?: WorkspacePlanLimits[K] | null;
};

/**
 * Resolves effective limits for a workspace: an explicit numeric override
 * always wins; an explicit `null` override wins too, resolving to
 * `undefined` (unlimited) regardless of the plan default; otherwise falls
 * back to the resolved plan's `defaultLimits` for that field. `plan` fails
 * open to `free` via `getPlan` for any unrecognized/missing value, so a
 * legacy or malformed plan string never locks a workspace out.
 */
export function resolvePlanLimits(
  plan: PlanId | string | undefined,
  overrides: WorkspacePlanLimitOverrides,
): WorkspacePlanLimits {
  const defaults = getPlan(plan).defaultLimits;
  const resolved: WorkspacePlanLimits = {};
  for (const key of LIMIT_KEYS) {
    const override = overrides[key];
    if (override === null) {
      resolved[key] = undefined;
    } else if (override !== undefined) {
      resolved[key] = override;
    } else {
      resolved[key] = defaults[key];
    }
  }
  return resolved;
}

/** Per-field override input plus the optional plan string carried on a
 * workspace record — the shape `resolveEffectiveLimits` needs from any
 * caller's record type. */
export type EffectiveLimitsRecord = WorkspacePlanLimitOverrides & {
  plan?: PlanId | string;
};

/**
 * Single seam for "what are this workspace's effective limits" — the one
 * place the `plan === undefined` gate lives (issue #388, deferred from PR
 * #386 review). Both enforcement (`apps/api/src/budget.ts`) and display
 * (`apps/api/src/workspace-plan.ts`) call through here so they can never
 * drift on precedence.
 *
 * When `record.plan` is absent, this reproduces pre-billing behavior
 * byte-for-byte: no plan defaults are applied — only the record's own
 * explicit fields, with `null` (and absence) both resolving to `undefined`
 * (unlimited). Callers that need to sanitize raw/legacy field values
 * (e.g. `budget.ts`'s `positiveLimit` filtering) must do so before calling
 * this function — an absent `plan` here does not consult `resolvePlanLimits`
 * at all, so no plan-default fallback would apply to a sanitized value
 * either way.
 *
 * When `record.plan` is set (including an unrecognized/legacy string,
 * which fails open to `free` via `getPlan`), this defers entirely to
 * `resolvePlanLimits` for precedence between the record's overrides and
 * the resolved plan's defaults.
 */
export function resolveEffectiveLimits(record: EffectiveLimitsRecord): WorkspacePlanLimits {
  if (record.plan === undefined) {
    const resolved: WorkspacePlanLimits = {};
    for (const key of LIMIT_KEYS) {
      const value = record[key];
      resolved[key] = value === null ? undefined : value;
    }
    return resolved;
  }
  return resolvePlanLimits(record.plan, record);
}
