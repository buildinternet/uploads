import { describe, expect, it } from "vitest";
import { planResponse, validatePlanPatch } from "./workspace-plan";

describe("validatePlanPatch", () => {
  it("accepts a known plan id", () => {
    expect(validatePlanPatch({ plan: "pro" })).toEqual({ plan: "pro" });
    expect(validatePlanPatch({ plan: "free" })).toEqual({ plan: "free" });
  });

  it("rejects an unknown plan id", () => {
    expect(() => validatePlanPatch({ plan: "enterprise" })).toThrow(/invalid_plan|plan/i);
  });

  it("rejects a missing plan field", () => {
    expect(() => validatePlanPatch({})).toThrow(/invalid_plan|plan/i);
  });

  it("rejects a non-object body", () => {
    expect(() => validatePlanPatch(null)).toThrow(/invalid_plan|plan/i);
    expect(() => validatePlanPatch("pro")).toThrow(/invalid_plan|plan/i);
  });
});

describe("planResponse", () => {
  it("reports the free plan (display default) but leaves a bare record's limits unlimited — planApplied: false", () => {
    const result = planResponse("acme", { provider: "r2", bucket: "b" });
    expect(result).toEqual({
      workspace: "acme",
      plan: "free",
      available: true,
      planApplied: false,
      limits: {
        maxStorageBytes: null,
        maxUploadsPerPeriod: null,
        maxUploadBytes: null,
        maxVideoUploadBytes: null,
      },
      overrides: [],
    });
  });

  it("reflects explicit overrides on a bare (no-plan) record without applying plan defaults", () => {
    const result = planResponse("acme", {
      provider: "r2",
      bucket: "b",
      maxStorageBytes: 999,
    });
    expect(result.planApplied).toBe(false);
    expect(result.overrides).toEqual(["maxStorageBytes"]);
    expect(result.limits.maxStorageBytes).toBe(999);
    expect(result.limits.maxUploadsPerPeriod).toBe(null);
  });

  it("resolves plan defaults + overrides once a plan is explicitly set — planApplied: true", () => {
    const result = planResponse("acme", {
      provider: "r2",
      bucket: "b",
      plan: "free",
      maxStorageBytes: 999,
    });
    expect(result.planApplied).toBe(true);
    expect(result.overrides).toEqual(["maxStorageBytes"]);
    expect(result.limits.maxStorageBytes).toBe(999);
    expect(result.limits.maxUploadsPerPeriod).toBe(3000);
  });

  it("reports pro as unavailable when a workspace is set to it", () => {
    const result = planResponse("acme", { provider: "r2", bucket: "b", plan: "pro" });
    expect(result.plan).toBe("pro");
    expect(result.available).toBe(false);
    expect(result.planApplied).toBe(true);
    expect(result.limits.maxStorageBytes).toBe(10_000_000_000);
  });

  it("fails open to free for an unrecognized stored plan string, but still applies plan-aware resolution", () => {
    const result = planResponse("acme", {
      provider: "r2",
      bucket: "b",
      plan: "enterprise" as never,
    });
    expect(result.plan).toBe("free");
    expect(result.planApplied).toBe(true);
    expect(result.limits.maxStorageBytes).toBe(250_000_000);
  });
});
