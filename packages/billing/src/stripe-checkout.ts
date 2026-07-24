/**
 * Extra Stripe Checkout Session parameters for the Pro upgrade.
 *
 * Today this carries one thing: whether Checkout makes the buyer tick a box
 * agreeing to our Terms of Service before it will take the payment.
 *
 * Stripe already handles the *disclosure* half of a subscription sale on its
 * own — the checkout page shows the price, the currency, and the billing
 * interval, and the session is created with `mode: "subscription"`, so the
 * recurring nature is inherent in what the buyer sees. What Stripe does NOT do
 * unless asked is collect agreement to *our* terms at the moment of purchase.
 * That is `consent_collection.terms_of_service`, and it is off by default.
 *
 * ## Why this is gated rather than simply on
 *
 * `consent_collection: { terms_of_service: "required" }` needs a Terms of
 * Service URL set in the Stripe Dashboard (Settings → Public business
 * information). Without it, Stripe rejects the Checkout Session outright — and
 * that failure lands squarely on the purchase path, which would make the
 * upgrade button dead for everyone. So the parameter stays off until an
 * operator turns it on deliberately, after the Dashboard field exists.
 *
 * Enabling it, in order:
 *   1. Set the Terms of service URL in the Stripe Dashboard to
 *      https://uploads.sh/terms (do this FIRST — step 2 breaks checkout
 *      without it).
 *   2. `wrangler secret put STRIPE_CHECKOUT_TOS_CONSENT` on uploads-auth, or
 *      set the var, to exactly `true`.
 *   3. Run a test-mode checkout and confirm the checkbox renders.
 *
 * Whether the checkbox is legally *required* for us is a question for counsel,
 * not a default this module should assume — hence off until asked.
 */

export interface CheckoutConsentEnv {
  /** Exactly `"true"` enables the Terms checkbox. Any other value, including
   * unset, leaves Checkout as it is today. */
  STRIPE_CHECKOUT_TOS_CONSENT?: string;
}

/** The `consent_collection` block Stripe expects, or nothing. */
export interface CheckoutConsentParams {
  consent_collection?: { terms_of_service: "required" };
}

/**
 * Extra params to merge into `checkout.sessions.create`. Returns `{}` — a
 * no-op spread — unless the flag is exactly `"true"`.
 *
 * Fail-closed on purpose, matching `OAUTH_CLIENT_REAPER_ENABLED` in
 * apps/auth: a typo'd or half-set value must leave the paid path working
 * rather than break every upgrade with a Stripe rejection.
 */
export function checkoutConsentParams(env: CheckoutConsentEnv): CheckoutConsentParams {
  return env.STRIPE_CHECKOUT_TOS_CONSENT === "true"
    ? { consent_collection: { terms_of_service: "required" } }
    : {};
}
