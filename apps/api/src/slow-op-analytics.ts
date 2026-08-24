/**
 * Analytics Engine write side for the slow-op trend dataset (issue #812
 * tier 3). One point per operation that `@uploads/observability`'s `timeOp`
 * measured above `SLOW_OP_THRESHOLD_MS` — the same `SlowOpEvent` shape
 * already logged as a structured `slow_op` line, fanned out to a second sink
 * so /admin-ui/metrics can show a trend instead of an operator grepping logs.
 *
 * `@uploads/observability` deliberately has no Worker-binding dependency
 * (packages/README.md convention), so it exposes `timeOp`'s `onSlowOp` hook
 * instead of writing to Analytics Engine itself — every `timeOp` call site in
 * this app passes `onSlowOp: (event) => writeSlowOpPoint(c.env, event)` to
 * wire this up. apps/web has no `ANALYTICS`/`SLOW_OPS` binding and omits the
 * hook entirely, so its slow-ops stay console-log-only (per issue #812's own
 * scope note that apps/web has no such binding).
 *
 * Separate dataset from `uploads_adoption` (adoption.ts's `writeAdoptionPoint`)
 * rather than a new blob column on it: the two datasets have unrelated
 * shapes and cardinalities, and keeping them apart means neither's blob
 * ordinal contract (adoption.ts's `BLOB_ORDER`) has to make room for the
 * other's fields.
 *
 * Only op name, route, durations, and outcome are ever written — never a
 * user id, token, key, or query text (same posture as `logSlowOp` in
 * `@uploads/observability`, which already logs this same event to Workers
 * Logs).
 *
 * `writeSlowOpPoint` never throws and never awaits — an absent binding
 * (self-hosters, tests, local dev) is a silent no-op, same contract as
 * `writeAdoptionPoint`.
 */
import type { SlowOpEvent } from "@uploads/observability";

/**
 * Blob positions are a contract with the SQL read path
 * (`fetchSlowOps` in analytics-engine.ts) — Analytics Engine has no column
 * names, only ordinals. Append new fields at the END; never reorder or
 * remove, or historical rows change meaning retroactively.
 */
export const SLOW_OP_BLOB_ORDER = ["op", "route", "outcome"] as const;

export function writeSlowOpPoint(env: Env, event: SlowOpEvent): void {
  const analytics = (env as { SLOW_OPS?: AnalyticsEngineDataset }).SLOW_OPS;
  if (!analytics) return;
  try {
    analytics.writeDataPoint({
      // Sampling key: keeps one noisy op from crowding out the rest.
      indexes: [event.op],
      blobs: [event.op, event.route ?? "", event.outcome],
      // execMs is -1 (not null/undefined — AE doubles can't carry either)
      // when the underlying result carried no D1 meta (e.g. a `.first()`
      // read, or the error-outcome path); the read side treats a negative
      // value as "unknown" rather than a real duration.
      doubles: [event.wallMs, event.execMs ?? -1],
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(JSON.stringify({ message: "slow-op analytics write failed", error: message }));
  }
}
