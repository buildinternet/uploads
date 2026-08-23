/**
 * `RateLimitCounter` — one Durable Object per Better Auth rate-limit key.
 *
 * The object holds a single fixed-window counter. Because a DO is
 * single-threaded, the read → decide → write below is atomic without any
 * locking or compare-and-set, which is what lets the fleet share one exact
 * counter per key (the built-in memory backend can only approximate that,
 * per isolate).
 *
 * All decision logic lives in src/rate-limit.ts (`decideWindow`) so it can be
 * unit-tested under plain vitest — this file is the only one that imports
 * `cloudflare:workers`. It is exported from src/index.ts because wrangler
 * requires the class to be a named export of the worker entrypoint.
 */
import { DurableObject } from "cloudflare:workers";
import {
  decideWindow,
  type RateLimitOutcome,
  type RateLimitRule,
  type RateLimitState,
} from "./rate-limit";

/** Storage key for the counter row. One row per object, so a constant. */
const STATE_KEY = "s";

type StoredState = RateLimitState & { expiresAt: number };

export class RateLimitCounter extends DurableObject {
  /**
   * Record one hit against this key and report Better Auth's verdict.
   * Return shape matches `BetterAuthRateLimitStorage["consume"]`.
   */
  async consume(rule: RateLimitRule): Promise<RateLimitOutcome> {
    const now = Date.now();
    const stored = await this.ctx.storage.get<StoredState>(STATE_KEY);
    // Expiry mirrors the memory backend's per-entry TTL (`ttlFor(rule.window)`
    // in better-auth/dist/api/rate-limiter/index.mjs): a lapsed entry is
    // indistinguishable from no entry at all.
    const state = stored && now < stored.expiresAt ? stored : undefined;
    const decision = decideWindow(state, rule, now);
    if (decision.allowed) {
      const expiresAt = now + rule.window * 1000;
      await this.ctx.storage.put<StoredState>(STATE_KEY, { ...decision.next, expiresAt });
      // Cheap self-cleanup so an idle object doesn't keep a stale row forever.
      // Armed only when a window is freshly started, not on every hit — the
      // alarm handler reschedules itself if the key is still active, which
      // keeps the hot path down to a single storage write.
      if (!state) await this.ctx.storage.setAlarm(expiresAt + 1000);
    }
    return { allowed: decision.allowed, retryAfter: decision.retryAfter };
  }

  /**
   * Fired a beat after the current window would lapse. If traffic kept the
   * counter alive in the meantime, push the alarm out instead of deleting —
   * dropping a live counter would silently reset someone's limit.
   */
  override async alarm(): Promise<void> {
    const stored = await this.ctx.storage.get<StoredState>(STATE_KEY);
    if (stored && Date.now() < stored.expiresAt) {
      await this.ctx.storage.setAlarm(stored.expiresAt + 1000);
      return;
    }
    await this.ctx.storage.deleteAll();
  }
}
