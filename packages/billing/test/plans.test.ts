import { describe, expect, it } from "vitest";
import { getPlan, PLANS } from "../src/plans";

describe("PLANS catalog", () => {
  it("defines free as available with the current self-serve defaults", () => {
    expect(PLANS.free.available).toBe(true);
    expect(PLANS.free.defaultLimits).toEqual({
      maxStorageBytes: 250_000_000,
      maxUploadsPerPeriod: 3000,
      maxUploadBytes: 25_000_000,
      maxVideoUploadBytes: 8_000_000,
    });
  });

  it("defines pro as unavailable display metadata", () => {
    expect(PLANS.pro.available).toBe(false);
    expect(PLANS.pro.id).toBe("pro");
    expect(typeof PLANS.pro.name).toBe("string");
    expect(PLANS.pro.name.length).toBeGreaterThan(0);
  });

  it("every plan's id matches its catalog key", () => {
    for (const [key, plan] of Object.entries(PLANS)) {
      expect(plan.id).toBe(key);
    }
  });
});

describe("getPlan", () => {
  it("returns the matching catalog entry for a known id", () => {
    expect(getPlan("pro")).toBe(PLANS.pro);
  });

  it("fails open to free for an unknown or legacy plan string", () => {
    expect(getPlan("enterprise")).toBe(PLANS.free);
    expect(getPlan("")).toBe(PLANS.free);
    expect(getPlan(undefined)).toBe(PLANS.free);
  });
});
