import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchProPrice, formatPrice } from "./plan-prices";

describe("fetchProPrice", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the price on a happy-path 200", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        prices: { pro: { unitAmount: 1000, currency: "usd", interval: "month" } },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchProPrice("https://auth.uploads.sh")).resolves.toEqual({
      unitAmount: 1000,
      currency: "usd",
      interval: "month",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://auth.uploads.sh/billing/prices",
      expect.not.objectContaining({ credentials: "include" }),
    );
  });

  it("returns null when the server reports no pro price", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ prices: { pro: null } }) }),
    );
    await expect(fetchProPrice("https://auth.uploads.sh")).resolves.toBeNull();
  });

  it("returns null on a non-200 (e.g. 404 before the endpoint ships)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404 }));
    await expect(fetchProPrice("https://auth.uploads.sh")).resolves.toBeNull();
  });

  it("returns null when fetch rejects (network error)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    await expect(fetchProPrice("https://auth.uploads.sh")).resolves.toBeNull();
  });

  it("returns null on a malformed body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ prices: { pro: { unitAmount: "x" } } }),
      }),
    );
    await expect(fetchProPrice("https://auth.uploads.sh")).resolves.toBeNull();
  });
});

describe("formatPrice", () => {
  it("formats a whole-dollar amount without decimals", () => {
    expect(formatPrice({ unitAmount: 1000, currency: "usd", interval: "month" })).toBe(
      "$10 per month",
    );
  });

  it("formats a fractional amount with decimals", () => {
    expect(formatPrice({ unitAmount: 999, currency: "usd", interval: "month" })).toBe(
      "$9.99 per month",
    );
  });

  it("returns null for an unknown price", () => {
    expect(formatPrice(null)).toBeNull();
  });
});
