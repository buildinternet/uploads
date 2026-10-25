/**
 * Test-only stand-in for the `cloudflare:workers` built-in module, which the
 * workerd runtime provides but plain Node/vitest cannot resolve.
 * `@uploads/observability` imports it; vitest.config.ts aliases it here.
 */
/** `@uploads/observability/issues` reads this. Tests have no active span. */
export const tracing = {
  getActiveSpan(): undefined {
    return undefined;
  },
};
