/**
 * Daily usage-limit alert sweep: for every REGISTRY workspace, compare current
 * storage / monthly-upload usage against the resolved cap and email the
 * workspace's admins/owners when it crosses a 50 / 90 / 100% band. Invoked from
 * the Worker scheduled handler alongside the retention sweep.
 *
 * Detection is level-based but edge-triggered: a KV marker per (workspace, cap)
 * stores the highest band already notified, so an email only fires when the
 * band *rises*. Lowering the marker as usage recedes re-arms the alert — which
 * is also what makes a plan upgrade (usage % collapses against the bigger cap)
 * alert again on the new plan. Send + per-user preference filtering happen in
 * the auth worker (the pref and member roster live only there); this module
 * only detects and dedups, then POSTs crossings to `/internal/usage-alerts/notify`.
 */
import { enforcedMaxStorageBytes, enforcedStorageUsageBytes, resolveBudgetLimits } from "./budget";
import { dbFor } from "./db-session";
import { getWorkspaceUsage, usagePeriodStart } from "./usage";
import { isPurgedTombstone, type PurgedTombstone, type WorkspaceRecord } from "./workspace";
import type { UsageAlertEvent, UsageAlertThreshold } from "@uploads/email";

const INTERNAL_ORIGIN = "https://auth.internal";
const THRESHOLDS: readonly UsageAlertThreshold[] = [50, 90, 100];
/** Storage never resets — keep the marker alive well past the daily cadence. */
const STORAGE_MARKER_TTL_S = 400 * 24 * 60 * 60;
/** Upload markers are period-scoped; expire a little after the month rolls. */
const UPLOADS_MARKER_TTL_S = 40 * 24 * 60 * 60;

export interface UsageAlertSweepResult {
  workspacesScanned: number;
  /** Workspaces that crossed at least one new band this run. */
  workspacesAlerted: number;
  /** Total cap crossings emailed (a workspace can cross both caps at once). */
  crossings: number;
  errors: Array<{ workspace: string; error: string }>;
}

/** Highest band (50/90/100) the given percentage has reached, else 0. */
function bandFor(pct: number): number {
  let band = 0;
  for (const t of THRESHOLDS) {
    if (pct >= t) band = t;
  }
  return band;
}

/**
 * Compare a cap's current usage against its marker. Pushes a crossing when the
 * band rose; always reconciles the marker to the current band (re-arming on a
 * recede). Never throws — a KV hiccup on one cap must not abort the sweep.
 */
async function evaluateCap(
  kv: KVNamespace,
  markerKey: string,
  ttlSeconds: number,
  event: { cap: UsageAlertEvent["cap"]; used: number; limit: number },
  crossed: UsageAlertEvent[],
): Promise<void> {
  const pct = (event.used / event.limit) * 100;
  const current = bandFor(pct);
  const prevRaw = await kv.get(markerKey);
  const prev = prevRaw ? parseInt(prevRaw, 10) || 0 : 0;

  if (current > prev) {
    crossed.push({
      cap: event.cap,
      threshold: current as UsageAlertThreshold,
      used: event.used,
      limit: event.limit,
    });
  }

  if (current === 0) {
    if (prevRaw !== null) await kv.delete(markerKey);
    return;
  }
  // Refresh every sweep while at/above a band so the marker stays alive for
  // active workspaces (and lapses via TTL once a workspace goes cold).
  await kv.put(markerKey, String(current), { expirationTtl: ttlSeconds });
}

/** POST a workspace's crossings to the auth worker, which filters + sends. */
async function postUsageAlert(env: Env, slug: string, events: UsageAlertEvent[]): Promise<void> {
  const res = await env.AUTH.fetch(`${INTERNAL_ORIGIN}/internal/usage-alerts/notify`, {
    method: "POST",
    headers: { "x-uploads-internal": "1", "content-type": "application/json" },
    body: JSON.stringify({ slug, events }),
  });
  if (!res.ok) {
    console.warn(
      JSON.stringify({
        message: "usage_alert_notify_failed",
        workspace: slug,
        status: res.status,
      }),
    );
  }
}

export async function runUsageAlertSweep(env: Env): Promise<UsageAlertSweepResult> {
  const db = dbFor(env);
  const period = usagePeriodStart();
  let cursor: string | undefined;
  const result: UsageAlertSweepResult = {
    workspacesScanned: 0,
    workspacesAlerted: 0,
    crossings: 0,
    errors: [],
  };

  do {
    const page = await env.REGISTRY.list({ prefix: "ws:", cursor, limit: 100 });
    for (const entry of page.keys) {
      result.workspacesScanned += 1;
      const name = entry.name.startsWith("ws:") ? entry.name.slice(3) : entry.name;
      if (!name) continue;

      try {
        const record = await env.REGISTRY.get<WorkspaceRecord | PurgedTombstone>(
          entry.name,
          "json",
        );
        if (!record) continue;
        if (isPurgedTombstone(record)) continue;
        // Soft-deleted workspaces are on their way out — don't alert them.
        if (record.deletedAt) continue;

        const maxStorageBytes = enforcedMaxStorageBytes(record);
        const { maxUploadsPerPeriod } = resolveBudgetLimits(record);
        // Legacy/unlimited (plan===undefined and no explicit cap): nothing to
        // cross. Skip the D1 read entirely when neither cap is set.
        if (maxStorageBytes === undefined && maxUploadsPerPeriod === undefined) continue;

        const usage = await getWorkspaceUsage(db, name);
        const crossed: UsageAlertEvent[] = [];

        if (maxStorageBytes !== undefined) {
          const used = enforcedStorageUsageBytes(record, usage);
          if (used !== undefined) {
            await evaluateCap(
              env.REGISTRY,
              `usage:alert:${name}:storage`,
              STORAGE_MARKER_TTL_S,
              { cap: "storage", used, limit: maxStorageBytes },
              crossed,
            );
          }
        }

        if (maxUploadsPerPeriod !== undefined) {
          await evaluateCap(
            env.REGISTRY,
            `usage:alert:${name}:uploads:${period}`,
            UPLOADS_MARKER_TTL_S,
            { cap: "uploads", used: usage.uploadsInPeriod, limit: maxUploadsPerPeriod },
            crossed,
          );
        }

        if (crossed.length > 0) {
          await postUsageAlert(env, name, crossed);
          result.workspacesAlerted += 1;
          result.crossings += crossed.length;
        }
      } catch (err) {
        result.errors.push({
          workspace: name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  console.log(
    JSON.stringify({
      message: "usage_alert_sweep",
      workspacesScanned: result.workspacesScanned,
      workspacesAlerted: result.workspacesAlerted,
      crossings: result.crossings,
      errors: result.errors.length,
    }),
  );
  return result;
}
