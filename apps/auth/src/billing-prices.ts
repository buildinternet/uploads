/**
 * GET /billing/prices — Stripe is the single source of truth for the pro
 * plan's price *amount*, so the web app never hardcodes it (issue: web lane
 * builds against this response shape). `pro` is `null` whenever Stripe is
 * dormant (no STRIPE_SECRET_KEY or no STRIPE_PRO_PRICE_ID — same dormancy
 * check as stripe-plugin.ts) or the Stripe fetch itself fails; this route
 * must never 500 for that, the page just renders without a price.
 *
 * In-isolate memoized for ~5 minutes (module-level TTL cache) on top of the
 * `Cache-Control: public, max-age=300` response header, so a warm isolate
 * serving many requests doesn't hit Stripe per request.
 */
import Stripe from "stripe";

export type BillingPricesEnv = {
  STRIPE_SECRET_KEY?: string;
  STRIPE_PRO_PRICE_ID?: string;
};

export type PriceInfo = {
  unitAmount: number;
  currency: string;
  interval: string;
};

export type BillingPricesResponse = {
  prices: {
    pro: PriceInfo | null;
  };
};

const CACHE_TTL_MS = 5 * 60 * 1000;

let cache: { value: PriceInfo | null; expiresAt: number } | null = null;

/** Test-only: clear the in-isolate memoization between cases. */
export function resetBillingPricesCacheForTests(): void {
  cache = null;
}

async function fetchProPrice(env: BillingPricesEnv): Promise<PriceInfo | null> {
  if (!env.STRIPE_SECRET_KEY || !env.STRIPE_PRO_PRICE_ID) return null;

  const stripeClient = new Stripe(env.STRIPE_SECRET_KEY, {
    apiVersion: "2026-06-24.dahlia",
    // Same rationale as stripe-plugin.ts: Workers has no Node http/https
    // module, force the fetch-based client rather than relying on export
    // condition auto-selection.
    httpClient: Stripe.createFetchHttpClient(),
  });

  try {
    const price = await stripeClient.prices.retrieve(env.STRIPE_PRO_PRICE_ID);
    if (typeof price.unit_amount !== "number") return null;
    return {
      unitAmount: price.unit_amount,
      currency: price.currency,
      interval: price.recurring?.interval ?? "month",
    };
  } catch (err) {
    console.error(
      JSON.stringify({
        message: "billing_prices_stripe_fetch_failed",
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return null;
  }
}

/** The pro price, from the in-isolate TTL cache when fresh, else fetched
 * from Stripe (and re-memoized, including the `null`/dormant/error case —
 * a dormant deploy shouldn't re-check its own env on every request). */
export async function getProPrice(env: BillingPricesEnv): Promise<PriceInfo | null> {
  const now = Date.now();
  if (cache && cache.expiresAt > now) return cache.value;

  const value = await fetchProPrice(env);
  cache = { value, expiresAt: now + CACHE_TTL_MS };
  return value;
}

export async function billingPricesResponseBody(
  env: BillingPricesEnv,
): Promise<BillingPricesResponse> {
  return { prices: { pro: await getProPrice(env) } };
}
