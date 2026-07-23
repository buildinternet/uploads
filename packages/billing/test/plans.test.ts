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
      maxMembers: 3,
    });
  });

  it("defines pro as an available paid plan", () => {
    expect(PLANS.pro.available).toBe(true);
    expect(PLANS.pro.id).toBe("pro");
    expect(typeof PLANS.pro.name).toBe("string");
    expect(PLANS.pro.name.length).toBeGreaterThan(0);
  });

  it("defines pro with the decided simplified limits (2026-07-22)", () => {
    expect(PLANS.pro.defaultLimits).toEqual({
      maxStorageBytes: 10_000_000_000,
      maxUploadsPerPeriod: 100_000,
      maxUploadBytes: 100_000_000,
      maxVideoUploadBytes: 100_000_000,
      maxMembers: 25,
    });
  });

  it("markets free's member cap but not pro's abuse guard (issue #450)", () => {
    expect(PLANS.free.marketsMemberCap).toBe(true);
    expect(PLANS.pro.marketsMemberCap).toBe(false);
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

  it("fails open to free for inherited-property names, not the prototype value", () => {
    expect(getPlan("constructor")).toBe(PLANS.free);
    expect(getPlan("__proto__")).toBe(PLANS.free);
  });

  it("still resolves real plan ids unaffected by the hasOwn check", () => {
    expect(getPlan("free")).toBe(PLANS.free);
    expect(getPlan("pro")).toBe(PLANS.pro);
  });
});
