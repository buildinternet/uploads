import { describe, expect, it, vi } from "vitest";
import {
  createBindingRateLimitStorage,
  rateLimitTiers,
  tierFor,
  type RateLimiterLike,
  type RateLimitBindings,
} from "./rate-limit";

/** A limiter that records keys and answers with `success`. */
function fakeLimiter(success = true): RateLimiterLike & { keys: string[] } {
  const keys: string[] = [];
  return {
    keys,
    async limit({ key }) {
      keys.push(key);
      return { success };
    },
  };
}

function bindings(overrides: RateLimitBindings = {}): RateLimitBindings {
  return {
    RL_SIGN_IN: fakeLimiter(),
    RL_EMAIL: fakeLimiter(),
    RL_OAUTH: fakeLimiter(),
    RL_DEFAULT: fakeLimiter(),
    ...overrides,
  };
}

describe("rateLimitTiers", () => {
  it("is null unless all four bindings are present", () => {
    expect(rateLimitTiers({})).toBeNull();
    expect(rateLimitTiers({ ...bindings(), RL_OAUTH: undefined })).toBeNull();
    expect(rateLimitTiers(bindings())).toHaveLength(4);
  });
});

describe("tierFor", () => {
  const env = bindings();
  const tiers = rateLimitTiers(env)!;

  // Every rule Better Auth 1.7.7 and its plugins resolve for this worker.
  it.each([
    ["sign-in, change-password, change-email", { window: 10, max: 3 }, env.RL_SIGN_IN],
    ["password reset, verification email", { window: 60, max: 3 }, env.RL_EMAIL],
    ["magic link, register", { window: 60, max: 5 }, env.RL_EMAIL],
    ["oauth2 token", { window: 60, max: 20 }, env.RL_OAUTH],
    ["oauth2 authorize, revoke", { window: 60, max: 30 }, env.RL_OAUTH],
    ["oauth2 userinfo", { window: 60, max: 60 }, env.RL_DEFAULT],
    ["oauth2 introspect", { window: 60, max: 100 }, env.RL_DEFAULT],
    ["Better Auth default", { window: 10, max: 100 }, env.RL_DEFAULT],
  ])("maps %s", (_name, rule, limiter) => {
    expect(tierFor(tiers, rule).limiter).toBe(limiter);
  });

  it("never picks a tier stricter than a 10s or 60s rule", () => {
    for (const window of [10, 60]) {
      for (const max of [1, 3, 5, 20, 30, 60, 100]) {
        const tier = tierFor(tiers, { window, max });
        expect(tier.max / tier.window).toBeGreaterThanOrEqual(max / window);
      }
    }
  });
});

describe("createBindingRateLimitStorage", () => {
  const RULE = { window: 60, max: 5 };

  it("allows when the binding succeeds, keyed by Better Auth's key", async () => {
    const email = fakeLimiter();
    const storage = createBindingRateLimitStorage(rateLimitTiers(bindings({ RL_EMAIL: email }))!);
    await expect(storage.consume("203.0.113.7|/sign-in/magic-link", RULE)).resolves.toEqual({
      allowed: true,
      retryAfter: null,
    });
    expect(email.keys).toEqual(["203.0.113.7|/sign-in/magic-link"]);
  });

  it("denies with the tier's window as retryAfter when the binding says no", async () => {
    const env = bindings({ RL_EMAIL: fakeLimiter(false) });
    const storage = createBindingRateLimitStorage(rateLimitTiers(env)!);
    await expect(storage.consume("k", RULE)).resolves.toEqual({
      allowed: false,
      retryAfter: 60,
    });
  });

  it("skips limiting for requests with no client IP (service bindings)", async () => {
    const env = bindings({ RL_OAUTH: fakeLimiter(false) });
    const storage = createBindingRateLimitStorage(rateLimitTiers(env)!);
    await expect(
      storage.consume("no-trusted-ip|/oauth2/token", { window: 60, max: 20 }),
    ).resolves.toEqual({ allowed: true, retryAfter: null });
  });

  it("fails open and reports when the binding throws", async () => {
    const onError = vi.fn();
    const broken: RateLimiterLike = {
      limit: async () => {
        throw new Error("ratelimit unavailable");
      },
    };
    const storage = createBindingRateLimitStorage(rateLimitTiers(bindings({ RL_EMAIL: broken }))!, {
      onError,
    });
    await expect(storage.consume("k", RULE)).resolves.toEqual({
      allowed: true,
      retryAfter: null,
    });
    expect(onError).toHaveBeenCalledOnce();
  });
});
