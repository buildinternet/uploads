/**
 * Per-workspace read limiter (issue #829 §3).
 *
 * Authenticated reads previously had no rate limit of their own: the only
 * per-workspace limiters were for mutations (`WRITE_LIMITER`), renders,
 * poster generation, and public intake. Those quotas are untouched here — a
 * read never consumes them, and a write never consumes a read budget.
 *
 * Two tiers, because the cost of a read varies by an order of magnitude:
 *
 *  - **normal** (`READ_LIMITER`): an object-store listing the caller asked
 *    not to hydrate (`?metadata=0`), plus the cheap point reads on the files
 *    vertical (`file-url`). One R2 list or one narrow lookup.
 *  - **tight** (`HEAVY_READ_LIMITER`): metadata search, facet discovery, the
 *    by-path grouping, and a metadata-hydrated listing. Each of these fans
 *    out into D1 with per-row work proportional to the page, so they are the
 *    shapes worth bounding separately.
 *
 * Classification is derived from the request, never from a caller-supplied
 * hint: `?metadata=0`/`false` is the same opt-out `routes/workspace-files.ts`
 * already honors for hydration (issue #829 §5), so an unhydrated listing pays
 * the normal limit and a hydrated one pays the tight limit — the parameter
 * that removes the work also removes the tighter bound.
 *
 * Both fail open when their binding is absent, matching every other limiter
 * in `guards.ts` (a self-hoster may drop the block entirely).
 */
import type { MiddlewareHandler } from "hono";
import { makeRateLimitGuard } from "./guards";
import type { WorkspaceVars } from "./workspace";

/**
 * Window length of both read limiters, mirrored from their `simple.period` in
 * `wrangler.jsonc`. Sizing lives there (the same mechanism every other
 * limiter is configured through); this constant only feeds `Retry-After`.
 */
export const READ_LIMIT_WINDOW_SECONDS = 60;

const normalGuard = makeRateLimitGuard("READ_LIMITER", "read rate limit exceeded", {
  windowSeconds: READ_LIMIT_WINDOW_SECONDS,
  code: "read_rate_limited",
});

const tightGuard = makeRateLimitGuard("HEAVY_READ_LIMITER", "read rate limit exceeded", {
  windowSeconds: READ_LIMIT_WINDOW_SECONDS,
  code: "read_rate_limited",
});

export const allowRead = normalGuard.allow;
export const allowHeavyRead = tightGuard.allow;

export type ReadTier = "normal" | "tight";

/**
 * Whether a canonical listing request asked for D1 metadata hydration.
 * Mirrors the `metadata=0`/`metadata=false` opt-out in
 * `routes/workspace-files.ts` exactly — the two must not drift, or a caller
 * could pay the tight limit for work the handler skipped.
 */
export function listingIsHydrated(metadataParam: string | undefined): boolean {
  return !(metadataParam === "0" || metadataParam === "false");
}

/** Which tier a canonical listing request falls into. */
export function classifyListingRead(metadataParam: string | undefined): ReadTier {
  return listingIsHydrated(metadataParam) ? "tight" : "normal";
}

function enforce(tier: ReadTier): MiddlewareHandler<WorkspaceVars> {
  const guard = tier === "tight" ? tightGuard : normalGuard;
  return async (c, next) => {
    const env = c.env as never;
    if (!(await guard.allow(env, c.get("workspaceName")))) guard.reject();
    await next();
  };
}

const normalMiddleware = enforce("normal");
const tightMiddleware = enforce("tight");

/**
 * Cheap authenticated reads: point lookups on the files vertical. Mount after
 * the auth middleware that sets `workspaceName`, so the bucket is
 * per-workspace rather than global.
 */
export const readRateLimit: MiddlewareHandler<WorkspaceVars> = normalMiddleware;

/**
 * Always-expensive reads: search, facets, by-path grouping. Tier is fixed by
 * the route, never inferred from the URL.
 */
export const heavyReadRateLimit: MiddlewareHandler<WorkspaceVars> = tightMiddleware;

/**
 * Canonical listing, whose tier depends on whether the caller asked for
 * metadata hydration. `?metadata=0` drops it to the normal tier because the
 * handler genuinely skips the D1 pass in that case.
 */
export const listingReadRateLimit: MiddlewareHandler<WorkspaceVars> = async (c, next) => {
  const tier = classifyListingRead(c.req.query("metadata"));
  return (tier === "tight" ? tightMiddleware : normalMiddleware)(c, next);
};

/**
 * Tier for the legacy bearer listing (`GET /v1/:workspace/files`), whose
 * metadata parameter runs the other way: that route lists from object storage
 * and hydrates only on `?metadata=1`, and switches to the D1 search path
 * entirely once any `meta.*` filter or `?name=` is present. Both of those are
 * the expensive shapes, so both pay the tight limit; a bare prefix list does
 * not.
 */
export function classifyLegacyListingRead(query: Record<string, string>): ReadTier {
  if (query.name !== undefined) return "tight";
  if (Object.keys(query).some((key) => key.startsWith("meta."))) return "tight";
  const metadata = query.metadata;
  return metadata !== undefined && metadata !== "0" && metadata !== "false" ? "tight" : "normal";
}

export const legacyListingReadRateLimit: MiddlewareHandler<WorkspaceVars> = async (c, next) => {
  const tier = classifyLegacyListingRead(c.req.query());
  return (tier === "tight" ? tightMiddleware : normalMiddleware)(c, next);
};
