import { describe, expect, it } from "vitest";
import { checkoutConsentParams } from "./stripe-checkout";

describe("checkoutConsentParams", () => {
  it("is off when the flag is unset", () => {
    expect(checkoutConsentParams({})).toEqual({});
  });

  it("requires the Terms checkbox when the flag is exactly 'true'", () => {
    expect(checkoutConsentParams({ STRIPE_CHECKOUT_TOS_CONSENT: "true" })).toEqual({
      consent_collection: { terms_of_service: "required" },
    });
  });

  // Fail-closed matters more here than convenience. A half-set or typo'd
  // value must leave checkout working: turning consent_collection on without
  // a Terms URL in the Stripe Dashboard makes Stripe reject the session, and
  // that lands on the purchase path.
  it.each(["", "1", "TRUE", "True", "yes", "false", " true"])(
    "stays off for %o rather than guessing",
    (value) => {
      expect(checkoutConsentParams({ STRIPE_CHECKOUT_TOS_CONSENT: value })).toEqual({});
    },
  );

  it("returns a spreadable no-op when off", () => {
    // The plugin spreads this into checkout.sessions.create, so "off" has to
    // be an empty object rather than undefined or a null-valued key.
    const base = { mode: "subscription" };
    expect({ ...base, ...checkoutConsentParams({}) }).toEqual({ mode: "subscription" });
  });
});
