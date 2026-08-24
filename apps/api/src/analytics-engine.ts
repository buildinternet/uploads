/**
 * Analytics Engine read path for the operator metrics panels: the upload
 * breakdown (dataset `uploads_adoption`) and the slow-op trend (dataset
 * `uploads_slow_ops`, issue #812 tier 3 — see `slow-op-analytics.ts` for the
 * write side).
 *
 * AE has no read binding, so this goes over the Cloudflare SQL API with an
 * account token (ANALYTICS_API_TOKEN, an account token carrying "Account
 * Analytics: Read", set via `wrangler secret put`). That token is distinct
 * from the local wrangler token in .env.
 *
 * EVERY failure mode returns `{ available: false, reason }` rather than
 * throwing: these panels are additive, and the D1-backed half of the metrics
 * page must keep working when AE is unconfigured or unreachable.
 *
 * Retention is 90 days — AE is for recent dimensional curiosity, never the
 * durable record. That lives in `daily_metrics`.
 */

import { BLOB_ORDER } from "./adoption";
import { SLOW_OP_BLOB_ORDER } from "./slow-op-analytics";

const SQL_ENDPOINT = "https://api.cloudflare.com/client/v4/accounts";
const DATASET = "uploads_adoption";
const SLOW_OP_DATASET = "uploads_slow_ops";

/**
 * Dimensions the breakdown panel lets an operator group by — a DELIBERATELY
 * separate concept from "physical blob position" (BLOB_ORDER in adoption.ts).
 * Every entry here must also be a BLOB_ORDER entry, but not every BLOB_ORDER
 * entry belongs here: `workspace` is the AE sampling index, not a breakdown
 * column, and `plan` is a reserved-but-unpopulated blob slot (see
 * adoption.ts) that no caller ever sets — querying it would only ever return
 * one row with `value: ""`, so it is left out of the UI's "Group by" list
 * and out of this type.
 */
export type BreakdownDimension = "surface" | "contentType" | "client" | "repo";

const BREAKDOWN_DIMENSIONS: readonly BreakdownDimension[] = [
  "surface",
  "contentType",
  "client",
  "repo",
];

export interface BreakdownRow {
  value: string;
  events: number;
  bytes: number;
}

export type BreakdownResult =
  | { available: true; rows: BreakdownRow[] }
  | { available: false; reason: string };

/**
 * Blob ordinals for each queryable dimension, DERIVED from BLOB_ORDER (the
 * single source of truth for the write-side contract in adoption.ts) rather
 * than hand-repeated here. AE columns are positional and 1-indexed
 * (`blob1`, `blob2`, ...) while BLOB_ORDER is a 0-indexed array, hence the
 * `+ 1`. Appending a dimension to BLOB_ORDER is safe; reordering or removing
 * one rewrites the meaning of historical rows.
 */
const BLOB_COLUMN: Record<BreakdownDimension, string> = Object.fromEntries(
  BREAKDOWN_DIMENSIONS.map((dimension) => {
    const index = BLOB_ORDER.indexOf(dimension);
    // This runs at module init, so a BLOB_ORDER edit that drops or renames a
    // dimension this map depends on fails loudly at startup — instead of
    // `indexOf` silently returning -1, deriving `blob0` (not a real AE
    // column), and only surfacing later as a runtime `query_failed`.
    if (index < 0) throw new Error(`breakdown dimension "${dimension}" is not in BLOB_ORDER`);
    return [dimension, `blob${index + 1}`];
  }),
) as Record<BreakdownDimension, string>;

export function breakdownQuery(dimension: BreakdownDimension, days: number): string {
  const column = BLOB_COLUMN[dimension];
  const window = Number.isFinite(days) ? Math.max(1, Math.min(90, Math.floor(days))) : 30;
  // _sample_interval scales sampled rows back to a real-world estimate; a raw
  // COUNT() under-reports whenever AE has sampled.
  return `SELECT ${column} AS value,
                 SUM(_sample_interval) AS events,
                 SUM(double1 * _sample_interval) AS bytes
          FROM ${DATASET}
          WHERE timestamp > NOW() - INTERVAL '${window}' DAY
          GROUP BY value
          ORDER BY events DESC
          LIMIT 20`;
}

