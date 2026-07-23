import { describe, expect, it } from "vitest";
import { resolveBillingCta } from "./billing-cta";

describe("resolveBillingCta", () => {
  it("stays unavailable when pro isn't purchasable yet, regardless of plan", () => {
    expect(resolveBillingCta({ proAvailable: false, plan: "free", planSource: "none" })).toEqual({
      kind: "unavailable",
    });
    expect(resolveBillingCta({ proAvailable: false, plan: "pro", planSource: "stripe" })).toEqual({
      kind: "unavailable",
    });
    expect(resolveBillingCta({ proAvailable: false, plan: "pro", planSource: "admin" })).toEqual({
      kind: "unavailable",
    });
  });

  it("offers upgrade when pro is available and the workspace isn't on it", () => {
    expect(resolveBillingCta({ proAvailable: true, plan: "free", planSource: "none" })).toEqual({
      kind: "upgrade",
    });
  });

  it("offers the billing portal when a live Stripe subscription backs pro", () => {
    expect(resolveBillingCta({ proAvailable: true, plan: "pro", planSource: "stripe" })).toEqual({
      kind: "manage",
    });
  });

  it("does not offer the Stripe portal for a comped/admin-set pro plan", () => {
    // A workspace comped to pro has no Stripe customer, so the billing portal
    // 404s — offer the "comped" state (no portal button) instead of an opaque
    // error. Covers both derivations of a non-Stripe-backed paid plan.
    expect(resolveBillingCta({ proAvailable: true, plan: "pro", planSource: "admin" })).toEqual({
      kind: "comped",
    });
    expect(resolveBillingCta({ proAvailable: true, plan: "pro", planSource: "none" })).toEqual({
      kind: "comped",
    });
  });
});
