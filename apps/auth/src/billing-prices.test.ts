/**
 * GET /billing/prices — see src/billing-prices.ts. Mocks `Stripe.prices.retrieve`
 * the same way stripe-plugin.test.ts fakes env, per the brief.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const retrieveMock = vi.fn();

vi.mock("stripe", () => {
  class FakeStripe {
    prices = { retrieve: retrieveMock };
    static createFetchHttpClient() {
      return {};
    }
  }
  return { default: FakeStripe };
});

let getProPrice: typeof import("./billing-prices").getProPrice;
let resetBillingPricesCacheForTests: typeof import("./billing-prices").resetBillingPricesCacheForTests;

beforeEach(async () => {
  vi.resetModules();
  retrieveMock.mockReset();
  ({ getProPrice, resetBillingPricesCacheForTests } = await import("./billing-prices"));
  resetBillingPricesCacheForTests();
});

afterEach(() => {
  resetBillingPricesCacheForTests();
});

describe("getProPrice", () => {
  it("returns null when STRIPE_SECRET_KEY is missing", async () => {
    const result = await getProPrice({ STRIPE_PRO_PRICE_ID: "price_123" });
    expect(result).toBeNull();
    expect(retrieveMock).not.toHaveBeenCalled();
  });

  it("returns null when STRIPE_PRO_PRICE_ID is missing", async () => {
    const result = await getProPrice({ STRIPE_SECRET_KEY: "sk_test_123" });
    expect(result).toBeNull();
    expect(retrieveMock).not.toHaveBeenCalled();
  });

  it("returns the price on the happy path", async () => {
    retrieveMock.mockResolvedValue({
      unit_amount: 900,
      currency: "usd",
      recurring: { interval: "month" },
    });
    const result = await getProPrice({
      STRIPE_SECRET_KEY: "sk_test_123",
      STRIPE_PRO_PRICE_ID: "price_123",
    });
    expect(result).toEqual({ unitAmount: 900, currency: "usd", interval: "month" });
    expect(retrieveMock).toHaveBeenCalledWith("price_123");
  });

  it("defaults interval to month when recurring is absent", async () => {
    retrieveMock.mockResolvedValue({ unit_amount: 900, currency: "usd" });
    const result = await getProPrice({
      STRIPE_SECRET_KEY: "sk_test_123",
      STRIPE_PRO_PRICE_ID: "price_123",
    });
    expect(result).toEqual({ unitAmount: 900, currency: "usd", interval: "month" });
  });

  it("returns null when the Stripe fetch fails, never throws", async () => {
    retrieveMock.mockRejectedValue(new Error("stripe unreachable"));
    const result = await getProPrice({
      STRIPE_SECRET_KEY: "sk_test_123",
      STRIPE_PRO_PRICE_ID: "price_123",
    });
    expect(result).toBeNull();
  });

  it("memoizes across calls within the TTL window (single Stripe fetch)", async () => {
    retrieveMock.mockResolvedValue({
      unit_amount: 900,
      currency: "usd",
      recurring: { interval: "month" },
    });
    const env = { STRIPE_SECRET_KEY: "sk_test_123", STRIPE_PRO_PRICE_ID: "price_123" };
    await getProPrice(env);
    await getProPrice(env);
    expect(retrieveMock).toHaveBeenCalledTimes(1);
  });
});
