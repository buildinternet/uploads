import { describe, expect, it } from "vitest";
import { resolveEffectiveLimits, resolvePlanLimits } from "../src/resolve";
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

  it("an explicit null override wins over the plan default, resolving to unlimited (undefined)", () => {
    const resolved = resolvePlanLimits("free", { maxStorageBytes: null });
    expect(resolved.maxStorageBytes).toBeUndefined();
    expect(resolved.maxUploadsPerPeriod).toBe(PLANS.free.defaultLimits.maxUploadsPerPeriod);
  });

  it("a null override on a plan with a defined default still clears it (pro)", () => {
    const resolved = resolvePlanLimits("pro", { maxUploadsPerPeriod: null });
    expect(resolved.maxUploadsPerPeriod).toBeUndefined();
    expect(resolved.maxStorageBytes).toBe(PLANS.pro.defaultLimits.maxStorageBytes);
  });

  it("null and undefined overrides can be mixed with numeric overrides across fields", () => {
    const resolved = resolvePlanLimits("free", {
      maxStorageBytes: null,
      maxUploadsPerPeriod: undefined,
      maxUploadBytes: 42,
    });
    expect(resolved).toEqual({
      maxStorageBytes: undefined,
      maxUploadsPerPeriod: PLANS.free.defaultLimits.maxUploadsPerPeriod,
      maxUploadBytes: 42,
      maxVideoUploadBytes: PLANS.free.defaultLimits.maxVideoUploadBytes,
    });
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

describe("resolveEffectiveLimits", () => {
  // Characterization for the single `plan === undefined` gate (issue #388):
  // both apps/api/src/budget.ts (enforcement) and workspace-plan.ts
  // (display) call through this seam.
  it("no plan set: returns the record's own fields, no plan defaults applied", () => {
    expect(resolveEffectiveLimits({})).toEqual({
      maxStorageBytes: undefined,
      maxUploadsPerPeriod: undefined,
      maxUploadBytes: undefined,
      maxVideoUploadBytes: undefined,
    });
  });

  it("no plan set: an explicit numeric field passes through unchanged", () => {
    const resolved = resolveEffectiveLimits({ maxStorageBytes: 500 });
    expect(resolved.maxStorageBytes).toBe(500);
    expect(resolved.maxUploadsPerPeriod).toBeUndefined();
  });

  it("no plan set: an explicit null field resolves to undefined (unlimited), same as absent", () => {
    const resolved = resolveEffectiveLimits({ maxStorageBytes: null });
    expect(resolved.maxStorageBytes).toBeUndefined();
  });

  it("plan set: defers to resolvePlanLimits for defaults + override precedence", () => {
    expect(resolveEffectiveLimits({ plan: "free" })).toEqual(PLANS.free.defaultLimits);
    const withOverride = resolveEffectiveLimits({ plan: "pro", maxStorageBytes: 1_000 });
    expect(withOverride.maxStorageBytes).toBe(1_000);
    expect(withOverride.maxUploadsPerPeriod).toBe(PLANS.pro.defaultLimits.maxUploadsPerPeriod);
  });

  it("plan set: an unrecognized plan string still fails open to free via resolvePlanLimits", () => {
    expect(resolveEffectiveLimits({ plan: "enterprise" })).toEqual(PLANS.free.defaultLimits);
  });

  it("plan set: an explicit null override still wins over the plan default (unlimited)", () => {
    const resolved = resolveEffectiveLimits({ plan: "free", maxStorageBytes: null });
    expect(resolved.maxStorageBytes).toBeUndefined();
    expect(resolved.maxUploadsPerPeriod).toBe(PLANS.free.defaultLimits.maxUploadsPerPeriod);
  });
});
