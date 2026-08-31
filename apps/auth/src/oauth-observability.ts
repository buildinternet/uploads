/**
 * Issue #912: lightweight Analytics Engine signal for OAuth refresh-grant
 * health at `/oauth2/token` — a follow-up to #909 (refresh-token rotation
 * reuse grace) and #911 (offline_access wasn't granted, so no client ever
 * got a refresh token). Before this, the only detector for either failure
 * mode was a user report.
 *
 * `@better-auth/oauth-provider` is a dependency — this module never patches
 * it. Everything here observes from OUTSIDE, via two hooks wired onto
 * `betterAuth({ hooks })` in auth.ts:
 *
 *  - `hooks.before` snapshots the presented refresh token's D1 row (revoked
 *    + rotation-replay-window state) BEFORE the plugin's handler runs. This
 *    is the only extra query this module ever issues, and it only runs for
 *    `grant_type=refresh_token` requests at `/oauth2/token` — not on the
 *    general request path (get-session, sign-in, etc.), which stays exactly
 *    as cheap as before.
 *  - `hooks.after` reads the handler's outcome (`ctx.context.returned`,
 *    either the success JSON body or the thrown `APIError`) plus the
 *    before-hook's snapshot, classifies the request, and fires at most one
 *    Analytics Engine data point.
 *
 * The before/after snapshot handoff rides on the mutable `ctx` object
 * `createAuthMiddleware` hands each hook: Better Auth's dispatcher passes
 * the SAME context through before → handler → after for a single request
 * (see `dispatchAuthEndpoint` in better-auth's `api/dispatch.mjs`) as long
 * as no hook rewrites `body`/`query` — this module's before-hook never
 * does, so the object identity holds. If Better Auth ever changes that and
 * the stashed snapshot goes missing, `refreshTokenAfterHook` degrades to
 * treating the request as unclassified rather than throwing or guessing.
 *
 * Event payloads are minimal by design (repo rule, and this issue's own
 * ask): client_id, an opaque userId, the grant type, and an OAuth error
 * code where relevant. Never a token value, never an email.
 */
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { APIError, createAuthMiddleware } from "better-auth/api";
import * as schema from "./schema";

/** Auth worker env slice this module needs — mirrors apps/api's ANALYTICS/SLOW_OPS optionality. */
export type AuthEventsEnv = {
  AUTH_EVENTS?: AnalyticsEngineDataset;
};

/**
 * Event names this module ever writes. Kept as a literal union (not derived
 * from the AE call sites) so `classifyOAuthTokenEvent`'s return type alone
 * documents the full observability surface for #912.
 */
export type AuthEventName =
  /** RFC 9700 §4.14 teardown: a revoked refresh token was reused OUTSIDE the
   * 60s reuse grace, so the plugin tore down the whole family. */
  | "refresh_family_invalidated"
  /** A revoked refresh token was reused WITHIN the 60s reuse grace — #909's
   * absorption path. Fires whether the plugin replayed a cached response or
   * (rare — see classifyOAuthTokenEvent) failed anyway. */
  | "refresh_rotation_replay"
  /** Any other refresh-grant failure at /oauth2/token, by RFC 6749 error
   * code (invalid_grant for an unknown/expired/wrong-client token,
   * invalid_scope, invalid_target, ...). */
  | "refresh_grant_failed"
  /** A token grant (authorization_code or refresh_token) succeeded but the
   * response carried no refresh_token — the exact shape #911 was. */
  | "token_grant_without_refresh";

/** Fields every AE data point below may carry. Never a token value or email. */
export type AuthEventFields = {
  clientId?: string;
  userId?: string;
  grantType?: string;
  errorCode?: string;
};

/**
 * Blob ordinal contract for the `uploads_auth_events` dataset — Analytics
 * Engine has no column names. Append new fields at the END; never reorder
 * or remove, or historical rows change meaning retroactively (same
 * convention as apps/api's SLOW_OP_BLOB_ORDER).
 */
export const AUTH_EVENT_BLOB_ORDER = [
  "event",
  "clientId",
  "grantType",
  "errorCode",
  "userId",
] as const;

/**
 * Writes one Analytics Engine data point for an OAuth token-endpoint event.
 * Never throws and never awaits — an absent AUTH_EVENTS binding (unit
 * tests, self-hosters, local dev without the binding configured) is a
 * silent no-op, same contract as apps/api's writeSlowOpPoint/writeAdoptionPoint.
 */
