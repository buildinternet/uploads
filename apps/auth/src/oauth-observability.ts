/**
 * Issue #912: lightweight Analytics Engine signals for OAuth refresh-grant
 * failures and rotation-replay hits. `@better-auth/oauth-provider` is a
 * dependency we don't patch (see auth.ts's long comments on that plugin), so
 * every signal here is observed from OUTSIDE it, via Better Auth's
 * `hooks.before`/`hooks.after` on `/oauth2/token` — the same mechanism
 * `authBeforeHook` already uses for CIMD/DCR interop.
 *
 * Four signals, one dataset (`AUTH_EVENTS`, see wrangler.jsonc):
 *
 *  - `oauth_refresh_family_teardown` — the RFC 9700 §4.14 refresh-token
 *    family invalidation the plugin performs when an already-rotated
 *    refresh token is presented again OUTSIDE the reuse grace
 *    (`refreshTokenReuseInterval: 60` on `oauthProvider()`, PR #909).
 *  - `oauth_refresh_replay_hit` — reuse of an already-rotated refresh token
 *    WITHIN that grace, which the plugin absorbs by replaying the cached
 *    rotation response instead of tearing down the family. A nonzero rate
 *    of these alongside zero teardowns is the healthy signature #909 was
 *    meant to produce (see the issue).
 *  - `oauth_refresh_grant_failure` — any `/oauth2/token` refresh_token grant
 *    that ended in an OAuth error, tagged with the RFC 6749 error code
 *    (`invalid_grant`, `invalid_scope`, ...).
 *  - `oauth_token_grant_no_refresh` — any successful `/oauth2/token`
 *    response, of any grant_type, that did NOT include a refresh_token.
 *    Would have made #911 (offline_access never granted, so no client ever
 *    got a refresh token) obvious immediately instead of waiting on a user
 *    report.
 *
 * ## Replay vs. teardown
 *
 * Both branches share one precondition in the plugin's handler: the
 * presented refresh token's row is already `revoked`. The only thing that
 * separates them is whether the plugin's own `rotationReplayExpiresAt`
 * window (stamped at rotation time) still covers "now" — which only exists
 * in D1 (`oauth_refresh_token.revoked`/`rotationReplayExpiresAt`), and only
 * for the instant a request reads it, before its own processing can move
 * that state forward. So this reads that row TWICE per refresh_token grant:
 * once in `hooks.before` (via {@link captureRefreshTokenPriorState}, mirroring
 * the plugin's own default token hash — see {@link hashRefreshToken}) to
 * snapshot the "was it already revoked, and still inside grace" state
 * *before* the plugin's handler runs, and once implicitly in `hooks.after`
 * (via {@link classifyTokenGrantEvents}) once the response is known.
 *
 * The before→after correlation is an isolate-local, FIFO, TTL-bounded queue
 * ({@link pendingRefreshSnapshots}), not any Better-Auth-internal state —
 * safe against the plugin's own internals changing. Caveats for whoever
 * reads the resulting counts:
 *
 *  - It's per-isolate. Two concurrent refresh requests for the same token
 *    landing on DIFFERENT isolates (plausible under real load, e.g. two
 *    OpenCode processes racing from different colos) won't correlate, and
 *    that specific outcome silently falls back to no replay/teardown event
 *    at all (the coarser `oauth_refresh_grant_failure` /
 *    `oauth_token_grant_no_refresh` signals are unaffected — those don't
 *    need the snapshot).
 *  - A snapshot older than {@link PENDING_SNAPSHOT_TTL_MS} or beyond
 *    {@link PENDING_SNAPSHOT_MAX_KEYS} distinct tokens is dropped rather than
 *    kept forever, so an isolate that never sees the matching after-hook
 *    (crash mid-request) can't leak memory.
 *  - This is all best-effort telemetry, not a security control — nothing
 *    here changes what the plugin actually does with the token.
 *
 * Never logs a token value, email, or other PII: client_id, opaque user id,
 * grant_type, and the OAuth error code are the only identifying fields.
 */
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

