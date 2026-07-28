/**
 * Analytics Engine read path for the operator metrics breakdown panel.
 *
 * AE has no read binding, so this goes over the Cloudflare SQL API with an
 * account token (ANALYTICS_API_TOKEN, an account token carrying "Account
 * Analytics: Read", set via `wrangler secret put`). That token is distinct
 * from the local wrangler token in .env.
 *
 * EVERY failure mode returns `{ available: false, reason }` rather than
 * throwing: this panel is additive, and the D1-backed half of the metrics
 * page must keep working when AE is unconfigured or unreachable.
 *
 * Retention is 90 days — AE is for recent dimensional curiosity, never the
 * durable record. That lives in `daily_metrics`.
 */

const SQL_ENDPOINT = "https://api.cloudflare.com/client/v4/accounts";
const DATASET = "uploads_adoption";

export type BreakdownDimension = "surface" | "contentType" | "client" | "plan" | "repo";

export interface BreakdownRow {
  value: string;
  events: number;
  bytes: number;
}

export type BreakdownResult =
  | { available: true; rows: BreakdownRow[] }
  | { available: false; reason: string };

/**
 * Blob ordinals, matching BLOB_ORDER in adoption.ts. AE columns are
 * positional, so this mapping is a contract with the write path — appending
 * is safe, reordering rewrites the meaning of historical rows.
 */
const BLOB_COLUMN: Record<BreakdownDimension, string> = {
  surface: "blob2",
  contentType: "blob3",
  client: "blob4",
  plan: "blob5",
  repo: "blob6",
};

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
