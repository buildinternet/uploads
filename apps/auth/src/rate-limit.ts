/**
 * Durable-Object-backed rate-limit storage for Better Auth (2026-08-23
 * incident follow-up; see the `rateLimit` block in src/auth.ts).
 *
 * This module is deliberately free of any `cloudflare:workers` import so the
 * plain-vitest suite can exercise every decision path in-process. The Durable
 * Object class itself lives in src/rate-limit-do.ts and imports `decideWindow`
 * from here.
 *
 * Semantics are a byte-for-byte mirror of Better Auth 1.7.1's own
 * `decideConsume` (node_modules/better-auth/dist/api/rate-limiter/index.mjs
 * lines 25-63) and `getRetryAfter` (lines 71-75), so swapping the built-in
 * memory backend for this one cannot change who gets a 429:
 *
 *   - no state            → count = 1, allowed
 *   - now - lastRequest >= window*1000 → window elapsed: count resets to 1, allowed
 *   - count >= max        → denied, state untouched,
 *                           retryAfter = ceil((lastRequest + window*1000 - now) / 1000)
 *   - otherwise           → count + 1, lastRequest = now, allowed
 *
 * `window` is in SECONDS on the way in and `retryAfter` is in SECONDS on the
 * way out; `lastRequest` is epoch milliseconds. Note that `lastRequest` is
 * bumped on every ALLOWED request (upstream does the same), so the window
 * slides forward with traffic rather than being pinned to the first hit.
 */

/** A resolved Better Auth rate-limit rule: `window` in seconds, `max` hits. */
export type RateLimitRule = { window: number; max: number };

/** The single counter row a per-key Durable Object holds. */
export type RateLimitState = { count: number; lastRequest: number };

export type RateLimitOutcome = { allowed: boolean; retryAfter: number | null };

export type RateLimitDecision = RateLimitOutcome & {
  /** The state to persist. Only meaningful when `allowed` is true. */
  next: RateLimitState;
};

/**
 * Pure fixed-window decision. Extracted so it is testable without the DO
 * runtime; the Durable Object is nothing but storage read → this → storage
 * write, which is atomic because a DO is single-threaded.
 */
export function decideWindow(
  state: RateLimitState | undefined,
  rule: RateLimitRule,
  now: number,
): RateLimitDecision {
  const windowInMs = rule.window * 1000;
  if (!state) {
    return { next: { count: 1, lastRequest: now }, allowed: true, retryAfter: null };
  }
  if (now - state.lastRequest >= windowInMs) {
    return { next: { count: 1, lastRequest: now }, allowed: true, retryAfter: null };
  }
  if (state.count >= rule.max) {
    return {
      next: state,
      allowed: false,
      // Mirrors better-auth's getRetryAfter (dist/api/rate-limiter/index.mjs:71).
      retryAfter: Math.ceil((state.lastRequest + windowInMs - now) / 1000),
    };
  }
  return {
    next: { count: state.count + 1, lastRequest: now },
    allowed: true,
    retryAfter: null,
  };
}

/** The RPC surface src/rate-limit-do.ts exposes; kept structural for testing. */
export interface RateLimitCounterStub {
  consume(rule: RateLimitRule): Promise<RateLimitOutcome>;
}

/**
 * The slice of `DurableObjectNamespace<RateLimitCounter>` this module uses.
 * Structural on purpose: unit tests pass a fake, and the real binding
 * satisfies it without a cast.
 */
export interface RateLimitNamespaceLike<Id = unknown> {
  idFromName(name: string): Id;
  get(id: Id): RateLimitCounterStub;
}

/** Fail-open result, used for every error and for the timeout. */
const FAIL_OPEN: RateLimitOutcome = { allowed: true, retryAfter: null };

/**
 * Default deadline for the DO round trip. A rate limiter must never be able
 * to add unbounded latency to the hot path — that is exactly what the D1
 * incident was. DO RPC has no abort signal, so the losing promise is simply
 * abandoned (it settles harmlessly in the background; its write, if any,
 * still lands in the counter).
 */
export const DEFAULT_RATE_LIMIT_TIMEOUT_MS = 1500;

export type DurableRateLimitStorageOptions = {
  timeoutMs?: number;
  /** Injected in tests; defaults to `console.error`. */
  onError?: (error: unknown) => void;
};

/**
 * Build a Better Auth `rateLimit.customStorage` backed by one Durable Object
 * per rate-limit key.
 *
 * `idFromName(key)` is deterministic, so every isolate in the fleet lands on
 * the same object for a given key — the counter is exact and global, unlike
 * the per-isolate memory Map — and Cloudflare places that object near its
 * first caller, which keeps the round trip short for the IP-keyed buckets
 * Better Auth uses.
 */
export function createDurableRateLimitStorage(
  namespace: RateLimitNamespaceLike,
  options: DurableRateLimitStorageOptions = {},
): { consume: (key: string, rule: RateLimitRule) => Promise<RateLimitOutcome> } {
  const timeoutMs = options.timeoutMs ?? DEFAULT_RATE_LIMIT_TIMEOUT_MS;
  const onError =
    options.onError ??
    ((error: unknown) => {
      console.error(
        JSON.stringify({
          message: "auth_rate_limit_storage_failed",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    });

  return {
    async consume(key, rule) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const stub = namespace.get(namespace.idFromName(key));
        const call = Promise.resolve(stub.consume(rule));
        // A rejection that lands after the timeout has already won the race
        // would otherwise surface as an unhandled rejection — swallow it on
        // this side branch; the race branch still observes it normally.
        call.catch(() => {});
        const timeout = new Promise<RateLimitOutcome | undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), timeoutMs);
        });
        const result = await Promise.race([call, timeout]);
        if (!result) {
          onError(new Error(`rate limit DO timed out after ${timeoutMs}ms`));
          return FAIL_OPEN;
        }
        return result;
      } catch (error) {
        onError(error);
        return FAIL_OPEN;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    },
  };
}
