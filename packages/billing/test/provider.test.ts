import { describe, expect, it } from "vitest";
import { NullBillingProvider } from "../src/provider";

describe("NullBillingProvider", () => {
  it("getSubscription always resolves null (no subscription today)", async () => {
    const provider = new NullBillingProvider();
    await expect(provider.getSubscription("acme")).resolves.toBeNull();
  });

  it("createCheckoutSession rejects — no checkout path exists yet", async () => {
    const provider = new NullBillingProvider();
    await expect(provider.createCheckoutSession("acme", "pro")).rejects.toThrow(
      /not available|unavailable/i,
    );
  });

  it("createPortalSession rejects — no billing portal exists yet", async () => {
    const provider = new NullBillingProvider();
    await expect(provider.createPortalSession("acme")).rejects.toThrow(
      /not available|unavailable/i,
    );
  });
});
