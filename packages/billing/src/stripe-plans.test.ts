import { describe, expect, it } from "vitest";
import { stripePlans } from "./stripe-plans";

describe("stripePlans", () => {
  it("returns [] with no price id", () => {
    expect(stripePlans({})).toEqual([]);
  });
  it("maps pro to the configured price", () => {
    expect(stripePlans({ STRIPE_PRO_PRICE_ID: "price_x" })).toEqual([
      { name: "pro", priceId: "price_x" },
    ]);
  });
});
