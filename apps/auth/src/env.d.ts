// Runtime Worker secrets/dev fallbacks (see .dev.vars.example), not declared
// in wrangler.jsonc, so `wrangler types` does not generate them. Augment Env
// here, mirroring apps/api/src/env.d.ts.
interface Env {
  /**
   * Dev-only fallback for the Better Auth signing secret. Preferred only when
   * UPL_BETTER_AUTH_SECRET (Secrets Store) is unresolvable — see
   * src/secrets.ts and the D7 footgun note there.
   */
  BETTER_AUTH_SECRET_DEV?: string;
  /** Dev plain fallback for UPL_BETTER_AUTH_API_KEY (mounts `dash()` when set). */
  BETTER_AUTH_API_KEY?: string;
  /** Dev-only plain fallbacks for GitHub OAuth, gated the same way as the store pair. */
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  /** Comma-separated extra trusted origins (see src/trusted-origins.ts). */
  BETTER_AUTH_TRUSTED_ORIGINS?: string;
  /** Dev opt-out for Better Auth's fail-closed production rate limiting. */
  AUTH_RATE_LIMIT_DISABLED?: string;
  /**
   * Service binding to apps/api (see wrangler.jsonc), used by
   * src/billing-bridge.ts to POST /internal/billing/plan. Optional: absent
   * in tests/local dev without both `wrangler dev` sessions running — the
   * bridge no-ops (logs, doesn't throw) rather than requiring it.
   */
  API?: Fetcher;
  /** Stripe phase 2 secrets (task 5+): unused directly by billing-bridge.ts,
   * declared here so the webhook handler that will call syncWorkspacePlan
   * has them typed on Env. */
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_PRO_PRICE_ID?: string;
  /** Shared secret for POST /internal/billing/plan (see apps/api's
   * routes/internal-billing.ts and wrangler.jsonc comment there). Fail-closed
   * when unset: billing-bridge.ts no-ops rather than sending an empty header. */
  BILLING_INTERNAL_KEY?: string;
}