/** Matches `@better-auth/oauth-provider`'s default token hasher exactly
 * (SHA-256, base64url, no padding) — see `defaultHasher`/`storeToken` in the
 * plugin's dist (`storeTokens` defaults to `"hashed"`, unset by auth.ts's
 * `oauthProvider()` call). Also mirrored in oauth.test.ts's `hashToken`
 * helper for the reuse-grace test; keep both in lockstep with the plugin's
 * default should it ever change. */
export async function hashRefreshToken(raw: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

export type AuthEventName =
  | "oauth_refresh_family_teardown"
  | "oauth_refresh_replay_hit"
  | "oauth_refresh_grant_failure"
  | "oauth_token_grant_no_refresh";

export interface AuthEvent {
  name: AuthEventName;
  clientId?: string;
  userId?: string;
  grantType?: string;
  errorCode?: string;
}

/**
 * Blob positions are a contract with any future SQL read path (mirrors
 * `SLOW_OP_BLOB_ORDER` in apps/api's slow-op-analytics.ts) — Analytics
 * Engine has no column names, only ordinals. Append new fields at the END;
 * never reorder or remove.
 */
export const AUTH_EVENT_BLOB_ORDER = [
  "event",
  "clientId",
  "grantType",
  "errorCode",
  "userId",
] as const;

/**
 * Analytics Engine write side. Null-safe and never throws: tests and local
 * dev run apps/auth without an `AUTH_EVENTS` binding today (see
 * wrangler.jsonc), and a write failure must never affect the token
 * response — same contract as apps/api's `writeSlowOpPoint`/
 * `writeAdoptionPoint`.
 */
export function writeAuthEventPoint(
  env: { AUTH_EVENTS?: AnalyticsEngineDataset },
  event: AuthEvent,
): void {
  const analytics = env.AUTH_EVENTS;
  if (!analytics) return;
  try {
    analytics.writeDataPoint({
      // Sampling key: keeps one noisy event type from crowding out the rest.
      indexes: [event.name],
      blobs: [
        event.name,
        event.clientId ?? "",
        event.grantType ?? "",
        event.errorCode ?? "",
        event.userId ?? "",
      ],
      doubles: [],
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(JSON.stringify({ message: "auth event analytics write failed", error: message }));
  }
}

/** Snapshot of an `oauth_refresh_token` row's rotation state, read BEFORE
 * the plugin's own `/oauth2/token` handler runs for this request. */
export interface RefreshTokenPriorState {
  clientId: string;
  userId: string;
  wasRevoked: boolean;
  /** True when `rotationReplayExpiresAt` was still in the future at read
   * time — i.e. this request is inside the `refreshTokenReuseInterval`
   * grace for whichever earlier request rotated this token. */
  withinGrace: boolean;
}

interface QueuedSnapshot extends RefreshTokenPriorState {
  at: number;
}

/** See the "Replay vs. teardown" section of the file doc comment. */
const pendingRefreshSnapshots = new Map<string, QueuedSnapshot[]>();
const PENDING_SNAPSHOT_TTL_MS = 15_000;
const PENDING_SNAPSHOT_MAX_KEYS = 200;

function pruneStalePendingSnapshots(now: number): void {
  for (const [key, queue] of pendingRefreshSnapshots) {
    const fresh = queue.filter((s) => now - s.at < PENDING_SNAPSHOT_TTL_MS);
    if (fresh.length === 0) pendingRefreshSnapshots.delete(key);
    else if (fresh.length !== queue.length) pendingRefreshSnapshots.set(key, fresh);
  }
}

function stashRefreshSnapshot(tokenHash: string, state: RefreshTokenPriorState): void {
  const now = Date.now();
  pruneStalePendingSnapshots(now);
  const queue = pendingRefreshSnapshots.get(tokenHash) ?? [];
  queue.push({ ...state, at: now });
  pendingRefreshSnapshots.set(tokenHash, queue);
  while (pendingRefreshSnapshots.size > PENDING_SNAPSHOT_MAX_KEYS) {
    const oldestKey = pendingRefreshSnapshots.keys().next().value;
    if (oldestKey === undefined) break;
    pendingRefreshSnapshots.delete(oldestKey);
  }
}

/** FIFO take — pairs with the earliest not-yet-consumed snapshot for this
 * token hash, so two sequential requests for the same token each get their
 * own prior-state reading. */
function takeRefreshSnapshot(tokenHash: string): RefreshTokenPriorState | undefined {
  const queue = pendingRefreshSnapshots.get(tokenHash);
  if (!queue || queue.length === 0) return undefined;
  const next = queue.shift();
  if (queue.length === 0) pendingRefreshSnapshots.delete(tokenHash);
  else pendingRefreshSnapshots.set(tokenHash, queue);
  return next;
}

/** Test-only escape hatch: clears in-flight snapshot state between cases. */
export function __resetPendingRefreshSnapshotsForTest(): void {
  pendingRefreshSnapshots.clear();
}

type HookCtx = { path: string; body?: unknown };

/**
 * `hooks.before` half of the pair (see file doc comment). Reads the
 * presented refresh token's current D1 state ahead of the plugin's own
 * handler; a no-op (single cheap `!==` check) for every path/grant_type
 * other than a refresh_token grant at `/oauth2/token`, and for a token this
 * worker has no row for (unknown/garbage token — the plugin's own
 * `invalid_grant` covers that; nothing to snapshot). Never throws — a
 * lookup failure here must not block the token endpoint.
 */
export async function captureRefreshTokenPriorState(
  db: ReturnType<typeof drizzle<typeof schema>>,
  ctx: HookCtx,
): Promise<void> {
  if (ctx.path !== "/oauth2/token") return;
  const body = ctx.body as Record<string, unknown> | undefined;
  if (body?.grant_type !== "refresh_token") return;
  const raw = body.refresh_token;
  if (typeof raw !== "string" || !raw) return;
  try {
    const tokenHash = await hashRefreshToken(raw);
    const [row] = await db
      .select({
        clientId: schema.oauthRefreshToken.clientId,
        userId: schema.oauthRefreshToken.userId,
        revoked: schema.oauthRefreshToken.revoked,
        rotationReplayExpiresAt: schema.oauthRefreshToken.rotationReplayExpiresAt,
      })
      .from(schema.oauthRefreshToken)
      .where(eq(schema.oauthRefreshToken.token, tokenHash))
      .limit(1);
    if (!row) return;
    stashRefreshSnapshot(tokenHash, {
      clientId: row.clientId,
      userId: row.userId,
      wasRevoked: Boolean(row.revoked),
      withinGrace: Boolean(
        row.rotationReplayExpiresAt && row.rotationReplayExpiresAt.getTime() > Date.now(),
      ),
    });
  } catch {
    // Best-effort: a D1 hiccup here must never block the token endpoint.
  }
}

export interface TokenGrantOutcome {
  grantType?: string;
  clientId?: string;
  success: boolean;
  /** RFC 6749 `error` value (e.g. `invalid_grant`), only set when `!success`. */
  errorCode?: string;
  /** Only meaningful when `success`: did the response body carry a
   * `refresh_token`? */
  hasRefreshToken?: boolean;
}

/**
 * Pure classification: turns one `/oauth2/token` outcome (plus the optional
 * before-hook snapshot for refresh_token grants) into zero or more events.
 * Exported and kept side-effect-free so it's directly unit-testable without
 * driving the full HTTP/D1 stack.
 */
export function classifyTokenGrantEvents(
  outcome: TokenGrantOutcome,
  priorRefreshState?: RefreshTokenPriorState,
): AuthEvent[] {
  const events: AuthEvent[] = [];

  if (outcome.grantType === "refresh_token") {
    if (!outcome.success) {
      events.push({
        name: "oauth_refresh_grant_failure",
        clientId: outcome.clientId,
        grantType: outcome.grantType,
        errorCode: outcome.errorCode,
      });
      // Family teardown: the presented token was already revoked AND its
      // reuse grace had already expired at read time — exactly the branch
      // in the plugin's handler that calls invalidateRefreshFamily before
      // throwing invalid_grant.
      if (priorRefreshState?.wasRevoked && !priorRefreshState.withinGrace) {
        events.push({
          name: "oauth_refresh_family_teardown",
          clientId: priorRefreshState.clientId,
          userId: priorRefreshState.userId,
        });
      }
    } else if (priorRefreshState?.wasRevoked && priorRefreshState.withinGrace) {
      // Presented an already-rotated token still inside the reuse grace:
      // the plugin replayed the cached rotation response instead of
      // minting a fresh pair.
      events.push({
        name: "oauth_refresh_replay_hit",
        clientId: priorRefreshState.clientId,
        userId: priorRefreshState.userId,
      });
    }
  }

  if (outcome.success && outcome.hasRefreshToken === false) {
    events.push({
      name: "oauth_token_grant_no_refresh",
      clientId: outcome.clientId,
      grantType: outcome.grantType,
    });
  }

  return events;
}

/** Shape of the `after`-hook `ctx` this needs beyond `HookCtx`: the
 * endpoint's outcome, mirroring what Better Auth's dispatcher stashes on
 * `ctx.context.returned` — either the success response body, or the thrown
 * `APIError` itself (Better Auth runs `hooks.after` on both paths; see
 * `runAfterHooks`/`dispatchAuthEndpoint` in better-auth's `api/dispatch`). */
type AfterHookCtx = HookCtx & { context: { returned?: unknown } };

/**
 * Builds the `hooks.after` handler that completes the classification and
 * writes events. Takes a plain `isError`/`errorBody` extractor rather than
 * importing `isAPIError` itself so this module has no dependency on
 * `better-auth/api` beyond the type the caller already imports — keeps this
 * file trivially unit-testable (see oauth-observability.test.ts) without
 * constructing a real `APIError`.
 */
export function buildTokenGrantAfterHandler(
  env: { AUTH_EVENTS?: AnalyticsEngineDataset },
  isApiError: (value: unknown) => boolean,
) {
  return async (ctx: AfterHookCtx): Promise<void> => {
    if (ctx.path !== "/oauth2/token") return;
    try {
      const body = ctx.body as Record<string, unknown> | undefined;
      const grantType = typeof body?.grant_type === "string" ? body.grant_type : undefined;
      const clientId = typeof body?.client_id === "string" ? body.client_id : undefined;

      let priorState: RefreshTokenPriorState | undefined;
      const rawRefreshToken = body?.refresh_token;
      if (grantType === "refresh_token" && typeof rawRefreshToken === "string" && rawRefreshToken) {
        priorState = takeRefreshSnapshot(await hashRefreshToken(rawRefreshToken));
      }

      const returned = ctx.context.returned;
      let outcome: TokenGrantOutcome;
      if (isApiError(returned)) {
        const errorBody = (returned as { body?: { error?: unknown } }).body;
        outcome = {
          grantType,
          clientId,
          success: false,
          errorCode: typeof errorBody?.error === "string" ? errorBody.error : undefined,
        };
      } else if (returned && typeof returned === "object") {
        const responseBody = returned as { refresh_token?: unknown };
        outcome = {
          grantType,
          clientId,
          success: true,
          hasRefreshToken: typeof responseBody.refresh_token === "string",
        };
      } else {
        // Nothing to classify (no response captured on this ctx).
        return;
      }

      for (const event of classifyTokenGrantEvents(outcome, priorState)) {
        writeAuthEventPoint(env, event);
      }
    } catch (err) {
      // Observability must never break the token endpoint.
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        JSON.stringify({ message: "oauth observability after-hook failed", error: message }),
      );
    }
  };
}
