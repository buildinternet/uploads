/**
 * Composes the operator metrics overview from the D1 rollups (this worker)
 * and signup history (the auth worker, over the AUTH service binding — never
 * a direct cross-database read).
 *
 * Cached in KV because D1 bills rows read: the TTL bounds cost by elapsed
 * time rather than by page loads. Cache keys live under the `metrics:` prefix
 * and are NOT workspace records, so the `mutateWorkspaceRecord` discipline
 * that governs `ws:` keys does not apply here.
 */

import {
  activeWorkspacesSince,
  featureTotals,
  platformSeries,
  platformStorage,
  windowStart,
  workspaceActivity,
  type DayPoint,
  type WorkspaceActivity,
} from "./adoption-queries";

export const OVERVIEW_CACHE_TTL = 600;

/** Windows the UI offers. Anything else is rejected, so the cache stays small. */
export const ALLOWED_WINDOWS = [7, 30, 90] as const;

export interface SignupPoint {
  day: string;
  count: number;
}

export interface MetricsOverview {
  window: { days: number; since: string };
  totals: {
    /** All-time, from the auth worker. */
    users: number;
    /** All-time registered organizations, from the auth worker. */
    orgs: number;
    /** Workspaces with at least one recorded upload (not registrations). */
    workspaces: number;
    /** Current absolute stored bytes, from `workspace_usage`. */
    storedBytes: number;
    activeWorkspaces7d: number;
    activeWorkspaces30d: number;
    /** Uploads within the selected window. */
    uploads: number;
    /** Bytes uploaded within the selected window — not stored bytes. */
    bytes: number;
  };
  series: {
    uploads: DayPoint[];
    users: SignupPoint[];
    orgs: SignupPoint[];
  };
  features: Record<string, number>;
  workspaces: WorkspaceActivity[];
}

interface AuthMetrics {
  users: SignupPoint[];
  orgs: SignupPoint[];
  totals: { users: number; orgs: number };
}

const EMPTY_AUTH: AuthMetrics = {
  users: [],
  orgs: [],
  totals: { users: 0, orgs: 0 },
};

export function overviewCacheKey(days: number): string {
  return `metrics:overview:v1:${days}`;
}

/**
 * Signup history from the auth worker. Degrades to zeros rather than failing
 * the page: the D1-backed half of the overview is still worth showing.
 */
async function authMetrics(env: Env, since: string): Promise<AuthMetrics> {
  try {
    const res = await env.AUTH.fetch(`https://auth.internal/internal/metrics?since=${since}`, {
      headers: { "x-uploads-internal": "1" },
    });
    if (!res.ok) return EMPTY_AUTH;
    return (await res.json()) as AuthMetrics;
  } catch {
    return EMPTY_AUTH;
  }
}

export async function buildOverview(
  env: Env,
  days: number,
  now = new Date(),
): Promise<MetricsOverview> {
  const since = windowStart(days, now);
  const since7 = windowStart(7, now);
  const since30 = windowStart(30, now);

  const [uploads, features, table, active30, storage, auth] = await Promise.all([
    platformSeries(env.DB, "upload", since),
    featureTotals(env.DB, since),
    workspaceActivity(env.DB, since),
    // Scans the 30-day window ONCE; the 7-day count is derived below by
    // filtering these same rows rather than issuing a second query — the
    // last 7 days of index entries are always a subset of the last 30, so a
    // separate activeWorkspaceCount(since7) call would just re-read them
    // (D1 bills rows read).
    activeWorkspacesSince(env.DB, since30),
    platformStorage(env.DB),
    authMetrics(env, since),
  ]);

  return {
    window: { days, since },
    totals: {
      users: auth.totals.users,
      orgs: auth.totals.orgs,
      workspaces: storage.workspaces,
      storedBytes: storage.storedBytes,
      activeWorkspaces7d: active30.filter((w) => w.lastActive >= since7).length,
      activeWorkspaces30d: active30.length,
      uploads: uploads.reduce((sum, point) => sum + point.count, 0),
      bytes: uploads.reduce((sum, point) => sum + point.bytes, 0),
    },
    series: { uploads, users: auth.users, orgs: auth.orgs },
    features,
    workspaces: table,
  };
}

/** Cached read. Cache failures fall through to a live build, never a 500. */
export async function cachedOverview(
  env: Env,
  days: number,
  fresh: boolean,
  now = new Date(),
): Promise<MetricsOverview> {
  const key = overviewCacheKey(days);
  if (!fresh) {
    try {
      const hit = await env.REGISTRY.get(key);
      if (hit) return JSON.parse(hit) as MetricsOverview;
    } catch {
      // fall through to a live build
    }
  }
  const overview = await buildOverview(env, days, now);
  try {
    await env.REGISTRY.put(key, JSON.stringify(overview), { expirationTtl: OVERVIEW_CACHE_TTL });
  } catch {
    // caching is an optimization, never a requirement
  }
  return overview;
}
