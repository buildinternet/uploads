import { describe, expect, it } from "vitest";
import { resolvePlanLimits } from "../src/resolve";
import { PLANS } from "../src/plans";

describe("resolvePlanLimits", () => {
  it("uses the plan's default limits when there are no overrides", () => {
    expect(resolvePlanLimits("free", {})).toEqual(PLANS.free.defaultLimits);
  });

  it("an explicit override beats the plan default for that field", () => {
    const resolved = resolvePlanLimits("free", { maxStorageBytes: 1_000 });
    expect(resolved.maxStorageBytes).toBe(1_000);
    expect(resolved.maxUploadsPerPeriod).toBe(PLANS.free.defaultLimits.maxUploadsPerPeriod);
  });

  it("an override of undefined does not shadow the plan default", () => {
    const resolved = resolvePlanLimits("free", { maxStorageBytes: undefined });
    expect(resolved.maxStorageBytes).toBe(PLANS.free.defaultLimits.maxStorageBytes);
  });

  it("resolves pro's own (unavailable) defaults when a workspace is set to pro", () => {
    expect(resolvePlanLimits("pro", {})).toEqual(PLANS.pro.defaultLimits);
  });

  it("fails open to free's defaults for an unknown plan string", () => {
    expect(resolvePlanLimits("enterprise", {})).toEqual(PLANS.free.defaultLimits);
  });

  it("fails open to free's defaults when plan is undefined (absent-in-KV case)", () => {
    expect(resolvePlanLimits(undefined, {})).toEqual(PLANS.free.defaultLimits);
  });

  it("all four override fields compose independently", () => {
    const resolved = resolvePlanLimits("free", {
      maxStorageBytes: 1,
      maxUploadsPerPeriod: 2,
      maxUploadBytes: 3,
      maxVideoUploadBytes: 4,
    });
    expect(resolved).toEqual({
      maxStorageBytes: 1,
      maxUploadsPerPeriod: 2,
      maxUploadBytes: 3,
      maxVideoUploadBytes: 4,
    });
  });
});