export function writeAuthEventPoint(
  env: AuthEventsEnv,
  name: AuthEventName,
  fields: AuthEventFields,
): void {
  const analytics = env.AUTH_EVENTS;
  if (!analytics) return;
  try {
    analytics.writeDataPoint({
      // Sampling key: one noisy client/error combo can't crowd out the rest.
      indexes: [name],
      blobs: [
        name,
        fields.clientId ?? "",
        fields.grantType ?? "",
        fields.errorCode ?? "",
        fields.userId ?? "",
      ],
      doubles: [1],
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(JSON.stringify({ message: "auth event analytics write failed", error: message }));
  }
}

/**
 * SHA-256, base64url, no padding — mirrors `@better-auth/oauth-provider`'s
 * `defaultHasher`, the storage form its `oauth_refresh_token.token` column
 * holds under the default (unconfigured) `storeTokens: "hashed"`. Pinned
 * here, not imported, because the plugin doesn't export it — see the
 * module doc comment on why this module never patches the plugin.
 * `refresh token rotation reuse grace` in oauth.test.ts (PR #910) already
 * relies on the identical mirror for its own D1 assertions.
 */
export async function hashOAuthToken(raw: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

/** The presented refresh token's revocation/replay-window state at request start. */
export type RefreshTokenSnapshot = {
  clientId: string;
  userId: string;
  revoked: boolean;
  withinReuseInterval: boolean;
};

/**
 * Mirrors `isWithinRefreshTokenReuseInterval` in `@better-auth/oauth-provider`:
 * a row counts as "within the reuse grace" only once it's actually been
 * rotated (rotatedAt set) and that rotation's replay window hasn't lapsed.
 */
function isWithinReuseInterval(row: {
  rotatedAt: Date | null;
  rotationReplayExpiresAt: Date | null;
}): boolean {
  return (
    Boolean(row.rotatedAt) &&
    Boolean(row.rotationReplayExpiresAt) &&
    (row.rotationReplayExpiresAt as Date) >= new Date()
  );
}

/**
 * Looks up the refresh token a `/oauth2/token` request presented, BEFORE
 * the plugin's handler processes it. The only extra D1 read this module
 * ever issues, and only for `grant_type=refresh_token` requests — every
 * other path (including every other OAuth grant type) is untouched.
 * Never throws: a lookup failure just means the after-hook can't classify
 * this request beyond its raw success/failure outcome.
 */
export async function snapshotPresentedRefreshToken(
  db: ReturnType<typeof drizzle<typeof schema>>,
  rawToken: string,
): Promise<RefreshTokenSnapshot | undefined> {
  try {
    const hashed = await hashOAuthToken(rawToken);
    const [row] = await db
      .select({
        clientId: schema.oauthRefreshToken.clientId,
        userId: schema.oauthRefreshToken.userId,
        revoked: schema.oauthRefreshToken.revoked,
        rotatedAt: schema.oauthRefreshToken.rotatedAt,
        rotationReplayExpiresAt: schema.oauthRefreshToken.rotationReplayExpiresAt,
      })
      .from(schema.oauthRefreshToken)
      .where(eq(schema.oauthRefreshToken.token, hashed))
      .limit(1);
    if (!row) return undefined;
    return {
      clientId: row.clientId,
      userId: row.userId,
      revoked: Boolean(row.revoked),
      withinReuseInterval: isWithinReuseInterval(row),
    };
  } catch {
    return undefined;
  }
}

/** Pure classification input — kept independent of `ctx`/`APIError` so tests need no fake middleware context. */
export type OAuthTokenOutcome = {
  grantType?: string;
  clientId?: string;
  /** True when the handler threw (an RFC 6749 error response). */
  failed: boolean;
  /** RFC 6749 `error` field of a failed response, e.g. "invalid_grant". */
  errorCode?: string;
  /** True when a successful response body carried a non-empty `refresh_token`. */
  hasRefreshToken?: boolean;
  snapshot?: RefreshTokenSnapshot;
};

/**
 * Classifies one `/oauth2/token` request into at most one #912 event.
 * Pure — no I/O, no `ctx` — so oauth-observability.test.ts can cover every
 * branch directly. `refreshTokenAfterHook` below is the only caller in
 * production and does nothing but gather this shape and forward the result
 * to `writeAuthEventPoint`.
 *
 * Decision order for `grant_type=refresh_token`:
 *  1. Presented token was already revoked (from the before-hook snapshot):
 *     - within the 60s reuse grace → `refresh_rotation_replay` (RFC 9700
 *       absorption path; the plugin serves a cached rotation response here,
 *       or — rarely, if the cached replay went missing — fails anyway. The
 *       "replay was attempted" fact is what matters for #912, not which of
 *       those two the plugin managed).
 *     - outside the grace → `refresh_family_invalidated` (the plugin calls
 *       `invalidateRefreshFamily` before throwing `invalid_grant`).
 *  2. No snapshot (unknown/foreign/garbage token) and the grant failed →
 *     `refresh_grant_failed` with whatever RFC 6749 error code came back
 *     (covers invalid_scope/invalid_target too, not just invalid_grant).
 *  3. Grant succeeded and the response has no `refresh_token` →
 *     `token_grant_without_refresh` (the exact #911 shape).
 *
 * `authorization_code` grants only ever reach case 3 (no snapshot/replay
 * logic applies — there's no prior refresh token to reuse).
 */
export function classifyOAuthTokenEvent(
  outcome: OAuthTokenOutcome,
): { name: AuthEventName; fields: AuthEventFields } | null {
  const { grantType, snapshot } = outcome;
  const clientId = outcome.clientId ?? snapshot?.clientId;

  if (grantType === "refresh_token" && snapshot?.revoked) {
    return snapshot.withinReuseInterval
      ? {
          name: "refresh_rotation_replay",
          fields: { clientId, userId: snapshot.userId, grantType },
        }
      : {
          name: "refresh_family_invalidated",
          fields: { clientId, userId: snapshot.userId, grantType },
        };
  }

  if (outcome.failed) {
    if (grantType !== "refresh_token") return null;
    return {
      name: "refresh_grant_failed",
      fields: { clientId, grantType, errorCode: outcome.errorCode ?? "unknown" },
    };
  }

  if (
    (grantType === "refresh_token" || grantType === "authorization_code") &&
    !outcome.hasRefreshToken
  ) {
    return { name: "token_grant_without_refresh", fields: { clientId, grantType } };
  }

  return null;
}

/**
 * Shape of the stashed before-hook snapshot. Stored on `ctx.context` (Better
 * Auth's shared per-request `AuthContext`, holding things like `returned`
 * and `session`) rather than directly on `ctx` itself: `runBeforeHooks`
 * (better-auth's `api/dispatch.mjs`) invokes the before-hook with `{
 * ...context, returnHeaders: true }` — a SHALLOW spread copy — so a field
 * written straight onto that spread copy is discarded, but `ctx.context` is
 * a nested object reference the spread preserves, and `runAfterHooks` calls
 * the after-hook with the original context object directly. Verified
 * against better-auth 1.7.1's dispatcher; if a future version stops sharing
 * `ctx.context` across before/after, this degrades to `snapshot: undefined`
 * (see classifyOAuthTokenEvent's case 2) rather than misclassifying.
 */
const SNAPSHOT_KEY = "__uploads_auth_events_snapshot__";
type SnapshotCarrier = { [SNAPSHOT_KEY]?: RefreshTokenSnapshot };

/**
 * `hooks.before` half: snapshots the presented refresh token's D1 state
 * ahead of the plugin's own handler. No-op (and no query) for any request
 * other than `POST /oauth2/token` with `grant_type=refresh_token`.
 *
 * Plain async function, not a `createAuthMiddleware`-wrapped one: Better
 * Auth's `hooks.before` slot takes exactly one handler, and auth.ts's
 * `authBeforeHook` already owns it (CIMD/DCR scope rewrite, last-admin
 * guard). This just needs to run as one more step inside that same
 * function, sharing its `ctx` — see the call site in auth.ts.
 */
export async function snapshotBeforeOAuthTokenRequest(
  ctx: { path: string; body?: unknown; context: unknown },
  env: { DB: D1Database },
): Promise<void> {
  if (ctx.path !== "/oauth2/token") return;
  const body = ctx.body as Record<string, unknown> | undefined;
  if (body?.grant_type !== "refresh_token" || typeof body.refresh_token !== "string") return;
  const db = drizzle(env.DB, { schema });
  const snapshot = await snapshotPresentedRefreshToken(db, body.refresh_token);
  if (snapshot) (ctx.context as SnapshotCarrier)[SNAPSHOT_KEY] = snapshot;
}

/**
 * `hooks.after` half: reads the handler's outcome plus the before-hook's
 * snapshot (if any), classifies, and fires at most one AE point. No-op for
 * any request other than `POST /oauth2/token`.
 */
export function refreshTokenAfterHook(env: AuthEventsEnv) {
  return createAuthMiddleware(async (ctx) => {
    if (ctx.path !== "/oauth2/token") return;
    const body = ctx.body as Record<string, unknown> | undefined;
    const grantType = typeof body?.grant_type === "string" ? body.grant_type : undefined;
    const clientId = typeof body?.client_id === "string" ? body.client_id : undefined;
    const snapshot = (ctx.context as SnapshotCarrier)[SNAPSHOT_KEY];
    const returned = (ctx.context as unknown as { returned?: unknown }).returned;

    const failed = returned instanceof APIError;
    const errorCode = failed
      ? ((returned as APIError).body as { error?: string } | undefined)?.error
      : undefined;
    const hasRefreshToken =
      !failed && Boolean((returned as { refresh_token?: unknown } | undefined)?.refresh_token);

    const event = classifyOAuthTokenEvent({
      grantType,
      clientId,
      failed,
      errorCode,
      hasRefreshToken,
      snapshot,
    });
    if (event) writeAuthEventPoint(env, event.name, event.fields);
  });
}
