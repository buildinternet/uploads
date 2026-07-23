import { describe, expect, it } from "vitest";
import { resolveSubscriptionCopy } from "./subscription-copy";

describe("resolveSubscriptionCopy", () => {
  it("shows nothing when there's no subscription at all", () => {
    expect(
      resolveSubscriptionCopy({ planSource: "none", subscription: null, priceText: null }),
    ).toBeNull();
  });

  it("shows nothing when planSource is stripe but subscription is missing", () => {
    expect(
      resolveSubscriptionCopy({
        planSource: "stripe",
        subscription: null,
        priceText: "$10.00 per month",
      }),
    ).toBeNull();
  });

  it("renders a renewal line with the price for an active, non-cancelling subscription", () => {
    expect(
      resolveSubscriptionCopy({
        planSource: "stripe",
        subscription: {
          status: "active",
          periodEnd: "2026-08-23T00:00:00.000Z",
          cancelAtPeriodEnd: false,
        },
        priceText: "$10.00 per month",
      }),
    ).toEqual({ text: "Renews on August 23, 2026 · $10.00 per month", tone: "muted" });
  });

  it("renders a renewal line without a price suffix when the price is unknown", () => {
    expect(
      resolveSubscriptionCopy({
        planSource: "stripe",
        subscription: {
          status: "active",
          periodEnd: "2026-08-23T00:00:00.000Z",
          cancelAtPeriodEnd: false,
        },
        priceText: null,
      }),
    ).toEqual({ text: "Renews on August 23, 2026", tone: "muted" });
  });

  it("renders honest 'ends on' copy when cancelAtPeriodEnd is true, even while still active", () => {
    expect(
      resolveSubscriptionCopy({
        planSource: "stripe",
        subscription: {
          status: "active",
          periodEnd: "2026-08-23T00:00:00.000Z",
          cancelAtPeriodEnd: true,
        },
        priceText: "$10.00 per month",
      }),
    ).toEqual({ text: "Your plan ends on August 23, 2026.", tone: "muted" });
  });

  it("renders an alert-toned past-due line regardless of cancelAtPeriodEnd", () => {
    expect(
      resolveSubscriptionCopy({
        planSource: "stripe",
        subscription: {
          status: "past_due",
          periodEnd: "2026-08-23T00:00:00.000Z",
          cancelAtPeriodEnd: false,
        },
        priceText: "$10.00 per month",
      }),
    ).toEqual({
      text: "Payment past due — update your payment method in the billing portal.",
      tone: "alert",
    });

    expect(
      resolveSubscriptionCopy({
        planSource: "stripe",
        subscription: { status: "past_due", periodEnd: null, cancelAtPeriodEnd: true },
        priceText: null,
      }),
    ).toEqual({
      text: "Payment past due — update your payment method in the billing portal.",
      tone: "alert",
    });
  });

  it("renders muted 'applied by an operator' copy for admin-comped plans, ignoring any subscription", () => {
    expect(
      resolveSubscriptionCopy({ planSource: "admin", subscription: null, priceText: null }),
    ).toEqual({ text: "Applied by an operator — no Stripe subscription.", tone: "muted" });

    expect(
      resolveSubscriptionCopy({
        planSource: "admin",
        subscription: {
          status: "active",
          periodEnd: "2026-08-23T00:00:00.000Z",
          cancelAtPeriodEnd: false,
        },
        priceText: "$10.00 per month",
      }),
    ).toEqual({ text: "Applied by an operator — no Stripe subscription.", tone: "muted" });
  });

  it("returns null for an unrecognized status", () => {
    expect(
      resolveSubscriptionCopy({
        planSource: "stripe",
        subscription: {
          status: "incomplete",
          periodEnd: "2026-08-23T00:00:00.000Z",
          cancelAtPeriodEnd: false,
        },
        priceText: null,
      }),
    ).toBeNull();
  });

  it("returns null for a missing or malformed periodEnd on an active subscription", () => {
    expect(
      resolveSubscriptionCopy({
        planSource: "stripe",
        subscription: { status: "active", periodEnd: null, cancelAtPeriodEnd: false },
        priceText: null,
      }),
    ).toBeNull();

    expect(
      resolveSubscriptionCopy({
        planSource: "stripe",
        subscription: { status: "active", periodEnd: "not-a-date", cancelAtPeriodEnd: false },
        priceText: null,
      }),
    ).toBeNull();
  });

  it("returns null for a missing periodEnd when cancelAtPeriodEnd is true", () => {
    expect(
      resolveSubscriptionCopy({
        planSource: "stripe",
        subscription: { status: "active", periodEnd: null, cancelAtPeriodEnd: true },
        priceText: null,
      }),
    ).toBeNull();
  });
});
