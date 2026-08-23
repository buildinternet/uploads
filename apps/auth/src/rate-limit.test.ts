import { describe, expect, it, vi } from "vitest";
import {
  createDurableRateLimitStorage,
  decideWindow,
  type RateLimitNamespaceLike,
  type RateLimitOutcome,
  type RateLimitRule,
  type RateLimitState,
} from "./rate-limit";

const RULE: RateLimitRule = { window: 60, max: 3 };

describe("decideWindow", () => {
  it("starts a window at count 1 when there is no state", () => {
    const now = 1_000_000;
    expect(decideWindow(undefined, RULE, now)).toEqual({
      next: { count: 1, lastRequest: now },
      allowed: true,
      retryAfter: null,
    });
  });

  it("increments inside the window and slides lastRequest forward", () => {
    const state: RateLimitState = { count: 1, lastRequest: 1_000_000 };
    expect(decideWindow(state, RULE, 1_005_000)).toEqual({
      next: { count: 2, lastRequest: 1_005_000 },
      allowed: true,
      retryAfter: null,
    });
  });

  it("resets to count 1 once the full window has elapsed", () => {
    const state: RateLimitState = { count: 3, lastRequest: 1_000_000 };
    // Exactly window*1000 later — better-auth uses `>=`, so this resets.
    expect(decideWindow(state, RULE, 1_060_000)).toEqual({
      next: { count: 1, lastRequest: 1_060_000 },
      allowed: true,
      retryAfter: null,
    });
  });

  it("denies at max and leaves the state untouched", () => {
    const state: RateLimitState = { count: 3, lastRequest: 1_000_000 };
    const decision = decideWindow(state, RULE, 1_010_000);
    expect(decision.allowed).toBe(false);
    expect(decision.next).toBe(state);
  });

  it("reports retryAfter in whole seconds, rounded up (better-auth getRetryAfter)", () => {
    const state: RateLimitState = { count: 3, lastRequest: 1_000_000 };
    // 50.5s remaining in the 60s window → ceil → 51.
    expect(decideWindow(state, RULE, 1_009_500).retryAfter).toBe(51);
    // 1ms remaining → ceil → 1, never 0.
    expect(decideWindow(state, RULE, 1_059_999).retryAfter).toBe(1);
  });

  it("denies immediately when max is 0", () => {
    const state: RateLimitState = { count: 0, lastRequest: 1_000_000 };
    expect(decideWindow(state, { window: 10, max: 0 }, 1_000_100).allowed).toBe(false);
  });
});

/** In-process stand-in for the DO: the same read-decide-write, no runtime. */
function fakeNamespace(
  consume: (key: string, rule: RateLimitRule) => Promise<RateLimitOutcome>,
): RateLimitNamespaceLike<string> & { keys: string[] } {
  const keys: string[] = [];
  return {
    keys,
    idFromName(name) {
      keys.push(name);
      return name;
    },
    get(id) {
      return { consume: (rule) => consume(id, rule) };
    },
  };
}

describe("createDurableRateLimitStorage", () => {
  it("passes the verdict through on the allowed path", async () => {
    const ns = fakeNamespace(async () => ({ allowed: true, retryAfter: null }));
    const storage = createDurableRateLimitStorage(ns);
    await expect(storage.consume("ip:1.2.3.4/get-session", RULE)).resolves.toEqual({
      allowed: true,
      retryAfter: null,
    });
    // One DO per key, addressed by name.
    expect(ns.keys).toEqual(["ip:1.2.3.4/get-session"]);
  });

  it("passes the verdict through on the limited path, retryAfter included", async () => {
    const ns = fakeNamespace(async () => ({ allowed: false, retryAfter: 42 }));
    const storage = createDurableRateLimitStorage(ns);
    await expect(storage.consume("k", RULE)).resolves.toEqual({
      allowed: false,
      retryAfter: 42,
    });
  });

  it("fails open when the DO call rejects", async () => {
    const onError = vi.fn();
    const ns = fakeNamespace(async () => {
      throw new Error("durable object unavailable");
    });
    const storage = createDurableRateLimitStorage(ns, { onError });
    await expect(storage.consume("k", RULE)).resolves.toEqual({
      allowed: true,
      retryAfter: null,
    });
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("fails open when the namespace itself throws before the RPC", async () => {
    const onError = vi.fn();
    const storage = createDurableRateLimitStorage(
      {
        idFromName() {
          throw new Error("binding missing");
        },
        get() {
          throw new Error("unreachable");
        },
      },
      { onError },
    );
    await expect(storage.consume("k", RULE)).resolves.toEqual({
      allowed: true,
      retryAfter: null,
    });
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("fails open when the DO call outruns the timeout", async () => {
    const onError = vi.fn();
    // Never settles: stands in for the stalled-storage case the 2026-08-23
    // incident was made of.
    const ns = fakeNamespace(() => new Promise<RateLimitOutcome>(() => {}));
    const storage = createDurableRateLimitStorage(ns, { timeoutMs: 5, onError });
    await expect(storage.consume("k", RULE)).resolves.toEqual({
      allowed: true,
      retryAfter: null,
    });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(String(onError.mock.calls[0]?.[0])).toContain("timed out");
  });

  it("does not leave the timer pending after a fast answer", async () => {
    vi.useFakeTimers();
    try {
      const ns = fakeNamespace(async () => ({ allowed: true, retryAfter: null }));
      const storage = createDurableRateLimitStorage(ns, { timeoutMs: 60_000 });
      await storage.consume("k", RULE);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * End-to-end shape check: drive `decideWindow` through a fake DO exactly the
 * way src/rate-limit-do.ts does (read → decide → write only when allowed) and
 * confirm the storage wrapper produces Better Auth's fixed-window behaviour.
 */
describe("DO counter behaviour (decideWindow driven like rate-limit-do.ts)", () => {
  it("allows `max` hits per window, then denies with a retryAfter", async () => {
    let clock = 1_000_000;
    const rows = new Map<string, RateLimitState & { expiresAt: number }>();
    const ns = fakeNamespace(async (key, rule) => {
      const stored = rows.get(key);
      const state = stored && clock < stored.expiresAt ? stored : undefined;
      const decision = decideWindow(state, rule, clock);
      if (decision.allowed) {
        rows.set(key, { ...decision.next, expiresAt: clock + rule.window * 1000 });
      }
      return { allowed: decision.allowed, retryAfter: decision.retryAfter };
    });
    const storage = createDurableRateLimitStorage(ns);

    for (let i = 0; i < RULE.max; i++) {
      expect((await storage.consume("k", RULE)).allowed).toBe(true);
      clock += 1000;
    }
    const denied = await storage.consume("k", RULE);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfter).toBeGreaterThan(0);

    // Past the window with no traffic: the counter starts over.
    clock += RULE.window * 1000;
    expect((await storage.consume("k", RULE)).allowed).toBe(true);
  });

  it("keeps separate counters per key", async () => {
    const rows = new Map<string, RateLimitState>();
    const ns = fakeNamespace(async (key, rule) => {
      const decision = decideWindow(rows.get(key), rule, 1_000_000);
      if (decision.allowed) rows.set(key, decision.next);
      return { allowed: decision.allowed, retryAfter: decision.retryAfter };
    });
    const storage = createDurableRateLimitStorage(ns);
    const rule: RateLimitRule = { window: 60, max: 1 };
    expect((await storage.consume("a", rule)).allowed).toBe(true);
    expect((await storage.consume("b", rule)).allowed).toBe(true);
    expect((await storage.consume("a", rule)).allowed).toBe(false);
  });
});
