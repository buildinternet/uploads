// Runtime Worker ambient declarations, mirroring apps/api/src/env.d.ts.
//
// The eight secrets below (BETTER_AUTH_SECRET, BETTER_AUTH_API_KEY,
// GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, STRIPE_SECRET_KEY,
// STRIPE_WEBHOOK_SECRET, STRIPE_PRO_PRICE_ID, BILLING_INTERNAL_KEY) and
// STRIPE_CHECKOUT_TOS_CONSENT are now ALSO declared in wrangler.jsonc — the
// first eight in `secrets.required` (uploads#754 item 2), the last as a
// `vars` entry — which makes `wrangler types` generate them as required (not
// optional) on the ambient `Env`. That required-ness is a deploy-time
// guarantee (`wrangler deploy`/`versions upload` refuses to ship without
// them), not a runtime one: every call site here still treats a missing
// value as an expected, fail-soft case (GitHub/Stripe/dash() features stay
// unmounted, /api/auth/* answers 503) rather than a programming error. The
// declarations below intentionally keep them optional, overriding the
// generated required version — see src/secrets.ts for the fail-soft
// resolvers and docs/ops.md for the cutover.
interface Env {
  /**
   * The Better Auth signing secret (`wrangler secret put BETTER_AUTH_SECRET`).
   * See src/secrets.ts.
   */
  BETTER_AUTH_SECRET?: string;
  /** Infra dashboard API key (mounts `dash()` when set). */
  BETTER_AUTH_API_KEY?: string;
  /** GitHub OAuth credentials, gated as a pair (src/secrets.ts). */
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
  /**
   * Exactly `"true"` makes Stripe Checkout require a Terms of Service
   * checkbox before it takes payment. Off by default, and deliberately so:
   * Stripe rejects the session unless a Terms URL is set in the Dashboard
   * first, which would break every upgrade. See
   * packages/billing/src/stripe-checkout.ts for the enable order.
   */
  STRIPE_CHECKOUT_TOS_CONSENT?: string;
  /** Shared secret for POST /internal/billing/plan (see apps/api's
   * routes/internal-billing.ts and wrangler.jsonc comment there). Fail-closed
   * when unset: billing-bridge.ts no-ops rather than sending an empty header. */
  BILLING_INTERNAL_KEY?: string;
}
