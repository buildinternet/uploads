/**
 * Test-only stand-in for the `cloudflare:workers` built-in module, which the
 * workerd runtime provides but plain Node/vitest cannot resolve.
 *
 * apps/auth runs its suite on plain vitest with in-process fakes (see
 * src/test/fake-d1.ts), so importing src/index.ts — which must re-export the
 * `RateLimitCounter` Durable Object for wrangler — would otherwise fail at
 * module load. vitest.config.ts aliases the module here.
 *
 * Only the surface apps/auth actually uses is stubbed: the `DurableObject`
 * base class's `ctx`/`env` assignment. Behaviour of the DO subclass is tested
 * through the pure `decideWindow` helper in src/rate-limit.ts, not through
 * this class.
 */
export class DurableObject<TEnv = unknown> {
  constructor(
    readonly ctx: DurableObjectState,
    readonly env: TEnv,
  ) {}
}
