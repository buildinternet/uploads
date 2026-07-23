import { describe, expect, it } from "vitest";
import { resolveBillingCta } from "./billing-cta";

describe("resolveBillingCta", () => {
  it("stays unavailable when pro isn't purchasable yet, regardless of plan", () => {
    expect(resolveBillingCta({ proAvailable: false, plan: "free" })).toEqual({
      kind: "unavailable",
    });
    expect(resolveBillingCta({ proAvailable: false, plan: "pro" })).toEqual({
      kind: "unavailable",
    });
  });

  it("offers upgrade when pro is available and the workspace isn't on it", () => {
    expect(resolveBillingCta({ proAvailable: true, plan: "free" })).toEqual({
      kind: "upgrade",
    });
  });

  it("offers the billing portal when the workspace is already on pro", () => {
    expect(resolveBillingCta({ proAvailable: true, plan: "pro" })).toEqual({
      kind: "manage",
    });
  });
});
