/**
 * Better Auth rate-limit storage backed by Cloudflare's Rate Limiting binding.
 *
 * The binding counts locally in each colo, so a check never leaves the
 * machine and cannot stall a request (the Durable Object backend this
 * replaced timed out under load). Counts are per colo and approximate, which
 * is fine for per-IP abuse shaping: one client IP almost always lands on one
 * colo.
 *
 * A binding's limit and period are fixed in wrangler.jsonc, so Better Auth's
 * rules are mapped onto a few tiers. Every rule here has a 10s or 60s window
 * (the only periods the binding supports), and `tierFor` never picks a tier
 * stricter than such a rule.
 */

import { reportHandledError } from "@uploads/observability";

/** A resolved Better Auth rate-limit rule: `window` in seconds, `max` hits. */
export type RateLimitRule = { window: number; max: number };

export type RateLimitOutcome = { allowed: boolean; retryAfter: number | null };

/** The slice of the Workers `RateLimit` binding this module uses. */
export interface RateLimiterLike {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

/** One `ratelimits` binding. `window`/`max` must match its wrangler.jsonc `simple` block. */
export type RateLimitTier = { window: number; max: number; limiter: RateLimiterLike };

export type RateLimitBindings = {
  RL_SIGN_IN?: RateLimiterLike;
  RL_EMAIL?: RateLimiterLike;
  RL_OAUTH?: RateLimiterLike;
  RL_DEFAULT?: RateLimiterLike;
};

/**
 * The tiers, or null unless all four bindings are present. Ordered strictest
 * first; the last one is the loosest and the fallback.
 *
 *   RL_SIGN_IN   3 / 10s   sign-in, change-password, change-email
 *   RL_EMAIL     5 / 60s   magic link, password reset, verification email, register
 *   RL_OAUTH    30 / 60s   oauth2 token, authorize, revoke
 *   RL_DEFAULT 100 / 10s   everything else (introspect, userinfo, Better Auth's default)
 */
export function rateLimitTiers(env: RateLimitBindings): RateLimitTier[] | null {
  const { RL_SIGN_IN, RL_EMAIL, RL_OAUTH, RL_DEFAULT } = env;
  if (!RL_SIGN_IN || !RL_EMAIL || !RL_OAUTH || !RL_DEFAULT) return null;
  return [
    { window: 10, max: 3, limiter: RL_SIGN_IN },
    { window: 60, max: 5, limiter: RL_EMAIL },
    { window: 60, max: 30, limiter: RL_OAUTH },
    { window: 10, max: 100, limiter: RL_DEFAULT },
  ];
}

/** The strictest tier with the rule's window that allows at least `rule.max`, else the last. */
export function tierFor(tiers: RateLimitTier[], rule: RateLimitRule): RateLimitTier {
  return tiers.find((tier) => tier.window === rule.window && tier.max >= rule.max) ?? tiers.at(-1)!;
}

/** Fail-open result, used for no-IP keys and binding errors. */
const FAIL_OPEN: RateLimitOutcome = { allowed: true, retryAfter: null };

/**
 * Better Auth's key prefix when a request has no client IP
 * (`no-trusted-ip|<path>`). Only service-binding calls lack `cf-connecting-ip`,
 * and they would all share one counter per path, so they are not limited.
 */
const NO_IP_KEY_PREFIX = "no-trusted-ip|";

export type BindingRateLimitStorageOptions = {
  /** Injected in tests; defaults to `reportHandledError`. */
  onError?: (error: unknown) => void;
};

/** Build a Better Auth `rateLimit.customStorage` over the tiers. */
export function createBindingRateLimitStorage(
  tiers: RateLimitTier[],
  options: BindingRateLimitStorageOptions = {},
): { consume: (key: string, rule: RateLimitRule) => Promise<RateLimitOutcome> } {
  const onError = options.onError ?? reportHandledError;

  return {
    async consume(key, rule) {
      if (key.startsWith(NO_IP_KEY_PREFIX)) return FAIL_OPEN;
      const tier = tierFor(tiers, rule);
      try {
        const { success } = await tier.limiter.limit({ key });
        // The binding doesn't report time left, so a full window is the bound.
        return success ? FAIL_OPEN : { allowed: false, retryAfter: tier.window };
      } catch (error) {
        onError(error);
        return FAIL_OPEN;
      }
    },
  };
}