export async function fetchBreakdown(
  env: Env,
  dimension: BreakdownDimension,
  days: number,
  fetchImpl: typeof fetch = fetch,
): Promise<BreakdownResult> {
  // Object.hasOwn (not the `in` operator) so prototype-chain keys like
  // "toString" or "constructor" can never slip past this allowlist.
  if (!Object.hasOwn(BLOB_COLUMN, dimension))
    return { available: false, reason: "invalid_dimension" };

  const account = (env as { CLOUDFLARE_ACCOUNT_ID?: string }).CLOUDFLARE_ACCOUNT_ID;
  const token = (env as { ANALYTICS_API_TOKEN?: string }).ANALYTICS_API_TOKEN;
  if (!account || !token) return { available: false, reason: "not_configured" };

  try {
    const res = await fetchImpl(`${SQL_ENDPOINT}/${account}/analytics_engine/sql`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: breakdownQuery(dimension, days),
    });
    if (!res.ok) return { available: false, reason: "query_failed" };
    const payload = (await res.json()) as { data?: unknown };
    if (payload.data !== undefined && !Array.isArray(payload.data)) {
      return { available: false, reason: "query_failed" };
    }
    return { available: true, rows: (payload.data as BreakdownRow[] | undefined) ?? [] };
  } catch {
    return { available: false, reason: "query_failed" };
  }
}

/** Windows the /admin-ui/metrics/slow-ops panel offers — 24 hours or 7 days. */
export type SlowOpWindow = "24h" | "7d";

const SLOW_OP_WINDOW_HOURS: Record<SlowOpWindow, number> = { "24h": 24, "7d": 168 };

export interface SlowOpRow {
  op: string;
  count: number;
  p50WallMs: number;
  p95WallMs: number;
}

export type SlowOpsResult =
  | { available: true; rows: SlowOpRow[] }
  | { available: false; reason: string };

const SLOW_OP_BLOB_COLUMN: Record<(typeof SLOW_OP_BLOB_ORDER)[number], string> = Object.fromEntries(
  SLOW_OP_BLOB_ORDER.map((key, index) => [key, `blob${index + 1}`]),
) as Record<(typeof SLOW_OP_BLOB_ORDER)[number], string>;

/**
 * Aggregates the `uploads_slow_ops` dataset (written by
 * `slow-op-analytics.ts`'s `writeSlowOpPoint`) by op name: an event count
 * (scaled by `_sample_interval` the same way `breakdownQuery` does) plus
 * median/p95 wall-clock ms. `quantile(0.5|0.95)(...)` is Analytics Engine
 * SQL's ClickHouse-derived quantile function — approximate, which is the
 * right tradeoff for an operator trend panel.
 */
export function slowOpsQuery(window: SlowOpWindow): string {
  const opColumn = SLOW_OP_BLOB_COLUMN.op;
  const wallColumn = "double1";
  const hours = SLOW_OP_WINDOW_HOURS[window];
  return `SELECT ${opColumn} AS op,
                 SUM(_sample_interval) AS count,
                 quantile(0.5)(${wallColumn}) AS p50WallMs,
                 quantile(0.95)(${wallColumn}) AS p95WallMs
          FROM ${SLOW_OP_DATASET}
          WHERE timestamp > NOW() - INTERVAL '${hours}' HOUR
          GROUP BY op
          ORDER BY count DESC
          LIMIT 20`;
}

export async function fetchSlowOps(
  env: Env,
  window: SlowOpWindow,
  fetchImpl: typeof fetch = fetch,
): Promise<SlowOpsResult> {
  const account = (env as { CLOUDFLARE_ACCOUNT_ID?: string }).CLOUDFLARE_ACCOUNT_ID;
  const token = (env as { ANALYTICS_API_TOKEN?: string }).ANALYTICS_API_TOKEN;
  if (!account || !token) return { available: false, reason: "not_configured" };

  try {
    const res = await fetchImpl(`${SQL_ENDPOINT}/${account}/analytics_engine/sql`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: slowOpsQuery(window),
    });
    if (!res.ok) return { available: false, reason: "query_failed" };
    const payload = (await res.json()) as { data?: unknown };
    if (payload.data !== undefined && !Array.isArray(payload.data)) {
      return { available: false, reason: "query_failed" };
    }
    return { available: true, rows: (payload.data as SlowOpRow[] | undefined) ?? [] };
  } catch {
    return { available: false, reason: "query_failed" };
  }
}
