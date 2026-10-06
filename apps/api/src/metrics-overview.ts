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

import { fetchUploadClassSeries, type UploadClassSeriesResult } from "./analytics-engine";
import { dbFor } from "./db-session";
import { fillDaySeries } from "./day-series";
import { listWorkspaceByobStatus } from "./workspace-byob";
import {
  countActiveWorkspaces,
  deriveUploadSummary,
  deriveWorkspaceActivity,
  featureTotals,
  multiIdentityWorkspaces,
  platformSeries,
  platformStorage,
  rowsSince,
  windowStart,
  workspaceDaySeries,
  workspacesWithGithubApp,
  type DayPoint,
  type MultiIdentityWorkspace,
  type WorkspaceActivity,
  type UploadDaySummary,
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
    /** Workspaces with at least one `github_repo_links` row that has the GitHub App installed. */
    workspacesWithGithubApp: number;
    /**
     * Registered workspaces storing objects in their own bucket (`isByoRecord`).
     * `null` when the registry could not be read — unknown, not zero (#1094).
     */
    workspacesWithByob: number | null;
  };
  series: {
    uploads: DayPoint[];
    users: SignupPoint[];
    orgs: SignupPoint[];
    /** Per-day upload counts by media class, from Analytics Engine. Degrades when AE is unavailable. */
    uploadClasses: UploadClassSeriesResult;
    /**
     * Bounded per-day attribution (D1-exact): total plus the top 3
     * contributors, for the bar tooltip. Full per-day and per-workspace
     * detail is fetched on demand from `/admin-ui/metrics/uploads/*`.
     */
    uploadsByDay: UploadDaySummary[];
    /** Workspaces for the chart filter: top 50 by window volume. */
    uploadWorkspaces: { workspace: string; count: number }[];
  };
  features: Record<string, number>;
  workspaces: (WorkspaceActivity & { byob: boolean })[];
  /**
   * Workspaces with two or more distinct `minting_user_id` values in
   * `auth_tokens` — a read-only revisit trigger for the actor-on-PR gate
   * (issue #579). Not window-scoped: `auth_tokens` has no window semantics,
   * so this is all-time, same as `totals.users`/`totals.orgs`.
   */
  multiIdentityWorkspaces: MultiIdentityWorkspace[];
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
  return `metrics:overview:v5:${days}`;
}

/**
 * Names of registered workspaces on their own bucket, read from the `ws:` key
 * metadata on the paged registry list (one KV list, not a read per workspace).
 * Records written before #1094 and not yet backfilled fall back to one read
 * each. Returns `null` — "unknown", not "none" — when the registry can't be
 * read, so a KV failure never renders as a confident 0.
 */
async function byobWorkspaces(env: Env): Promise<Set<string> | null> {
  try {
    const status = await listWorkspaceByobStatus(env);
    return new Set([...status].filter(([, byob]) => byob).map(([name]) => name));
  } catch (err) {
    console.error("metrics overview: byob status unavailable", err);
    return null;
  }
}

/**
 * Signup history from the auth worker. Degrades to zeros rather than failing
 * the page: the D1-backed half of the overview is still worth showing.
 *
 * A non-OK response and a thrown/parse failure both fall through to
 * EMPTY_AUTH above, but a malformed 200 (null body, or one missing `totals`)
 * would otherwise pass straight through and only blow up later at
 * `auth.totals.users` in buildOverview — OUTSIDE this try/catch, turning into
 * a 500 for the entire page. Normalize the shape here instead of trusting it.
 */
async function authMetrics(env: Env, since: string): Promise<AuthMetrics> {
  try {
    const res = await env.AUTH.fetch(`https://auth.internal/internal/metrics?since=${since}`, {
      headers: { "x-uploads-internal": "1" },
    });
    if (!res.ok) return EMPTY_AUTH;
    const body = (await res.json()) as Partial<AuthMetrics> | null;
    return {
      users: Array.isArray(body?.users) ? body.users : [],
      orgs: Array.isArray(body?.orgs) ? body.orgs : [],
      totals: {
        users: typeof body?.totals?.users === "number" ? body.totals.users : 0,
        orgs: typeof body?.totals?.orgs === "number" ? body.totals.orgs : 0,
      },
    };
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

  const [
    uploads,
    features,
    workspaceRows,
    storage,
    auth,
    multiIdentity,
    githubApp,
    uploadClasses,
    byob,
  ] = await Promise.all([
    platformSeries(dbFor(env), "upload", since),
    featureTotals(dbFor(env), since),
    // The per-workspace rows are read ONCE, over the wider of the selected
    // window and the 30-day active window. The activity table, the 7d/30d
    // active counts and the per-workspace series are all derived from them in
    // JS below (D1 bills rows read, and every narrower window is a subset).
    workspaceDaySeries(dbFor(env), since < since30 ? since : since30),
    platformStorage(dbFor(env)),
    authMetrics(env, since),
    multiIdentityWorkspaces(dbFor(env)),
    workspacesWithGithubApp(dbFor(env)),
    fetchUploadClassSeries(env, days, fetch, now),
    byobWorkspaces(env),
  ]);

  const uploadSummary = deriveUploadSummary(rowsSince(workspaceRows, since));
  const table = deriveWorkspaceActivity(workspaceRows, since, githubApp);

  // Sparse SQL rows → one point per calendar day so the charts' bar
  // spacing matches the selected window (quiet days plot as 0).
  const uploadsFilled = fillDaySeries(since, days, uploads, (day) => ({
    day,
    count: 0,
    bytes: 0,
  }));
  const usersFilled = fillDaySeries(since, days, auth.users, (day) => ({ day, count: 0 }));
  const orgsFilled = fillDaySeries(since, days, auth.orgs, (day) => ({ day, count: 0 }));
  const uploadClassesFilled: UploadClassSeriesResult = uploadClasses.available
    ? {
        available: true,
        days: fillDaySeries(since, days, uploadClasses.days, (day) => ({
          day,
          image: 0,
          video: 0,
          other: 0,
        })),
      }
    : uploadClasses;

  return {
    window: { days, since },
    totals: {
      users: auth.totals.users,
      orgs: auth.totals.orgs,
      workspaces: storage.workspaces,
      storedBytes: storage.storedBytes,
      activeWorkspaces7d: countActiveWorkspaces(workspaceRows, since7),
      activeWorkspaces30d: countActiveWorkspaces(workspaceRows, since30),
      uploads: uploadsFilled.reduce((sum, point) => sum + point.count, 0),
      bytes: uploadsFilled.reduce((sum, point) => sum + point.bytes, 0),
      workspacesWithGithubApp: githubApp.size,
      workspacesWithByob: byob ? byob.size : null,
    },
    series: {
      uploads: uploadsFilled,
      users: usersFilled,
      orgs: orgsFilled,
      uploadClasses: uploadClassesFilled,
      uploadsByDay: uploadSummary.byDay,
      uploadWorkspaces: uploadSummary.workspaces,
    },
    features,
    workspaces: table.map((row) => ({ ...row, byob: byob?.has(row.workspace) ?? false })),
    multiIdentityWorkspaces: multiIdentity,
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
