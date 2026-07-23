/**
 * One-time backfill for self-serve workspace records created before issue
 * #412: `selfServeWorkspaceRecord` used to stamp explicit per-limit numbers
 * (free's defaults) instead of `plan: "free"`, which meant an upgrade to Pro
 * (POST /internal/billing/plan) left the workspace capped at free's limits
 * forever — the explicit overrides always beat the plan default (issue
 * #454, `resolveEffectiveLimits`).
 *
 * For every `ws:` record with `selfServe: true`:
 *   - sets `plan: "free"` if `plan` is absent.
 *   - removes each of the four budget override fields
 *     (maxStorageBytes/maxUploadsPerPeriod/maxUploadBytes/maxVideoUploadBytes)
 *     whose stored value exactly equals free's default for that field — a
 *     genuinely custom override (comped or otherwise) never matches and is
 *     left untouched.
 *
 * Deliberately narrow, mirroring reencrypt-registry.ts's shape (same `ws:`
 * KV pagination, dry-run support, admin-gated route):
 *   - Non-self-serve (admin-provisioned/legacy) records are never touched —
 *     an absent `plan` on those means "legacy unlimited", not free, and must
 *     stay that way (see budget.ts's resolveBudgetLimits comment).
 *   - A record that already has `plan` set is only checked for the stale
 *     override fields — it does not get plan overwritten.
 *   - `maxMembers` is out of scope here: self-serve records never stamped it
 *     (issue #450), so there is nothing to backfill for that field.
 */
import { PLANS } from "@uploads/billing";
import { mutateWorkspaceRecord } from "./workspace-mutate";
import type { WorkspaceRecord } from "./workspace";

const BUDGET_FIELDS = [
  "maxStorageBytes",
  "maxUploadsPerPeriod",
  "maxUploadBytes",
  "maxVideoUploadBytes",
] as const;

const FREE_DEFAULTS = PLANS.free.defaultLimits;

export interface SelfServePlanBackfillResult {
  dryRun: boolean;
  scanned: number;
  updated: number;
  skipped: number;
  errors: Array<{ workspace: string; error: string }>;
  workspaces: Array<{
    workspace: string;
    action: "updated" | "would_update" | "skipped";
    reason?: string;
    clearedFields?: string[];
  }>;
}

/** Pure: which fields on `record` should be cleared / what `plan` should
 * become, or `null` if this self-serve record needs no changes at all. */
export function planBackfillForRecord(
  record: WorkspaceRecord,
): { plan?: "free"; clearFields: string[] } | null {
  const needsPlan = record.plan === undefined;
  const clearFields = BUDGET_FIELDS.filter(
    (field) => typeof record[field] === "number" && record[field] === FREE_DEFAULTS[field],
  );
  if (!needsPlan && clearFields.length === 0) return null;
  return { plan: needsPlan ? "free" : undefined, clearFields };
}

export async function backfillSelfServePlans(
  env: Env,
  opts: { dryRun?: boolean } = {},
): Promise<SelfServePlanBackfillResult> {
  const dryRun = opts.dryRun === true;

  let cursor: string | undefined;
  let scanned = 0;
  let updated = 0;
  let skipped = 0;
  const errors: SelfServePlanBackfillResult["errors"] = [];
  const workspaces: SelfServePlanBackfillResult["workspaces"] = [];

  do {
    const page = await env.REGISTRY.list({ prefix: "ws:", cursor, limit: 100 });
    for (const entry of page.keys) {
      scanned += 1;
      const name = entry.name.startsWith("ws:") ? entry.name.slice(3) : entry.name;
      if (!name) continue;

      let record: WorkspaceRecord | null;
      try {
        record = await env.REGISTRY.get<WorkspaceRecord>(entry.name, "json");
      } catch (err) {
        errors.push({ workspace: name, error: err instanceof Error ? err.message : String(err) });
        continue;
      }
      if (!record) {
        skipped += 1;
        workspaces.push({ workspace: name, action: "skipped", reason: "missing" });
        continue;
      }
      if (!record.selfServe) {
        skipped += 1;
        workspaces.push({ workspace: name, action: "skipped", reason: "not_self_serve" });
        continue;
      }

      const plan = planBackfillForRecord(record);
      if (!plan) {
        skipped += 1;
        workspaces.push({ workspace: name, action: "skipped", reason: "already_backfilled" });
        continue;
      }

      if (dryRun) {
        updated += 1;
        workspaces.push({
          workspace: name,
          action: "would_update",
          clearedFields: plan.clearFields,
        });
        continue;
      }

      try {
        // Recomputed inside the mutation against the freshest record (issue
        // #387) — this sweep walks every workspace, so a write landing
        // mid-sweep (e.g. a live upgrade) must not be reverted or reapplied
        // against stale data.
        let applied: ReturnType<typeof planBackfillForRecord> = null;
        await mutateWorkspaceRecord(env, name, (current) => {
          applied = planBackfillForRecord(current);
          if (!applied) return null;
          const next: WorkspaceRecord = { ...current };
          if (applied.plan) next.plan = applied.plan;
          for (const field of applied.clearFields) {
            delete next[field as keyof WorkspaceRecord];
          }
          return next;
        });
        const appliedResult = applied as ReturnType<typeof planBackfillForRecord>;
        if (!appliedResult) {
          skipped += 1;
          workspaces.push({ workspace: name, action: "skipped", reason: "already_backfilled" });
          continue;
        }
        updated += 1;
        workspaces.push({
          workspace: name,
          action: "updated",
          clearedFields: appliedResult.clearFields,
        });
      } catch (err) {
        errors.push({ workspace: name, error: err instanceof Error ? err.message : String(err) });
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  return { dryRun, scanned, updated, skipped, errors, workspaces };
}
